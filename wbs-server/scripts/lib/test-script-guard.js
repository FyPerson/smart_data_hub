/**
 * #106 S4a：测试脚本静态分析器（共享模块）。
 *
 * 来源：从 verify-test-env-suite.js（S3b 套件，H 节静态守卫）1337–1866 行**原样**搬入（分析器本体：parseSource … analyzeScript，R1–R7 与收尾检查 analyzeClosers），
 * 供两处共用：① verify-test-env-suite.js 的 H 节（S3b 的 8 个代表脚本）；② verify-test-isolation-static.js（全目录守卫，扫 wbs-server/scripts/ 顶层全部 git 可见 .js）。
 * 本模块不做 I/O（不读文件、不起进程）。BEGIN / END 两行标记之间是原样搬入的分析器代码，改动它等于改 S3b 的守卫口径，须同时跑 verify-test-env.js 回归。
 * 新增部分（END 标记之后，逐项列全）：
 *   常量 / 正则：TIER1_CODES（T1–T5）、TEST_VAR_NAME_RE（T5 的测试变量名）、SECRET_ENV_NAMES（T2 的两个真实密钥变量）、SERVER_JS_RE（路径边界上以 server.js 结尾）、
 *     SERVER_JS_CMD_RE（命令串：分隔符边界正则，修复批 3 简化）、SERVER_REQ_RE（require 类实参里的 server / server.js）、SINK_NAMES、LOOP_TYPES（finish 检查用）；
 *   助手：calleeName、requiresChildProcess（require / import() 的 child_process，含 node: 前缀）、isSinkCall、isRequireClassCall（require / require.resolve）、tplText（模板串静态文本）、isFnNode；
 *   起主服务字符串 serverJsLiterals（sink / require 内外判定、命令串两处适用范围）、起进程能力 spawnCapability；
 *   Tier-1 扫描 scanTier1 / tier1Codes（含 envDestructurePattern：process.env 的解构读取，声明与赋值两种语法共用，T2 / T5 都用它）；finish(code) 尾部位置检查 finishViolations；
 *   S4b2b 追加 SELF_ISOLATED 一节（isSiExemptLiteral / selfIsolatedSpawnForms / selfIsolatedBindingForms / selfIsolatedFacts：窄 T3 豁免 + sink 形态与 child_process 绑定形态硬规则，放在 spawnCapability 之后；scanTier1 新增 opts.selfIsolated）；module.exports。
 */
'use strict';

const acorn = require('acorn');
const J = (v) => JSON.stringify(v);

// ===== BEGIN 原样搬入（verify-test-env-suite.js 1337–1866 行）=====
const IO_CALL_NAMES = new Set(['signAs', 'signToken', 'createPendingFixture', 'apiCall', 'cleanup', 'setCollabState']);
const FX_MEMBERS = ['BASE', 'DB_PATH', 'JWT_SECRET'];

function parseSource(src) {
    const comments = [];
    const ast = acorn.parse(src, { ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script', onComment: comments });
    return { ast, comments };
}
function stripComments(src, comments) {
    const out = src.split('');
    for (const c of comments) for (let i = c.start; i < c.end; i += 1) if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' ';
    return out.join('');
}
function walk(node, parents, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node, parents);
    parents.push(node);
    for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'start' || k === 'end') continue;
        const v = node[k];
        if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') walk(x, parents, visit); } else if (v && typeof v.type === 'string') walk(v, parents, visit);
    }
    parents.pop();
}
const isFn = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
const memberName = (m) => (m.computed ? (m.property.type === 'Literal' ? String(m.property.value) : null) : m.property.name);
const objName = (m) => (m.object.type === 'Identifier' ? m.object.name : null);

// ---- ready() 的来源绑定（S3b 收口小批，13T-R2 M5 / 预筛 LOW-2）：只认 test-env、_test-fixture 的导入绑定——本地 function ready(){}、别的模块的 srv.ready() 不算
const READY_MODULE_RE = /(?:^|\/)(?:_test-fixture|test-env)(?:\.js)?$/;
/** require('<test-env | _test-fixture>') 调用 → 模块名；否则 null */
const readyModuleOf = (n) => (isRequireLiteralCall(n) && READY_MODULE_RE.test(n.arguments[0].value) ? n.arguments[0].value : null);
const propKeyName = (p) => (p.computed ? null : (p.key.type === 'Identifier' ? p.key.name : (p.key.type === 'Literal' ? String(p.key.value) : null)));
/** 解构 / 参数模式里绑定的全部名字 */
function patternNames(p, out) {
    if (!p) return;
    switch (p.type) {
        case 'Identifier': out.push(p.name); break;
        case 'AssignmentPattern': patternNames(p.left, out); break;
        case 'RestElement': patternNames(p.argument, out); break;
        case 'ArrayPattern': p.elements.forEach((e) => patternNames(e, out)); break;
        case 'ObjectPattern': p.properties.forEach((q) => patternNames(q.type === 'RestElement' ? q.argument : q.value, out)); break;
        default: break;
    }
}
/** 整份源码里名字 name 的声明点个数（函数 / 类 / 变量 / 参数 / catch 参数；不分作用域——保守：多于 1 个就当「有歧义」） */
function countBindings(ast, name) {
    let n = 0;
    walk(ast, [], (x) => {
        const names = [];
        if ((x.type === 'FunctionDeclaration' || x.type === 'FunctionExpression' || x.type === 'ClassDeclaration' || x.type === 'ClassExpression') && x.id) names.push(x.id.name);
        if (isFn(x)) x.params.forEach((p) => patternNames(p, names));
        if (x.type === 'VariableDeclarator') patternNames(x.id, names);
        if (x.type === 'CatchClause' && x.param) patternNames(x.param, names);
        n += names.filter((k) => k === name).length;
    });
    return n;
}
/**
 * ready / teardown 的合法来源：{ objs: 绑定到 test-env / _test-fixture 模块对象的名字（const X = require(…) 与一层层的 const Y = X 别名）,
 *   fns: 从这两个模块（或它们的绑定）解构出的 ready（含 { ready: r } 别名）, tfns: 同样解构出的 teardown }。声明点多于 1 个的名字（本地同名函数 / 变量遮蔽）一律剔除。
 */
function collectModuleBindings(ast) {
    const objs = new Set(); const fns = new Set(); const tfns = new Set();
    const decls = [];
    walk(ast, [], (n) => { if (n.type === 'VariableDeclarator' && n.init) decls.push(n); });
    const take = (d) => {
        if (d.id.type === 'Identifier') { if (!objs.has(d.id.name)) { objs.add(d.id.name); return true; } return false; }
        let grew = false;
        if (d.id.type === 'ObjectPattern') {
            for (const p of d.id.properties) {
                if (p.type !== 'Property') continue;
                const k = propKeyName(p);
                if (p.value.type !== 'Identifier') continue;
                if (k === 'ready' && !fns.has(p.value.name)) { fns.add(p.value.name); grew = true; }
                if (k === 'teardown' && !tfns.has(p.value.name)) { tfns.add(p.value.name); grew = true; }
            }
        }
        return grew;
    };
    for (const d of decls) if (readyModuleOf(d.init) !== null) take(d);
    for (let again = true; again;) {   // 别名传播：const fx = F; const { ready: r } = fx;
        again = false;
        for (const d of decls) if (d.init.type === 'Identifier' && objs.has(d.init.name) && take(d)) again = true;
    }
    for (const set of [objs, fns, tfns]) for (const nm of Array.from(set)) if (countBindings(ast, nm) !== 1) set.delete(nm);
    return { objs, fns, tfns };
}
const NO_BINDINGS = Object.freeze({ objs: new Set(), fns: new Set(), tfns: new Set() });
/** ready() 调用：ready(…)（ready 是 test-env / _test-fixture 解构出来的绑定）、X.ready(…)（X 绑定到这两个模块之一）、require('<这两个模块>').ready(…)；其余对象的 .ready() 不算 */
function isReadyCall(n, aliases) {
    if (n.type !== 'CallExpression') return false;
    const rb = (aliases && aliases.ready) || NO_BINDINGS;
    const c = n.callee;
    if (c.type === 'Identifier') return rb.fns.has(c.name);
    if (c.type !== 'MemberExpression' || memberName(c) !== 'ready') return false;
    if (c.object.type === 'Identifier') return rb.objs.has(c.object.name);
    return readyModuleOf(c.object) !== null;
}
/** teardown() 调用：同上（teardown 解构绑定 / 模块对象的 .teardown） */
function isTeardownCall(n, aliases) {
    if (n.type !== 'CallExpression') return false;
    const rb = (aliases && aliases.ready) || NO_BINDINGS;
    const c = n.callee;
    if (c.type === 'Identifier') return rb.tfns.has(c.name);
    if (c.type !== 'MemberExpression' || memberName(c) !== 'teardown') return false;
    if (c.object.type === 'Identifier') return rb.objs.has(c.object.name);
    return readyModuleOf(c.object) !== null;
}
/** 夹具对象的名字：默认 fx，再加上 `const X = require('./_test-fixture')` 绑定的名字 */
function collectFixtureAliases(ast) {
    const names = new Set(['fx']);
    walk(ast, [], (n) => {
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && n.init.type === 'CallExpression' && n.init.callee.type === 'Identifier' && n.init.callee.name === 'require'
            && n.init.arguments[0] && n.init.arguments[0].type === 'Literal' && /(?:^|\/)_test-fixture(?:\.js)?$/.test(String(n.init.arguments[0].value))) names.add(n.id.name);
    });
    return names;
}
function isIoNode(n, aliases) {
    if (n.type === 'CallExpression') {
        const c = n.callee;
        if (c.type === 'Identifier') return ['fetch', 'spawn', 'spawnSync', 'exec', 'execFile', 'execFileSync', 'execSync', 'fork'].includes(c.name);   // exec：47R4b M2
        if (c.type === 'MemberExpression') {
            const name = memberName(c); const obj = objName(c);
            if (name === 'exec') return !!(aliases && aliases.fileHasCp) && !(c.object.type === 'Literal' && c.object.regex);   // X.exec(…)：只在文件 require 了 child_process 时算进程 I/O（与 isSinkCall 同口径；47R4b M2），正则字面量的 .exec 不算（47R4bc-R L）
            if ((name === 'request' || name === 'get') && (obj === 'http' || obj === 'https')) return true;
            if (name === 'launch' && ['chromium', 'firefox', 'webkit'].includes(obj)) return true;
            if (IO_CALL_NAMES.has(name)) return true;
            if (['spawn', 'spawnSync', 'execFile', 'execFileSync', 'execSync', 'fork'].includes(name)) return true;
            if (name === 'createServer' || name === 'listen') return true;
        }
        return false;
    }
    if (n.type === 'NewExpression') {
        const c = n.callee;
        if (c.type === 'MemberExpression' && memberName(c) === 'Database') return true;
        if (c.type === 'Identifier' && c.name === 'Database') return true;
        return false;
    }
    if (n.type === 'MemberExpression') {
        // fx.BASE / fx.DB_PATH / fx.JWT_SECRET 的成员读取（ready() 之前读取会抛 FX_NOT_READY；放在 ready() 之前说明脚本以为它是同步常量）
        const on = objName(n);
        return on !== null && aliases.has(on) && FX_MEMBERS.includes(memberName(n));
    }
    if (n.type === 'VariableDeclarator') {
        // 解构读取：const { BASE, DB_PATH: db } = fx;
        return n.id.type === 'ObjectPattern' && n.init && n.init.type === 'Identifier' && aliases.has(n.init.name)
            && n.id.properties.some((p) => p.type === 'Property' && ((p.key.type === 'Identifier' && !p.computed && FX_MEMBERS.includes(p.key.name)) || (p.key.type === 'Literal' && FX_MEMBERS.includes(String(p.key.value)))));
    }
    return false;
}

