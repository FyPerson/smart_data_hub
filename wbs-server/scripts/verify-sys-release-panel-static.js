/**
 * verify-sys-release-panel-static.js
 *
 * 上线体统一重构 C7（方案 v3.4 §6.7 明文）：静态源码断言，锁定
 * 「admin 界面必须始终暴露「安排上线」操作，否则应急场景会卡住」这条前端不变量。
 *
 * 用法：node scripts/verify-sys-release-panel-static.js   （纯文本源码扫描，无需启动 server，自包含）
 *
 * 背景：C2b 已把「上线单管理」入口（siOpenBatch）与 META_OK 解耦（若 /sys-issues/meta 加载失败，
 * 应急上线通道不能被连坐锁死），siOpenBatchDetail 内的「安排上线」（siReleaseNotifyExecutor）/
 * 「执行上线」（siReleaseExecuteModal）/「撤销上线安排」（siReleaseCancelScheduleModal）三个动作
 * 同样刻意不挂 META_OK 门。这条不变量此前只在代码注释里承诺，从未有断言钉住——本脚本补上：
 *   ① 「上线单管理」入口按钮的可见性条件不得包含 META_OK
 *   ② siOpenBatchDetail 函数体（含「安排上线」/「执行上线」/「撤销上线安排」三个动作按钮）整体
 *      不得引用 META_OK
 *   ③ 「值班排班」入口同样不挂 META_OK（§6.15 明文"登录即可见"，与①②同一条不变量的另一实例）
 *   ④ 反向边界：META_OK 异常态下**应该**降级的入口（新建迭代单 / 删除审计 / 流程说明；「上线编排」
 *      legacy 面板已于 2026-07-30 随旧家族封禁整体删除，从降级清单转入"删干净"断言组）仍正确挂着
 *      META_OK 门——防止未来有人"为了让①②过"而把 META_OK 从整个文件删掉，那样①②会假绿。
 *   ⑤ HTML 内联 <script> 语法有效（new Function 编译不执行，等价 node -c）
 *
 * 与 Playwright 层分工：本脚本只读源码结构、不起浏览器，验证的是"代码写没写对"；
 * test-sys-release-panel-c2b2-playwright.js（C7 扩展）验证的是"META_OK=false 时页面运行时表现
 * 是否真的如愿"（真浏览器、真 fetch 失败模拟）。两层互补，不是重复覆盖。
 *
 * 【META_OK 异常态边界（本脚本④固化，供人工核对）】
 *   /sys-issues/meta 加载失败（META_OK=false）时：
 *   - 仍可用：「上线单管理」（含内部安排上线/执行上线/撤销上线安排/改期/加单）、「值班排班」、
 *     单据详情页的只读展示区（§1922 附近 `if (!META_OK) box.innerHTML='只读模式…'` 分支——单据的
 *     状态流转动作按钮才降级，不影响上线单体系）
 *   - 降级/隐藏：「+ 新建迭代单」（依赖 typeFlows 判断可建类型）、「🗑️ 删除审计」「📜 上线日志」
 *     （2026-07-31 新增，与删除审计同门槛——均为纯查询功能，非应急路径，容忍随 meta 一起降级）、
 *     「📖 流程说明」（静态说明文档，随 meta 降级不影响写操作）
 *   - 已删除（非降级）：「🚀 上线编排」legacy 面板（2026-07-30 随旧家族 4 端点封禁整体删除）
 *
 * 【2026-07-31 变更】原"四入口"（新建迭代单/删除审计/上线编排[已删]/流程说明）反向降级断言组扩为
 * 五入口，新增「上线日志」与「删除审计」同门槛同断言写法（见下方 §④ 新增 check）。
 *
 * 【2026-08-02 变更·用户裁定二】筛选栏右侧改「[⚙️ 管理▾][+ 新建迭代单]」——上线单管理/值班排班/
 * 上线日志/删除审计/流程说明五个入口从平铺按钮收进「⚙️ 管理」下拉菜单；新建迭代单仍是独立主按钮。
 * ①②③④ 五组断言的 marker 匹配（onclick="siOpenXxx()" 标记文本 + 就近 if 条件）**无需改动就依旧
 * 成立**——onclick 属性值本身逐字保留（下拉的"点菜单项后自动收起"用事件委托实现，不在每个 onclick
 * 里追加 siCloseHeadMenu()，故标记文本没变），各按钮自己的 if 块仍是紧邻自身 marker 的最近 if（哪怕
 * 五个块在函数体内被重新排过序，guardConditionBefore 只认"某个 marker 前最近一个 if"，块内部顺序
 * 互换不影响各自配对关系）。即便如此，新增 §③ 三条**结构性**断言把"这五个入口真的挂在下拉菜单里、
 * 新建迭代单真的没被挪进去、下拉本体真的有'至少一个菜单项才渲染'的门控"这三条 2026-08-02 新增的
 * 结构不变量也钉住——防止未来有人把某个入口从 .u-head-menu-item 挪回裸按钮（或反之）却没人发现。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const sqlite3 = require('sqlite3');
const acorn = require('acorn'); // [S5 甲2] extractFunctionBody 交叉验证。⚠️ [S5b·Opus 预筛 M3] 本仓第 6 处消费点（collab-validation-status-coverage / db-connections-writers 硬 require，badge-alias / external-source-playwright try 降级）——acorn 此前一直是 eslint 传递依赖被提升，本次 S5 首次显式写进 devDependencies 是补旧债，不是新引入
// [长任务B·S4c 补充] 逐人完成 else-if 分支体结构锚提取——用共享 lib 的有限状态词法扫描（跳过字符串/
// 模板/注释内的假花括号），不重造一份朴素深度计数。
const { findMatchingBraceIndex } = require('./lib/extract-function-body.js');

let passed = 0, failed = 0;
const failures = [];
// [C4e·codex 560 M3 收口] 新增 async check 支持——M3 的两组「真实执行 siReleaseExecuteRetryModal」断言
// 需要 await 真实的 `async v => {...}` onConfirm 回调（不是手写同构逻辑复刻一份，避免复刻漂移），原
// check() 只支持同步 fn（异步 fn() 会立即返回 pending promise，try/catch 接不住之后才抛出的断言失败，
// 变成 unhandled rejection）。改法：fn() 返回值若是 thenable，则登记进 pending 队列延后判定，文件末尾
// `await Promise.all(pending)` 之后才打印总分/决定退出码——同步调用点行为逐字不变（fn() 非 thenable 时
// 走原有同步分支，无感知）。
const pending = [];
const checkNames = [];
function check(name, fn) {
    checkNames.push(name);
    let result;
    try {
        result = fn();
    } catch (e) {
        failed++; failures.push({ name, err: e.message });
        console.log(`  ✗ ${name} — ${e.message}`);
        return;
    }
    if (result && typeof result.then === 'function') {
        pending.push(result.then(
            () => { passed++; console.log(`  ✓ ${name}`); },
            (e) => { failed++; failures.push({ name, err: e.message }); console.log(`  ✗ ${name} — ${e.message}`); }
        ));
        return;
    }
    passed++; console.log(`  ✓ ${name}`);
}

const htmlPath = path.join(__dirname, '..', 'public', 'Sys_Iteration.html');
const src = fs.readFileSync(htmlPath, 'utf8');

// 取单个具名函数体（从 `function name(...) {` 到与之匹配的右括号）——同 verify-collab-terminal-notify.js
// 既有范式（extractFunctionBody）。
// ⚠️ [581-R2 L1 / 581-R3 L 措辞订正·两轮] 原注释写「balanced-brace 提取，**避免跨函数误判**」
//   ——这个保证**强于实现**：本实现**逐字符统计所有花括号**，不区分代码 / 字符串 / 模板字面量 /
//   正则 / 注释。⇒ 函数体内只要出现**不成对的花括号字面量**（字符串里单独的 `}` 或 `{`、
//   模板里的 `${` 拼接片段、正则中的 `{n,m}`、注释里的孤立括号），提取结果就不可靠。
//   ⚠️ [581-R3] 后果**不止「提前结束」一种**（我上一轮只写了这一种，不全）：
//     · 多出**右**花括号 ⇒ **提前结束**，拿到截断的函数体
//     · 多出**左**花括号 ⇒ **越过函数边界**，把后面的函数一起吞进来
//     · 括号始终不归零 ⇒ **提取失败**（返回 null）
//   截断/越界后的后果分两种：① 被断言的特征串落在错误范围外 ⇒ **假红**（能发现）
//   ② 断言的是「不含某串」这类负向条件 ⇒ **假绿**（发现不了）。
//   **准确的表述**：本提取器只在「目标函数体内花括号成对且不出现于字符串/模板/正则/注释」这一
//   输入格式约束下正确；**提取成功 ≠ 函数边界正确**。
//   ⇒ 使用纪律（⚠️ 这是**待落实的纪律**，不代表现有调用点已全部实施）：凡用本提取器做
//   **负向断言**（断某串不存在）的地方，都应另加一条正向锚点断言（断一个只出现在函数体
//   **尾部**的特征串），以排除提取范围不对。
//   ⇒ 更彻底的修法是改用真正的 JS 解析器按函数节点取起止偏移并与本提取器对照
//   （codex 581-R2/R3 建议），属**测试工具可靠性**改造、不在 #67 范围内
//   ⇒ 登记锚点 §9 第 9 项，不在本批实施。
function extractFunctionBody(source, fnName) {
    const startRe = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`);
    const m = startRe.exec(source);
    if (!m) return null;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return null;
}

// 剥离 // 行注释与 /* */ 块注释（不做完整 JS 词法分析，够用即可——本文件内 META_OK 不会出现在字符串
// 字面量里，注释里提"本区块不挂 META_OK 门"这类说明性文字很常见，必须先剥注释再判"代码里有没有用它"，
// 否则会把"说它没用"误判成"用了它"）。
function stripComments(code) {
    return code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// [长任务B S4c2·codex 590 裁定 M6] 抽出纯函数：先取 <style> 标签内容，剥 CSS 注释 /* … */（不是 JS
//   注释——CSS 没有 // 行注释语法，只剥块注释），再 matchAll 出全部 `.si-tl-evt.si-tl-<色名> { … }`
//   规则。原判据直接对整份 HTML 全文 matchAll，若某条规则被整行 CSS 注释掉（`/* .si-tl-evt.si-tl-teal
//   {...} */`），纯字符匹配的正则完全不理解"这是注释"，会照样把注释里的文本当成一条真实规则算进
//   结果——"删规则"的活体变异用字符串替换成空串能骗过这条判据，但更贴近真实误操作的"顺手注释掉"
//   不会被发现。改为先剥 CSS 注释再扫描，正向断言与 MED-4a/b/c 三条变异对照组共用同一份实现，不复刻。
function extractTimelineBadgeRules(fullSrc) {
    const styleMatch = fullSrc.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    const styleBody = styleMatch ? styleMatch[1] : '';
    const noComments = styleBody.replace(/\/\*[\s\S]*?\*\//g, '');
    return [...noComments.matchAll(/\.si-tl-evt\.si-tl-([a-z]+)\s*\{\s*background:\s*(#[0-9a-fA-F]{6});\s*color:\s*#[0-9a-fA-F]{6};\s*\}/g)];
}

// 取 `const <name> = {` 起花括号平衡的对象字面量全文（照 verify-sys-fastlane-panel-static.js 同款范式·
// S10 预筛拦截 B1 三表正向断言专用）。
function extractConstObjectText(name) {
    const startRe = new RegExp(`const\\s+${name}\\s*=\\s*\\{`);
    const m = startRe.exec(src);
    if (!m) return null;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    return null;
}

// 找到 marker 之前最近一个 `if (` 的守卫条件文本（从该 `if (` 到与之配对的 `)`，括号深度平衡）。
// 用于精确定位"这个按钮到底被哪个 if 条件控制"，而不是笼统扫整个函数体（那样会把不相关按钮的
// 条件误判为目标按钮的条件，尤其本文件多个按钮共享同一个大函数体）。
function guardConditionBefore(body, marker) {
    const mi = body.indexOf(marker);
    assert.ok(mi >= 0, `未找到标记文本 "${marker}"`);
    const ifIdx = body.lastIndexOf('if (', mi);
    assert.ok(ifIdx >= 0, `"${marker}" 之前未找到 if (`);
    let depth = 0, i = ifIdx + 3; // 指向 '('
    const start = i;
    for (; i < body.length; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')') {
            depth--;
            if (depth === 0) return body.slice(start + 1, i);
        }
    }
    throw new Error(`"${marker}" 的 if 条件未闭合`);
}

// [S5 甲2 · 长任务A锚点 §9 第 9 项裁定] extractFunctionBody（本文件 :109 一带）逐字符统计花括号、
// 不区分字符串/模板/正则/注释——「提取成功 ≠ 函数边界正确」的风险此前只有「末字符为 } + new Function
// 编译」两项间接检查，未直接验证边界。裁定＝不换实现（保留现状），改用真正的 JS 解析器（acorn）独立
// 复算每个目标函数体的花括号区间，与 extractFunctionBody 的返回值逐字节比对——把"未发现异常"升级
// 为"已证明边界正确"，且一旦未来出现截断/越界会立刻在此报红（不必等到下游用它做负向断言的地方假绿）。
//
// 比对口径：extractFunctionBody(source, name) 返回值从 `{`（源码里 `function name(...) {` 的那个左
// 花括号，函数体起点）到与之配对的 `}`（含两端花括号）的原始子串——即 acorn AST 里 FunctionDeclaration
// 节点 `.body`（BlockStatement）的 `[start, end)` 区间原样切片：node.body.start 指向左花括号，
// node.body.end 是右花括号之后一位（exclusive），故 `blockText.slice(node.body.start, node.body.end)`
// 与 extractFunctionBody 的返回值应逐字节相等，两者对同一份源码文本取同一含义的区间，非近似比较。
//
// 范围：本文件内实际调用 extractFunctionBody(src, 目标函数名字面量)（含经由内部小工具 grabFnA 间接
// 调用的形态）覆盖到的全部目标函数名，去重后取集合——不是固定 26 这个预估数，以本文件当前实际调用点
// 为准（多点位重复调用同一函数名只登记一次，比对一次即可，重复调用不改变该函数体在源码里的边界）。
// [G1·长任务B S4c2·codex 590 裁定·2026-09-17] grabFnA 非字面量调用的豁免判定——acorn 结构级重写，
//   替代原 regex + 手写括号平衡的启发式实现。
//   ⚠️ 改造前两版遗留的问题：587-R M1 版按「参数文本字面等于 'name'」纯文本相等放行（任意位置的
//   `grabFnA(name)` 都会被放过）；S4c 版加了"循环体内、参数恰为循环变量"的结构判据，但①循环的
//   `right`（被遍历的是什么）完全不检查——`for (const name of ['x'])` 这种遍历**任意内联数组**的循环
//   同样会被判豁免，而这个数组的内容从未被证明是"已审计过的合法目标函数名清单"；②仍是正则+手写括号
//   计数，字符串字面量里出现裸 `{`/`}` 会打乱计数；③不识别"循环体内嵌套函数用同名参数遮蔽循环变量"
//   这种情况——遮蔽后该函数体内的 `name` 已是另一个绑定，不该继续豁免。
//   本版全部改用 acorn 真实语法树：豁免须同时满足——① 调用落在某个 `for (const <var> of <right>) {…}`
//   循环体内；② `<right>` 必须是本文件登记的目标枚举标识符 G1_GRAB_FN_A_LOOP_TARGETS（不接受任意内联
//   数组字面量，见下方常量定义）；③ 从循环体顶层到该调用之间，若途经任何嵌套函数（声明/表达式/箭头）
//   用同名参数遮蔽了循环变量，则该函数体内的调用不再豁免。
const G1_GRAB_FN_A_LOOP_TARGETS_NAME = 'G1_GRAB_FN_A_LOOP_TARGETS';
// eslint-disable-next-line no-unused-vars
const G1_GRAB_FN_A_LOOP_TARGETS = ['esc', 'siTlChangeValueHtml', 'siRenderTimelineChanges', 'siTlChangeObjectText', 'siRenderTimeline', 'siTlChangesHtml'];
function paramDeclaresName(paramNode, name) {
    if (!paramNode) return false;
    if (paramNode.type === 'Identifier') return paramNode.name === name;
    if (paramNode.type === 'AssignmentPattern') return paramDeclaresName(paramNode.left, name);
    if (paramNode.type === 'RestElement') return paramDeclaresName(paramNode.argument, name);
    if (paramNode.type === 'ObjectPattern') return (paramNode.properties || []).some((p) => paramDeclaresName(p.value || p.argument, name));
    if (paramNode.type === 'ArrayPattern') return (paramNode.elements || []).some((el) => paramDeclaresName(el, name));
    return false;
}
function walkAllAcornNodes(node, visit) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    visit(node);
    for (const key in node) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
        const val = node[key];
        if (Array.isArray(val)) { for (const item of val) walkAllAcornNodes(item, visit); }
        else if (val && typeof val === 'object' && typeof val.type === 'string') walkAllAcornNodes(val, visit);
    }
}
// [长任务B S4c3·codex 591-R M4] 把「G1 枚举标识符是否指向本文件模块级声明」与「循环变量是否被内层
//   同名声明遮蔽」统一改成真实作用域链解析，替代旧版「按名字字符串相等就信」（枚举名）与「只查函数
//   参数遮蔽」（循环变量）两处过窄判据。591-R 报告的绕过面：① 局部同名 `const G1_GRAB_FN_A_LOOP_TARGETS`
//   在内层函数/块里重新声明后替换遍历目标——旧版只比对 Identifier.name 字符串，不管它实际绑定的是
//   模块级那份还是局部重声明的那份，一律放行；② 循环体内 `const name = ...` 块级声明 / 嵌套
//   `for (const name of ...)` 用同名变量遮蔽外层循环变量——旧版 `collectExemptGrabFnACallStarts` 只识别
//   "嵌套函数用同名参数遮蔽"这一种遮蔽形态，块级声明与嵌套 for-of 两种遮蔽形态视而不见。
//
// collectPatternNames：从任意绑定模式（Identifier/ObjectPattern/ArrayPattern/AssignmentPattern/
//   RestElement）里递归收集全部被声明的标识符名，供作用域帧收集变量名与函数参数名共用。
function collectPatternNames(pat, names) {
    if (!pat) return;
    if (pat.type === 'Identifier') { names.add(pat.name); return; }
    if (pat.type === 'ObjectPattern') {
        for (const p of pat.properties) collectPatternNames(p.type === 'RestElement' ? p.argument : p.value, names);
        return;
    }
    if (pat.type === 'ArrayPattern') { for (const el of pat.elements) { if (el) collectPatternNames(el, names); } return; }
    if (pat.type === 'AssignmentPattern') { collectPatternNames(pat.left, names); return; }
    if (pat.type === 'RestElement') { collectPatternNames(pat.argument, names); return; }
}
// 收集一个 BlockStatement 直接子语句里声明的名字（const/let 变量 + 具名函数声明）——只看直接子语句，
// 不下探嵌套块/函数（那些各自另起一帧，遮蔽判定按帧链逐层核对，不需要在这里合并）。
function collectLocalScopeNames(blockNode) {
    const names = new Set();
    for (const stmt of blockNode.body || []) {
        if (stmt.type === 'VariableDeclaration' && (stmt.kind === 'const' || stmt.kind === 'let')) {
            for (const d of stmt.declarations) collectPatternNames(d.id, names);
        } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
            names.add(stmt.id.name);
        }
    }
    return names;
}
// [长任务B S4c3·codex 591-R2 M4b·主会话亲核订正] `var` 是函数作用域（不是块作用域）——此前函数帧只收
// 参数名+函数自身 id，函数体内（含任意深度嵌套的 if/for/while/switch/try 等块，但**不含**嵌套函数，
// 那些各自另起自己的 var 作用域）出现的 `var` 声明完全没有被计入函数帧，导致"函数内嵌套函数体内的
// var 遮蔽外层枚举/循环变量"这类遮蔽形态判据视而不见。递归收集时遇到 FunctionDeclaration/
// FunctionExpression/ArrowFunctionExpression 立即停止下探（那是另一个函数的作用域边界）。
function collectVarNamesInFunctionBody(node, names) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') return;
    if (node.type === 'VariableDeclaration' && node.kind === 'var') {
        for (const d of node.declarations) collectPatternNames(d.id, names);
    }
    for (const key in node) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range' || key === '__scopeChain' || key === '__ownFrame') continue;
        const val = node[key];
        if (Array.isArray(val)) { for (const item of val) collectVarNamesInFunctionBody(item, names); }
        else if (val && typeof val === 'object' && typeof val.type === 'string') collectVarNamesInFunctionBody(val, names);
    }
}
// annotateScopeChains：整棵 AST 只走一次，给每个节点挂 `__scopeChain`（从最外层非 Program 作用域到
// 最内层、按嵌套顺序排列的 Set 数组；不含 Program 顶层本身——模块级声明天然不算"遮蔽"）。ForOfStatement
// 额外挂 `__ownFrame`，指向它自己那个循环变量专属的 Set 对象引用（用于后续区分"这就是外层目标循环
// 自己的绑定"还是"被更内层同名声明顶替"）。
function annotateScopeChains(programAst) {
    function visit(node, scopeStack) {
        if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
        node.__scopeChain = scopeStack;
        let nextStack = scopeStack;
        if (node.type === 'BlockStatement') {
            nextStack = scopeStack.concat([collectLocalScopeNames(node)]);
        } else if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
            const frame = new Set();
            if (node.left.type === 'VariableDeclaration') { for (const d of node.left.declarations) collectPatternNames(d.id, frame); }
            node.__ownFrame = frame;
            nextStack = scopeStack.concat([frame]);
        } else if (node.type === 'ForStatement') {
            const frame = new Set();
            if (node.init && node.init.type === 'VariableDeclaration') { for (const d of node.init.declarations) collectPatternNames(d.id, frame); }
            nextStack = scopeStack.concat([frame]);
        } else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
            const frame = new Set();
            for (const p of node.params) collectPatternNames(p, frame);
            if (node.id) frame.add(node.id.name);
            // [S4c3·M4b] var 提升到函数顶层，须计入函数自己的帧（不下探嵌套函数，见函数头注）。
            collectVarNamesInFunctionBody(node.body, frame);
            nextStack = scopeStack.concat([frame]);
        } else if (node.type === 'CatchClause' && node.param) {
            const frame = new Set();
            collectPatternNames(node.param, frame);
            nextStack = scopeStack.concat([frame]);
        } else if (node.type === 'SwitchStatement') {
            // [S4c3·M4b] switch 的全部 case 共享**一个**词法作用域帧（ECMAScript 语义：没有花括号包裹的
            // case 分支不各自另起块作用域，`case 'a': const x=1; case 'b': const y=2;` 里 x/y 同属一帧）。
            // 若某个 case 分支自己又用花括号包成 BlockStatement，那个花括号会照既有 BlockStatement 分支
            // 另起自己的帧，这里只收集"直接挂在 case.consequent 数组里、没有额外花括号包裹"的声明。
            const frame = new Set();
            for (const c of node.cases) {
                for (const stmt of c.consequent) {
                    if (stmt.type === 'VariableDeclaration' && (stmt.kind === 'const' || stmt.kind === 'let')) {
                        for (const d of stmt.declarations) collectPatternNames(d.id, frame);
                    } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
                        frame.add(stmt.id.name);
                    }
                }
            }
            nextStack = scopeStack.concat([frame]);
        }
        for (const key in node) {
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range' || key === '__scopeChain' || key === '__ownFrame') continue;
            const val = node[key];
            if (Array.isArray(val)) { for (const item of val) visit(item, nextStack); }
            else if (val && typeof val === 'object' && typeof val.type === 'string') visit(val, nextStack);
        }
    }
    visit(programAst, []);
}
// 判定某节点处引用的标识符 name 是否被其祖先作用域链中的任意一帧遮蔽（用于 G1 枚举标识符——祖先链
// 里只要有任何一帧含同名声明，就说明该处引用解析到的不是模块级顶层声明，而是局部重声明）。
function isNameShadowedAtNode(node, name) {
    return (node.__scopeChain || []).some((frame) => frame.has(name));
}
// 收集"确实豁免"的 grabFnA(loopVar) 调用起点——loopVarFrame 是外层目标循环自己那个变量帧的**引用**
// （非按名字比较）：对 bodyNode 内每个 grabFnA(<loopVar 同名标识符>) 调用，从其 __scopeChain 由内向外
// 找第一个含 loopVar 名字的帧；只有这个"最近绑定帧"恰好就是 loopVarFrame 本身（引用相等）才算真的
// 引用外层目标循环变量——嵌套函数参数遮蔽 / 块级 `const <loopVar>` 遮蔽 / 嵌套同名 for-of 遮蔽，
// 无论哪种，最近绑定帧都会是那个更内层的新帧而非 loopVarFrame，天然判红，不用逐种遮蔽形态分别写判据。
function collectExemptGrabFnACallStarts(bodyNode, loopVar, loopVarFrame, exemptStarts) {
    walkAllAcornNodes(bodyNode, (n) => {
        if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'grabFnA') return;
        if (n.arguments.length !== 1 || n.arguments[0].type !== 'Identifier' || n.arguments[0].name !== loopVar) return;
        const chain = n.__scopeChain || [];
        let nearestFrame = null;
        for (let i = chain.length - 1; i >= 0; i--) {
            if (chain[i].has(loopVar)) { nearestFrame = chain[i]; break; }
        }
        if (nearestFrame === loopVarFrame) exemptStarts.add(n.start);
    });
}
function findNonExemptGrabFnACalls(cleanSrc) {
    let ast;
    try {
        ast = acorn.parse(cleanSrc, { ecmaVersion: 'latest', allowReturnOutsideFunction: true });
    } catch (e) {
        ast = null;   // fail-closed 兜底见下方
    }
    if (!ast) {
        // 解析失败——不静默放行，退回按纯文本抓取全部 grabFnA(...) 调用参数文本，一律计入违规。
        const bad = [];
        for (const gm of cleanSrc.matchAll(/grabFnA\(\s*([^)]*)\)/g)) {
            const argText = gm[1].trim();
            if (!/^'[^']+'$/.test(argText)) bad.push(argText);
        }
        return bad;
    }
    annotateScopeChains(ast);   // [S4c3·M4] 先给整棵树挂作用域链，下面两处判据都要用它来解析真实绑定
    const exemptStarts = new Set();
    walkAllAcornNodes(ast, (node) => {
        if (node.type !== 'ForOfStatement' || node.left.type !== 'VariableDeclaration') return;
        const decl = node.left.declarations[0];
        if (!decl || decl.id.type !== 'Identifier') return;
        // [S4c3·M4] 枚举标识符须字面上是 G1_GRAB_FN_A_LOOP_TARGETS，**且**该处引用未被任何祖先作用域
        // 里的同名局部重声明遮蔽——否则它实际绑定的是局部替换的数组，不是本文件登记的模块级枚举。
        const isTargetEnum = node.right.type === 'Identifier' && node.right.name === G1_GRAB_FN_A_LOOP_TARGETS_NAME
            && !isNameShadowedAtNode(node, G1_GRAB_FN_A_LOOP_TARGETS_NAME);
        if (!isTargetEnum) return;
        collectExemptGrabFnACallStarts(node.body, decl.id.name, node.__ownFrame, exemptStarts);
    });
    const bad = [];
    walkAllAcornNodes(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'grabFnA') return;
        const arg = node.arguments[0];
        if (arg && arg.type === 'Literal' && typeof arg.value === 'string') return;   // 字面量字符串，天然安全
        if (exemptStarts.has(node.start)) return;   // 结构上确认落在登记枚举的循环体内、参数恰为该循环变量、未被遮蔽
        bad.push(arg && arg.type === 'Identifier' ? arg.name : (arg ? cleanSrc.slice(arg.start, arg.end) : '(无参)'));
    });
    return bad;
}
let __selfCleanForG1Mutation = null;   // 供文末 [G1] mutated 反例复用，避免重新 readFile+stripComments
const EXTRACT_FN_BODY_TARGET_NAMES = (() => {
    const names = new Set();
    const re1 = /extractFunctionBody\(\s*(?:src|mutated|indexJsSrc)\s*,\s*'([^']+)'\s*\)/g;
    const re2 = /grabFnA\('([^']+)'\)/g;
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    // [S5b-4] 在**剥注释后**的文本上扫：注释里写的示例（如 grabFnA('…')）会被当成目标名「…」→ acorn 找不到而假红
    const selfClean = stripComments(selfSrc);
    // [长任务B S4c2·codex 590 裁定] findNonExemptGrabFnACalls 已改为 acorn 真实解析——喂给它的必须是
    //   **原始**源码（含真注释/真正则字面量），不能是 stripComments() 的产物：本文件体量大、含多处
    //   正则字面量，naive 的 `//`/`/* */` 剥离正则会把正则字面量内部的 `//` 序列误当行注释切断，
    //   产出语法上不再合法的 JS（acorn.parse 直接抛「Unterminated regular expression」），
    //   findNonExemptGrabFnACalls 内部的 try/catch 会静默退化到旧版纯文本兜底、完全绕过新判据——
    //   这条踩坑已实测复现，改存原始 selfSrc（真解析器自己正确跳过注释，不需要也不能预先剥离）。
    __selfCleanForG1Mutation = selfSrc;
    let mm;
    while ((mm = re1.exec(selfClean))) names.add(mm[1]);
    while ((mm = re2.exec(selfClean))) names.add(mm[1]);
    // [S5b·Opus 预筛 M2] 自扫正则只认「第一参 ∈ src/mutated/indexJsSrc + 第二参单引号字面量」与 grabFnA('…')，
    //   **非字面量传名**（如 :513 一带 `for (const fn of [...]) extractFunctionBody(src, fn)`）扫不到——那三个名字
    //   此前只是恰好在别处另有字面量调用点才进了集合。反向封闭：枚举全文所有 `extractFunctionBody(` 调用（剥注释），
    //   凡不匹配 re1 形态的，必须落在已知白名单形态内（本函数定义行 / 本 check 自身 `extractFunctionBody(src, name)` /
    //   grabFnA 内部 / :513 的 fn 循环），且循环数组里的名字必须已在集合内——否则报错，不让「变量传名新增目标」静默漏出验证面。
    // 只认真正的调用（前面不是 "function " 定义、也不是正则字面量里的转义形态 "extractFunctionBody\("）
    const allCalls = [...selfClean.matchAll(/(?<!function\s)extractFunctionBody\(\s*([^)]*)\)/g)].map(m => m[1].replace(/\s+/g, ' ').trim());
    const literalRe = /^(?:src|mutated|indexJsSrc) *, *'[^']+'$/;
    const nonLiteral = allCalls.filter(a => !literalRe.test(a));
    // 已知白名单形态：本 check 自身 (src, name) / grabFnA 内部 (src, name) / :513 一带 fn 循环 (src, fn)
    // [S6a·codex 587-R M1] 白名单不再按参数文本"全局放行"，而是**精确计数**：'src, name' 恰 2 处（grabFnA 内部 + S5 check 自身）、
    //   'src, fn' 恰 1 处（:513 一带循环）——新增任何一处 \`const name = '…'; extractFunctionBody(src, name)\` 之类的动态调用
    //   都会让计数 +1 判红，而不是被同文本白名单放过；grabFnA 的非字面量调用恰 0 处（同理封住 grabFnA(name) 入口）。
    const countOf = (txt) => nonLiteral.filter(a => a === txt).length;
    const EXPECTED_NON_LITERAL = { 'src, name': 2, 'src, fn': 1 };
    const unknown = nonLiteral.filter(a => !(a in EXPECTED_NON_LITERAL));
    if (unknown.length) throw new Error('[S5b] extractFunctionBody 出现未登记的非字面量调用形态（交叉验证面会静默缺口）：' + JSON.stringify(unknown) + '——要么改成字面量传名，要么把名字并入集合并登记形态');
    for (const [txt, expected] of Object.entries(EXPECTED_NON_LITERAL)) {
        if (countOf(txt) !== expected) throw new Error('[S6a] 动态传名形态「' + txt + '」的调用次数应恰 ' + expected + '，实得 ' + countOf(txt) + '——新增动态传名调用不进交叉验证集合，禁止');
    }
    const grabDynamic = findNonExemptGrabFnACalls(selfSrc);
    if (grabDynamic.length) throw new Error('[S6a] grabFnA 出现非字面量调用（不进交叉验证集合）：' + JSON.stringify(grabDynamic));
    // 只认循环体内真的调用了 extractFunctionBody(src, fn) 的循环（本文件另有"这些函数应已删除"的负向 fn 循环，不相干）
    let extractLoops = 0;
    for (const lm of selfClean.matchAll(/for \(const fn of \[([^\]]+)\]\)\s*\{/g)) {
        const body = selfClean.slice(lm.index, lm.index + 400);
        if (!/extractFunctionBody\(src, fn\)/.test(body)) continue;
        extractLoops += 1;
        for (const nm of [...lm[1].matchAll(/'([^']+)'/g)].map(m => m[1])) {
            if (!names.has(nm)) throw new Error('[S5b] 变量传名循环里的 ' + nm + ' 不在交叉验证集合内（无字面量调用点兜底）');
        }
    }
    if (extractLoops !== 1) throw new Error('[S5b] 用变量 fn 调用 extractFunctionBody 的循环应恰 1 处（:513 一带），实得 ' + extractLoops + '——形态变了要同步本自检');
    return [...names].sort();
})();

// 递归 walk 整棵 AST（不引入 acorn-walk，手写足够）：对每个节点，遍历其自身属性，凡值是"看起来像
// AST 节点"（有 .type 字符串）的对象或此类对象组成的数组，递归下探——这样嵌套在其它函数体内的
// FunctionDeclaration（闭包内再声明具名函数）同样能被发现，不局限于顶层 body。
function walkFunctionDeclarations(node, names, out) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && node.id && names.has(node.id.name)) {
        (out[node.id.name] = out[node.id.name] || []).push({ start: node.body.start, end: node.body.end });
    }
    for (const key in node) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
        const val = node[key];
        if (Array.isArray(val)) {
            for (const item of val) walkFunctionDeclarations(item, names, out);
        } else if (val && typeof val === 'object' && typeof val.type === 'string') {
            walkFunctionDeclarations(val, names, out);
        }
    }
}

check('[S5 甲2] acorn 交叉验证：extractFunctionBody 对全部目标函数的提取边界与真实 AST 逐字节一致', () => {
    // src 是整段 HTML（:87 fs.readFileSync 的就是 Sys_Iteration.html 全文），先切出内联 <script>…</script>
    // 块（跳过带 src= 的外链脚本，也跳过 type 非 JS 的内联块如 application/json）——本文件当前只有一个
    // 内联块，但写成通用循环不假设"只有一个"，未来多块也能覆盖。
    const scriptBlocks = [];
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
    let sm;
    while ((sm = scriptRe.exec(src))) {
        const attrs = sm[1];
        if (/\bsrc\s*=/.test(attrs)) continue;
        if (/\btype\s*=\s*["'](?!text\/javascript|module)[^"']*["']/.test(attrs)) continue;
        // [S5b·L1/L2] 记录 type 属性（module 块按 module 解析，否则 import/export 会让 check 假红）与块在 src 全文里的起点（同址断言用）
        scriptBlocks.push({ text: sm[2], isModule: /\btype\s*=\s*["']module["']/.test(attrs), srcOffset: sm.index + sm[0].indexOf(sm[2]) });
    }
    assert.ok(scriptBlocks.length > 0, '未在 Sys_Iteration.html 中找到内联 <script> 块（跳过外链/非 JS type 后）');

    const namesSet = new Set(EXTRACT_FN_BODY_TARGET_NAMES);
    const foundByName = {};
    for (const blk of scriptBlocks) {
        const block = blk.text;
        const ast = acorn.parse(block, { ecmaVersion: 'latest', sourceType: blk.isModule ? 'module' : 'script' });
        const perBlock = {};
        walkFunctionDeclarations(ast, namesSet, perBlock);
        for (const name in perBlock) {
            (foundByName[name] = foundByName[name] || []).push(...perBlock[name].map(x => ({ ...x, blockText: block, srcStart: blk.srcOffset + x.start })));
        }
    }

    const problems = [];
    for (const name of EXTRACT_FN_BODY_TARGET_NAMES) {
        const matches = foundByName[name] || [];
        if (matches.length === 0) {
            problems.push(`${name}：acorn AST 中未找到 FunctionDeclaration（extractFunctionBody 靠正则找到了却在真实语法树里找不到，说明正则匹配到了非声明位置，如注释/字符串里的同名文本）`);
            continue;
        }
        // extractFunctionBody 用 regex.exec(source) 只取源码里"第一个"匹配（未指定 g 标志、从头开始
        // 搜），若同名声明有多处，只有位置最靠前那个会被现有实现实际消费——取 AST 里 start 最小的一条
        // 与之对齐比较；但"存在多处同名声明"本身就是可疑信号，无论比对是否相等都单独报出，不静默吞掉。
        matches.sort((a, b) => a.srcStart - b.srcStart);   // [S5b·L2] 按 src 全文偏移排序（块内偏移跨块无意义）
        if (matches.length > 1) {
            problems.push(`${name}：AST 中发现 ${matches.length} 处同名 FunctionDeclaration（extractFunctionBody 只会取正则命中的第一处，若与 AST 的"起始位置最小"那处不是同一处会掩盖問題——本次仍按起始位置最小对齐比较，但请人工确认是否为有意的重名）`);
        }
        const first = matches[0];
        const acornText = first.blockText.slice(first.start, first.end);
        // [S5b·L2] 「字节相等」升级为「同址且相等」：extractFunctionBody 取的是 src 全文首个匹配，其起点必须等于 acorn 节点换算到全文的起点
        const naiveStart = (() => { const m = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(src); return m ? m.index + m[0].length - 1 : -1; })();
        if (naiveStart !== first.srcStart) problems.push(`${name}：起点不同址——extractFunctionBody 正则首个匹配起点 ${naiveStart}，acorn 节点全文起点 ${first.srcStart}`);
        const naiveText = extractFunctionBody(src, name);
        if (naiveText === null) {
            problems.push(`${name}：extractFunctionBody 返回 null（正则未匹配到 "function ${name}(...) {"），但 AST 里能找到该函数声明——两者矛盾`);
            continue;
        }
        if (acornText !== naiveText) {
            let diffAt = 0;
            const n = Math.min(acornText.length, naiveText.length);
            while (diffAt < n && acornText[diffAt] === naiveText[diffAt]) diffAt++;
            const ctx = (s, i) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
            problems.push(`${name}：边界不一致 — acorn 长度 ${acornText.length}，extractFunctionBody 长度 ${naiveText.length}，首个差异偏移 ${diffAt}；acorn 处附近=${ctx(acornText, diffAt)}；extractFunctionBody 处附近=${ctx(naiveText, diffAt)}`);
        }
    }
    assert.strictEqual(problems.length, 0, `${problems.length} 个目标未通过 acorn 交叉验证：\n  - ${problems.join('\n  - ')}`);
});

console.log('— §① 「上线单管理」入口不挂 META_OK（§6.7）—');
check('siRenderHeadActions 存在', () => {
    assert.ok(src.includes('function siRenderHeadActions()'), '缺 siRenderHeadActions 定义');
});
check('「上线单管理」按钮（siOpenBatch）守卫条件不含 META_OK', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    assert.ok(body, '未提取到 siRenderHeadActions 函数体');
    const cond = guardConditionBefore(body, 'onclick="siOpenBatch()"');
    assert.ok(!cond.includes('META_OK'), `守卫条件含 META_OK：${cond}`);
    // 正向锚点：条件应仍是 admin∨对接人（防止未来把整个 if 删掉变成"无条件可见"这种过度放开，
    // 那不是本条不变量的本意——本意是"不因 meta 加载失败而锁死"，不是"零权限门"）。
    assert.ok(cond.includes('isAdmin()') && cond.includes('isSiIntakeLiaison'), `守卫条件应仍含 admin/对接人判断，实际：${cond}`);
});
check('「值班排班」入口（siOpenDutyRoster）守卫条件不含 META_OK（§6.15 登录即可见，同一不变量另一实例）', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenDutyRoster()"');
    assert.ok(!cond.includes('META_OK'), `守卫条件含 META_OK：${cond}`);
});

console.log('— §② siOpenBatchDetail（安排上线/执行上线/撤销上线安排）整体不引用 META_OK —');
check('siOpenBatchDetail 存在且含三个上线动作按钮（C5 订正：安排上线按钮改名 siReleaseSetExecutorsModal）', () => {
    const body = extractFunctionBody(src, 'siOpenBatchDetail');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    assert.ok(body.includes('siReleaseSetExecutorsModal'), '缺「安排上线」按钮（siReleaseSetExecutorsModal，C5 重写前旧名 siReleaseNotifyExecutor）');
    assert.ok(body.includes('siReleaseExecuteModal'), '缺「确认上线完成」按钮（siReleaseExecuteModal）');
    assert.ok(body.includes('siReleaseCancelScheduleModal'), '缺「撤销上线安排」按钮（siReleaseCancelScheduleModal）');
});
check('siOpenBatchDetail 函数体（剥注释后）不含 META_OK（三个动作按钮及其外层容器函数整体不受 meta 加载成败影响）', () => {
    const body = extractFunctionBody(src, 'siOpenBatchDetail');
    const code = stripComments(body);
    assert.ok(!code.includes('META_OK'), 'siOpenBatchDetail 函数体（代码，非注释）内出现了 META_OK，§6.7 不变量被破坏');
});

console.log('— §③（2026-08-02 用户裁定二新增）「⚙️ 管理」下拉结构不变量 —');
check('五个入口（上线单管理/值班排班/上线日志/删除审计/流程说明）的 onclick 标记均落在 .u-head-menu-item 菜单项模板内', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const markers = ['onclick="siOpenBatch()"', 'onclick="siOpenDutyRoster()"', 'onclick="siOpenReleaseLog()"', 'onclick="siOpenDeleteAudit()"', 'onclick="siOpenFlowGuide()"'];
    for (const marker of markers) {
        const mi = body.indexOf(marker);
        assert.ok(mi >= 0, `未找到标记 "${marker}"`);
        // 就近往前找 u-head-menu-item 类名——五个入口的模板串写法均为
        // `<button ... class="u-head-menu-item" ... onclick="siOpenXxx()">`，class 在 onclick 之前
        // 同一开始标签内，lastIndexOf 能命中同一标签内的类名，不会跨到别的无关标签。
        const classIdx = body.lastIndexOf('u-head-menu-item', mi);
        assert.ok(classIdx >= 0 && mi - classIdx < 120, `"${marker}" 未挂在 .u-head-menu-item 菜单项模板内（疑似被移出下拉菜单）`);
    }
});
check('「+ 新建迭代单」（siOpenCreate）不带 u-head-menu-item 菜单项类名——保持独立主按钮，不进下拉', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const mi = body.indexOf('onclick="siOpenCreate()"');
    assert.ok(mi >= 0, '未找到「新建迭代单」标记');
    const nearBefore = body.slice(Math.max(0, mi - 200), mi);
    assert.ok(!nearBefore.includes('u-head-menu-item'), '「新建迭代单」标记附近出现 u-head-menu-item，疑似被误挪进下拉菜单');
});
check('下拉本体（触发按钮 u-head-menu-trigger + 面板 u-head-menu-list）仅在 menuItems 非空时才拼进 html（"至少一个菜单项可见才渲染"）', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const code = stripComments(body);
    assert.ok(/if\s*\(\s*menuItems\s*\)\s*\{/.test(code), '未找到 `if (menuItems) {` 门控——下拉本体应仅在至少一个菜单项存在时才拼进 html');
    assert.ok(code.includes('u-head-menu-trigger') && code.includes('u-head-menu-list'), '下拉触发按钮/面板结构缺失');
});

console.log('— §④ 反向边界：META_OK 异常态下应该降级的入口仍正确挂着门（防守卫被连带误删）—');
check('「+ 新建迭代单」（siOpenCreate）守卫条件含 META_OK', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenCreate()"');
    assert.ok(cond.includes('META_OK'), `期望仍挂 META_OK 门，实际条件：${cond}`);
});
check('「删除审计」（siOpenDeleteAudit）守卫条件含 META_OK', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenDeleteAudit()"');
    assert.ok(cond.includes('META_OK'), `期望仍挂 META_OK 门，实际条件：${cond}`);
});
check('「上线日志」（siOpenReleaseLog，2026-07-31 新增）守卫条件含 META_OK（与「删除审计」同门槛）', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenReleaseLog()"');
    assert.ok(cond.includes('META_OK'), `期望仍挂 META_OK 门，实际条件：${cond}`);
    assert.ok(cond.includes('isAdmin()'), `期望仍挂 isAdmin() 门，实际条件：${cond}`);
});
// ⭐ [C7 裁定·2026-07-29 → 2026-07-30 终局] C7 曾"隐藏入口保留代码"过渡；2026-07-30 用户裁定旧上线编排
//   家族 4 端点全封（assign-release-dev/reassign-release-dev/notify-release-executor(-batch)），前端面板/
//   弹窗/通知按钮代码整体删除。以下断言锁定"删干净且不被误恢复"——匹配模式取"function 定义/onclick/
//   siApi 调用点"三种形态，注释里的历史提及不误伤。
check('「上线编排」legacy 面板入口不再渲染（onclick 调用点全文零残留）', () => {
    assert.ok(!src.includes('onclick="siOpenReleaseOrch()"'),
        '期望「上线编排」入口已删除（2026-07-30 家族封禁），实际仍在渲染');
});
check('旧编排面板/弹窗/通知按钮函数定义已整体删除', () => {
    for (const fn of ['siOpenReleaseOrch', 'siRenderReleaseOrchPanel', 'siReleaseOrchState',
        'siModalBatchAssignReleaseDev', 'siBatchNotifyReleaseExecutor', 'siModalAssignReleaseDev',
        'siNotifyReleaseExecutorClick']) {
        assert.ok(!src.includes(`function ${fn}(`), `期望 ${fn} 函数定义已删除（2026-07-30 家族封禁），实际仍在`);
    }
});
check('4 个被封端点的前端调用点零残留', () => {
    for (const ep of ["siApi('/sys-issues/assign-release-dev'", "siApi('/sys-issues/reassign-release-dev'",
        "siApi('/sys-issues/notify-release-executor-batch'", "siNotifyManual('notify-release-executor'"]) {
        assert.ok(!src.includes(ep), `期望前端调用点已删（2026-07-30 家族封禁）：${ep}`);
    }
});
check('去注释源码中被封端点路径字面量零残留（防别名/fetch/模板串重新接线，codex 208 LOW-2）', () => {
    // 剥掉 // 与 /* */ 注释后扫描端点路径字面量——上一条只锁 siApi/siNotifyManual 两种既有调用形态，
    // 本条兜"换个包装函数重新接线"的形态（任何可执行调用都绕不开路径字符串本身）。
    // 注意 '/sys-issues/notify-release-executor' 同时覆盖 -batch 前缀；notify-read-status 是另一条路径不受影响。
    const code = stripComments(src);
    for (const lit of ['/sys-issues/assign-release-dev', '/sys-issues/reassign-release-dev', '/sys-issues/notify-release-executor']) {
        assert.ok(!code.includes(lit), `期望去注释源码不含被封端点路径字面量 ${lit}（2026-07-30 家族封禁）`);
    }
    // 复审 risk-1 采纳：单条通知端点路径含 :id 段（/sys-issues/${id}/notify-release-executor），模板串形态
    // 不含上面的连续字面量——补裸 token 扫描兜住。assign/reassign 是无 :id 的固定路径，字面量已覆盖；
    // 且裸 'assign-release-dev' 在通用循环抑制行（meta 条目保留的既定决策）里合法存在，不能同样裸扫。
    assert.ok(!code.includes('notify-release-executor'),
        '期望去注释源码不含裸 token notify-release-executor（含模板串 :id 路径形态，2026-07-30 家族封禁）');
});
check('「流程说明」（siOpenFlowGuide）守卫条件含 META_OK', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenFlowGuide()"');
    assert.ok(cond.includes('META_OK'), `期望仍挂 META_OK 门，实际条件：${cond}`);
});

console.log('— §⑥（C5·方案 §4.5，预筛 MED-1/L3/L9/L10 订正；决策 7 三修下限 2→1）选人弹窗组件结构（fetch/render 两段·两处复用·无群发·选不足 1 人置灰）—');
check('siExecutorPickerModal（fetch 段）存在，请求 executor-candidates + await 后补 siAuditGen/overlay 双检查（L9），交给 siExecutorPickerRender 渲染', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerModal');
    assert.ok(body, '未提取到 siExecutorPickerModal 函数体');
    assert.ok(body.includes('/sys-releases/executor-candidates'), '未请求候选端点');
    assert.ok(body.includes('siAuditGen'), 'L9：await siApi 后应补 siAuditGen 双检查（同 :4914 一带先例纪律）');
    assert.ok(body.includes('siBatchOverlay'), 'L9：await siApi 后应补 siBatchOverlay 打开态检查');
    assert.ok(body.includes('siExecutorPickerRender'), '未见调用 siExecutorPickerRender 渲染段');
});
check('siExecutorPickerRender（纯渲染段）消费 selected_by_default/skipped_defaults，不发起任何网络请求，不自动调用任何通知端点', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerRender');
    assert.ok(body, '未提取到 siExecutorPickerRender 函数体');
    assert.ok(body.includes('selected_by_default'), '未消费默认候选（决策 8：排班∪固定默认执行人并集）');
    assert.ok(body.includes('skipped_defaults'), '未展示 skipped_defaults 非阻断提示（v1.4·codex 254-C LOW-3：跳过不静默）');
    const code = stripComments(body);
    assert.ok(!/siApi\(/.test(code), 'siExecutorPickerRender 是纯渲染段，不应自己发请求（候选数据须由调用方传入）');
    assert.ok(!/notify-executor|\/notify['"]/.test(code), 'siExecutorPickerRender 本体不应直接调用任何通知端点（决策 4：选人与发通知是两个独立动作）');
});
check('两处复用：siReleaseSetExecutorsModal（安排上线）经 siExecutorPickerModal、siModalHotfix（应急一键）经自己 fetch 后直调 siExecutorPickerRender——都落到同一份渲染逻辑，不各写一份', () => {
    const setExecBody = extractFunctionBody(src, 'siReleaseSetExecutorsModal');
    assert.ok(setExecBody && setExecBody.includes('siExecutorPickerModal'), 'siReleaseSetExecutorsModal 未复用选人弹窗组件（fetch 段）');
    const hotfixBody = extractFunctionBody(src, 'siModalHotfix');
    assert.ok(hotfixBody, '未提取到 siModalHotfix 函数体');
    assert.ok(hotfixBody.includes('siExecutorPickerRender'), 'siModalHotfix 未复用选人弹窗渲染段（登记清单②：executors[] 需复用同一选人弹窗 UI，MED-1+L3 订正后走渲染段直连，不再经 fetch 段重复请求）');
});
check('siReleaseSetExecutorsModal 确认后只调 PUT executors，不调用任何通知端点（v1.2 修正：确认后 PUT+notify 两步与"无群发按钮"矛盾）', () => {
    const body = extractFunctionBody(src, 'siReleaseSetExecutorsModal');
    const code = stripComments(body);
    assert.ok(/\/executors['"]/.test(code) && /method:\s*'PUT'/.test(code), '未找到 PUT .../executors 调用');
    assert.ok(!code.includes('/notify'), 'siReleaseSetExecutorsModal 不应调用任何 .../notify 端点（决策 4：选人确认绝不自动发送）');
});
check('（反转·用户拍板决策 7 第三次修正，方案 v1.7 二订）选不足 1 人时确认按钮置灰（siExecPickerUpdateHint 操作 siMConfirm.disabled，判据 n<1，下限 2→1）', () => {
    const body = extractFunctionBody(src, 'siExecPickerUpdateHint');
    assert.ok(body, '未提取到 siExecPickerUpdateHint 函数体');
    const code = stripComments(body);
    // 红灯诊断：原判据 `n<2` 钉的是三修前的下限，非实现错——本条随决策 7 三修反转为 `n<1`
    // （[[feedback_test_assertion_self_error]]：断言过时，不是代码坏了）。
    assert.ok(/n\s*<\s*1/.test(code), '未找到"少于 1 人"判据（决策 7 三修：下限 2→1）');
    assert.ok(!/n\s*<\s*2/.test(code), '不应再出现"少于 2 人"判据残留（决策 7 三修应已整体改为 <1，若命中说明改造不完整）');
    assert.ok(code.includes('btn.disabled = true') && code.includes('btn.disabled = false'), '未找到确认按钮置灰/解禁两个分支');
    // v1.3 改口径：不写"前后端各一人"这类承诺了做不到的话术（系统不校验职能组合，决策 3 终局）。
    assert.ok(!src.includes('前后端各一人') && !src.includes('前后端各1人'), '不应出现"前后端各一人"这类过时话术（v1.3 已订正为"至少选择 1 名执行人"，决策 7 三修下限 2→1）');
});
check('312-M1（codex 合并前建议）：siExecPickerUpdateHint 的计数口径与提交收集逻辑完全一致——均先 querySelectorAll(...:checked) 再 filter(!c.disabled)，不能只数 :checked', () => {
    const hintBody = extractFunctionBody(src, 'siExecPickerUpdateHint');
    const hintCode = stripComments(hintBody);
    assert.ok(/querySelectorAll\('\.si-exec-pick-chk:checked'\)[\s\S]{0,80}filter\(c\s*=>\s*!c\.disabled\)/.test(hintCode),
        '未见 siExecPickerUpdateHint 计数处紧邻 querySelectorAll(...:checked) 的 filter(!c.disabled)——门禁判据用的计数须与提交时真正收集到的人数同源，不能各算各的');
    // 双处口径一致：siExecutorPickerRender（提交收集）与 siExecPickerUpdateHint（门禁计数）用的须是
    // 同一个过滤谓词写法（正则字面量逐字比对，防止两处各写一套语义相同但字面不同的过滤条件，日后
    // 其中一处改了过滤逻辑而另一处忘记同步）。
    const renderBody = extractFunctionBody(src, 'siExecutorPickerRender');
    const renderCode = stripComments(renderBody);
    assert.ok(renderCode.includes('filter(c => !c.disabled)') && hintCode.includes('filter(c => !c.disabled)'),
        'siExecutorPickerRender（提交收集）与 siExecPickerUpdateHint（门禁计数）应逐字使用同一过滤谓词 filter(c => !c.disabled)，双处口径锁死一致');
});
check('无资格候选人置灰展示 + 标注原因（R1b：不静默隐藏）', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerRender');
    const code = stripComments(body);
    assert.ok(code.includes('disabled_reason'), '未读取 disabled_reason');
    assert.ok(/disabled\b/.test(code), '未见 disabled 属性拼接（无资格候选应置灰而非从列表移除）');
});
check('309-M2：默认勾选联合判据 u.eligible && defaultSet.has(...)——disabled 行绝不允许同时带 checked（双重防线第一道：渲染层不产出脏 HTML）', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerRender');
    const code = stripComments(body);
    assert.ok(/u\.eligible\s*&&\s*defaultSet\.has\(/.test(code), '未见 u.eligible && defaultSet.has(...) 联合判据——默认勾选不能只看 defaultSet 单一来源，须同时要求候选本身合格');
});
check('309-M2：选人确认收集阶段叠加 !c.disabled 过滤（双重防线第二道：即便渲染层出了脏 HTML，收集这步也兜得住）', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerRender');
    const code = stripComments(body);
    assert.ok(/querySelectorAll\('\.si-exec-pick-chk:checked'\)[\s\S]{0,80}!c\.disabled/.test(code), '未见收集 ids 时紧邻 querySelectorAll(...:checked) 的 !c.disabled 过滤——:checked 选择器本身不排除 disabled 元素，必须显式过滤');
});
console.log('— §⑥b（预筛 MED-1+L3）siModalHotfix 关键序：先取候选后关第 1 步弹窗，再栈外开选人弹窗 —');
check('siModalHotfix：先 await 取候选清单再关第 1 步弹窗（取失败要保留用户已填内容，不能先关弹窗再取）', () => {
    const body = extractFunctionBody(src, 'siModalHotfix');
    assert.ok(body, '未提取到 siModalHotfix 函数体');
    const fetchIdx = body.indexOf("siApi('/sys-releases/executor-candidates'");
    const closeIdx = body.indexOf('siCloseModal()');
    assert.ok(fetchIdx >= 0, '未找到候选清单请求（应先于任何弹窗关闭动作发起）');
    assert.ok(closeIdx >= 0, '未找到 siCloseModal() 调用');
    assert.ok(fetchIdx < closeIdx, `取候选清单应先于关闭第 1 步弹窗，实际候选请求 offset=${fetchIdx}、siCloseModal offset=${closeIdx}`);
});
check('siModalHotfix：关闭第 1 步弹窗后用 setTimeout 栈外打开选人弹窗（避开 siModal 包装器复位覆盖置灰状态）', () => {
    const body = extractFunctionBody(src, 'siModalHotfix');
    const closeIdx = body.indexOf('siCloseModal()');
    const timeoutIdx = body.indexOf('setTimeout(');
    const renderIdx = body.indexOf('siExecutorPickerRender(');
    assert.ok(timeoutIdx >= 0, '未找到 setTimeout 调用');
    assert.ok(closeIdx >= 0 && closeIdx < timeoutIdx, 'setTimeout 应晚于 siCloseModal() 出现');
    assert.ok(renderIdx > timeoutIdx, 'siExecutorPickerRender 应在 setTimeout 回调内部（栈外）调用，不能与 siCloseModal 同步在一个事件循环里打开下一个弹窗');
});

console.log('— §⑦（C5·方案 §4.5）多人执行人区块渲染（none 态契约·done 行防呆·无全部发送按钮）—');
check('siExecutorSectionHtml 存在，none 态显式空态引导（v1.3·M-c：不能落进未知态兜底渲染出必然 404 的按钮）', () => {
    const body = extractFunctionBody(src, 'siExecutorSectionHtml');
    assert.ok(body, '未提取到 siExecutorSectionHtml 函数体');
    assert.ok(/summary\s*===\s*'none'/.test(body), "未见对 'none' 态的显式判断");
    assert.ok(body.includes('尚未安排执行人'), '未见 none 态空态引导文案');
});
check('done 行不渲染发送按钮**也不渲染查已读按钮**（v1.3·M-b + 309-M1：确认完成后不再有"通知过程"这回事，固化的 read_at 徽标仍照常显示，但两个操作按钮都不再提供）——!isDone 须分别与 siExecutorRowNotify、siExecutorRowReadStatus 两个按钮调用在各自邻域内（L13：邻域判据而非全函数体裸判，防未来函数体膨胀后两者被拆到互不相关的分支）', () => {
    const body = extractFunctionBody(src, 'siExecutorSectionHtml');
    const code = stripComments(body);
    assert.ok(/!isDone[\s\S]{0,400}siExecutorRowNotify/.test(code), '未见 !isDone 条件与 siExecutorRowNotify 按钮调用在 400 字符邻域内——防呆条件应紧邻它守卫的那个按钮，不能隔着老远靠"反正整个函数体里出现过"这种弱判据蒙混过关');
    assert.ok(/!isDone[\s\S]{0,400}siExecutorRowReadStatus/.test(code), '309-M1：未见 !isDone 条件与 siExecutorRowReadStatus 按钮调用在 400 字符邻域内——查已读按钮同样应受 done 行防呆约束，不能只护住发通知按钮');
});
check('执行人区块不含"全部发送/批量发送/一键发送/群发"这类群发入口（决策 4：admin 想什么时候发给谁就点哪一行，行级独立）', () => {
    const body = extractFunctionBody(src, 'siExecutorSectionHtml');
    assert.ok(!body.includes('全部发送') && !body.includes('批量发送') && !body.includes('一键发送') && !body.includes('群发'), '执行人区块不应出现批量/全部/一键/群发这类群发按钮文案');
});
check('行级发通知/查已读均走行级端点（/executors/:userId/notify、/executors/:userId/read-status），不再有批次级 notify-executor 残留', () => {
    const notifyBody = extractFunctionBody(src, 'siExecutorRowNotify');
    const readBody = extractFunctionBody(src, 'siExecutorRowReadStatus');
    assert.ok(notifyBody && /\/executors\/['"]\s*\+\s*userId\s*\+\s*['"]\/notify/.test(notifyBody.replace(/\s+/g, ' ')), 'siExecutorRowNotify 未走行级 .../executors/:userId/notify 端点');
    assert.ok(readBody && /\/executors\/['"]\s*\+\s*userId\s*\+\s*['"]\/read-status/.test(readBody.replace(/\s+/g, ' ')), 'siExecutorRowReadStatus 未走行级 .../executors/:userId/read-status 端点');
});
check('执行人聚合徽标改读 executor_notify_summary（六态·方案 §4.3），批次面板三函数（不含 siOpenReleaseLog）内旧批次级单列 release_assignee_* 零残留', () => {
    // ⚠️ 全文盲扫 release_assignee_ 会误伤——sys_issues 8 列镜像（旧"上线编排"bug 单机制，2026-07-30 已
    // 单独退场，前端仍在 bug 单详情/gate 提示里合法引用其历史留痕，见 :1720/:1824-1858/:2583-2587 一带，
    // 与本批「上线单执行人多选」的批次级 sys_releases.release_assignee_* 是两套完全不同的列/机制，
    // out of C5 scope）。改为只在批次面板函数体内扫，精确对齐本批实际改动范围。
    for (const fn of ['siOpenBatchDetail', 'siRenderBatchList', 'siProbeMyReleasesEntry']) {
        const body = extractFunctionBody(src, fn);
        assert.ok(body, `未提取到 ${fn} 函数体`);
        const code = stripComments(body);
        assert.ok(!code.includes('release_assignee_'), `${fn} 函数体（代码，非注释）仍有 release_assignee_ 前缀字段引用——旧批次级单列已随 C4b H1 退场冻结，C5 应已改读子表/聚合字段`);
    }
    assert.ok(src.includes('executor_notify_summary'), '未见 executor_notify_summary 聚合字段消费');
});
check('siOpenReleaseLog 例外：release_assignee_name 允许作"历史记录"只读展示（预筛 L1 采纳）——非空显示姓名+「（历史记录）」标注，不当作实时权威态使用', () => {
    const body = extractFunctionBody(src, 'siOpenReleaseLog');
    assert.ok(body, '未提取到 siOpenReleaseLog 函数体');
    const code = stripComments(body);
    assert.ok(code.includes('b.release_assignee_name'), 'siOpenReleaseLog 应读取 b.release_assignee_name（L1：非空时按历史记录展示，而非一律隐藏）');
    assert.ok(code.includes('（历史记录）'), '未见「（历史记录）」标注文案——必须明确标注这是历史留痕而非当前权威通知态，防被误读成实时状态');
    // 反向锚点：仍不得出现"待执行"这类实时状态判定使用该字段（那类判定必须走 executor_notify_summary）。
    assert.ok(!/awaitingExec.*release_assignee/.test(code) && !/release_assignee.*awaitingExec/.test(code), 'release_assignee_name 不应被用来判定"待执行"这类实时状态（那属于 executor_notify_summary 的职责）');
});

console.log('— §⑧（C5·方案 §4.5）确认上线弹窗关键渲染条件（最后一人 + 行 id + 并发补救）—');
check('siReleaseExecuteModal 按 pending_count===1 分支最后一人文案与上线说明必填框', () => {
    const body = extractFunctionBody(src, 'siReleaseExecuteModal');
    assert.ok(body, '未提取到 siReleaseExecuteModal 函数体');
    assert.ok(body.includes('isLast'), '未见最后一人判据变量');
    assert.ok(body.includes('pendingCount === 1') || body.includes('pendingCount===1'), '未见 pending_count===1 判据');
    assert.ok(body.includes('你是最后一个确认人'), '未见最后一人二次确认文案');
});
check('execute 请求体带 executor_row_id（取自本人在册行 id，§4.1a 代次语义——不许服务端自己猜一行）', () => {
    const body = extractFunctionBody(src, 'siReleaseExecuteModal');
    const code = stripComments(body);
    assert.ok(/executor_row_id:\s*myRow\.id/.test(code), '未见 executor_row_id: myRow.id——必须显式传本人那一行的行 id，不能让服务端自己查一行（会丢代次保证）');
});
check('[C3·H2 统一重试上下文改造] 收到 RELEASE_NOTE_REQUIRED / overdue_reason_required 均经 siReleaseExecuteSubmit 统一出口转入 siReleaseExecuteRetryModal 重试，不报死错（原 siReleaseExecuteRetryNoteModal 已被统一重试弹层取代，方案 §5.1.4）', () => {
    const submitBody = extractFunctionBody(src, 'siReleaseExecuteSubmit');
    assert.ok(submitBody, '未提取到 siReleaseExecuteSubmit 函数体（统一提交出口）');
    const code = stripComments(submitBody);
    assert.ok(code.includes("RELEASE_NOTE_REQUIRED"), '未见 RELEASE_NOTE_REQUIRED 分支');
    assert.ok(code.includes('overdue_reason_required'), '未见 overdue_reason_required 分支（四个 RELEASE_OVERDUE_REASON_* 响应体统一携带该字段，方案 §5.1.3a）');
    assert.ok(code.includes('siReleaseExecuteRetryModal'), '未见统一重试弹窗调用');
    const retryBody = extractFunctionBody(src, 'siReleaseExecuteRetryModal');
    assert.ok(retryBody, '未提取到 siReleaseExecuteRetryModal 函数体');
});
check('[C3] siReleaseExecuteModal 与 siReleaseExecuteRetryModal 均通过 siReleaseExecuteSubmit 提交，请求体必含 executor_row_id（§4.1a 代次语义——首次/补弹两条链路同样不能漏传行 id）', () => {
    const submitBody = stripComments(extractFunctionBody(src, 'siReleaseExecuteSubmit') || '');
    assert.ok(submitBody, '未提取到 siReleaseExecuteSubmit 函数体');
    assert.ok(/executor_row_id:\s*ctx\.executor_row_id/.test(submitBody), '未见 executor_row_id: ctx.executor_row_id——统一提交出口必须显式带上 ctx 里的行 id');
    const initBody = stripComments(extractFunctionBody(src, 'siReleaseExecuteModal') || '');
    assert.ok(/executor_row_id:\s*myRow\.id/.test(initBody), '首次提交的 ctx 构造未见 executor_row_id: myRow.id');
    const retryBody = stripComments(extractFunctionBody(src, 'siReleaseExecuteRetryModal') || '');
    assert.ok(/Object\.assign\(\{\},\s*ctx\)/.test(retryBody), '重试弹层未见基于既有 ctx 累计构造 newCtx（Object.assign({}, ctx)）——统一重试上下文要求补弹只补当次缺的字段，不能整体重建');
});
check('[C3] siReleaseExecuteRetryModal 对四个 RELEASE_OVERDUE_REASON_* 一律展开理由块（按 overdue_reason_required===true 判定，不逐一分辨具体 code）且回填 ctx 已填理由（不静默丢弃）', () => {
    const retryBody = stripComments(extractFunctionBody(src, 'siReleaseExecuteRetryModal') || '');
    assert.ok(retryBody, '未提取到 siReleaseExecuteRetryModal 函数体');
    assert.ok(/d\.overdue_reason_required === true/.test(retryBody), '未见 overdue_reason_required === true 判据');
    assert.ok(/fReleaseOverdueReasonBlock\('siRetryOverdueBlock',\s*true,\s*ctx\.overdue_reason_code \|\| ''/.test(retryBody), '理由块未见回填 ctx.overdue_reason_code（补弹时清空已填理由=方案 §7.3 变异 V5 场景，须判红）');
});
// [C4e·codex 560 M3 收口] 「双链均通过统一出口」原断言只查了两处字面量模式（executor_row_id 赋值/
//   Object.assign 存在），没查两个弹层函数体内真的**调用**了 siReleaseExecuteSubmit(——"存在克隆语句"
//   不等于"克隆结果真被提交"；且回填断言只覆盖了 overdue_reason_code 一个字段，测不出"先补说明再补
//   理由/先补理由再补说明"两种顺序下，另一次已补齐的字段会不会在下一轮 Object.assign 之外被漏落。
check('[C4e·M3-①] siReleaseExecuteModal 与 siReleaseExecuteRetryModal 函数体内均含 siReleaseExecuteSubmit( 调用（不是只声明了克隆语句，克隆/构造结果真的被送进统一出口）', () => {
    const initBody = stripComments(extractFunctionBody(src, 'siReleaseExecuteModal') || '');
    const retryBody = stripComments(extractFunctionBody(src, 'siReleaseExecuteRetryModal') || '');
    assert.ok(initBody && /siReleaseExecuteSubmit\(/.test(initBody), 'siReleaseExecuteModal 函数体未见 siReleaseExecuteSubmit( 调用');
    assert.ok(retryBody && /siReleaseExecuteSubmit\(/.test(retryBody), 'siReleaseExecuteRetryModal 函数体未见 siReleaseExecuteSubmit( 调用');
});
console.log('— §M3-② siReleaseExecuteRetryModal 真实执行：两种补齐顺序下字段不丢失 —');
// 沙箱真执行 siReleaseExecuteRetryModal——只 stub 掉两个"会摸真实 DOM/网络"的依赖（siModal 改成同步
//   捕获 onConfirm 供测试直接调用、siReleaseExecuteSubmit 改成记录收到的 ctx），其余全是真实源码
//   （note/fText/fTextarea/esc/fReleaseOverdueReasonBlock/siCollectReleaseOverdueReasonRequired/
//   SI_RELEASE_OVERDUE_REASON_CODES/_NOTE_MAX 与 siReleaseExecuteRetryModal 本体），不手抄第二份判据。
(function assertRetryModalFieldPreservation() {
    // [C4f·562-R M2 收口·grabFn 自身踩坑] `src.indexOf('function ' + name + '(')` 对 `async function
    // siReleaseExecuteSubmit(` 这类声明会命中"function"关键字本身的位置（作为"async "之后的子串），
    // 把 "async " 前缀漏在截取范围之外——取出来的文本变成一个内部含 `await` 却没有 async 修饰的裸
    // function 声明，`new Function(...)` 编译时报"await is only valid in async functions"。改法：
    // 先探测紧邻的 `async function <name>(` 整段是否存在，命中则从"async"起截取，未命中再退回普通
    // `function <name>(`——两种声明形态都要支持，不能只顾其中一种。
    function grabFn(name) {
        const asyncPrefix = 'async function ' + name + '(';
        const plainPrefix = 'function ' + name + '(';
        let i = src.indexOf(asyncPrefix);
        if (i < 0) i = src.indexOf(plainPrefix);
        if (i < 0) return null;
        let d = 0, j = src.indexOf('{', i);
        const s = i;   // 从声明起始（含 async 前缀，若有）截取，不是只从花括号开始
        for (; j < src.length; j++) {
            if (src[j] === '{') d++;
            else if (src[j] === '}') { d--; if (d === 0) return src.slice(s, j + 1); }
        }
        return null;
    }
    const fnRetry = grabFn('siReleaseExecuteRetryModal');
    const fnSubmit = grabFn('siReleaseExecuteSubmit');
    const fnNote = grabFn('note');
    const fnFText = grabFn('fText');
    const fnFTextarea = grabFn('fTextarea');
    const fnEsc = grabFn('esc');
    const fnBlock = grabFn('fReleaseOverdueReasonBlock');
    const fnCollect = grabFn('siCollectReleaseOverdueReasonRequired');
    const codesLit = (src.match(/const SI_RELEASE_OVERDUE_REASON_CODES = \[[^\]]*\];/) || [''])[0];
    const noteMaxLit = (src.match(/const SI_RELEASE_OVERDUE_REASON_NOTE_MAX = \d+;/) || [''])[0];
    check('[M3-②前置] 依赖函数均提取成功（提不到=本组空转，不静默跳过）', () => {
        assert.ok(fnRetry, '未提取到 siReleaseExecuteRetryModal');
        assert.ok(fnSubmit, '未提取到 siReleaseExecuteSubmit（C4f·562-R M2：本组须纳入真实提交函数，不能只 stub 它）');
        assert.ok(fnNote && fnFText && fnFTextarea && fnEsc && fnBlock && fnCollect, '未提取到 note/fText/fTextarea/esc/fReleaseOverdueReasonBlock/siCollectReleaseOverdueReasonRequired 之一');
        assert.ok(codesLit && noteMaxLit, '未提取到 SI_RELEASE_OVERDUE_REASON_CODES / SI_RELEASE_OVERDUE_REASON_NOTE_MAX');
    });
    if (!fnRetry || !fnSubmit || !fnNote || !fnFText || !fnFTextarea || !fnEsc || !fnBlock || !fnCollect || !codesLit || !noteMaxLit) return;

    // [C4f·codex 562-R M2 收口] 原写法把 siReleaseExecuteSubmit 整个 stub 成"记录收到的 ctx"——这只证明
    //   了 siReleaseExecuteRetryModal 把 newCtx 传给了 siReleaseExecuteSubmit，不证明**真实**
    //   siReleaseExecuteSubmit 构造请求体时有没有漏传某个字段（它自己删掉某行 `if (ctx.xxx) body.xxx=...`
    //   这类回归，旧写法测不出，因为它压根没跑真实函数体）。改法：把真实 siReleaseExecuteSubmit 一并编译
    //   进沙箱，只在**它自己发请求**这一个边界（siApi）stub——捕获真实构造出的请求体，返回成功响应让
    //   它自然走完成功分支（siExecuteApplyResult/siCloseModal/siLoadList/siOpenBatchDetail 均 stub 为
    //   无副作用空函数，只是让真实控制流跑得完，不代表它们本身被测）。siModalInstanceSeq/siAuditGen 是
    //   siReleaseExecuteSubmit 内部读取比对的全局态，沙箱里声明为恒定值（stub 侧从不递增，天然通过
    //   "未过期"分支，不影响我们关心的字段保留断言）。
    function makeHarness() {
        let capturedOnConfirm = null;
        let submittedBody = null;
        // eslint-disable-next-line no-new-func
        const runRetry = new Function(
            'showToast', 'siModal', 'siApi', 'siExecuteApplyResult', 'siCloseModal', 'siLoadList', 'siOpenBatchDetail', 'siApiErr',
            `let siModalInstanceSeq = 0;\nlet siAuditGen = 0;\n${codesLit}\n${noteMaxLit}\n${fnEsc}\n${fnNote}\n${fnFText}\n${fnFTextarea}\n${fnBlock}\n${fnCollect}\n${fnSubmit}\n${fnRetry}\nreturn siReleaseExecuteRetryModal;`
        )(
            () => {},
            (title, fields, onConfirm) => { capturedOnConfirm = onConfirm; },
            async (url, opts) => { submittedBody = (opts && opts.body) || null; return { ok: true, data: {} }; },
            () => {}, () => {}, async () => {}, async () => {}, () => {}
        );
        return {
            invoke: async (releaseId, ctx, errData, v) => {
                capturedOnConfirm = null; submittedBody = null;
                runRetry(releaseId, ctx, errData);
                assert.ok(capturedOnConfirm, 'siModal stub 未捕获到 onConfirm——siReleaseExecuteRetryModal 实现可能已改用别的调用形态');
                await capturedOnConfirm(v);
                assert.ok(submittedBody, 'siApi 边界未捕获到请求体——真实 siReleaseExecuteSubmit 可能未被调用到，或未走到发请求这一步');
                return submittedBody;
            },
        };
    }

    check('[M3-②a] 先补说明（RELEASE_NOTE_REQUIRED）再补理由（overdue_reason_required）：真实 siReleaseExecuteSubmit 两轮构造的请求体均保留已补字段，四字段齐全', async () => {
        const h = makeHarness();
        const baseCtx = { executor_row_id: 42 };
        const body1 = await h.invoke('r1', baseCtx, { code: 'RELEASE_NOTE_REQUIRED' }, { release_note: 'M3 夹具·首轮上线说明', version_tag: '' });
        assert.strictEqual(body1.executor_row_id, 42, '第一轮请求体 executor_row_id 应为 42');
        assert.strictEqual(body1.release_note, 'M3 夹具·首轮上线说明', '第一轮请求体应含 release_note');
        // body1 的字段形状与内部 newCtx 一致（真实 siReleaseExecuteSubmit 逐字段 `if (ctx.xxx) body.xxx=ctx.xxx`
        // 透传，未做额外改名/转换），拿它作第二轮的 ctx 输入等价于拿到了第一轮内部真正累积出的 newCtx。
        const body2 = await h.invoke('r1', body1, { overdue_reason_required: true, planned_date: '2026-01-01', released_date: '2026-01-05', overdue_days: 4 },
            { siRetryOverdueBlock_code: '业务方要求延后', siRetryOverdueBlock_note: 'M3 夹具·第二轮理由说明' });
        assert.strictEqual(body2.executor_row_id, 42, '第二轮请求体应仍带着最初的 executor_row_id（未曾被任何一轮覆盖）');
        assert.strictEqual(body2.release_note, 'M3 夹具·首轮上线说明', '第二轮（本轮只补理由）请求体不应丢掉第一轮已补的 release_note');
        assert.strictEqual(body2.overdue_reason_code, '业务方要求延后', '第二轮请求体应含 overdue_reason_code');
        assert.strictEqual(body2.overdue_reason_note, 'M3 夹具·第二轮理由说明', '第二轮请求体应含 overdue_reason_note');
    });

    check('[M3-②b] 先补理由（overdue_reason_required）再补说明（RELEASE_NOTE_REQUIRED）：真实 siReleaseExecuteSubmit 两轮构造的请求体均保留已补字段，四字段齐全（顺序颠倒同样不丢）', async () => {
        const h = makeHarness();
        const baseCtx = { executor_row_id: 99 };
        const body1 = await h.invoke('r2', baseCtx, { overdue_reason_required: true, planned_date: '2026-01-01', released_date: '2026-01-06', overdue_days: 5 },
            { siRetryOverdueBlock_code: '环境或依赖未就绪', siRetryOverdueBlock_note: 'M3 夹具·先补理由' });
        assert.strictEqual(body1.overdue_reason_code, '环境或依赖未就绪', '第一轮请求体应含 overdue_reason_code');
        assert.strictEqual(body1.overdue_reason_note, 'M3 夹具·先补理由', '第一轮请求体应含 overdue_reason_note');
        const body2 = await h.invoke('r2', body1, { code: 'RELEASE_NOTE_REQUIRED' }, { release_note: 'M3 夹具·后补说明', version_tag: '' });
        assert.strictEqual(body2.executor_row_id, 99, '第二轮请求体应仍带着最初的 executor_row_id');
        assert.strictEqual(body2.release_note, 'M3 夹具·后补说明', '第二轮请求体应含 release_note');
        assert.strictEqual(body2.overdue_reason_code, '环境或依赖未就绪', '第二轮（本轮只补说明）请求体不应丢掉第一轮已补的 overdue_reason_code');
        assert.strictEqual(body2.overdue_reason_note, 'M3 夹具·先补理由', '第二轮请求体不应丢掉第一轮已补的 overdue_reason_note');
    });
})();
check('cancel-schedule 收到 CONFIRM_DISCARD_DONE_REQUIRED 时补弹 done_executor_names 二次确认框，带 confirm_discard_done:true 重试', () => {
    const body = extractFunctionBody(src, 'siReleaseCancelScheduleModal');
    assert.ok(body, '未提取到 siReleaseCancelScheduleModal 函数体');
    assert.ok(body.includes('CONFIRM_DISCARD_DONE_REQUIRED'), '未见 CONFIRM_DISCARD_DONE_REQUIRED 分支');
    assert.ok(body.includes('done_executor_names'), '未见 done_executor_names 消费');
    const discardBody = extractFunctionBody(src, 'siReleaseCancelScheduleDiscardModal');
    assert.ok(discardBody && discardBody.includes('confirm_discard_done: true'), '二次确认弹窗未带 confirm_discard_done:true 重试');
});
check('309-L2：「撤销上线安排」按钮的局部渲染条件自带 planning &&（自洽冗余——即便这段代码将来被挪出外层 if(planning){...} 包裹，也不会在已发布批次上误开这个按钮）', () => {
    const body = extractFunctionBody(src, 'siOpenBatchDetail');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    const cond = guardConditionBefore(body, 'onclick="siReleaseCancelScheduleModal(${id})"');
    assert.ok(/^\s*planning\s*&&/.test(cond), `「撤销上线安排」按钮局部条件应以 planning && 开头，实际条件：${cond}`);
});

console.log('— §⑨ `?release=` 深链兼容（钉钉通知点进来直达批次详情，方案 §4.5 第4条不变）—');
check('deepRelId 解析后仍调用 siGotoBatchDetail，siGotoBatchDetail 仍调用 siOpenBatchDetail（C5 只重写详情面板内部渲染，不动入口/路由）', () => {
    assert.ok(src.includes('deepRelId'), '未见 ?release= 深链解析变量');
    const gotoBody = extractFunctionBody(src, 'siGotoBatchDetail');
    assert.ok(gotoBody && gotoBody.includes('siOpenBatchDetail'), 'siGotoBatchDetail 未调用 siOpenBatchDetail');
});

console.log('— §⑩ C5 收口：[C5-TODO] 标记全清（僅剩一处历史提及，非真实待办）—');
check('全文（前端 Sys_Iteration.html + 后端 index.js）[C5-TODO] 真实标记数为 0（L12：措辞写实"全文"——原判据只扫了前端，后端也曾有过同款标记，须同扫）', () => {
    // 真实待办标记形如 `// [C5-TODO] ...`（无反引号包裹，位于注释起手处）；历史说明性提及会用反引号
    // 包裹整个词组（`` `[C5-TODO]` ``）以区别于活跃标记，本断言只拦前者。
    const liveTodoRe = /\/\/\s*\[C5-TODO\]/g;
    const indexJsPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const indexJsSrc = fs.readFileSync(indexJsPath, 'utf8');
    const feMatches = [...src.matchAll(liveTodoRe)];
    const beMatches = [...indexJsSrc.matchAll(liveTodoRe)];
    assert.strictEqual(feMatches.length, 0, `Sys_Iteration.html 仍有 ${feMatches.length} 处未清理的活跃 [C5-TODO] 标记`);
    assert.strictEqual(beMatches.length, 0, `routes/sys-iteration/index.js 仍有 ${beMatches.length} 处未清理的活跃 [C5-TODO] 标记`);
});
check('旧死函数/变量（siReleaseNotifyExecutor/siReleaseResendExecutor/siReleaseQueryExecutorRead/siDutyPreviewHtml/siBatchDutyPreview）已整体删除', () => {
    for (const name of ['siReleaseNotifyExecutor', 'siReleaseResendExecutor', 'siReleaseQueryExecutorRead', 'siDutyPreviewHtml']) {
        assert.ok(!src.includes(`function ${name}(`), `期望 ${name} 函数定义已删除（C5 重写），实际仍在`);
    }
    assert.ok(!src.includes('siBatchDutyPreview'), '期望 siBatchDutyPreview 变量/引用已删除（C5：选人已前移到弹窗环节，值班预览机制随之退场）');
});

console.log('— §⑥ C8 风险/优先级双显（方案 v1.7 §9.2 + 2026-08-07 启动门增补）—');
check('列表列头改「优先级/风险」且排序仍绑 priority（下行不参与排序）', () => {
    assert.ok(/data-sort-by="priority">优先级\/风险</.test(src),
        '期望列头文本为「优先级/风险」且 data-sort-by 仍是 priority（双行复用同一列，排序口径不变）');
    assert.ok(!/data-sort-by="risk_level"/.test(src),
        '风险等级不应成为独立可排序列——C8 明确"不加列"（列表已 20+ 列，加列必触发横滚）');
});
check('列表单元格走 siPriRiskCellHtml 同格结构（徽章+"/"+风险文本·2026-08-10 二拍「P2/三级」斜杠合并形态）', () => {
    assert.ok(/<td>\$\{siPriRiskCellHtml\(i\)\}<\/td>/.test(src), '列表行的优先级单元格应改调 siPriRiskCellHtml(i)');
    const fn = extractFunctionBody(src, 'siPriRiskCellHtml');
    assert.ok(fn, 'siPriRiskCellHtml 函数体应能被提取（防改名后本组静默失效）');
    // 〔断言同步·2026-08-09〕原断言写死 `class="u-pri ${esc(i.priority)}"`，被**状态徽章统一 v1.142.0**
    //   打红：那一批把三处输出点的 class 片段从 `esc(原值)` 改成白名单 map `siPriClass()`
    //   （Sys_Iteration.html:770-780 有成文理由：esc 防注入，但"产不出规则的 class"它管不着）。
    //   ⇒ 属**断言该改**不是实现错——本断言的原意「复用共享层 .u-pri，不自造样式」现在依然成立，
    //   变的只是 class 片段的来源。顺手把断言**加强**成徽章批的真实不变量：class 片段必须来自
    //   受控 map，可见文本仍是 esc(原值)（该页刻意保留显示原值，见 :772-774 的取舍说明）。
    assert.ok(/class="u-pri \$\{siPriClass\(i\.priority\)\}"/.test(fn), '上行仍是既有 .u-pri 徽章，且 class 片段走 siPriClass 白名单（不再 raw 拼 esc(原值)）');
    assert.ok(/>\$\{esc\(i\.priority\)\}</.test(fn), '可见文本仍用 esc(原值)（脏数据要能被人看见，与 class 规范化是两回事）');
    assert.ok(/si-pri-risk/.test(fn) && /si-risk-line/.test(fn), '应输出 si-pri-risk 容器 + si-risk-line 风险包裹（类名结构钩子保留不动）');
    assert.ok(/\.si-pri-risk\s*\{/.test(src) && /\.si-risk-sub\s*\{/.test(src), 'si-pri-risk / si-risk-sub 样式应已定义（否则并排排布失效、风险小字失去从属视觉）');
    // 〔2026-08-10 二拍「P2/三级」〕徽章与风险文本之间恒有半角 "/" 分隔符——镜像列头「优先级/风险」。
    //   codex M2（本轮采纳）：断言最终模板的**顺序与嵌套**，不只查"分隔符存在"——否则 sep 挪到
    //   riskText 之后（读成「P2三级/」）字符串断言仍全绿。
    assert.ok(/return `<div class="si-pri-risk">\$\{pri\}<div class="si-risk-line"><span class="si-risk-sep">\/<\/span>\$\{riskText\}<\/div><\/div>`/.test(fn),
        '最终模板必须是 徽章→si-risk-line(sep→风险文本) 的顺序与嵌套（防分隔符挪位/结构重排假绿）');
    // codex L1（本轮采纳）：断言文案声称"裸奔继承 13px"，就必须真查字号——只查选择器存在=声称超检查面
    assert.ok(/\.si-risk-sep\s*\{[^}]*font-size:\s*11px/.test(src), '.si-risk-sep 应定义 11px 字号（分隔符裸奔会继承单元格 13px，与 11px 风险小字失配）');
    // codex M1（本轮采纳）：脏长值防线——flex-wrap 只管子项间换行，管不住单项内连续长串撑大 min-content
    assert.ok(/\.si-risk-line\s*\{[^}]*min-width:\s*0/.test(src) && /\.si-risk-sub\s*\{[^}]*overflow-wrap:\s*anywhere/.test(src),
        '脏长值防线应齐两件：.si-risk-line min-width:0 + .si-risk-sub overflow-wrap:anywhere（否则注释声称的"折行不撑宽列"不成立，防横滚是 C8 硬约束）');
});
check('bug/config 行风险段显示 "-" 占位（不适用≠未定级）；feature/improvement 未定级显示灰字「未定级」', () => {
    const fn = extractFunctionBody(src, 'siPriRiskCellHtml');
    assert.ok(/i\.type === 'feature' \|\| i\.type === 'improvement'/.test(fn),
        '应按 type 门控风险文本（与详情页 risk_level kv 的既有 type 判据同口径）');
    // 〔断言同步·2026-08-10〕原断言写死"不适用分支提前 return 孤徽章"（留空口径）——同日用户二拍升级为
    //   「P2/-」占位形态：三值三形态（"-"=不适用／「未定级」=该定没定／空白=歧义），属**断言该改**不是
    //   实现错（feedback_test_assertion_self_error 口径）。"不适用禁用『未定级』文本"这条原不变量不变，
    //   只是"不适用"的表达从空白升级为 "-"。
    assert.ok(!/if \(!riskApplicable\) return/.test(fn),
        '不适用分支不应再提前 return 孤徽章（三形态统一渲染"徽章+/+风险文本"两段结构）');
    // codex M2（本轮采纳）：绑定**分支归属**——"-" 占位必须挂在 !riskApplicable 的真分支上。
    //   只查"na span 存在于函数体"时，三元两分支互换（bug 行显风险/feature 行显 "-"）仍全绿。
    assert.ok(/const riskText = !riskApplicable\s*\?\s*`<span class="si-risk-sub si-muted si-risk-na" title="\$\{SI_RISK_NA_TITLE\}">-<\/span>`/.test(fn),
        '"-" 占位必须绑在 !riskApplicable 真分支（防三元分支互换后字符串存在性断言仍假绿）');
    assert.ok(/const SI_RISK_NA_TITLE = /.test(src), '应定义 SI_RISK_NA_TITLE 单一事实源常量（"-" 的悬浮说明文案）');
    assert.ok(/\.si-risk-sub\.si-muted\.si-risk-na\s*\{[^}]*cursor:\s*help/.test(src),
        '.si-risk-na 应以三类叠加选择器把 cursor 翻回 help（"-" 挂了 title；不靠同特异性源序压 si-muted 的 default）');
    assert.ok(/si-risk-sub si-muted">未定级</.test(fn), 'feature/improvement 未定级应显示灰字「未定级」（与详情页 kv 逐字同口径）');
});
check('风险等级三级口径常量存在且文案逐字对齐方案 §9.2 末条', () => {
    assert.ok(/const SI_RISK_LEVEL_HELP_TEXT = /.test(src), '应定义 SI_RISK_LEVEL_HELP_TEXT 单一事实源常量');
    // 三级定义逐字断言——这段是业务判定依据，任何"顺手润色"都会让它与方案原文分岔
    const L1 = '一级＝出款相关需求、优化，或实际代码改动涉及出款部分的需求、优化。';
    const L2 = '二级＝影响关键业务流程（立项、开票、结算、领款）无法正常进行的需求。';
    const L3 = '三级＝页面显示优化调整、报表、查询等不影响主要业务流程的需求。';
    for (const [n, txt] of [['一级', L1], ['二级', L2], ['三级', L3]]) {
        assert.ok(src.includes(txt), `SI_RISK_LEVEL_HELP_TEXT 应**逐字**包含${n}定义（方案 v1.7 §9.2 末条原文）：${txt}`);
    }
});
check('问号徽章挂在唯一渲染风险等级选择的表单上（受理弹窗），范式同 SI_PRIORITY_LABEL', () => {
    assert.ok(/const SI_RISK_LEVEL_LABEL = `风险等级 <span class="si-help"[^`]*title="\$\{SI_RISK_LEVEL_HELP_TEXT\}"/.test(src),
        'SI_RISK_LEVEL_LABEL 应照搬 SI_PRIORITY_LABEL 的 si-help + title 范式');
    assert.ok(/aria-label="\$\{SI_RISK_LEVEL_HELP_TEXT\}"/.test(src), '应同时给 aria-label（屏幕阅读器/键盘，同 codex60 L-2 先例）');
    assert.ok(/<label>\$\{SI_RISK_LEVEL_LABEL\}/.test(src), '受理弹窗的风险等级 label 应改用 SI_RISK_LEVEL_LABEL');
    // 全站渲染"风险等级选择"的表单只此一处——若未来新增第二处，本断言会提醒同步挂徽章
    const selectCount = (src.match(/id="f_risk_level"/g) || []).length;
    assert.strictEqual(selectCount, 1, `全站风险等级 select 应恰 1 处（新增第 2 处时须同步挂 SI_RISK_LEVEL_LABEL 徽章），实际 ${selectCount} 处`);
});
check('列表端点 DTO 已含 risk_level 只读字段（前端双行下行的数据源）', () => {
    const indexJsPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const indexJsSrc = fs.readFileSync(indexJsPath, 'utf8');
    assert.ok(/SELECT id, type, status, priority, risk_level, title/.test(indexJsSrc),
        'GET /sys-issues 的列表 SELECT 应含 risk_level——前端 siPriRiskCellHtml 的下行全靠它，字段被摘掉时列表会静默显示成"全部未定级"（不报错、不红，正是最难发现的一类回归）');
    // 只读扩字段：不得因此新增筛选/排序（C8 硬约束）
    assert.ok(!/addEq\('risk_level'/.test(indexJsSrc), 'C8 是纯展示扩字段，不应新增 risk_level 筛选');
});
check('详情页基本信息块补优先级 kv（与风险等级 kv 并排）', () => {
    // 〔断言同步·2026-08-09〕同上：class 片段随状态徽章统一 v1.142.0 改走 siPriClass 白名单。
    assert.ok(/<label>优先级<\/label><div class="v"><span class="u-pri \$\{siPriClass\(iss\.priority\)\}" title="\$\{SI_PRIORITY_HELP_TEXT\}"/.test(src),
        '基本信息 kv 应含优先级项，徽章复用 .u-pri（class 走 siPriClass 白名单）且 title 复用既有 SI_PRIORITY_HELP_TEXT（不新增文案副本）');
});
check('MED-4：详情页工期 kv 移出 needs_feasibility 条件，改按 type 适用面', () => {
    assert.ok(/const effortApplicableType = \(iss\.type === 'feature' \|\| iss\.type === 'improvement'\)/.test(src),
        '工期 kv 应先按 type 适用面门控（nf 两值都可能有工期：nf=1 走评估弹窗、nf=0 走估时弹窗）');
    assert.ok(/\$\{effortKv\}/.test(src), 'effortKv 应被基本信息块消费');
    // 评估块内不得再残留一份工期 kv（否则 nf=1 单会显示两遍）
    // [C8-fix K4] 切片两端 end-marker 补前提断言（照 [T1b] 范式）：`indexOf` 找不到锚点返回 -1，
    //   `slice(start, -1)` 会静默切出"到倒数第二个字符"的巨大片段——本组随之从"评估块内无残留"退化成
    //   对全文的检查（恒红），或起点也失效时切出空串（恒绿）。两种退化都让断言失去判定力，锚点必须先钉。
    const idxFeasStart = src.indexOf('let feas = \'\';');
    const idxFeasEnd = src.indexOf('// ④a §7 关联修正单号软展示');
    assert.ok(idxFeasStart > 0, 'K4 前置：评估块起点锚点「let feas = \'\';」应能定位（锚点漂移时先红，不静默切错片段）');
    assert.ok(idxFeasEnd > 0, 'K4 前置：评估块终点锚点「// ④a §7 关联修正单号软展示」应能定位（indexOf 返回 -1 会让 slice 静默切出错误片段）');
    assert.ok(idxFeasEnd > idxFeasStart, 'K4 前置：终点锚点应在起点之后（顺序颠倒会切出空串 → 断言恒真假绿）');
    const feasBlock = src.slice(idxFeasStart, idxFeasEnd);
    assert.ok(!/工期（人日）/.test(feasBlock), '评估块内不应再残留工期 kv（移动而非复制，否则 nf=1 单会重复显示两行）');
});
check('K3：详情工期 kv 三态门控（值非空→显示值 / 值空∧开发中→灰字未填 / 其余状态整行不渲染）', () => {
    const idxStart = src.indexOf('const effortApplicableType =');
    const idxEnd = src.indexOf('let feas = \'\';');
    assert.ok(idxStart > 0, 'K3 前置：effortKv 计算块起点应能定位');
    assert.ok(idxEnd > idxStart, 'K3 前置：终点应在起点之后（否则切片为空 → 下方断言恒真假绿）');
    const blk = src.slice(idxStart, idxEnd);
    // ⭐ [C8-fix2 L1'] 判据已从 `effortKvValue != null` 收紧为「非 null ∧ trim 后非空」——空白串按缺失走
    //   三态门控（与后端 normalizeSysEffortDays 的 `raw.trim()===''→value:null` 同口径），不再渲染空白格。
    assert.ok(/const effortKvHasValue = effortKvValue != null && String\(effortKvValue\)\.trim\(\) !== ''/.test(blk),
        "K3/L1'：有值判据须写成 `effortKvValue != null && String(effortKvValue).trim() !== ''`（空白串按缺失处理，与后端 normalizeSysEffortDays 同口径）");
    assert.ok(/if \(effortKvHasValue\)/.test(blk), 'K3：值非空分支应直接显示值（走 effortKvHasValue 判据）');
    // 反向：不得再把裸 `!= null` 直接当渲染门（那会让空白串渲染出一格没内容的工期）
    assert.ok(!/if \(effortKvValue != null\)/.test(blk),
        "L1'：不得回退到裸 `if (effortKvValue != null)` 作为渲染门——空白串会被判成「有值」，渲染出一个有标签无内容的空格子");
    assert.ok(/else if \(iss\.status === '开发中'\)/.test(blk),
        'K3：值为空时只有「开发中」态才渲染灰字「未填」——工期写入口（estimate/feasibility）的 W06 白名单只开这一态，其余状态用户根本没地方填');
    assert.ok(/si-muted">未填</.test(blk), 'K3：开发中态的空值应是灰字「未填」');
    // 不得存在"其余状态也显示未填"的兜底分支。
    // ⭐ [C8-fix 回卷 M3] 反向断言从"文本级 `!/\belse\s*\{/`（挖掉 if 段后不应再有 else）"**改为结构计数**：
    //   原写法有两个已被变异实证的漏洞——① `} else if (true) {` 这种"形式上是 else-if、实际是兜底"的形态
    //   带 `if` 不带裸 `{`，正则一个字都拦不住；② 它依赖一个 `.replace(/…\n {12}\}/, '')` 的挖洞步骤，
    //   缩进硬编码 12 空格，任何重排/换缩进都会让 replace 静默失配（挖不掉 → 残留 if 段里的 else-if 反而
    //   可能误红，或改成别的形状后误绿）。挖洞步骤随本次一并删除（[C8-fix 回卷 L2]：它不是"保险"，是噪音）。
    // 新判据（selectCount===1 范式，同上方风险等级 select 唯一性断言）：本块内对 status 的比较**恰 1 处**，
    //   且右值**恰为 '开发中'**。任何兜底分支想生效，都必须要么再加一个 status 比较（计数 →2，红），要么把
    //   唯一那处比较改成别的常量/恒真式（右值断言红）。这是对"三态门控"这件事本身的结构约束，不是对某种
    //   写法的文本匹配。
    const statusCmps = blk.match(/iss\.status\s*===\s*'[^']*'/g) || [];
    assert.strictEqual(statusCmps.length, 1,
        `K3：effortKv 计算块内对 iss.status 的比较应恰 1 处（多出第 2 处 = 引入了新的状态分支，须重新裁定三态门控口径），实际 ${statusCmps.length} 处：${JSON.stringify(statusCmps)}`);
    assert.strictEqual(statusCmps[0], "iss.status === '开发中'",
        `K3：唯一那处 status 比较的右值必须恰是 '开发中'（"还轮不到填"不能说成"未填"——与列表页 bug 行「留空≠未定级」是同一条判断标准），实际 ${statusCmps[0]}`);
    // 且整块只有 2 条赋值出口（值非空 / 开发中空值），不存在第 3 条 —— 兜底分支即使不比较 status（如裸 else）
    //   也必然要多一条 `effortKv = ` 赋值才能产出内容，此断言把那条路也堵死。
    const assigns = blk.match(/effortKv\s*=\s*`/g) || [];
    assert.strictEqual(assigns.length, 2,
        `K3：effortKv 的模板赋值出口应恰 2 条（值非空显示值 / 开发中空值显示未填），第 3 条即兜底渲染，实际 ${assigns.length} 条`);
    // ⭐⭐ [C8-fix2 M1'·补直接的裸 else 禁令] 上面两条结构计数各有盲区，**裸 else 能从缝里过去**：
    //   · statusCmps 只数 `iss.status === '…'`，裸 else 压根不比较 status ⇒ 计数仍是 1，过；
    //   · assigns 只数**模板字面量**赋值（`effortKv = \``），而 `} else { effortKv = SOME_CONST; }` 这种
    //     用变量/普通字符串赋值的兜底 ⇒ 计数仍是 2，也过。
    //   两条合起来仍拦不住"加一条不看状态、且不用模板串的兜底渲染"，而那恰恰会把 K3 三态门控退化成两态
    //   （"还轮不到填"被说成"未填"）。故直接对块内禁裸 else。
    //   ⚠️ 正则形态刻意用 `\}\s*else\s*\{` 而**不用** `else\s*(?!if\b)`：后者的 `\s*` 会回溯到"少吃几个空格"
    //     的位置让负向先行断言在空白处成立，是经典的假绿写法。`else` 与 `{` 之间夹着 `if (...)` 时本正则
    //     自然不匹配，无需先行断言，也就没有那个回溯陷阱。
    const bareElse = blk.match(/\}\s*else\s*\{/g) || [];
    assert.strictEqual(bareElse.length, 0,
        `K3：effortKv 计算块内**不得出现裸 else**（\`} else {\`）——那是绕过"三态门控"的兜底渲染入口，且能同时躲过 statusCmps 与 assigns 两条计数断言，实际 ${bareElse.length} 处：${JSON.stringify(bareElse)}`);
});

console.log('— §⑪ C9-fix（免上线直翻·前端消费面）—');
check('[H1] 验收弹窗直翻预告读 siDetail.dev_commits，**不是** iss.dev_commits（后者恒 undefined=死代码）', () => {
    const body = extractFunctionBody(src, 'siModalAccept');
    assert.ok(body, 'siModalAccept 函数体应能被提取（防改名后本组静默失效）');
    // ⚠️ 反向断言必须跑在 **stripComments 后的代码**上（同本文件 :145 「函数体（代码，非注释）」既有范式）：
    //   本函数的 H1 订正注释里正当地引用了 `iss.dev_commits` 这个错误写法来说明"为什么它是错的"，
    //   直接对原文匹配会把**解释性引用**误判成**实际用法**（首跑实测踩到，本组当场红）。
    const code = stripComments(body);
    // 正向：必须从 siDetail 取 dev_commits
    assert.ok(/Array\.isArray\(siDetail && siDetail\.dev_commits\)/.test(code),
        '预告判据应写成 Array.isArray(siDetail && siDetail.dev_commits)——详情响应体里 issue 与 dev_commits 是兄弟键，dev_commits 挂在 siDetail 上而不是 issue 上');
    assert.ok(/siDetail\.dev_commits\.length === 0/.test(code), '零 commit 判据同样应取自 siDetail.dev_commits');
    // ⭐ 反向（本组的核心）：代码里不得再出现 iss.dev_commits——那是恒 undefined 的死代码写法，
    //   Array.isArray(undefined) 恒 false 会让预告永不出现，且**不报任何错**（最难发现的一类回归）。
    assert.ok(!/\biss\.dev_commits\b/.test(code),
        '[H1] siModalAccept 代码（非注释）内不得出现 iss.dev_commits——issue 对象上没有这个键（恒 undefined ⇒ 预告分支永不进入，静默失效）；数据源在 siDetail.dev_commits');
    // release_id 则确实挂在 issue 上，仍应从 iss 取（防"一刀切全改 siDetail"改错方向）
    assert.ok(/!iss\.release_id/.test(code),
        '[H1] 未挂批次判据仍应读 iss.release_id（release_id 确实在 issue 对象上，与 dev_commits 不同——不要一刀切）');
});
check('[H1] 直翻结果以响应体 online_source 为准，不复用事前预告变量（真判定在服务端）', () => {
    const code = stripComments(extractFunctionBody(src, 'siModalAccept') || '');
    assert.ok(/d\.online_source === 'no_commit_acceptance'/.test(code),
        '成功回调应按响应体 online_source 判定实际结果——事前预告只是体验层提示，存在 stale 窗口（详情打开后他人补 commit）');
    // 结果分支不得复用 likelyDirect：那会把"我以为会直翻"当成"确实直翻了"
    // [2026-09-07 主会话裁定 L4] 锚点由 code.indexOf('siApi(') 改 code.indexOf('/accept')——S2b
    //   验收说明附件批给 siModalAccept 加了"先传附件"两步链，函数体内第一个 siApi( 调用现在是
    //   POST .../attachments（上传），不再是 POST .../accept；旧锚点会把切片起点提前到上传调用处，
    //   偏离本组"accept 调用之后的结果处理段"的真实检查意图。改锚定 '/accept' 字面量（该请求路径
    //   在函数体内唯一，精确定位到 accept 调用本身）。
    const cbIdx = code.indexOf('/accept');
    assert.ok(cbIdx > 0, '应能定位 /accept 调用（锚点漂移时先红，不静默切错片段）');
    assert.ok(!/likelyDirect/.test(code.slice(cbIdx)),
        '[H1] siApi 调用之后的结果处理段不得引用 likelyDirect——预告与结果必须各判各的，复用等于把客户端快照当成服务端裁决');
});
check('[C9-fix2 M3] 验收弹窗直翻预告改**条件式**文案（不再是"验收通过后将 X"的承诺句式）', () => {
    // codex 316 M3 实证：原文案「验收通过后将直接标记为「已上线」」是承诺句式，而同处注释却声称
    //   "措辞用『将』而非承诺"——声称与实现相反。真正的问题不在措辞强弱，而在**它会说错话**：
    //   详情打开后、点确认前若他人补了 commit/挂了批次，后端会落「待上线」，提示与结果对不上。
    //   修法=把前提与另一种结局都写进句子，使这句话在两个分支下都为真。
    const code = stripComments(extractFunctionBody(src, 'siModalAccept') || '');
    assert.ok(code, 'siModalAccept 函数体应能被提取（防改名后本组静默失效）');
    // ① 必须出现条件前提（"若…仍无…"）——这是条件式与承诺式的分水岭
    assert.ok(/若确认时该单仍无在案 commit/.test(code),
        '[M3] 预告文案须显式写出前提「若确认时该单仍无在案 commit 且未挂 active 上线批次」——没有前提的"验收通过后将直接上线"是承诺句式，stale 窗口里会说错话');
    // ② 必须写出另一种结局（否则用户只被告知一半）
    assert.ok(/否则/.test(code) && /待上线/.test(code),
        '[M3] 预告文案须同时写出另一种结局（否则照常进入「待上线」）——只说一个分支等于把可能性说成必然');
    // ③ 必须点明最终以服务端为准（真判定永远在服务端，297-M1）
    assert.ok(/最终以服务端判定为准/.test(code),
        '[M3] 预告文案须点明「最终以服务端判定为准」（前端判据只是快照，真判定在写事务内）');
    // ④ 反向（**顺序**约束，不是存在性约束）：承诺分句"验收通过后将…"必须出现在条件前提**之后**。
    //   ⚠️ 首版把这条写成"不得含承诺分句"——那是**断言写错**：条件式文案本身就包含那半句（"若…，验收通过后
    //     将…；否则…"），存在性检查必然误红。真正要防的回归是**前提被删掉、只剩承诺**，那等价于
    //     "条件出现的位置早于承诺"这条顺序关系被破坏（前提没了 ⇒ indexOf 返 -1 ⇒ 本条红）。
    const condIdx = code.indexOf('若确认时该单仍无在案 commit');
    const promiseIdx = code.indexOf('验收通过后将');
    assert.ok(promiseIdx >= 0, '[M3] 预告文案应仍含"验收通过后将…"这一结果分句（本条只约束它的位置，不是要删掉它）');
    assert.ok(condIdx >= 0 && condIdx < promiseIdx,
        `[M3] 承诺分句必须位于条件前提之后（前提被删只剩承诺=回退到原句式），前提位置=${condIdx} 承诺位置=${promiseIdx}`);
});
check('[M3] 详情页「上线方式」kv：四分支字典 + 仅已上线单渲染 + 前端不自行判定来源', () => {
    // ① 字典常量存在且四个 key/文案逐字对齐后端 deriveOnlineSourceKind 的四分支
    //   [SB2·2026-08-13] 3→4：组 B 直上新增 authorized_fastlane→「先行上线」（后端 ②b 分支与前端词条
    //   同 commit 落地，本守卫的"两边对账"职责由计数+逐 key 枚举共同承载——计数基线随分支演进更新）。
    assert.ok(/const SI_ONLINE_SOURCE_LABEL = \{/.test(src), '应定义 SI_ONLINE_SOURCE_LABEL 单一事实源字典');
    for (const [k, label] of [['release_publish', '批次发布'], ['no_commit_acceptance', '免上线直翻'], ['authorized_fastlane', '先行上线'], ['unknown_legacy', '历史存量']]) {
        assert.ok(new RegExp(`${k}:\\s*'${label}'`).test(src), `SI_ONLINE_SOURCE_LABEL 应含 ${k} → 「${label}」（key 与后端 deriveOnlineSourceKind 四分支逐字对齐）`);
    }
    const dictMatch = src.match(/const SI_ONLINE_SOURCE_LABEL = \{([^}]*)\}/);
    assert.ok(dictMatch, 'SI_ONLINE_SOURCE_LABEL 字典字面量应能被切出（锚点漂移时先红，不静默按 0 个分支判定）');
    const dictKeys = dictMatch[1].split(',').filter(s => s.trim()).length;
    assert.strictEqual(dictKeys, 4, `SI_ONLINE_SOURCE_LABEL 应恰 4 个分支（与后端四分支一一对应；多出第 5 个说明后端加了分支而两边未对账），实际 ${dictKeys}`);
    // ② kv 渲染：以 online_source_kind 非空为门（后端对非已上线单恒返 null ⇒ 等价于"仅已上线单渲染"）
    assert.ok(/\$\{iss\.online_source_kind \? `<div class="u-kv-item"><label>上线方式<\/label>/.test(src),
        '「上线方式」kv 应由 iss.online_source_kind 非空门控——不适用时整行不渲染（同工期 kv K3 三态门控 / 列表页 bug 行「留空≠未定级」同一判断标准）');
    assert.ok(/SI_ONLINE_SOURCE_LABEL\[iss\.online_source_kind\] \|\| iss\.online_source_kind/.test(src),
        '未知 kind 应兜底显示原始 key（宁可露出英文标识让人发现漏改，也不静默显示空白/错误分类）');
    // ③ ⭐ 前端**不得自行判定「上线方式」展示来源**：不得把原始 online_source 列**值比较到 kind 字面量**重算三/四分支
    //    （展示 kind 判定权威唯一在后端 deriveOnlineSourceKind，两份判据必然漂移——297-M6 已裁定）。
    //    [SB3·2026-08-13 精修] 守卫从"禁一切 iss.online_source 读取"收窄为"禁与 kind 字面量的**值比较**
    //    （=== / !== '字面量'）"——原 blanket 禁误伤组 B 授权按钮可见性的 `iss.online_source == null`
    //    **未上线门控**（与后端活跃授权谓词 `online_source IS NULL` 同款·非重算展示 kind）。null 检查=粗粒度
    //    "是否已上线"闸，不产生与 deriveOnlineSourceKind 竞争的 kind 判定，故放行；值比较仍禁（那才是重算）。
    //    [追加批·codex 363 号 M4 泛化] 上一版正则 `\b(iss|i)\.online_source` 是**变量名白名单**——codex
    //    363 指出 row./item./x. 等任意其它变量名会漏检（既不误报也不误放行，是纯粹的扫描盲区：换个变量名
    //    写同样的重算代码，守卫看不见）。改为**通用成员访问扫描**：任意标识符 `.online_source` 后跟值比较
    //    运算符，不再枚举变量名白名单。
    //    但通用化后会连坐两处**响应体**消费（非 issue DTO 列，是端点返回值，语义与"重算展示来源"无关）：
    //    · siModalAccept 里的 `d.online_source === 'no_commit_acceptance'`（accept 端点响应体）——用既有
    //      extractFunctionBody 整段函数体剥除处理（下方 srcSansAccept，先例未变）。
    //    · siModalSubmit 里的 `r.data.online_source === 'authorized_fastlane'`（submit 端点 direct_release
    //      成功响应体，组 B·SB3 新增）——**不整段剥 siModalSubmit**（该函数体量大，整段剥除会连带遮蔽
    //      函数内未来任何真实违规），改为精确剥除这一个字面量子串本身（同 siModalAccept 剥除范式的
    //      "剥最小必要单元"精神，只是单元从"整个函数体"收窄到"这一条字面量表达式"）：扫描前把
    //      `r.data.online_source` 替换成一个不含 `.online_source` 的中性占位串，通用正则天然扫不到它。
    //      [组B·S2 订正] 该字面量表达式已随两步化方案 §4-2 拆直上分支整块删除（direct_release 勾选框
    //      与响应体消费同批拆除），下方 `.replace(/r\.data\.online_source/g, ...)` 在真实 src 上现已是
    //      no-op（零匹配）——保留不删：若未来任何函数以同款写法重新消费 submit 响应体的 online_source
    //      字段（例如 S3+ 落地新的执行确认端点响应体），这行仍能按同一精神精确豁免，不必现在提前删除
    //      再等下次需要时重写一遍；下方 [M4] 对照组已改为合成注入验证该剥除步骤本身的可逆性，不再依赖
    //      真实 src 是否含这个具体子串。
    //    ⚠️ 全文核实：除这两处外，全仓 `.online_source` 仅余两条 `== null`（siHasActiveFastReleaseAuth
    //    定义处 + fastReleaseBtns 门控），均是 null 检查（无引号跟在运算符后），正则天然不命中，无需额外剥除。
    const acceptBody = extractFunctionBody(src, 'siModalAccept') || '';
    const srcSansAccept = src.replace(acceptBody, '')
        .replace(/r\.data\.online_source/g, '__SUBMIT_RESPONSE_BODY_ONLINE_SOURCE__');
    // [codex 364 L1 登记接受] 本正则覆盖**单层成员访问** `<标识符>.online_source === '…'`（含 row./item./任意变量名）。
    //   已知未覆盖形态（前瞻·当前代码库全无此写法）：多级链 `row.issue.online_source ===`、函数返回 `getIssue().online_source ===`、
    //   括号访问 `row['online_source'] ===`——若未来出现须升级到 AST（MemberExpression.property.name==='online_source' 且参与字符串字面量比较）。
    //   现阶段单层正则 + 通用标识符前缀已覆盖全部现有 issue DTO 读点，AST 化属独立守卫工程，本期不做。
    assert.ok(!/\b[\w$]+\.online_source\s*[=!]==?\s*'/.test(srcSansAccept),
        '[M3·M4 泛化] 前端不得把 issue.online_source 值比较到 kind 字面量重算「上线方式」展示（=== / !== \'…\'·任意标识符前缀，不再限定变量名白名单）——展示 kind 只认后端 online_source_kind；null 检查（未上线门控）不在此禁列；accept/submit 两处响应体消费已剥除不算违例。');
    // ④ 纯展示扩字段：不得因此新增来源筛选（同 C8 risk_level 的既定口径）
    assert.ok(!/online_source_kind[^\n]*(filter|筛选|addEq)/.test(src) && !/\?online_source=/.test(src),
        '[M3] C9 是纯展示扩字段，不应新增按上线来源筛选（加筛选属独立需求，须另行立项）');
});
// [追加批·codex 363 号 M4 泛化] 两条独立对照组——证明上面这条"通用成员访问扫描"判据既不是空炮（能真判红），
//   也没有在剥除响应体读点时顺手把整条正则削断（各自重算 srcSansAccept，不依赖外层 check 的闭包变量，
//   与本文件其余 check 一贯的"自包含"写法对齐，不引入跨 check 共享状态）。
check('[M4] ★对照组：把剥除后的中性占位串还原成真实响应体读点前缀，判据不应误报（证明剥除只掐掉这一处，不是把整条正则关掉）', () => {
    // [组B·S2 订正] 原写法依赖 `src` 真含 `r.data.online_source` 这一具体子串来做"剥除→复原→重新命中"
    //   的往返验证——该子串是 siModalSubmit 里 direct_release 成功响应体读点，已随两步化方案 §4-2 拆直上
    //   分支整块删除（见 Sys_Iteration.html S2-2 拆除记录），`src` 里已不再存在这个具体写法，往返验证
    //   失去真实依托对象。改为**合成注入**：不依赖真实源码是否还含这个具体子串，只验证"剥除+复原"这套
    //   机制本身对**任意**符合同一形态的字符串都是可逆的、不会把正则本身削断——与紧邻的下一条对照组
    //   （合成注入 `row.online_source === '…'`）同一精神，只是这条测的是"剥除目标子串本身复原后仍可
    //   命中"，那条测的是"剥除后正则仍能抓住其它变量名前缀"，两条互补，均不依赖真实业务代码现状。
    const acceptBody = extractFunctionBody(src, 'siModalAccept') || '';
    const synthetic = src + "\nconst __synthetic_check = r.data.online_source === 'authorized_fastlane';\n";
    const syntheticStripped = synthetic.replace(acceptBody, '')
        .replace(/r\.data\.online_source/g, '__SUBMIT_RESPONSE_BODY_ONLINE_SOURCE__');
    assert.ok(!/\b[\w$]+\.online_source\s*[=!]==?\s*'/.test(syntheticStripped),
        '合成注入的 r.data.online_source 子串剥除后不应被正则命中（剥除步骤本身应生效）');
    const restored = syntheticStripped.replace(/__SUBMIT_RESPONSE_BODY_ONLINE_SOURCE__/g, 'r.data.online_source');
    assert.ok(/\b[\w$]+\.online_source\s*[=!]==?\s*'/.test(restored),
        '还原占位串后正则应重新命中该行（若不命中，说明剥除逻辑把正则本身削断了而非精确排除了目标子串）');
});
check('[M4] ★对照组：注入一个用未白名单变量名（如 row.）写的重算分支，通用正则应判红（证明不再是变量名白名单）', () => {
    const acceptBody = extractFunctionBody(src, 'siModalAccept') || '';
    const srcSansAccept = src.replace(acceptBody, '')
        .replace(/r\.data\.online_source/g, '__SUBMIT_RESPONSE_BODY_ONLINE_SOURCE__');
    const injected = srcSansAccept + "\nconst fake = row.online_source === 'authorized_fastlane';\n";
    assert.ok(/\b[\w$]+\.online_source\s*[=!]==?\s*'/.test(injected),
        '注入 row.online_source === \'…\' 后正则应命中（旧版 (iss|i) 变量名白名单对 row. 前缀是扫描盲区，本条证明泛化后已堵住）');
});
check('[M3] 后端契约：deriveOnlineSourceKind 对非「已上线」单恒返 null（前端 kv 门控的前提）', () => {
    const indexJsPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const indexJsSrc = fs.readFileSync(indexJsPath, 'utf8');
    // 前端只判 online_source_kind 非空、不另判 status，其正确性完全依赖后端这一行——跨文件钉死，
    //   否则后端哪天去掉这个 early return，前端会给「待验证」单也渲染出一行「上线方式」。
    assert.ok(/function deriveOnlineSourceKind\(row\) \{\s*\n\s*if \(!row \|\| row\.status !== SYS_ONLINE_STATUS\) return null;/.test(indexJsSrc),
        '[M3] deriveOnlineSourceKind 首行须对非「已上线」单 return null——前端「上线方式」kv 只判该字段非空、不另判 status，这一行就是"仅已上线单渲染"的唯一保证');
    assert.ok(/online_source_kind/.test(indexJsSrc), '[M3] 后端须以 online_source_kind 键名下发（前端按此键读取）');
});

console.log('— §⑫ 列表页「系统」列双行（2026-08-10 用户拍板·codex M4 补守卫）—');
check('列表行系统单元格走 siSystemCellHtml 双行结构，排序仍只绑 system_name', () => {
    assert.ok(/<td>\$\{siSystemCellHtml\(i\)\}<\/td>/.test(src), '列表行的系统单元格应调 siSystemCellHtml(i)（单行 esc(i.system_name) 已被 2026-08-10 双行改造取代）');
    assert.ok(/data-sort-by="system_name">系统</.test(src), '表头应保持「系统」+ data-sort-by=system_name（模块子行不参与排序键，同需求方列部门子行口径）');
    assert.ok(!/data-sort-by="module_name"/.test(src), 'module_name 不得成为排序键——它是下行小字展示，不是独立列');
});
check('siSystemCellHtml：trim 判空、未填占位「—」、超 4 字码点截断 + title 悬停全名', () => {
    const fn = extractFunctionBody(src, 'siSystemCellHtml');
    assert.ok(fn, 'siSystemCellHtml 函数体应能被提取（防改名后本组静默失效）');
    assert.ok(/\(i\.module_name \|\| ''\)\.trim\(\)/.test(fn), '模块名须 trim 后判空（codex 259 L-1 渲染端兜底口径：纯空白串不得渲染成"看着有值实则空白"）');
    assert.ok(/let sub = '—';/.test(fn), '未填模块须占位全角「—」（同页空值占位统一口径，见预计完成/期望完成列）');
    assert.ok(/Array\.from\(mod\)/.test(fn), '截断须按码点计（Array.from），防 BMP 外字符被 slice 劈成半个代理对');
    assert.ok(/chars\.length > 4/.test(fn) && /chars\.slice\(0, 4\)/.test(fn), '超 4 字须截前 4 字（用户 2026-08-10 拍板口径）');
    assert.ok(/title="\$\{esc\(mod\)\}"/.test(fn), '截断分支须挂 title=esc(全名)（悬停看完整模块名，对齐 commit 列纯 title 范式）');
    assert.ok(/<div class="si-muted" style="font-size:11px;">/.test(fn), '下行须为 si-muted 11px 小字（与需求方列部门子行同款范式）');
    assert.ok(/\$\{esc\(i\.system_name\)\}/.test(fn), '上行 system_name 须经 esc 转义');
});

console.log('— §⑬ 对接人绑单收口（2026-08-10·isSysCoordinator 消费面钉死）—');
check('后端 isSysCoordinator 仅存 2 个读路径调用点（防新写端点误引重新引入 [13] 全局写权）', () => {
    const indexJsPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const indexJsSrc = fs.readFileSync(indexJsPath, 'utf8');
    // 消费面登记表（codex 332 risks 建议落地）：定义 1 + 调用 2 = 恰 3 处 `isSysCoordinator(`。
    //   两个合法调用点均为**读路径可见性**（详情附件列表可见 / 附件下载），且都叠加了 isBoundLiaisonOrAdmin
    //   增量；附件上传/删除两写路径已改 isBoundLiaisonEligibleOrAdmin 绑单精判（指派族 C10 已改）。
    //   本断言红了 = 有人新增/删除了 isSysCoordinator 调用——新增写端点引用它会静默复活「白名单[13] 全局
    //   写权」，先来这里对齐口径再动。
    const calls = (indexJsSrc.match(/isSysCoordinator\(/g) || []).length;
    assert.strictEqual(calls, 3, `isSysCoordinator( 出现次数应恰 3（定义1+读路径调用2），实得 ${calls}——新增调用须先核对绑单收口口径（写路径禁用本函数）`);
    assert.ok(/isSysCoordinator\(attActor, row\.type\) \|\| isBoundLiaisonOrAdmin\(attActor, row\)/.test(indexJsSrc),
        '详情附件可见性应为「isSysCoordinator ∨ isBoundLiaisonOrAdmin」增量式（读路径保留[13]+绑定本人）');
    assert.ok(/isSysCoordinator\(actor, row\.type\) \|\| isBoundLiaisonOrAdmin\(actor, row\)/.test(indexJsSrc),
        '附件下载应为「isSysCoordinator ∨ isBoundLiaisonOrAdmin」增量式（同上）');
});
check('前端 isSiBoundLiaison 判据存在且 per-issue 操作权已断开白名单（isSiIntakeLiaison 仅存 release 级+读路径 8 消费点）', () => {
    assert.ok(/function isSiBoundLiaison\(iss\)/.test(src), '应定义 isSiBoundLiaison(iss) per-issue 绑单镜像判据');
    assert.ok(/iss\.intake_liaison_id != null\s*\n?\s*&& Number\(iss\.intake_liaison_id\) === Number\(currentUser\.id\)/.test(src),
        'isSiBoundLiaison 应比对本单 intake_liaison_id 与当前用户（null 安全）');
    // 消费面钉死：isSiIntakeLiaison( 文本恰 10 处 = 常量区注释提及 1（`isSiIntakeLiaison([13]) 的语义…`）+
    //   定义 1 + release 级调用 4（上线单管理入口/我的批次探测早退/排班表写权/批次执行摘要）+ 读路径增量
    //   调用 4（通知区可见/变更流查已读/bug 流查已读/含已作废查看权 siCanViewVoided——2026-08-17 开放受理人，
    //   属白名单语义②「读路径可见性」的合法增量，非 per-issue 操作权）。红了=有人把白名单判据接回了
    //   per-issue 操作权（或删了刻意保留项），先对齐绑单收口口径再改本数。
    const siCalls = (src.match(/isSiIntakeLiaison\(/g) || []).length;
    assert.strictEqual(siCalls, 10, `isSiIntakeLiaison( 出现次数应恰 10（注释1+定义1+release级4+读路径4），实得 ${siCalls}`);
    // 新消费点锚定：siCanViewVoided 判据应为 admin ∨ 受理人（防未来误改成裸白名单或漏 admin）
    assert.ok(/function siCanViewVoided\(\) \{ return isAdmin\(\) \|\| \(currentUser && isSiIntakeLiaison\(currentUser\.id\)\); \}/.test(src),
        'siCanViewVoided 应为「isAdmin() ∨ isSiIntakeLiaison(currentUser.id)」判据');
});

console.log('— §⑭（R-C5·方案 §3 O3）上线单基本信息编辑前端不变量 —');
check('详情 kv 网格新增「标题」行（且挂在 siOpenBatchDetail 函数体内，非另起渲染路径）', () => {
    const body = stripComments(extractFunctionBody(src, 'siOpenBatchDetail') || '');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    // 红：kv 行被删/label 文案改动/挪出本函数——N0-R 订正明文"须新增一整行 kv"，不是往既有行插按钮。
    assert.ok(/<div class="u-kv-item full"><label>标题<\/label>/.test(body), 'kv 网格未见「标题」行（class 应为 full，同「上线说明」整行占位）');
});
check('编辑门槛条件与后端 D8 通知门同构：planning ∧ isAdmin() ∧（未通知 ∨ 标题为空例外）', () => {
    const body = stripComments(extractFunctionBody(src, 'siOpenBatchDetail') || '');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    // 红：任一子条件被删（如漏 `|| titleBlank`）——例外通道会消失，已通知批次的"忘记写标题"场景补不了；
    //   或反过来漏 `!notifyStarted &&` 前提——会在未通知的正常场景也一并锁死编辑入口。
    assert.ok(body.includes("const canEditReleaseInfo = planning && isAdmin() && (!notifyStarted || titleBlank);"),
        '未见 canEditReleaseInfo 门槛表达式（或被改写成非等价形式）——须与后端 D8 三道门第③条（通知门含例外）同构');
    assert.ok(body.includes("const notifyStarted = !['none', 'not_sent'].includes(execSummary);"),
        'notifyStarted 判据应与后端 getReleaseNotifySummary 聚合态口径同源（none/not_sent 两态视为未通知）');
    // [S10 预筛提示1] titleBlank 口径字面锚——丢 trim 会与后端 norm 分叉（title='   ' 时前端藏按钮而后端本可放行）
    assert.ok(body.includes("const titleBlank = !(rel.title && String(rel.title).trim());"),
        '未见 titleBlank 判据（须含 trim·与后端 norm(beforeRow.title)===null 口径同源）');
});
check('编辑按钮 onclick 走 siReleaseEditInfoModal 且挂在门槛变量之后（不是恒渲染）', () => {
    const body = stripComments(extractFunctionBody(src, 'siOpenBatchDetail') || '');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    assert.ok(body.includes('onclick="siReleaseEditInfoModal(${id})"'), '未见「编辑」按钮 onclick 调用 siReleaseEditInfoModal');
    // [S10 预筛提示5] 结构锚（非行内换行锚·格式化免疫）：同一赋值语句内 canEditReleaseInfo 与调用名共现
    const btnStmt = /const releaseEditBtn = canEditReleaseInfo[\s\S]{0,200}siReleaseEditInfoModal/.test(body);
    assert.ok(btnStmt, '编辑按钮 HTML 应由 canEditReleaseInfo 门控产出且 200 字符内接 siReleaseEditInfoModal 调用（红：恒渲染或条件弱化）');
});
check('release_info_edit 三表正向登记（[S10 预筛拦截 B1] 照 fastlane:877 同族先例——SI_TL_CLS 此前零守卫：摘掉词条 84 断言全绿而运行时静默降级灰徽章；Set 双向相等断言只证两处一致不证含本码）', () => {
    const labelBody = stripComments(extractConstObjectText('SI_TL_LABEL') || '');
    const clsBody = stripComments(extractConstObjectText('SI_TL_CLS') || '');
    assert.ok(labelBody && /release_info_edit:\s*'上线单信息修改'/.test(labelBody), 'SI_TL_LABEL 应含 release_info_edit 词条');
    assert.ok(clsBody && /release_info_edit:\s*'si-tl-indigo'/.test(clsBody), 'SI_TL_CLS 应含 release_info_edit 词条（缺失=运行时静默降级 si-tl-gray）');
    assert.ok(/SI_TL_NOTE_OWN_LABEL_CODES\s*=\s*new Set\(\[[\s\S]*?'release_info_edit'/.test(src), 'SI_TL_NOTE_OWN_LABEL_CODES 应含 release_info_edit（缺失=落回通用「备注」徽章）');
});
check('siReleaseEditInfoModal：PATCH 同一批次资源（非改期/加单等子路由）且三字段齐全提交', () => {
    const body = stripComments(extractFunctionBody(src, 'siReleaseEditInfoModal') || '');
    assert.ok(body, '未提取到 siReleaseEditInfoModal 函数体');
    // 红：改成拼接了子路径（如 /update-planned-date）——会打到错误端点；或漏了三字段之一——D8 例外边界二
    //   （三字段全量提交但只有 title 真变）这条既有后端用例的前端触发条件就不成立了。
    assert.ok(/siApi\('\/sys-releases\/'\s*\+\s*releaseId,\s*\{\s*method:\s*'PATCH'/.test(body),
        '未见 PATCH /sys-releases/:id 调用（应直拼 releaseId，不带任何子路径后缀）');
    assert.ok(/body:\s*\{\s*title:\s*v\.title,\s*version_tag:\s*v\.version_tag,\s*release_note:\s*v\.release_note\s*\}/.test(body),
        'PATCH body 应恰好三字段（title/version_tag/release_note）齐全提交，不做客户端预筛选');
});
check('siReleaseEditInfoModal 三字段回填走 fText/fTextarea 既有转义 helper（449-H4 转义契约，不手写插值）', () => {
    const body = stripComments(extractFunctionBody(src, 'siReleaseEditInfoModal') || '');
    assert.ok(body, '未提取到 siReleaseEditInfoModal 函数体');
    // 红：改成裸模板字符串插值（如 `value="${rel.title}"`）——fText/fTextarea 内部已 esc()，绕开它们
    //   等于绕开了转义契约本身，需要重新证明新写法同样安全。
    assert.ok(/fText\('title', '标题', rel\.title \|\| '', false/.test(body), 'title 字段未见走 fText helper 回填');
    assert.ok(/fText\('version_tag', '版本号', rel\.version_tag \|\| '', false/.test(body), 'version_tag 字段未见走 fText helper 回填');
    assert.ok(/fTextarea\('release_note', '上线说明', rel\.release_note \|\| '', false/.test(body), 'release_note 字段未见走 fTextarea helper 回填');
});
check('D9：release_info_edit 不注册进 SI_TL_RELEASE_SCOPE_LABEL（否则会被「隐藏上线单调整记录」过滤器连带隐藏）', () => {
    const m = stripComments(src).match(/const SI_TL_RELEASE_SCOPE_LABEL = \{[\s\S]*?\n {4}\};/);
    assert.ok(m, '未定位到 SI_TL_RELEASE_SCOPE_LABEL 对象字面量');
    assert.ok(!m[0].includes('release_info_edit'), 'release_info_edit 不应出现在 SI_TL_RELEASE_SCOPE_LABEL 内（违反 D9「信息修改始终可见」）');
});
check('P2 遗留收口：siRenderBatchList 空态文案按 isAdmin() 三分支实现（非 admin 不再看到必然点不到的「新建上线单」引导）', () => {
    const body = extractFunctionBody(src, 'siRenderBatchList');
    assert.ok(body, '未提取到 siRenderBatchList 函数体');
    // 红：isAdmin() 分支被合并/删除——「+ 新建上线单」按钮本就只对 isAdmin() 渲染（头部动作位），
    //   若空态文案退回旧的 isMine 二分支，对接人（!isMine 但非 admin）会重新看到点不到的引导文案。
    assert.ok(body.includes("const emptyText = isMine ? '暂无指派给你的上线单' : (isAdmin() ? '暂无上线单，点右上角「新建上线单」' : '暂无上线单');"),
        '空态文案未按 isAdmin() 三分支实现');
});

console.log('— §⑮（R-C7·方案 §3 O4）删除上线单前端不变量 —');
check('删除按钮门槛条件与后端状态门同构：isAdmin() ∧ 通知未启动（无 D8 title 补空例外——delete 无该豁免）', () => {
    const body = stripComments(extractFunctionBody(src, 'siOpenBatchDetail') || '');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    // 红：条件里出现 titleBlank（误把 O3 的 D8 例外抄进 delete，与"delete 没有补空不算改这回事"矛盾）；
    //   或漏 !notifyStarted（会在通知已启动的批次上误开删除按钮，撞后端必然 409）。
    // ⚠️ 用严格的整段 if(...) 字面匹配（而非"两个子串各自邻域出现"的弱判据）——门槛条件必须逐字等于
    //   `isAdmin() && !notifyStarted`（外层允许空白），这样"误抄 D8 例外多加 (…||titleBlank)"这类変异
    //   会因整段字面量不再匹配而被本条直接判红，不依赖另一条独立的反向正则（下方变异对照组验证的正是
    //   这条严格匹配本身，而非另一条更弱的反向断言）。
    assert.ok(/if\s*\(\s*isAdmin\(\)\s*&&\s*!notifyStarted\s*\)\s*\{/.test(body),
        '未见 `if (isAdmin() && !notifyStarted) {` 删除按钮门槛（或条件被改写成非等价形式，如误加 titleBlank/其它子条件）');
});
check('删除按钮 onclick 走 siReleaseDeleteModal，且门槛条件与调用在 200 字符邻域内共现（非恒渲染）', () => {
    const body = stripComments(extractFunctionBody(src, 'siOpenBatchDetail') || '');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    assert.ok(/isAdmin\(\)\s*&&\s*!notifyStarted[\s\S]{0,200}siReleaseDeleteModal/.test(body),
        '删除按钮 HTML 应由 isAdmin() && !notifyStarted 门控产出且 200 字符内接 siReleaseDeleteModal 调用（红：恒渲染或条件弱化）');
    // ⭐ [codex 475 回卷 MED-1] 四参传漏——releaseNo/pendingMemberCount/voidedMemberCount 是二次确认弹窗
    //   分状态措辞的数据源（后端「已作废」成员删批次只清指针不改 status，不是"退回待上线"，见
    //   siReleaseDeleteModal 处注释），漏传或传错任一个都会让影响面文案与后端真实行为脱节。
    assert.ok(/siReleaseDeleteModal\(\$\{id\},\$\{siJsStringAttr\(rel\.release_no \|\| ''\)\},\$\{pendingMemberCount\},\$\{voidedMemberCount\}\)/.test(body),
        '删除按钮 onclick 应传恰四参：releaseId/release_no（siJsStringAttr 转义）/pendingMemberCount/voidedMemberCount');
    // 红：两个计数改用 issues.length 或其它裸计数——必须是按 i.status 精确分类算出的两个独立计数，
    //   不能用总数模糊代替（那正是本次修法要消灭的问题：总数无法区分"退回待上线"与"仅清指针"两类）。
    assert.ok(/const pendingMemberCount = issues\.filter\(i => i\.status === '待上线'\)\.length;/.test(body),
        '未见 pendingMemberCount = issues.filter(i => i.status === \'待上线\').length 的精确计数');
    assert.ok(/const voidedMemberCount = issues\.filter\(i => i\.status === '已作废'\)\.length;/.test(body),
        '未见 voidedMemberCount = issues.filter(i => i.status === \'已作废\').length 的精确计数');
});
check('release_deleted 三表正向登记（同 release_info_edit R-C5 同款先例：SI_TL_CLS 无独立守卫，摘掉词条会静默降级灰徽章；Set 双向相等断言只证两处一致不证含本码）', () => {
    const labelBody = stripComments(extractConstObjectText('SI_TL_LABEL') || '');
    const clsBody = stripComments(extractConstObjectText('SI_TL_CLS') || '');
    assert.ok(labelBody && /release_deleted:\s*'上线单已删除'/.test(labelBody), 'SI_TL_LABEL 应含 release_deleted 词条');
    assert.ok(clsBody && /release_deleted:\s*'si-tl-red'/.test(clsBody), 'SI_TL_CLS 应含 release_deleted 词条（缺失=运行时静默降级 si-tl-gray）');
    assert.ok(/SI_TL_NOTE_OWN_LABEL_CODES\s*=\s*new Set\(\[[\s\S]*?'release_deleted'/.test(src), 'SI_TL_NOTE_OWN_LABEL_CODES 应含 release_deleted（缺失=落回通用「备注」徽章）');
});
check('release_deleted 不注册进 SI_TL_RELEASE_SCOPE_LABEL（同 D9 精神——若误入会被「隐藏上线单调整记录」过滤器连带隐藏，删除是比编辑更高关注度的事件，理应同等可见）', () => {
    const m = stripComments(src).match(/const SI_TL_RELEASE_SCOPE_LABEL = \{[\s\S]*?\n {4}\};/);
    assert.ok(m, '未定位到 SI_TL_RELEASE_SCOPE_LABEL 对象字面量');
    assert.ok(!m[0].includes('release_deleted'), 'release_deleted 不应出现在 SI_TL_RELEASE_SCOPE_LABEL 内');
});
check('siReleaseDeleteModal：DELETE 同一批次资源（非子路由）+ reason 必填 fTextarea + 提交前 trim/长度校验 + 成功后回列表（非回详情——批次已不存在）', () => {
    const body = stripComments(extractFunctionBody(src, 'siReleaseDeleteModal') || '');
    assert.ok(body, '未提取到 siReleaseDeleteModal 函数体');
    // 红：改成拼接了子路径——会打到错误端点。
    assert.ok(/siApi\('\/sys-releases\/'\s*\+\s*releaseId,\s*\{\s*method:\s*'DELETE'/.test(body),
        '未见 DELETE /sys-releases/:id 调用（应直拼 releaseId，不带任何子路径后缀）');
    assert.ok(/body:\s*\{\s*reason\s*\}/.test(body), 'DELETE 请求体应恰为 { reason }');
    assert.ok(body.includes("fTextarea('reason', '删除原因', '', true"), '未见 reason 必填 fTextarea 字段（第4参应为 true）');
    // 红：提交前不做 trim/长度前置校验——虽然后端会 400 拒绝，但前端应同后端一致做前置防呆（同 siDeleteIssue 既有范式）。
    assert.ok(/reason\.length > 200/.test(body), '未见前端 reason 超长（>200）前置校验');
    // 红：成功后调 siOpenBatchDetail(releaseId) 而非 siRenderBatchList()——删除后该批次已物理不存在，
    //   详情页无处可留，必须回列表（同 siDeleteIssue 删除成功后 siCloseDrawer+siLoadList 的范式精神）。
    // ⭐ [Opus 预筛 S12 回卷提示5] siRenderBatchList 前须 await——同族 siReleaseEditInfoModal（await
    //   siOpenBatchDetail）/siRemoveFromBatch（await siOpenBatchDetail）等收尾调用均 await，漏 await
    //   会产生未追踪的 Promise（unhandled rejection 面）。
    assert.ok(/showToast\('已删除', 'success'\);\s*\n[\s\S]{0,400}\n\s*siCloseModal\(\); await siRenderBatchList\(\); return false;/.test(body),
        '删除成功后应 siCloseModal() + await siRenderBatchList()（回列表，非 siOpenBatchDetail——批次已不存在；且必须 await，不留未追踪 Promise）');
});
check('[codex 475 回卷 MED-1] siReleaseDeleteModal 影响面文案四分支——已作废成员措辞与后端 R-C6 修法(b) 真实行为（只清指针不改 status）同构，不再统一宣称"退回待上线"', () => {
    const body = stripComments(extractFunctionBody(src, 'siReleaseDeleteModal') || '');
    assert.ok(body, '未提取到 siReleaseDeleteModal 函数体');
    // 红：signature 退回三参/改名——四分支逻辑的输入面必须是 pendingCount/voidedCount 两个独立计数。
    //   ⚠️ 签名行在 `{` 之前，不属于 extractFunctionBody 返回的 body（body 从 `{` 起算）——故对 src 判断。
    assert.ok(src.includes('function siReleaseDeleteModal(releaseId, releaseNo, pendingCount, voidedCount)'),
        '未见 siReleaseDeleteModal(releaseId, releaseNo, pendingCount, voidedCount) 四参签名');
    // 分支①：pending>0 且 voided>0——必须同时出现"退回「待上线」"与"仅解除与本上线单的关联（保持「已作废」）"
    //   两段措辞，且分别绑定 pCount/vCount（不能两段共用同一个数字——那会把"多少张已作废"误报成"多少张待上线"）。
    assert.ok(/张待上线单据会退回「待上线」，<b>\$\{vCount\}<\/b> 张已作废单据仅解除与本上线单的关联（保持「已作废」）。`;/.test(body),
        '混合分支（pending>0∧voided>0）文案未见"…张待上线单据会退回「待上线」，N 张已作废单据仅解除与本上线单的关联（保持「已作废」）。"完整形态');
    assert.ok(/\$\{pCount\}<\/b> 张待上线单据会退回「待上线」/.test(body), '混合分支的 pending 计数应绑定 pCount 变量');
    // 分支②：仅 pending（voided=0）——保留原"N 张单据会退回「待上线」"措辞（不带"待上线单据"限定词，
    //   因为此时没有第二类需要区分的成员）。
    assert.ok(/\$\{pCount\}<\/b> 张单据会退回「待上线」。`;/.test(body), '仅 pending 分支未见"…其中 N 张单据会退回「待上线」。"（不应带"待上线单据"限定词）');
    // 分支③：仅 voided（pending=0）——"N 张已作废单据仅解除与本上线单的关联（保持「已作废」）"，且不得
    //   出现"退回待上线"字样（那是分支①②专属，voided-only 场景下没有任何单据会退回待上线）。
    assert.ok(/\$\{vCount\}<\/b> 张已作废单据仅解除与本上线单的关联（保持「已作废」）。`;/.test(body), '仅 voided 分支未见"…其中 N 张已作废单据仅解除与本上线单的关联（保持「已作废」）。"');
    // 分支④：全 0——维持"该批次当前无成员"措辞不变。
    assert.ok(/不可恢复<\/b>（该批次当前无成员）。`;/.test(body), '全 0 分支未见"（该批次当前无成员）"措辞');
    // 反向锚点：仅 voided 分支绝不能出现"张单据会退回「待上线」"（没有 pCount 变量介入的裸"退回待上线"），
    //   防止有人在分支③误抄分支②的措辞导致"已作废单据"也被宣称会退回待上线。
    const voidedOnlyBranch = (body.match(/else if \(vCount > 0\) \{[\s\S]*?\n {8}\}/) || [''])[0];
    assert.ok(voidedOnlyBranch && !voidedOnlyBranch.includes('退回「待上线」'), '仅 voided 分支（else if (vCount > 0)）不应出现"退回「待上线」"字样——已作废成员不会退回待上线');
});
check('活体变异对照组①：门槛条件叠加 titleBlank（误抄 D8 例外）——上方严格 if(...) 字面匹配须判红', () => {
    const mutated = src.replace(
        'if (isAdmin() && !notifyStarted) {',
        'if (isAdmin() && (!notifyStarted || titleBlank)) {'
    );
    assert.notStrictEqual(mutated, src, '变异替换未命中原文——门槛条件字面量已漂移，需同步本条变异对照组');
    const mutatedBody = stripComments(extractFunctionBody(mutated, 'siOpenBatchDetail') || '');
    assert.ok(!/if\s*\(\s*isAdmin\(\)\s*&&\s*!notifyStarted\s*\)\s*\{/.test(mutatedBody),
        '变异后严格 if(...) 字面正则仍能匹配——说明该正则对"误抄 D8 例外"这类変异不敏感，守卫本身失效');
});
check('活体变异对照组②：门槛条件弱化为恒真 isAdmin()（漏 !notifyStarted）——上方严格 if(...) 字面匹配须判红', () => {
    const mutated = src.replace(
        'if (isAdmin() && !notifyStarted) {',
        'if (isAdmin()) {'
    );
    assert.notStrictEqual(mutated, src, '变异替换未命中原文——门槛条件字面量已漂移，需同步本条变异对照组');
    const mutatedBody = stripComments(extractFunctionBody(mutated, 'siOpenBatchDetail') || '');
    assert.ok(!/if\s*\(\s*isAdmin\(\)\s*&&\s*!notifyStarted\s*\)\s*\{/.test(mutatedBody),
        '变异后严格 if(...) 字面正则仍能匹配——说明该正则对"漏 !notifyStarted"这类変异不敏感，守卫本身失效');
});

console.log('— §⑯（收尾批 2026-08-27）R 两组错误码不入 SI_ERR_TEXT + 成员状态枚举防御 —');
// 背景：siApiErr(:1423) 只取 `r.data.error || r.data.code`、从不查 SI_ERR_TEXT，而编辑/删除两处调用点
//   走的正是 siApiErr ⇒ 登记进 SI_ERR_TEXT 即死词条（R-C5/R-C7 曾各登记 6+4 条，收尾批一并摘除）。
//   本组守卫钉住"摘掉后别再加回来"，口径与 verify-sys-fastlane-panel-static.js ⑨ 同源（那条盯的是
//   FASTLANE_*/FAST_RELEASE_EXEC_* 系列），也与 verify-badge-alias.js 裁定 3③「非通知 CRUD 端点的码
//   不在冻结表内，接表反而信息倒退」一致。文案登记归文档（通知统一_错误码映射 §6.5），不归本表。
// ⚠️ 不能复用上方 extractConstObjectText：它的起始正则是 `const NAME = {`（裸对象字面量），而
//   SI_ERR_TEXT 声明形态是 `const SI_ERR_TEXT = Object.freeze({` ⇒ 匹配不上直接返回 null，且它写死
//   读全局 src、无法喂变异后的源码（活体变异对照组会因此静默失效）。这里按 verify-sys-fastlane-
//   panel-static.js ⑨ 的同款切片自取，并显式收 source 参数。表体内无嵌套对象字面量，首个 `});` 即
//   收尾（与那条守卫同一前提）。
function grabErrTextBlock(source) {
    const start = source.indexOf('const SI_ERR_TEXT = Object.freeze({');
    if (start < 0) return null;
    const end = source.indexOf('});', start);
    return end < 0 ? null : source.slice(start, end);
}
const R_DEAD_CODES = Object.freeze([
    // R-C5 编辑批六码
    'RELEASE_NOTIFY_STARTED', 'RELEASE_PATCH_UNSUPPORTED_FIELD', 'RELEASE_PATCH_INVALID_TYPE',
    'RELEASE_TITLE_TOO_LONG', 'VERSION_TAG_TOO_LONG', 'RELEASE_NOTE_TOO_LONG',
    // R-C7 删除批四码
    'RELEASE_NOT_FOUND', 'RELEASE_DELETE_REASON_REQUIRED', 'RELEASE_MEMBER_STATE_DIRTY', 'RELEASE_DELETE_CONFLICT',
]);
// [codex 478 MED-1 收口] 主断言抽成可复用函数——变异对照组必须**真正执行同一个断言函数**并要求它
//   抛错，而不是另写一条"变异后文本里能找到该码"的存在性正则去间接推断。后者的漏洞是：若主断言的
//   提取范围或正则退化（比如 grabErrTextBlock 少切了一段），主断言会假绿，而存在性正则照样能匹配到
//   ⇒ 对照组也绿，两条一起失效却无人报警。现在改为同实现同入口，主断言坏掉时对照组必然跟着红。
// [codex 478 复审 MED-1 收口] 属性键的三种合法写法都要覆盖：裸键 `CODE:`、单引号 `'CODE':`、
//   双引号 `"CODE":`。首版只写 `\bCODE\s*:`，带引号回流（JS 完全合法、且 SI_ERR_TEXT 里已有别的
//   条目是这种风格的可能性存在）会从主断言底下溜过去 ⇒ 假绿。前缀限定为行首/空白/逗号/左花括号，
//   避免把别处的子串误当成属性键。
function deadCodeKeyRe(code) {
    return new RegExp(`(?:^|[\\s,{])['"]?${code}['"]?\\s*:`, 'm');
}
function assertNoDeadCodes(source) {
    const block = stripComments(grabErrTextBlock(source) || '');
    assert.ok(block, '未提取到 SI_ERR_TEXT 常量体——扫描面落空（比断言失败更坏，先修提取器）');
    // 剥注释先行：本表内部就写着解释这条口径的大段注释，不剥会被自己的注释文本假红。
    for (const code of R_DEAD_CODES) {
        assert.ok(!deadCodeKeyRe(code).test(block),
            `SI_ERR_TEXT 不应登记 ${code}（裸键/单引号键/双引号键三形态均判红）——该码所属端点（PATCH/DELETE /sys-releases/:id）经 siApiErr 直出后端 error 原文，本表条目永不被命中（死词条），且与后端完整中文句构成两份会漂移的翻译。文案登记请写进 docs/local/前端统一/通知统一_错误码映射_20260809_v1.0.md §10.2 登记项 5`);
    }
}
check(`SI_ERR_TEXT 不含编辑/删除两组共 ${R_DEAD_CODES.length} 码（siApiErr 不查表，登记即死词条 + 与后端原文漂移的第二份翻译）`, () => {
    assertNoDeadCodes(src);
});
check('反向对照组：SI_ERR_TEXT 提取器确实抓得到内容（通知域既有码仍在表内——防上一条因提取落空而假绿）', () => {
    const block = stripComments(grabErrTextBlock(src) || '');
    // 这四个是通知域真活码（走 siErrText 的调用点消费），必须仍在；若它们也没了，说明提取器抓空或
    //   有人把整张表删了，上一条的"全部不含"就成了无意义的恒真断言。
    for (const live of ['RELEASE_NOT_PLANNING', 'EXECUTOR_NOT_ACTIVE', 'NOTIFY_IN_FLIGHT', 'STATUS_NOT_NOTIFIABLE']) {
        assert.ok(new RegExp(`\\b${live}\\s*:`).test(block), `SI_ERR_TEXT 应仍含通知域活码 ${live}（缺失=提取落空或误删活词条）`);
    }
});
check('活体变异对照组：把一条 R 死码塞回 SI_ERR_TEXT——上方断言函数须真的抛错（codex 478 MED-1 收口）', () => {
    // 锚点是单行片段：本 HTML 是 CRLF，跨行锚点写 '…\n…' 匹配不上真实的 '\r\n'（会静默变成"变异没
    //   发生"⇒ 对照组假绿）。塞在 §6.6 注释行**之前**，确保落在 SI_ERR_TEXT 常量体范围内。
    const anchor = "        // §6.6 tech consult / tech-lead-comment";
    assert.ok(src.includes(anchor), '变异锚点（§6.6 注释行）未命中——锚点已漂移，需同步本条变异对照组');
    const mutated = src.replace(anchor, "        RELEASE_DELETE_CONFLICT: '批次状态已并发变更，请刷新重试',\r\n" + anchor);
    assert.notStrictEqual(mutated, src, '变异替换未产生差异——需同步本条变异对照组');
    // 关键：跑**同一个** assertNoDeadCodes，要求它对变异源码抛 AssertionError。
    //   它若没抛，说明主断言对"死码真回流"不敏感 ⇒ 守卫本身失效（而非实现没问题）。
    let threw = null;
    try { assertNoDeadCodes(mutated); } catch (e) { threw = e; }
    assert.ok(threw, '变异后 assertNoDeadCodes 未抛错——上方"不含死码"断言对真实回流不敏感（提取范围或正则失效），守卫本身失效');
    assert.ok(/RELEASE_DELETE_CONFLICT/.test(threw.message),
        `变异后确实抛错，但报的不是被塞回的那个码（实得："${String(threw.message).slice(0, 120)}"）——说明红灯来源与本变异无因果关系，仍属假对照`);
});
// [codex 478 复审 MED-1] 带引号属性键的第二条变异——首版正则 `\bCODE\s*:` 对这种写法完全无感，
//   而 `'CODE': '...'` 是合法 JS、真回流时很可能就长这样。两种键形态各一条对照组，缺一不可。
for (const [quoteLabel, quoted] of [['单引号', "'RELEASE_DELETE_CONFLICT'"], ['双引号', '"RELEASE_DELETE_CONFLICT"']]) {
    check(`活体变异对照组：以${quoteLabel}属性键塞回死码——assertNoDeadCodes 同样须抛错（防带引号写法绕过）`, () => {
        const anchor = "        // §6.6 tech consult / tech-lead-comment";
        assert.ok(src.includes(anchor), '变异锚点（§6.6 注释行）未命中——锚点已漂移，需同步本条变异对照组');
        const mutated = src.replace(anchor, `        ${quoted}: '批次状态已并发变更，请刷新重试',\r\n` + anchor);
        assert.notStrictEqual(mutated, src, '变异替换未产生差异——需同步本条变异对照组');
        let threw = null;
        try { assertNoDeadCodes(mutated); } catch (e) { threw = e; }
        assert.ok(threw, `以${quoteLabel}键塞回死码后 assertNoDeadCodes 未抛错——正则只认裸键，带引号写法可绕过主断言（假绿面）`);
        assert.ok(/RELEASE_DELETE_CONFLICT/.test(threw.message),
            `抛错了但报的不是被塞回的码（实得："${String(threw.message).slice(0, 120)}"）——红灯与本变异无因果关系`);
    });
}
check('[codex 475 LOW-1] 成员状态枚举防御：pending+voided 恒等于成员总数的契约有断言兜住，破契约时按钮置灰而非隐藏', () => {
    const body = stripComments(extractFunctionBody(src, 'siOpenBatchDetail') || '');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    assert.ok(/const memberStateSound = \(pendingMemberCount \+ voidedMemberCount\) === issues\.length;/.test(body),
        '未见 memberStateSound 契约断言——后端 badMembers 闸只承认「待上线」/「已作废」两态，前端两计数之和必须逐字对拍 issues.length（少报成员数是比报错更坏的静默失真）');
    assert.ok(/if \(!memberStateSound\) \{[\s\S]{0,400}console\.error\(/.test(body),
        '契约破裂时未 fail-loud 到 console.error（同 KIT_VERSION 不一致即报错的既有范式，不静默降级）');
    // 红：改成 `memberStateSound && ...` 式的隐藏写法——那会让 admin 面对一个既无删除入口又无解释的
    //   批次（受困态不可解释）。必须是三元里带 disabled 的置灰分支。
    assert.ok(/foot \+= memberStateSound\s*\?[\s\S]{0,600}:\s*`<button[^`]*disabled[^`]*>删除上线单<\/button>`/.test(body),
        '未见"契约成立→可点按钮 / 不成立→disabled 置灰按钮"的三元分支（红：改成隐藏按钮=制造不可解释的受困态）');
});
check('活体变异对照组：把置灰分支改成隐藏（disabled 按钮 → 空串）——上方断言须判红', () => {
    // ⚠️ 锚点必须是**单行内**片段：本 HTML 是 CRLF 行尾，跨行锚点写 '…\n…' 匹配不上真实的 '\r\n'
    //   （会静默变成"变异没发生"⇒ 对照组假绿）。上方两条既有对照组用的也都是单行片段，同此纪律。
    const mutated = src.replace(
        ': `<button class="u-btn-danger u-btn-sm" disabled title="${esc(dirtyDeleteTip)}">删除上线单</button>`;',
        ": '';"
    );
    assert.notStrictEqual(mutated, src, '变异替换未命中原文——置灰分支写法已漂移，需同步本条变异对照组');
    const mutatedBody = stripComments(extractFunctionBody(mutated, 'siOpenBatchDetail') || '');
    assert.ok(!/foot \+= memberStateSound\s*\?[\s\S]{0,600}:\s*`<button[^`]*disabled[^`]*>删除上线单<\/button>`/.test(mutatedBody),
        '变异后三元正则仍能匹配——说明该正则对"置灰改隐藏"这类变异不敏感，守卫本身失效');
});

console.log('— §⑰（2026-08-27）预计完成时间的超期口径：完成后冻结，未完成才实时催 —');
// 沙箱真执行 siRemainingDaysHtml——文本扫描证不了"算得对不对"，这里直接跑真实现喂真数据。
//   注入 siDateOnly + SI_ABANDONED_STATUSES + 函数本体（不手抄第二份判据，同既有纪律）。
(function assertRemainingDays() {
    function grabFn(name) {
        const i = src.indexOf('function ' + name + '(');
        if (i < 0) return null;
        let d = 0, j = src.indexOf('{', i);
        const s = j;
        for (; j < src.length; j++) {
            if (src[j] === '{') d++;
            else if (src[j] === '}') { d--; if (d === 0) return src.slice(i, j + 1); }
        }
        return null;
    }
    const fnDateOnly = grabFn('siDateOnly');
    const fnRemaining = grabFn('siRemainingDaysHtml');
    const abandoned = (src.match(/const SI_ABANDONED_STATUSES = \[[^\]]*\];/) || [''])[0];
    check('[⑰前置] siDateOnly / siRemainingDaysHtml / SI_ABANDONED_STATUSES 均提取成功（提不到=本组空转）', () => {
        assert.ok(fnDateOnly, '未提取到 siDateOnly');
        assert.ok(fnRemaining, '未提取到 siRemainingDaysHtml');
        assert.ok(abandoned, '未提取到 SI_ABANDONED_STATUSES');
    });
    if (!fnDateOnly || !fnRemaining || !abandoned) return;
    // eslint-disable-next-line no-new-func
    const f = new Function(`${abandoned}\n${fnDateOnly}\n${fnRemaining}\nreturn siRemainingDaysHtml;`)();
    const strip = (h) => String(h).replace(/<[^>]*>/g, '').trim();

    check('⑰ ⭐生产 #89 真实形态（回退链路：无 last_completed_at ⇒ 锚回退验收日）：预计 2026-08-26 17:10、验收 2026-08-27 13:36 → 「实际超期 1 天完成」（**不随今天变化**）', () => {
        const got = strip(f({ status: '已上线', dev_estimated_at: '2026-08-26 17:10:00', accepted_at: '2026-08-27 13:36:13' }));
        assert.strictEqual(got, '（实际超期 1 天完成）', `实得「${got}」`);
    });
    // ⭐ [口径二改·2026-08-27 用户拍板（#81 实证）] 冻结锚由验收日改为**实际完成**（last_completed_at·
    //   最后一次进待验证），验收对比预计会把「提交→验收」的等待算到开发头上；判据仍=accepted_at 有值
    //   （只看 last_completed_at 会在打回返工窗口误冻在上次提交时刻）。
    check('⑰ ⭐⭐生产 #81 真实形态（本次口径二改的靶心）：预计 08-26 17:00、实际完成 08-26 15:47、验收 08-27 09:35 → 「按期完成」（原验收锚显示「实际超期 1 天完成」=把验收等待冤枉到开发头上）', () => {
        const got = strip(f({ status: '待上线', dev_estimated_at: '2026-08-26 17:00:00', accepted_at: '2026-08-27 09:35:19', last_completed_at: '2026-08-26 15:47:24' }));
        assert.strictEqual(got, '（按期完成）', `实得「${got}」`);
    });
    check('⑰ 实际完成真超期时按实际完成算（不因验收更晚而多算）：预计 08-20、实际完成 08-22、验收 08-27 → 「实际超期 2 天完成」（验收锚会算 7 天）', () => {
        const got = strip(f({ status: '已关闭', dev_estimated_at: '2026-08-20 09:00:00', accepted_at: '2026-08-27 10:00:00', last_completed_at: '2026-08-22 11:00:00' }));
        assert.strictEqual(got, '（实际超期 2 天完成）', `实得「${got}」`);
    });
    check('⑰ 判据仍是 accepted_at：last_completed_at 有值但未验收（待验证中/可能被打回）→ 仍走实时分支（防"提交即冻结"——打回返工窗口会误冻在上次提交时刻）', () => {
        const got = strip(f({ status: '待验证', dev_estimated_at: '2026-01-01 12:00:00', accepted_at: null, last_completed_at: '2026-01-01 10:00:00' }));
        assert.ok(/个自然日/.test(got), `实得「${got}」——未验收单应保持实时算，不因已提交而冻结`);
    });
    check('⑰ 回退链·last_completed_at 非法（2026-02-31 会被 Date 进位）→ 锚回退验收日而非算错值', () => {
        const got = strip(f({ status: '已关闭', dev_estimated_at: '2026-08-20 09:00:00', accepted_at: '2026-08-21 10:00:00', last_completed_at: '2026-02-31 08:00:00' }));
        assert.strictEqual(got, '（实际超期 1 天完成）', `实得「${got}」——非法实际完成时刻应回退验收日锚`);
    });
    check('⑰ 冻结性证明：同一张单，把"今天"往后推不影响结果（冻结分支只用 accepted_at/last_completed_at 与 dev_estimated_at，不读当前时间）', () => {
        // 直接证"不读 now"：函数体内 new Date() 只出现在未验收分支。已验收分支若误用 now，本条无法
        //   通过纯输入构造出差异——故改用源码结构断言 + 上方数值断言双证。
        const body = fnRemaining;
        const frozenBranch = body.slice(body.indexOf('const accepted = siDateOnly'), body.indexOf('// 未验收'));
        assert.ok(frozenBranch.length > 0, '未定位到冻结分支');
        assert.ok(!/new Date\(\)/.test(frozenBranch), '冻结分支内出现 new Date()——说明仍在读当前时间，"冻结"名不副实');
        assert.ok(/target - done/.test(frozenBranch), '冻结分支应以 (target - done) 计差，即预计日与实际完成日（回退验收日）之差');
        assert.ok(/siDateOnly\(iss\.last_completed_at\)\s*\|\|\s*accepted/.test(frozenBranch), '冻结锚应为 siDateOnly(iss.last_completed_at) || accepted（实际完成优先·空/非法回退验收）——缺失说明口径二改被回退');
    });
    check('⑰ 按期完成（回退链）：无 last_completed_at 时预计日 === 验收日 → 「按期完成」', () => {
        const got = strip(f({ status: '已关闭', dev_estimated_at: '2026-08-20 09:00:00', accepted_at: '2026-08-20 23:59:00' }));
        assert.strictEqual(got, '（按期完成）', `实得「${got}」——同日应判按期（只比日历日，时分秒不参与）`);
    });
    check('⑰ 提前完成（回退链）：无 last_completed_at 时验收日早于预计日 → 「提前 N 天完成」', () => {
        const got = strip(f({ status: '已关闭', dev_estimated_at: '2026-08-25 09:00:00', accepted_at: '2026-08-22 10:00:00' }));
        assert.strictEqual(got, '（提前 3 天完成）', `实得「${got}」`);
    });
    check('⑰ ⭐待上线单已冻结不随天数涨（回退链走验收日锚；生产 14 张全部已 accepted 却卡在上线排期——不得把上线排期算作开发超期）', () => {
        const got = strip(f({ status: '待上线', dev_estimated_at: '2026-08-20 18:00:00', accepted_at: '2026-08-21 10:00:00' }));
        assert.strictEqual(got, '（实际超期 1 天完成）', `实得「${got}」——待上线应走冻结分支，不随天数递增`);
    });
    check('⑰ 未验收仍实时催：accepted_at 为空 → 走原实时分支（措辞保持「个自然日」，与冻结分支的「天」区分）', () => {
        const future = new Date(Date.now() + 3 * 86400000);
        const y = future.getFullYear(), m = String(future.getMonth() + 1).padStart(2, '0'), d = String(future.getDate()).padStart(2, '0');
        const got = strip(f({ status: '开发中', dev_estimated_at: `${y}-${m}-${d} 12:00:00`, accepted_at: null }));
        assert.ok(/距预计完成还有 3 个自然日/.test(got), `实得「${got}」——未验收单应保持实时算`);
    });
    check('⑰ 放弃态不显示：已作废 / 已拒绝 即便有预计时间与验收时间也返回空串', () => {
        for (const st of ['已作废', '已拒绝']) {
            const got = strip(f({ status: st, dev_estimated_at: '2026-08-20 09:00:00', accepted_at: '2026-08-25 10:00:00' }));
            assert.strictEqual(got, '', `${st} 应不显示超期，实得「${got}」——放弃不是完成`);
        }
    });
    check('⑰ 无预计时间 → 空串（不因有 accepted_at 就凭空造一个超期结论）', () => {
        assert.strictEqual(strip(f({ status: '已关闭', dev_estimated_at: null, accepted_at: '2026-08-25 10:00:00' })), '');
    });
    check('⑰ 反向对照组：把 accepted_at 抹掉，同一张已完成单会退回实时分支并随天数递增（证冻结分支真的由 accepted_at 驱动，非恒走某一支）', () => {
        const withAcc = strip(f({ status: '已关闭', dev_estimated_at: '2026-01-01 09:00:00', accepted_at: '2026-01-05 10:00:00' }));
        const noAcc = strip(f({ status: '已关闭', dev_estimated_at: '2026-01-01 09:00:00', accepted_at: null }));
        assert.strictEqual(withAcc, '（实际超期 4 天完成）', `有 accepted_at 应冻结为 4 天，实得「${withAcc}」`);
        assert.ok(/个自然日/.test(noAcc) && noAcc !== withAcc,
            `无 accepted_at 应走实时分支且与冻结值不同（实得「${noAcc}」）——两支输出相同说明分流没生效`);
    });
    check('⑰ [codex 480 MED-1] 非法日期不显示：2026-13-01 / 2026-02-31 这类会被 new Date 自动进位的输入必须判 null 而非算出错值', () => {
        // new Date(2026,12,1) → 2027-01-01；new Date(2026,1,31) → 2026-03-03。不做 round-trip 校验
        //   就不会报错，只会安静地算出一个错误天数——比 NaN 更难发现。
        for (const bad of ['2026-13-01 09:00:00', '2026-02-31 09:00:00', '2026-00-10 09:00:00', '2026-04-31 09:00:00']) {
            // 预计日非法 ⇒ 整条提示不渲染（没有基准日，任何结论都是编的）
            assert.strictEqual(strip(f({ status: '已关闭', dev_estimated_at: bad, accepted_at: '2026-05-01 10:00:00' })), '',
                `非法预计日 ${bad} 应不渲染（实际会被 Date 进位成另一个合法日期，算出错误天数）`);
            // 验收日非法 ⇒ 视同"未验收"，**保守降级走实时分支**（宁可继续催办，也不冻结在错值上）。
            //   这里断言"不含冻结分支措辞"而非"等于空串"——空串会把这条降级路径也判红，那是断言写错。
            const got = strip(f({ status: '已关闭', dev_estimated_at: '2026-05-01 09:00:00', accepted_at: bad }));
            assert.ok(!/完成）$/.test(got) && !/实际超期|按期完成|提前 \d+ 天/.test(got),
                `非法验收日 ${bad} 不得据此算出冻结值（实得「${got}」）——应视同未验收，走实时分支`);
            assert.ok(/个自然日|预计今天完成/.test(got),
                `非法验收日 ${bad} 应保守降级为实时提示（实得「${got}」）`);
        }
    });
    check('⑰ 合法边界日仍正常：闰年 2/29、月末 31 日不得被误判为非法', () => {
        assert.strictEqual(strip(f({ status: '已关闭', dev_estimated_at: '2028-02-29 09:00:00', accepted_at: '2028-02-29 18:00:00' })), '（按期完成）');
        assert.strictEqual(strip(f({ status: '已关闭', dev_estimated_at: '2026-01-31 09:00:00', accepted_at: '2026-01-31 18:00:00' })), '（按期完成）');
    });
    check('⑰ [codex 480 LOW-1] 调用点守卫加严：**任何**传日期串的调用形态都判红（不只精确匹配 iss.dev_estimated_at）', () => {
        assert.ok(/siRemainingDaysHtml\(iss\)/.test(src), '未见 siRemainingDaysHtml(iss) 调用');
        // 原断言只禁 `siRemainingDaysHtml(iss.dev_estimated_at)` 这一个字面形态，
        //   `siRemainingDaysHtml(row.dev_estimated_at)` / `(item.dev_estimated_at)` / 传一个日期串变量
        //   都能绕过 ⇒ 冻结分支静默失效而守卫全绿。改为枚举所有调用实参逐个判定。
        const calls = [...src.matchAll(/siRemainingDaysHtml\(([^)]*)\)/g)]
            .map(m => m[1].trim())
            .filter(a => a !== '' && a !== 'iss');   // 函数定义处的形参名与正确调用均放行
        for (const arg of calls) {
            assert.ok(!/dev_estimated_at/.test(arg),
                `siRemainingDaysHtml 的调用实参「${arg}」含 dev_estimated_at——传日期串会让 status/accepted_at 取不到，冻结分支永不命中（层内全绿但功能不可用的典型）`);
        }
    });
})();

console.log('— §⑱（2026-08-27）「我的上线单」iOS 红色角标 —');
check('入口按钮改角标形态：保留「我的上线单」文字 + data-si-exec-badge 红色圆形数字（不再是括号文字计数）', () => {
    const body = stripComments(extractFunctionBody(src, 'siProbeMyReleasesEntry') || '');
    assert.ok(body, '未提取到 siProbeMyReleasesEntry 函数体');
    assert.ok(!/待执行）/.test(body), '仍存在「N 待执行）」括号文字计数——已被 iOS 角标取代，两种形态并存会双重显示');
    assert.ok(/data-si-exec-badge/.test(body), '未见 data-si-exec-badge 角标节点（该属性同时是探针的定位锚，删除会让活体断言失去选择器）');
    assert.ok(/background:#dc2626/.test(body), '角标应为红底 #dc2626（与逾期徽章同红——都是"欠着的事"语义）');
    assert.ok(/btn\.style\.position = 'relative'/.test(body), '按钮须设 position:relative 作角标定位锚——漏了角标会相对页面定位飞走');
    // 计数同源：角标数字必须来自 siMyReleasesEntryData.pending（l7-executor-badge [7] 钉住的那套口径），
    //   不得另算——否则角标说 3 点进去 2，比没有角标更伤信任。
    assert.ok(/const pendingN = siMyReleasesEntryData\.pending/.test(body), '角标计数应直读 siMyReleasesEntryData.pending（与 l7 [7] 口径同源），不得另算一份');
    assert.ok(/pendingN > 99 \? '99\+' : pendingN/.test(body), '>99 应显示 99+（iOS 惯例，防三位数撑破圆形）');
    assert.ok(/pendingN > 0\s*\?/.test(body) && /:\s*''/.test(body), 'pending=0 时不渲染角标（空串分支）——0 也挂角标是噪音');
});

console.log('— §建单人展示（codex 487 LOW·2026-08-28 用户拍板）—');
// created_by/created_by_name 建表起 NOT NULL 落库、两端点一直下发，前端 2026-08-28 起消费。
// 窄断言（按 487 建议不绑整段 HTML/文案顺序）：只钉「展示存在 + 走 esc 转义 + 时间条件化经 siFmtDT」
// 三个不变量，防止重构 siRenderBatchList / 详情 kv 时静默回归；具体措辞与位置留自由度。
check('列表卡片 meta 含建单人且经 esc 转义（siRenderBatchList）', () => {
    const body = stripComments(extractFunctionBody(src, 'siRenderBatchList') || '');
    assert.ok(body, '未提取到 siRenderBatchList 函数体');
    assert.ok(body.includes('建单人'), '列表渲染未见「建单人」文案——展示点被删即回归（2026-08-28 用户拍板）');
    assert.ok(/esc\(b\.created_by_name/.test(body), '列表 created_by_name 未经 esc() 包裹（XSS 纵深防线，不因来源是服务端落库而豁免）');
});
check('详情 kv 含建单人行：姓名经 esc + 建单时间条件化经 siFmtDT（siOpenBatchDetail）', () => {
    const body = stripComments(extractFunctionBody(src, 'siOpenBatchDetail') || '');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    assert.ok(/<label>建单人<\/label>/.test(body), '详情 kv 网格未见「建单人」行');
    assert.ok(/esc\(rel\.created_by_name/.test(body), '详情 created_by_name 未经 esc() 包裹');
    assert.ok(/rel\.created_at\s*\?[^:]*esc\(siFmtDT\(rel\.created_at\)\)/.test(body),
        '建单时间应条件化渲染（rel.created_at 有值才显示）且经 siFmtDT 格式化 + esc 转义——三件缺一即回归');
});

console.log('— §上线单标识对齐（codex 488 LOW-2·2026-08-28 用户报障「#16 无处可寻」）—');
check('迭代单详情四处上线单标识=release_no 主显+#id 回退（防退回内部主键）', () => {
    // 2026-08-28 拍板：用户可见面的上线单标识统一 release_no（R-YYYYMMDD-N·上线单管理唯一认这个），
    //   内部主键 #id 仅作回退（release_no NULL=批次记录已不存在的唯一残余标识）。窄断言只钉表达式
    //   形状与处数：kv「所属上线单」（链接/纯文本两分支各一）+ 应急上线闸提示 + 待上线闸提示恰 4 处；「批次已失效」异常提示
    //   刻意保留 #id（不在计数内）。后端同款口径一处（应急口 409 文案·index.js）不在本守卫扫描面，
    //   由 API 套件与审查覆盖。
    const hits = (stripComments(src).match(/esc\(iss\.release_no \|\| \('#' \+ iss\.release_id\)\)/g) || []).length;
    assert.strictEqual(hits, 4, `「release_no 主显+#id 回退」表达式应恰 4 处（kv 行链接/纯文本两分支 + 应急闸 + 待上线闸），实得 ${hits}——少了=有展示点退回 #id，多了=新增展示点未登记本守卫`);
    // 回退分支不可被"简化"掉：主显表达式里必须保留 '#' + iss.release_id 兜底（release_no NULL 时
    //   不能渲染成空白——上面恰-3 断言已隐含，此处单独留言明确失败语义）。
});

console.log('— §⑯（C3·上线逾期留痕 方案 20260910 v1.2 §5.1.6/§5.1.4）前端不变量 —');
check('release_overdue_reason 三表正向登记（同 release_info_edit/release_deleted/dev_withdraw 同族先例：SI_TL_CLS 无独立守卫，摘掉词条会静默降级灰徽章；Set 双向相等断言只证两处一致不证含本码）', () => {
    const labelBody = stripComments(extractConstObjectText('SI_TL_LABEL') || '');
    const clsBody = stripComments(extractConstObjectText('SI_TL_CLS') || '');
    assert.ok(labelBody && /release_overdue_reason:\s*'上线逾期'/.test(labelBody), 'SI_TL_LABEL 应含 release_overdue_reason 词条');
    assert.ok(clsBody && /release_overdue_reason:\s*'si-tl-red'/.test(clsBody), 'SI_TL_CLS 应含 release_overdue_reason 词条（缺失=运行时静默降级 si-tl-gray）');
    assert.ok(/SI_TL_NOTE_OWN_LABEL_CODES\s*=\s*new Set\(\[[\s\S]*?'release_overdue_reason'/.test(src), 'SI_TL_NOTE_OWN_LABEL_CODES 应含 release_overdue_reason（缺失=落回通用「备注」徽章）');
});
check('D9/D2：release_overdue_reason 不注册进 SI_TL_RELEASE_SCOPE_LABEL/_CLS（否则会被「隐藏上线单调整记录」过滤器连带隐藏，与 D2「豁免的是输入闸不是事实」冲突——C0 ⑤-a 实证）', () => {
    const labelM = stripComments(src).match(/const SI_TL_RELEASE_SCOPE_LABEL = \{[\s\S]*?\n {4}\};/);
    const clsM = stripComments(src).match(/const SI_TL_RELEASE_SCOPE_CLS = \{[\s\S]*?\n {4}\};/);
    assert.ok(labelM, '未定位到 SI_TL_RELEASE_SCOPE_LABEL 对象字面量');
    assert.ok(clsM, '未定位到 SI_TL_RELEASE_SCOPE_CLS 对象字面量');
    assert.ok(!labelM[0].includes('release_overdue_reason'), 'release_overdue_reason 不应出现在 SI_TL_RELEASE_SCOPE_LABEL 内（违反 D9/D2，会被隐藏过滤器连带隐藏）');
    assert.ok(!clsM[0].includes('release_overdue_reason'), 'release_overdue_reason 不应出现在 SI_TL_RELEASE_SCOPE_CLS 内（同上）');
});
check('前端 SI_RELEASE_OVERDUE_REASON_CODES 字面量与后端 _internals.RELEASE_OVERDUE_REASON_CODES 真值逐字相等（写读同源对拍——守卫与被测方都手写字面量会一起过期，须 require 真相源，guard_static_analysis_gotchas 沉淀）', () => {
    const m = /const SI_RELEASE_OVERDUE_REASON_CODES = (\[[^\]]*\]);/.exec(src);
    assert.ok(m, '未定位到前端 SI_RELEASE_OVERDUE_REASON_CODES 字面量数组');
    // eslint-disable-next-line no-eval
    const frontendCodes = eval(m[1]);
    const noop = () => {};
    // [C3b·Opus 预筛 L-8 收口] memDb 只在本 check 内临时用来满足工厂期 deps 校验（不真的建表/写入），
    // 但泄漏一个打开的 sqlite3 句柄仍是资源泄漏——包 try/finally 确保断言失败（assert 抛异常）时
    // memDb 依然被关闭，不依赖"走到最后一行才 close"这种顺序假设。
    const memDb = new sqlite3.Database(':memory:');
    try {
        const asyncNoop = async () => null;
        const backendMod = require('../routes/sys-iteration')({
            logger: { info: noop, warn: noop, error: noop, debug: noop },
            db: memDb, dbRunAsync: asyncNoop, dbGetAsync: asyncNoop, dbAllAsync: async () => [],
            authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
            ...require('./_sys-attach-test-deps'),
            readSystemConfig: asyncNoop, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: asyncNoop, maskPhone: (s) => s,
        });
        const backendCodes = backendMod._internals.RELEASE_OVERDUE_REASON_CODES;
        assert.ok(Array.isArray(backendCodes) && backendCodes.length > 0, '后端 _internals.RELEASE_OVERDUE_REASON_CODES 未导出或为空——两侧对拍失去意义');
        assert.deepStrictEqual(frontendCodes, backendCodes, `前端 SI_RELEASE_OVERDUE_REASON_CODES 与后端 RELEASE_OVERDUE_REASON_CODES 不相等（任一侧改了值/顺序/新增删除项未同步另一侧）：前端=${JSON.stringify(frontendCodes)} 后端=${JSON.stringify(backendCodes)}`);
    } finally {
        memDb.close();
    }
});
check('前端 SI_RELEASE_DATE_CHANGE_REASON_MAX 字面量与后端 _internals.RELEASE_DATE_CHANGE_REASON_MAX 真值相等（同 SI_RELEASE_OVERDUE_REASON_CODES 既有对拍写法，C4b·L4 收口）', () => {
    const m = /const SI_RELEASE_DATE_CHANGE_REASON_MAX = (\d+);/.exec(src);
    assert.ok(m, '未定位到前端 SI_RELEASE_DATE_CHANGE_REASON_MAX 字面量');
    const frontendMax = Number(m[1]);
    const noop = () => {};
    const memDb = new sqlite3.Database(':memory:');
    try {
        const asyncNoop = async () => null;
        const backendMod = require('../routes/sys-iteration')({
            logger: { info: noop, warn: noop, error: noop, debug: noop },
            db: memDb, dbRunAsync: asyncNoop, dbGetAsync: asyncNoop, dbAllAsync: async () => [],
            authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
            ...require('./_sys-attach-test-deps'),
            readSystemConfig: asyncNoop, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: asyncNoop, maskPhone: (s) => s,
        });
        const backendMax = backendMod._internals.RELEASE_DATE_CHANGE_REASON_MAX;
        assert.strictEqual(typeof backendMax, 'number', '后端 _internals.RELEASE_DATE_CHANGE_REASON_MAX 未导出或非数值——两侧对拍失去意义');
        assert.strictEqual(frontendMax, backendMax, `前端 SI_RELEASE_DATE_CHANGE_REASON_MAX(${frontendMax}) 与后端 RELEASE_DATE_CHANGE_REASON_MAX(${backendMax}) 不相等`);
    } finally {
        memDb.close();
    }
});
check('siReleaseExecuteModal 预判层：仅普通批次∧isLast∧前端判逾期才展开理由块（方案 §5.1.5，应急批次/非最后一人不展开）', () => {
    const body = stripComments(extractFunctionBody(src, 'siReleaseExecuteModal') || '');
    assert.ok(body, '未提取到 siReleaseExecuteModal 函数体');
    assert.ok(/siReleaseOverdueApplicable\(rel,\s*isLast\)/.test(body), '未见 siReleaseOverdueApplicable(rel, isLast) 调用——预判展开条件应复用该判据函数，不应另写一套内联条件');
    assert.ok(/fReleaseOverdueReasonBlock\('siExecOverdueBlock'/.test(body), '未见预判层理由块渲染（fReleaseOverdueReasonBlock 调用）');
});
check('siReleaseOverdueApplicable：应急批次（release_kind===\'emergency\'）恒返回 null（不展开理由块）', () => {
    assert.ok(/function siReleaseOverdueApplicable\(rel, isLast\) \{/.test(stripComments(src)), '未定位到 siReleaseOverdueApplicable 定义');
    const body = stripComments(extractFunctionBody(src, 'siReleaseOverdueApplicable') || '');
    assert.ok(/rel\.release_kind === 'emergency'/.test(body), '未见 release_kind===\'emergency\' 短路判据——应急批次不应参与逾期理由预判');
});

console.log('— §⑤ HTML 内联 <script> 语法有效 —');
// ═══ [时间线改动明细 方案 20260911 v1.2 §3.3] 修改类事件「查看改动」渲染：静态登记 + 直调行为 ═══
// [#67 A3/C2·2026-09-16] 可隐藏性双语义拆分的**核心语义锁**。本条断言的判别力方向：
//   · 有人把 release_date_change 加回白名单 → 差集变空 → 红（改期又会被过滤器藏掉，正是本次要修的病）
//   · 有人往 SCOPE_LABEL 表加新码却忘登记白名单 → 差集多一项 → 红（提醒他做显式决策）
//     ——这是**提醒而非阻止**：白名单的安全默认是「未登记即不可隐藏」，忘登记只多显示一行、不丢信息
//   · 白名单登记了不在 SCOPE 表里的码 → 越界项非空 → 红（那个码拿不到标签，登记它无意义）
// [#83·S2 续做·C2] SI_TL_HIDABLE_SCOPE_CODES（Set，8 码）已由 S2 升级为 SI_TL_HIDABLE_CODES
//   （Map<action_code,期望 event_type>，恰 11 项：原 8 个 scope_change 型逐字不变 + 新增 3 个附件
//   note 型）。提取范式同 SI_TL_CHANGE_CODES（A1③ 先例）：正则抓 `['code','type']` 对 + 完备性核对
//   （剔除已识别条目后只应剩逗号/空白，防新增**未被本正则识别**的条目形态——双引号/变量/展开——静默漏检）。
const parseHidableCodesMap = () => {
    const m = src.match(/const SI_TL_HIDABLE_CODES = new Map\(\[([\s\S]*?)\]\);/);
    assert.ok(m, '未提取到 SI_TL_HIDABLE_CODES Map');
    // [596B-L2] 先剥注释再对**同一份**文本做成员提取与 leftover 完备性核对——原写法成员提取跑在原始
    // 文本上、leftover 跑在剥注释后的文本上，若 Map 初始化列表内的注释含形如 ['x_code','note'] 的示例，
    // 会被原始 matchAll 误当成真实成员多算一条，而 leftover（剥注释后）看不到它、不会报残留，两处口径
    // 不一致导致假红/漏检两个方向都可能发生。统一改成都在 stripped 上跑。
    const stripped = stripComments(m[1]);
    const pairs = [...stripped.matchAll(/\[\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\]/g)].map((mm) => [mm[1], mm[2]]);
    const leftover = stripped.replace(/\[\s*'[a-z_]+'\s*,\s*'[a-z_]+'\s*\]/g, '').replace(/[\s,]/g, '');
    assert.strictEqual(leftover, '', `SI_TL_HIDABLE_CODES 初始化列表里有本断言**无法识别**的内容（残留「${leftover}」）——静态提取已不完备，下面的项数/成员比对会漏掉这些条目`);
    return pairs;
};
const ATTACHMENT_HIDABLE_CODES = ['attachment_added', 'attachment_replaced', 'attachment_removed'];
const RELEASE_HIDABLE_SCOPE_CODES = ['release_add', 'release_remove', 'release_schedule_cancel', 'release_published', 'release_executors_set', 'release_executor_notify', 'release_executor_done', 'release_hotfix_create'];
check('[A·#67/#83 A3] SI_TL_HIDABLE_CODES 恰 11 项 ∧ 8 个批次编排码=scope_change 逐字不变 ∧ 3 个附件码=note ∧ 批次编排码全在 SCOPE_LABEL 表内 ∧ 两者差集恰为 release_date_change', () => {
    const pairs = parseHidableCodesMap();
    assert.strictEqual(pairs.length, 11, `SI_TL_HIDABLE_CODES 应恰 11 项，实得 ${pairs.length}：${JSON.stringify(pairs)}`);
    const dup = pairs.map((p) => p[0]);
    assert.strictEqual(new Set(dup).size, dup.length, `11 项的 action_code 不应有重复，实得 ${dup.join(',')}`);
    const scopeEntries = pairs.filter((p) => p[1] === 'scope_change').map((p) => p[0]).sort();
    const noteEntries = pairs.filter((p) => p[1] === 'note').map((p) => p[0]).sort();
    const otherEntries = pairs.filter((p) => p[1] !== 'scope_change' && p[1] !== 'note');
    assert.deepStrictEqual(otherEntries, [], `不应出现 scope_change/note 之外的第三种登记类型，实得 ${JSON.stringify(otherEntries)}`);
    assert.deepStrictEqual(scopeEntries, [...RELEASE_HIDABLE_SCOPE_CODES].sort(),
        `8 个批次编排码应逐字不变（原 Set 8 码原样搬入 Map，各配 'scope_change'），实得 ${scopeEntries.join(',')}`);
    assert.deepStrictEqual(noteEntries, [...ATTACHMENT_HIDABLE_CODES].sort(),
        `3 个附件码应恰为 attachment_added/attachment_replaced/attachment_removed，各配 'note'，实得 ${noteEntries.join(',')}`);
    const mL = src.match(/const SI_TL_RELEASE_SCOPE_LABEL = \{([\s\S]*?)\};/);
    assert.ok(mL, '未提取到 SI_TL_RELEASE_SCOPE_LABEL');
    const lbl = [...new Set((mL[1].match(/([a-z_]+)\s*:/g) || []).map((s) => s.replace(/\s*:$/, '')))];
    const outOfTable = scopeEntries.filter((k) => !lbl.includes(k));
    assert.deepStrictEqual(outOfTable, [], `批次编排码成员必须都在 SCOPE_LABEL 表里（否则拿不到标签），越界：${outOfTable.join(',')}`);
    const diff = lbl.filter((k) => !scopeEntries.includes(k));
    assert.deepStrictEqual(diff, ['release_date_change'],
        `SCOPE 表减批次编排码应恰为 release_date_change —— 这是 #67 的核心语义（改期仍进表拿「上线单改期」标签，但不再可隐藏）。实得：${diff.join(',') || '（空）'}`);
    // 附件三码不应混进 SCOPE_LABEL 表（它们是 note 型，走独立徽章路径，不经此表）
    const attachInScopeLabel = ATTACHMENT_HIDABLE_CODES.filter((k) => lbl.includes(k));
    assert.deepStrictEqual(attachInScopeLabel, [], `附件码不应出现在 SCOPE_LABEL 表里（那是 scope_change 型标签表，附件三码是 note 型独立徽章），实得：${attachInScopeLabel.join(',')}`);
});
// [#67 A4/C2·576-M1 重写] 判据的**行为**断言，不只断源码长相。
// ⚠️ 为什么必须直调：原版只有两条源码正则（断"含 scope_change"与"含 has(...)"）——**把 && 改成 ||
//   两条正则照样匹配**，断言不红，而那时任意 scope_change 事件都会被隐藏。源码正则只能发现"删掉某段
//   文本"，证明不了"两个条件必须同时成立"。故改为提取真实判据直调，逐码逐类型跑行为。
// ⚠️ [576-L1 订正] 原注释说"删左半边会让 release_info_edit 等 note 码意外可隐藏"——**那是错的**：
//   那些码不在白名单里，删左半边后 has() 仍为 false、照样不隐藏。真实风险是
//   **白名单内的码以非登记类型出现时被误隐藏**（如 release_add 若某处以 note 写入，或附件码若某处以
//   scope_change 写入——[#83·S2 续做] Map 化后类型错配的风险面从"单一 scope_change"扩到"逐码各自登记
//   的期望类型"，下方行为断言据此扩为"配对类型 true / 换任意错配类型 false"）。
// [576-R·rec2] 提取逻辑抽共用 helper：两条断言各自对**函数体**与**集合**分别断言，
//   避免第二条在匹配失败时直接在 m[0] 处抛错（那是"报错不清晰"，虽不构成假绿）。
const grabHidablePredicate = () => {
    const mFn = src.match(/function siTlIsHidableScope\(e\) \{[\s\S]*?\n    \}/);
    assert.ok(mFn, '未提取到 siTlIsHidableScope 函数体（提取失效=本组空转，必须先红在这里）');
    const mMap = src.match(/const SI_TL_HIDABLE_CODES = new Map\(\[[\s\S]*?\]\);/);
    assert.ok(mMap, '未提取到 SI_TL_HIDABLE_CODES Map');
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${mMap[0]}\n${mFn[0]}\nreturn siTlIsHidableScope;`)();
    assert.strictEqual(typeof fn, 'function', '提取出的判据不是函数');
    // [596B-L2] 成员清单复用 parseHidableCodesMap()（内部已统一在 stripComments 后的文本上提取），
    // 不再让调用方各自对 mMap[0]（含注释的原始 Map 字面量）重新 matchAll——消除三套提取口径漂移。
    return { fn, pairs: parseHidableCodesMap() };
};
// 注：每码跑 1 个正类型 + 8 个反类型 = 共 9 种 event_type 取值（576-R 订正了我原先写的"8 种"）。
check('[A·#67 A4] siTlIsHidableScope 行为：8 个批次编排码 × scope_change 为 true，同码换其他 8 种类型一律 false', () => {
    const { fn, pairs } = grabHidablePredicate();
    const codes = pairs.filter((p) => p[1] === 'scope_change').map((p) => p[0]);
    assert.strictEqual(codes.length, 8, `批次编排码应恰 8 码，实得 ${codes.length}`);
    for (const c of codes) {
        assert.strictEqual(fn({ event_type: 'scope_change', action_code: c }), true, `${c} + scope_change 应可隐藏`);
        for (const t of ['note', 'release', 'status_change', 'created', undefined, null, '', 'scope_change '])
            assert.strictEqual(fn({ event_type: t, action_code: c }), false, `${c} + event_type=${JSON.stringify(t)} 不应可隐藏（&& 被改成 || 会在此红）`);
    }
});
// [#83·S2 续做·C2] 三码 note 型行为断言——同上一条镜像结构，只是白名单登记类型是 'note' 而非
//   'scope_change'：三码 + 'note' 应 true；同三码换其余 8 种类型（含真正的 'scope_change'——这正是
//   「类型错配」用例，验证 Map 化后不同码各自独立类型约束，不会被批次编排码的 scope_change 语义污染）
//   应一律 false。
check('[A·#83 C2] siTlIsHidableScope 行为：3 个附件码 × note 为 true，同码换其他 8 种类型（含 scope_change 类型错配）一律 false', () => {
    const { fn, pairs } = grabHidablePredicate();
    const codes = pairs.filter((p) => p[1] === 'note').map((p) => p[0]);
    assert.strictEqual(codes.length, 3, `附件码应恰 3 码，实得 ${codes.length}`);
    assert.deepStrictEqual([...codes].sort(), [...ATTACHMENT_HIDABLE_CODES].sort(), `附件码集合应恰为三码，实得 ${codes.join(',')}`);
    for (const c of codes) {
        assert.strictEqual(fn({ event_type: 'note', action_code: c }), true, `${c} + note 应可隐藏`);
        for (const t of ['scope_change', 'release', 'status_change', 'created', undefined, null, '', 'note '])
            assert.strictEqual(fn({ event_type: t, action_code: c }), false, `${c} + event_type=${JSON.stringify(t)} 不应可隐藏（类型错配应被挡）`);
    }
});
check('[A·#67/#83 A4] siTlIsHidableScope 行为：改期码 / 未知码 / 异常输入 / 逐人完成两码一律 false（未登记即不可隐藏的安全默认）', () => {
    const { fn } = grabHidablePredicate();
    // 改期码：本次改造的核心——它是 scope_change 型且在 SCOPE_LABEL 表里，但**不在白名单**
    assert.strictEqual(fn({ event_type: 'scope_change', action_code: 'release_date_change' }), false, '改期码不应可隐藏（#67 核心语义）');
    for (const e of [
        { event_type: 'scope_change', action_code: 'release_unknown_code' },
        { event_type: 'scope_change', action_code: undefined },
        { event_type: 'scope_change' },
        { event_type: 'scope_change', action_code: 123 },
        { event_type: 'scope_change', action_code: null },
        {}, null, undefined,
        // [#83·S2 续做·C2] M1 负向：未登记码 + 缺 event_type——has() 必须先短路 false，不能靠
        //   `undefined===undefined` 混进来（换判据结构=换边界行为，memory feedback_predicate_shape_change_edges）。
        { action_code: 'attachment_unregistered_code' },
        { event_type: undefined, action_code: 'totally_unknown_attachment_code' },
        // [#83·S2 续做·C2] 逐人完成两码（#72，note 型但未登记进 SI_TL_HIDABLE_CODES）——D3 决策：
        //   逐人完成不归可隐藏集合，即便与附件三码同为 note 型也不应可隐藏。
        { event_type: 'note', action_code: 'dev_submit_done' },
        { event_type: 'note', action_code: 'dev_no_code' },
    ]) assert.strictEqual(fn(e), false, `异常/未登记输入应 false：${JSON.stringify(e)}`);
});
// [#67 A4/C2] 三处消费点的分工锁：class 与初始 display 必须用 isHidableScope；hasReleaseScopeTl 必须调
//   同一纯函数（不得自行重算，否则出「勾了无反应的死开关」）；isReleaseScope 必须仍服务 key 计算。
check('[A·#67 A4] 消费点分工：class/display 用 isHidableScope ∧ hasReleaseScopeTl 调纯函数 ∧ isReleaseScope 仍参与 key 计算', () => {
    assert.ok(/class="si-tl-item\$\{isHidableScope \? ' si-tl-release-scope' : ''\}/.test(src),
        'class 拼接未改用 isHidableScope —— 改期行仍会带可隐藏 class 而被藏');
    assert.ok(/\$\{isHidableScope && siTlHideReleaseScope \? ' style="display:none"' : ''\}/.test(src),
        '初始 display 未改用 isHidableScope');
    assert.ok(/const hasReleaseScopeTl = tlEvents\.some\(siTlIsHidableScope\);/.test(src),
        'hasReleaseScopeTl 未改调纯函数（自行重算会与行 class 判据漂移 → 死开关）');
    assert.ok(/\(isReleaseScope \|\| isNoteWithOwnLabel\) \? e\.action_code : e\.event_type/.test(src),
        'isReleaseScope 已不参与 key 计算 —— 改期会掉回通用「范围变更」标签');
});
// [#67 A7/C2·#83 S2 续做] 过滤器文案与旧文案残留。旧文案曾出现在 UI 与三处注释里，改造时一并同步。
// [#83·S2] SI_TL_HIDABLE_CODES 扩容进附件三码后，开关同时管批次编排 + 附件增删两类，文案随之扩为
//   「隐藏批次编排与附件增删记录」——旧文案「隐藏批次编排记录」现算"过期文案"，一并纳入残留检查。
check('[A·#67/#83 A7] 过滤器文案为「隐藏批次编排与附件增删记录」∧ 全文无旧文案残留（含更早的「隐藏上线单调整记录」与本次已过期的「隐藏批次编排记录」）', () => {
    assert.ok(/> 隐藏批次编排与附件增删记录<\/label>/.test(src), '过滤器 UI 文案未改');
    assert.ok(!/隐藏上线单调整记录/.test(src), '仍有更早的旧文案残留（含注释）—— 改文案必同步注释里的引用，否则注释成假事实源');
    // 新文案「隐藏批次编排与附件增删记录」在"编排"与"记录"之间插了「与附件增删」，故旧文案「隐藏批次编排
    // 记录」不是新文案的子串，直接判残留即可，无需排除新文案本身误命中。
    assert.ok(!/隐藏批次编排记录/.test(src), '仍有本次改造前的旧文案「隐藏批次编排记录」残留（未跟附件增删一起扩写）');
});
// [#83·S2 续做·C2] 「未登记码天然不可隐藏」新措辞注释存在——S2 曾推翻「note 型天然不可隐藏」这条随
//   Map 化而失效的旧结论（附件三码同为 note 型却已登记进 SI_TL_HIDABLE_CODES 会被隐藏，反证旧结论不再
//   成立），把三处（release_info_edit/release_deleted 一带 + release_overdue_reason 一带）+ #72 分支
//   一带的措辞改成「未登记进 SI_TL_HIDABLE_CODES 天然不可隐藏」——本条锁住新措辞确实落地，且不止一处
//   （单处可能是笔误，需 ≥3 处才算"逐条改写"而非"改了一处凑数"）。
check('[A·#83 C2] 「未登记进 SI_TL_HIDABLE_CODES 天然不可隐藏」新措辞注释存在且不止一处', () => {
    const hits = (src.match(/未登记进 SI_TL_HIDABLE_CODES 天然不可隐藏/g) || []).length;
    assert.ok(hits >= 3, `新措辞注释应至少出现 3 处（S2 回执登记的三/四处订正位），实得 ${hits} 处`);
});
// [S2 修复批·MED-1] 负向半边——只查新词落地不查旧词清干净是单向的（与 A7 文案残留检查不对称）；
//   Opus 预筛拦下 :4494-4497 漏改的旧结论两句（「左半边限定 event_type === 'scope_change'」「双重保证不会
//   被藏」），本条锁死旧措辞不得残留，防未来再有同类"改了新地方、漏了历史沿革集中处"的盘点盲区。
//   [codex 595 L2] 本条是**精确短语的文案检查**，不穷尽同义改写后的语义变体（换个说法表达同一错误结论
//   仍可能漏检）——真正的语义机制保证靠上方 [A·#67 A4]（消费点分工）与 [A·#67 A1] 一带的行为断言，本条
//   只是防"错误结论的字面原句"死灰复燃。
check('[A·#83 C2·MED-1] 旧结论「上方函数的左半边限定 scope_change」「双重保证不会被藏」不得作为现行断言残留全文（S2 修复批已订正 :4494-4497；不含 :4301/:4324 那两处"原注释写「…」双重保证——已订正"的历史沿革引述，那两处是正确的订正说明，不是残留的错误结论）', () => {
    assert.ok(!/上方函数的左半边限定/.test(src), '仍有「上方函数的左半边限定」旧措辞残留（该判据已改为 has()+get() 逐码配对，不再有"函数左半边"这种结构）');
    assert.ok(!/双重保证不会被藏/.test(src), '仍有「双重保证不会被藏」旧结论字面残留（Map 化后 note 型不再天然免于可隐藏，唯一保证是未登记本身）');
});
// [#83·S2 续做·C2·K1·C0 报告 §3(a)/(c)] K1 静态：persist 内附件三码的 payload 构造（两条字面量 INSERT
//   共用同一个 `payload` 对象 + 删除端点的 `removePayload`）不得出现 `attachment_ids` 键——那是既有
//   accept/return 两步链凭证专用键名（verify-sys-accept-evidence.js deepStrictEqual 锁死），前端
//   `siRenderTimeline` :4917 一带唯一无条件读该键渲染成 📎 凭证行；附件三码若意外带上这个键，会被那条
//   通用分支误渲染成"两步链凭证"，与三码自己的专属展开区（si-tl-attach-list）产生双重/矛盾展示。
//   切片终点用**结构锚**（花括号平衡的对象字面量本身自然收尾，`};`），不用行号——防止 index.js 增删行
//   后行号漂移导致断言悄悄失效（memory 坑 27：正则限定作用域切片终点须用结构锚）。
// [codex 595 M3] ⚠️ 本条只是**前置静态检查**——它只能证明"写代码时刻的字面量初始化"不含该键，不能保证
//   INSERT 前没有人在初始化之后又给根对象追加 `payload.attachment_ids = ...`（对象展开同理）。最终保证
//   是 verify-sys-attachment-trace.js 里读**实际落库 payload_json**做的行为断言：
//   - added 路径 `[B1] delivery 上传：action_code/summary/payload 完整快照/ref_id 四件套核对通过`
//     （:325 一带，`assert.deepStrictEqual(payload, {...})` 完整快照深比较——缺 attachment_ids 键即通过）
//   - replaced 路径 `[B3/K1] replaced 根对象无 attachment_ids`（:561）
//   - removed 路径 `[删除/K1] 根对象无 attachment_ids`（:1852）
//   本条静态检查的价值是"结构锚失效时先在这里红"（省去到行为层排查的成本），不是唯一防线。
// [K1 专用] 本文件既有 extractFunctionBody(src|mutated|indexJsSrc, 'name') 的调用会被 :406 一带
//   EXTRACT_FN_BODY_TARGET_NAMES 自动收编进 [S5 甲2] acorn 交叉验证集合——那条检查固定只对
//   Sys_Iteration.html 的 <script> 块跑 acorn 解析，目标若是 index.js 里的函数（如本处
//   sysPersistAttachments）必然"AST 中找不到"而误判空转。K1 要定位的是 index.js 内部函数，
//   与那条元检查的验证域不同源，故不复用同名 extractFunctionBody（会被字面量正则强行拉进验证集合），
//   另写一个逻辑相同、命名不同的本地花括号平衡提取函数，专供 K1 使用。
function extractFnBodyLocal(source, fnName) {
    const startRe = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`);
    const m = startRe.exec(source);
    if (!m) return null;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(start, i + 1); }
    }
    return null;
}
check('[A·#83 C2·K1] persist 附件 payload 构造（两条字面量 INSERT 共用）与删除端点 removePayload 构造均不含 attachment_ids 键', () => {
    const indexJsSrc = fs.readFileSync(require('path').resolve(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    // [自测踩坑修正] `const payload = {` 在 index.js 里**并非唯一**（全仓另有 3 处同名局部变量声明，
    //   与 persist 无关）——裸 `indexJsSrc.match(...)` 只取全文件第一个匹配，曾悄悄抓到一处不相关的
    //   声明（约 :10282，配置类 payload），本条检查因此对真正的目标全程空转、从未真正扫描过附件 payload。
    //   改为**先用结构锚定位到 sysPersistAttachments 函数体**（花括号平衡，见上方 extractFnBodyLocal），
    //   再在该函数体内找 `const payload = {`，确保定位到的就是附件三码这一处。
    const persistFnBody = extractFnBodyLocal(indexJsSrc, 'sysPersistAttachments');
    assert.ok(persistFnBody, '未提取到 sysPersistAttachments 函数体（结构锚失效=本条空转，须先红在这里）');
    const persistPayload = persistFnBody.match(/const payload = \{[\s\S]*?\};/);
    assert.ok(persistPayload, '未在 sysPersistAttachments 函数体内提取到 `const payload = {...};`（结构锚失效=本条空转，须先红在这里）');
    assert.ok(!/attachment_ids/.test(persistPayload[0]), `persist payload 构造不得出现 attachment_ids 键，实得：${persistPayload[0]}`);
    // [codex 595 M3] removePayload 的匹配须限定到删除端点自己的 handler 作用域内，不能对全文件裸
    //   `match`（若未来别处新增同名局部变量 `removePayload`，裸正则会取"全文件第一个匹配"，可能命中
    //   不相关声明而误判——同上方 persistPayload 已踩过的"裸正则取错声明"坑，:2073 一带自测踩坑修正）。
    //   结构锚：先定位 `router.delete('/sys-issues/:id/attachments/:attId', ...)` 路由注册行，从其
    //   handler 的 `=> {` 起花括号平衡切片到 handler 结尾，只在该切片内找 removePayload。
    const delRouteRe = /router\.delete\('\/sys-issues\/:id\/attachments\/:attId'[\s\S]*?=>\s*\{/;
    const delRouteM = delRouteRe.exec(indexJsSrc);
    assert.ok(delRouteM, '未定位到附件删除端点 router.delete(\'/sys-issues/:id/attachments/:attId\'...) 注册行（结构锚失效=本条空转，须先红在这里）');
    let depth = 0;
    let i = delRouteM.index + delRouteM[0].length - 1;
    const delHandlerStart = i;
    for (; i < indexJsSrc.length; i++) {
        if (indexJsSrc[i] === '{') depth++;
        else if (indexJsSrc[i] === '}') { depth--; if (depth === 0) break; }
    }
    assert.ok(depth === 0 && i < indexJsSrc.length, '删除端点 handler 花括号未能配平（结构锚失效=本条空转，须先红在这里）');
    const delHandlerBody = indexJsSrc.slice(delHandlerStart, i + 1);
    const removePayload = delHandlerBody.match(/const removePayload = \{[\s\S]*?\};/);
    assert.ok(removePayload, '未在删除端点 handler 作用域内提取到 `const removePayload = {...};`（结构锚失效=本条空转，须先红在这里）');
    assert.ok(!/attachment_ids/.test(removePayload[0]), `removePayload 构造不得出现 attachment_ids 键，实得：${removePayload[0]}`);
    // 双保险：两条字面量 INSERT 语句本身（含 JSON.stringify(payload) 绑定表达式）也不应出现该键名——
    //   防止未来有人绕过 `payload` 变量、直接在 INSERT 语句里内联拼一个新对象。用**精确字面量正则**
    //   （完整列清单 + 完整占位符 + 完整绑定数组，逐字匹配已知的两条真实语句形态）代替"从 INSERT 关键字
    //   扫到下一个 JSON.stringify(payload)"这种跨语句漂移的宽口径扫描——踩坑记录：后者曾意外跨过中间
    //   一条不相关的 completion_overrun_reason INSERT，一路扫到几百行外才收口，把大段无关代码当成"本
    //   条语句"喂给 attachment_ids 检查，导致假红。
    for (const code of ['attachment_added', 'attachment_replaced']) {
        const stmtRe = new RegExp(
            `INSERT INTO sys_issue_timeline \\(issue_id, event_type, summary, action_code, ref_id, round_no, operator_id, operator_name, payload_json\\)\\s*` +
            `VALUES \\(\\?, 'note', \\?, '${code}', \\?, \\?, \\?, \\?, \\?\\)\`,\\s*` +
            `\\[issueId, summary, refId, roundNo, uploader\\.id, uploader\\.name, JSON\\.stringify\\(payload\\)\\]`
        );
        const m = indexJsSrc.match(stmtRe);
        assert.ok(m, `未精确匹配到 '${code}' 的字面量 INSERT 语句（列清单/占位符/绑定数组任一处改动会致本条空转，需同步更新此正则）`);
        assert.ok(!/attachment_ids/.test(m[0]), `'${code}' 的 INSERT 语句本身不得出现 attachment_ids 字样，实得：${m[0]}`);
    }
});
// [S2 修复批·MED-2·Opus 预筛拦截] attachment_type 枚举现有 4 份物理副本（后端 SYS_ATTACH_TYPES 数组 +
//   后端 SYS_ATTACH_TYPE_WORD 键集 + 前端 SI_TL_ATTACH_TYPE_WORD 键集 + 前端 attachTypeOk 判据集合），
//   此前无一条对拍断言——后端若新增第 4 种类型，前端 attachTypeOk 判 false ⇒ arrValid=false ⇒ 整条附件
//   行静默回退 esc(summary)，展开区（#83 要留的"审计原文"）无声消失，没有任何守卫会红。
//   同批已把前端 attachTypeOk 从硬编码字面量集合改成读 SI_TL_ATTACH_TYPE_WORD 的 key 集（见
//   siRenderAttachListHtml 内注释），压掉前端的第二份副本；本条断言锁剩下三方（后端数组 + 后端键集 +
//   前端键集）互相一致，仿既有 SI_RELEASE_DATE_CHANGE_REASON_MAX 前后端对拍写法（读源码正则提取真值，
//   而非另写一份硬编码期望值，防"改了真值、断言里的硬编码期望值没跟着改"这种自我复读式假通过）。
// [codex 595 L1] 三方对拍原实现的成员正则只认单引号字面量（'([a-z_]+)'/([a-z_]+)\s*:），若后端数组新增
//   双引号成员（"archive"）或后端/前端对象新增计算属性键（['archive']），两种正则都会**静默漏计**，仍与
//   未改动的另一侧三项相等——守卫显示一致，前端却拒绝新增类型。改为：逐成员用可识别 4 种写法（单引号/
//   双引号/单引号计算属性/双引号计算属性）的组合正则匹配"键:值"整体（值固定是单引号中文字符串——数组
//   成员本身即"值"，无需再匹配冒号），再对剥注释后的原文做**完备性检查**（leftover——同 SI_TL_HIDABLE_CODES
//   /SI_TL_CHANGE_CODES 既有 leftover 先例）：正则命中部分与逗号/空白之外还剩非空内容即判红，防止"两种
//   成员正则都漏掉同一处新增"这种同源盲区。
function extractQuotedArrayMembers(listText, label) {
    const stripped = stripComments(listText);
    const re = /'([a-z_]+)'|"([a-z_]+)"/g;
    const items = [];
    let m;
    while ((m = re.exec(stripped))) items.push(m[1] || m[2]);
    const leftover = stripped.replace(/'([a-z_]+)'|"([a-z_]+)"/g, '').replace(/[\s,]/g, '');
    assert.strictEqual(leftover, '', `${label} 数组字面量里有本断言**无法识别**的内容（残留「${leftover}」，双引号成员正则已覆盖，此处若非空说明有第三种写法未被识别）——静态提取已不完备，可能漏计新增成员`);
    return items.sort();
}
function extractObjectKeysWithValue(bodyText, label) {
    const stripped = stripComments(bodyText);
    // 逐个"键:值"整体匹配（键 4 种写法 × 值固定单引号字符串），避免只匹配键导致 leftover 里混进值本身。
    const entryRe = /'([a-z_]+)'\s*:\s*'[^']*'|"([a-z_]+)"\s*:\s*'[^']*'|\[\s*'([a-z_]+)'\s*\]\s*:\s*'[^']*'|\[\s*"([a-z_]+)"\s*\]\s*:\s*'[^']*'|([a-z_]+)\s*:\s*'[^']*'/g;
    const items = [];
    let m;
    while ((m = entryRe.exec(stripped))) items.push(m[1] || m[2] || m[3] || m[4] || m[5]);
    const leftover = stripped.replace(entryRe, '').replace(/[\s,]/g, '');
    assert.strictEqual(leftover, '', `${label} 对象字面量里有本断言**无法识别**的内容（残留「${leftover}」，裸写/单引号/双引号/计算属性键四种写法已覆盖）——静态提取已不完备，可能漏计新增成员`);
    return items.sort();
}
check('[A·#83 D1·MED-2] attachment_type 枚举三方对拍——后端 SYS_ATTACH_TYPES 数组 / 后端 SYS_ATTACH_TYPE_WORD 键集 / 前端 SI_TL_ATTACH_TYPE_WORD 键集，排序后逐一相等（含解析完备性 leftover 检查）', () => {
    const indexJsSrc = fs.readFileSync(require('path').resolve(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const mTypes = indexJsSrc.match(/const SYS_ATTACH_TYPES = \[([^\]]*)\];/);
    assert.ok(mTypes, '未定位到后端 SYS_ATTACH_TYPES 数组字面量（结构锚失效=本条空转，须先红在这里）');
    const backendTypes = extractQuotedArrayMembers(mTypes[1], '后端 SYS_ATTACH_TYPES');
    const mWordBackend = indexJsSrc.match(/const SYS_ATTACH_TYPE_WORD = \{([^}]*)\};/);
    assert.ok(mWordBackend, '未定位到后端 SYS_ATTACH_TYPE_WORD 常量字面量（结构锚失效=本条空转，须先红在这里）');
    const backendWordKeys = extractObjectKeysWithValue(mWordBackend[1], '后端 SYS_ATTACH_TYPE_WORD');
    const mWordFrontend = src.match(/const SI_TL_ATTACH_TYPE_WORD = \{([^}]*)\};/);
    assert.ok(mWordFrontend, '未定位到前端 SI_TL_ATTACH_TYPE_WORD 常量字面量（结构锚失效=本条空转，须先红在这里）');
    const frontendWordKeys = extractObjectKeysWithValue(mWordFrontend[1], '前端 SI_TL_ATTACH_TYPE_WORD');
    assert.deepStrictEqual(backendTypes, backendWordKeys, `后端 SYS_ATTACH_TYPES(${JSON.stringify(backendTypes)}) 与后端 SYS_ATTACH_TYPE_WORD 键集(${JSON.stringify(backendWordKeys)}) 不相等——同一侧内部两份副本已漂移`);
    assert.deepStrictEqual(backendWordKeys, frontendWordKeys, `后端 SYS_ATTACH_TYPE_WORD 键集(${JSON.stringify(backendWordKeys)}) 与前端 SI_TL_ATTACH_TYPE_WORD 键集(${JSON.stringify(frontendWordKeys)}) 不相等——前后端枚举已漂移，后端新增类型会致前端附件行整体静默回退`);
    // attachTypeOk 已改读 SI_TL_ATTACH_TYPE_WORD（hasOwnProperty），前端第四份硬编码副本已压掉，
    // 故本条不再单独对拍 attachTypeOk——它与 SI_TL_ATTACH_TYPE_WORD 键集同源，锁源头即锁住它。
    assert.ok(/hasOwnProperty\.call\(SI_TL_ATTACH_TYPE_WORD, t\)/.test(src), 'attachTypeOk 应读 SI_TL_ATTACH_TYPE_WORD 而非硬编码字面量集合（压掉前端第四份副本，防止两处前端定义各自漂移）');
});
// [#67 A1/C10·2026-09-16] SI_TL_CHANGE_CODES 已由 Set 升为 Map<码, 期望 event_type>，本条随之重写。
// ⚠️ 按 A1① 的「按用途分两类」原则：本条是**纯成员资格 / 集合关系检查**，故按 Map 的 **key 集合**比对，
//   **不改成事件配对**（配对只用于事件分支资格判断，唯一规范在 A5——见下一条 check）。
//   方案 v0.4/v0.5 曾写「所有 .has() 改为 get()===event_type」，那是 M1 修复后**未同步的旧指令**，
//   照它处理本条会重新引入「未登记码 ∧ 缺 event_type ⇒ undefined===undefined」漏洞。
check('[A·#67 A1/乙4 B1] SI_TL_CHANGE_CODES 是 Map 且恰含七码及其期望 event_type + SI_TL_CHANGE_FIELD_LABEL 含十六字段', () => {
    const mMap = src.match(/const SI_TL_CHANGE_CODES = new Map\(\[([\s\S]*?)\]\);/);
    assert.ok(mMap, 'SI_TL_CHANGE_CODES 应是 new Map([...]) 形态（#67 A1 由 Set 升级）');
    const pairs = [...mMap[1].matchAll(/\[\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\]/g)].map((m) => [m[1], m[2]]);
    const got = Object.fromEntries(pairs);
    // [577-R2 L4·同款缺陷全扫] 本条与下方 rec1 对拍用的是**同一个正则**，故有同一个洞：只收集
    //   "能识别的条目"时，新增**双引号/变量/展开项**条目会被**静默忽略**，四码 deepStrictEqual 照样通过
    //   ⇒ 新增第五码可以完全躲过本守卫。故先验**解析完备性**：剔除已识别条目后只应剩逗号与空白。
    //   （codex 577-R2 只点了对拍那处；这处是按「修同类问题按模式全扫」自查出来的同款。）
    const leftoverA1 = mMap[1].replace(/\[\s*'[a-z_]+'\s*,\s*'[a-z_]+'\s*\]/g, '').replace(/[\s,]/g, '');
    assert.strictEqual(leftoverA1, '', `SI_TL_CHANGE_CODES 初始化列表里有本断言**无法识别**的内容（残留「${leftoverA1}」）——静态提取已不完备，下面的四码比对会漏掉这些条目`);
    assert.deepStrictEqual(got, {
        release_info_edit: 'note',
        edit_in_revision: 'note',
        release_date_change: 'scope_change',
        assign_overdue_eta: 'note',
        // [乙4·2026-09-17 B1] 时间线留痕覆盖面补齐 v0.2 §5 B1 新增三码：
        estimate_eta: 'estimate',
        set_scheduled_start: 'note',
        set_oa_number: 'note',
    }, `七码及其期望类型应逐项吻合（新增码须同时登记类型），实得 ${JSON.stringify(got)}`);
    const lbl = (src.match(/const SI_TL_CHANGE_FIELD_LABEL = \{[\s\S]*?\};/) || [''])[0];
    assert.ok(lbl, '未提取到 SI_TL_CHANGE_FIELD_LABEL');
    for (const f of ['title', 'version_tag', 'release_note', 'description', 'system_name', 'module_name', 'priority', 'deadline', 'needs_feasibility', 'requester_dept', 'requester_name', 'requester_phone', 'source', 'related_correction_no']) {
        assert.ok(new RegExp(`\\b${f}:\\s*'`).test(lbl), `SI_TL_CHANGE_FIELD_LABEL 缺 ${f}（后端 SYS_RELEASE_EDIT_FIELD_LABEL ∪ EDIT_FIELD_LABELS 前端副本失同源）`);
    }
    // [#67 A2·577-M3] 本次新增两字段**核对中文内容**，不只检查「键 + 冒号 + 引号开头」——
    //   原写法下把 dev_estimated_at 的文案改成任意错误字符串，断言照样通过（codex 577-M3 指出）。
    for (const [f, zh] of [['planned_date', '计划上线日期'], ['dev_estimated_at', '预计完成时间']]) {
        assert.ok(new RegExp(`\\b${f}:\\s*'${zh}'`).test(lbl), `SI_TL_CHANGE_FIELD_LABEL 的 ${f} 应为「${zh}」（展开区字段名直接来自它，改错文案用户会看到错的字段名）`);
    }
});
// [#67 C2·2026-09-16] 三条集合关系断言。⚠️ 按 A1② 的要求，凡涉及 SI_TL_CHANGE_CODES 的集合关系
//   一律按**Map 的 key 集合**比对——不用事件配对（那只用于分支资格判断）。
const parseChangeCodeKeys = () => {
    const m = src.match(/const SI_TL_CHANGE_CODES = new Map\(\[([\s\S]*?)\]\);/);
    assert.ok(m, '未提取到 SI_TL_CHANGE_CODES Map');
    return [...new Set([...m[1].matchAll(/\[\s*'([a-z_]+)'\s*,/g)].map((x) => x[1]))];
};
const parseSetMembers = (name) => {
    const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
    assert.ok(m, `未提取到 ${name}`);
    return [...new Set((m[1].match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, '')))];
};
check('[A·#67 C2] 历史提示豁免集合 ⊆ SI_TL_CHANGE_CODES 的 key 集合（豁免一个没进变更留痕的码没有意义）', () => {
    const keys = parseChangeCodeKeys();
    const exempt = parseSetMembers('SI_TL_CHANGE_HISTORY_HINT_EXEMPT_CODES');
    const outside = exempt.filter((k) => !keys.includes(k));
    assert.deepStrictEqual(outside, [], `豁免集合有成员不在 CHANGE_CODES 里：${outside.join(',')}`);
});
check('[A·#67/#83 C2] SI_TL_HIDABLE_CODES（全 11 项，含附件三码）与 SI_TL_CHANGE_CODES 的 key 集合**交集为空**（一个码不能既可隐藏又是变更留痕）', () => {
    // 语义冲突：变更留痕是「对外承诺被改了、必须始终可见」，可隐藏是「批次内部编排/附件增删噪音、可折叠」。
    // 交集非空意味着某个码两种语义都占，渲染时就会出现「换了 ✎ 徽章但又被过滤器藏掉」的自相矛盾。
    // [#83·S2 续做] 按全部 11 项（8 批次编排 + 3 附件）比对，非只比批次编排那 8 个子集——附件三码同样
    // 不得混进变更留痕语义。
    const keys = parseChangeCodeKeys();
    const hidable = parseHidableCodesMap().map((p) => p[0]);
    const inter = hidable.filter((k) => keys.includes(k));
    assert.deepStrictEqual(inter, [], `两集合交集应为空，实得：${inter.join(',')}`);
});
check('[A·#67 C2/A9] SI_TL_CHANGE_LEGACY_ADAPTER 的键 ⊆ SI_TL_CHANGE_CODES 的 key 集合（给没进变更分支的码写适配器永远不会被调用）', () => {
    const keys = parseChangeCodeKeys();
    const m = src.match(/const SI_TL_CHANGE_LEGACY_ADAPTER = \{([\s\S]*?)\n    \};/);
    assert.ok(m, '未提取到 SI_TL_CHANGE_LEGACY_ADAPTER');
    const adapterKeys = [...new Set([...m[1].matchAll(/^\s{8}([a-z_]+):/gm)].map((x) => x[1]))];
    assert.ok(adapterKeys.length > 0, '未解析出适配器的任何键（解析失效=本条空转）');
    const outside = adapterKeys.filter((k) => !keys.includes(k));
    assert.deepStrictEqual(outside, [], `适配器有键不在 CHANGE_CODES 里：${outside.join(',')}`);
    // A9 明令「按 action_code 登记、不做通用推断」：当前只有 release_date_change 存在旧版结构化 payload
    assert.deepStrictEqual(adapterKeys, ['release_date_change'], `适配器应只登记 release_date_change（assign_overdue_eta 历来无 payload，通用化会误吞），实得：${adapterKeys.join(',')}`);
});
// [#67 A5/C10·2026-09-16] 分支条件由「硬编码 note ∧ Set.has」改为**码 + 期望类型配对**，本条随之重写。
// ⚠️ **定位锚必须换掉 `.has(e.action_code)`**（方案 C10 明警）：新条件里**仍含**那个字符串，
//   拿它定位会**偶然命中却没验证完整条件** = 假绿。改用配对表达式整体作锚。
check('[A·#67 A5] changes 分支条件为「has(码) ∧ get(码)===event_type」配对匹配 ∧ has() 前置不可省 ∧ 位于 online_mode 分支之前', () => {
    const body = stripComments(extractFunctionBody(src, 'siRenderTimeline') || '');
    assert.ok(body, '未提取到 siRenderTimeline 函数体');
    const pairRe = /SI_TL_CHANGE_CODES\.has\(e\.action_code\)\s*&&\s*SI_TL_CHANGE_CODES\.get\(e\.action_code\)\s*===\s*e\.event_type/;
    assert.ok(pairRe.test(body), 'changes 分支条件应为 has(e.action_code) && get(e.action_code) === e.event_type');
    // ⚠️ **has() 不可省**（codex 568-R2 M1）：若判据只剩 get(码) === e.event_type，未登记码 get()
    //   返回 undefined、该行又缺 event_type（也是 undefined）⇒ undefined === undefined 成立 ⇒ 异常行
    //   被放进分支。该漏洞的**行为级**验证见下方「未登记码 ∧ 缺失 event_type」用例。
    // ⚠️ [577-rec2 订正] 下面这条「has 在 get 之前」是**方案风格约束，不是安全必需**——对原生 Map
    //   交换两个 && 操作数并不会放行（has() 仍在 && 链里、照样返回 false）。保留它只为让判据读起来
    //   与方案 A5 的写法一致，别把它当成在守 undefined===undefined 那个洞。
    const iHas = body.indexOf('SI_TL_CHANGE_CODES.has(e.action_code)');
    const iGet = body.indexOf('SI_TL_CHANGE_CODES.get(e.action_code)');
    assert.ok(iHas > 0 && iGet > iHas, `风格约束：has() 应写在 get() 之前（与方案 A5 一致），实得 iHas=${iHas} iGet=${iGet}`);
    assert.ok(!/e\.event_type === 'note' && SI_TL_CHANGE_CODES\./.test(body), '仍残留旧的硬编码 note 条件（会把 release_date_change 挡在外面）');
    // [577-rec6] 顺序比较改用**配对表达式的匹配位置**，与上面「定位锚已换成配对表达式整体」的
    //   记录一致；原先仍用独立 indexOf 取 iGet，实现与记录有出入。
    const mPair = pairRe.exec(body);
    assert.ok(mPair, '配对表达式应能定位');
    const iOnline = body.indexOf('parsedPayload.online_mode != null');
    assert.ok(iOnline > mPair.index, 'changes 分支应在 online_mode 分支之前');
    // 徽章覆盖（v1.172.1）：两码 note 事件无条件统一为玫红「✎ 变更留痕」（si-tl-rose，用户选 V4a；不得与 release_published 的 si-tl-green 同色）；无明细时按 payload 空/非空分别追加「历史记录」/「明细不可用」说明
    assert.ok(/label = SI_TL_CHANGE_BADGE_LABEL; cls = SI_TL_CHANGE_BADGE_CLS;/.test(body) && !/if \(changesHtml\) \{ label = /.test(body), 'changes 分支应无条件覆盖 label/cls 为变更留痕徽章（v1.172.1 用户二拍：历史行也换徽章）');
    assert.ok(/（历史记录，未保存修改明细）/.test(body) && /（修改明细不可用）/.test(body), '无明细时应按 payload 空/非空分别追加「历史记录」/「明细不可用」两句');
    // [乙4·2026-09-17 B4] 该判据随 siTlChangesHtml 抽取搬进了独立函数体——siRenderTimeline 本体
    //   不再直接出现这段文本，检查目标同步换成 siTlChangesHtml 的函数体（同一份判据，只是搬了家，
    //   语义不变：kind='history' 的边界仍是 payload_json 为 NULL/空串）。
    const changesHtmlFnBody = stripComments(extractFunctionBody(src, 'siTlChangesHtml') || '');
    assert.ok(changesHtmlFnBody, '未提取到 siTlChangesHtml 函数体（B4 应已抽出该共用函数）');
    assert.ok(/e\.payload_json == null \|\| e\.payload_json === ''/.test(changesHtmlFnBody), '历史行判据=payload_json 为 NULL/空串（v1.172.0 起两写点恒写 payload，NULL 是版本边界），现应位于 siTlChangesHtml 函数体内');
    assert.ok(/const SI_TL_CHANGE_BADGE_LABEL = '✎ 变更留痕';/.test(src) && /const SI_TL_CHANGE_BADGE_CLS = 'si-tl-rose';/.test(src), '变更留痕徽章常量：标签「✎ 变更留痕」+ si-tl-rose（用户 2026-09-11 选 V4a）');
    assert.ok(/\.si-tl-evt\.si-tl-rose \{ background: #fce7f3; color: #be185d; \}/.test(src), 'si-tl-rose CSS 类应存在且为玫红实底（#fce7f3 / #be185d）');
    assert.ok(/release_published:\s*'si-tl-green'/.test(stripComments(src)), '对照：release_published 仍为 si-tl-green，变更留痕不得与之同色');
});
// ══════════════════════════════════════════════════════════════════════════════
// [乙4·2026-09-17 C1·时间线留痕覆盖面补齐 v0.2 §5 C1] S4b 前端 B 块（B1-B8）配套静态守卫。
//   放在 #67 §6.2 组之后（既有辅助函数 parseChangeCodeKeys/parseSetMembers 已在上方定义可复用）。
// ══════════════════════════════════════════════════════════════════════════════
const parseAttachCodeEntries = () => {
    const m = src.match(/const SI_TL_CHANGE_ATTACH_CODES = new Map\(\[([\s\S]*?)\]\);/);
    assert.ok(m, '未提取到 SI_TL_CHANGE_ATTACH_CODES Map');
    const pairs = [...m[1].matchAll(/\[\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\]/g)].map((x) => [x[1], x[2]]);
    const leftover = m[1].replace(/\[\s*'[a-z_]+'\s*,\s*'[a-z_]+'\s*\]/g, '').replace(/[\s,]/g, '');
    assert.strictEqual(leftover, '', `SI_TL_CHANGE_ATTACH_CODES 初始化列表里有本断言**无法识别**的内容（残留「${leftover}」）——静态提取已不完备`);
    return Object.fromEntries(pairs);
};
const parseAttachCodeKeys = () => Object.keys(parseAttachCodeEntries());
check('[A·乙4 C1①] SI_TL_CHANGE_ATTACH_CODES 是 Map 且恰含三码（B 类）及其期望 event_type', () => {
    const got = parseAttachCodeEntries();
    assert.deepStrictEqual(got, {
        feasibility_change: 'feasibility',
        assign_eta: 'assign',
        scope_change_deadline: 'scope_change',
    }, `B 类三码及其期望类型应逐项吻合，实得 ${JSON.stringify(got)}`);
});
check('[A·乙4 C1③] SI_TL_CHANGE_CODES（A 类）与 SI_TL_CHANGE_ATTACH_CODES（B 类）**无交集**', () => {
    const aKeys = parseChangeCodeKeys();
    const bKeys = parseAttachCodeKeys();
    const inter = aKeys.filter((k) => bKeys.includes(k));
    assert.deepStrictEqual(inter, [], `A/B 两类不得有共同码（语义互斥：覆盖徽章 vs 保留原徽章），实得交集：${inter.join(',')}`);
});
check('[A·乙4 C1④] 六新码（A 类三 + B 类三）均不在 SI_TL_HIDABLE_CODES 白名单、也不在 SI_TL_NOTE_OWN_LABEL_CODES 里', () => {
    const sixNew = ['estimate_eta', 'set_scheduled_start', 'set_oa_number', 'feasibility_change', 'assign_eta', 'scope_change_deadline'];
    const hidable = parseHidableCodesMap().map((p) => p[0]);
    const noteOwn = parseSetMembers('SI_TL_NOTE_OWN_LABEL_CODES');
    for (const code of sixNew) {
        assert.ok(!hidable.includes(code), `${code} 不应进可隐藏白名单（改造它的语义与「批次内部编排噪音」无关）`);
        assert.ok(!noteOwn.includes(code), `${code} 不应进 NOTE_OWN_LABEL 白名单（其标签由 key===event_type 或 A/B 类分支决定，不走 note 型专属徽章路径）`);
    }
});
check('[A·乙4 C1⑤] SI_TL_CHANGE_ATTACH_CODES 分支条件同样为「has(码) ∧ get(码)===event_type」配对匹配，位于 A 类分支之后、estimate 前缀分支之前，且不覆盖 label/cls', () => {
    const body = stripComments(extractFunctionBody(src, 'siRenderTimeline') || '');
    assert.ok(body, '未提取到 siRenderTimeline 函数体');
    const pairReA = /SI_TL_CHANGE_CODES\.has\(e\.action_code\)\s*&&\s*SI_TL_CHANGE_CODES\.get\(e\.action_code\)\s*===\s*e\.event_type/;
    const pairReB = /SI_TL_CHANGE_ATTACH_CODES\.has\(e\.action_code\)\s*&&\s*SI_TL_CHANGE_ATTACH_CODES\.get\(e\.action_code\)\s*===\s*e\.event_type/;
    const mA = pairReA.exec(body);
    const mB = pairReB.exec(body);
    assert.ok(mA, 'A 类配对表达式应能定位');
    assert.ok(mB, 'B 类配对表达式应能定位（has() 前置不可省，理由同 A 类）');
    assert.ok(mB.index > mA.index, 'B 类分支应位于 A 类分支之后');
    // ⚠️ 搜索起点须从 mB.index **之后**开始——「e.event_type === 'estimate' && e.summary」这段文本
    //   还出现在函数顶部 baseSummaryHtml 的计算式里（早于整条 if/else 链，也早于 mB），从 0 找会误命中
    //   那处，与「B 类分支应在 estimate 前缀分支之前」的意图无关。
    const iEstimatePrefix = body.indexOf("e.event_type === 'estimate' && e.summary", mB.index);
    assert.ok(iEstimatePrefix > mB.index, 'B 类分支应位于 estimate 前缀分支之前（B3 分支顺序）');
    const iHasB = body.indexOf('SI_TL_CHANGE_ATTACH_CODES.has(e.action_code)');
    const iGetB = body.indexOf('SI_TL_CHANGE_ATTACH_CODES.get(e.action_code)');
    assert.ok(iHasB > 0 && iGetB > iHasB, `风格约束：has() 应写在 get() 之前，实得 iHasB=${iHasB} iGetB=${iGetB}`);
    // B 类分支不得覆盖 label/cls——截取 B 类分支体（从 mB.index 到下一个 '} else if' 或本函数结尾附近）
    // [S4b2·585 L3] 切片终点改为 B 分支之后紧邻的「} else if (e.event_type === 'estimate' && e.summary)」（B3 顺序已由上方断言锁住），
    //   不再用 1500 定长窗口（分支体变长会逃逸、变短会吞进后续分支）；且禁止**任何**对 label/cls 的赋值形式，不只禁两个常量。
    const bEnd = body.indexOf("} else if (e.event_type === 'estimate' && e.summary)", mB.index);
    assert.ok(bEnd > mB.index, 'B 类分支之后应紧邻 estimate 前缀分支（切片终点定位失败 = 分支顺序或文本变了）');
    const bBranchSlice = body.slice(mB.index, bEnd);
    assert.ok(!/\b(label|cls)\s*=[^=]/.test(bBranchSlice), `B 类分支体内不得出现任何 label/cls 赋值（保留原徽章是 B 类核心语义），实得片段：${(bBranchSlice.match(/\b(label|cls)\s*=[^=][^\n]*/) || [''])[0]}`);
});
check('[A·乙4 C1⑥] SI_TL_CHANGE_FIELD_LABEL 含六处漏网写点新纳入的六个 field，且中文文案与方案 B5 逐项一致', () => {
    const lbl = (src.match(/const SI_TL_CHANGE_FIELD_LABEL = \{[\s\S]*?\};/) || [''])[0];
    assert.ok(lbl, '未提取到 SI_TL_CHANGE_FIELD_LABEL');
    for (const [f, zh] of [
        ['scheduled_start', '计划开工日'], ['oa_number', 'OA 流程号'], ['estimated_effort_days', '预计工期（人日）'],
        ['feasibility_conclusion', '评估结论'], ['feasibility_requirement_confirm', '需求理解确认'], ['feasibility_risk', '风险'],
    ]) {
        assert.ok(new RegExp(`\\b${f}:\\s*'${zh}'`).test(lbl), `SI_TL_CHANGE_FIELD_LABEL 的 ${f} 应为「${zh}」，实得未匹配（展开区字段名直接来自它）`);
    }
    // deadline 沿用既有「预期完成」，不应被本次改动重复定义第二次
    const deadlineHits = (lbl.match(/\bdeadline:\s*'/g) || []).length;
    assert.strictEqual(deadlineHits, 1, `deadline 应沿用既有定义、不重复登记，实得出现 ${deadlineHits} 次`);
    // [S4b2·codex 585 M] 方案 C1 要求**程序化**从六写点提取 field 字面量再对账，不只手写六个标签：
    //   后端新增/拼错字段时，上面的手写清单照样绿。做法：按路由处理器切片（起点 router.post('/sys-issues/:id/<p>'、
    //   终点该处理器收尾 "\n  });"）+ scope-change 的构造纯函数体，提取 `field: '<name>'` 字面量，
    //   逐项断言是 SI_TL_CHANGE_FIELD_LABEL 的自有键；并锁定字段全集（防漏提取——空集合也会"全部通过"）。
    const ixSrc = fs.readFileSync(require('path').resolve(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const routeSlice = (p) => {
        const key = `router.post('/sys-issues/:id/${p}'`;
        const i = ixSrc.indexOf(key); assert.ok(i >= 0, `[C1⑥] 未找到路由 ${key}`);
        const j = ixSrc.indexOf('\n  });', i + key.length); assert.ok(j > i, `[C1⑥] 路由 ${key} 未找到处理器收尾`);
        return ixSrc.slice(i, j);
    };
    const fnStart = ixSrc.indexOf('function buildScopeChangeDeadlineChanges(');
    assert.ok(fnStart >= 0, '[C1⑥] 未找到 buildScopeChangeDeadlineChanges');
    const fnSlice = ixSrc.slice(fnStart, ixSrc.indexOf('\n  }', fnStart));
    const backendFields = new Set();
    for (const seg of ['estimate', 'feasibility', 'set-scheduled-start', 'assign', 'scope-change', 'set-oa-number'].map(routeSlice).concat([fnSlice])) {
        for (const m of stripComments(seg).matchAll(/\bfield:\s*'([a-z_]+)'/g)) backendFields.add(m[1]);
    }
    const EXPECTED_BACKEND_FIELDS = ['dev_estimated_at', 'estimated_effort_days', 'feasibility_conclusion', 'feasibility_requirement_confirm', 'feasibility_risk', 'scheduled_start', 'deadline', 'oa_number'];
    assert.deepStrictEqual([...backendFields].sort(), [...EXPECTED_BACKEND_FIELDS].sort(), `六写点程序化提取的 field 全集应恰为 8 个（漂移=后端加/改了字段，前端标签与本清单要同步），实得 ${[...backendFields].sort().join(',')}`);
    const labelKeys = new Set([...lbl.matchAll(/\b([a-z_]+):\s*'/g)].map(m => m[1]));
    for (const f of backendFields) assert.ok(labelKeys.has(f), `后端写点产出的 field「${f}」在 SI_TL_CHANGE_FIELD_LABEL 无自有键（展开区会落回裸字段名）`);
});
check('[A·乙4 C1⑦] SI_TL_CHANGE_HISTORY_ELIGIBLE_CODES 恰含六码（四既有 + set_scheduled_start/set_oa_number），且不含 estimate_eta 与 B 类三码', () => {
    const eligible = parseSetMembers('SI_TL_CHANGE_HISTORY_ELIGIBLE_CODES');
    const expected = ['release_info_edit', 'edit_in_revision', 'release_date_change', 'assign_overdue_eta', 'set_scheduled_start', 'set_oa_number'];
    assert.deepStrictEqual([...eligible].sort(), [...expected].sort(), `历史资格集合应恰含这六码，实得：${eligible.join(',')}`);
    for (const excluded of ['estimate_eta', 'feasibility_change', 'assign_eta', 'scope_change_deadline']) {
        assert.ok(!eligible.includes(excluded), `${excluded} 无历史空载荷阶段，不应进历史资格集合（583-R M1）`);
    }
});
check('[A·乙4 C1⑧] 六新码的 event_type 与后端 index.js 写点的 INSERT 字面量一致（程序化提取，防前后端登记漂移）', () => {
    const indexJsSrc = fs.readFileSync(require('path').resolve(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const EXPECTED_EVENT_TYPE = {
        estimate_eta: 'estimate',
        feasibility_change: 'feasibility',
        set_scheduled_start: 'note',
        assign_eta: 'assign',
        scope_change_deadline: 'scope_change',
        set_oa_number: 'note',
    };
    // [S4b2·585 L2 / Opus L2] 不再用「全文 400 字符窗口 + 首个命中」（会跨到上一条 VALUES 或注释）：
    //   逐条解析 INSERT 模板「(列清单) VALUES (令牌)」，按列位置取 event_type / action_code 令牌，
    //   对每个码断**恰 1 条**模板以字面量写该码，且同一模板内 event_type 字面量等于期望。
    const sites = [];
    for (const m of stripComments(indexJsSrc).matchAll(/INSERT INTO sys_issue_timeline\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/g)) {
        const cols = m[1].split(',').map(t => t.trim());
        const toks = m[2].split(',').map(t => t.trim());
        if (cols.length !== toks.length) continue;   // 非 ?/字面量一一对应的形态不在本对账范围（label-coverage 守卫另管）
        const iA = cols.indexOf('action_code'); const iE = cols.indexOf('event_type');
        if (iA < 0 || iE < 0) continue;
        const ma = toks[iA].match(/^'([a-z_]+)'$/); const me = toks[iE].match(/^'([a-z_]+)'$/);
        if (ma) sites.push({ code: ma[1], eventType: me ? me[1] : null });
    }
    for (const [code, expectedType] of Object.entries(EXPECTED_EVENT_TYPE)) {
        const hits = sites.filter(x => x.code === code);
        assert.strictEqual(hits.length, 1, `index.js 以字面量写 '${code}' 的 INSERT 模板应恰 1 条，实得 ${hits.length}`);
        assert.strictEqual(hits[0].eventType, expectedType, `后端 ${code} 同一模板内的 event_type 应为 '${expectedType}'，实得 '${hits[0].eventType}'（前后端不同源会让 A/B 类配对判据永远不成立）`);
    }
});
check('[A] index.js edit_in_revision INSERT 落 payload_json（JSON.stringify({ changes })）', () => {
    const indexJsSrc = fs.readFileSync(require('path').resolve(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const m = indexJsSrc.match(/INSERT INTO sys_issue_timeline \(issue_id, event_type, summary, action_code, operator_id, operator_name, payload_json\)\s*VALUES \(\?, 'note', \?, 'edit_in_revision', \?, \?, \?\)`,\s*\[id, noteSummary, [^\]]*JSON\.stringify\(\{ changes \}\)\]/);
    assert.ok(m, 'edit_in_revision INSERT 应含 payload_json 列并绑定 JSON.stringify({ changes })');
    assert.ok(/changes\.push\(\{ field: f, old: normOld, new: normNew \}\)/.test(indexJsSrc), '幂等循环内应 changes.push({ field, old: normOld, new: normNew })（与幂等判据同源）');
});
{
    // 直调行为验证：抽出 siTlChangeValueHtml + siRenderTimelineChanges + 两常量 + esc，new Function 装配执行。
    const grabFnA = (name) => {
        const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
        const m = re.exec(src);
        if (!m) return null;
        const body = extractFunctionBody(src, name);
        return body ? src.slice(m.index, m.index + m[0].length - 1) + body : null;
    };
    const fnEsc = grabFnA('esc');
    const fnVal = grabFnA('siTlChangeValueHtml');
    const fnRender = grabFnA('siRenderTimelineChanges');
    const fnObj = grabFnA('siTlChangeObjectText');
    const constLbl = (src.match(/const SI_TL_CHANGE_FIELD_LABEL = \{[\s\S]*?\};/) || [''])[0];
    const constMax = (src.match(/const SI_TL_CHANGE_VALUE_MAX = \d+;/) || [''])[0];
    check('[A 前置] esc / siTlChangeValueHtml / siRenderTimelineChanges / 两常量均提取成功（提不到=本组空转）', () => {
        assert.ok(fnEsc && fnVal && fnRender && fnObj && constLbl && constMax, `提取缺失：esc=${!!fnEsc} val=${!!fnVal} render=${!!fnRender} obj=${!!fnObj} lbl=${!!constLbl} max=${!!constMax}`);
    });
    if (fnEsc && fnVal && fnRender && fnObj && constLbl && constMax) {
        const warns = [];
        // eslint-disable-next-line no-new-func
        const built = new Function('console', `${constLbl}\n${constMax}\n${fnEsc}\n${fnVal}\n${fnObj}\n${fnRender}\nreturn { siRenderTimelineChanges, siTlChangeObjectText };`)({ warn: (...a) => warns.push(a) });
        const render = built.siRenderTimelineChanges;
        const objText = built.siTlChangeObjectText;
        const oldVal = (h, i) => { const m = [...String(h).matchAll(/si-tl-change-old"><span class="si-tl-change-tag">修改前<\/span><div class="si-tl-change-val">([\s\S]*?)<\/div>/g)]; return m[i] ? m[i][1] : undefined; };
        const newVal = (h, i) => { const m = [...String(h).matchAll(/si-tl-change-new"><span class="si-tl-change-tag">修改后<\/span><div class="si-tl-change-val">([\s\S]*?)<\/div>/g)]; return m[i] ? m[i][1] : undefined; };
        const count = (h) => { const m = String(h).match(/查看改动（(\d+) 项）/); return m ? Number(m[1]) : null; };
        check('[A 直调] 正常三项 → 折叠计 3，逐字段「修改前 / 修改后」两块，未登记字段落回裸字段名，头行变更对象与字段清单', () => {
            const h = render([{ field: 'title', old: 'A', new: 'B' }, { field: 'priority', old: 'P2', new: 'P1' }, { field: 'zzz_unknown', old: 1, new: 2 }]);
            assert.strictEqual(count(h), 3, `计数应 3，实得 ${h}`);
            assert.ok(h.includes('标题') && h.includes('优先级') && h.includes('zzz_unknown'), '三行标签');
            assert.strictEqual(oldVal(h, 0), 'A', `第 1 项修改前块应为 A，实得 ${oldVal(h, 0)}`);
            assert.strictEqual(newVal(h, 0), 'B', `第 1 项修改后块应为 B，实得 ${newVal(h, 0)}`);
            assert.strictEqual(oldVal(h, 1), 'P2'); assert.strictEqual(newVal(h, 1), 'P1');
            assert.strictEqual(oldVal(h, 2), '1'); assert.strictEqual(newVal(h, 2), '2');
            assert.strictEqual((h.match(/si-tl-change-old"/g) || []).length, 3, '旧值块数=有效项数');
            assert.strictEqual((h.match(/si-tl-change-new"/g) || []).length, 3, '新值块数=有效项数');
            assert.strictEqual((h.match(/修改前<\/span>/g) || []).length, 3, '每项各一个「修改前」标签');
            assert.strictEqual((h.match(/修改后<\/span>/g) || []).length, 3, '每项各一个「修改后」标签');
            assert.ok(h.includes('<div class="si-tl-change-head">变更字段：标题、优先级、zzz_unknown（3 项）</div>'), `头行变更字段清单，实得 ${h.slice(0, 220)}`);
            const h2 = render([{ field: 'title', old: 'A', new: 'B' }], '上线单信息（批次 #5）');
            assert.ok(h2.includes('变更对象：上线单信息（批次 #5） · 变更字段：标题（1 项）'), `头行含变更对象，实得 ${h2.slice(0, 220)}`);
            assert.strictEqual(objText({ action_code: 'release_info_edit', ref_id: 7 }), '上线单信息（批次 #7）');
            assert.strictEqual(objText({ action_code: 'release_info_edit' }), '上线单信息');
            assert.strictEqual(objText({ action_code: 'release_info_edit', ref_id: 'abc' }), '上线单信息', 'ref_id 非数字省略括号');
            assert.strictEqual(objText({ action_code: 'release_info_edit', ref_id: '12' }), '上线单信息（批次 #12）', 'ref_id 数字串按整数显示');
            assert.strictEqual(objText({ action_code: 'release_info_edit', ref_id: 0 }), '上线单信息', 'ref_id 0 省略');
            assert.strictEqual(objText({ action_code: 'edit_in_revision' }), '迭代单内容');
            assert.strictEqual(objText({ action_code: 'accept' }), '');
            const h3 = render([{ field: 'title', old: 'A', new: 'B' }], '<b>x</b>');
            assert.ok(!h3.includes('<b>x</b>') && h3.includes('&lt;b&gt;x&lt;/b&gt;'), 'objectText 也经转义');
        });
        check('[A 直调·甲1 统一契约·2026-09-17] 缺损项规则：null / 非对象 / 数组 / field 非字符串 → 跳过不计数；**缺 old 或缺 new 自有键 → 同样跳过不计数**；显式 null 保留并显「（空）」', () => {
            // ⚠️ 本条**推翻 codex 565-R M5 冻结的规则**（原规则：缺 old / 缺 new / 两者都缺 → 显「（空）」且保留计数）。
            //   裁定依据（用户 2026-09-17·上段锚点 §9 第 8 项）：旧键适配器（codex 568-R M1）判「缺键=数据损坏」，
            //   新载荷路径却「缺键保留计数」——同一形态两条线结论相反比任一边错更危险；显式 null 是已保存的合法状态
            //   （清空/原未设定），缺键是缺失证据，两者必须可分辨；生产全量探针 6 个 changes 项均三键齐全 ⇒ 零显示影响。
            const h = render([null, 'x', 7, ['a'], { old: 1, new: 2 }, { field: 3, old: 1, new: 2 },
                { field: 'title', new: 'B' }, { field: 'title', old: 'A' }, { field: 'title' },
                { field: 'title', old: null, new: 'B' }, { field: 'priority', old: 'P2', new: null },
                { field: 'title', old: undefined, new: 'C' }]);   // [S2b·L1→M1 合并定] 自有键但值为 undefined（JSON 不可构造，仅直调可达）：按 M1 标量规则 undefined 不是合法标量 ⇒ 过滤。
            //   预筛 L1 原想用这一格区分「自有属性」与「值 !== undefined」两种实现——加了标量规则后两者对本格结论相同，
            //   区分点消失属预期：契约的准确措辞是「自有属性 ∧ 值为 null 或原始标量」，缺键与 undefined 值都不满足。
            assert.strictEqual(count(h), 2, `只有两个三键齐全项应保留（三种缺键项 + undefined 值项都不计数），实得 ${h}`);
            assert.strictEqual((h.match(/（空）/g) || []).length, 2, `「（空）」应恰出现 2 次（显式 null 各一），实得 ${(h.match(/（空）/g) || []).length}`);
            assert.ok(!/→ C|>C</.test(h) && !h.includes('修改后</span><div class="si-tl-change-val">C<'), 'undefined 值项不得渲染出来');
            assert.ok(/（空）/.test(String(oldVal(h, 0))) && newVal(h, 0) === 'B', `第 1 项应为「（空）→ B」，实得 ${oldVal(h, 0)} / ${newVal(h, 0)}`);
            assert.ok(oldVal(h, 1) === 'P2' && /（空）/.test(String(newVal(h, 1))), `第 2 项应为「P2 →（空）」，实得 ${oldVal(h, 1)} / ${newVal(h, 1)}`);
            assert.strictEqual(render([{ field: 'title', new: 'B' }, { field: 'title', old: 'A' }, { field: 'title' }]), '',
                '只含缺键项 → 全部过滤 → 空串（调用方据此落分支4「修改明细不可用」，不出折叠）');
        });
        check('[A 直调·甲1 S2b·Opus 预筛 M1] changes 项 old/new 为对象/数组 → 整项过滤（与旧键适配器「非法类型=损坏」对齐）；数字/布尔仍是合法标量', () => {
            // 预筛指出：甲1 把两条路径统一到了「缺键」维度，但「非法类型」维度仍相反——旧键路径对 {} / [] 判损坏，
            //   changes 路径却把 {old:{},new:false} 渲染成「[object Object] → false」正常展开。本条锁住对齐后的契约。
            assert.strictEqual(render([{ field: 'a', old: {}, new: 'x' }, { field: 'b', old: 'x', new: [1] }, { field: 'c', old: { d: 1 }, new: {} }, { field: 'd', old: ['x'], new: null }]), '',
                '全部为对象/数组 → 全过滤 → 空串（调用方落分支4）');
            const h = render([{ field: 'n', old: 0, new: 1 }, { field: 'b', old: false, new: true }, { field: 'bad', old: {}, new: 'x' }]);
            assert.strictEqual(count(h), 2, `数字与布尔项保留、对象项过滤 ⇒ 计 2，实得 ${h}`);
            assert.strictEqual(oldVal(h, 0), '0'); assert.strictEqual(newVal(h, 0), '1');
            assert.strictEqual(oldVal(h, 1), 'false'); assert.strictEqual(newVal(h, 1), 'true');
            assert.ok(!h.includes('[object Object]'), '不得出现 [object Object]');
        });
        check('[A 直调·甲1 S2c·codex 582 M] old/new 来自原型链（非自有属性）→ 整项过滤——把「自有属性」与「标量检查」两道判据分别锁住', () => {
            // codex 582：S2b 加标量规则后，缺键与 undefined 值都被标量检查兜住，看似 hasOwnProperty 检查冗余；
            //   但**继承得到的合法标量**（原型上有 old:'A'）能通过标量检查、只被自有键检查拦下 ⇒ 自有键检查非冗余，
            //   守卫此前缺该用例（变异「去掉自有键过滤」在 S2b 后不再打红）。本条是**函数防御契约覆盖**：普通 JSON
            //   载荷构造不出原型形态，不宣称生产可达；它锁的是「实现按自有属性判」这一契约本身。
            const inhOld = Object.assign(Object.create({ old: 'A' }), { field: 'title', new: 'B' });
            const inhNew = Object.assign(Object.create({ new: 'B' }), { field: 'title', old: 'A' });
            const inhBoth = Object.assign(Object.create({ old: 'A', new: 'B' }), { field: 'title' });
            assert.strictEqual(render([inhOld, inhNew, inhBoth]), '', '继承 old / 继承 new / 两者都继承 → 全部过滤 → 空串');
            const h = render([inhOld, { field: 'title', old: 'A', new: 'B' }]);
            assert.strictEqual(count(h), 1, `继承项过滤、自有项保留 ⇒ 计 1，实得 ${h}`);
            assert.strictEqual(oldVal(h, 0), 'A'); assert.strictEqual(newVal(h, 0), 'B');
        });
        check('[A 直调] 全部无效项 / 非数组 / 空数组 → 返回空串（不出折叠）', () => {
            assert.strictEqual(render([null, 'x', { old: 1 }]), '', '全无效应空串');
            assert.strictEqual(render('nope'), '', '非数组应空串');
            assert.strictEqual(render([]), '', '空数组应空串');
        });
        check('[A 直调] 值含 <script> 与引号被转义（正文与 title 属性内都不出现原始 < 与 "）；超 120 码点含属性注入片段的值在 title 内双引号被编码；含特殊字符的未知 field 回退裸字段名也被转义', () => {
            const long = '<script>alert(1)</script>' + 'x'.repeat(200);
            const h = render([{ field: 'description', old: '<b>o</b>', new: long }]);
            assert.ok(!h.includes('<script>') && !h.includes('<b>'), '不得出现原始标签');
            assert.ok(h.includes('&lt;script&gt;') && h.includes('&lt;b&gt;'), '应为转义后的 &lt;');
            // [566-L1] title 属性上下文：超 120 码点 + 双引号 + 属性注入片段
            const inject = '" onmouseover="alert(1)" data-x="' + 'y'.repeat(130);
            const h2 = render([{ field: 'description', old: '', new: inject }]);
            assert.ok(!h2.includes('" onmouseover="'), 'title 内不得出现原始双引号形成的额外属性');
            assert.ok(/title="&quot; onmouseover=&quot;alert\(1\)&quot; data-x=&quot;y+"/.test(h2), `title 中双引号应编码为 &quot;，实得 ${h2.slice(0, 200)}`);
            assert.strictEqual((h2.match(/<span title=/g) || []).length, 1, '只应有一个 title span（截断分支）');
            // [566-L1] 未知 field 回退裸字段名：特殊字符转义
            const h3 = render([{ field: '<img src=x onerror=alert(1)>&"', old: 'a', new: 'b' }]);
            assert.ok(!h3.includes('<img') && h3.includes('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;'), `未知 field 应被转义，实得 ${h3.slice(0, 200)}`);
            assert.strictEqual(count(h3), 1, '未知 field 项保留计数 1');
        });
        check('[A 直调] 超 120 码点截断 + title 挂全文；恰 120 不截；emoji 按码点计', () => {
            const s121 = '😀'.repeat(121);
            const h = render([{ field: 'description', old: '', new: s121 }]);
            assert.ok(/title="(😀){121}"/.test(h), 'title 应挂全文 121 个码点');
            assert.ok(/>(😀){120}…</.test(h), '正文应为 120 个码点 + …');
            const s120 = 'y'.repeat(120);
            const h2 = render([{ field: 'description', old: '', new: s120 }]);
            assert.ok(!h2.includes('…') && !h2.includes('title="' + s120), '恰 120 不截断、不挂 title');
        });
        check('[A 直调] 数字 0 显「0」不显「（空）」；needs_feasibility 1→是 0→否', () => {
            const h = render([{ field: 'module_name', old: 0, new: '' }, { field: 'needs_feasibility', old: 1, new: 0 }]);
            assert.strictEqual(oldVal(h, 0), '0', `module_name 旧值 0 应显 0，实得 ${oldVal(h, 0)}`);
            assert.ok(String(newVal(h, 0)).includes('（空）'), 'module_name 新值空串显「（空）」');
            assert.strictEqual((h.match(/（空）/g) || []).length, 1, '只有 module_name 的新值空串显「（空）」');
            assert.strictEqual(oldVal(h, 1), '是', 'needs_feasibility 1 → 是');
            assert.strictEqual(newVal(h, 1), '否', 'needs_feasibility 0 → 否');
        });
        check('[A 直调] 渲染内部抛错 → 返回空串且 console.warn 一次（不中断时间线）', () => {
            const evil = { field: 'title', get old() { throw new Error('boom'); }, new: 'x' };
            const before = warns.length;
            assert.strictEqual(render([evil]), '', '异常应降级空串');
            assert.strictEqual(warns.length, before + 1, '应 console.warn 一次');
        });
        // ── [566-R L2] 徽章覆盖直调：装配真实 siRenderTimeline（with 作用域注入真实标签/配色登记 + 其余依赖替身）──
        {
            const fnTimeline = grabFnA('siRenderTimeline');
            // [乙4·2026-09-17 B4] siRenderTimeline 自本次起依赖共用函数 siTlChangesHtml——隔离装配同样
            //   必须注入它的函数本体，否则 new Function 里 ReferenceError: siTlChangesHtml is not defined。
            const fnChangesHtml = grabFnA('siTlChangesHtml');
            const grabConst = (name) => (src.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\};`)) || [''])[0];
            const grabSet = (name) => (src.match(new RegExp(`const ${name} = new Set\\(\\[[\\s\\S]*?\\]\\);`)) || [''])[0];
            const badgeConsts = (src.match(/const SI_TL_CHANGE_BADGE_LABEL = '[^']*';\s*\n\s*const SI_TL_CHANGE_BADGE_CLS = '[^']*';/) || [''])[0];
            // [#67 A4·C1 必改] siRenderTimeline 自本次起依赖**模块级纯函数** siTlIsHidableScope，
            //   隔离装配必须把它的**函数本体**与它依赖的白名单一并注入 parts——否则 new Function 里
            //   ReferenceError: siTlIsHidableScope is not defined（本次改造前实测三条断言正是这样红的）。
            //   提取失败会被下方 parts.forEach 的 assert.ok 兜住，不会静默跑空。
            const fnHidable = (src.match(/function siTlIsHidableScope\(e\) \{[\s\S]*?\n    \}/) || [''])[0];
            // [#67 A1③·2026-09-16] grabSet 解析的是 `new Set([...])` 字面量，SI_TL_CHANGE_CODES 升 Map 后**失效**
            //   （本次实测：parts 第 5 项提取为空、被既有 assert.ok 兜住报「第 5 项登记/常量未提取到」，
            //   **不是静默跑空**）。故新增 grabMap 专取 `new Map([[...]])`。
            const grabMap = (name) => (src.match(new RegExp(`const ${name} = new Map\\(\\[[\\s\\S]*?\\]\\);`)) || [''])[0];
            // [#67 §6.3 + A9] 本分支新依赖两个常量：历史提示豁免集合与旧版 payload 适配器，隔离装配须一并注入
            const exemptSet = grabSet('SI_TL_CHANGE_HISTORY_HINT_EXEMPT_CODES');
            const legacyAdapter = (src.match(/const SI_TL_CHANGE_LEGACY_ADAPTER = \{[\s\S]*?\n    \};/) || [''])[0];
            // [乙4·2026-09-17 B2/B4] 新增两项装配依赖：B 类附带变更表（Map）+ 历史资格集合（Set）。
            const attachMap = grabMap('SI_TL_CHANGE_ATTACH_CODES');
            const eligibleSet = grabSet('SI_TL_CHANGE_HISTORY_ELIGIBLE_CODES');
            // [#83·S2 续做] siRenderTimeline 自本批起依赖 siRenderAttachListHtml（附件三码「读侧校验 +
            // 展开区列表」，同 siTlChangesHtml 一样是独立具名函数）+ 它引用的 SI_TL_ATTACH_TYPE_WORD 常量
            // 与 siTlAttachDisplayName 辅助函数——隔离装配同样须一并注入，否则遇到附件行会
            // ReferenceError: siRenderAttachListHtml is not defined（本组用例已在下方 [A 直调·H1] 一带
            // 覆盖附件行，装配齐全是这些用例能跑通的前提）。
            const fnAttachList = grabFnA('siRenderAttachListHtml');
            const fnAttachDisplayName = grabFnA('siTlAttachDisplayName');
            const constAttachTypeWord = (src.match(/const SI_TL_ATTACH_TYPE_WORD = \{[\s\S]*?\};/) || [''])[0];
            const parts = [grabConst('SI_TL_LABEL'), grabConst('SI_TL_CLS'), grabSet('SI_TL_NOTE_OWN_LABEL_CODES'), grabConst('SI_TL_RELEASE_SCOPE_LABEL'), grabConst('SI_TL_RELEASE_SCOPE_CLS'), grabMap('SI_TL_CHANGE_CODES'), grabMap('SI_TL_HIDABLE_CODES'), exemptSet, legacyAdapter, fnHidable, badgeConsts, attachMap, eligibleSet, constAttachTypeWord, fnAttachDisplayName, fnAttachList];
            check('[A 徽章前置] siRenderTimeline + siTlChangesHtml + siRenderAttachListHtml + 十二张登记表/常量 + 适配器 + 徽章常量 + siTlIsHidableScope 本体均提取成功', () => {
                assert.ok(fnTimeline, '未提取到 siRenderTimeline');
                assert.ok(fnChangesHtml, '未提取到 siTlChangesHtml（B4 应已抽出该共用函数）');
                assert.ok(fnAttachList, '未提取到 siRenderAttachListHtml（#83·S2 续做应已抽出该共用函数）');
                parts.forEach((p, i) => assert.ok(p, `第 ${i} 项登记/常量未提取到`));
            });
            if (fnTimeline && fnChangesHtml && fnAttachList && parts.every(Boolean)) {
                const stubs = {
                    SI_TL_WGATE_LEGACY_SUMMARY: '__wgate__', SI_DEV_FAMILY_STATUSES: ['开发中', '处理中'],
                    siStatusDisplay: (s) => s, siFmtDT: (s) => s, siFmtDTSec: (s) => s, siTlHideReleaseScope: false, siOpenId: 1,
                    siFormatReleasePublishedSummary: () => ({ ok: false, brief: 'pub-brief', raw: 'raw' }), siRenderReleasePublishedCommits: () => '',
                    console: { warn: () => {} },
                };
                // eslint-disable-next-line no-new-func
                const tl = new Function('stubs', `with (stubs) { ${parts.join('\n')}\n${constLbl}\n${constMax}\n${fnEsc}\n${fnVal}\n${fnObj}\n${fnRender}\n${fnChangesHtml}\n${fnTimeline}\nreturn siRenderTimeline; }`)(stubs);
                const badge = (h) => { const m = String(h).match(/<span class="si-tl-evt ([^"]+)">([^<]*)<\/span>/); return m ? { cls: m[1], label: m[2] } : null; };
                const row = (extra) => Object.assign({ id: 1, event_type: 'note', action_code: 'edit_in_revision', summary: '编辑内容（标题）', operator_name: '示例客服B', created_at: '2026-09-11 10:00:00', payload_json: JSON.stringify({ changes: [{ field: 'title', old: 'A', new: 'B' }] }) }, extra);
                check('[A 徽章直调] 有效 changes → 徽章覆盖为玫红「✎ 变更留痕」（si-tl-rose），edit_in_revision 与 release_info_edit 两码均如此；发布留痕不与之同色', () => {
                    assert.deepStrictEqual(badge(tl([row()], [], '')), { cls: 'si-tl-rose', label: '✎ 变更留痕' });
                    assert.deepStrictEqual(badge(tl([row({ action_code: 'release_info_edit', ref_id: 9, summary: '上线单信息修改（标题）' })], [], '')), { cls: 'si-tl-rose', label: '✎ 变更留痕' });
                    assert.notStrictEqual(badge(tl([row({ event_type: 'scope_change', action_code: 'release_published', summary: 'R-1 已发布', payload_json: null })], [], '')).cls, 'si-tl-rose', '发布留痕不得用变更留痕的色');
                    assert.ok(tl([row({ action_code: 'release_info_edit', ref_id: 9 })], [], '').includes('变更对象：上线单信息（批次 #9）'), '头行含批次对象');
                });
                check('[A 徽章直调·v1.172.1] 无明细行仍换「✎ 变更留痕」徽章、不出折叠；payload NULL/空串 → 「历史记录」文案；payload 非空异常（非 JSON / 无 changes 键 / changes 非数组 / 空数组 / 全部无效）→ 「修改明细不可用」文案（567 M1）', () => {
                    const rose = { cls: 'si-tl-rose', label: '✎ 变更留痕' };
                    for (const [name, extra] of [['无 payload(null)', { payload_json: null }], ['空串 payload', { payload_json: '' }], ['历史 release_info_edit', { action_code: 'release_info_edit', payload_json: null }]]) {
                        const h = tl([row(extra)], [], '');
                        assert.deepStrictEqual(badge(h), rose, `${name}：徽章应为变更留痕`);
                        assert.ok(h.includes('（历史记录，未保存修改明细）') && !h.includes('修改明细不可用'), `${name}：应追加历史文案`);
                        assert.ok(!h.includes('查看改动'), `${name}：不得出现折叠`);
                    }
                    for (const [name, extra] of [['非 JSON', { payload_json: '{not json' }], ['无 changes 键', { payload_json: JSON.stringify({ attachment_ids: [] }) }], ['changes 非数组', { payload_json: JSON.stringify({ changes: 'x' }) }], ['空数组', { payload_json: JSON.stringify({ changes: [] }) }], ['全部无效项', { payload_json: JSON.stringify({ changes: [null, 'x'] }) }], ['release_info_edit 空数组', { action_code: 'release_info_edit', payload_json: JSON.stringify({ changes: [] }) }]]) {
                        const h = tl([row(extra)], [], '');
                        assert.deepStrictEqual(badge(h), rose, `${name}：徽章应为变更留痕`);
                        assert.ok(h.includes('（修改明细不可用）') && !h.includes('历史记录'), `${name}：应追加「明细不可用」而非历史文案`);
                        assert.ok(!h.includes('查看改动'), `${name}：不得出现折叠`);
                    }
                    for (const extra of [{}, { action_code: 'release_info_edit', ref_id: 3, summary: '上线单信息修改（标题）' }]) {
                        const hNew = tl([row(extra)], [], '');
                        assert.ok(hNew.includes('查看改动') && !hNew.includes('未保存修改明细') && !hNew.includes('明细不可用'), '有明细的行只出折叠不追加说明');
                    }
                });
                // ══ [#67 A3/A4·真实渲染层双向证明] ══════════════════════════════════════════
                // 为什么要在这里加：C2 的那几条是**源码正则**（断"代码里写的是 isHidableScope"），
                //   而"改期行到底带不带 class、勾选后到底可不可见"必须看**渲染输出**才算证明。
                // 本该由 c2b2 在 DOM 层证明，但它有既有债——夹具排班 2032-04-07 撞 F1 闸，:553 的
                //   「确认上线完成」按钮被禁用致 page.click 超时，**跑不到 G3 尾段的 timeline 断言**
                //   （PROJECT_STATUS #64 既有债②，非本次引入）。故在此用真实 siRenderTimeline 直调补证，
                //   并把 c2b2 的 DOM 级验证登记为挂起项。
                const stubsHidden = Object.assign({}, stubs, { siTlHideReleaseScope: true });
                // eslint-disable-next-line no-new-func
                const tlHidden = new Function('stubs', `with (stubs) { ${parts.join('\n')}\n${constLbl}\n${constMax}\n${fnEsc}\n${fnVal}\n${fnObj}\n${fnRender}\n${fnChangesHtml}\n${fnTimeline}\nreturn siRenderTimeline; }`)(stubsHidden);
                // ⚠️ [579-R2 L1] 本 helper 是**锁定当前序列化格式**的检查，不是 HTML 解析器：
                //   它要求 div 的第一个属性就是 class ⇒ 合法调整属性顺序会**假红**；
                //   且原写法 `si-tl-item[^"]*` 会把 `si-tl-item-wrapper` 这类**前缀类**误当事件项 ⇒ **假绿**。
                //   ⇒ 补**完整 class 令牌边界**：`si-tl-item` 后面只能是引号或空格。
                //   若将来渲染结构外面再包一层容器，应改为真正解析 HTML 后按令牌集合选取。
                const firstItemAttrs = (h) => {
                    const m = String(h).match(/<div class="(si-tl-item(?:\s[^"]*)?)"([^>]*)>/);
                    if (!m) return null;
                    const tokens = m[1].split(/\s+/).filter(Boolean);
                    return { cls: m[1], rest: m[2], tokens, has: (t) => tokens.includes(t) };
                };
                const evtDateChange = { id: 71, event_type: 'scope_change', action_code: 'release_date_change', summary: '计划上线日期 2026-09-20 → 2026-09-25', ref_id: 9, operator_name: '示例客服B', created_at: '2026-09-16 10:00:00' };
                const evtHidable = { id: 72, event_type: 'scope_change', action_code: 'release_add', summary: '加入上线单 R-1', ref_id: 9, operator_name: '示例客服B', created_at: '2026-09-16 10:01:00' };
                check('[A 直调·#67 A3] 改期行**不带** si-tl-release-scope class，而白名单码（release_add）**带**——双向对照，证明拆分真的生效而非恰好', () => {
                    const a = firstItemAttrs(tl([evtDateChange], [], ''));
                    assert.ok(a, '改期行未渲染出 si-tl-item');
                    assert.ok(!/si-tl-release-scope/.test(a.cls), `改期行不应带可隐藏 class（#67 核心语义），实得 class="${a.cls}"`);
                    const b = firstItemAttrs(tl([evtHidable], [], ''));
                    assert.ok(b && /si-tl-release-scope/.test(b.cls), `对照组 release_add 应带可隐藏 class（否则本断言是恒真、无判别力），实得 class="${b && b.cls}"`);
                });
                check('[A 直调·#67 A3] 勾选过滤器（siTlHideReleaseScope=true）后：改期行**无** display:none 仍可见，而白名单码被隐藏', () => {
                    const a = firstItemAttrs(tlHidden([evtDateChange], [], ''));
                    assert.ok(a, '改期行未渲染出 si-tl-item');
                    assert.ok(!/display:none/.test(a.rest), `勾选后改期行仍须可见（这是 S1 的验收标准），实得属性="${a.rest}"`);
                    const b = firstItemAttrs(tlHidden([evtHidable], [], ''));
                    assert.ok(b && /display:none/.test(b.rest), `对照组 release_add 勾选后应被隐藏（否则过滤器整体失效、本断言无判别力），实得属性="${b && b.rest}"`);
                });
                // ⚠️ [#67 S2 改写·2026-09-16] **本条断言的前提被 S2 改变了**，原样保留会假红。
                //   S1 时改期还没进 changes 分支，所以它的徽章取自 SCOPE_LABEL 表（「上线单改期」），
                //   S1 据此断言「isReleaseScope 保留的标签作用仍在」。S2 的 A5 配对匹配让
                //   release_date_change + scope_change 命中 changes 分支后，**徽章被覆盖为 ✎「变更留痕」**
                //   （方案有意：统一徽章，「改的是什么对象」下沉到展开区头行）⇒ 原断言必然失败。
                // ⚠️ 更要紧的是：徽章覆盖会**掩盖 isReleaseScope 被误改的后果**——若它被误改，key 会落到
                //   event_type，默认 label 变成通用「范围变更」，但 changes 分支照样覆盖成 ✎，**看不出来**。
                //   故改期码这条路已失去可观测性 ⇒ isReleaseScope 的标签作用改用**未进 changes 分支的
                //   可隐藏码**（release_add）来验，那条路径没有徽章覆盖、能真实反映 key 计算结果。
                check('[A 直调·#67 S2] 改期行徽章被统一覆盖为 ✎「变更留痕」∧ 展开区头行落「上线批次（批次 #N）」（A8）', () => {
                    const h = tl([Object.assign({}, evtDateChange, { payload_json: JSON.stringify({ changes: [{ field: 'planned_date', old: '2026-09-20', new: '2026-09-25' }] }) })], [], '');
                    assert.deepStrictEqual(badge(h), { cls: 'si-tl-rose', label: '✎ 变更留痕' }, '改期进 changes 分支后徽章应统一为玫红变更留痕');
                    assert.ok(h.includes('变更对象：上线批次（批次 #9） · '), `展开区头行应含 A8 新增的改期分支文案，实得片段：${(h.match(/变更对象：[^<]*/) || ['(无)'])[0]}`);
                    assert.ok(h.includes('计划上线日期'), 'A2 新增的 planned_date 字段标签应生效（否则落回裸字段名）');
                });
                check('[A 直调·#67 A4] isReleaseScope 的标签作用仍在——用未进 changes 分支的可隐藏码验（release_add 取「加入上线单」而非通用「范围变更」）', () => {
                    const bd = badge(tl([evtHidable], [], ''));
                    assert.ok(bd, 'release_add 行未渲染出徽章');
                    assert.strictEqual(bd.label, '加入上线单', `应取 SCOPE_LABEL 表里的专属标签；若 isReleaseScope 被误改，key 会落到 event_type、标签变成通用「范围变更」。实得「${bd.label}」`);
                });
                // ══ [S2 修复批·H1·codex 预筛拦截] 附件三码渲染分支——行为断言（补回被
                //   verify-sys-timeline-summary-escape.js 白名单挡掉的那层：siRenderAttachListHtml 是本批
                //   唯一渲染攻击者可控字符串（original_name）的路径，此前 panel-static 零覆盖）══════════
                const xssImg = '<img src=x onerror=alert(1)>';
                const xssAttr = '" onmouseover="alert(2)';
                const addedRow = (originalName, extra) => Object.assign({ id: 81, event_type: 'note', action_code: 'attachment_added', summary: '上传附件：a.png', operator_name: '示例客服B', created_at: '2026-09-17 10:00:00', payload_json: JSON.stringify({ attachments: [{ id: 5, original_name: originalName, attachment_type: 'spec' }], count: 1 }) }, extra);
                const replacedRow = (originalName) => Object.assign({}, addedRow(originalName), { id: 82, action_code: 'attachment_replaced', payload_json: JSON.stringify({ attachments: [{ id: 6, original_name: originalName, attachment_type: 'delivery' }], count: 1, superseded_id: 5 }) });
                const removedRow = (originalName) => ({ id: 83, event_type: 'note', action_code: 'attachment_removed', summary: '删除附件：a.png', operator_name: '示例客服B', created_at: '2026-09-17 10:01:00', payload_json: JSON.stringify({ attachment: { id: 7, original_name: originalName, attachment_type: 'screenshot', uploaded_by_name: '张三' } }) });
                check('[A 直调·H1] 附件展开区两个 XSS 文件名样本在 added/replaced/removed 三路径均被转义——不含裸 <img/onmouseover=，各自含转义后的字面量', () => {
                    for (const [name, row] of [['added', addedRow], ['replaced', replacedRow], ['removed', removedRow]]) {
                        const hImg = tl([row(xssImg)], [], '');
                        assert.ok(!hImg.includes('<img src=x'), `${name} 路径 xssImg 样本应转义 <img，实得片段：${(hImg.match(/<li>[^\n]*<\/li>/) || ['(无)'])[0]}`);
                        assert.ok(hImg.includes('&lt;img'), `${name} 路径 xssImg 样本应含转义后的 &lt;img，实得片段：${(hImg.match(/<li>[^\n]*<\/li>/) || ['(无)'])[0]}`);
                        const hAttr = tl([row(xssAttr)], [], '');
                        assert.ok(!hAttr.includes('" onmouseover="alert'), `${name} 路径 xssAttr 样本不应留原样 onmouseover 属性注入`);
                        assert.ok(hAttr.includes('&quot; onmouseover'), `${name} 路径 xssAttr 样本应含转义后的 &quot; onmouseover，实得片段：${(hAttr.match(/<li>[^\n]*<\/li>/) || ['(无)'])[0]}`);
                    }
                });
                check('[A 直调·H1] 三码正例——合法 payload 均展开 <details class="si-tl-attach-list">，含 (无文件名) 占位符', () => {
                    for (const [name, row] of [['added', addedRow], ['replaced', replacedRow], ['removed', removedRow]]) {
                        const h = tl([row('正常文件名.pdf')], [], '');
                        assert.ok(h.includes('<details class="si-tl-attach-list">'), `${name} 合法 payload 应展开附件清单 details`);
                    }
                    const hNull = tl([addedRow(null)], [], '');
                    assert.ok(hNull.includes('<details class="si-tl-attach-list">'), 'original_name 显式 null 仍应合法展开');
                    assert.ok(/（无文件名）#5/.test(hNull), '显式 null 应显示「（无文件名）#id」占位符');
                });
                check('[A 直调·H1] 非法 payload 三码均静默回退 esc(summary)，不出 details——added 缺 attachments、replaced 缺 superseded_id、removed 类型非枚举', () => {
                    const badAdded = tl([Object.assign({}, addedRow('x'), { payload_json: JSON.stringify({ count: 0 }) })], [], '');
                    assert.ok(!badAdded.includes('si-tl-attach-list'), 'added 缺 attachments 应回退，不出 details');
                    const badReplaced = tl([Object.assign({}, replacedRow('x'), { payload_json: JSON.stringify({ attachments: [{ id: 6, original_name: 'x', attachment_type: 'delivery' }], count: 1 }) })], [], '');
                    assert.ok(!badReplaced.includes('si-tl-attach-list'), 'replaced 缺 superseded_id 应回退，不出 details');
                    const badRemoved = tl([Object.assign({}, removedRow('x'), { payload_json: JSON.stringify({ attachment: { id: 7, original_name: 'x', attachment_type: 'archive', uploaded_by_name: '张三' } }) })], [], '');
                    assert.ok(!badRemoved.includes('si-tl-attach-list'), 'removed attachment_type 非枚举应回退，不出 details');
                });
                // [596B-L1] 表驱动反例补充——上一条只覆盖「缺 attachments/缺 superseded_id/类型非枚举」三个
                // 缺陷点，未直接锁住 count 与数组长度不符、元素 id 非正整数、缺 original_name、removed 缺
                // uploaded_by_name、replaced 的 superseded_id 为零或负数这五类。同时补 removed 的
                // uploaded_by_name:null 合法占位分支（显式 null 与缺键语义不同，不应被合并处理）。
                check('[A 直调·L1(596B)] 非法 payload 反例表驱动补充——count 与数组长度不符/元素 id 非正整数/缺 original_name/removed 缺 uploaded_by_name/replaced superseded_id 为零或负数均应静默回退（不抛、不出 details、summary 转义保留）；removed 的 uploaded_by_name:null 是合法占位（非缺键）应正常展开', () => {
                    const summaryX = '恶意<script>alert(9)</script>反例摘要';
                    const escSummaryFrag = '&lt;script&gt;alert(9)&lt;/script&gt;';
                    const runBad = (name, actionCode, payload) => {
                        const row = { id: 91, event_type: 'note', action_code: actionCode, summary: summaryX, operator_name: '示例客服B', created_at: '2026-09-18 10:00:00', payload_json: JSON.stringify(payload) };
                        let h; let threw = null;
                        try { h = tl([row], [], ''); } catch (err) { threw = err; }
                        assert.ok(!threw, `${name} 不应抛错，实抛出：${threw && threw.message}`);
                        assert.ok(!h.includes('si-tl-attach-list'), `${name} 应静默回退，不出 details，实得：${h}`);
                        assert.ok(h.includes(escSummaryFrag), `${name} 回退后应保留转义后的 summary，实得：${h}`);
                    };
                    runBad('added-count与数组长度不符', 'attachment_added', { attachments: [{ id: 1, original_name: 'a.png', attachment_type: 'delivery' }], count: 2 });
                    runBad('added-id非正整数(0)', 'attachment_added', { attachments: [{ id: 0, original_name: 'a.png', attachment_type: 'delivery' }], count: 1 });
                    runBad('added-id非正整数(负数)', 'attachment_added', { attachments: [{ id: -1, original_name: 'a.png', attachment_type: 'delivery' }], count: 1 });
                    runBad('added-缺original_name键', 'attachment_added', { attachments: [{ id: 1, attachment_type: 'delivery' }], count: 1 });
                    runBad('replaced-supersededId为0', 'attachment_replaced', { attachments: [{ id: 1, original_name: 'a.png', attachment_type: 'delivery' }], count: 1, superseded_id: 0 });
                    runBad('replaced-supersededId为负数', 'attachment_replaced', { attachments: [{ id: 1, original_name: 'a.png', attachment_type: 'delivery' }], count: 1, superseded_id: -3 });
                    runBad('removed-缺uploaded_by_name键', 'attachment_removed', { attachment: { id: 1, original_name: 'a.png', attachment_type: 'delivery' } });
                    // removed 的 uploaded_by_name:null 是**合法占位**（非缺键）——siRenderAttachListHtml 用
                    // hasOwnProperty 区分「缺键」与「显式 null」，二者语义不同，不应被合并处理为一律回退。
                    const removedNullUploader = { id: 92, event_type: 'note', action_code: 'attachment_removed', summary: '删除附件：a.png', operator_name: '示例客服B', created_at: '2026-09-18 10:01:00', payload_json: JSON.stringify({ attachment: { id: 1, original_name: 'a.png', attachment_type: 'delivery', uploaded_by_name: null } }) };
                    const hOk = tl([removedNullUploader], [], '');
                    assert.ok(hOk.includes('si-tl-attach-list'), 'removed 的 uploaded_by_name:null 是合法占位，应正常展开 details（不应被误判为缺键回退）');
                    assert.ok(hOk.includes('（未知上传人）'), 'removed 的 uploaded_by_name:null 展开区应显示「（未知上传人）」占位符');
                });
                // ══ [S2 修复批2·codex 595 M1] attachTypeOk 严格类型判据——非字符串（数组会被 hasOwnProperty
                //   属性键转换误当合法字符串；{toString:null} 这种合法 JSON 值会在属性键转换时抛
                //   TypeError，中断整条时间线渲染）三码均须不抛错、静默回退，不得被 hasOwnProperty.call 的
                //   隐式类型转换蒙混过关 ══════════════════════════════════════════════════════
                check('[A 直调·H1·M1(codex 595)] attachment_type 非字符串（数组/含 toString 陷阱对象）三码均不抛错、静默回退 esc(summary)——不得被属性键隐式转换误判合法或致渲染中断', () => {
                    const summaryX = '恶意<script>alert(9)</script>摘要';
                    const escSummaryFrag = '&lt;script&gt;alert(9)&lt;/script&gt;';
                    const badTypeAdded = (t) => ({ id: 81, event_type: 'note', action_code: 'attachment_added', summary: summaryX, operator_name: '示例客服B', created_at: '2026-09-17 10:00:00', payload_json: JSON.stringify({ attachments: [{ id: 5, original_name: 'x', attachment_type: t }], count: 1 }) });
                    const badTypeReplaced = (t) => ({ id: 82, event_type: 'note', action_code: 'attachment_replaced', summary: summaryX, operator_name: '示例客服B', created_at: '2026-09-17 10:00:00', payload_json: JSON.stringify({ attachments: [{ id: 6, original_name: 'x', attachment_type: t }], count: 1, superseded_id: 5 }) });
                    const badTypeRemoved = (t) => ({ id: 83, event_type: 'note', action_code: 'attachment_removed', summary: summaryX, operator_name: '示例客服B', created_at: '2026-09-17 10:01:00', payload_json: JSON.stringify({ attachment: { id: 7, original_name: 'x', attachment_type: t, uploaded_by_name: '张三' } }) });
                    for (const [name, rowFn] of [['added', badTypeAdded], ['replaced', badTypeReplaced], ['removed', badTypeRemoved]]) {
                        for (const [caseName, t] of [['数组', ['spec']], ['toString 陷阱对象', { toString: null }]]) {
                            let h; let threw = null;
                            try { h = tl([rowFn(t)], [], ''); } catch (err) { threw = err; }
                            assert.ok(!threw, `${name} 路径 attachment_type=${caseName} 不应抛错，实抛出：${threw && threw.message}`);
                            assert.ok(!h.includes('si-tl-attach-list'), `${name} 路径 attachment_type=${caseName} 应静默回退，不出 details，实得：${h}`);
                            assert.ok(h.includes(escSummaryFrag), `${name} 路径 attachment_type=${caseName} 回退后应保留转义后的 summary，实得：${h}`);
                        }
                    }
                });
                // ══ [S2 修复批2·codex 595 M2] uploaded_by_name 恶意标签样本（文件名保持普通，隔离变量）+
                //   三码合法/非法 payload 下恶意 summary 均须转义——补白名单挡掉的那层安全回归防护 ══════
                check('[A 直调·H1·M2(codex 595)] uploaded_by_name 恶意标签样本（文件名普通）在 removed 路径被转义；三码合法/非法 payload 下恶意 summary（<script>/属性注入两种）均被转义、不含裸标签', () => {
                    const xssUploader = '<img src=x onerror=alert(1)>';
                    const removedBadUploader = { id: 83, event_type: 'note', action_code: 'attachment_removed', summary: '删除附件：a.png', operator_name: '示例客服B', created_at: '2026-09-17 10:01:00', payload_json: JSON.stringify({ attachment: { id: 7, original_name: '正常文件名.pdf', attachment_type: 'screenshot', uploaded_by_name: xssUploader } }) };
                    const hUploader = tl([removedBadUploader], [], '');
                    assert.ok(!hUploader.includes('<img src=x onerror'), `removed 路径 uploaded_by_name 恶意标签应转义，实得片段：${(hUploader.match(/<li>[^<]*<\/li>/) || ['(无)'])[0]}`);
                    assert.ok(hUploader.includes('&lt;img src=x onerror'), `removed 路径 uploaded_by_name 恶意标签应含转义后字面量，实得片段：${(hUploader.match(/<li>[^<]*<\/li>/) || ['(无)'])[0]}`);

                    const xssSummary = '恶意摘要<script>alert(2)</script>片段';
                    const escSummary = '&lt;script&gt;alert(2)&lt;/script&gt;';
                    const xssSummaryAttr = '恶意摘要" onmouseover="alert(3)片段';
                    const escSummaryAttr = '&quot; onmouseover=&quot;alert(3)';
                    const cases = [
                        ['added',
                            (s) => addedRow('正常文件名.pdf', { summary: s }),
                            (s) => Object.assign({}, addedRow('x', { summary: s }), { payload_json: JSON.stringify({ count: 0 }) })],
                        ['replaced',
                            (s) => Object.assign({}, replacedRow('正常文件名.pdf'), { summary: s }),
                            (s) => Object.assign({}, replacedRow('x'), { summary: s, payload_json: JSON.stringify({ attachments: [{ id: 6, original_name: 'x', attachment_type: 'delivery' }], count: 1 }) })],
                        ['removed',
                            (s) => Object.assign({}, removedRow('正常文件名.pdf'), { summary: s }),
                            (s) => Object.assign({}, removedRow('x'), { summary: s, payload_json: JSON.stringify({ attachment: { id: 7, original_name: 'x', attachment_type: 'archive', uploaded_by_name: '张三' } }) })],
                    ];
                    for (const [name, buildLegal, buildIllegal] of cases) {
                        for (const [tag, mal, escMal] of [['<script>', xssSummary, escSummary], ['属性注入', xssSummaryAttr, escSummaryAttr]]) {
                            const hLegal = tl([buildLegal(mal)], [], '');
                            assert.ok(!hLegal.includes(mal), `${name} 合法 payload + ${tag} summary：不应含裸恶意片段，实得：${hLegal.slice(0, 500)}`);
                            assert.ok(hLegal.includes(escMal), `${name} 合法 payload + ${tag} summary：应含转义后文本，实得：${hLegal.slice(0, 500)}`);
                            const hIllegal = tl([buildIllegal(mal)], [], '');
                            assert.ok(!hIllegal.includes(mal), `${name} 非法 payload + ${tag} summary：不应含裸恶意片段，实得：${hIllegal.slice(0, 500)}`);
                            assert.ok(hIllegal.includes(escMal), `${name} 非法 payload + ${tag} summary：应保留转义后的 summary（回退路径），实得：${hIllegal.slice(0, 500)}`);
                        }
                    }
                });
                // ══ [#67 §6.2/C2b/C12·四分支行为断言] ══════════════════════════════════════
                // 为什么在这里补：C10-b 删掉了两条**源码正则**（锁「三元表达式形态」与「直接传
                //   parsedPayload.changes」），因为 A9 引入适配器后调用参数变成了统一变量、那两条必红。
                //   方案 C12 要求「优先改为行为断言」——删了正则不补行为断言就是净损失。以下按
                //   §6.2 的四个分支逐条断**渲染结果**，不再断源码长相。
                const dcRow = (payload) => Object.assign({}, evtDateChange, { payload_json: payload });
                const hasFold = (h) => /查看改动/.test(h);
                const noteOf = (h) => (h.match(/（(历史记录[^）]*|修改明细不可用)）/) || [])[0] || '';
                check('[A 直调·#67 §6.2 分支1] changes 键存在且渲染非空 → 展开明细，不加任何说明文字', () => {
                    const h = tl([dcRow(JSON.stringify({ changes: [{ field: 'planned_date', old: '2026-09-20', new: '2026-09-25' }] }))], [], '');
                    assert.ok(hasFold(h), '应出现「查看改动」折叠');
                    assert.strictEqual(noteOf(h), '', `分支1 不应追加说明文字，实得「${noteOf(h)}」`);
                    assert.ok(h.includes('2026-09-20') && h.includes('2026-09-25'), '应渲染出前后两值');
                });
                check('[A 直调·#67 §6.2 分支2·A9 适配器] changes 键**不存在**但有旧键 planned_date_old/new → 用适配结果展开（T2 段记录）', () => {
                    const h = tl([dcRow(JSON.stringify({ planned_date_old: '2026-09-20', planned_date_new: '2026-09-25', reason: 'x', release_no: 'R-1' }))], [], '');
                    assert.ok(hasFold(h), 'T2 段（有旧键、无 changes）应能展开——这是 D5 方案1「渲染期适配」的核心');
                    assert.strictEqual(noteOf(h), '', `分支2 成功时不应追加说明文字，实得「${noteOf(h)}」`);
                    assert.ok(h.includes('2026-09-20') && h.includes('2026-09-25'), '适配结果应渲染出旧键的前后两值');
                    assert.ok(h.includes('计划上线日期'), '适配结果的 field 应是 planned_date、取到 A2 的中文标签');
                });
                check('[A 直调·#67 §6.2 分支2 边界] old 键存在但值为 null/空串 → 合法「原未设定」，展开且旧值显「（空）」', () => {
                    for (const ov of [null, '']) {
                        const h = tl([dcRow(JSON.stringify({ planned_date_old: ov, planned_date_new: '2026-09-25' }))], [], '');
                        assert.ok(hasFold(h), `old=${JSON.stringify(ov)} 应仍可展开（键存在即合法）`);
                        assert.ok(h.includes('（空）'), `old=${JSON.stringify(ov)} 的旧值应渲染「（空）」`);
                    }
                });
                // ⚠️ [577-M2 / 577-R L2 登记] 方案 568-R2 还要求「适配器返回非 null 但**渲染为空**时继续落分支4」。
                //   当前真实依赖下该返回值**不可达**：适配器硬编码 `field: 'planned_date'`（字符串），按
                //   siRenderTimelineChanges 的过滤规则至少产出一行 ⇒ 必返回非空串。
                //   ⇒ 本轮**不新增故障注入测试**，并**明确登记：该防御契约（调用方对空串的回退）未作行为验证**。
                //   ⚠️ 不写成「stub 渲染依赖就是假绿」——577-R 指出那不成立：保留真实调用方、只替换下游依赖，
                //     是能验证调用方契约的，只是不能证明该返回值在真实依赖下可达。这里是**范围取舍**，不是"已验证"。
                //   若将来适配结果可能被过滤规则全部丢弃（而非只是"扩到多字段"——多字段全合法时仍不可达），
                //     再补这条覆盖。
                check('[A 直调·#67 §6.2 分支2→4] 适配器判为损坏（缺 old 键 / 新值为空）→ 不停在分支2，落分支4「修改明细不可用」', () => {
                    // 缺 old 自有键 = 数据损坏（codex 568-R M1：正常写点恒写 old/new 两键，值可为 null）
                    //   若缺键时补成 null，会渲染出「（空）→ 新值」这种**半条明细**，方案明令禁止
                    const hMissOld = tl([dcRow(JSON.stringify({ planned_date_new: '2026-09-25' }))], [], '');
                    assert.ok(!hasFold(hMissOld), '缺 old 键不得展开（不得拼半条明细）');
                    assert.strictEqual(noteOf(hMissOld), '（修改明细不可用）', `缺 old 键应落分支4，实得「${noteOf(hMissOld)}」`);
                });
                // [577-R L1] 新值损坏那组**拆成独立 check**：原先与「缺 old 键」同处一个 check，而缺-old 的
                //   严格断言在循环**之前** ⇒ 它一抛错循环根本不执行，变异报告里看到的红就成了既有断言的红，
                //   **证不出新增断言的增量判别力**（codex 577-R 的 LOW-1，说得对）。拆开后两组各自可观测。
                check('[A 直调·#67 §6.2 分支2→4·新值损坏] 旧键齐全但**新值为空串/缺键** → 落分支4「修改明细不可用」（不得静默）', () => {
                    // [577-M2] 断的是**最终结果**——只断「不展开」的话，把这些输入改成静默返回摘要也能通过，
                    //   恰好漏掉 §6.2 要防的**静默空洞**（既不展开、也不提示异常）。
                    // ⚠️ [579-R L3] 本组只管**真正的数据损坏**（空串、缺键）。`null` 那一格已按 codex 579
                    //   的建议**拆到下面单独一条**（它是合法清空、性质不同）——原先写在这里的那段 null 说明
                    //   已随之删除，不留在本组制造"本组含 null"的错觉。
                    for (const nv of ['', undefined]) {
                        const p = { planned_date_old: '2026-09-20' };
                        p.planned_date_new = nv;
                        const h = tl([dcRow(JSON.stringify(p))], [], '');
                        assert.ok(!hasFold(h), `新值=${JSON.stringify(nv)} 不得展开`);
                        assert.strictEqual(noteOf(h), '（修改明细不可用）', `新值=${JSON.stringify(nv)} 应落分支4并提示，实得「${noteOf(h)}」——只断不展开会漏掉静默空洞`);
                    }
                });
                // ⚠️⚠️ [S4b·codex 579 rec] `new === null` 这一格**单独拆出来**，因为它和上面两格性质不同：
                //   空串与缺键是**真正的数据损坏**，而 `null` 是**合法的清空**（改期端点 normalizeDeadline
                //   明确「留空可清除」）。混在一组里会让人把「已知缺陷的现状刻画」误读成「正确的业务契约」
                //   （codex 579 原话：应「名称明确写『已知缺陷』，与空串、缺键的真正损坏用例分开」）。
                check('[A 直调·#67 §6.2 分支2·甲1 统一契约·2026-09-17] T2 段的**合法清空**（旧键齐、new 为 null）→ 展开且旧值显实值、新值显「（空）」、无说明文字', () => {
                    // 原为「现状刻画·待裁定」（记录当时被误报为「修改明细不可用」）。用户 2026-09-17 裁定：按 codex 578 收紧版——
                    //   两键须为自有属性 + 各自校验「字符串 或 null」，显式 null = 已保存的合法清空（改期端点 normalizeDeadline
                    //   「留空可清除」；verify-sys-release-date-change [2c] 断写点 changes[0].new 严格为 null）。
                    const p = { planned_date_old: '2026-09-20', planned_date_new: null };
                    const h = tl([dcRow(JSON.stringify(p))], [], '');
                    assert.ok(hasFold(h), '合法清空应可展开（不再落分支4）');
                    assert.strictEqual(noteOf(h), '', `合法清空不应带任何说明文字，实得「${noteOf(h)}」`);
                    const olds = [...h.matchAll(/si-tl-change-old"><span class="si-tl-change-tag">修改前<\/span><div class="si-tl-change-val">([\s\S]*?)<\/div>/g)].map(m => m[1]);
                    const news = [...h.matchAll(/si-tl-change-new"><span class="si-tl-change-tag">修改后<\/span><div class="si-tl-change-val">([\s\S]*?)<\/div>/g)].map(m => m[1]);
                    assert.strictEqual(olds.length, 1, `应恰 1 行明细，实得 ${olds.length}`);
                    assert.strictEqual(olds[0], '2026-09-20', `旧值应为实值，实得「${olds[0]}」`);
                    assert.ok(/（空）/.test(String(news[0])), `新值应显「（空）」，实得「${news[0]}」`);
                });
                check('[A 直调·#67 §6.2 分支2→4·甲1 收紧版·非法类型] 旧键存在但值为 false/数字/对象/数组（old 或 new 任一）→ 落分支4「修改明细不可用」', () => {
                    // codex 577-rec4 登记、578 收紧版 (b) 吞并的边界：键存在 ≠ 合法；非字符串非 null 的值是损坏，不得当有效适配。
                    for (const bad of [false, 0, 123, {}, [], ['2026-09-25'], { d: '2026-09-25' }]) {
                        for (const side of ['planned_date_old', 'planned_date_new']) {
                            const p = { planned_date_old: '2026-09-20', planned_date_new: '2026-09-25' };
                            p[side] = bad;
                            const h = tl([dcRow(JSON.stringify(p))], [], '');
                            assert.ok(!hasFold(h), `${side}=${JSON.stringify(bad)} 不得展开`);
                            assert.strictEqual(noteOf(h), '（修改明细不可用）', `${side}=${JSON.stringify(bad)} 应落分支4，实得「${noteOf(h)}」`);
                        }
                    }
                });
                check('[A 直调·#67 §6.2 分支1 vs 4 严格区分] changes 键**存在但值异常** → 落分支4，**不得用旧键掩盖异常**', () => {
                    // codex 568 H1：changes 键缺失但旧键有效=正常旧版（分支2）；changes 键存在但值异常=数据异常（分支4）
                    for (const bad of [{ changes: null }, { changes: 'x' }, { changes: [] }, { changes: [{}] }]) {
                        const p = Object.assign({ planned_date_old: '2026-09-20', planned_date_new: '2026-09-25' }, bad);
                        const h = tl([dcRow(JSON.stringify(p))], [], '');
                        assert.ok(!hasFold(h), `changes 异常(${JSON.stringify(bad)}) 时即便旧键有效也不得展开——那会用旧键掩盖新数据的异常`);
                        assert.strictEqual(noteOf(h), '（修改明细不可用）', `changes 异常应落分支4，实得「${noteOf(h)}」`);
                    }
                });
                check('[A 直调·#67 §6.2 前置守卫] payload 解析出**原始值/数组** → 直接落分支4，不抛错（禁对原始值用 in）', () => {
                    // 方案前置守卫：对原始值用 `in` 会抛 TypeError 并**中断整条时间线渲染**
                    // [577-M2] 同样补断最终结果。注意 'null' 解析出的是 null ⇒ payload_json 字符串本身
                    //   非空、但解析值为 null ⇒ 按 §6.2 应落**分支4**（payload_json 非空那一支）。
                    for (const raw of ['"juststring"', '123', 'null', '[1,2]', '[]']) {
                        const h = tl([dcRow(raw)], [], '');
                        assert.ok(typeof h === 'string' && h.length > 0, `payload=${raw} 不得中断渲染`);
                        assert.ok(!hasFold(h), `payload=${raw} 不得展开`);
                        assert.strictEqual(noteOf(h), '（修改明细不可用）', `payload=${raw} 应落分支4并提示，实得「${noteOf(h)}」`);
                    }
                });
                check('[A 直调·#67 §6.2 分支3a] 豁免码（assign_overdue_eta）payload 为空 → **无任何说明文字**', () => {
                    const base = { id: 73, event_type: 'note', action_code: 'assign_overdue_eta', summary: '超时指派：预计完成时间由甲重填为 2026-09-30（原值 2026-09-25）', operator_name: '示例客服B', created_at: '2026-09-16 10:02:00' };
                    for (const pj of [null, '']) {
                        const h = tl([Object.assign({}, base, { payload_json: pj })], [], '');
                        assert.deepStrictEqual(badge(h), { cls: 'si-tl-rose', label: '✎ 变更留痕' }, 'ETA 变更码应进 changes 分支换徽章');
                        assert.strictEqual(noteOf(h), '', `豁免码 payload 空时不得加说明文字（其 summary 已自足，加提示是假警报），实得「${noteOf(h)}」`);
                    }
                });
                check('[A 直调·#67 §6.2 分支3b] 非豁免码 payload 为空 → 「历史记录，未保存修改明细」', () => {
                    for (const pj of [null, '']) {
                        const h = tl([dcRow(pj)], [], '');
                        assert.strictEqual(noteOf(h), '（历史记录，未保存修改明细）', `改期码（非豁免）payload 空时应报历史提示，实得「${noteOf(h)}」`);
                    }
                });
                check('[A 直调·#67 §6.3] 豁免只作用于分支3a——豁免码 payload **非空但异常** 仍报「修改明细不可用」', () => {
                    const base = { id: 74, event_type: 'note', action_code: 'assign_overdue_eta', summary: 'x', operator_name: '示例客服B', created_at: '2026-09-16 10:03:00' };
                    const h = tl([Object.assign({}, base, { payload_json: JSON.stringify({ changes: [] }) })], [], '');
                    assert.strictEqual(noteOf(h), '（修改明细不可用）', `豁免不影响分支4（payload 非空却读不出明细是真异常），实得「${noteOf(h)}」`);
                });
                // [577-M1] C11 扩展覆盖：方案要求的不只是「原六组仍通过」，还要**四码遍历已知错误类型**
                //   与**「未登记码且缺 event_type」定点用例**。原先只加了 release_add 一条负向，
                //   据此宣布 C11 达标是**过度声称**（codex 577-M1）。下面按预期配对表生成全组合。
                // [577-R rec1] 预期表**保持独立来源**（不从被测 Map 反推，否则负向组合会随实现漂移），
                //   但**另加一条与真实 Map 的键值对拍**——否则将来只改生产 Map 与 A1、漏改这里，
                //   16 组会静默变成「测老四码」。对拍红了就是提醒人同时更新两处。
                const EXPECT_PAIR = {
                    release_info_edit: 'note',
                    edit_in_revision: 'note',
                    release_date_change: 'scope_change',
                    assign_overdue_eta: 'note',
                    // [乙4·2026-09-17 B1] 时间线留痕覆盖面补齐 v0.2 §5 B1 新增三码：
                    estimate_eta: 'estimate',
                    set_scheduled_start: 'note',
                    set_oa_number: 'note',
                };
                check('[A 直调·#67 A5/C11 扩展] 七码 × 各自的错误 event_type 一律不换变更徽章、不展开', () => {
                    // [577-R2 rec5] 组数不再手写常数——由**独立的类型集合**与预期表算出，新增码/新增类型时
                    //   自动跟上；并另断「每个预期类型都属于该集合」，否则集合漏了某类型会让遍历少跑而不报。
                    // [乙4·2026-09-17] +'estimate'——estimate_eta 的期望类型是 'estimate'，须在 ALL_TYPES
                    //   里才能被遍历到（否则漏跑「estimate_eta 配错误类型」这一组，也漏跑「老码配 estimate
                    //   类型」这组负向对照）。
                    const ALL_TYPES = ['note', 'scope_change', 'status_change', 'release', 'created', 'estimate'];
                    for (const t of Object.values(EXPECT_PAIR)) {
                        assert.ok(ALL_TYPES.includes(t), `预期类型 ${t} 不在 ALL_TYPES 里——遍历会少跑一组且不报错`);
                    }
                    const expectN = Object.keys(EXPECT_PAIR).length * (ALL_TYPES.length - 1);
                    let n = 0;
                    for (const [code, okType] of Object.entries(EXPECT_PAIR)) {
                        for (const badType of ALL_TYPES.filter((t) => t !== okType)) {
                            const h = tl([{ id: 90 + n, event_type: badType, action_code: code, summary: 'x', ref_id: 9, operator_name: '示例客服B', created_at: '2026-09-16 11:00:00', payload_json: JSON.stringify({ changes: [{ field: 'planned_date', old: 'a', new: 'b' }] }) }], [], '');
                            const bd = badge(h) || {};
                            assert.notStrictEqual(bd.label, '✎ 变更留痕', `${code} + ${badType} 不得换变更徽章（配对不成立）`);
                            assert.ok(!hasFold(h), `${code} + ${badType} 不得展开`);
                            n += 1;
                        }
                    }
                    assert.strictEqual(n, expectN, `应跑满 ${Object.keys(EXPECT_PAIR).length} 码 × ${ALL_TYPES.length - 1} 种错误类型 = ${expectN} 组，实得 ${n}`);
                });
                check('[A 直调·#67 A5/C11 扩展·577-R rec1] 负向用例的预期配对表与生产 Map **键值逐项一致**（防只改一处的静默漂移）', () => {
                    const mMap = src.match(/const SI_TL_CHANGE_CODES = new Map\(\[([\s\S]*?)\]\);/);
                    assert.ok(mMap, '未提取到 SI_TL_CHANGE_CODES');
                    const entryRe = /\[\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'\s*\]/g;
                    const real = Object.fromEntries([...mMap[1].matchAll(entryRe)].map((m) => [m[1], m[2]]));
                    // [577-R2 L4] **先验解析完备性再对拍**：只收集"能识别的条目"时，将来新增双引号条目/
                    //   变量条目/展开项会被**静默忽略**，原四项仍相等 ⇒ 对拍失去「防新增码遗漏」的作用。
                    //   故把已识别条目从列表里剔除，残留必须只剩逗号与空白；否则立即失败而不是默默放过。
                    const leftover = mMap[1].replace(/\[\s*'[a-z_]+'\s*,\s*'[a-z_]+'\s*\]/g, '').replace(/[\s,]/g, '');
                    assert.strictEqual(leftover, '', `SI_TL_CHANGE_CODES 的初始化列表里有本断言**无法识别**的内容（残留「${leftover}」）——静态提取已不完备，对拍会漏掉这些条目，请改用装配导出实际 Map 或扩展提取语法`);
                    assert.deepStrictEqual(EXPECT_PAIR, real, '上面负向用例的预期表与生产 Map 已不一致——新增/改动码时两处都要更新（预期表刻意不从 Map 反推，故只能靠本条对拍）');
                });
                check('[A 直调·#67 A5/C11 扩展] 未登记码 ∧ **缺失 event_type** → 不进分支（这是 has() 不可省要防的核心场景）', () => {
                    // 若判据写成只有 get(码) === e.event_type（省掉 has）：未登记码 get() 返回 undefined，
                    //   该行又缺 event_type（也是 undefined）⇒ undefined === undefined 成立 ⇒ 异常行被放进分支。
                    //   本用例是那条漏洞的**行为级**定点验证（源码正则只能证明 has 这段文本还在）。
                    const h = tl([{ id: 120, action_code: 'totally_unknown_code', summary: '某个未登记码的事件', ref_id: 9, operator_name: '示例客服B', created_at: '2026-09-16 11:10:00', payload_json: JSON.stringify({ changes: [{ field: 'planned_date', old: 'a', new: 'b' }] }) }], [], '');
                    const bd = badge(h) || {};
                    assert.notStrictEqual(bd.label, '✎ 变更留痕', '未登记码 + 缺 event_type 不得换变更徽章');
                    assert.ok(!hasFold(h), '未登记码 + 缺 event_type 不得展开明细');
                    // 同族：已登记码 + 缺 event_type 也不得进（get 返回 'note'，与 undefined 不等 ⇒ 天然挡住）
                    const h2 = tl([{ id: 121, action_code: 'edit_in_revision', summary: 'x', operator_name: '示例客服B', created_at: '2026-09-16 11:11:00', payload_json: JSON.stringify({ changes: [{ field: 'title', old: 'a', new: 'b' }] }) }], [], '');
                    assert.notStrictEqual((badge(h2) || {}).label, '✎ 变更留痕', '已登记码 + 缺 event_type 也不得换徽章');
                });
                // [577-R M] 断言必须**定位到展开区的明细行**逐单元格核对，不能在整页 HTML 里 includes——
                //   「预计完成时间」头行里就有、日期在 summary 里也有 ⇒ 整页 includes 是**恒真于本夹具**的假绿：
                //   明细行的字段标签或新值丢了照样通过（codex 577-R 的 MEDIUM）。
                //   配套：夹具 summary 改成**中性文本**（不含字段中文名与日期），减少其他整页级断言的误匹配;
                //   明细行的字段名与前后值由**行级断言**验证——其作用域由 changeRows 决定，与 summary 无关
                //   （原注释写「日期写回 summary 会让行级断言退化成整页 includes」是**错的**，577-R2 已纠正）。
                const changeRows = (h) => {
                    const det = String(h).match(/<details class="si-tl-release-json">[\s\S]*?<\/details>/);
                    if (!det) return [];
                    return det[0].split('<div class="si-tl-change-row">').slice(1).map((seg) => ({
                        label: (seg.match(/^<div class="si-tl-change-field">([\s\S]*?)<\/div>/) || [, null])[1],
                        old: (seg.match(/si-tl-change-old"><span class="si-tl-change-tag">修改前<\/span><div class="si-tl-change-val">([\s\S]*?)<\/div>/) || [, null])[1],
                        new: (seg.match(/si-tl-change-new"><span class="si-tl-change-tag">修改后<\/span><div class="si-tl-change-val">([\s\S]*?)<\/div>/) || [, null])[1],
                    }));
                };
                check('[A 直调·#67 A2/A8·577-M3+R] ETA 变更正常展开：明细行**逐单元格**核对字段标签/旧值/新值 + 头行文案 + 不含批次编号', () => {
                    // 该码**不写 ref_id**，A8 故意不拼批次号——拼了会渲染出「批次 #NaN」。
                    //   原先 ETA 只有「空 payload 豁免」与「异常 payload」两条用例，缺正常展开路径
                    //   ⇒ 删掉 A8 的 ETA 分支或改错 A2 的中文标签都测不出来（codex 577-M3）。
                    const etaRow = { id: 122, event_type: 'note', action_code: 'assign_overdue_eta', summary: '改派时由人工重新设定了交付时点', operator_name: '示例客服B', created_at: '2026-09-16 11:12:00', payload_json: JSON.stringify({ changes: [{ field: 'dev_estimated_at', old: null, new: '2026-09-30' }] }) };
                    // [577-R2 L3] 断的必须是**真正传入 tl 的那个对象**。原先对另写的一份字面量做正则，
                    //   改夹具不会让它失败 = 锁字面量而非锁真相（codex 577-R2 指出，说得对）。
                    assert.ok(!/预计完成时间|2026-09-30/.test(etaRow.summary), '夹具 summary 须保持中性（不含字段中文名与日期），以免下面的整页级断言误匹配到摘要');
                    const h = tl([etaRow], [], '');
                    assert.deepStrictEqual(badge(h), { cls: 'si-tl-rose', label: '✎ 变更留痕' }, 'ETA 正常 changes 应换变更留痕徽章');
                    assert.ok(hasFold(h), 'ETA 正常 changes 应可展开');
                    assert.ok(h.includes('变更对象：预计完成时间 · '), `展开区头行应落 A8 的 ETA 分支文案，实得：${(h.match(/变更对象：[^<]*/) || ['(无)'])[0]}`);
                    assert.ok(!/批次 #/.test(h), '该码不写 ref_id，头行不得拼批次号（否则出「批次 #NaN」）');
                    // [581-R L1] 原先这里还有一条对**另写的一份 summary 字面量**做的正则断言，
                    //   与上面那条针对真实 etaRow.summary 的检查重复、且改夹具不会让它失败
                    //   ——正是 577-R2 批过的「锁字面量而非锁真相」，我在上方注释里自陈已订正、
                    //   却把同一形态又写了一遍（codex 581-R 指出，成立）⇒ 删除。
                    //   下面通过 changeRows 定位明细单元格，独立核对字段与前后值。
                    const rows = changeRows(h);
                    assert.strictEqual(rows.length, 1, `展开区应恰有 1 行明细，实得 ${rows.length}`);
                    assert.strictEqual(rows[0].label, '预计完成时间', `明细行字段标签应取 A2 的中文名，实得「${rows[0].label}」`);
                    assert.strictEqual(rows[0].new, '2026-09-30', `明细行「修改后」单元格应是新值，实得「${rows[0].new}」`);
                    assert.ok(/（空）/.test(String(rows[0].old)), `首次设定 old=null 属合法「原未设定」，「修改前」单元格应显「（空）」，实得「${rows[0].old}」`);
                    assert.ok(!/（空）/.test(String(rows[0].new)), '「修改后」单元格不得显「（空）」（新值有实值）');
                    assert.strictEqual(noteOf(h), '', `正常展开时不应追加说明文字，实得「${noteOf(h)}」`);
                });
                // ══ [S4·C8 数据形态矩阵补格·方案 §7.2] ══
                //   S1-S3 已逐条覆盖 17 格中的绝大多数（见上方各 §6.2 行为断言与 567-M2 那组）。
                //   本段只补**核对后确认缺失**的格，不重复造已覆盖的：
                //     · 格8「changes 混合数组（部分有效）」—— 全文搜过，此前无任何用例
                //     · 格14「ETA payload NULL × **三种文案分支各一**」—— 此前只有「超时指派」一条
                //     · codex 578-R2 追加要求的「**新载荷合法清空**」—— 渲染层此前没有（[2c] 只断库层）
                //     · 格17「过滤开关 × 每种形态」—— 压成一条**有判别力**的断言（见该条注释）
                check('[A 直调·#67 C8 格2·真实 T1 摘要] 用生产 #176 的**实际摘要**（无冒号/无 X→Y/无批次号）+ payload NULL → 「历史记录，未保存修改明细」', () => {
                    // [codex 579 rec] 原先格2 只造了「payload 为 NULL」的合成夹具 —— 那覆盖的是**载荷分支**，
                    //   不等于「真实 T1 摘要兼容验收」。方案 §7.1 记了生产 #176 那行的实际摘要：
                    //   「上线计划日期变更，通知与执行人已重置」——**无冒号、无 `X → Y`、无批次号**，
                    //   与 v1.172.0 后的模板逐字不同（这正是 T1/T2 分界在真实数据上成立的实证依据）。
                    //   ⇒ 用那条真实摘要再跑一遍，确认摘要文本本身不参与分支判定、且被原样转义输出。
                    const T1_SUMMARY = '上线计划日期变更，通知与执行人已重置';
                    for (const pj of [null, '']) {
                        const h = tl([Object.assign({}, evtDateChange, { summary: T1_SUMMARY, payload_json: pj })], [], '');
                        assert.deepStrictEqual(badge(h), { cls: 'si-tl-rose', label: '✎ 变更留痕' }, `T1 摘要 + payload=${JSON.stringify(pj)} 仍应换 ✎ 徽章（v1.172.1：历史行也换）`);
                        assert.ok(!hasFold(h), `T1 摘要 + payload=${JSON.stringify(pj)} 不得出现展开区`);
                        assert.strictEqual(noteOf(h), '（历史记录，未保存修改明细）', `T1 摘要 + payload=${JSON.stringify(pj)} 应报历史提示（改期码不在 §6.3 豁免集合里），实得「${noteOf(h)}」`);
                        // ⚠️ [579-R L3] 这条验的是**该真实摘要被完整保留**与它走的兼容分支，
                        //   **不是**转义判别力——这条摘要里没有需要转义的字符（只有中文逗号）。
                        //   转义行为由上方专门那条「值含 <script> 与引号被转义」的用例负责。
                        assert.ok(h.includes(T1_SUMMARY), `该真实摘要应被完整保留在渲染结果里，实得未含「${T1_SUMMARY}」`);
                    }
                });
                check('[A 直调·#67 C8 格8] changes **混合数组**（部分有效）→ 保留有效项照常展开，不因存在无效项整体判失败', () => {
                    // 方案 §7.2：「保留有效项照常展开，不整体判失败」。无效项的丢弃条件是
                    //   `!c || typeof c !== 'object' || Array.isArray(c) || typeof c.field !== 'string'`。
                    //   未登记的 field 是**有效项**（渲染时回退成裸字段名），不是无效项——这是本格容易搞错的地方。
                    const p = { changes: [
                        { field: 'planned_date', old: '2026-09-20', new: '2026-09-25' },
                        {},
                        { field: 123, old: 'a', new: 'b' },
                        null,
                        [{ field: 'planned_date' }],
                        { field: 'some_unregistered_field', old: 'x', new: 'y' },
                    ] };
                    const h = tl([dcRow(JSON.stringify(p))], [], '');
                    assert.ok(hasFold(h), '混合数组应仍可展开（有有效项就不该整体判失败）');
                    assert.strictEqual(noteOf(h), '', `混合数组有有效项时不应追加说明文字，实得「${noteOf(h)}」`);
                    const rows = changeRows(h);
                    assert.strictEqual(rows.length, 2, `应恰渲染 2 行（planned_date + 未登记字段），实得 ${rows.length}：${JSON.stringify(rows)}`);
                    assert.strictEqual(rows[0].label, '计划上线日期', `第 1 行取 A2 中文名，实得「${rows[0].label}」`);
                    assert.strictEqual(rows[1].label, 'some_unregistered_field', `第 2 行未登记字段回退**裸字段名**，实得「${rows[1].label}」`);
                    // [579-L1] 光断标签不够——「保留了字段却丢/串了值」这种退化测不出来 ⇒ 两行的前后值都要断
                    assert.strictEqual(rows[0].old, '2026-09-20', `第 1 行「修改前」实得「${rows[0].old}」`);
                    assert.strictEqual(rows[0].new, '2026-09-25', `第 1 行「修改后」实得「${rows[0].new}」`);
                    assert.strictEqual(rows[1].old, 'x', `第 2 行「修改前」实得「${rows[1].old}」`);
                    assert.strictEqual(rows[1].new, 'y', `第 2 行「修改后」实得「${rows[1].new}」`);
                    // [579-R L2] 折叠计数要**单独提取 `<summary>` 元素**再断——整页搜「查看改动（2 项）」的话，
                    //   折叠摘要里的计数写错、而该字符串恰好出现在别处，仍会通过（codex 579-R 指出，成立）。
                    const sum8 = (h.match(/<summary>([\s\S]*?)<\/summary>/) || [, ''])[1];
                    assert.strictEqual(sum8, '查看改动（2 项）', `折叠摘要本身的计数应为有效项数 2，实得 summary「${sum8}」`);
                    const head8 = (h.match(/<div class="si-tl-change-head">([\s\S]*?)<\/div>/) || [, ''])[1];
                    assert.ok(/（2 项）/.test(head8), `展开区头行的计数也应为 2，实得头行「${head8}」`);
                });
                check('[A 直调·#67 C8 格14] ETA payload NULL × **三种文案分支各一** → 一律无说明文字、无展开', () => {
                    // 方案 §7.2 写的是「三种文案分支各一」，此前只造了「超时指派」一条。
                    //   三条文案来自 index.js 的 /reassign：overdue → 「超时指派」；oldEta 非空 → 「人工更新」
                    //   （该分支在本端点已 structurally 不可达，但写点代码仍在、时间线里可能存有历史行）；
                    //   否则 → 「人工设定」。它们共用同一个 action_code，故渲染层必须三条都无提示。
                    const SUMS = [
                        '超时指派：预计完成时间由甲重填为 2026-09-30（原值 2026-09-25）',
                        '改派时人工更新预计完成时间：甲 更新为 2026-09-30（原值 2026-09-25）',
                        '改派时人工设定预计完成时间：甲 填写为 2026-09-30',
                    ];
                    let n = 0;
                    for (const summary of SUMS) {
                        for (const pj of [null, '']) {
                            const h = tl([{ id: 130 + n, event_type: 'note', action_code: 'assign_overdue_eta', summary, operator_name: '示例客服B', created_at: '2026-09-16 12:00:00', payload_json: pj }], [], '');
                            assert.deepStrictEqual(badge(h), { cls: 'si-tl-rose', label: '✎ 变更留痕' }, `「${summary.slice(0, 6)}…」payload=${JSON.stringify(pj)} 仍应换 ✎ 徽章（v1.172.1：历史行也换）`);
                            assert.ok(!hasFold(h), `「${summary.slice(0, 6)}…」payload=${JSON.stringify(pj)} 不得出现展开区`);
                            assert.strictEqual(noteOf(h), '', `「${summary.slice(0, 6)}…」payload=${JSON.stringify(pj)} 不得加说明文字（§6.3 豁免：三条文案都自带前后值，加提示是假警报），实得「${noteOf(h)}」`);
                            n += 1;
                        }
                    }
                    assert.strictEqual(n, 6, `应跑满 3 种文案 × 2 种空 payload = 6 组，实得 ${n}`);
                });
                check('[A 直调·#67 C8·578-R2 追加] **新载荷合法清空**（changes 键存在、new 为 null）→ 展开且新值显「（空）」', () => {
                    // codex 578-R2 明确要求 S4 覆盖「新载荷合法清空」。历史上它曾是 §9 第 3 项争议的对照证据
                    //   （当时旧键路径把 nv=null 判进「新值损坏」组显「修改明细不可用」，两条路径结论相反）。
                    //   ⚠️ [S2c·codex 582 L 订正] 2026-09-17 裁定后旧键路径已改（见上方「甲1 统一契约」合法清空条）：
                    //   现在本条与那条**共同锁定**同一个「改为未设定」语义在两条路径上**均展开、新值均显「（空）」**——
                    //   不再有「供裁定」的分歧，本注释不再引用已不存在的 nv=null 损坏用例。
                    const p = { changes: [{ field: 'planned_date', old: '2026-09-20', new: null }] };
                    const h = tl([dcRow(JSON.stringify(p))], [], '');
                    assert.deepStrictEqual(badge(h), { cls: 'si-tl-rose', label: '✎ 变更留痕' }, '合法清空仍是变更留痕');
                    assert.ok(hasFold(h), '合法清空应可展开（changes 键存在且渲染非空）');
                    assert.strictEqual(noteOf(h), '', `合法清空不得报异常文案，实得「${noteOf(h)}」`);
                    const rows = changeRows(h);
                    assert.strictEqual(rows.length, 1, `应恰 1 行明细，实得 ${rows.length}`);
                    assert.strictEqual(rows[0].label, '计划上线日期', `字段名应为「计划上线日期」，实得「${rows[0].label}」`);
                    assert.strictEqual(rows[0].old, '2026-09-20', `「修改前」应是清空前的日期，实得「${rows[0].old}」`);
                    assert.ok(/（空）/.test(String(rows[0].new)), `「修改后」应显「（空）」，实得「${rows[0].new}」`);
                });
                // ⚠️ [581-R2 M2 → 甲1 统一契约·2026-09-17] 新载荷 changes 项**缺 old/new 自有键**：原为「现状刻画·待裁定」
                //   （当时缺 old 会显示成「（空）→ 新值」，与显式 null 不可分辨，与旧键路径「缺键=损坏」结论相反）。
                //   用户 2026-09-17 裁定选 A：统一为严格三键契约，与 §9 第 3 项合并实施 ⇒ 本条改为**锁目标契约**：
                //   缺键项按自有属性过滤（不计数）、显式 null 保留；全部项无效时落既有「（修改明细不可用）」出口。
                //   ⚠️ 这推翻了「[A 直调] 缺损项规则」那条（原 :1739 一带）锁定的 565-R M5「缺键显（空）保留计数」（那条已同步改写为「甲1 统一契约」）。
                check('[A 直调·#67 §6.2·甲1 统一契约·2026-09-17] 新载荷 changes 项缺 old/new 自有键 → 该项过滤；全缺则落分支4；显式 null 保留——与旧键路径结论一致', () => {
                    const hMissOld = tl([dcRow(JSON.stringify({ changes: [{ field: 'planned_date', new: '2026-09-25' }] }))], [], '');
                    assert.ok(!hasFold(hMissOld), '缺 old 的新载荷不得展开（不得拼半条明细）');
                    assert.strictEqual(noteOf(hMissOld), '（修改明细不可用）', `缺 old 应落分支4，实得「${noteOf(hMissOld)}」`);
                    const hMissNew = tl([dcRow(JSON.stringify({ changes: [{ field: 'planned_date', old: '2026-09-20' }] }))], [], '');
                    assert.ok(!hasFold(hMissNew), '缺 new 的新载荷不得展开');
                    assert.strictEqual(noteOf(hMissNew), '（修改明细不可用）', `缺 new 应落分支4，实得「${noteOf(hMissNew)}」`);
                    // 混合：缺键项过滤、齐全项照常 ⇒ 展开且只计 1 项
                    const hMixed = tl([dcRow(JSON.stringify({ changes: [{ field: 'planned_date', new: '2026-09-25' }, { field: 'planned_date', old: '2026-09-20', new: '2026-09-25' }] }))], [], '');
                    assert.ok(hasFold(hMixed), '混合数组应展开（有效项保留）');
                    assert.strictEqual(changeRows(hMixed).length, 1, `混合数组只计齐全项，实得 ${changeRows(hMixed).length}`);
                    // 显式 null 保留：这是「合法首次设定」，与缺键必须可分辨
                    const hNull = tl([dcRow(JSON.stringify({ changes: [{ field: 'planned_date', old: null, new: '2026-09-25' }] }))], [], '');
                    assert.ok(hasFold(hNull), '显式 old=null 应展开');
                    const rN = changeRows(hNull);
                    assert.strictEqual(rN.length, 1, `显式 null 应恰 1 行，实得 ${rN.length}`);
                    assert.ok(/（空）/.test(String(rN[0].old)) && rN[0].new === '2026-09-25', `应为「（空）→ 2026-09-25」，实得 ${rN[0].old} / ${rN[0].new}`);
                    // [S2b·Opus 预筛 M1] 非法类型维度同样对齐：changes 项 old 为对象 ⇒ 过滤 ⇒ 全无效 ⇒ 分支4，与旧键路径 {} 判损坏一致
                    const hObj = tl([dcRow(JSON.stringify({ changes: [{ field: 'planned_date', old: {}, new: '2026-09-25' }] }))], [], '');
                    assert.ok(!hasFold(hObj), 'changes 项 old 为对象不得展开');
                    assert.strictEqual(noteOf(hObj), '（修改明细不可用）', `changes 项 old 为对象应落分支4，实得「${noteOf(hObj)}」`);
                    // 对照：同一「缺 old」形态走旧键路径 ⇒ 同样判损坏 ⇒ 两条路径结论**一致**（这正是本次统一的目的）
                    const hLegacyMissOld = tl([dcRow(JSON.stringify({ planned_date_new: '2026-09-25' }))], [], '');
                    assert.strictEqual(noteOf(hLegacyMissOld), '（修改明细不可用）', '对照：旧键路径缺 old 判损坏，与新载荷路径一致');
                });
                check('[A 直调·#67 C8·载荷×归属关系回归] 可隐藏性归属**不随载荷形态变化**——同一码在 **15 种**载荷下归属恒定（原 11 项 + 579-R6 补 4 项对应格 5/6/7）', () => {
                    // ══ [579-R6 收口记录] 本条在格17 里的位置，以及两处**不能写成"已覆盖"**的格 ══
                    //   · **格9**（适配器返回非 null 但渲染为空）=「**已接受范围豁免**：当前真实依赖下
                    //     不可达（适配器硬编码 `field: 'planned_date'` 字符串字面量、返回非 null 的前提
                    //     已含新值非空 ⇒ 必产出至少一行），该防御契约**未作行为验证**」。
                    //     ⚠️ codex 579-R6 明确：**不得标为已覆盖**，且格17 的验收范围应**注明排除此豁免形态**。
                    //   · **格5**（新值为空 → 落异常）要**拆开写**：`空串／缺键` = 有契约断言；
                    //     `null` = **合法清空**（2026-09-17 裁定后已是契约断言，见上方「甲1 统一契约」合法清空条；
                    //     原「现状刻画·待裁定」口径作废）。
                    // ⚠️ [579-M1 降级定位] 本条**不是**方案 §7.2 格17（「过滤开关 × 每种形态」）的完整验收
                    //   ——它**没有开启过滤开关**、不验实际可见性、不遍历 8 个可隐藏码。开关事件失效／
                    //   容器状态未切换／过滤样式失效／其他白名单码归属错误，都可能穿过本条（codex 579-M1
                    //   指出，成立）。⇒ 本条的准确定位是「**载荷与归属关系的回归测试**」；格17 的开关验收
                    //   由下一条（8 码 × 开关开启）与 C6 的浏览器实证第 ⑫ 组共同承担。
                    // 为什么这个回归值得单列：A3 的判据（siTlIsHidableScope）只看 event_type + action_code，
                    //   与 payload **结构上无关**。
                    // ⚠️ [579-L2 / 579-R L3 / 579-R7 LOW 三次收窄] 本条**覆盖所列 15 种形态**
                    //   （原 11 项 + 579-R6 补的 4 项，对应方案格 5/6/7）、**能捕获"载荷为真值即改变归属"
                    //   这一类变异**（实测变异：`if (e && e.payload_json) return false;` → 本条红）。
                    //   **不**声称"锁死一切引入载荷的改法"，也**不**声称那 15 种形态都被执行过——
                    //   断言遇错即抛，红在第一个触发的形态上（前段原有的宽泛承诺已删，避免与本段自相矛盾）。
                    // ⚠️ [579-R7 订正我自己一处**过度自谦**] 我原先说 579-R6 新增那 4 项"不新增判别力"——
                    //   codex 指出这**不能泛化**：准确说法是"对**已讨论的那个**『载荷为真值即改变归属』
                    //   变异没有新增区分能力"；而**只在缺旧键时错误改变归属**这类改法，**恰恰只有新增项
                    //   能捕获**。⇒ 它们既补覆盖对应性、也确实带来针对特定形态的判别力。
                    // ⚠️ [579-R6 M] 补 **4 项**（覆盖方案格 5/6/7）**此前不在本表里**的载荷形态——codex 把格17 的剩余缺口
                    //   具体定位到方案 §7.2 的格 5/6/7：那三格此前只有**明细语义**断言
                    //   （不展开 + 异常说明），**没有断言目标行的可隐藏归属**。本表正是管"归属"的，
                    //   把那三种载荷加进来即一处补齐三格的归属证据。原话：「复用这些既有夹具，
                    //   补充目标行的归属断言，再连接已经接受的共同归属判据及开关验证即可」。
                    const FORMS = [
                        null,
                        '',
                        'not-json',
                        '"juststring"',
                        '123',
                        'null',
                        '[1,2]',
                        JSON.stringify({ planned_date_old: '2026-09-20', planned_date_new: '2026-09-25' }),
                        JSON.stringify({ changes: [{ field: 'planned_date', old: 'a', new: 'b' }] }),
                        JSON.stringify({ changes: null }),
                        JSON.stringify({ changes: [] }),
                        // ↓↓ [579-R6 M] 新增 **4 项**，逐项标明它对应方案 §7.2 的哪一格 ↓↓
                        // 格6：缺 planned_date_old（只有 new 键的损坏对象）
                        JSON.stringify({ planned_date_new: '2026-09-25' }),
                        // 格5：缺 planned_date_new（旧键齐但新键缺）——空串那半由下一项覆盖
                        JSON.stringify({ planned_date_old: '2026-09-20' }),
                        // 格5：planned_date_new 为空串（真正的损坏，与"合法清空"的 null 不同）
                        JSON.stringify({ planned_date_old: '2026-09-20', planned_date_new: '' }),
                        // 格7/11/13：无效 changes **与有效旧键同时存在**（禁止回退的诱饵形态）
                        JSON.stringify({ planned_date_old: '2026-09-20', planned_date_new: '2026-09-25', changes: [{}] }),
                    ];
                    // ⚠️ [581-R L2] 原先这两条用 `/si-tl-release-scope/.test(h)` 在**整段 HTML** 里搜子串，
                    //   **没有确认该令牌属于事件行本身**——若某个载荷路径让这个字符串出现在子节点或
                    //   其他文本里，白名单行即使丢了目标 class 也照样通过（本文件已有 firstItemAttrs
                    //   却没在这组用上·codex 581-R 指出，成立）。改为逐条提取事件行属性：
                    //   **先断事件行存在**，再按**完整 class 令牌**核归属，不再吃整页子串。
                    let n = 0;
                    for (const pj of FORMS) {
                        const tag = `payload=${JSON.stringify(pj)}`;
                        // 改期码：**任何**载荷形态下事件行都在、且都不带可隐藏令牌
                        const aDc = firstItemAttrs(tl([Object.assign({}, evtDateChange, { payload_json: pj })], [], ''));
                        assert.ok(aDc, `改期行在 ${tag} 下应渲染出事件行（firstItemAttrs 取不到 = 结构变了或没渲染）`);
                        assert.strictEqual(aDc.has('si-tl-release-scope'), false,
                            `改期行在 ${tag} 下仍不得带 si-tl-release-scope 令牌，实得 class「${aDc.cls}」`);
                        // 白名单码（release_add）：**任何**载荷形态下都带（双向对照，防"恰好都不带"）
                        const aAdd = firstItemAttrs(tl([Object.assign({}, evtHidable, { payload_json: pj })], [], ''));
                        assert.ok(aAdd, `白名单码在 ${tag} 下应渲染出事件行`);
                        assert.strictEqual(aAdd.has('si-tl-release-scope'), true,
                            `白名单码在 ${tag} 下应带 si-tl-release-scope 令牌，实得 class「${aAdd.cls}」`);
                        n += 1;
                    }
                    assert.strictEqual(n, FORMS.length, `应跑满 ${FORMS.length} 种载荷形态（含 579-R6 补的格 5/6/7 三种），实得 ${n}`);
                    assert.strictEqual(FORMS.length, 15, `载荷形态表应为 15 项（原 11 + 579-R6 补 4 项覆盖格 5/6/7），实得 ${FORMS.length} —— 数量变了就该同步核对它与方案 §7.2 的对应关系`);
                });
                check('[A 直调·#67 C8 格17·渲染层半] 8 个可隐藏码 × 开关**开启** → 逐码输出隐藏属性；**关闭**态则一律不输出；改期行两态都不输出（方案 §7.1 点名的那 8 个）', () => {
                    // [579-M1] 上一条只验「载荷×归属」，**没开开关、没遍历 8 码** ⇒ 格17 的开关验收缺口。
                    //   方案 §7.1 把 8 个码逐个点了名：add / remove / schedule_cancel / published /
                    //   executors_set / notify / done / hotfix_create。本条用 `tlHidden` 装配
                    //   （siTlHideReleaseScope=true）逐码验，并**双向对照**改期行仍可见。
                    //   ⚠️ 真实浏览器里的开关**事件**（点 checkbox → siToggleTlReleaseScope → 逐行改 style）
                    //   由 C6 的 Playwright 第 ⑫ 组覆盖；本条覆盖的是**初始渲染时 8 码全带 display:none**
                    //   这一半——两半合起来才是格17。单独任一半都不够，这点在注释里写明以免被误读。
                    // ⚠️ [579-R L1 措辞收窄] 本条查的是**输出里有没有那段隐藏属性**，
                    //   **不等价于**「有效隐藏样式」：属性原文里的同名文本、或后面再写一个 display:block，
                    //   文本检查都会满足；写成带空格的 `display: none` 又会假红。
                    // ⚠️ [579-R2 L2 / 579-R3 L2 计数订正] 浏览器层的**实际可见性证据**
                    //   （`getComputedStyle` + `getClientRects`，C6 第 ⑫ 组）**只覆盖该夹具里出现的两类行**
                    //   ——8 个可隐藏码里只有 `release_add`，外加**不属于**那 8 码的改期行。
                    //   ⇒ 没有浏览器层有效样式证据的是**其余 7 个可隐藏码**（我上一轮写"6 个"算错了：
                    //   改期行是单独类别，不该从 8 里扣），它们靠的是「三处消费同一归属判据」这个
                    //   分层论证（由 A4 那条源码正则锁住）。不要把「⑫ 组兜底」读成"8 码两态都被浏览器验过"。
                    // ⚠️ [579-R2 M2·581-R 计数同步] 同理，本文件的覆盖不是「8 码 × 两态 × 15 载荷」的
                    //   **笛卡尔积**：实际执行的是「8 码 × 两态」的渲染检查 **加** 「15 种载荷」的归属
                    //   检查两组，它们经共同判据支持**分层组合**，不是一次跑完 240 个组合。
                    //   （载荷表已由 579-R6 从 11 扩到 15，此处计数原先漏改·codex 581-R 指出。
                    //    格17 的准确组成 = 15 形态的两码归属检查 + 8 码两态初始输出检查 +
                    //    浏览器夹具的「关闭→开启→关闭」交互检查；另有格9 豁免；合法 null 已于 2026-09-17 裁定为契约。）
                    // ⚠️ [579-R M] 补**开关关闭态**作对照：只断"开启时带隐藏属性"不足以证明那段属性是
                    //   **开关驱动**的——若实现变成"这 8 码恒带 display:none"，只测开启态照样全绿，
                    //   而用户在关闭开关时根本看不到这 8 类记录。故两态都断。
                    const EIGHT = ['release_add', 'release_remove', 'release_schedule_cancel', 'release_published',
                        'release_executors_set', 'release_executor_notify', 'release_executor_done', 'release_hotfix_create'];
                    let n = 0;
                    for (const code of EIGHT) {
                        const row = { id: 150 + n, event_type: 'scope_change', action_code: code, summary: `${code} 事件`, ref_id: 9, operator_name: '示例客服B', created_at: '2026-09-16 13:00:00' };
                        const on = firstItemAttrs(tlHidden([row], [], ''));
                        assert.ok(on, `${code} 未渲染出 si-tl-item（开启态）`);
                        assert.ok(on.has('si-tl-release-scope'), `${code} 应带 si-tl-release-scope（它在方案 §7.1 点名的 8 码里）——按**完整 class 令牌**判定，不用子串匹配，实得 tokens=${JSON.stringify(on.tokens)}`);
                        assert.ok(/display:none/.test(on.rest), `${code} 在开关**开启**时应输出隐藏属性（方案 §7.1：8 个可隐藏码全部消失），实得属性="${on.rest}"`);
                        const off = firstItemAttrs(tl([row], [], ''));
                        assert.ok(off, `${code} 未渲染出 si-tl-item（关闭态）`);
                        assert.ok(off.has('si-tl-release-scope'), `${code} 关闭态仍应带 class（class 是归属、与开关无关）——按完整令牌判定，实得 tokens=${JSON.stringify(off.tokens)}`);
                        assert.ok(!/display:none/.test(off.rest), `${code} 在开关**关闭**时不得输出隐藏属性（否则这 8 类记录恒不可见），实得属性="${off.rest}"`);
                        n += 1;
                    }
                    assert.strictEqual(n, 8, `应跑满方案点名的 8 码，实得 ${n}`);
                    // 双向对照：**两态**下改期行都不得被隐藏（否则"全隐藏"可能是过滤器整体失控）
                    const dOn = firstItemAttrs(tlHidden([evtDateChange], [], ''));
                    assert.ok(dOn && !/display:none/.test(dOn.rest), `开启态下改期行仍须可见（#67 A3 核心语义），实得属性="${dOn && dOn.rest}"`);
                    const dOff = firstItemAttrs(tl([evtDateChange], [], ''));
                    assert.ok(dOff && !/display:none/.test(dOff.rest), `关闭态下改期行当然也须可见，实得属性="${dOff && dOff.rest}"`);
                });
                check('[A 直调·#67 A5 负向] 非白名单的 scope_change 事件不进本分支、不换徽章', () => {
                    const h = tl([{ id: 75, event_type: 'scope_change', action_code: 'release_add', summary: '加入上线单', ref_id: 9, operator_name: '示例客服B', created_at: '2026-09-16 10:04:00' }], [], '');
                    assert.notStrictEqual((badge(h) || {}).label, '✎ 变更留痕', 'release_add 不在 CHANGE_CODES 里，不得换变更留痕徽章');
                    assert.ok(!hasFold(h), '不得出现折叠');
                });
                check('[A 徽章直调·567 M2] 普通 note / 同码非 note / release_published / accept(online_mode) 不受覆盖影响——断完整徽章对象，不只比旧标签文本', () => {
                    const rose = { cls: 'si-tl-rose', label: '✎ 变更留痕' };
                    const notRose = (h, name) => { const b = badge(h); assert.ok(b && b.cls !== 'si-tl-rose' && b.label !== '✎ 变更留痕' && !b.label.includes('变更留痕'), `${name}：不得被覆盖成变更留痕，实得 ${JSON.stringify(b)}`); return b; };
                    const plain = notRose(tl([row({ action_code: 'work_note_x', payload_json: JSON.stringify({ changes: [{ field: 'title', old: 'A', new: 'B' }] }) })], [], ''), '非两码 note 带 changes');
                    assert.deepStrictEqual(plain, { cls: 'si-tl-gray', label: '备注' }, '非两码 note 应为通用「备注」灰徽章');
                    for (const code of ['edit_in_revision', 'release_info_edit']) {
                        for (const et of ['status_change', 'scope_change', 'release']) {
                            const h = tl([row({ event_type: et, action_code: code, from_status: '待修改', to_status: '待修改', payload_json: JSON.stringify({ changes: [{ field: 'title', old: 'A', new: 'B' }] }) })], [], '');
                            notRose(h, `${code} 且 event_type=${et}`);
                            assert.ok(!h.includes('查看改动') && !h.includes('修改明细'), `${code}/${et}：不进 changes 分支`);
                        }
                    }
                    const pub = badge(tl([row({ event_type: 'scope_change', action_code: 'release_published', summary: 'R-1 已发布', payload_json: null })], [], ''));
                    assert.deepStrictEqual(pub, { cls: 'si-tl-green', label: '发布留痕' }, 'release_published 保持绿色发布留痕');
                    const acc = tl([row({ event_type: 'status_change', action_code: 'accept', from_status: '待验证', to_status: '已上线', payload_json: JSON.stringify({ online_mode: 'direct' }) })], [], '');
                    assert.ok(acc.includes('上线方式') && !acc.includes('变更留痕') && !acc.includes('si-tl-rose'), 'accept 行走 online_mode 分支且不换徽章');
                });
                // ══════════════════════════════════════════════════════════════════════
                // [乙4·2026-09-17 C2·时间线留痕覆盖面补齐 v0.2 §5 C2] S4b 新增六码的真实渲染层行为。
                // ══════════════════════════════════════════════════════════════════════
                const NEW_CODE_FIXTURES = {
                    estimate_eta:          { event_type: 'estimate',    cls: 'si-tl-rose',   label: '✎ 变更留痕', field: 'dev_estimated_at',       fieldLabel: '预计完成时间', objText: '预计完成时间' },
                    set_scheduled_start:   { event_type: 'note',        cls: 'si-tl-rose',   label: '✎ 变更留痕', field: 'scheduled_start',        fieldLabel: '计划开工日',   objText: '计划开工日' },
                    set_oa_number:         { event_type: 'note',        cls: 'si-tl-rose',   label: '✎ 变更留痕', field: 'oa_number',              fieldLabel: 'OA 流程号',    objText: 'OA 流程号' },
                    feasibility_change:    { event_type: 'feasibility', cls: 'si-tl-indigo', label: '可行性评估', field: 'feasibility_conclusion', fieldLabel: '评估结论',     objText: '可行性评估' },
                    assign_eta:            { event_type: 'assign',      cls: 'si-tl-indigo', label: '指派',       field: 'dev_estimated_at',       fieldLabel: '预计完成时间', objText: '预计完成时间' },
                    scope_change_deadline: { event_type: 'scope_change',cls: 'si-tl-orange', label: '范围变更',   field: 'deadline',               fieldLabel: '预期完成',     objText: '预期完成' },
                };
                const mkRow = (code, extra) => Object.assign({
                    id: 200, event_type: NEW_CODE_FIXTURES[code].event_type, action_code: code,
                    summary: code === 'estimate_eta' ? '2026-09-30 12:00' : `${code} 中性摘要`,
                    operator_name: '示例客服B', created_at: '2026-09-17 09:00:00',
                }, extra);
                check('[A 直调·乙4 C2] 六新码各自的有效 payload → 展开 + 逐单元格前后值 + 头行变更对象文案 + 各自正确徽章', () => {
                    for (const code of Object.keys(NEW_CODE_FIXTURES)) {
                        const fx = NEW_CODE_FIXTURES[code];
                        const h = tl([mkRow(code, { payload_json: JSON.stringify({ changes: [{ field: fx.field, old: 'X', new: 'Y' }] }) })], [], '');
                        assert.ok(hasFold(h), `${code}：有效 payload 应可展开，实得 ${h}`);
                        const rows = changeRows(h);
                        assert.strictEqual(rows.length, 1, `${code}：应恰有 1 行明细，实得 ${rows.length}`);
                        assert.strictEqual(rows[0].label, fx.fieldLabel, `${code}：字段标签应为「${fx.fieldLabel}」，实得「${rows[0].label}」`);
                        assert.strictEqual(rows[0].old, 'X', `${code}：修改前应为 X`);
                        assert.strictEqual(rows[0].new, 'Y', `${code}：修改后应为 Y`);
                        assert.ok(h.includes(`变更对象：${fx.objText} · `), `${code}：头行变更对象应含「${fx.objText}」，实得 ${(h.match(/变更对象：[^<]*/) || ['(无)'])[0]}`);
                        assert.strictEqual(noteOf(h), '', `${code}：正常展开不应追加说明文字，实得「${noteOf(h)}」`);
                        assert.deepStrictEqual(badge(h), { cls: fx.cls, label: fx.label }, `${code}：徽章应为 ${JSON.stringify({ cls: fx.cls, label: fx.label })}，实得 ${JSON.stringify(badge(h))}`);
                    }
                });
                check('[A 直调·乙4 C2·S4b2 L4] assign_eta 带 from/to_status（真实指派行形态）：指派徽章 + 起止状态文案 + 展开区共存', () => {
                    const pl = JSON.stringify({ changes: [{ field: 'dev_estimated_at', old: null, new: '2026-10-08 10:00' }] });
                    const h = tl([mkRow('assign_eta', { from_status: '待指派', to_status: '开发中', summary: '指派给 开发王｜指派时人工设定预计完成时间：管理员 填写为 2026-10-08 10:00', payload_json: pl })], [], '');
                    assert.deepStrictEqual(badge(h), { cls: 'si-tl-indigo', label: '指派' }, `assign_eta 带状态流转仍应是「指派」徽章，实得 ${JSON.stringify(badge(h))}`);
                    // flow 的真实形态（Sys_Iteration.html siRenderTimeline）：from≠to 时输出 <span class="si-tl-to"> →目标状态</span>，同状态不输出
                    assert.ok(/class="si-tl-to">\s*→/.test(h), `from≠to 时应输出目标状态箭头 si-tl-to，实得 ${h}`);
                    assert.ok(hasFold(h) && changeRows(h).length === 1, 'assign_eta 带状态流转仍应有 1 行展开区');
                    const hSame = tl([mkRow('assign_eta', { from_status: '开发中', to_status: '开发中', summary: '指派给 开发王', payload_json: pl })], [], '');
                    assert.ok(hasFold(hSame) && changeRows(hSame).length === 1, '同状态指派带 ETA 变化仍应有展开区');
                    assert.deepStrictEqual(badge(hSame), { cls: 'si-tl-indigo', label: '指派' }, '同状态指派徽章不变');
                    assert.ok(!/si-tl-to/.test(hSame), '同状态时不应输出目标状态箭头（flow 判据 from!==to）');
                });
                check('[A 直调·乙4 C2/B3] estimate_eta 行 summary 前缀「预计完成：」恰一次（不双拼）', () => {
                    const h = tl([mkRow('estimate_eta', { payload_json: JSON.stringify({ changes: [{ field: 'dev_estimated_at', old: null, new: '2026-09-30 12:00' }] }) })], [], '');
                    const hits = (h.match(/预计完成：/g) || []).length;
                    assert.strictEqual(hits, 1, `「预计完成：」前缀应恰出现一次，实得 ${hits} 次，${h}`);
                });
                check('[A 直调·乙4 C2] 历史行零变化四格：无码 estimate 行 / set_scheduled_start 历史提示 / set_oa_number 历史豁免 / B 类三种旧行原样', () => {
                    // 无码 estimate 行——原「estimate 前缀分支」，不受本次 A/B 类改动影响
                    const hEst = tl([{ id: 201, event_type: 'estimate', summary: '2026-08-01 10:00', operator_name: '示例客服B', created_at: '2026-08-01 10:00:00' }], [], '');
                    assert.ok(hEst.includes('预计完成：2026-08-01 10:00'), '无码 estimate 行应仍走原「estimate 前缀分支」');
                    assert.ok(!hasFold(hEst) && !noteOf(hEst), `无码 estimate 行不应展开、不应有说明文字，实得 ${hEst}`);
                    // set_scheduled_start：非豁免码，payload 空 → 历史提示
                    const hSched = tl([mkRow('set_scheduled_start', { summary: '定计划开工日：2026-09-01', payload_json: null })], [], '');
                    assert.strictEqual(noteOf(hSched), '（历史记录，未保存修改明细）', `set_scheduled_start 历史行应报历史提示，实得「${noteOf(hSched)}」`);
                    assert.ok(!hasFold(hSched), 'set_scheduled_start 历史行不应展开');
                    // set_oa_number：豁免码，payload 空 → 无提示
                    const hOa = tl([mkRow('set_oa_number', { summary: '补填 OA 流程号：OA-1（原空）', payload_json: '' })], [], '');
                    assert.strictEqual(noteOf(hOa), '', `set_oa_number 历史行应豁免（无提示），实得「${noteOf(hOa)}」`);
                    assert.ok(!hasFold(hOa), 'set_oa_number 历史行不应展开');
                    // B 类三种 event_type 的无码旧行——action_code 为 null，根本不进 A/B 分支，原样渲染
                    for (const et of ['assign', 'feasibility', 'scope_change']) {
                        const hOld = tl([{ id: 202, event_type: et, action_code: null, summary: `${et} 旧行`, operator_name: '示例客服B', created_at: '2026-08-01 10:00:00' }], [], '');
                        assert.ok(!hasFold(hOld) && !noteOf(hOld), `${et} 无码旧行应原样，不展开不提示，实得 ${hOld}`);
                    }
                });
                check('[A 直调·乙4 C2/583-R M1·S4b2 L1] estimate_eta 空载荷（NULL/空串）与损坏载荷（解析失败/空 changes）→「修改明细不可用」（无历史资格）且「预计完成：」前缀恰一次', () => {
                    for (const pj of [null, '', '{not json', JSON.stringify({ changes: [] })]) {
                        const h = tl([mkRow('estimate_eta', { payload_json: pj })], [], '');
                        assert.strictEqual(noteOf(h), '（修改明细不可用）', `estimate_eta payload=${JSON.stringify(pj)} 应报「修改明细不可用」，实得「${noteOf(h)}」`);
                        assert.ok(!hasFold(h), 'estimate_eta 空载荷不应展开');
                        // [S4b2·L1] history/broken 出口若把 baseSummaryHtml 换回 esc(summary) 会丢前缀——此前只在 ok 出口锁过
                        assert.ok(h.includes('预计完成：2026-09-30 12:00'), `estimate_eta payload=${JSON.stringify(pj)} 的摘要应含完整「预计完成：2026-09-30 12:00」，实得 ${h}`);
                        assert.strictEqual((h.match(/预计完成：/g) || []).length, 1, `estimate_eta payload=${JSON.stringify(pj)} 前缀应恰一次`);
                        assert.deepStrictEqual(badge(h), { cls: 'si-tl-rose', label: '✎ 变更留痕' }, 'estimate_eta 徽章不受载荷形态影响（A 类无条件覆盖）');
                    }
                });
                check('[A 直调·乙4 C2/B4 M2] B 类异常载荷（NULL/空串/解析失败/无有效项）一律「修改明细不可用」且徽章仍为原徽章', () => {
                    const code = 'feasibility_change';
                    const fx = NEW_CODE_FIXTURES[code];
                    for (const [name, pj] of [['NULL', null], ['空串', ''], ['解析失败', '{not json'], ['无有效项', JSON.stringify({ changes: [] })]]) {
                        const h = tl([mkRow(code, { payload_json: pj })], [], '');
                        assert.strictEqual(noteOf(h), '（修改明细不可用）', `${code} payload=${name} 应报「修改明细不可用」（B 类无历史资格，不显历史提示），实得「${noteOf(h)}」`);
                        assert.ok(!hasFold(h), `${code} payload=${name} 不应展开`);
                        assert.deepStrictEqual(badge(h), { cls: fx.cls, label: fx.label }, `${code} payload=${name} 徽章应仍为原徽章「${fx.label}」`);
                    }
                });
                check('[A 直调·乙4 C2] 异常配对两格：未登记码+缺 event_type 不入任一分支；登记码+类型错（assign_eta 配 note）不入分支', () => {
                    const h1 = tl([{ id: 203, action_code: 'totally_unknown_new_code', summary: 'x', operator_name: '示例客服B', created_at: '2026-09-17 09:00:00', payload_json: JSON.stringify({ changes: [{ field: 'x', old: 1, new: 2 }] }) }], [], '');
                    assert.ok(!hasFold(h1), '未登记码+缺 event_type 不得展开');
                    const bd1 = badge(h1) || {};
                    assert.notStrictEqual(bd1.label, '✎ 变更留痕', '未登记码+缺 event_type 不得换 A 类徽章');
                    const h2 = tl([mkRow('assign_eta', { event_type: 'note', payload_json: JSON.stringify({ changes: [{ field: 'dev_estimated_at', old: 'X', new: 'Y' }] }) })], [], '');
                    assert.ok(!hasFold(h2), 'assign_eta 配 event_type=note（类型错）不得展开（B 类同样受 has()+get()===event_type 配对约束）');
                });
                check('[A 直调·乙4 C2/B8] scope_change_deadline 行不带 si-tl-release-scope 令牌 ∧ 徽章「范围变更」（B 类不覆盖 label/cls）', () => {
                    const row5 = mkRow('scope_change_deadline', { payload_json: JSON.stringify({ changes: [{ field: 'deadline', old: '2026-09-20 18:00', new: '2026-09-25 18:00' }] }) });
                    const a = firstItemAttrs(tl([row5], [], ''));
                    assert.ok(a, 'scope_change_deadline 行未渲染出 si-tl-item');
                    assert.ok(!/si-tl-release-scope/.test(a.cls), `scope_change_deadline 不应带可隐藏 class，实得 class="${a.cls}"`);
                    assert.deepStrictEqual(badge(tl([row5], [], '')), { cls: 'si-tl-orange', label: '范围变更' }, 'scope_change_deadline 徽章应为「范围变更」（保留原徽章，B 类不覆盖）');
                });

                // ══════════════════════════════════════════════════════════════════════
                // [长任务B·S3-A·时间线逐人完成事件_方案_20260916_v1.1] 「开发逐人完成」前端不变量
                // ══════════════════════════════════════════════════════════════════════
                check('[S3-A] dev_submit_done/dev_no_code 三表正向登记（连文案）+ CLS 归 si-tl-teal', () => {
                    const labelBody = stripComments(extractConstObjectText('SI_TL_LABEL') || '');
                    const clsBody = stripComments(extractConstObjectText('SI_TL_CLS') || '');
                    assert.ok(labelBody && /dev_submit_done:\s*'开发完成·代码已提交'/.test(labelBody), 'SI_TL_LABEL 应含 dev_submit_done 词条且文案精确');
                    assert.ok(labelBody && /dev_no_code:\s*'开发完成·无代码交付'/.test(labelBody), 'SI_TL_LABEL 应含 dev_no_code 词条且文案精确');
                    assert.ok(clsBody && /dev_submit_done:\s*'si-tl-teal'/.test(clsBody), 'SI_TL_CLS dev_submit_done 应归 si-tl-teal');
                    assert.ok(clsBody && /dev_no_code:\s*'si-tl-teal'/.test(clsBody), 'SI_TL_CLS dev_no_code 应归 si-tl-teal');
                    // [Opus 预筛 S3·MED-2·长任务B S4c·2026-09-17] 原判据 `/SI_TL_NOTE_OWN_LABEL_CODES\s*=\s*new
                    //   Set\(\[[\s\S]*?'dev_submit_done'/` 是懒惰匹配、终点不是 Set 字面量真正的收尾 `]);`——
                    //   若从 Set 里删掉 'dev_submit_done'，只要文件里**其它地方**（如 :4989 一带某分支判据）还
                    //   出现字符串 'dev_submit_done'，这条正则仍会命中（越界匹配到 Set 外），假绿。改用
                    //   grabSet（本文件既有小工具，:2138 一带，终点锚定该 Set 字面量真正的 `]);`）切出精确
                    //   范围，再在这个范围内断言，不给"删码后靠别处同名字符串蒙混过关"留空子。
                    const noteOwnBody = stripComments(grabSet('SI_TL_NOTE_OWN_LABEL_CODES') || '');
                    assert.ok(noteOwnBody, '未提取到 SI_TL_NOTE_OWN_LABEL_CODES Set 字面量');
                    assert.ok(/'dev_submit_done'/.test(noteOwnBody), 'NOTE_OWN 应含 dev_submit_done（缺失=落回通用「备注」徽章）');
                    assert.ok(/'dev_no_code'/.test(noteOwnBody), 'NOTE_OWN 应含 dev_no_code（同上）');
                });
                check('[S3-A] .si-tl-evt.si-tl-teal 色族本体存在 + 全部 .si-tl-evt.si-tl-* 底色两两不重复（S3b 活体变异会临时删掉这条 CSS 规则验证本断言真有判别力）', () => {
                    // [Opus 预筛 S3·MED-3·长任务B S4c·2026-09-17] 原判据只手写 4 个既有色族（gray/rose/green/
                    //   amber）逐个比对——本文件实际已有 9 个 .si-tl-evt.si-tl-* 色族（另 5 个 amber 之外的
                    //   indigo/blue/red/orange 未被覆盖），新增色族与那 5 个之一撞色不会被这条判据发现（假绿）。
                    //   改用 matchAll 抓全部规则，断 background 值集合 size===规则条数（两两不重复）这一条更强
                    //   的不变量，天然覆盖任意新增色族，不必每加一色就手改一遍白名单。
                    // [长任务B S4c2·codex 590 M6] 改用 extractTimelineBadgeRules（先取 <style> 内容 + 剥 CSS
                    //   注释再扫描），与下方 MED-4a/b/c 三条活体变异共用同一份实现。
                    const rules = extractTimelineBadgeRules(src);
                    assert.ok(rules.length >= 9, `.si-tl-evt.si-tl-* 色族规则应至少 9 条（本文件当前已知色族数），实得 ${rules.length}`);
                    const teal = rules.find(m => m[1] === 'teal');
                    assert.ok(teal, '未定位到 .si-tl-evt.si-tl-teal CSS 规则');
                    assert.strictEqual(teal[2].toLowerCase(), '#ccfbf1', `si-tl-teal 背景色应为 #ccfbf1，实得 ${teal[2].toLowerCase()}`);
                    const bgSet = new Set(rules.map(m => m[2].toLowerCase()));
                    assert.strictEqual(bgSet.size, rules.length, `全部 .si-tl-evt.si-tl-* 背景色应两两不重复，实得 ${rules.length} 条规则只有 ${bgSet.size} 个不同底色，重复色值会导致时间线不同性质的事件在视觉上无法区分——规则清单：${JSON.stringify(rules.map(m => [m[1], m[2]]))}`);
                });
                // ══════════════════════════════════════════════════════════════════════
                // [Opus 预筛 S3·MED-4·长任务B S4c·2026-09-17] 三处"活体变异对照组"——上面两条 check 的注释
                // 分别写了"S3b 活体变异会临时删掉这条 CSS 规则验证本断言真有判别力"这类承诺，但从未真正落地
                // 成自动化 check（只是口头承诺）。补三条真变异（同 :1276「活体变异对照组①」范式：对真实 src
                // 做字符串替换模拟改坏，再用同一套判据函数复跑，断言判据确实翻红），逐条钉死。
                // ══════════════════════════════════════════════════════════════════════
                check('活体变异对照组·MED-4a：删掉 .si-tl-evt.si-tl-teal 这条 CSS 规则——上方色族存在性 + 计数断言须判红', () => {
                    const tealRuleText = ".si-tl-evt.si-tl-teal { background: #ccfbf1; color: #0f766e; }   /* 逐人完成专用（用户 2026-09-17 在示例页 V1-V9 中选 V1 teal 实底：与 amber/gray/rose/green/red/blue/indigo 全不撞·方案 20260916 v1.1 D10）*/";
                    assert.ok(src.includes(tealRuleText), '变异替换未命中原文——teal CSS 规则文本已漂移，需同步本条变异对照组');
                    // [长任务B S4c2·codex 590 M6] 断"规则数 = 原数 - 1 且缺 teal"（相对不变量），不再断固定
                    //   数字 8——固定数字每加一色都要手改一遍，相对断言天然跟着基线走。改用
                    //   extractTimelineBadgeRules 与正向 check 共用同一份实现。
                    const rulesBefore = extractTimelineBadgeRules(src);
                    const mutated = src.replace(tealRuleText, '');
                    const rulesMutated = extractTimelineBadgeRules(mutated);
                    assert.strictEqual(rulesMutated.length, rulesBefore.length - 1, `删掉 teal 规则后应恰比原数少 1 条（原 ${rulesBefore.length} 条），实得 ${rulesMutated.length}——说明规则提取对"删规则"这类变异不敏感`);
                    assert.ok(!rulesMutated.some(m => m[1] === 'teal'), '删掉 teal 规则后不应再找到 teal 色族——若仍找到说明判据未真正扫描变异后的文本');
                });
                check('活体变异对照组·MED-4a2：把 teal 规则整行用 /* … */ 注掉（不删除文本本体）——extractTimelineBadgeRules 剥 CSS 注释后应视同"该规则不存在"，判红', () => {
                    const tealRuleText = ".si-tl-evt.si-tl-teal { background: #ccfbf1; color: #0f766e; }   /* 逐人完成专用（用户 2026-09-17 在示例页 V1-V9 中选 V1 teal 实底：与 amber/gray/rose/green/red/blue/indigo 全不撞·方案 20260916 v1.1 D10）*/";
                    assert.ok(src.includes(tealRuleText), '变异替换未命中原文——teal CSS 规则文本已漂移，需同步本条变异对照组');
                    const rulesBefore = extractTimelineBadgeRules(src);
                    // 整条规则本体（不含其后已有的说明性注释）包在一对新的 /* … */ 里，模拟"顺手注释掉一条规则"
                    // 这种不删文本、只让它对渲染失效的真实误操作。
                    const tealRuleBodyOnly = ".si-tl-evt.si-tl-teal { background: #ccfbf1; color: #0f766e; }";
                    const mutated = src.replace(tealRuleBodyOnly, `/* ${tealRuleBodyOnly} */`);
                    const rulesMutated = extractTimelineBadgeRules(mutated);
                    assert.strictEqual(rulesMutated.length, rulesBefore.length - 1, `注掉 teal 规则后应恰比原数少 1 条（原 ${rulesBefore.length} 条），实得 ${rulesMutated.length}——若仍等于原数，说明判据把注释文本当成了真实规则`);
                    assert.ok(!rulesMutated.some(m => m[1] === 'teal'), '注掉 teal 规则后不应再找到 teal 色族——若仍找到说明未真正剥离 CSS 注释');
                });
                check('活体变异对照组·MED-4b：从 SI_TL_NOTE_OWN_LABEL_CODES 删掉 dev_submit_done/dev_no_code 两码——上方 NOTE_OWN 断言须判红', () => {
                    // [#83·S2 续做] 尾部随附件三码登记后延长——锚点更新为含附件三码的完整现状；变异只摘掉
                    // 本条对照组关心的 dev_submit_done/dev_no_code 两码，附件三码保留不动（不是本条变异对象）。
                    const before = "'dev_withdraw', 'release_overdue_reason', 'dev_submit_done', 'dev_no_code', 'attachment_added', 'attachment_replaced', 'attachment_removed']);";
                    assert.ok(src.includes(before), '变异替换未命中原文——SI_TL_NOTE_OWN_LABEL_CODES 尾部文本已漂移，需同步本条变异对照组');
                    const mutated = src.replace(before, "'dev_withdraw', 'release_overdue_reason', 'attachment_added', 'attachment_replaced', 'attachment_removed']);");
                    const noteOwnMutatedRaw = (mutated.match(new RegExp('const SI_TL_NOTE_OWN_LABEL_CODES = new Set\\(\\[[\\s\\S]*?\\]\\);')) || [''])[0];
                    assert.ok(noteOwnMutatedRaw, '变异后仍应能提取到 SI_TL_NOTE_OWN_LABEL_CODES Set 字面量本体（否则本条对照组自身失效）');
                    const noteOwnMutated = stripComments(noteOwnMutatedRaw);
                    assert.ok(!/'dev_submit_done'/.test(noteOwnMutated), '删码后不应再含 dev_submit_done——若仍含说明判据未真正扫描变异后的文本');
                    assert.ok(!/'dev_no_code'/.test(noteOwnMutated), '删码后不应再含 dev_no_code——同上');
                });
                check('活体变异对照组·MED-4c：篡改 SI_TL_LABEL 的 dev_submit_done 文案——上方精确文案断言须判红', () => {
                    const before = "dev_submit_done: '开发完成·代码已提交'";
                    assert.ok(src.includes(before), '变异替换未命中原文——SI_TL_LABEL dev_submit_done 文案已漂移，需同步本条变异对照组');
                    const mutated = src.replace(before, "dev_submit_done: '开发完成'");
                    // extractConstObjectText（本文件既有小工具）内部固定读模块级 `src`，不接受传参切任意文本
                    // ——改用同款正则（花括号平衡）直接在 mutated 文本上重新抽取，逻辑与 extractConstObjectText
                    // 一致，不改动既有工具函数签名以免影响其它调用点。
                    const grabConstFromText = (text, name) => {
                        const startRe = new RegExp(`const\\s+${name}\\s*=\\s*\\{`);
                        const m = startRe.exec(text);
                        if (!m) return null;
                        let depth = 0, i = m.index + m[0].length - 1;
                        const start = i;
                        for (; i < text.length; i++) {
                            if (text[i] === '{') depth++;
                            else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
                        }
                        return null;
                    };
                    const mutatedLabelBody = stripComments(grabConstFromText(mutated, 'SI_TL_LABEL') || '');
                    assert.ok(mutatedLabelBody, '变异后仍应能提取到 SI_TL_LABEL 对象字面量本体（否则本条对照组自身失效）');
                    assert.ok(!/dev_submit_done:\s*'开发完成·代码已提交'/.test(mutatedLabelBody), '篡改文案后不应再匹配精确文案正则——若仍匹配说明判据未真正扫描变异后的文本');
                });
                check('[S3-A] 前后端 D9「原因摘要上限」常量同值（跨文件对拍，防漂移）', () => {
                    // [Opus 预筛 S3·LOW-12·长任务B S4c·2026-09-17] 原正则 `/NAME = (\d+)/` 未锚 `const` 前缀、
                    //   未剥注释——若未来某处注释里写了"曾经是 PERDEV_DONE_SUMMARY_MAX_CODEPOINTS = 60"这类
                    //   历史说明文字（且该文字排在真实声明之前），match() 只取第一个命中，会把注释里的旧数字
                    //   误认成当前值。改为剥注释后锚 `const NAME = (\d+)` 精确定位真实声明。
                    const indexJsSrc = stripComments(fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8'));
                    const mBack = indexJsSrc.match(/const PERDEV_DONE_SUMMARY_MAX_CODEPOINTS = (\d+)/);
                    const mFront = stripComments(src).match(/const SI_PERDEV_REASON_BRIEF_MAX = (\d+)/);
                    assert.ok(mBack, '未在 index.js 定位到 const PERDEV_DONE_SUMMARY_MAX_CODEPOINTS 声明');
                    assert.ok(mFront, '未在 Sys_Iteration.html 定位到 const SI_PERDEV_REASON_BRIEF_MAX 声明');
                    assert.strictEqual(mFront[1], mBack[1], `前后端 D9 摘要上限应同值，后端=${mBack[1]} 前端=${mFront[1]}`);
                });
                check('活体变异对照组·LOW-12：index.js 里若在真实声明之前混入一条含旧数字的注释——锚 const 前缀的判据不应被注释里的数字带偏', () => {
                    const realIndexJsSrc = fs.readFileSync(path.resolve(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
                    const decl = 'const PERDEV_DONE_SUMMARY_MAX_CODEPOINTS = 80;';
                    assert.ok(realIndexJsSrc.includes(decl), '变异替换未命中原文——PERDEV_DONE_SUMMARY_MAX_CODEPOINTS 声明文本已漂移，需同步本条变异对照组');
                    // 在真实声明之前插入一条“注释里恰好出现旧数字”的干扰文本（模拟未来有人写迁移说明）。
                    const mutated = realIndexJsSrc.replace(decl, '// 历史值：PERDEV_DONE_SUMMARY_MAX_CODEPOINTS = 60（v1.0 曾用值，现已废弃）\n  ' + decl);
                    const oldStyleMatch = mutated.match(/PERDEV_DONE_SUMMARY_MAX_CODEPOINTS = (\d+)/);
                    assert.strictEqual(oldStyleMatch[1], '60', '本条对照组前提失败——旧版无锚正则应命中注释里的干扰数字 60（若不是 60，说明干扰文本构造方式已不适配，需重写变异样例）');
                    const newStyleMatch = stripComments(mutated).match(/const PERDEV_DONE_SUMMARY_MAX_CODEPOINTS = (\d+)/);
                    assert.ok(newStyleMatch, '剥注释 + 锚 const 前缀后仍应定位到真实声明');
                    assert.strictEqual(newStyleMatch[1], '80', `剥注释 + 锚 const 前缀应取到真实声明值 80（不受注释里的干扰数字影响），实得 ${newStyleMatch[1]}`);
                });
                // [长任务B S4c2·codex 590 裁定 M7] 原判据是两条纯文本正则（`payload\.mode\b` / `\.mode\s*===`）——
                //   只认字面拼出的属性访问与 `===` 判断这两种具体写法，绕过面明显：计算属性 `payload['mode']`
                //   （不含 `.mode` 三个连续字符）、解构 `const {mode} = perDevPayload`（同样不含 `.mode`）都能
                //   写文本上完全绕开这两条正则却达到同样的"读 mode 字段"效果。改用 acorn 解析分支体，收集
                //   perDevPayload/parsedPayload 及其别名（`const x = perDevPayload;` 链式追踪），判红：
                //   ① 对别名的 MemberExpression 访问属性名为 'mode'（点号或计算属性字面量均算）；
                //   ② 任意 ObjectPattern 解构模式含 'mode' 键（不限定来源，分支体内出现即算，保守但足够窄）。
                // [长任务B S4c3·codex 591-R M6·主会话亲核订正] 别名追踪此前只认"声明时初始化为另一别名"
                // 这一种形态（`const x = perDevPayload;`），漏了两类：① 先声明后裸赋值（`let x;
                // x = perDevPayload;`）——AssignmentExpression 完全未被扫描；② 链式赋值
                // （`a = b = perDevPayload;`，AST 里是 `a = (b = perDevPayload)` 嵌套结构）——链上
                // 每一环都该被认成别名，不只是最内层。另外根别名集合缺 `payload`（本分支体内同样常见的
                // 别名字面量）。terminalAssignmentTargetName/collectChainLeftNames 把"简单 `=` 赋值链"
                // 展开：前者找到链条最终指向的标识符名（若链尾不是裸标识符则返回 null，不深入更复杂的
                // 表达式），后者收集链上全部左值标识符名——链尾一旦命中已知别名，链上全部左值都追加为
                // 别名。两者都在下方 while(changed) 定点循环里反复跑，跟 VariableDeclaration 分支一样
                // 不要求声明/赋值的书写顺序。
                function terminalAssignmentTargetName(node) {
                    let cur = node;
                    while (cur && cur.type === 'AssignmentExpression' && cur.operator === '=') cur = cur.right;
                    return cur && cur.type === 'Identifier' ? cur.name : null;
                }
                function collectChainLeftNames(node, out) {
                    let cur = node;
                    while (cur && cur.type === 'AssignmentExpression' && cur.operator === '=') {
                        if (cur.left.type === 'Identifier') out.push(cur.left.name);
                        cur = cur.right;
                    }
                }
                function findModeReadViolations(branchBody) {
                    let ast;
                    try {
                        ast = acorn.parse(`function __siPerDevGuardWrap() ${branchBody}`, { ecmaVersion: 'latest' });
                    } catch (e) {
                        return { parseError: e.message };
                    }
                    const aliasNames = new Set(['perDevPayload', 'parsedPayload', 'payload']);
                    let changed = true;
                    while (changed) {
                        changed = false;
                        walkAllAcornNodes(ast, (node) => {
                            if (node.type === 'VariableDeclaration' && (node.kind === 'const' || node.kind === 'let')) {
                                for (const decl of node.declarations) {
                                    if (decl.id.type !== 'Identifier' || !decl.init) continue;
                                    if (decl.init.type === 'Identifier') {
                                        if (aliasNames.has(decl.init.name) && !aliasNames.has(decl.id.name)) {
                                            aliasNames.add(decl.id.name);
                                            changed = true;
                                        }
                                        continue;
                                    }
                                    // [S4c3·M6b·主会话亲核订正] 声明的 init 本身就是一条赋值链
                                    // （`let b; const a = b = perDevPayload;`——a 的 init 是
                                    // AssignmentExpression `b = perDevPayload`，不是裸 Identifier，
                                    // 上面那条分支永远匹配不上）。沿链找到链尾，链尾命中已知别名时，
                                    // 声明左侧标识符（a）与链上全部左值（b 等）一并登记为别名——不能
                                    // 只指望"链上内层那条 AssignmentExpression 会被独立访问到"去顺带
                                    // registerb，那条路径确实会注册 b，但注册不了 a（a 是 declarator
                                    // 的左值，不出现在任何 AssignmentExpression.left 里）。
                                    if (decl.init.type === 'AssignmentExpression' && decl.init.operator === '=') {
                                        const terminalName = terminalAssignmentTargetName(decl.init);
                                        if (terminalName && aliasNames.has(terminalName)) {
                                            const leftNames = [decl.id.name];
                                            collectChainLeftNames(decl.init, leftNames);
                                            for (const name of leftNames) {
                                                if (!aliasNames.has(name)) { aliasNames.add(name); changed = true; }
                                            }
                                        }
                                    }
                                }
                                return;
                            }
                            if (node.type === 'AssignmentExpression' && node.operator === '=') {
                                const terminalName = terminalAssignmentTargetName(node);
                                if (terminalName && aliasNames.has(terminalName)) {
                                    const leftNames = [];
                                    collectChainLeftNames(node, leftNames);
                                    for (const name of leftNames) {
                                        if (!aliasNames.has(name)) { aliasNames.add(name); changed = true; }
                                    }
                                }
                            }
                        });
                    }
                    const violations = [];
                    walkAllAcornNodes(ast, (node) => {
                        if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && aliasNames.has(node.object.name)) {
                            const propName = !node.computed && node.property.type === 'Identifier' ? node.property.name
                                : (node.computed && node.property.type === 'Literal' ? node.property.value : null);
                            if (propName === 'mode') violations.push(`${node.object.name}.mode（属性访问，:${node.start}）`);
                        }
                        if (node.type === 'ObjectPattern') {
                            for (const prop of node.properties) {
                                if (prop.type === 'RestElement' || !prop.key) continue;
                                const keyIsMode = (prop.key.type === 'Identifier' && prop.key.name === 'mode')
                                    || (prop.key.type === 'Literal' && prop.key.value === 'mode');
                                if (keyIsMode) violations.push(`解构模式含 mode 键（:${node.start}）`);
                            }
                        }
                    });
                    return { violations };
                }
                function extractPerDevBranchBody() {
                    const condMarker = "e.action_code === 'dev_submit_done' || e.action_code === 'dev_no_code'";
                    const condIdx = src.indexOf(condMarker);
                    assert.ok(condIdx >= 0, '未定位到逐人完成 else-if 条件文本——结构锚已漂移，需同步本条检查');
                    const braceOpen = src.indexOf('{', condIdx);
                    assert.ok(braceOpen >= 0, '未定位到逐人完成 else-if 分支体起始花括号');
                    const braceClose = findMatchingBraceIndex(src, braceOpen);
                    assert.ok(braceClose > braceOpen, '逐人完成 else-if 分支体花括号不平衡');
                    return src.slice(braceOpen, braceClose + 1);
                }
                check('[Opus 预筛 S3 补充·S4c2 改写为 AST 判据] 逐人完成 else-if 分支体（结构锚提取）不得读 perDevPayload/parsedPayload 别名的 mode 字段——严格按 e.action_code 分派，D9 既有注释警示"单标志双语义"（dev_events 的 payload.mode 取值 commits/no_code 与本分支 e.action_code 取值 dev_submit_done/dev_no_code 字面同名场景不同）', () => {
                    const branchBody = extractPerDevBranchBody();
                    assert.ok(branchBody.includes('perDevPayload'), '结构锚定位错误——提取到的分支体应含 perDevPayload（本分支的核心变量），否则说明切错了块，需重核锚点');
                    const { violations, parseError } = findModeReadViolations(branchBody);
                    assert.ok(!parseError, `逐人完成分支体 acorn 解析失败（结构锚可能切到了不完整/不合法的片段）：${parseError}`);
                    assert.strictEqual(violations.length, 0, `逐人完成分支体不应读取 payload 别名的 mode 字段（点号/计算属性/解构任一形态），实得：${JSON.stringify(violations)}`);
                });
                check('活体变异对照组·M7-①：分支体内混入 perDevPayload.mode 判断（点号访问）——上方 AST 判据须判红', () => {
                    const branchBody = extractPerDevBranchBody();
                    const anchorText = 'const perDevPayload = ';
                    assert.ok(branchBody.includes(anchorText), '变异注入点文本未命中——perDevPayload 声明文本已漂移，需同步本条变异对照组');
                    const mutatedBranchBody = branchBody.replace(anchorText, "if (perDevPayload && perDevPayload.mode === 'commits') { /* 误判分支 */ }\n                " + anchorText);
                    const { violations } = findModeReadViolations(mutatedBranchBody);
                    assert.ok(violations && violations.some(v => v.includes('perDevPayload.mode')), `点号访问 perDevPayload.mode 应判红，实得 ${JSON.stringify(violations)}`);
                });
                check('活体变异对照组·M7-②：分支体内混入 perDevPayload[\'mode\']（计算属性，旧版纯文本正则漏检）——上方 AST 判据须判红', () => {
                    const branchBody = extractPerDevBranchBody();
                    const anchorText = 'const perDevPayload = ';
                    const mutatedBranchBody = branchBody.replace(anchorText, "if (perDevPayload && perDevPayload['mode'] === 'commits') { /* 误判分支 */ }\n                " + anchorText);
                    const { violations } = findModeReadViolations(mutatedBranchBody);
                    assert.ok(violations && violations.some(v => v.includes('perDevPayload.mode')), `计算属性 perDevPayload['mode'] 应判红，实得 ${JSON.stringify(violations)}`);
                });
                check('活体变异对照组·M7-③：分支体内混入 `const {mode} = perDevPayload;`（解构，旧版纯文本正则漏检）——上方 AST 判据须判红', () => {
                    const branchBody = extractPerDevBranchBody();
                    const anchorText = 'const perDevPayload = ';
                    const mutatedBranchBody = branchBody.replace(anchorText, "if (perDevPayload) { const { mode } = perDevPayload; void mode; }\n                " + anchorText);
                    const { violations } = findModeReadViolations(mutatedBranchBody);
                    assert.ok(violations && violations.some(v => v.includes('解构模式含 mode 键')), `解构 {mode} = perDevPayload 应判红，实得 ${JSON.stringify(violations)}`);
                });
                check('活体变异对照组·S4c3·M6-①：赋值别名 `let x; x = perDevPayload; if (x.mode === \'commits\') {}`（旧版只认声明时初始化为别名，裸赋值完全扫不到）——上方 AST 判据须判红', () => {
                    const branchBody = extractPerDevBranchBody();
                    const anchorText = 'const perDevPayload = ';
                    assert.ok(branchBody.includes(anchorText), '变异注入点文本未命中——perDevPayload 声明文本已漂移，需同步本条变异对照组');
                    const mutatedBranchBody = branchBody.replace(anchorText, "let __m6x; __m6x = perDevPayload; if (__m6x && __m6x.mode === 'commits') { /* 误判分支 */ }\n                " + anchorText);
                    const { violations } = findModeReadViolations(mutatedBranchBody);
                    assert.ok(violations && violations.some(v => v.includes('__m6x.mode')), `裸赋值别名 __m6x = perDevPayload 之后的 __m6x.mode 应判红，实得 ${JSON.stringify(violations)}`);
                });
                check('活体变异对照组·S4c3·M6-②：链式赋值别名 `let a, b; a = b = perDevPayload; a.mode`（旧版只展开单层赋值，链式赋值完全扫不到）——上方 AST 判据须判红', () => {
                    const branchBody = extractPerDevBranchBody();
                    const anchorText = 'const perDevPayload = ';
                    const mutatedBranchBody = branchBody.replace(anchorText, "let __m6a, __m6b; __m6a = __m6b = perDevPayload; if (__m6a && __m6a.mode === 'commits') { /* 误判分支 */ }\n                " + anchorText);
                    const { violations } = findModeReadViolations(mutatedBranchBody);
                    assert.ok(violations && violations.some(v => v.includes('__m6a.mode')), `链式赋值别名 __m6a = __m6b = perDevPayload 之后的 __m6a.mode 应判红，实得 ${JSON.stringify(violations)}`);
                    assert.ok(!violations.some(v => v.includes('__m6b.mode')), '本例未读 __m6b.mode，不应凭空出现该项（防误报污染判红理由）');
                });
                check('活体变异对照组·S4c3·M6b：声明+链式组合别名 `let b; const a = b = perDevPayload; a.mode`（VariableDeclarator 的 init 直接是赋值链，此前只认 init 为裸 Identifier，a 从未被登记）——须判红，且违规项明确含 a.mode', () => {
                    const branchBody = extractPerDevBranchBody();
                    const anchorText = 'const perDevPayload = ';
                    const mutatedBranchBody = branchBody.replace(anchorText, "let __m6bb; const __m6ba = __m6bb = perDevPayload; if (__m6ba && __m6ba.mode === 'commits') { /* 误判分支 */ }\n                " + anchorText);
                    const { violations } = findModeReadViolations(mutatedBranchBody);
                    assert.ok(violations && violations.some(v => v.includes('__m6ba.mode')), `声明+链式组合别名 __m6ba 之后的 __m6ba.mode 应判红，实得 ${JSON.stringify(violations)}`);
                });
                {
                    // 隔离直调 harness——同上方 tl/tlHidden 装配范式，额外注入 SI_PERDEV_REASON_BRIEF_MAX
                    // 常量（逐人完成分支引用它，tl 原装配未含此常量会 ReferenceError）。
                    const constPerDevMax = (src.match(/const SI_PERDEV_REASON_BRIEF_MAX = \d+;/) || [''])[0];
                    check('[S3-A 前置] SI_PERDEV_REASON_BRIEF_MAX 常量提取成功（提不到=本组空转）', () => {
                        assert.ok(constPerDevMax, '未提取到 SI_PERDEV_REASON_BRIEF_MAX 常量声明');
                    });
                    if (constPerDevMax) {
                        // eslint-disable-next-line no-new-func
                        const tlPerDev = new Function('stubs', `with (stubs) { ${parts.join('\n')}\n${constLbl}\n${constMax}\n${constPerDevMax}\n${fnEsc}\n${fnVal}\n${fnObj}\n${fnRender}\n${fnChangesHtml}\n${fnTimeline}\nreturn siRenderTimeline; }`)(stubs);
                        // 真实 esc() 的可调用引用（复用 grabFnA 抓到的源码本体，非手抄一份转义逻辑——防
                        // 复刻漂移：若真实 esc() 未来改行为，这里的期望值自动跟着变，不需要人工同步改）。
                        // eslint-disable-next-line no-new-func
                        const escFn = new Function(`${fnEsc}\nreturn esc;`)();
                        const mkPerDevRow = (actionCode, payloadJsonOverride, extra) => Object.assign({
                            id: 300, event_type: 'note', action_code: actionCode,
                            summary: actionCode === 'dev_no_code' ? '开发完成：开发甲 无代码交付：测试原因' : '开发完成：开发甲 代码已提交',
                            operator_name: '开发甲', created_at: '2026-09-17 10:00:00',
                            payload_json: payloadJsonOverride === undefined ? JSON.stringify(Object.assign({
                                dev_user_id: 5, dev_user_name: '开发甲', dev_assignee_id: 9,
                                mode: actionCode === 'dev_no_code' ? 'no_code' : 'code_submitted',
                                submitted_at: '2026-09-17 09:59:00',
                                ...(actionCode === 'dev_no_code' ? { no_code_reason: '测试原因' } : {}),
                            })) : payloadJsonOverride,
                        }, extra);
                        check('[S3-A 直调] dev_submit_done/dev_no_code 徽章正确（teal + 精确文案）', () => {
                            assert.deepStrictEqual(badge(tlPerDev([mkPerDevRow('dev_submit_done')], [], '')), { cls: 'si-tl-teal', label: '开发完成·代码已提交' });
                            assert.deepStrictEqual(badge(tlPerDev([mkPerDevRow('dev_no_code')], [], '')), { cls: 'si-tl-teal', label: '开发完成·无代码交付' });
                        });
                        check('[S3-A 直调] 逐人行不带 si-tl-release-scope class（D3 不依赖 #67 可隐藏集合）；反例：同 payload 改 scope_change+HIDABLE 码验证 class 断言有判别力', () => {
                            const a = firstItemAttrs(tlPerDev([mkPerDevRow('dev_submit_done')], [], ''));
                            assert.ok(a, '逐人行未渲染出 si-tl-item');
                            assert.ok(!/si-tl-release-scope/.test(a.cls), `逐人行不应带可隐藏 class，实得 class="${a.cls}"`);
                            assert.strictEqual(String(tlPerDev([mkPerDevRow('dev_submit_done')], [], '')).indexOf('si-tl-release-scope'), -1, '整串渲染结果不应出现 si-tl-release-scope 字样');
                            const hiddenRow = { id: 301, event_type: 'scope_change', action_code: 'release_add', summary: '加入上线单 R-1', ref_id: 9, operator_name: '示例客服B', created_at: '2026-09-17 10:00:00' };
                            const b = firstItemAttrs(tlPerDev([hiddenRow], [], ''));
                            assert.ok(b && /si-tl-release-scope/.test(b.cls), `对照组 release_add 应带可隐藏 class（否则本组 class 断言恒真无判别力），实得 class="${b && b.cls}"`);
                        });
                        check('[S3-A 直调·D9 边界] 恰 80 码点不截断且正文含全文无省略号；81 码点截断为 80+省略号', () => {
                            const exact80 = '甲'.repeat(80);
                            const h80 = tlPerDev([mkPerDevRow('dev_no_code', JSON.stringify({ dev_user_id: 5, dev_user_name: '开发甲', dev_assignee_id: 9, mode: 'no_code', submitted_at: '2026-09-17 09:59:00', no_code_reason: exact80 }))], [], '');
                            assert.ok(h80.includes(`：${exact80}`) && !h80.includes('…'), `恰 80 码点不应截断、不应出现省略号，实得 ${h80}`);
                            assert.ok(!h80.includes('<details'), '恰 80 码点不应产出展开区');
                            const over81 = '乙'.repeat(81);
                            const h81 = tlPerDev([mkPerDevRow('dev_no_code', JSON.stringify({ dev_user_id: 5, dev_user_name: '开发甲', dev_assignee_id: 9, mode: 'no_code', submitted_at: '2026-09-17 09:59:00', no_code_reason: over81 }))], [], '');
                            const expectedChunk = Array.from(over81).slice(0, 80).join('') + '…';
                            assert.ok(h81.includes(`：${expectedChunk}`), `81 码点应截断为 80+省略号，实得 ${h81}`);
                            assert.ok(h81.includes('<details class="si-tl-perdev-reason">') && h81.includes(`<pre>${over81}</pre>`), `81 码点应产出 si-tl-perdev-reason 展开区并含完整 81 码点原文，实得 ${h81}`);
                        });
                        check('[S3-A 直调·D9 转义] 危险片段（<script>/引号/&/换行）→ 正文摘要与展开区 pre 各自独立转义，整串无原始 <script>；title 路径同样精确转义且不含 reason 文本', () => {
                            const evilPrefix = '<script>"x"&\'y\'</script>\n第二行';
                            const evilReason = evilPrefix + 'a'.repeat(60);   // 总长 > 80，确保①触发展开区②截断后的摘要仍完整含危险片段
                            const h = tlPerDev([mkPerDevRow('dev_no_code', JSON.stringify({ dev_user_id: 5, dev_user_name: '开发甲', dev_assignee_id: 9, mode: 'no_code', submitted_at: '2026-09-17 09:59:00', no_code_reason: evilReason }))], [], '');
                            assert.ok(!h.includes('<script>'), '整串不应出现原始 <script>');
                            assert.strictEqual((h.match(/&lt;script&gt;/g) || []).length, 2, `正文摘要与展开区 pre 应各自恰含 1 处 &lt;script&gt;（共 2 处），实得 ${h}`);
                            // evilPrefix 含 "x"（2 个双引号）与 'y'（2 个单引号），每处出现各占 2 个转义字符，
                            // 正文摘要 + 展开区 pre 共 2 处出现 ⇒ 各自 2 × 2 = 4。
                            assert.strictEqual((h.match(/&quot;/g) || []).length, 4, '正文与 pre 应各自含 2 处 &quot;（共 4 处，"x" 两个双引号 × 2 处出现）');
                            assert.strictEqual((h.match(/&#39;/g) || []).length, 4, '正文与 pre 应各自含 2 处 &#39;（共 4 处，\'y\' 两个单引号 × 2 处出现）');
                            assert.ok((h.match(/&amp;/g) || []).length >= 2, '正文与 pre 应各自含 &amp;');
                            // title 路径：姓名含引号/尖括号/&，期望值由真实 esc() 计算得出（防手抄期望值出错）。
                            const evilName = '张"三"<b>&';
                            const hName = tlPerDev([mkPerDevRow('dev_submit_done', JSON.stringify({ dev_user_id: 5, dev_user_name: evilName, dev_assignee_id: 9, mode: 'code_submitted', submitted_at: '2026-09-17 09:59:00' }))], [], '');
                            // ⚠️ 不能用泛化的 /title="([^"]*)"/：整行渲染还含 si-tl-time 外层 div 的
                            // title（siFmtDTSec(created_at)），它排在正文 span 之前会被先命中——精确锚定
                            // 「不带 class 的 <span title=...>」这个逐人行专属特征。
                            const titleMatch = hName.match(/<span title="([^"]*)">/);
                            assert.ok(titleMatch, '应产出 title 属性');
                            const expectedTitle = escFn(evilName + ' · 代码已提交 · 2026-09-17 09:59:00');
                            assert.strictEqual(titleMatch[1], expectedTitle, `title 应精确转义（由真实 esc() 计算得出的期望值），实得 ${titleMatch[1]}`);
                            assert.ok(!titleMatch[1].includes('原因'), 'title 不应含 no_code 原因相关文本（本例 code_submitted 天然无原因，仅证明 title 只含姓名·模式·时刻三段）');
                        });
                        check('[S3-A 直调·D9 单码点 emoji 边界] 81 个单码点 emoji（非 ZWJ 组合）截断切口无 U+FFFD', () => {
                            const emoji81 = '😀'.repeat(81);
                            const h = tlPerDev([mkPerDevRow('dev_no_code', JSON.stringify({ dev_user_id: 5, dev_user_name: '开发甲', dev_assignee_id: 9, mode: 'no_code', submitted_at: '2026-09-17 09:59:00', no_code_reason: emoji81 }))], [], '');
                            assert.ok(!h.includes('�'), '截断切口不应出现 U+FFFD 替换字符（说明按码点而非 UTF-16 码元截断）');
                            assert.ok(h.includes('😀'.repeat(80) + '…'), '正文应含恰 80 个完整 emoji + 省略号');
                        });
                        // [codex 589 采纳·D9 补充] 前端配对用例——恰 80 个单码点 emoji 不截断（同后端
                        // verify-sys-perdev-done.js [C8·D9·emoji] 的前端等价物，用非 BMP 字符反证"按码点
                        // 而非 UTF-16 code unit 数上限"这条纪律，若实现误用 .length 会在此处提前截断）。
                        check('[S3-A 直调·D9 单码点 emoji 边界] 恰 80 个单码点 emoji 不截断（前端与后端 C8·D9·emoji 配对用例）', () => {
                            const emoji80 = '😀'.repeat(80);
                            const h = tlPerDev([mkPerDevRow('dev_no_code', JSON.stringify({ dev_user_id: 5, dev_user_name: '开发甲', dev_assignee_id: 9, mode: 'no_code', submitted_at: '2026-09-17 09:59:00', no_code_reason: emoji80 }))], [], '');
                            assert.ok(h.includes(`：${emoji80}`) && !h.includes('…'), `恰 80 个单码点 emoji 不应截断、不应出现省略号，实得 ${h}`);
                            assert.ok(!h.includes('<details'), '恰 80 个单码点 emoji 不应产出展开区');
                        });
                        check('[S3-A 直调] payload 降级四态：null/非 JSON/裸字符串 JSON/缺关键键 → 正文等于 esc(summary)，不抛、不出现 undefined 字样', () => {
                            const cases = [
                                ['payload_json=null', null],
                                ['非 JSON', '不是JSON'],
                                ['裸字符串 JSON', '"裸字符串"'],
                                ['缺 submitted_at', JSON.stringify({ dev_user_name: '张三' })],
                            ];
                            for (const [name, pj] of cases) {
                                const row = mkPerDevRow('dev_submit_done', pj);
                                const h = tlPerDev([row], [], '');
                                assert.ok(h.includes(escFn(row.summary)), `${name}：正文应等于 esc(summary)，实得 ${h}`);
                                assert.ok(!h.includes('undefined'), `${name}：不应出现 undefined 字样，实得 ${h}`);
                            }
                        });
                    }
                }
                // ══════════════════════════════════════════════════════════════════════
                // [长任务B·S4a·#64③收口] dev_withdraw 时间线自足——harness 直调渲染（复用 `tl`，
                //   同上方各组直调纪律，不新起一套装配）。escFnA 本地重建（复用 fnEsc 源码文本，
                //   tlPerDev 块内的 escFn 此处已出块作用域，不能跨块引用）。
                // eslint-disable-next-line no-new-func
                const escFnA = new Function(`${fnEsc}\nreturn esc;`)();
                check('[S4a] dev_withdraw 行：正文含「撤回提交 #<id>」尾注、不带 si-tl-release-scope、payload 非对象时回退 summary', () => {
                    const withdrawRow = { id: 400, event_type: 'note', action_code: 'dev_withdraw', ref_id: 9, round_no: 1, summary: '开发撤回提交：commit 记录填错了', operator_name: '开发甲', created_at: '2026-09-17 11:00:00', payload_json: JSON.stringify({ withdrawn_event_id: 88, commits: [{ commit_id: 1, component: 'backend', commit_ref: 'r-1' }] }) };
                    const h = tl([withdrawRow], [], '');
                    assert.ok(h.includes('撤回提交 #88'), `正文应含尾注「撤回提交 #88」，实得 ${h}`);
                    const a = firstItemAttrs(h);
                    assert.ok(a, 'dev_withdraw 行未渲染出 si-tl-item');
                    assert.ok(!/si-tl-release-scope/.test(a.cls), `dev_withdraw 行不应带可隐藏 class，实得 class="${a.cls}"`);
                    assert.ok(h.includes('si-tl-withdraw-detail'), '带 commits 快照时应产出 si-tl-withdraw-detail 展开区');
                    // payload 非对象（数组/裸字符串/缺 withdrawn_event_id）三态一律回退 esc(summary)，不抛、不出现 undefined。
                    for (const [name, pj] of [['数组', '[1,2]'], ['裸字符串', '"x"'], ['缺 withdrawn_event_id', JSON.stringify({ commits: [] })]]) {
                        const row = Object.assign({}, withdrawRow, { payload_json: pj });
                        const h2 = tl([row], [], '');
                        assert.ok(h2.includes(escFnA(row.summary)), `${name}：正文应回退为 esc(summary)，实得 ${h2}`);
                        assert.ok(!h2.includes('undefined'), `${name}：不应出现 undefined 字样，实得 ${h2}`);
                        assert.ok(!h2.includes('si-tl-withdraw-detail'), `${name}：不应产出展开区`);
                    }
                });
                // [codex 589 MED-2] commits 快照单重转义——map 内不再各自 esc(comp)/esc(ref)，改在
                //   <pre> 处统一 esc(commitLines) 一次；含 `&`/`<`/`>`/引号/换行的字段值应恰好转义一次，
                //   反转义（escFnA 的逆操作，用 HTML 实体表逐个替换回来）后应逐字等于原始拼接文本，且不
                //   应出现 `&amp;amp;` 这种双重转义的痕迹。
                check('[codex 589 MED-2] dev_withdraw commits 快照单重转义（非双重）', () => {
                    const specialChars = { component: 'back&end<x>', commit_ref: 'r-1 "quoted"\nline2' };
                    const row = { id: 405, event_type: 'note', action_code: 'dev_withdraw', ref_id: 9, round_no: 1, summary: '开发撤回提交', operator_name: '开发甲', created_at: '2026-09-17 11:05:00', payload_json: JSON.stringify({ withdrawn_event_id: 89, commits: [specialChars] }) };
                    const h = tl([row], [], '');
                    assert.ok(!h.includes('&amp;amp;'), `不应出现双重转义痕迹 &amp;amp;，实得 ${h}`);
                    const preMatch = h.match(/<pre>([\s\S]*?)<\/pre>/);
                    assert.ok(preMatch, `应产出 <pre> 展开区，实得 ${h}`);
                    const originalConcat = `${specialChars.component}: ${specialChars.commit_ref}`;
                    assert.strictEqual(preMatch[1], escFnA(originalConcat), `<pre> 内文本应恰为单重 esc(原始拼接文本)，实得 ${JSON.stringify(preMatch[1])}，期望 ${JSON.stringify(escFnA(originalConcat))}`);
                });
                // [codex 589 LOW-2] withdrawn_event_id 只接受正安全整数（number）或纯数字正整数字符串——
                //   空串/空白/0/负数/非数字文本六分支逐一断言回退 esc(summary)，不出现尾注/展开区。
                check('[codex 589 LOW-2·S4c3 附] withdrawn_event_id 非法值十分支应回退 esc(summary)（不显示尾注/展开区）', () => {
                    const baseRow = { id: 406, event_type: 'note', action_code: 'dev_withdraw', ref_id: 9, round_no: 1, summary: '开发撤回提交：xyz', operator_name: '开发甲', created_at: '2026-09-17 11:06:00' };
                    // [长任务B S4c3·codex 591-R 附] 原六分支 + 新增四例：1.5（非整数 number）、true（布尔，
                    //   typeof 既非 number 也非 string）、9007199254740993（字面量在 JS 里已舍入为
                    //   9007199254740992，仍非安全整数——Number.isSafeInteger 判 false）、'1e3'（字符串但
                    //   非纯数字形态，/^[0-9]+$/ 判不匹配）——四例按当前实现均应回退，非新行为，纯补覆盖面。
                    const invalidIds = ['', '   ', 0, -5, 'abc', '-1', 1.5, true, 9007199254740993, '1e3'];
                    for (const invalidId of invalidIds) {
                        const row = Object.assign({}, baseRow, { payload_json: JSON.stringify({ withdrawn_event_id: invalidId, commits: [{ component: 'x', commit_ref: 'y' }] }) });
                        const h = tl([row], [], '');
                        assert.ok(h.includes(escFnA(baseRow.summary)), `withdrawn_event_id=${JSON.stringify(invalidId)}：应回退为 esc(summary)，实得 ${h}`);
                        assert.ok(!/撤回提交 #/.test(h), `withdrawn_event_id=${JSON.stringify(invalidId)}：不应出现尾注，实得 ${h}`);
                        assert.ok(!h.includes('si-tl-withdraw-detail'), `withdrawn_event_id=${JSON.stringify(invalidId)}：不应产出展开区`);
                    }
                    // 合法边界：字符串形式的正整数（前导空白应被 trim 后接受）应正常显示尾注
                    const validRow = Object.assign({}, baseRow, { payload_json: JSON.stringify({ withdrawn_event_id: ' 42 ', commits: [] }) });
                    const hValid = tl([validRow], [], '');
                    assert.ok(hValid.includes('撤回提交 #42'), `withdrawn_event_id=" 42 "（trim 后为合法正整数字符串）应显示尾注，实得 ${hValid}`);
                });
                // ══════════════════════════════════════════════════════════════════════
                // [长任务B·S4b·#84 子项收口] 改期行批次号口径统一为业务编号——harness 直调（复用 `tl`）。
                // ══════════════════════════════════════════════════════════════════════
                check('[S4b] release_date_change/release_info_edit 展开区头行：payload 带 release_no → 业务编号（不含「批次 #」）；历史行（无 release_no）→ 回退「批次 #<id>」', () => {
                    const withRelNo = { id: 401, event_type: 'scope_change', action_code: 'release_date_change', ref_id: 9, summary: '上线计划日期变更：2026-09-20 → 2026-09-25（批次 R-20260917-1）', operator_name: '示例客服B', created_at: '2026-09-17 12:00:00', payload_json: JSON.stringify({ planned_date_old: '2026-09-20', planned_date_new: '2026-09-25', release_no: 'R-20260917-1', changes: [{ field: 'planned_date', old: '2026-09-20', new: '2026-09-25' }] }) };
                    const hWith = tl([withRelNo], [], '');
                    assert.ok(hWith.includes('上线批次（批次 R-20260917-1）'), `带 release_no 应显业务编号，实得 ${hWith.match(/变更对象：[^<]*/) || hWith}`);
                    assert.ok(!/批次 #\d/.test(hWith), `带 release_no 时不应再出现「批次 #数字」内部 id 口径，实得 ${hWith}`);
                    const withoutRelNo = Object.assign({}, withRelNo, { id: 402, payload_json: JSON.stringify({ planned_date_old: '2026-09-20', planned_date_new: '2026-09-25', changes: [{ field: 'planned_date', old: '2026-09-20', new: '2026-09-25' }] }) });
                    const hWithout = tl([withoutRelNo], [], '');
                    assert.ok(hWithout.includes('上线批次（批次 #9）'), `无 release_no（历史行）应回退内部 id 口径，实得 ${hWithout.match(/变更对象：[^<]*/) || hWithout}`);
                    // [长任务B·S4b2·2026-09-17] release_info_edit 同款处——后端（PATCH /sys-releases/:id
                    //   :18171 一带）已补 release_no 键，带该键时应与 release_date_change 同款显业务编号；
                    //   历史行（无该键，改造前写入）仍回退内部 id 口径，两态都要覆盖。
                    const infoEditWithRelNo = { id: 403, event_type: 'note', action_code: 'release_info_edit', ref_id: 11, summary: '上线单信息修改（标题）', operator_name: '示例客服B', created_at: '2026-09-17 12:01:00', payload_json: JSON.stringify({ changes: [{ field: 'title', old: 'A', new: 'B' }], release_no: 'R-20260917-2' }) };
                    const hInfoWith = tl([infoEditWithRelNo], [], '');
                    assert.ok(hInfoWith.includes('上线单信息（批次 R-20260917-2）'), `release_info_edit 带 release_no 应显业务编号，实得 ${hInfoWith.match(/变更对象：[^<]*/) || hInfoWith}`);
                    assert.ok(!/批次 #\d/.test(hInfoWith), `release_info_edit 带 release_no 时不应再出现「批次 #数字」，实得 ${hInfoWith}`);
                    const infoEditHistory = { id: 404, event_type: 'note', action_code: 'release_info_edit', ref_id: 11, summary: '上线单信息修改（标题）', operator_name: '示例客服B', created_at: '2026-09-17 12:01:00', payload_json: JSON.stringify({ changes: [{ field: 'title', old: 'A', new: 'B' }] }) };
                    const hInfoHistory = tl([infoEditHistory], [], '');
                    assert.ok(hInfoHistory.includes('上线单信息（批次 #11）'), `release_info_edit 历史行（无 release_no）应回退内部 id 口径，实得 ${hInfoHistory.match(/变更对象：[^<]*/) || hInfoHistory}`);
                });
            }
        }
    }
}
// ⚠️ 本组两条 check 刻意不在源码里写出连续的字面量 "grabFnA(name)"（含本注释、check 名、断言消息全部
//   避开）——本文件自身也会被 EXTRACT_FN_BODY_TARGET_NAMES 的自扫正则当成"selfClean"扫描一遍，若这里
//   直接写出该连续字面量，会把测试夹具自己的文本也当成一次真实非豁免调用而在 IIFE 阶段抢先报错（同
//   :195 一带"注释里写例子会被当真"同款坑，字符串字面量同理不被 stripComments 剥除）。改用拼接组装
//   注入串，源码文本层面不出现该连续字面量。
const G1_FN_TOKEN = 'grabFnA';
check('[G1·长任务B S4c] 动态参数 grabFnA 结构定位豁免——循环体外的裸调用必须判红（旧版按文本相等的豁免会静默放行）', () => {
    assert.ok(__selfCleanForG1Mutation, '未捕获到 selfClean（IIFE 未按预期执行，无法做 mutated 反例）');
    const mutated = __selfCleanForG1Mutation + "\nconst name = 'evil'; " + G1_FN_TOKEN + "(name);\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(bad.includes('name'), `循环体外的裸动态调用应被判定为非豁免，实得 ${JSON.stringify(bad)}——说明结构定位豁免已失效，退化回旧版纯文本判据`);
});
check('[G1·长任务B S4c2] 动态参数 grabFnA（结构匹配 for (const name of G1_GRAB_FN_A_LOOP_TARGETS) { … } 循环体内、遍历已登记枚举）应正确豁免', () => {
    const mutated = __selfCleanForG1Mutation + "\nfor (const name of " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + ") { " + G1_FN_TOKEN + "(name); }\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(!bad.includes('name'), `循环体内、遍历已登记枚举的动态调用不应被误判为违规，实得 ${JSON.stringify(bad)}`);
});
check('[G1·长任务B S4c2·codex 590 M5-①] for-of 遍历非登记枚举（内联数组字面量 [\'x\']，非 G1_GRAB_FN_A_LOOP_TARGETS）——循环体内调用不应被豁免，必须判红', () => {
    const mutated = __selfCleanForG1Mutation + "\nfor (const name of ['x']) { " + G1_FN_TOKEN + "(name); }\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(bad.includes('name'), `遍历非登记枚举（内联数组字面量）的循环体内调用应判红，实得 ${JSON.stringify(bad)}——若不判红，说明豁免仍接受任意内联数组，未真正绑定登记标识符`);
});
check('[G1·长任务B S4c2·codex 590 M5-②] 循环体内字符串字面量含裸花括号 "{" 不应干扰豁免判定（acorn 真实解析，非旧版括号计数启发式）', () => {
    const mutated = __selfCleanForG1Mutation + "\nfor (const name of " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + ") { const noise = 'a{b'; " + G1_FN_TOKEN + "(name); }\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(!bad.includes('name'), `字符串内裸花括号不应导致豁免判定失效，实得 ${JSON.stringify(bad)}`);
});
check('[G1·长任务B S4c2·codex 590 M5-③] 循环体内嵌套函数用同名参数遮蔽循环变量——该函数内部的调用不应被豁免，必须判红', () => {
    const mutated = __selfCleanForG1Mutation + "\nfor (const name of " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + ") { const wrap = (name) => { " + G1_FN_TOKEN + "(name); }; wrap('z'); }\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(bad.includes('name'), `嵌套函数同名参数遮蔽循环变量后，其内部调用不应被豁免，实得 ${JSON.stringify(bad)}`);
});
// [S4c3·codex 591-R M4] 三组新增反例：枚举标识符/循环变量的「按名字字符串相等」旧判据在此三种遮蔽
// 形态下都会误判豁免，改成作用域链解析（annotateScopeChains + isNameShadowedAtNode/collectExemptGrabFnACallStarts
// 的最近绑定帧比对）后，三组必须全部判红。
check('[G1·S4c3·M4-①] 局部同名枚举替换：内层函数用同名 const 局部重声明 G1_GRAB_FN_A_LOOP_TARGETS 顶替遍历目标（旧版按名字字符串相等会误信为模块级枚举）——须判红', () => {
    const mutated = __selfCleanForG1Mutation + "\n(function(){ const " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + " = ['evil']; for (const name of " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + ") { " + G1_FN_TOKEN + "(name); } })();\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(bad.includes('name'), `枚举标识符被内层同名局部声明遮蔽后不应再被当成模块级枚举豁免，实得 ${JSON.stringify(bad)}`);
});
check('[G1·S4c3·M4-②] 循环体内块级同名声明遮蔽循环变量（`const name` 直接写在循环体里，非嵌套函数）——须判红', () => {
    const mutated = __selfCleanForG1Mutation + "\nfor (const name of " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + ") { const name = 'z'; " + G1_FN_TOKEN + "(name); }\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(bad.includes('name'), `循环体内块级 const 同名重声明遮蔽循环变量后，其后调用不应被豁免，实得 ${JSON.stringify(bad)}`);
});
check('[G1·S4c3·M4-③] 嵌套同名 for-of 遮蔽外层循环变量（内层 for-of 遍历非登记枚举、变量名与外层同名）——须判红', () => {
    const mutated = __selfCleanForG1Mutation + "\nfor (const name of " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + ") { for (const name of ['z']) { " + G1_FN_TOKEN + "(name); } }\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(bad.includes('name'), `嵌套同名 for-of 遮蔽外层循环变量后，内层调用不应被豁免，实得 ${JSON.stringify(bad)}`);
});
// [长任务B S4c3·codex 591-R2 M4b·主会话亲核订正] 三组新增反例——`var`（函数作用域，含嵌套块内但不
// 下探嵌套函数）与 `switch` 各 case 共享一帧这两类词法帧盲区，此前完全没有对应帧，遮蔽会被漏判。
check('[G1·S4c3·M4b-①] 登记循环体内的嵌套函数中，函数体嵌套块内 `var name` 遮蔽外层循环变量（var 是函数作用域，须计入该函数自己的帧，不是块帧）——须判红', () => {
    const mutated = __selfCleanForG1Mutation + "\nfor (const name of " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + ") { const wrap = () => { if (true) { var name = 'evil'; } " + G1_FN_TOKEN + "(name); }; wrap(); }\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(bad.includes('name'), `嵌套函数体内块级 var 声明（函数作用域）遮蔽外层循环变量后，其后调用不应被豁免，实得 ${JSON.stringify(bad)}`);
});
check('[G1·S4c3·M4b-②] 内层函数用 `var` 重声明 G1_GRAB_FN_A_LOOP_TARGETS 顶替遍历目标（同 M4-① 但用 var 而非 const，验证函数帧的 var 收集路径，非块帧的 const/let 路径）——须判红', () => {
    const mutated = __selfCleanForG1Mutation + "\n(function(){ var " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + " = ['evil']; for (const name of " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + ") { " + G1_FN_TOKEN + "(name); } })();\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(bad.includes('name'), `枚举标识符被内层 var 重声明遮蔽后不应再被当成模块级枚举豁免，实得 ${JSON.stringify(bad)}`);
});
check('[G1·S4c3·M4b-③] switch 各 case 共享同一词法帧——case 内裸写（无花括号包裹）的 `const name` 遮蔽外层循环变量——须判红', () => {
    const mutated = __selfCleanForG1Mutation + "\nfor (const name of " + G1_GRAB_FN_A_LOOP_TARGETS_NAME + ") { switch (1) { case 1: const name = 'z'; " + G1_FN_TOKEN + "(name); break; } }\n";
    const bad = findNonExemptGrabFnACalls(mutated);
    assert.ok(bad.includes('name'), `switch case 内裸写的 const 同名声明（无花括号，与其它 case 共享同一词法帧）遮蔽外层循环变量后，其后调用不应被豁免，实得 ${JSON.stringify(bad)}`);
});
check('Sys_Iteration.html 内联脚本可编译（new Function，不执行）', () => {
    const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length > 0, '未找到内联 <script> 块');
    for (const s of scripts) {
        // eslint-disable-next-line no-new-func
        new Function(s);
    }
});

// [C4e·codex 560 M3 收口] 等所有 async check（见上方 M3-② 两组）的 pending promise 落定后再算总分/
// 决定退出码——本文件其余全部 check() 调用均为同步，`pending` 数组届时早已是空数组，`Promise.all([])`
// 立即 resolve，对既有同步跑法零延迟零行为变化。
(async () => {
    await Promise.all(pending);
    // [579-R rec] **单列「待裁定项」计数**：本文件里有"现状刻画"型检查（锁住已知缺陷的当前行为、
    //   等决策者裁定），它们通过**不代表**对应业务场景验收通过。若只打印「全部通过 N/N」，
    //   后人很容易把它读成"业务全绿"。故按检查名里的标记单独计数并显式提示。
    const pendingRuling = checkNames.filter((nm) => nm.includes('待裁定'));
    console.log(`\n${failed === 0 ? '[全部通过]' : '[失败]'} ${passed}/${passed + failed} 项断言${failed ? `，${failed} 项失败` : ''}`);
    if (pendingRuling.length) {
        console.log(`⚠️ 其中 ${pendingRuling.length} 项是「现状刻画·待裁定」——通过 ≠ 该业务场景验收通过：`);
        for (const nm of pendingRuling) console.log(`   · ${nm}`);
    }
    if (failed) {
        console.log('失败详情：');
        for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
        process.exit(1);
    }
})();