// ---- R1：写死的 3000（结构化：只看字符串 / 模板字面量里的 URL 形态，或端口赋值；不再对全文做 :3000 的子串匹配，所以 timeout:3000 这类紧凑写法不误报）
const URL3000_RE = /(?:https?:\/\/[^\s'"`/\\]*|(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)):\s*3000(?!\d)|^:\s*3000(?!\d)/i;
function isPort3000(v) {
    if (!v) return false;
    if (v.type === 'Literal') return v.value === 3000 || v.value === '3000';
    if (v.type === 'CallExpression' && v.callee.type === 'Identifier' && ['Number', 'parseInt', 'String'].includes(v.callee.name)) return isPort3000(v.arguments[0]);
    if (v.type === 'LogicalExpression') return isPort3000(v.left) || isPort3000(v.right);
    if (v.type === 'ConditionalExpression') return isPort3000(v.consequent) || isPort3000(v.alternate);
    return false;
}
// 端口类名字：整个名字就是 port，或以 _port 结尾（PORT / port / TEST_PORT / SERVER_PORT / my_port）；不再用 ^port 前缀（漏 TEST_PORT、SERVER_PORT；也会误伤 portal / portfolio 之类）
const PORT_NAME_RE = /(?:^|_)port$/i;
/** URL 里「主机:」之后紧接端口的位置：模板串 / 字符串拼接的前一段以此结尾，后面接的值就是端口 */
const HOST_COLON_TAIL_RE = /(?:https?:\/\/[^\s'"`/\\]*|(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)):\s*$/i;
const is3000Literal = (v) => !!v && v.type === 'Literal' && (v.value === 3000 || v.value === '3000');
function findHardcoded3000(ast) {
    const hits = [];
    // 值为 3000 的标识符（const P = 3000 / const P = x || 3000）：本身不报（可能是毫秒数），拼进 URL 的端口位置时才报
    const bound3000 = new Set();
    walk(ast, [], (n) => { if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isPort3000(n.init)) bound3000.add(n.id.name); });
    const is3000Value = (v) => is3000Literal(v) || (!!v && v.type === 'Identifier' && bound3000.has(v.name)) || isPort3000(v);
    walk(ast, [], (n) => {
        if (n.type === 'Literal' && typeof n.value === 'string' && URL3000_RE.test(n.value)) hits.push(`字符串 ${J(n.value.slice(0, 60))}`);
        if (n.type === 'TemplateLiteral') {
            const joined = n.quasis.map((q) => (q.value.cooked === null || q.value.cooked === undefined ? q.value.raw : q.value.cooked)).join('\u0000');
            if (URL3000_RE.test(joined)) hits.push(`模板串 ${J(joined.replace(/\u0000/g, '${}').slice(0, 60))}`);
            // `http://127.0.0.1:${P}`（P 是 3000 / 绑定了 3000 的标识符）：前一段以「主机:」结尾，后面的表达式就是端口
            n.expressions.forEach((ex, i) => {
                const q = n.quasis[i];
                const prefix = q.value.cooked === null || q.value.cooked === undefined ? q.value.raw : q.value.cooked;
                if (HOST_COLON_TAIL_RE.test(prefix) && is3000Value(ex)) hits.push(`模板串端口位置 \${${ex.type === 'Identifier' ? ex.name : '3000'}}（主机: 之后）`);
            });
        }
        // 'http://localhost:' + 3000 / 'http://localhost:' + P（含 a + b + c 的左结合内层）
        if (n.type === 'BinaryExpression' && n.operator === '+' && n.left.type === 'Literal' && typeof n.left.value === 'string' && HOST_COLON_TAIL_RE.test(n.left.value) && is3000Value(n.right)) {
            hits.push(`字符串拼接端口 ${J(n.left.value.slice(-40))} + 3000`);
        }
        if (n.type === 'Property' && !n.computed) {
            const key = n.key.type === 'Identifier' ? n.key.name : (n.key.type === 'Literal' ? String(n.key.value) : '');
            if (PORT_NAME_RE.test(key) && isPort3000(n.value)) hits.push(`端口属性 ${key}: 3000`);
        }
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && PORT_NAME_RE.test(n.id.name) && isPort3000(n.init)) hits.push(`端口常量 ${n.id.name} = 3000`);
        if (n.type === 'AssignmentExpression') {
            const l = n.left;
            const lname = l.type === 'Identifier' ? l.name : (l.type === 'MemberExpression' && !l.computed ? l.property.name : '');
            if (PORT_NAME_RE.test(lname) && isPort3000(n.right)) hits.push(`端口赋值 ${lname} = 3000`);
        }
    });
    return hits;
}

// ---- R4–R6：ready() 必须是入口函数里第一条有副作用的语句
/** 表达式语句的「头部调用」：main().catch(f) → main()；(async () => {...})().catch(f) → 那个 IIFE 调用；void main() 同理。找不到 → null */
function headCall(expr) {
    let e = expr;
    for (let i = 0; i < 20 && e; i += 1) {
        if (e.type === 'UnaryExpression' && e.operator === 'void') e = e.argument;
        else if (e.type === 'ChainExpression') e = e.expression;
        else if (e.type === 'CallExpression') {
            if (e.callee.type === 'MemberExpression') e = e.callee.object;
            else return e;
        } else if (e.type === 'MemberExpression') e = e.object;
        else return null;
    }
    return null;
}
/*
 * ready() 位置的硬规则（S3b 修复批 2a 撤销了修复批 1 的「顶层 try 首条」放宽——被证明留了空子：catch 吞掉 ready 失败后 try 外做 I/O、catch / finally 调本模块函数做 I/O、finally 里直接 I/O …）：
 *   ① 模块顶层只允许「声明」与恰好一个入口调用：声明 = 函数 / 类 / 初始值纯的 const·let·var / 'use strict' 指令；入口调用 = IIFE，或对模块顶层命名函数的直接调用（可带 .catch / .then / .finally 链，链上的实参只能是纯值，回调是函数表达式）。
 *      其他顶层可执行语句一律判红「无法判定，需人工豁免」；第二个入口调用（第二个 IIFE 等）同样判红。
 *   ② 入口函数体里，`await ready()`（独立语句：await ready(); / const x = await ready(); / x = await ready();）必须是**第一条有副作用的语句**：它之前只允许声明（函数声明、初始值纯的变量声明）。
 *      try / 条件分支 / 循环里的 ready、没被 await 的 ready、嵌在更大表达式里的 ready、ready 之前出现任何调用（辅助函数、夹具助手、console.log、解构出来的 signAs …）一律判红。
 *   纯初始值 = 字面量、模板串（表达式也纯）、标识符读取、成员读取（fx.BASE / fx.DB_PATH / fx.JWT_SECRET 除外：ready() 之前读取会抛错，算 I/O）、require('字面量')（及 require('sqlite3').verbose()）、函数 / 箭头函数表达式（只声明不调用）、
 *   数组 / 对象字面量（元素与值也纯）、一元 / 二元 / 逻辑 / 条件表达式（操作数也纯）、new Map / Set / WeakMap / WeakSet / RegExp。解构模式里的默认值也要纯。
 *   ③（收口小批）入口函数的**参数**（默认值表达式、解构的计算键）也必须纯：参数默认值在函数体之前求值，`main(r = fetch(url))` 的请求早于 ready()。
 *   ④（收口小批）模块顶层的同名函数声明一律判红 R6（后一个覆盖前一个，守卫与运行时可能看的不是同一个）；函数声明与顶层变量同名同样。
 *   ⑤（收口小批）ready() 的来源：只认 test-env / _test-fixture 的导入绑定（含合法别名与从这两个模块解构出的 ready）；本地 function ready(){}、别的模块的 srv.ready() 不算 ready()。
 *   ⑥（收口小批，D-1）入口调用链上的 .catch（及 .then 的第二个参数）回调必须以非零退出：回调体的**顶层语句**里有 `process.exit(非零整数字面量)` / `process.exitCode = 非零整数字面量` / `throw`，且在它之前没有顶层 return；
 *      ready() 失败时退出码兜底还没装上，catch 里只打印就自然结束会得到退出码 0。违反 → R7。回调不是函数表达式也不是顶层命名函数 → R6。
 *   残余（登记，不判定）：入口调用链上 .catch / .finally 回调里的 I/O（它们在入口函数落定之后才跑，ready 已经跑过或已经失败）；require(...) 加载的模块本身在加载时做什么；
 *      `'http://' + host + ':' + P` 这类经变量中转的 URL 拼接不报 R1（预筛 LOW-3d，登记残余）。
 */
const PURE_NEW = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp']);
const isRequireLiteralCall = (n) => !!n && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments.length === 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string';
function isPureExpr(n, aliases) {
    if (!n) return true;
    const P = (x) => isPureExpr(x, aliases);
    switch (n.type) {
        case 'Literal': case 'Identifier': case 'ThisExpression': return true;
        case 'TemplateLiteral': return n.expressions.every(P);
        case 'MemberExpression': {
            const on = objName(n);
            if (on !== null && aliases.has(on) && FX_MEMBERS.includes(memberName(n))) return false;
            return P(n.object) && (!n.computed || P(n.property));
        }
        case 'ChainExpression': return P(n.expression);
        case 'CallExpression':
            if (isRequireLiteralCall(n)) return true;
            // require('sqlite3').verbose()：只打开 sqlite3 的详细堆栈开关，无 I/O（脚本里的惯用写法，窄白名单；收口小批：模块名限定 sqlite3——别的模块的 .verbose() 不知道做什么）
            return n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.property.name === 'verbose' && n.arguments.length === 0 && isRequireLiteralCall(n.callee.object) && n.callee.object.arguments[0].value === 'sqlite3';
        case 'ArrowFunctionExpression': case 'FunctionExpression': return true;
        case 'ArrayExpression': return n.elements.every((e) => e === null || (e.type === 'SpreadElement' ? P(e.argument) : P(e)));
        case 'ObjectExpression': return n.properties.every((p) => (p.type === 'SpreadElement' ? P(p.argument) : ((!p.computed || P(p.key)) && P(p.value))));
        case 'UnaryExpression': return n.operator !== 'delete' && P(n.argument);
        case 'BinaryExpression': case 'LogicalExpression': return P(n.left) && P(n.right);
        case 'ConditionalExpression': return P(n.test) && P(n.consequent) && P(n.alternate);
        case 'NewExpression': return n.callee.type === 'Identifier' && PURE_NEW.has(n.callee.name) && n.arguments.every(P);
        default: return false;
    }
}
function isPurePattern(p, aliases) {
    if (!p) return true;
    switch (p.type) {
        case 'Identifier': return true;
        case 'AssignmentPattern': return isPurePattern(p.left, aliases) && isPureExpr(p.right, aliases);
        case 'RestElement': return isPurePattern(p.argument, aliases);
        case 'ArrayPattern': return p.elements.every((e) => e === null || isPurePattern(e, aliases));
        case 'ObjectPattern': return p.properties.every((q) => (q.type === 'RestElement' ? isPurePattern(q.argument, aliases) : ((!q.computed || isPureExpr(q.key, aliases)) && isPurePattern(q.value, aliases))));
        default: return false;
    }
}
function isPureClass(c, aliases) {
    if (c.superClass && !isPureExpr(c.superClass, aliases)) return false;
    return c.body.body.every((m) => {
        if (m.type === 'StaticBlock') return false;
        if (m.computed && !isPureExpr(m.key, aliases)) return false;
        if (m.type === 'PropertyDefinition' && m.static && !isPureExpr(m.value, aliases)) return false;
        return true;
    });
}
/** 「声明」语句：函数 / 类声明、初始值纯的变量声明、'use strict' 之类的指令、空语句 */
function isDeclStmt(st, aliases) {
    switch (st.type) {
        case 'FunctionDeclaration': case 'EmptyStatement': return true;
        case 'ClassDeclaration': return isPureClass(st, aliases);
        case 'VariableDeclaration': return st.declarations.every((d) => !isIoNode(d, aliases) && isPurePattern(d.id, aliases) && isPureExpr(d.init, aliases));   // isIoNode(declarator)：const { BASE } = fx 这类解构读取不算声明
        case 'ExpressionStatement': return typeof st.directive === 'string';
        default: return false;
    }
}
/** 入口调用链（main().catch(f).finally(g) / (async () => {…})().catch(f) / void main()）上所有调用的实参都是纯值 */
function chainArgsPure(expr, aliases) {
    let e = expr;
    for (let i = 0; i < 20 && e; i += 1) {
        if (e.type === 'UnaryExpression' && e.operator === 'void') e = e.argument;
        else if (e.type === 'ChainExpression') e = e.expression;
        else if (e.type === 'AwaitExpression') e = e.argument;
        else if (e.type === 'CallExpression') {
            if (!e.arguments.every((a) => isPureExpr(a.type === 'SpreadElement' ? a.argument : a, aliases))) return false;
            e = e.callee.type === 'MemberExpression' ? e.callee.object : null;
        } else if (e.type === 'MemberExpression') e = e.object;
        else return true;
    }
    return true;
}
/** 语句（子树）里是否含 ready() 调用 / I/O 节点——只用来给违规定性（R5 = 有 I/O，R6 = 无法判定） */
function subtreeFacts(node, aliases) {
    const facts = { ready: false, io: false };
    walk(node, [], (n) => { if (isReadyCall(n, aliases)) facts.ready = true; if (isIoNode(n, aliases)) facts.io = true; });
    return facts;
}
/** `await ready(...)` 形态的语句（await ready(); / const x = await ready(); / x = await ready();），实参纯 → 返回 ready 调用节点；否则 null */
function awaitReadyStmt(st, aliases) {
    let ex = null;
    if (st.type === 'ExpressionStatement') ex = st.expression.type === 'AssignmentExpression' && st.expression.operator === '=' ? st.expression.right : st.expression;
    else if (st.type === 'VariableDeclaration' && st.declarations.length === 1) ex = st.declarations[0].init;
    if (!ex || ex.type !== 'AwaitExpression' || !isReadyCall(ex.argument, aliases)) return null;
    return ex.argument.arguments.every((a) => isPureExpr(a.type === 'SpreadElement' ? a.argument : a, aliases)) ? ex.argument : null;
}
/** 模块顶层的命名函数（函数声明 / const·let 绑定的函数表达式）；找不到 → null（同名重复由 checkReadyPlacement 另判 R6） */
function resolveTopFn(name, ast) {
    for (const st of ast.body) {
        if (st.type === 'FunctionDeclaration' && st.id && st.id.name === name) return st;
        if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier' && d.id.name === name && d.init && isFn(d.init)) return d.init;
    }
    return null;
}
/** 入口调用的函数：IIFE 的函数表达式，或顶层命名函数；解析不到 → null */
function resolveEntryFn(hc, ast) {
    const c = hc.callee;
    if (c.type === 'FunctionExpression' || c.type === 'ArrowFunctionExpression') return c;
    if (c.type !== 'Identifier') return null;
    return resolveTopFn(c.name, ast);
}
/** 回调实参 → 函数节点：函数表达式 / 箭头函数，或顶层命名函数的标识符；其余（调用、成员…）→ null */
function resolveCallbackFn(cb, ast) {
    if (cb.type === 'FunctionExpression' || cb.type === 'ArrowFunctionExpression') return cb;
    if (cb.type === 'Identifier') return resolveTopFn(cb.name, ast);
    return null;
}
/** 入口调用链上的回调：err = .catch(f) 的 f 与 .then(a, f) 的 f；ok = .then(f) 的 f 与 .finally(f) 的 f（成功路径也会跑） */
function entryChainCallbacks(expr) {
    const err = []; const ok = [];
    let e = expr;
    for (let i = 0; i < 20 && e; i += 1) {
        if (e.type === 'UnaryExpression' && e.operator === 'void') e = e.argument;
        else if (e.type === 'ChainExpression') e = e.expression;
        else if (e.type === 'AwaitExpression') e = e.argument;
        else if (e.type === 'CallExpression') {
            if (e.callee.type !== 'MemberExpression') break;
            const nm = memberName(e.callee);
            if (nm === 'catch' && e.arguments[0]) err.push(e.arguments[0]);
            else if (nm === 'then') { if (e.arguments[0]) ok.push(e.arguments[0]); if (e.arguments[1]) err.push(e.arguments[1]); } else if (nm === 'finally' && e.arguments[0]) ok.push(e.arguments[0]);
            e = e.callee.object;
        } else if (e.type === 'MemberExpression') e = e.object;
        else break;
    }
    return { err, ok };
}
const isNonZeroIntLiteral = (v) => !!v && v.type === 'Literal' && typeof v.value === 'number' && Number.isInteger(v.value) && v.value !== 0;
/** process.exit(非零整数字面量) / process.exitCode = 非零整数字面量 */
function isNonZeroExitExpr(ex) {
    if (!ex) return false;
    if (ex.type === 'CallExpression' && ex.callee.type === 'MemberExpression' && objName(ex.callee) === 'process' && memberName(ex.callee) === 'exit') return isNonZeroIntLiteral(ex.arguments[0]);
    if (ex.type === 'AssignmentExpression' && ex.operator === '=' && ex.left.type === 'MemberExpression' && objName(ex.left) === 'process' && memberName(ex.left) === 'exitCode') return isNonZeroIntLiteral(ex.right);
    return false;
}
/** 错误回调是否以非零退出：表达式体 → 表达式本身是非零退出；块体 → 顶层语句里先遇到 throw / 非零退出（先遇到 return 则否） */
function errCallbackExitsNonZero(fn) {
    if (!fn.body || fn.body.type !== 'BlockStatement') return isNonZeroExitExpr(fn.body);
    for (const st of fn.body.body) {
        if (st.type === 'ThrowStatement') return true;
        if (st.type === 'ReturnStatement') return false;
        if (st.type === 'ExpressionStatement' && isNonZeroExitExpr(st.expression)) return true;
    }
    return false;
}
/** ready() 位置的硬规则检查（见上面的块注释）；返回违规 [{ rule, detail }] */
function checkReadyPlacement(ast, aliases) {
    const out = [];
    // ④ 顶层同名函数声明（含函数声明与顶层变量同名）：后一个覆盖前一个，一律 R6
    const topNames = new Map();
    for (const st of ast.body) if (st.type === 'FunctionDeclaration' && st.id) topNames.set(st.id.name, (topNames.get(st.id.name) || 0) + 1);
    for (const st of ast.body) {
        if (st.type !== 'VariableDeclaration') continue;
        for (const d of st.declarations) { const ns = []; patternNames(d.id, ns); for (const k of ns) if (topNames.has(k)) topNames.set(k, topNames.get(k) + 1); }
    }
    for (const [k, c] of topNames) if (c > 1) out.push({ rule: 'R6', detail: `模块顶层同名声明 ${k} 出现 ${c} 次（函数声明重复 / 与顶层变量同名，后一个覆盖前一个；守卫与运行时看的可能不是同一个，无法判定，需人工豁免）` });
    const entryCalls = [];
    for (const st of ast.body) {
        if (isDeclStmt(st, aliases)) continue;
        if (st.type === 'ExpressionStatement') {
            const hc = headCall(st.expression);
            if (hc) { entryCalls.push({ st, hc }); continue; }
        }
        const f = subtreeFacts(st, aliases);
        out.push({ rule: f.io ? 'R5' : 'R6', detail: `模块顶层有可执行语句（只允许声明与一个入口调用；无法判定，需人工豁免）：${st.type}@${st.start}${f.io ? '，其中有 I/O（加载时就执行，早于入口函数里的 ready()）' : ''}` });
    }
    if (entryCalls.length !== 1) {
        const ioExtra = entryCalls.some((c) => subtreeFacts(c.st, aliases).io);
        out.push({ rule: entryCalls.length > 1 && ioExtra ? 'R5' : 'R6', detail: `模块顶层必须恰有一个入口调用（IIFE 或对顶层命名函数的直接调用），实际 ${entryCalls.length} 个${entryCalls.length > 1 ? `（${entryCalls.map((c) => `@${c.st.start}`).join('、')}；多出来的入口调用在加载时就执行，无法保证 ready() 先于它）` : ''}` });
        return out;
    }
    const { st: callStmt, hc } = entryCalls[0];
    if (!hc.arguments.every((a) => isPureExpr(a.type === 'SpreadElement' ? a.argument : a, aliases)) || !chainArgsPure(callStmt.expression, aliases)) {
        out.push({ rule: 'R6', detail: `入口调用（@${callStmt.start}）的实参 / 链上实参含有副作用（只能是纯值或函数表达式），无法判定` });
        return out;
    }
    // ⑥ D-1：入口调用链上的 .catch（及 .then 的第二个参数）回调必须以非零退出（ready() 失败时兜底还没装上）
    for (const cb of entryChainCallbacks(callStmt.expression).err) {
        const cf = resolveCallbackFn(cb, ast);
        if (!cf) out.push({ rule: 'R6', detail: `入口调用链上的错误回调（@${cb.start}）不是函数表达式也不是模块顶层的命名函数，无法确认它以非零退出` });
        else if (!errCallbackExitsNonZero(cf)) out.push({ rule: 'R7', detail: `入口调用链上的 .catch 回调（@${cb.start}）没有以非零退出：回调体顶层语句里需要 process.exit(非零) / process.exitCode = 非零 / throw（ready() 失败时退出码兜底还没装上，只打印就自然结束会得到退出码 0）` });
    }
    const fn = resolveEntryFn(hc, ast);
    if (!fn) { out.push({ rule: 'R6', detail: `入口调用（@${callStmt.start}）调用的不是 IIFE 也不是模块顶层的命名函数，无法找到入口函数体` }); return out; }
    // ③ 入口函数的参数：默认值表达式 / 解构计算键在函数体之前求值，必须纯
    const impureParam = fn.params.find((p) => !isPurePattern(p, aliases));
    if (impureParam) {
        const f = subtreeFacts(impureParam, aliases);
        out.push({ rule: f.io ? 'R5' : 'R6', detail: `入口函数的参数（@${impureParam.start}）含非纯的默认值表达式 / 解构计算键（参数在函数体之前求值，早于 ready()）${f.io ? '，其中有 I/O' : '，无法判定'}` });
        return out;
    }
    if (!fn.body || fn.body.type !== 'BlockStatement') { out.push({ rule: 'R6', detail: '入口函数是表达式体箭头函数，无法确定 ready() 位置' }); return out; }
    const first = fn.body.body.find((st) => !isDeclStmt(st, aliases));
    if (!first) { out.push({ rule: 'R6', detail: '入口函数体里只有声明，没有 ready()' }); return out; }
    if (awaitReadyStmt(first, aliases) === null) {
        const f = subtreeFacts(first, aliases);
        out.push({ rule: f.ready ? 'R6' : (f.io ? 'R5' : 'R6'), detail: f.ready
            ? `入口函数里第一条有副作用的语句（${first.type}@${first.start}）含 ready() 但不是独立的 \`await ready()\` 语句（没有 await / 在 try·条件分支·循环里 / 嵌在更大的表达式里），无法确定必经`
            : `入口函数里第一条有副作用的语句（${first.type}@${first.start}）不是 \`await ready()\`${f.io ? '：ready() 之前出现网络 / 库 / 浏览器 / 进程 I/O（含 fx.BASE / fx.DB_PATH / fx.JWT_SECRET 成员读取与解构）' : '：ready() 之前出现有副作用的调用，无法判定'}` });
    }
    return out;
}

/**
 * 脚本的收尾（H.19，按用户裁定：`await teardown()` 或 `process.exit(…)` 二选一）。从入口函数、入口链上成功路径会跑的回调（.finally(f) / .then(f)）出发，沿模块顶层命名函数的直接调用走一遍
 * （不进入嵌套函数内部——嵌套的回调可能永远不被调用），找：
 *   teardown = 被 await 的 test-env / 夹具 teardown()（`await fx.teardown()`、`await fx.teardown().catch(f)`；没有 await 的裸调用不算——收尾没等到就退出）；
 *   exit     = `process.exit(…)` 调用（`process.exitCode = …` 不算：它不会让进程退出，自然排空时兜底仍会介入）。
 * 只定义了函数但入口调用不到它 → 不算。找不到入口（不是恰好一个入口调用）→ 两者都 false。
 */
function findClosers(ast, aliases) {
    const res = { teardown: false, exit: false };
    const entries = [];
    for (const st of ast.body) { if (st.type === 'ExpressionStatement') { const hc = headCall(st.expression); if (hc) entries.push({ st, hc }); } }
    if (entries.length !== 1) return res;
    const { st, hc } = entries[0];
    const queue = [];
    const entryFn = resolveEntryFn(hc, ast);
    if (entryFn) queue.push(entryFn);
    for (const cb of entryChainCallbacks(st.expression).ok) { const f = resolveCallbackFn(cb, ast); if (f) queue.push(f); }
    const chainCalls = (e) => {
        const calls = [];
        let x = e;
        for (let i = 0; i < 20 && x; i += 1) {
            if (x.type === 'ChainExpression') x = x.expression;
            else if (x.type === 'CallExpression') { calls.push(x); x = x.callee.type === 'MemberExpression' ? x.callee.object : null; } else if (x.type === 'MemberExpression') x = x.object;
            else break;
        }
        return calls;
    };
    const seen = new Set();
    const visit = (n) => {
        if (!n || typeof n.type !== 'string') return;
        if (isFn(n)) return;
        if (n.type === 'CallExpression') {
            if (n.callee.type === 'MemberExpression' && objName(n.callee) === 'process' && memberName(n.callee) === 'exit') res.exit = true;
            if (n.callee.type === 'Identifier') { const f = resolveTopFn(n.callee.name, ast); if (f) queue.push(f); }
        }
        if (n.type === 'AwaitExpression' && chainCalls(n.argument).some((c) => isTeardownCall(c, aliases))) res.teardown = true;
        for (const k of Object.keys(n)) {
            if (k === 'type' || k === 'start' || k === 'end') continue;
            const v = n[k];
            if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') visit(x); } else if (v && typeof v.type === 'string') visit(v);
        }
    };
    while (queue.length) {
        const f = queue.shift();
        if (seen.has(f)) continue;
        seen.add(f);
        visit(f.body);
    }
    return res;
}
function analyzeClosers(src) {
    const parsed = parseSource(src);
    const aliases = collectFixtureAliases(parsed.ast);
    aliases.ready = collectModuleBindings(parsed.ast);
    return findClosers(parsed.ast, aliases);
}

/**
 * 分析一份脚本源码，返回违规列表 [{ rule, detail }]。rule：
 *   R1 写死的 3000（字符串 / 模板串里的 URL 形态、PORT 类属性 / 常量 / 赋值 = 3000，结构化识别）；R2 真实库路径（task_pool.db 字面量）/ 加载真实 .env（dotenv）/ 读 process.env.JWT_SECRET|DB_ENCRYPTION_KEY；
 *   R3 自 spawn server.js（字符串字面量以 server.js 结尾）；R4 没有 ready() 调用（豁免清单除外）/ 豁免脚本含 I/O；
 *   R5 入口函数里第一条有副作用的语句不是 `await ready()` 且它含网络 / 库 / 浏览器 / 进程 I/O（含 fx.BASE / fx.DB_PATH / fx.JWT_SECRET 成员读取与解构），或模块顶层（函数外）的可执行语句 / 多余的入口调用含 I/O；
 *   R6 其余「无法判定」：模块顶层有非声明的可执行语句、入口调用不是恰好一个、ready() 没被 await / 在 try·条件分支·循环里 / 嵌在更大的表达式里、ready() 之前出现有副作用的调用、顶层同名函数声明、
 *      入口函数参数含非纯默认值、入口链上的错误回调无法解析（见 checkReadyPlacement 前的块注释；无法确定一律拒绝）；R7 入口调用链上的 .catch 回调没有以非零退出（D-1）。
 * opts.exemptNoReady：该脚本是否在豁免清单里。注释先剥离（字符串内容保留）。
 */
function analyzeScript(name, src, opts) {
    const o = opts || {};
    const violations = [];
    let parsed;
    try { parsed = parseSource(src); } catch (e) { return [{ rule: 'PARSE', detail: e.message }]; }
    const text = stripComments(src, parsed.comments);
    for (const h of findHardcoded3000(parsed.ast)) violations.push({ rule: 'R1', detail: `写死 3000：${h}` });
    if (/task_pool\.db/.test(text)) violations.push({ rule: 'R2', detail: '出现 task_pool.db 字面量（真实库路径）' });
    if (/require\(\s*['"]dotenv['"]\s*\)|\bdotenv\b/.test(text)) violations.push({ rule: 'R2', detail: '加载 dotenv（真实 .env）' });
    if (/process\.env\.(?:JWT_SECRET|DB_ENCRYPTION_KEY)\b/.test(text)) violations.push({ rule: 'R2', detail: '直接读 process.env.JWT_SECRET / DB_ENCRYPTION_KEY（应经 test-env）' });
    const aliases = collectFixtureAliases(parsed.ast);
    aliases.ready = collectModuleBindings(parsed.ast);   // ready() / teardown() 的合法来源（只认 test-env、_test-fixture 的导入绑定）
    aliases.fileHasCp = requiresChildProcess(parsed.ast);   // isIoNode 判 X.exec(…) 用
    const ioNodes = [];
    const readyCalls = [];
    walk(parsed.ast, [], (n, parents) => {
        if (n.type === 'Literal' && typeof n.value === 'string' && /(?:^|[\\/])server\.js$/.test(n.value)) violations.push({ rule: 'R3', detail: `字符串字面量指向 server.js：${n.value}` });
        if (isReadyCall(n, aliases)) readyCalls.push({ node: n, parents: parents.slice() });
        if (isIoNode(n, aliases)) ioNodes.push({ node: n, parents: parents.slice() });
    });
    if (o.exemptNoReady) {
        if (ioNodes.length > 0 || readyCalls.length > 0) violations.push({ rule: 'R4', detail: `豁免脚本含 I/O 或 ready() 调用：${ioNodes.slice(0, 3).map((x) => x.node.type + '@' + x.node.start).join(',')}` });
        return violations;
    }
    if (readyCalls.length === 0) { violations.push({ rule: 'R4', detail: '没有 ready() 调用' }); return violations; }
    // 硬规则（见 checkReadyPlacement 前的块注释）：ready() 是入口函数体里第一条有副作用的语句且被 await，模块顶层只有声明与一个入口调用
    violations.push(...checkReadyPlacement(parsed.ast, aliases));
    return violations;
}
// ===== END 原样搬入 =====

// ======================================================================
// 以下是 S4a 新增（不属于从 verify-test-env-suite.js 原样搬入的段）
// ======================================================================

/** Tier-1 规则代号（全目录守卫对「未登记」与「基线」两类脚本用）。T1 写死 3000 · T2 真实库 / .env / 密钥环境变量 · T3 自起主服务 · T4 用了夹具 / test-env 但没登记 · T5 绕过 test-env 直接读测试变量 */
const TIER1_CODES = Object.freeze(['T1', 'T2', 'T3', 'T4', 'T5']);
/** T5 的变量名（任意大小写） */
const TEST_VAR_NAME_RE = /^TEST_(?:INSTANCE|BASE_URL|DB_PATH|JWT_SECRET|TARGET|LIVE_URL)$/i;
/** T2 的两个真实密钥环境变量（区分大小写，与分析器 R2 一致） */
const SECRET_ENV_NAMES = Object.freeze(['JWT_SECRET', 'DB_ENCRYPTION_KEY']);

// ---------------------------------------------------------------- 起主服务的字面量（T3）
/** 与分析器 R3 同一个正则：字符串字面量以 server.js 结尾（路径边界） */
const SERVER_JS_RE = /(?:^|[\\/])server\.js$/;
/**
 * 命令串（修复批 3 简化，用户裁定 U6 = A）：一条分隔符边界正则，不按命令形态细分，宁可误红。
 *   左边界 = 串首 / 空白 / 双引号 / 单引号 / 等号 / 反斜杠（\x5c）/ 斜杠 / 模板占位（\u0000）；右边界 = 串尾 / 空白 / 双引号 / 单引号 / & | ; < > / 右括号 / 模板占位。
 *   命中：`node server.js`、`node ./server.js --port 0`、`node ../server.js > out.log`、`node wbs-server/server.js --x`、`node "server.js"`、`.\server.js`、`server.js&`、模板串 `${ROOT}/server.js --port ${p}`。
 *   不命中：`server.json`、`my-server.js`、`xserver.js`（边界不满足）。
 * 适用范围（任一）：① sink 调用实参子树里的全部字符串字面量与模板串静态片段；② 文件 require / import() 了 child_process 时，文件里的全部字符串字面量与模板串静态片段（一并解决别名：
 *   `util.promisify(cp.exec)`、`{ exec: run }`）。sink 外的路径字面量（以 server.js 结尾）仍走 SERVER_JS_RE + SOURCE_READERS 的老规则。
 */
const SERVER_JS_CMD_RE = /(?:^|[\s"'=\x5c/\u0000])server\.js(?=$|[\s"'&|;<>)\u0000])/;
/** require / import 的实参：路径边界上以 server 或 server.js 结尾（`../server`） */
const SERVER_REQ_RE = /(?:^|[\\/])server(?:\.js)?$/;
/**
 * sink：调用的被调名或成员名是这些之一（child_process.spawn(...)、解构出来的 spawn(...)、cp.fork(...) 都算）。判定规则（确定性硬规则，不是智能放行）：
 *   · 被调名是裸标识符（spawn(…) / exec(…) / execSync(…)，通常是从 child_process 解构出来的）→ 算；
 *   · 成员调用 X.spawn / X.spawnSync / X.fork / X.execSync / X.execFile / X.execFileSync → 算（这几个名字几乎不会撞上别的 API）；
 *   · 成员调用 X.exec(…) → 只有文件里出现 require('child_process') / require('node:child_process') / import('child_process') / import('node:child_process')（含解构、含赋给任意变量）时才算；否则不算（正则的 re.exec(text)）。
 *     理由：SOURCE_READERS 的 SPAWN 硬门本来就禁止 require child_process，所以 SR 文件里不可能有真正的 cp.exec；require 了 child_process 的文件里 re.exec 被算成 sink 只会误红（安全方向）。
 */
const SINK_NAMES = new Set(['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync']);
function calleeName(c) {
    if (!c) return null;
    if (c.type === 'Identifier') return c.name;
    if (c.type === 'MemberExpression') return c.computed ? (c.property.type === 'Literal' ? String(c.property.value) : null) : c.property.name;
    return null;
}
/** 文件里有没有 require('child_process') / require('node:child_process') / import('child_process')（任意形态：赋给变量、解构、直接调用） */
function requiresChildProcess(ast) {
    let found = false;
    walk(ast, [], (n) => {
        if (isRequireLiteralCall(n) && /^(?:node:)?child_process$/.test(n.arguments[0].value)) found = true;
        if (n.type === 'ImportExpression' && n.source.type === 'Literal' && /^(?:node:)?child_process$/.test(String(n.source.value))) found = true;
    });
    return found;
}
/** 调用节点是不是 sink 调用；fileHasCp = 文件里是否 require 了 child_process（只影响成员调用 X.exec(…)，见 SINK_NAMES 的注释） */
const isSinkCall = (n, fileHasCp) => {
    if (n.type !== 'CallExpression') return false;
    const name = calleeName(n.callee);
    if (!SINK_NAMES.has(name)) return false;
    if (name === 'exec' && n.callee.type === 'MemberExpression') return !!fileHasCp;
    return true;
};
/** require(…) / require.resolve(…) 调用（被调表达式是标识符 require，或 require.resolve） */
const isRequireClassCall = (n) => n.type === 'CallExpression' && (
    (n.callee.type === 'Identifier' && n.callee.name === 'require')
    || (n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.object.type === 'Identifier' && n.callee.object.name === 'require' && n.callee.property.name === 'resolve'));
/** 模板串的静态文本：表达式位置用 \u0000 占位（所以 `${ROOT}/server.js` 在路径边界上以 server.js 结尾，而 `${ROOT}server.js` 不算） */
const tplText = (t) => t.quasis.map((q) => (q.value.cooked === null || q.value.cooked === undefined ? q.value.raw : q.value.cooked)).join('\u0000');

/**
 * 起主服务相关的字符串（普通字面量与模板串），逐个标出：
 *   inSink：位于 sink 调用的实参子树里，或位于 require / require.resolve / import() 的实参子树里（进程内 require 主服务入口会无条件 listen，所以算 sink 内；SOURCE_READERS 不豁免）；
 *   legacy：普通字符串字面量且匹配分析器 R3 的正则（与分析器 R3 一一对应、同一遍历顺序；守卫用它把 MIGRATED 的 R3 与 SOURCE_READERS 对上号）。
 * 命中条件（任一）：路径边界上以 server.js 结尾 · 命令串（SERVER_JS_CMD_RE：sink 实参里，或文件 require 了 child_process 时文件里的任何字符串 / 模板串）· require 类实参里路径边界上以 server / server.js 结尾或整串等于 server · sink 实参里整串等于 server。
 * 文件级命令串命中（sink 外、文件 require 了 child_process）inSink = false：与「sink 外的路径字面量」同一档，SOURCE_READERS 登记的文件放过它（但登记文件本来就不许 require child_process，SPAWN 硬门照红）。
 * 返回 [{ value, start, inSink, legacy }]。
 * 残余（登记，不追求覆盖）：字面量先赋给变量再传给 sink / require（`const S = join(…, 'server.js'); spawn('node', [S])`）；拆字符串；`spawn(process.execPath, ['.'])`、`npm start`（'.' 会误伤 git add .）。
 */
function serverJsLiterals(ast) {
    const out = [];
    const fileHasCp = requiresChildProcess(ast);
    walk(ast, [], (n, parents) => {
        let text;
        if (n.type === 'Literal' && typeof n.value === 'string') text = n.value;
        else if (n.type === 'TemplateLiteral') text = tplText(n);
        else return;
        const chain = parents.concat([n]);
        let inSinkArgs = false;
        let inRequireArgs = false;
        for (let i = 0; i < chain.length - 1; i += 1) {
            const a = chain[i];
            if (isSinkCall(a, fileHasCp) && a.arguments.includes(chain[i + 1])) inSinkArgs = true;
            if (isRequireClassCall(a) && a.arguments.includes(chain[i + 1])) inRequireArgs = true;
            if (a.type === 'ImportExpression' && a.source === chain[i + 1]) inRequireArgs = true;
        }
        // 命令串（分隔符边界正则）：sink 实参里认；文件 require 了 child_process 时全文件字面量都认（别名 / 起别名的 exec 也覆盖）。既不在 sink 里、文件也没有 child_process 的说明文字（'see ./server.js for details'）不认
        const pathish = SERVER_JS_RE.test(text) || ((inSinkArgs || fileHasCp) && SERVER_JS_CMD_RE.test(text));
        const requireHit = inRequireArgs && (SERVER_REQ_RE.test(text) || text === 'server');
        const sinkWord = inSinkArgs && text === 'server';
        if (!(pathish || requireHit || sinkWord)) return;
        out.push({ value: text, start: n.start, inSink: inSinkArgs || inRequireArgs, legacy: n.type === 'Literal' && SERVER_JS_RE.test(text) });
    });
    return out;
}

/** 起进程的能力：有没有 require('child_process') / require('node:child_process') / import('child_process')，以及 sink 调用的个数。SOURCE_READERS 的硬门用 */
function spawnCapability(ast) {
    const cpRequire = requiresChildProcess(ast);
    let sinkCalls = 0;
    walk(ast, [], (n) => { if (isSinkCall(n, cpRequire)) sinkCalls += 1; });
    return { cpRequire, sinkCalls };
}

// ---------------------------------------------------------------- SELF_ISOLATED（S4b2b）：自带隔离机制的套件
/**
 * 登记在 SELF_ISOLATED 的文件，守卫对它们另做三件事（全部是确定性硬规则，不做智能放行，宁可误红）：
 *   ① T3 窄豁免：只豁免「sink 外、require 类实参外、普通字符串字面量（不是模板串）且值恰为 'server.js'」这一种（isSiExemptLiteral）；
 *      其余带命令内容的串、模板串、sink 实参与 require 实参里的 server.js 照旧判 T3 / R3。
 *   ② sink 形态（selfIsolatedSpawnForms，红码 SPAWN_FORM）：
 *      · exec / execSync / fork：一律红；
 *      · spawn / spawnSync / execFile / execFileSync：看第一个实参——
 *        process.execPath（成员表达式）或字面量 /^node(?:\.exe)?$/i → 起 node：第二个实参必须是数组字面量，且第一个元素必须是下面三种之一（展开元素、变量、`--require` / `-e` 打头、缺数组都红）：
 *          F1 标识符 __filename；
 *          F2 path.join(<X>, 'scripts', '_test-it-asset-ledger-server-wrapper.js')（被调恰为 path.join；恰 3 个实参，第 2 个是字面量 'scripts'，第 3 个是 wrapper 名字面量，第 1 个不是标识符 __dirname——
 *             __dirname 是测试脚本自己所在的检出目录，起的就是检出目录里的 wrapper；安全性来自 wrapper 自身：IA_TEST_DB_PATH 必填 + 真实库三层比对）；
 *          F3 path.join(__dirname, '<名>')，恰 2 个实参、第一个是标识符 __dirname、第二个是字面量、匹配 /^_seed-[A-Za-z0-9-]+\.js$/ 且这个文件名在扫描集合（git 可见的顶层 .js）里（L8：名字合法但文件不存在也红）；
 *        字面量属于封闭名单 taskkill / powershell / git → 非 node，放行；其余（变量、模板串、名单外字面量、调用表达式）一律红（分不清是不是起 node）。
 *   ③ child_process 绑定形态（selfIsolatedBindingForms，红码 BINDING，M2）：让 ② 的「按调用点看第一个实参」不能被绕过——
 *      · require('child_process') / require('node:child_process') 只能是 `const { a, b } = …` 的初值：外围声明是 const（let / var 红）、id 是 ObjectPattern，每个属性是语法上的简写（p.shorthand；`spawn: spawn` 红）、
 *        非计算、无默认值、非 rest，名字限 spawn / spawnSync / execFile / execFileSync；
 *        整体赋给变量、取成员（require('child_process').spawn）、改名解构、带默认值、带 rest、import('child_process')（含 node:）一律红；
 *      · （N4）值为 (node:)child_process 的字符串字面量 / 无表达式模板串，只许作为上面合格声明里 require 的实参出现；其余位置一律红（module.require('child_process')、createRequire(__filename)('child_process')、require(`child_process`)、变量中转）；
 *      · 绑定出来的每个标识符，除声明处外的所有引用必须恰是 CallExpression 的 callee（拦 util.promisify(execFile)、`const sp = spawn`、作为实参传出）。按名字判定、不做作用域分析：同名的内层变量 / 参数 / 函数名也会判红（安全方向）；
 *      · require / import() 了 worker_threads / cluster（含 node: 前缀）→ 红。
 *   ④ 过期（STALE，由调用方汇总）：没有任何被豁免的字面量，或没有 require child_process。
 * 登记的残余（不追求覆盖，守卫头注释同步写明）：wrapper 只保证库被重定向（IA_TEST_DB_PATH 必填 + 三层比对），不管 .env、uploads、外呼；F2 的第一个实参若解析到检出目录（如 ROOT），起的是检出目录的代码，守卫看不到——与非 SI 文件现状相同；
 * F3 不证明种子脚本拿到的是临时目标库（靠种子脚本自己的成对规则 + 调用助手的运行时断言）；非 node 名单内的程序（powershell / git）经命令行间接起 node 看不到；
 * 变量间接（`const e = path.join(__dirname, 'server.js'); require(e)`、经 NODE_OPTIONS 字符串拼接预加载入口、拆字符串拼出 child_process 这个模块名后 require(变量)）看不到。
 */
const SI_WRAPPER_NAME = '_test-it-asset-ledger-server-wrapper.js';
const SI_SEED_NAME_RE = /^_seed-[A-Za-z0-9-]+\.js$/;
const SI_NODE_LITERAL_RE = /^node(?:\.exe)?$/i;
const SI_NON_NODE_PROGRAMS = new Set(['taskkill', 'powershell', 'git']);
const SI_ALWAYS_RED = new Set(['exec', 'execSync', 'fork']);
/** 被豁免的 T3 字面量（serverJsLiterals 的一项）：普通字符串字面量、值恰为 'server.js'、不在 sink / require 类实参里 */
const isSiExemptLiteral = (l) => !!l && l.legacy === true && l.inSink === false && l.value === 'server.js';
const isProcessExecPath = (n) => !!n && n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'process' && n.property.type === 'Identifier' && n.property.name === 'execPath';
const isStringLiteral = (n) => !!n && n.type === 'Literal' && typeof n.value === 'string';
/** 被调恰为 path.join 的调用（path 必须是标识符 path，join 不是计算属性；`join(…)`、`p.join(…)`、可选调用都不算） */
const isPathJoinCall = (n) => !!n && n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
    && n.callee.object.type === 'Identifier' && n.callee.object.name === 'path' && n.callee.property.type === 'Identifier' && n.callee.property.name === 'join';
/** 起 node 时第二个实参数组的第一个元素：F1 / F2 / F3 之一 → null；否则返回不合格的原因。files = 扫描集合（Set 或数组；F3 要求种子脚本名在里面，缺省 / 空 = 一律不在，fail-closed） */
function siNodeScriptFormProblem(el, files) {
    if (el === undefined || el === null) return '数组里没有第一个元素';
    if (el.type === 'SpreadElement') return '第一个元素是展开元素';
    if (el.type === 'Identifier' && el.name === '__filename') return null;   // F1
    if (isPathJoinCall(el)) {
        const a = el.arguments;
        // F2：恰 3 个实参；第 2 个字面量 'scripts'、第 3 个 wrapper 名字面量；第 1 个不是标识符 __dirname（__dirname = 测试脚本自己所在的检出目录）
        if (a.length === 3 && isStringLiteral(a[1]) && a[1].value === 'scripts' && isStringLiteral(a[2]) && a[2].value === SI_WRAPPER_NAME && !(a[0].type === 'Identifier' && a[0].name === '__dirname')) return null;
        // F3：恰 2 个实参，第一个是标识符 __dirname，第二个是 _seed-*.js 字面量且在扫描集合里
        if (a.length === 2 && a[0].type === 'Identifier' && a[0].name === '__dirname' && isStringLiteral(a[1]) && SI_SEED_NAME_RE.test(a[1].value)) {
            const set = files instanceof Set ? files : new Set(files || []);
            if (set.has(a[1].value)) return null;
            return `path.join(__dirname, '${a[1].value}')：种子脚本名不在扫描集合（git 可见的顶层 .js）里`;
        }
        return 'path.join(…) 既不是 path.join(<非 __dirname>, \'scripts\', <wrapper 文件名>)（F2，恰 3 个实参），也不是 path.join(__dirname, \'_seed-*.js\')（F3，恰 2 个实参）';
    }
    return `第一个元素不是 __filename / path.join(…) 调用（${el.type}）`;
}
/** SELF_ISOLATED 文件里的 sink 形态违规：[{ detail }]，detail 里的 @偏移 由调用方换算成行号。files = 扫描集合（F3 用，见 siNodeScriptFormProblem） */
function selfIsolatedSpawnForms(ast, files) {
    const fileHasCp = requiresChildProcess(ast);
    const out = [];
    walk(ast, [], (n) => {
        if (!isSinkCall(n, fileHasCp)) return;
        const name = calleeName(n.callee);
        const at = `${name}(…)@${n.start}`;
        if (SI_ALWAYS_RED.has(name)) { out.push({ detail: `${at}：${name} 一律不许（SELF_ISOLATED 文件里只许 spawn / spawnSync / execFile / execFileSync 的三种放行形态）` }); return; }
        const a0 = n.arguments[0];
        if (a0 === undefined || a0.type === 'SpreadElement') { out.push({ detail: `${at}：第一个实参缺失或是展开元素，分不清是不是起 node` }); return; }
        if (isProcessExecPath(a0) || (isStringLiteral(a0) && SI_NODE_LITERAL_RE.test(a0.value))) {
            const a1 = n.arguments[1];
            if (!a1 || a1.type !== 'ArrayExpression') { out.push({ detail: `${at}：起 node 时第二个实参必须是数组字面量` }); return; }
            const problem = siNodeScriptFormProblem(a1.elements[0], files);
            if (problem !== null) out.push({ detail: `${at}：起 node 的脚本参数不合格——${problem}` });
            return;
        }
        if (isStringLiteral(a0) && SI_NON_NODE_PROGRAMS.has(a0.value)) return;   // 封闭名单内的非 node 程序
        out.push({ detail: `${at}：第一个实参不是 process.execPath / 'node' / 封闭名单（taskkill / powershell / git）里的字面量（${a0.type}），分不清是不是起 node` });
    });
    return out;
}
const SI_BINDABLE = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
const SI_CP_MODULE_RE = /^(?:node:)?child_process$/;
const SI_FORBIDDEN_MODULE_RE = /^(?:node:)?(?:worker_threads|cluster)$/;
/**
 * SELF_ISOLATED 文件里 child_process 的绑定形态违规（M2，红码 BINDING）：[{ detail }]，detail 里的 @偏移 由调用方换算成行号。规则见上面的块注释 ③：
 *   · child_process 的 require 只能是 `const { spawn, … } = require('child_process')`（const、语法简写、非计算、无默认值、非 rest、名字限 SI_BINDABLE）；import('child_process') 一律红；
 *   · （N4）child_process 这个字符串字面量 / 无表达式模板串只许出现在上面合格声明的 require 实参里；
 *   · 绑定出来的每个标识符，声明处之外的所有引用必须恰是 CallExpression 的 callee（按名字判定，不做作用域分析，同名内层变量也红——安全方向）；
 *   · require / import() 了 worker_threads / cluster → 红。
 * 不算「引用」的位置：非计算的 MemberExpression 属性名（x.spawn）、非计算且非简写的 Property 键、类成员键、标签。
 */
function selfIsolatedBindingForms(ast) {
    const out = [];
    const seen = new Set();
    const bad = (start, text) => { if (seen.has(`${start}:${text}`)) return; seen.add(`${start}:${text}`); out.push({ detail: `${text}@${start}` }); };
    const bound = new Set();
    const patterns = [];
    const okLits = new Set();        // 合格声明里 require 的实参节点（N4：child_process 字面量只许出现在这里）
    const flaggedLits = new Set();   // 已经因别的原因判红的 child_process 字面量节点（N4 不再重复报）
    walk(ast, [], (n, parents) => {
        if (n.type === 'ImportExpression') {
            const v = n.source.type === 'Literal' ? String(n.source.value) : null;
            if (v !== null && SI_CP_MODULE_RE.test(v)) { flaggedLits.add(n.source); bad(n.start, `import('${v}')：child_process 只许 const { spawn, … } = require('child_process') 一种绑定`); }
            else if (v !== null && SI_FORBIDDEN_MODULE_RE.test(v)) bad(n.start, `import('${v}')：SELF_ISOLATED 文件不许用 worker_threads / cluster 起别的执行体`);
            return;
        }
        if (!isRequireLiteralCall(n)) return;
        const mod = n.arguments[0].value;
        if (SI_FORBIDDEN_MODULE_RE.test(mod)) { bad(n.start, `require('${mod}')：SELF_ISOLATED 文件不许用 worker_threads / cluster 起别的执行体`); return; }
        if (!SI_CP_MODULE_RE.test(mod)) return;
        const parent = parents[parents.length - 1];
        const decl = parents[parents.length - 2];
        if (!parent || parent.type !== 'VariableDeclarator' || parent.id.type !== 'ObjectPattern' || !decl || decl.type !== 'VariableDeclaration' || decl.kind !== 'const') {
            flaggedLits.add(n.arguments[0]);
            bad(n.start, `require('${mod}') 不是 const { spawn, … } = require(…) 的初值（整体赋值 / 取成员 / 直接使用 / let·var 声明都不许）`);
            return;
        }
        const names = [];
        let ok = true;
        for (const p of parent.id.properties) {
            if (p.type !== 'Property') { bad(p.start, `child_process 解构里有 ${p.type}（rest 不许）`); ok = false; continue; }
            // 简写 = 语法上的简写（p.shorthand === true 蕴含非计算、键是标识符、键值同名；带默认值的 `{ spawn = x }` 也是 shorthand，由 value 必须是 Identifier 拦住）；改名、`spawn: spawn`、计算键、字面量键、带默认值（值是 AssignmentPattern）、嵌套模式都落在这一条
            if (p.shorthand !== true || p.value.type !== 'Identifier') { bad(p.start, 'child_process 解构的属性不是语法简写（改名 / spawn: spawn / 计算键 / 字面量键 / 带默认值 / 嵌套模式都不许）'); ok = false; continue; }
            if (!SI_BINDABLE.has(p.key.name)) { bad(p.start, `child_process 解构出 ${p.key.name}：只许 spawn / spawnSync / execFile / execFileSync`); ok = false; continue; }
            names.push(p.key.name);
        }
        if (ok) { okLits.add(n.arguments[0]); for (const nm of names) bound.add(nm); patterns.push(parent.id); } else flaggedLits.add(n.arguments[0]);
    });
    // N4：值为 (node:)child_process 的字符串字面量 / 无表达式模板串，只许出现在上面「合格声明」的 require 实参里；其余位置（module.require(…)、createRequire(…)(…)、require(`child_process`)、变量赋值……）一律红
    walk(ast, [], (n) => {
        let v = null;
        if (n.type === 'Literal' && typeof n.value === 'string') v = n.value;
        else if (n.type === 'TemplateLiteral' && n.expressions.length === 0) v = n.quasis.map((q) => (q.value.cooked === null || q.value.cooked === undefined ? q.value.raw : q.value.cooked)).join('');
        if (v === null || !SI_CP_MODULE_RE.test(v)) return;
        if (okLits.has(n) || flaggedLits.has(n)) return;
        bad(n.start, `字符串 '${v}' 出现在合格的 const { spawn, … } = require('${v}') 声明之外（module.require / createRequire / 模板串 / 变量中转都不许）`);
    });
    if (bound.size === 0) return out;
    walk(ast, [], (n, parents) => {
        if (n.type !== 'Identifier' || !bound.has(n.name)) return;
        if (patterns.some((p) => parents.includes(p))) return;   // 声明处
        const p = parents[parents.length - 1];
        if (p) {
            if (p.type === 'MemberExpression' && p.property === n && !p.computed) return;
            if (p.type === 'Property' && p.key === n && p.value !== n && !p.computed) return;   // 简写属性 { spawn }：value 与 key 是两个节点（acorn 8 复制）时 value 在自己的访问里判红；若是同一节点，p.value === n 不放过
            if ((p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && p.key === n && !p.computed) return;
            if ((p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') && p.label === n) return;
            if (p.type === 'CallExpression' && p.callee === n) return;
        }
        bad(n.start, `${n.name} 作为被调用以外的引用出现（赋值 / 传参 / promisify / 取成员都不许；按名字判定，同名内层变量也红）`);
    });
    return out;
}
/** SELF_ISOLATED 的汇总事实：被豁免的 T3 字面量个数、是否 require child_process、sink 形态违规、child_process 绑定形态违规。files = 扫描集合（F3 用） */
function selfIsolatedFacts(ast, files) {
    return {
        cpRequire: requiresChildProcess(ast),
        exemptLiterals: serverJsLiterals(ast).filter(isSiExemptLiteral).length,
        spawnForms: selfIsolatedSpawnForms(ast, files),
        bindingForms: selfIsolatedBindingForms(ast),
    };
}

// ---------------------------------------------------------------- Tier-1 扫描
/**
 * 「左边 ObjectPattern、右边 process.env」的解构读取：返回那个 ObjectPattern，不是则 null。三种语法：
 *   · VariableDeclarator：`const { JWT_SECRET } = process.env`（id / init）；
 *   · AssignmentExpression（operator 为 =）：`let s; ({ JWT_SECRET: s } = process.env)`（left / right）；
 *   · AssignmentPattern（参数默认值 / 解构默认值）：`function f({ JWT_SECRET } = process.env) {}`（left / right，收口预筛 MED-1）。
 * isProcessEnv 由调用方传入（识别 process.env / process?.env，含 ChainExpression 展开）。T2 与 T5 共用这一个函数。
 */
function envDestructurePattern(n, isProcessEnv) {
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && isProcessEnv(n.init)) return n.id;
    if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'ObjectPattern' && isProcessEnv(n.right)) return n.left;
    if (n.type === 'AssignmentPattern' && n.left.type === 'ObjectPattern' && isProcessEnv(n.right)) return n.left;
    return null;
}
/**
 * Tier-1 扫描：只做静态判定，不执行被扫脚本。返回命中列表 [{ code, line, evidence, analyzer }]，按行号排序（同一规则可有多条命中；codes 集合由调用方取）。
 * analyzer = true：同一处违规分析器 R1–R3 本来就会报（MIGRATED 文件不用再报一遍）；false：分析器看不到的补充写法（守卫给 MIGRATED 叠加报告）。
 *   T1 = 分析器 R1（findHardcoded3000，AST 判定）+ 补：`.listen(3000)`（第一个实参是 3000，或值为 3000 的同文件标识符）；
 *   T2 = 分析器 R2 的三条（剥离注释后的文本匹配：task_pool.db / dotenv / process.env.JWT_SECRET|DB_ENCRYPTION_KEY）+ 补：process.env 下解析出的属性名是两个真实密钥之一（点号 / 方括号 / 可选链 process.env?.JWT_SECRET / 换行或注释分隔，AST 判定）、
 *        const { JWT_SECRET } = process.env 声明解构与 ({ JWT_SECRET: s } = process.env) 赋值解构（含 process?.env、computed 字面量键）、process.loadEnvFile(…)、路径边界上以 .env 结尾的字符串字面量；
 *   T3 = 起主服务的字符串（serverJsLiterals：sink 内一律报；sink 外在 opts.sourceReader（登记在 SOURCE_READERS）时放过）；
 *   T4 = require('<…/_test-fixture | …/test-env>') 或字面量 import('<同上>')（READY_MODULE_RE，与分析器认 ready 来源的是同一个正则）；
 *   T5 = process.env.<测试变量>（点号或方括号字面量，任意大小写；另含 const { TEST_X } = process.env 的声明解构与 ({ TEST_X: v } = process.env) 的赋值解构，含 computed 字面量键）。
 * 解析失败 → 单条 code 'PARSE'（fail-closed：无法判定的文件不会被当成干净）。
 * 行号：T2–T5 取节点 / 匹配位置（精确）；T1 的分析器只返回描述串、不带位置，行号取剥离注释后第一处「3000 与主机 / 端口名同行」的行（尽力而为，判定本身不依赖它）。
 */
function scanTier1(name, src, opts) {
    const reader = !!(opts && opts.sourceReader);
    const selfIsolated = !!(opts && opts.selfIsolated);
    const hits = [];
    let parsed;
    try { parsed = parseSource(src); } catch (e) { return [{ code: 'PARSE', line: 0, evidence: `解析失败：${String(e && e.message).slice(0, 100)}`, analyzer: false }]; }
    const text = stripComments(src, parsed.comments);
    const rawLines = src.split('\n');
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    const lineAt = (idx) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; } return lo + 1; };
    const ev = (line) => (line >= 1 && line <= rawLines.length ? rawLines[line - 1].replace(/\r$/, '').trim().slice(0, 120) : '');
    const add = (code, line, evidence, analyzer) => hits.push({ code, line, evidence: evidence === undefined ? ev(line) : evidence, analyzer: !!analyzer });

    // T1：分析器 R1
    const r1 = findHardcoded3000(parsed.ast);
    if (r1.length > 0) {
        const textLines = text.split('\n');
        let ln = textLines.findIndex((l) => /3000/.test(l) && /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|https?:\/\/|port/i.test(l));
        if (ln < 0) ln = textLines.findIndex((l) => /3000/.test(l));
        const line = ln < 0 ? 0 : ln + 1;
        for (const h of r1) add('T1', line, `${h}${line ? ` | ${ev(line)}` : ''}`.slice(0, 120), true);
    }
    // T2：分析器 R2 的三条（文本匹配）
    for (const re of [/task_pool\.db/, /require\(\s*['"]dotenv['"]\s*\)|\bdotenv\b/, /process\.env\.(?:JWT_SECRET|DB_ENCRYPTION_KEY)\b/]) {
        const m = re.exec(text);
        if (m) add('T2', lineAt(m.index), undefined, true);
    }
    // 其余：AST
    // process.env（含可选链 process?.env；解构的初始值可能被 ChainExpression 包一层）
    const isProcessEnv = (n0) => {
        const n = n0 && n0.type === 'ChainExpression' ? n0.expression : n0;
        return !!n && n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'process' && n.property.type === 'Identifier' && n.property.name === 'env';
    };
    const bound3000 = new Set();
    walk(parsed.ast, [], (n) => { if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isPort3000(n.init)) bound3000.add(n.id.name); });
    walk(parsed.ast, [], (n) => {
        if (isRequireLiteralCall(n) && READY_MODULE_RE.test(n.arguments[0].value)) add('T4', lineAt(n.start), undefined, false);
        // 字面量动态导入夹具 / test-env：import('./_test-fixture.js')、import('./lib/test-env')（沿用 READY_MODULE_RE；import(变量) 是登记残余）
        if (n.type === 'ImportExpression' && n.source.type === 'Literal' && typeof n.source.value === 'string' && READY_MODULE_RE.test(n.source.value)) add('T4', lineAt(n.start), undefined, false);
        if (n.type === 'MemberExpression' && isProcessEnv(n.object)) {
            const key = n.computed ? (n.property.type === 'Literal' ? String(n.property.value) : null) : n.property.name;
            if (key !== null && TEST_VAR_NAME_RE.test(key)) add('T5', lineAt(n.start), undefined, false);
            // 真实密钥：process.env 下解析出的属性名统一查（点号 / 方括号 / 可选链 / 换行 / 注释分隔都是同一个 AST 形态）。节点文本恰为 process.env.<名字> 的，分析器 R2 的文本正则本来就会报（analyzer = true，MIGRATED 不重复报）；其余形态是补充命中
            if (key !== null && SECRET_ENV_NAMES.includes(key)) add('T2', lineAt(n.start), undefined, /^process\.env\.(?:JWT_SECRET|DB_ENCRYPTION_KEY)$/.test(text.slice(n.start, n.end)));
        }
        // 解构读取 process.env：声明形态（const { X } = process.env）与赋值形态（({ X: v } = process.env)）走同一个识别函数，T2 / T5 共用
        const envPat = envDestructurePattern(n, isProcessEnv);
        if (envPat) {
            for (const p of envPat.properties) {
                if (p.type !== 'Property') continue;
                const k = p.computed ? (p.key.type === 'Literal' ? String(p.key.value) : null) : propKeyName(p);
                if (k !== null && TEST_VAR_NAME_RE.test(k)) add('T5', lineAt(p.start), undefined, false);
                if (k !== null && SECRET_ENV_NAMES.includes(k)) add('T2', lineAt(p.start), undefined, false);
            }
        }
        if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.object.type === 'Identifier' && n.callee.object.name === 'process' && n.callee.property.name === 'loadEnvFile') add('T2', lineAt(n.start), undefined, false);
        if (n.type === 'Literal' && typeof n.value === 'string' && /(?:^|[\\/])\.env$/.test(n.value)) add('T2', lineAt(n.start), undefined, false);
        if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && calleeName(n.callee) === 'listen' && n.arguments[0]
            && (isPort3000(n.arguments[0]) || (n.arguments[0].type === 'Identifier' && bound3000.has(n.arguments[0].name)))) add('T1', lineAt(n.start), undefined, false);
    });
    // T3：sink 内的起主服务字符串一律报；sink 外的在 SOURCE_READERS 文件里放过；SELF_ISOLATED 文件另放过「sink 外、require 类实参外、普通字符串字面量且值恰为 'server.js'」这一种（isSiExemptLiteral）
    for (const l of serverJsLiterals(parsed.ast)) {
        if (selfIsolated && isSiExemptLiteral(l)) continue;
        if (l.inSink || !reader) add('T3', lineAt(l.start), `${l.inSink ? '[sink 内] ' : ''}${ev(lineAt(l.start))}`.slice(0, 120), l.legacy);
    }
    hits.sort((a, b) => a.line - b.line || (a.code < b.code ? -1 : 1));
    return hits;
}
/** 命中列表 → 规则代号集合（排序去重数组） */
const tier1Codes = (hits) => Array.from(new Set(hits.map((h) => h.code))).sort();

// ---------------------------------------------------------------- finish(…) 必须在尾部（L 组）
const isFnNode = (n) => n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
/**
 * test-env / 夹具的 finish(code)：teardown 之后调用，只设 process.exitCode 并装兜底计时器，**不会终止执行**。迁移脚本成功路径从 process.exit(code) 改成它；
 * 风险是有人把函数中间提前退出的 process.exit(code) 机械替换成 finish，代码会继续往下跑。规则（修复批 3 起分两步，顺序固定）：
 *   ① 先查祖先：调用点到最近函数边界之间有循环（for / for-in / for-of / while / do-while）、或有带 finalizer 的 try（finish 之后 finally 还会执行）→ 一律违规，
 *      先于下面所有放行判定（「紧跟 return」「return finish(…)」「箭头表达式体」也不例外）；带 finalizer 的判定只在这一处，下面的尾部判定不再重复看 finally；
 *   ② 再看位置，必须是「尾部位置」——
 *      · 所在语句块的最后一条语句，且该块（逐层往上，每一层都要是外层块的最后一条）也处在尾部位置：函数体 / 程序末尾，或 if 的 consequent·alternate / 独立嵌套块 / try 块 / catch 块的末尾且所属语句本身处在尾部位置；或
 *      · 紧跟一条 return 语句；或 return finish(…)；或箭头函数的表达式体。
 *      逐层规则：块的所有者是 IfStatement / TryStatement / CatchClause 时，被检查对象换成那条 if / try 语句本身；所有者是 BlockStatement（独立嵌套块）时，被检查对象换成这个嵌套块（它是外层块里的一条语句）。
 * 其余（后面还有语句、switch case 里、嵌在更大的表达式里、if 后面没有 return 又继续执行）→ 违规。
 * 登记残余（不判定）：finish 被包进本地包装函数再调用（`function done(c) { fx.finish(c); }`，调用点看不到 finish）；回调函数（forEach 等）里的 finish 后面的代码属于别的函数。
 * 来源绑定与分析器认 ready / teardown 的是同一套（collectModuleBindings：只认 test-env / _test-fixture 的导入绑定），另认从这两个模块（或其绑定）解构出的 finish。
 * 返回 [{ line, evidence }]（行号 + 原文前 120 字）；解析失败 → []（PARSE 由分析器报）。
 */
function finishViolations(src) {
    let parsed;
    try { parsed = parseSource(src); } catch (e) { return []; }
    const ast = parsed.ast;
    const b = collectModuleBindings(ast);
    const finFns = new Set();
    walk(ast, [], (n) => {
        if (n.type !== 'VariableDeclarator' || n.id.type !== 'ObjectPattern' || !n.init) return;
        const fromModule = readyModuleOf(n.init) !== null || (n.init.type === 'Identifier' && b.objs.has(n.init.name));
        if (!fromModule) return;
        for (const p of n.id.properties) if (p.type === 'Property' && propKeyName(p) === 'finish' && p.value.type === 'Identifier') finFns.add(p.value.name);
    });
    for (const nm of Array.from(finFns)) if (countBindings(ast, nm) !== 1) finFns.delete(nm);
    const isFinishCall = (n) => {
        if (n.type !== 'CallExpression') return false;
        const c = n.callee;
        if (c.type === 'Identifier') return finFns.has(c.name);
        if (c.type !== 'MemberExpression' || memberName(c) !== 'finish') return false;
        return c.object.type === 'Identifier' ? b.objs.has(c.object.name) : readyModuleOf(c.object) !== null;
    };
    // ① 调用点（chain 最后一个元素）到最近函数边界之间的祖先：有循环、或有带 finalizer 的 try → true（一律违规）
    const unsafeAncestor = (chain) => {
        let start = 0;
        for (let k = chain.length - 2; k >= 0; k -= 1) if (isFnNode(chain[k])) { start = k + 1; break; }
        for (let k = start; k < chain.length - 1; k += 1) {
            if (LOOP_TYPES.has(chain[k].type)) return true;
            if (chain[k].type === 'TryStatement' && chain[k].finalizer) return true;
        }
        return false;
    };
    // ② chain[i] 是语句（或 if 的直接子语句）时，它是否处在尾部位置（逐层往上）
    const isTail = (chain, i) => {
        let cur = i;
        for (let guard = 0; guard < 200; guard += 1) {
            const stmt = chain[cur];
            const container = chain[cur - 1];
            if (!container) return false;
            let list = null;
            if (container.type === 'BlockStatement' || container.type === 'Program') list = container.body;
            else if (container.type === 'SwitchCase') list = container.consequent;
            if (list) {
                const pos = list.indexOf(stmt);
                if (pos < 0) return false;
                // 紧跟的 return 只在不求值任何调用时放行：无返回值、字面量或标识符；`return next()` / `return await x()` 仍会继续执行（47R4b M1）
                if (pos < list.length - 1) { const nx = list[pos + 1]; return nx.type === 'ReturnStatement' && (nx.argument === null || nx.argument.type === 'Literal' || nx.argument.type === 'Identifier'); }
                if (container.type === 'Program') return true;
                if (container.type === 'SwitchCase') return false;
                // 块的最后一条：看块的所有者
                const owner = chain[cur - 2];
                if (!owner) return false;
                if (isFnNode(owner)) return true;
                if (owner.type === 'BlockStatement') { cur -= 1; continue; }   // 独立嵌套块：这个块本身是外层块里的一条语句，往上一层看它是不是外层块的最后一条
                if (owner.type === 'IfStatement' || owner.type === 'TryStatement') { cur -= 2; continue; }   // if 的 consequent·alternate / try 块：被检查对象换成那条 if / try 语句
                if (owner.type === 'CatchClause') { const t = chain[cur - 3]; if (t && t.type === 'TryStatement') { cur -= 3; continue; } return false; }
                return false;
            }
            // if 的直接子语句（没有花括号）：看这条 if 本身是否处在尾部位置
            if (container.type === 'IfStatement') { cur -= 1; continue; }
            return false;
        }
        return false;
    };
    const text = stripComments(src, parsed.comments);
    const rawLines = src.split('\n');
    const lineOf = (off) => text.slice(0, off).split('\n').length;
    const out = [];
    walk(ast, [], (n, parents) => {
        if (!isFinishCall(n)) return;
        const chain = parents.concat([n]);
        let pi = chain.length - 2;
        if (chain[pi] && chain[pi].type === 'AwaitExpression') pi -= 1;   // await finish(…) 与 finish(…) 同样处理
        const parent = chain[pi];
        let ok = false;
        if (unsafeAncestor(chain)) ok = false;   // 先查祖先，再接受下面三种放行形态
        else if (parent && parent.type === 'ReturnStatement') ok = true;
        else if (parent && parent.type === 'ArrowFunctionExpression' && parent.body === chain[pi + 1]) ok = true;
        else if (parent && parent.type === 'ExpressionStatement') ok = isTail(chain, pi);
        if (!ok) { const line = lineOf(n.start); out.push({ line, evidence: (rawLines[line - 1] || '').replace(/\r$/, '').trim().slice(0, 120) }); }
    });
    return out;
}

module.exports = { analyzeScript, analyzeClosers, parseSource, stripComments, walk, scanTier1, tier1Codes, TIER1_CODES, serverJsLiterals, spawnCapability, isSinkCall, SINK_NAMES, SERVER_JS_RE, finishViolations, isSiExemptLiteral, selfIsolatedSpawnForms, selfIsolatedBindingForms, selfIsolatedFacts };
