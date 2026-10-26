/**
 * #106 S2-0 守卫：代码读取的 system_configs 键集合 = 「非钉钉配置白名单 ∪ 钉钉四键」（acorn 语法树扫描，不扫源码文字）。
 *
 * 为什么：createIsolatedDb 建隔离库时只保留白名单 7 键（用来源键解密、隔离键重新加密）+ 钉钉四键（虚拟值），其余配置行一律删除。
 *   如果有人新增了一个 readSystemConfig('new_key') 读取点而没登记到白名单，线服务读到的是被删掉的空值、行为悄悄与主工作区不同——
 *   本守卫把「读取点」与「白名单」绑成全等关系：多一个、少一个都判红，并打印差集。
 *
 * 威胁模型（修复批 2 起写明）：本守卫防的是**诚实维护时漏改白名单或新增读取口**——有人新增 readSystemConfig('x') 却忘了登记白名单、新增一处读 system_configs 的 SQL
 *   却没经审查、重构时把 readSystemConfig 改名传递。它**不防刻意构造**：一个有意绕过的作者总能写出静态分析看不穿的东西。已知残余（不修，登记在此）：
 *     1. DEPS 数组下标当方法名：`const X_DEPS = ['readSystemConfig', …]; deps[X_DEPS[0]]('k')`——数组元素这一处按“const …DEPS 数组的字符串元素”放行，之后拿它当成员名不再追踪；
 *     2. `.join('')` 之类运行时拼接出方法名或表名（`['read', 'SystemConfig'].join('')`、`['system', 'configs'].join('_')`）——记号被切成两半，文本里根本不出现完整记号；
 *     3. `eval` / `new Function` / `vm` 构造代码；
 *     4. 运行时动态键名或表名（`readSystemConfig(await somethingAsync())` 会判红，但 `deps[name]()` 里 name 来自配置 / 参数这类完全动态的取法没有记号可抓）；
 *     5. 在 readSystemConfig 函数体内**复用已有 SQL 常量**再多调一次 db（`db.get(SQL, [otherKey], …)`）：不新增含记号的字符串，也就不新增站点指纹。
 *   修复批 2 的“按位置闭集 + 站点指纹多重集”只是把“诚实的疏忽”挡得更严，不改变上面的边界。
 *
 * 结构（修复批 1 起改为「记号闭集」，修复批 2 起改为「按位置」核算，不再逐个补绕过写法）：
 *   两个记号 T1 = readSystemConfig、T2 = system_configs（文本比对不分大小写）。
 *   ① 对每个被扫文件，用 acorn 的 onComment 去掉注释后，在剩余源码文本里找出两个记号的**每一个文本匹配位置**；
 *   ② AST 遍历里，标识符、字符串字面量、模板片段、正则字面量里含记号的节点，登记它的源码区间（“已归类节点”）；
 *   ③ 每个文本匹配位置都必须落在某个已归类节点的区间内，否则判红（F-unaccounted，报 file:line）；每个已归类节点，源码原文里的记号个数都必须等于解码值里的个数——
 *      不等（Unicode 转义、`String.raw` 里的转义等：原文看不到、解码后才含记号，或者反过来）一律判红（F-escaped）；正则字面量里出现记号显式判红（F-regex）。
 *      不再按文件汇总比较总数（总数相等也可能是一正一负抵消）；
 *   ④ 每次出现必须落进允许上下文，否则判红并报 file:line。字符串由「最大的 + 拼接 / 模板插值」根表达式整体常量折叠后判断（T2：未登记站点一律判红；已登记站点上折叠不了的根表达式以原文作指纹），
 *      所以 'SELECT … FROM sys' + 'tem_configs'、${'system_configs'}、表名常量拼接都落在判红里。
 *
 * 判红规则（rule id）：
 *   F-parse        文件无法解析
 *   F-unaccounted  去注释后的某个记号文本匹配位置不在任何已归类节点的区间内（报 file:line）
 *   F-escaped      已归类节点的源码原文与解码值里的记号个数不同（转义拼写 / String.raw 转义等）
 *   F-regex        正则字面量里出现记号
 *   F-def          readSystemConfig 的定义不是「server.js 里恰好 1 处顶层 function 声明」
 *   F-form         T1 出现在允许形态之外（改名传递、赋值、数组元素、.call/.apply、computed 成员、字符串 / 模板里的 readSystemConfig、含记号的其他标识符……）
 *   F-call-arg     调用的实参不是「唯一一个字符串字面量」或「同文件里恰好一处 const X = '字面量' 的标识符」
 *   F-const-array  形态 d' 的常量数组 X 除声明外的引用不是「恰好 1 处且就是 X.map(readSystemConfig)」（push、成员赋值、传出、赋给别的变量、展开、第二次引用……）
 *   F-keys-extra   代码读取了白名单 ∪ 钉钉四键之外的键
 *   F-keys-missing 白名单 ∪ 钉钉四键里有键，代码里没有对应的读取点
 *   F-sql          T2 出现点不在手写站点清单内 / 站点内容指纹多重集与清单不符 / 清单项已不存在 / 表名常量 / 标识符名含记号 / readSystemConfig 函数体内 SELECT 数 ≠ 1
 *   F-wl           白名单自检不过（与钉钉四键相交 / 键名像凭证）
 *
 * T1 允许上下文（对每一处标识符 readSystemConfig）：
 *   a 定义：server.js 顶层 function readSystemConfig(…)，全仓恰好 1 处
 *   b 调用，唯一实参是字符串字面量（含 deps.readSystemConfig('x') 这类成员调用）
 *   c 调用，唯一实参是标识符，且该标识符在同文件里只有一个绑定、并且是 const X = '字面量'
 *   d [<全部为字符串字面量>].map(readSystemConfig)
 *   d' <标识符>.map(readSystemConfig)，标识符在同文件里只有一个绑定、并且是 const X = ['字面量', …]，且 X 除声明外**只被引用 1 次**，就是这个 X.map(readSystemConfig) 的对象
 *      （非 computed 成员属性名、对象键不算引用；push / 下标赋值 / 传出 / 赋给别的变量 / 展开 / 第二次 map 都会让引用数 ≠ 1 而判红）；
 *      派单 F3-2d 未列 d'，是 server.js DINGTALK_CONFIG_KEYS.map(readSystemConfig) 的现状形态（主会话已认可）；开关 ALLOW_CONST_ARRAY_MAP 置 false 即严格口径
 *   e 依赖传递：对象简写 { readSystemConfig } / readSystemConfig: readSystemConfig（对象字面量与解构模式都认）；字符串 'readSystemConfig' 只允许作为
 *      `const <名字以 DEPS 结尾> = [ … ]` 的数组元素
 * T2 允许上下文 = 手写「站点清单」T2_SITES（修复批 1 起，取代“按 SQL 形态分类”的软判断；修复批 2 起带内容指纹）：
 *   所有含 system_configs 的字符串字面量、模板片段、可折叠的 + 拼接 / 插值模板（折叠后含记号的也算），**不管是否含 SELECT**，都要归到「文件 + 所在顶层声明」站点上；
 *   每个这样的根表达式记一个**内容指纹**（可折叠的用折叠后的文本、压缩连续空白并去首尾空白、保留大小写；折叠不了的用根表达式的源码原文，同样压缩空白），
 *   站点清单登记「文件 + 顶层声明 + 指纹多重集」，与代码逐项比对：站点内删一处、加一处（数量不变）、把登记的写入语句改成 INSERT … SELECT / 加 RETURNING，指纹都对不上而判红。
 *   清单外的任何站点判红，提示“新增 system_configs 出现点须经审查后加入站点清单”；清单里有而代码里已没有的也判红。
 *   值恰好等于 'system_configs' 的字面量（表名常量）不得进清单；标识符名里含 system_configs 一律判红；utils/instance-db.js 按相对路径整文件豁免分类（记号仍参与闭集核算）。
 *   另保留：server.js 顶层 readSystemConfig 函数体内「以 SELECT 开头的 system_configs 表达式」全仓恰好 1 条——按含记号的字符串**出现位置**计（常量 SQL 的定义算 1 条，
 *   引用该常量的模板其片段里没有记号，不重复计）。
 *
 * 运行：node scripts/verify-instance-config-keys.js        （先扫真实源码并打印两个记号的普查表，再跑内置自测；FAMILY 的那次调用就是这条）
 * 变异自证用：设置 INSTANCE_VERIFY_SOURCE_ROOT=<被测 wbs-server 副本的绝对路径>，脚本改为扫描该副本（白名单也从该副本的 utils/instance-db.js 读）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const SELF_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.INSTANCE_VERIFY_SOURCE_ROOT ? path.resolve(process.env.INSTANCE_VERIFY_SOURCE_ROOT) : SELF_ROOT;

const T1 = 'readSystemConfig';
const T2 = 'system_configs';
const RE_T1 = /readsystemconfig/gi;
const RE_T2 = /system_configs/gi;
const countOf = (re, s) => (s.match(re) || []).length;
const has1 = (s) => s.toLowerCase().includes(T1.toLowerCase());
const has2 = (s) => s.toLowerCase().includes(T2);

const ALLOW_CONST_ARRAY_MAP = true;                 // 形态 d'，见文件头
const SQL_REWRITER_FILE = 'utils/instance-db.js';   // T2 分类豁免（重写方），按相对路径精确匹配
const SECRET_NAME_RE = /secret|password|passwd|pwd|pass|token|app_?key|robot_?code|credential|api_?key|access_?key|private|webhook|cookie|cert/i;

/**
 * T2（system_configs）站点清单（手写、逐处审查过）：文件 + 所在顶层声明名 + 该站点内每个含 T2 的根表达式的**内容指纹**多重集（fps；
 * 字符串字面量 / 模板 / 可折叠拼接，不论是否含 SELECT；注释不计；指纹的算法见文件头）。
 * 清单外的任何站点、指纹多重集不符（删一处加一处、语句被改写）、清单里有而代码里已没有的站点，一律判红——**新增或改动 system_configs 出现点须经审查后更新本清单**。
 * 值恰好等于 'system_configs' 的字面量（表名常量）不得进清单；utils/instance-db.js 整文件豁免。readSystemConfig 函数体内恰好 1 条 SELECT 另有单独检查。
 * 各站点 what 字段里的行号只供阅读，不参与校验，会随代码漂移。
 */
const T2_SITES = Object.freeze([
    { file: 'server.js', decl: 'function initTable', what: 'CREATE TABLE IF NOT EXISTS system_configs（建表，server.js:2359）',
      fps: ["CREATE TABLE IF NOT EXISTS system_configs ( config_key TEXT PRIMARY KEY, config_value_encrypted TEXT, updated_by INTEGER, updated_by_name TEXT, updated_at DATETIME DEFAULT (datetime('now','localtime')) )"] },
    { file: 'server.js', decl: 'function verifyV2CollabSchema', what: 'sqlite_master 存在性检查（:2937）+ 缺表时的文案（:2941，同一个字面量既写 logger.error、又作 core「结构不完整」错误的消息——#106 S3a 收口预筛 LOW-6 复核：只进日志与就绪状态，对外只出 code）',
      fps: ["SELECT name FROM sqlite_master WHERE type='table' AND name='system_configs'", 'v2.0 schema 迁移不完整，system_configs 表未创建'] },
    { file: 'server.js', decl: 'function readSystemConfig', what: 'readSystemConfig 的唯一一条 SELECT（:11385）',
      fps: ['SELECT config_value_encrypted FROM system_configs WHERE config_key = ?'] },
    { file: 'server.js', decl: 'function writeSystemConfig', what: 'writeSystemConfig 的 INSERT … ON CONFLICT（:11415）',
      fps: ["INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name, updated_at) VALUES (?, ?, ?, ?, datetime('now','localtime')) ON CONFLICT(config_key) DO UPDATE SET config_value_encrypted = excluded.config_value_encrypted, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at"] },
    { file: 'routes/sys-iteration/index.js', decl: 'module.exports =', what: '执行人候选清单的 skipped_defaults.reason 提示文字（:17452，非 SQL）',
      fps: ['未配置固定默认执行人（system_configs.sys_release_default_executor_ids 缺失或为空）'] },
]);

// ---------------------------------------------------------------- AST 工具

const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range']);
/** 先序遍历；visit(node, parent, ancestors)；ancestors 是从根到 parent 的节点数组（含 parent，最后一个元素就是 parent；根节点的 ancestors 为空）。 */
function walk(node, visit, parent, ancestors) {
    visit(node, parent, ancestors);
    const childAnc = ancestors.concat([node]);
    for (const key of Object.keys(node)) {
        if (SKIP_KEYS.has(key)) continue;
        const v = node[key];
        if (Array.isArray(v)) {
            for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, node, childAnc);
        } else if (v && typeof v.type === 'string') {
            walk(v, visit, node, childAnc);
        }
    }
}

const isStringLiteral = (n) => !!n && n.type === 'Literal' && typeof n.value === 'string';
/** 没有插值的模板字面量也算字符串字面量。 */
const isPlainTemplate = (n) => !!n && n.type === 'TemplateLiteral' && n.expressions.length === 0 && n.quasis.length === 1 && typeof n.quasis[0].value.cooked === 'string';
const literalValue = (n) => (isStringLiteral(n) ? n.value : (isPlainTemplate(n) ? n.quasis[0].value.cooked : null));
const isLit = (n) => literalValue(n) !== null;

/** 绑定名收集：把声明 / 参数里的模式展开成标识符名。 */
function patternNames(p, out) {
    if (!p) return;
    switch (p.type) {
        case 'Identifier': out.push(p.name); break;
        case 'ObjectPattern': for (const pr of p.properties) patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out); break;
        case 'ArrayPattern': for (const el of p.elements) patternNames(el, out); break;
        case 'AssignmentPattern': patternNames(p.left, out); break;
        case 'RestElement': patternNames(p.argument, out); break;
        default: break;
    }
}

/** 同文件绑定表：name → [{ kind: 'const' (带 init) | 'other' }]；作用域不敏感——同名被多处绑定即视为歧义。 */
function collectBindings(ast) {
    const table = new Map();
    const add = (name, rec) => { if (!table.has(name)) table.set(name, []); table.get(name).push(rec); };
    walk(ast, (node, parent) => {
        if (node.type === 'VariableDeclarator') {
            const declKind = parent && parent.type === 'VariableDeclaration' ? parent.kind : 'var';
            if (node.id.type === 'Identifier') {
                if (declKind === 'const' && node.init) add(node.id.name, { kind: 'const', init: node.init, declarator: node });
                else add(node.id.name, { kind: 'other' });
            } else {
                const names = [];
                patternNames(node.id, names);
                for (const n of names) add(n, { kind: 'other' });
            }
        } else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
            if (node.id && node.id.name) add(node.id.name, { kind: 'other' });
            const names = [];
            for (const p of node.params) patternNames(p, names);
            for (const n of names) add(n, { kind: 'other' });
        } else if (node.type === 'CatchClause' && node.param) {
            const names = [];
            patternNames(node.param, names);
            for (const n of names) add(n, { kind: 'other' });
        } else if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id) {
            add(node.id.name, { kind: 'other' });
        }
    }, null, []);
    return table;
}
const singleConst = (table, name) => { const r = table.get(name); return r && r.length === 1 && r[0].kind === 'const' ? r[0] : null; };
function resolveConstLiteral(table, name) { const r = singleConst(table, name); return r ? literalValue(r.init) : null; }
function resolveConstArray(table, name) {
    const r = singleConst(table, name);
    if (!r || r.init.type !== 'ArrayExpression' || r.init.elements.length === 0 || !r.init.elements.every(isLit)) return null;
    return { values: r.init.elements.map(literalValue), declarator: r.declarator };
}

/** 完全常量折叠：字面量 / 无插值模板 / + 拼接 / 插值为同文件唯一 const 字符串的模板；折叠不了返回 null。 */
function makeFolder(table) {
    const fold = (n, depth, seen) => {
        if (!n || depth > 8) return null;
        const lv = literalValue(n);
        if (lv !== null) return lv;
        if (n.type === 'TemplateLiteral') {
            let s = '';
            for (let i = 0; i < n.quasis.length; i++) {
                const c = n.quasis[i].value.cooked;
                if (typeof c !== 'string') return null;
                s += c;
                if (i < n.expressions.length) {
                    const f = fold(n.expressions[i], depth + 1, seen);
                    if (f === null) return null;
                    s += f;
                }
            }
            return s;
        }
        if (n.type === 'BinaryExpression' && n.operator === '+') {
            const l = fold(n.left, depth + 1, seen);
            if (l === null) return null;
            const r = fold(n.right, depth + 1, seen);
            return r === null ? null : l + r;
        }
        if (n.type === 'Identifier') {
            const rec = singleConst(table, n.name);
            if (!rec || seen.has(n.name)) return null;
            seen.add(n.name);
            const out = fold(rec.init, depth + 1, seen);
            seen.delete(n.name);
            return out;
        }
        return null;
    };
    return (n) => fold(n, 0, new Set());
}

// ---------------------------------------------------------------- 单文件扫描

const addTo = (census, tok, cat, where, n) => { const m = census[tok]; if (!m[cat]) m[cat] = []; for (let i = 0; i < (n || 1); i++) m[cat].push(where); };

/**
 * @returns {{ reads, problems, defs, census, counts, readFnRoots }}
 */
function scanSource(rel, source, opts) {
    const allowConstArrayMap = !opts || opts.allowConstArrayMap === undefined ? ALLOW_CONST_ARRAY_MAP : opts.allowConstArrayMap;
    const out = { reads: [], problems: [], defs: 0, census: { T1: {}, T2: {} }, counts: { t1: { text: 0, covered: 0 }, t2: { text: 0, covered: 0 } }, readFnRoots: 0, t2Sites: new Map(), fingerprints: [] };
    const bad = (rule, node, msg) => out.problems.push({ rule, file: rel, line: node.loc.start.line, msg });
    const comments = [];
    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true, locations: true, onComment: (block, text, start, end) => comments.push([start, end]) });
    } catch (e) {
        out.problems.push({ rule: 'F-parse', file: rel, line: (e.loc && e.loc.line) || 0, msg: `无法解析：${e.message}` });
        return out;
    }
    // ① 去注释后的文本记号次数
    let stripped = '';
    let last = 0;
    for (const [s, e] of comments.sort((a, b) => a[0] - b[0])) { stripped += source.slice(last, s) + ' '.repeat(e - s); last = e; }
    stripped += source.slice(last);
    // 去注释后的文本里，两个记号的每一个匹配位置（注释被同长度空格顶替，所以位置与原文一致）
    const matchPositions = (re) => { const ps = []; re.lastIndex = 0; let m; while ((m = re.exec(stripped)) !== null) ps.push(m.index); re.lastIndex = 0; return ps; };
    const textPos = { T1: matchPositions(RE_T1), T2: matchPositions(RE_T2) };
    out.counts.t1.text = textPos.T1.length;
    out.counts.t2.text = textPos.T2.length;
    const lineOfPos = (pos) => { let line = 1; for (let i = 0; i < pos; i++) if (source.charCodeAt(i) === 10) line += 1; return line; };

    const parents = new Map();
    walk(ast, (n, p) => { if (p) parents.set(n, p); }, null, []);
    const bindings = collectBindings(ast);
    const fold = makeFolder(bindings);
    const cover = { T1: [], T2: [] };   // 已归类节点的源码区间 [start, end)：标识符 / 字符串字面量 / 模板片段 / 正则字面量里含记号的节点
    const escSeen = new Set();
    /** 登记一个节点；原文与解码值里的记号个数不同 → F-escaped。返回（取较大者的）两个记号个数，供根表达式折叠核算用。 */
    const classify = (n, rawText, decodedText) => {
        const r1 = countOf(RE_T1, rawText);
        const d1 = countOf(RE_T1, decodedText);
        const r2 = countOf(RE_T2, rawText);
        const d2 = countOf(RE_T2, decodedText);
        if (r1 || d1) cover.T1.push([n.start, n.end]);
        if (r2 || d2) cover.T2.push([n.start, n.end]);
        if ((r1 !== d1 || r2 !== d2) && !escSeen.has(n.start)) {
            escSeen.add(n.start);
            bad('F-escaped', n, `源码原文与解码值里的记号个数不同（${T1}：原文 ${r1} / 解码 ${d1}；${T2}：原文 ${r2} / 解码 ${d2}）——转义拼写或 String.raw 转义；不允许用转义写出记号`);
        }
        return [Math.max(r1, d1), Math.max(r2, d2)];
    };
    const roots = new Map();   // 根表达式节点 → { t1, t2 }（片段里的记号次数）
    const rootOf = (n) => {
        let cur = n;
        for (;;) {
            const p = parents.get(cur);
            if (p && ((p.type === 'BinaryExpression' && p.operator === '+') || (p.type === 'TemplateLiteral' && p.expressions.includes(cur)))) cur = p; else return cur;
        }
    };
    const noteRoot = (n, c1, c2) => {
        const r = rootOf(n);
        let info = roots.get(r);
        if (!info) { info = { t1: 0, t2: 0 }; roots.set(r, info); }
        info.t1 += c1;
        info.t2 += c2;
    };
    const constArrayUses = new Set();   // 形态 d' 用到的常量数组名

    walk(ast, (n, p, anc) => {
        const where = `${rel}:${n.loc.start.line}`;
        // ---- 字符串类节点：记号计数 + 根表达式登记
        if (n.type === 'Literal' && n.regex) {
            // 正则字面量：任何记号都不允许出现（pattern 与 flags 的原文）
            const raw = source.slice(n.start, n.end);
            if (has1(raw) || has2(raw)) {
                if (has1(raw)) cover.T1.push([n.start, n.end]);
                if (has2(raw)) cover.T2.push([n.start, n.end]);
                bad('F-regex', n, `正则字面量里出现记号（${has1(raw) ? T1 : ''}${has1(raw) && has2(raw) ? ' / ' : ''}${has2(raw) ? T2 : ''}）：${raw.slice(0, 60)}`);
            }
            return;
        }
        if (n.type === 'Literal' && typeof n.value === 'string') {
            const [c1, c2] = classify(n, source.slice(n.start, n.end), n.value);
            noteRoot(n, c1, c2);
            return;
        }
        if (n.type === 'TemplateElement') {
            const cooked = typeof n.value.cooked === 'string' ? n.value.cooked : '';
            const [c1, c2] = classify(n, n.value.raw, cooked);
            noteRoot(p, c1, c2);
            return;
        }
        if (n.type === 'TemplateLiteral' || (n.type === 'BinaryExpression' && n.operator === '+')) { noteRoot(n, 0, 0); return; }
        if (n.type !== 'Identifier') return;

        // ---- 标识符
        const [c1, c2] = classify(n, source.slice(n.start, n.end), n.name);
        const shorthandValueDup = !!p && p.type === 'Property' && p.shorthand && p.value === n && p.key !== n;
        if (c2 && !shorthandValueDup) {
            if (rel === SQL_REWRITER_FILE) addTo(out.census, 'T2', 'utils/instance-db.js 整文件豁免（标识符）', where);
            else { bad('F-sql', n, `标识符名里含 ${T2}（${n.name}）`); addTo(out.census, 'T2', 'UNCLASSIFIED 标识符', where); }
        }
        if (!c1) return;
        if (n.name !== T1) { bad('F-form', n, `标识符名里含 ${T1}（${n.name}）`); addTo(out.census, 'T1', 'UNCLASSIFIED 含记号的其他标识符', where); return; }
        const gp = anc.length >= 2 ? anc[anc.length - 2] : null;

        // a 定义
        if (p && p.type === 'FunctionDeclaration' && p.id === n) {
            if (rel === 'server.js' && gp && gp.type === 'Program') { out.defs += 1; addTo(out.census, 'T1', 'a 定义', where); return; }
            bad('F-def', n, `${T1} 的函数声明不在 server.js 顶层（${rel}）`);
            return;
        }
        // b / c：调用 f(x) 或 obj.f(x)
        let callNode = null;
        if (p && p.type === 'CallExpression' && p.callee === n) callNode = p;
        else if (p && p.type === 'MemberExpression' && p.property === n && !p.computed && gp && gp.type === 'CallExpression' && gp.callee === p) callNode = gp;
        if (callNode) {
            const args = callNode.arguments;
            if (args.length !== 1) { bad('F-call-arg', n, `${T1} 调用的实参个数 ${args.length}（须恰好 1 个）`); return; }
            const a = args[0];
            const lit = literalValue(a);
            if (lit !== null) { out.reads.push({ key: lit, file: rel, line: n.loc.start.line, form: 'b' }); addTo(out.census, 'T1', 'b 调用(字符串字面量)', where); return; }
            if (a.type === 'Identifier') {
                const v = resolveConstLiteral(bindings, a.name);
                if (v !== null) { out.reads.push({ key: v, file: rel, line: n.loc.start.line, form: 'c' }); addTo(out.census, 'T1', 'c 调用(const 字面量标识符)', where); return; }
                bad('F-call-arg', n, `${T1}(${a.name})：${a.name} 在本文件里不是「唯一绑定的 const X = '字面量'」`);
                return;
            }
            bad('F-call-arg', n, `${T1} 调用的实参是 ${a.type}（须为字符串字面量或 const 字面量标识符）`);
            return;
        }
        // d / d'：<数组>.map(readSystemConfig)
        if (p && p.type === 'CallExpression' && p.arguments.includes(n)) {
            const callee = p.callee;
            if (p.arguments.length === 1 && callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'map') {
                const obj = callee.object;
                if (obj.type === 'ArrayExpression' && obj.elements.length > 0 && obj.elements.every(isLit)) {
                    for (const el of obj.elements) out.reads.push({ key: literalValue(el), file: rel, line: n.loc.start.line, form: 'd' });
                    addTo(out.census, 'T1', 'd [字面量数组].map', where);
                    return;
                }
                if (allowConstArrayMap && obj.type === 'Identifier') {
                    const arr = resolveConstArray(bindings, obj.name);
                    if (arr !== null) {
                        for (const k of arr.values) out.reads.push({ key: k, file: rel, line: n.loc.start.line, form: "d'" });
                        constArrayUses.add(obj.name);
                        addTo(out.census, 'T1', `d' 常量数组.map (${obj.name})`, where);
                        return;
                    }
                }
                bad('F-form', n, `.map(${T1}) 的数组不是「全字符串字面量数组」${allowConstArrayMap ? '或「唯一绑定的 const 字面量数组」' : ''}（${obj.type}）`);
                return;
            }
            bad('F-form', n, `${T1} 被当作实参传给 ${callee.type === 'MemberExpression' && callee.property.name ? callee.property.name : callee.type}（只允许 .map 形态）`);
            return;
        }
        // e：对象简写 / 同名键值（对象字面量与解构模式）
        if (p && p.type === 'Property' && gp && (gp.type === 'ObjectExpression' || gp.type === 'ObjectPattern')) {
            if (p.computed) { bad('F-form', n, `computed 属性名里的 ${T1}`); return; }
            if (p.shorthand) { if (p.key === n) addTo(out.census, 'T1', 'e 简写属性(对象字面量 / 解构模式)', where); return; }   // key 与 value 是同位置的两个节点，普查只记一次
            const keyIsT = p.key.type === 'Identifier' && p.key.name === T1;
            const valIsT = p.value.type === 'Identifier' && p.value.name === T1;
            if (keyIsT && valIsT) { addTo(out.census, 'T1', 'e 同名键值', where); return; }
            bad('F-form', n, `属性 ${keyIsT ? `${T1}: <${p.value.type}>` : `<${p.key.type === 'Identifier' ? p.key.name : p.key.type}>: ${T1}`}（只允许简写或同名键值；改名传递不允许）`);
            return;
        }
        bad('F-form', n, `${T1} 出现在不允许的位置（父节点 ${p ? p.type : 'root'}${gp ? ' / ' + gp.type : ''}）`);
    }, null, []);

    // ---- 根表达式：折叠后判断 T1 / T2
    const inTopLevelReadFn = (node) => {
        let cur = node;
        for (;;) {
            const par = parents.get(cur);
            if (!par) return false;
            if (par.type === 'FunctionDeclaration' && par.id && par.id.name === T1) { const up = parents.get(par); return !!up && up.type === 'Program'; }
            cur = par;
        }
    };
    const isDepsArrayInit = (arr) => {
        const d = parents.get(arr);
        if (!d || d.type !== 'VariableDeclarator' || d.init !== arr || d.id.type !== 'Identifier' || !/DEPS$/.test(d.id.name)) return false;
        const decl = parents.get(d);
        return !!decl && decl.type === 'VariableDeclaration' && decl.kind === 'const';
    };
    /** 站点名 = 文件里包含该节点的顶层语句的声明名：function f / const X / <表达式语句：赋值左侧 或 调用（callee + 首个字面量实参）>。 */
    const topLevelDeclName = (node) => {
        let cur = node;
        for (;;) {
            const par = parents.get(cur);
            if (!par) return '(none)';
            if (par.type === 'Program') break;
            cur = par;
        }
        const src = (x) => source.slice(x.start, x.end).replace(/\s+/g, ' ');
        if (cur.type === 'FunctionDeclaration') return `function ${cur.id ? cur.id.name : '(anonymous)'}`;
        if (cur.type === 'VariableDeclaration') {
            const d = cur.declarations.find((x) => x.start <= node.start && node.end <= x.end) || cur.declarations[0];
            return `${cur.kind} ${d.id.type === 'Identifier' ? d.id.name : '(pattern)'}`;
        }
        if (cur.type === 'ExpressionStatement') {
            const e = cur.expression;
            if (e.type === 'AssignmentExpression') return `${src(e.left)} ${e.operator}`;
            if (e.type === 'CallExpression') {
                const first = e.arguments[0];
                return `${src(e.callee)}(${first && isStringLiteral(first) ? JSON.stringify(first.value) : ''}…)`;
            }
        }
        return cur.type;
    };
    for (const [root, info] of roots) {
        const S = fold(root);
        const where = `${rel}:${root.loc.start.line}`;
        if (info.t1 > 0 || (S !== null && has1(S))) {
            const par = parents.get(root);
            const ok = root.type === 'Literal' && S === T1 && !!par && par.type === 'ArrayExpression' && isDepsArrayInit(par);
            if (ok) addTo(out.census, 'T1', 'e 字符串元素(const …DEPS 数组)', where);
            else {
                bad('F-form', root, S === null ? `含 ${T1} 的字符串 / 模板折叠不了` : `字符串 / 模板里出现 ${T1}（只允许 const …DEPS 数组的字符串元素）：${S.replace(/\s+/g, ' ').slice(0, 60)}`);
                addTo(out.census, 'T1', 'UNCLASSIFIED 字符串/模板', where);
            }
        }
        if (info.t2 > 0 || (S !== null && has2(S))) {
            const occ = Math.max(info.t2, 1);
            if (rel === SQL_REWRITER_FILE) { addTo(out.census, 'T2', 'utils/instance-db.js 整文件豁免', where, occ); continue; }
            // 站点清单硬门：不管是否含 SELECT，每个含 T2 的字符串 / 模板 / 可折叠拼接都归到「文件 + 所在顶层声明」站点上，
            // 站点与“内容指纹多重集”必须与手写清单一致（在 evaluate 里核对）。指纹 = 可折叠的用折叠后文本，折叠不了的用根表达式源码原文；都压缩连续空白、去首尾空白。
            const site = topLevelDeclName(root);
            const fp = fingerprintOf(S !== null ? S : source.slice(root.start, root.end));
            const rec = out.t2Sites.get(site) || { count: 0, lines: [], fps: [] };
            rec.count += occ;
            rec.lines.push(root.loc.start.line);
            rec.fps.push(fp);
            out.t2Sites.set(site, rec);
            addTo(out.census, 'T2', `站点 ${rel} / ${site}`, where, occ);
            out.fingerprints.push({ file: rel, site, line: root.loc.start.line, folded: S !== null, fp });
            if (S !== null && S.trim().toLowerCase() === T2) bad('F-sql', root, `值恰好等于 '${T2}' 的字面量（表名常量）不得进站点清单`);
            // readSystemConfig 函数体内的 SELECT 数：按“含记号的字符串出现位置”计（info.t2 = 根表达式里直接含记号的字符串 / 模板片段里的记号个数）。
            // 引用常量 SQL 的模板，其片段里没有记号（info.t2 = 0），不重复计。
            if (S !== null && rel === 'server.js' && /^\s*select\b/i.test(S) && inTopLevelReadFn(root)) out.readFnRoots += info.t2;
        }
    }

    // ---- d' 常量数组：除声明外的标识符引用必须恰好 1 处，且就是那个 X.map(readSystemConfig) 的对象
    for (const name of constArrayUses) {
        const rec = singleConst(bindings, name);
        const declId = rec && rec.declarator.id;
        let refs = 0;
        let mapOk = false;
        let firstRef = null;
        walk(ast, (n, p, anc) => {
            if (n.type !== 'Identifier' || n.name !== name || n === declId) return;
            if (p && p.type === 'MemberExpression' && p.property === n && !p.computed) return;   // obj.NAME：属性名，不是引用
            if (p && p.type === 'Property' && p.key === n && !p.computed && !p.shorthand) return;   // { NAME: … }：对象键，不是引用
            refs += 1;
            if (!firstRef) firstRef = n;
            const gp = anc.length >= 2 ? anc[anc.length - 2] : null;
            if (p && p.type === 'MemberExpression' && p.object === n && !p.computed && p.property.type === 'Identifier' && p.property.name === 'map'
                && gp && gp.type === 'CallExpression' && gp.callee === p && gp.arguments.length === 1 && gp.arguments[0].type === 'Identifier' && gp.arguments[0].name === T1) mapOk = true;
        }, null, []);
        if (refs !== 1 || !mapOk) bad('F-const-array', firstRef || rec.declarator, `常量数组 ${name} 除声明外必须只被引用 1 次，且就是 ${name}.map(${T1})（实际引用 ${refs} 处）`);
    }

    // ---- 按位置闭集核算：去注释后源码里每个记号文本匹配位置，都必须落在某个已归类节点的区间内
    for (const [tok, key, token] of [['T1', 't1', T1], ['T2', 't2', T2]]) {
        let uncovered = 0;
        for (const pos of textPos[tok]) {
            if (cover[tok].some(([a, b]) => pos >= a && pos + token.length <= b)) continue;
            uncovered += 1;
            out.problems.push({ rule: 'F-unaccounted', file: rel, line: lineOfPos(pos), msg: `记号 ${token} 在第 ${lineOfPos(pos)} 行有一处文本匹配没落在任何已归类的标识符 / 字符串 / 模板片段 / 正则节点里（位置 ${pos}）` });
        }
        out.counts[key].covered = textPos[tok].length - uncovered;
    }
    return out;
}

/** 站点内容指纹：压缩连续空白、去首尾空白；保留大小写。 */
function fingerprintOf(text) { return String(text).replace(/\s+/g, ' ').trim(); }

// ---------------------------------------------------------------- 全局判定

/** 白名单自检（F3-5）：返回问题数组。 */
function checkWhitelistNames(whitelistKeys, dingtalkKeys) {
    const problems = [];
    const both = whitelistKeys.filter((k) => dingtalkKeys.includes(k));
    if (both.length) problems.push({ rule: 'F-wl', file: '(whitelist)', line: 0, msg: `白名单与钉钉四键相交：${both.join(', ')}` });
    for (const k of whitelistKeys) {
        if (SECRET_NAME_RE.test(k)) problems.push({ rule: 'F-wl', file: '(whitelist)', line: 0, msg: `白名单键名像凭证（${SECRET_NAME_RE}）：${k}` });
    }
    return problems;
}

/**
 * @param {Object<string,string>} files   相对路径（/ 分隔）→ 源码
 * @param {{ whitelistKeys: string[], dingtalkKeys: string[], allowConstArrayMap?: boolean }} cfg
 */
function evaluate(files, cfg) {
    const problems = [];
    const reads = [];
    let defs = 0;
    let readFnRoots = 0;
    const census = { T1: {}, T2: {} };
    const counts = { t1: { text: 0, covered: 0 }, t2: { text: 0, covered: 0 } };
    const foundSites = new Map();   // `${file}|${decl}` → { count, lines, fps }
    const fingerprints = [];
    for (const rel of Object.keys(files).sort()) {
        const r = scanSource(rel, files[rel], { allowConstArrayMap: cfg.allowConstArrayMap });
        problems.push(...r.problems);
        reads.push(...r.reads);
        defs += r.defs;
        readFnRoots += r.readFnRoots;
        fingerprints.push(...r.fingerprints);
        for (const [decl, rec] of r.t2Sites) foundSites.set(`${rel}|${decl}`, rec);
        for (const tok of ['T1', 'T2']) for (const [cat, list] of Object.entries(r.census[tok])) { census[tok][cat] = (census[tok][cat] || []).concat(list); }
        for (const k of ['t1', 't2']) { counts[k].text += r.counts[k].text; counts[k].covered += r.counts[k].covered; }
    }
    if (defs !== 1) problems.push({ rule: 'F-def', file: 'server.js', line: 0, msg: `server.js 顶层 function ${T1} 的定义数 = ${defs}（须恰好 1）` });

    const expected = new Set([...cfg.whitelistKeys, ...cfg.dingtalkKeys]);
    const got = new Set(reads.map((r) => r.key));
    const extra = [...got].filter((k) => !expected.has(k)).sort();
    const missing = [...expected].filter((k) => !got.has(k)).sort();
    for (const k of extra) {
        const where = reads.filter((r) => r.key === k).map((r) => `${r.file}:${r.line}`).join(', ');
        problems.push({ rule: 'F-keys-extra', file: '(keys)', line: 0, msg: `代码读取了白名单 ∪ 钉钉四键之外的键 ${k}（${where}）` });
    }
    for (const k of missing) problems.push({ rule: 'F-keys-missing', file: '(keys)', line: 0, msg: `白名单 ∪ 钉钉四键里的 ${k} 在代码里没有读取点` });
    if (readFnRoots !== 1) problems.push({ rule: 'F-sql', file: 'server.js', line: 0, msg: `${T1} 函数体内含 ${T2} 的 SELECT 字符串数 = ${readFnRoots}（须恰好 1，按含记号的字符串出现位置计；若把这条 SQL 提到函数外，只登记站点不够，须同时调整本检查的计数口径）` });
    // T2 站点清单硬门：站点 + 内容指纹多重集
    const sites = cfg.sites || T2_SITES;
    const listed = new Map(sites.map((s) => [`${s.file}|${s.decl}`, s]));
    const short = (s) => (s.length > 90 ? `${s.slice(0, 90)}…` : s);
    /** 多重集差：a 里有而 b 里（按个数）没有的元素。 */
    const multisetMinus = (a, b) => { const left = b.slice(); const out = []; for (const x of a) { const i = left.indexOf(x); if (i >= 0) left.splice(i, 1); else out.push(x); } return out; };
    for (const [k, rec] of foundSites) {
        const s = listed.get(k);
        if (!s) { problems.push({ rule: 'F-sql', file: k.split('|')[0], line: rec.lines[0], msg: `新增 ${T2} 出现点须经审查后加入站点清单：${k}（${rec.count} 处，行 ${rec.lines.join(',')}）` }); continue; }
        const extraFps = multisetMinus(rec.fps, s.fps);
        const goneFps = multisetMinus(s.fps, rec.fps);
        if (extraFps.length || goneFps.length) {
            problems.push({ rule: 'F-sql', file: k.split('|')[0], line: rec.lines[0], msg: `站点 ${k} 的 ${T2} 内容指纹多重集与清单不符：代码里多出 [${extraFps.map(short).join(' | ')}]；清单里有而代码里没有 [${goneFps.map(short).join(' | ')}]；变更须经审查后更新站点清单` });
        }
    }
    for (const [k, s] of listed) if (!foundSites.has(k)) problems.push({ rule: 'F-sql', file: s.file, line: 0, msg: `站点清单里的 ${k} 在代码里已不存在；请同步更新站点清单` });

    problems.push(...checkWhitelistNames(cfg.whitelistKeys, cfg.dingtalkKeys));
    return { problems, reads, defs, extra, missing, census, counts, readFnRoots, fingerprints };
}

// ---------------------------------------------------------------- 真实源码扫描

function listJs(dirAbs, relBase, out) {
    for (const e of fs.readdirSync(dirAbs, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const abs = path.join(dirAbs, e.name);
        const rel = `${relBase}/${e.name}`;
        if (e.isDirectory()) listJs(abs, rel, out);
        else if (e.isFile() && e.name.endsWith('.js')) out.push(rel);
    }
}
function loadRealFiles(root) {
    const rels = ['server.js'];
    for (const d of ['routes', 'utils']) {
        const abs = path.join(root, d);
        if (fs.existsSync(abs)) listJs(abs, d, rels);
    }
    const files = {};
    for (const rel of rels) files[rel] = fs.readFileSync(path.join(root, rel), 'utf8');
    return files;
}

// ---------------------------------------------------------------- 主流程 + 自测

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m, d) => { fail++; console.log(`  [FAIL] ${m}${d ? '\n         ' + d : ''}`); };
const must = (cond, m, d) => (cond ? ok(m) : bad(m, d));

const ruleSet = (problems) => [...new Set(problems.map((p) => p.rule))].sort();

function selfTest() {
    console.log('\n== 自测：合成源码喂给扫描函数，期望的判红规则集合手写在表里 ==');
    const CFG = { whitelistKeys: ['k_a'], dingtalkKeys: ['k_b'] };
    const SERVER_BASE = [
        'function readSystemConfig(key) {',
        "  return new Promise((resolve) => { db.get('SELECT config_value_encrypted FROM system_configs WHERE config_key = ?', [key], () => resolve(null)); });",
        '}',
        "async function f() { return readSystemConfig('k_a'); }",
    ].join('\n');
    const ROUTE_BASE = "module.exports = (deps) => { const { readSystemConfig } = deps; return readSystemConfig('k_b'); };";
    const base = () => ({ 'server.js': SERVER_BASE, 'routes/x.js': ROUTE_BASE });
    const withExtra = (rel, extra) => { const f = base(); f[rel] = (f[rel] || '') + '\n' + extra; return f; };
    // 自测用的站点清单：基线里 server.js 的 readSystemConfig 函数体 1 条 SELECT（指纹手写）；各用例按需追加（第 5 个元素），cfg.sites 给了就整体替换。
    // 站点指纹全部手写成“已压缩空白”的形态（连续空白 → 1 个空格、去首尾空白），不从被测代码里取。
    const READ_FP = 'SELECT config_value_encrypted FROM system_configs WHERE config_key = ?';
    const READ_SITE = { file: 'server.js', decl: 'function readSystemConfig', fps: [READ_FP] };
    const rules = (files, cfg, extraSites) => ruleSet(evaluate(files, Object.assign({ sites: [READ_SITE].concat(extraSites || []) }, cfg || CFG)).problems);
    const OFF = { whitelistKeys: ['k_a'], dingtalkKeys: ['k_b'], allowConstArrayMap: false };
    const site = (file, decl, ...fps) => ({ file, decl, fps });

    // 期望表：[说明, 文件集合, cfg 覆盖, 期望判红规则（空数组 = 绿）]
    const T = [
        // ---------- 判绿：现实代码的每一类合法形态各一例 ----------
        ['基线（a 定义 + b 调用 + e 解构简写）', base(), null, []],
        ['b 成员调用 deps.readSystemConfig(字面量)', withExtra('routes/x.js', "function g(deps) { return deps.readSystemConfig('k_a'); }"), null, []],
        ['c 常量间接（const X = 字面量）', withExtra('routes/x.js', "const KEY_C = 'k_a'; function g() { return readSystemConfig(KEY_C); }"), null, []],
        ['d [字面量].map(readSystemConfig)', withExtra('routes/x.js', "const r = Promise.all(['k_a', 'k_b'].map(readSystemConfig));"), null, []],
        ["d' 常量数组：除声明外只被引用 1 次，且就是 .map(readSystemConfig) 的对象（server.js DINGTALK_CONFIG_KEYS 现状形态）", withExtra('server.js', "const KEYS_R = ['k_a', 'k_b']; const r = Promise.all(KEYS_R.map(readSystemConfig));"), null, []],
        ["d' 常量数组：对象键 / 成员属性名同名不算引用", withExtra('server.js', "const KEYS_Z = ['k_a', 'k_b']; const r = KEYS_Z.map(readSystemConfig); const o = { KEYS_Z: 1 }; o.KEYS_Z = 2;"), null, []],
        ['e 对象简写 / 同名键值 / const …DEPS 数组字符串元素', withExtra('routes/y.js', "const A = require('./m')({ logger, readSystemConfig }); const B = { readSystemConfig: readSystemConfig }; const REQUIRED_DEPS = ['logger', 'readSystemConfig']; const OTHER_DEPS = ['readSystemConfig'];"), null, []],
        ['注释里写 readSystemConfig(\'zzz\') / system_configs 不计', withExtra('routes/x.js', "// readSystemConfig('zzz')\n/* system_configs readSystemConfig */\nconst ok1 = 1;"), null, []],
        ['② sqlite_master 存在性检查里提到 system_configs', withExtra('routes/x.js', "const q = \"SELECT name FROM sqlite_master WHERE type='table' AND name='system_configs'\";"), null, [], [site('routes/x.js', 'const q', "SELECT name FROM sqlite_master WHERE type='table' AND name='system_configs'")]],
        ['utils/instance-db.js（重写方）整文件豁免分类：SELECT / 标识符 / 简写属性（简写按位置去重，闭集核算仍相等）', withExtra('utils/instance-db.js', "const SYSTEM_CONFIGS_DDL = 'x'; const q = 'SELECT rowid, config_key FROM system_configs'; module.exports = { SYSTEM_CONFIGS_DDL };"), null, []],
        ['③ 写入 / 建表语句各一条（INSERT / UPDATE SET / DELETE FROM / CREATE TABLE IF NOT EXISTS / CREATE UNIQUE INDEX）', withExtra('routes/x.js', "const a1 = 'INSERT INTO system_configs (config_key) VALUES (?)'; const a2 = 'UPDATE system_configs SET config_value_encrypted = ? WHERE rowid = ?'; const a3 = 'DELETE FROM system_configs WHERE rowid = ?'; const a4 = `CREATE TABLE IF NOT EXISTS system_configs (\n config_key TEXT PRIMARY KEY\n)`; const a5 = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_sc ON system_configs(config_key)';"), null, [], [
            site('routes/x.js', 'const a1', 'INSERT INTO system_configs (config_key) VALUES (?)'),
            site('routes/x.js', 'const a2', 'UPDATE system_configs SET config_value_encrypted = ? WHERE rowid = ?'),
            site('routes/x.js', 'const a3', 'DELETE FROM system_configs WHERE rowid = ?'),
            site('routes/x.js', 'const a4', 'CREATE TABLE IF NOT EXISTS system_configs ( config_key TEXT PRIMARY KEY )'),
            site('routes/x.js', 'const a5', 'CREATE UNIQUE INDEX IF NOT EXISTS idx_sc ON system_configs(config_key)'),
        ]],
        ['③ 插值为同文件 const 字符串的模板（可完全折叠）：指纹是折叠后的文本', withExtra('routes/x.js', "const COLS = 'config_key'; const q = `INSERT INTO system_configs (${COLS}) VALUES (?)`;"), null, [], [site('routes/x.js', 'const q', 'INSERT INTO system_configs (config_key) VALUES (?)')]],
        ['日志文字：logger.error / console.warn（带插值，折叠不了，指纹是源码原文）/ new Error 的直接实参（同一站点 3 个根表达式）', withExtra('routes/x.js', "function g(e) { logger.error('system_configs 表未创建'); console.warn(`读 system_configs 失败 ${e}`); throw new Error('system_configs missing'); }"), null, [],
            [site('routes/x.js', 'function g', 'system_configs 表未创建', '`读 system_configs 失败 ${e}`', 'system_configs missing')]],
        ['非 SQL 提示文字放在对象属性里，站点已登记', withExtra('routes/x.js', "const o = { reason: '缺失 system_configs.x 为空' };"), null, [], [site('routes/x.js', 'const o', '缺失 system_configs.x 为空')]],
        ['站点按“所在顶层声明”归并：表达式语句（module.exports = …）与 app.get(…) 各登记一处', withExtra('routes/x.js', "module.exports.extra = () => 'INSERT INTO system_configs (a) VALUES (1)';\napp.get('/api/z', () => 'DELETE FROM system_configs');"), null, [],
            [site('routes/x.js', 'module.exports.extra =', 'INSERT INTO system_configs (a) VALUES (1)'), site('routes/x.js', 'app.get("/api/z"…)', 'DELETE FROM system_configs')]],
        ['站点指纹对空白不敏感：登记的是压缩空白后的文本，代码里换行缩进不同仍判绿', withExtra('routes/x.js', "function w() { return 'INSERT INTO   system_configs\\n   (a)   VALUES (1)'; }"), null, [], [site('routes/x.js', 'function w', 'INSERT INTO system_configs (a) VALUES (1)')]],
        ['readSystemConfig 函数体内无插值模板 SQL 只计 1 次（模板与其片段不重复计数）', { 'server.js': SERVER_BASE.replace("'SELECT config_value_encrypted FROM system_configs WHERE config_key = ?'", '`SELECT config_value_encrypted FROM system_configs WHERE config_key = ?`'), 'routes/x.js': ROUTE_BASE }, null, []],
        ['readSystemConfig 函数体内：常量 SQL 定义 + 模板引用该常量，SELECT 只计 1 次（定义算 1 条；引用模板的片段里没有记号）——两个根表达式各有指纹，登记两条', {
            'server.js': [
                'function readSystemConfig(key) {',
                "  const Q = 'SELECT config_value_encrypted FROM system_configs';",
                '  return new Promise((resolve) => { db.get(`${Q} WHERE config_key = ?`, [key], () => resolve(null)); });',
                '}',
                "async function f() { return readSystemConfig('k_a'); }",
            ].join('\n'),
            'routes/x.js': ROUTE_BASE,
        }, null, [], [site('server.js', 'function readSystemConfig', 'SELECT config_value_encrypted FROM system_configs', 'SELECT config_value_encrypted FROM system_configs WHERE config_key = ?')]],   // 同一站点键在 extraSites 里重复登记时，后者覆盖基线的 READ_SITE

        // ---------- 判红：读取键集合 ----------
        ['新增字面量键 readSystemConfig(\'new_key\')', withExtra('routes/x.js', "function g() { return readSystemConfig('new_key'); }"), null, ['F-keys-extra']],
        ['常量间接的非白名单键', withExtra('routes/x.js', "const KEY_N = 'new_key'; function g() { return readSystemConfig(KEY_N); }"), null, ['F-keys-extra']],
        ['.map 数组里新增键', withExtra('routes/x.js', "const r = ['k_a', 'k_b', 'new_key'].map(readSystemConfig);"), null, ['F-keys-extra']],
        ["d' 常量数组里新增键", withExtra('server.js', "const KEYS_N = ['k_a', 'new_key']; const r = KEYS_N.map(readSystemConfig);"), null, ['F-keys-extra']],
        ['缺少：白名单有键、代码没有读取点', base(), { whitelistKeys: ['k_a', 'k_z'], dingtalkKeys: ['k_b'] }, ['F-keys-missing']],

        // ---------- 判红：T1 形态 ----------
        ['判红示例 readSystemConfig(req.query.k)', withExtra('routes/x.js', 'function g(req) { return readSystemConfig(req.query.k); }'), null, ['F-call-arg']],
        ['判红示例 readSystemConfig(a + b)', withExtra('routes/x.js', 'function g(a, b) { return readSystemConfig(a + b); }'), null, ['F-call-arg']],
        ['判红示例 const f = readSystemConfig', withExtra('routes/x.js', 'const f = readSystemConfig;'), null, ['F-form']],
        ['判红示例 getCfg: readSystemConfig（改名传递）', withExtra('routes/x.js', 'const o = { getCfg: readSystemConfig };'), null, ['F-form']],
        ['判红示例 [k1, k2].map(readSystemConfig)（含非字面量元素）', withExtra('routes/x.js', 'function g(k1, k2) { return [k1, k2].map(readSystemConfig); }'), null, ['F-form']],
        ["d' 数组含非字面量元素", withExtra('server.js', "const k9 = 'k_a'; const KEYS_M = [k9, 'k_b']; const r = KEYS_M.map(readSystemConfig);"), null, ['F-form']],
        ["d' 同名多处绑定（歧义）", withExtra('server.js', "const KEYS_D = ['k_a']; function h(KEYS_D) { return KEYS_D.map(readSystemConfig); }"), null, ['F-form']],
        ['c 标识符同名多处绑定（歧义）', withExtra('routes/x.js', "const KEY_C = 'k_a'; function h(KEY_C) { return readSystemConfig(KEY_C); }"), null, ['F-call-arg']],
        ['c 标识符是 let 而非 const', withExtra('routes/x.js', "let KEY_L = 'k_a'; function g() { return readSystemConfig(KEY_L); }"), null, ['F-call-arg']],
        ['c 标识符的 const 值带插值', withExtra('routes/x.js', 'const KEY_T = `k_${1}`; function g() { return readSystemConfig(KEY_T); }'), null, ['F-call-arg']],
        ['调用没有实参 / 多个实参 / 展开实参', withExtra('routes/x.js', "function g(ks) { readSystemConfig(); readSystemConfig('k_a', 1); return readSystemConfig(...ks); }"), null, ['F-call-arg']],
        ['.call / .apply 调用', withExtra('routes/x.js', "function g() { return readSystemConfig.call(null, 'k_a'); }"), null, ['F-form']],
        ["computed 成员 deps['readSystemConfig']", withExtra('routes/x.js', "function g(deps) { return deps['readSystemConfig']('k_a'); }"), null, ['F-form']],
        ['computed 成员，模板字面量 deps[`readSystemConfig`]', withExtra('routes/x.js', "function g(deps) { return deps[`readSystemConfig`]('k_a'); }"), null, ['F-form']],
        ["computed 成员，拼接 deps['readSystem' + 'Config']", withExtra('routes/x.js', "function g(deps) { return deps['readSystem' + 'Config']('k_a'); }"), null, ['F-form']],
        ["const m = 'readSystemConfig'; deps[m]('k')", withExtra('routes/x.js', "const MNAME = 'readSystemConfig'; function g(deps) { return deps[MNAME]('k_a'); }"), null, ['F-form']],
        ["数组解构取出 const [m] = ['readSystemConfig']; deps[m]('k')", withExtra('routes/x.js', "function g(deps) { const [m] = ['readSystemConfig']; return deps[m]('k_a'); }"), null, ['F-form']],
        ["字符串元素所在数组不是 const …DEPS（const FOO = ['readSystemConfig']）", withExtra('routes/x.js', "const FOO = ['logger', 'readSystemConfig'];"), null, ['F-form']],
        ["字符串元素所在数组是 let …DEPS", withExtra('routes/x.js', "let LATE_DEPS = ['readSystemConfig'];"), null, ['F-form']],
        ['解构模式带默认值 { readSystemConfig = fallback }', withExtra('routes/x.js', 'function g(deps) { const { readSystemConfig = fb } = deps; }'), null, ['F-form']],
        ['解构改名 { readSystemConfig: rsc }', withExtra('routes/x.js', 'function g(deps) { const { readSystemConfig: rsc } = deps; }'), null, ['F-form']],
        ['数组元素 [readSystemConfig]', withExtra('routes/x.js', 'const arr = [readSystemConfig];'), null, ['F-form']],
        ['局部重新声明 const readSystemConfig = …', withExtra('routes/x.js', 'function g() { const readSystemConfig = async () => 1; }'), null, ['F-form']],
        ['作为其他函数的实参 setCfg(readSystemConfig)', withExtra('routes/x.js', 'setCfg(readSystemConfig);'), null, ['F-form']],
        ['含记号的其他标识符 xreadSystemConfigY', withExtra('routes/x.js', 'function xreadSystemConfigY() {}'), null, ['F-form']],
        ['T1 出现在正则字面量里（显式判红）', withExtra('routes/x.js', 'const re1 = /readSystemConfig/;'), null, ['F-regex']],
        ['T1 出现在私有标识符里（#readSystemConfig：不是标识符 / 字符串 / 模板 / 正则节点，按位置核算判红）', withExtra('routes/x.js', 'class Z1 { #readSystemConfig = 1; }'), null, ['F-unaccounted']],
        ['单独的转义标识符：readSyst\\u0065mConfig(新键)——解码名是 readSystemConfig（仍被当作读取点，新键被抓），原文里看不到记号 → F-escaped', withExtra('routes/x.js', "function g() { return readSyst\\u0065mConfig('new_key'); }"), null, ['F-escaped', 'F-keys-extra']],
        ['单独的转义标识符：readSyst\\u0065mConfig 合法位置（白名单内的键）也判红——不允许用转义写出记号', withExtra('routes/x.js', "function g() { return readSyst\\u0065mConfig('k_a'); }"), null, ['F-escaped']],
        ['定义不在 server.js', withExtra('routes/x.js', 'function readSystemConfig(k) { return k; }'), null, ['F-def']],
        ['server.js 里有两处定义', withExtra('server.js', 'function readSystemConfig(k) { return k; }'), null, ['F-def']],
        ['没有任何定义', { 'server.js': 'async function f() { return 1; }', 'routes/x.js': ROUTE_BASE }, { whitelistKeys: [], dingtalkKeys: ['k_b'] }, ['F-def', 'F-sql']],

        // ---------- 判红：d' 常量数组的其余引用 ----------
        ["d' 数组先 push 再 map（KEYS.push('x')）", withExtra('server.js', "const KEYS_P = ['k_a', 'k_b']; KEYS_P.push('x'); const r = KEYS_P.map(readSystemConfig);"), null, ['F-const-array']],
        ["d' 数组其他变更方法（sort / splice / reverse / fill / pop / shift / unshift / copyWithin）", withExtra('server.js', "const KEYS_Q = ['k_a', 'k_b']; KEYS_Q.sort(); const r = KEYS_Q.map(readSystemConfig);"), null, ['F-const-array']],
        ["d' 数组赋给别的变量（const Y = KEYS）", withExtra('server.js', "const KEYS_Y = ['k_a', 'k_b']; const Y = KEYS_Y; const r = KEYS_Y.map(readSystemConfig);"), null, ['F-const-array']],
        ["d' 数组作为实参传出（f(KEYS)）", withExtra('server.js', "const KEYS_F = ['k_a', 'k_b']; g(KEYS_F); const r = KEYS_F.map(readSystemConfig);"), null, ['F-const-array']],
        ["d' 数组展开 [...KEYS]", withExtra('server.js', "const KEYS_S = ['k_a', 'k_b']; const copy = [...KEYS_S]; const r = KEYS_S.map(readSystemConfig);"), null, ['F-const-array']],
        ["d' 数组成员赋值 KEYS[0] = 'z'", withExtra('server.js', "const KEYS_E = ['k_a', 'k_b']; KEYS_E[0] = 'z'; const r = KEYS_E.map(readSystemConfig);"), null, ['F-const-array']],
        ["d' 数组 length 赋值", withExtra('server.js', "const KEYS_L = ['k_a', 'k_b']; KEYS_L.length = 0; const r = KEYS_L.map(readSystemConfig);"), null, ['F-const-array']],
        ["d' 数组用别的回调 map", withExtra('server.js', "const KEYS_O = ['k_a', 'k_b']; const r = KEYS_O.map(readSystemConfig); const r2 = KEYS_O.map((k) => k);"), null, ['F-const-array']],
        ["d' 开关关闭后，const 字面量数组 .map 判红", withExtra('server.js', "const KEYS_D = ['k_a', 'k_b']; const r = Promise.all(KEYS_D.map(readSystemConfig));"), OFF, ['F-form']],
        ["d' 开关关闭后，全字面量数组 .map（形态 d）仍判绿", withExtra('routes/x.js', "const r = ['k_a', 'k_b'].map(readSystemConfig);"), OFF, []],

        // ---------- 判红：T2 ----------
        ['SELECT system_configs 出现在别处', withExtra('routes/y.js', "const q = 'SELECT config_key FROM system_configs';"), null, ['F-sql']],
        ['小写 select 也判红', withExtra('routes/y.js', "const q = 'select config_key from system_configs';"), null, ['F-sql']],
        ['模板字面量带非常量插值的 SELECT system_configs（折叠不了）', withExtra('routes/y.js', 'const q = `SELECT config_key FROM system_configs WHERE config_key = ${1}`;'), null, ['F-sql']],
        ["字符串拼接绕开：'SELECT * FROM sys' + 'tem_configs'", withExtra('routes/y.js', "const q = 'SELECT * FROM sys' + 'tem_configs';"), null, ['F-sql']],
        ["模板插值字面量：`SELECT … FROM ${'system_configs'} …`", withExtra('routes/y.js', "const q = `SELECT config_key FROM ${'system_configs'} WHERE 1`;"), null, ['F-sql']],
        ["表名常量拼接：const TABLE = 'system_configs'; 'SELECT … FROM ' + TABLE", withExtra('routes/y.js', "const TABLE = 'system_configs'; const q = 'SELECT * FROM ' + TABLE;"), null, ['F-sql']],
        ['表名常量放进模板插值', withExtra('routes/y.js', "const TBL3 = 'system_configs'; const q = `SELECT * FROM ${TBL3}`;"), null, ['F-sql']],
        ['单独的表名常量', withExtra('routes/y.js', "const ONLY_TABLE = 'system_configs';"), null, ['F-sql']],
        ['借 sqlite_master 夹带读取', withExtra('routes/y.js', "const q = 'SELECT * FROM system_configs WHERE config_key IN (SELECT name FROM sqlite_master)';"), null, ['F-sql']],
        ['server.js 里 readSystemConfig 函数体之外的 SELECT', withExtra('server.js', "const q2 = 'SELECT config_value_encrypted FROM system_configs';"), null, ['F-sql']],
        ['routes 里伪装成 readSystemConfig 函数体（只认 server.js 顶层）', withExtra('routes/y.js', "function readSystemConfigLike() { return 'SELECT config_key FROM system_configs'; }"), null, ['F-sql', 'F-form']],
        ['readSystemConfig 函数体内有第二条不同的 SELECT system_configs', { 'server.js': SERVER_BASE.replace("[key], () => resolve(null)); });", "[key], () => resolve(null)); db.all('SELECT * FROM system_configs', []); });"), 'routes/x.js': ROUTE_BASE }, null, ['F-sql']],
        ['已登记站点、登记的 INSERT 被改成 INSERT … SELECT → 指纹不符判红（N6）', withExtra('routes/y.js', "const q = 'INSERT INTO system_configs (config_key) SELECT config_key FROM other';"), null, ['F-sql'], [site('routes/y.js', 'const q', 'INSERT INTO system_configs (config_key) VALUES (?)')]],
        ['已登记站点、登记的 UPDATE 加上 RETURNING → 指纹不符判红（N6）', withExtra('routes/y.js', "const q = 'UPDATE system_configs SET config_value_encrypted = ? WHERE rowid = ? RETURNING config_value_encrypted';"), null, ['F-sql'], [site('routes/y.js', 'const q', 'UPDATE system_configs SET config_value_encrypted = ? WHERE rowid = ?')]],
        ['已登记站点、登记的 INSERT 被换成 REPLACE INTO → 指纹不符判红', withExtra('routes/y.js', "const q = 'REPLACE INTO system_configs (config_key) VALUES (?)';"), null, ['F-sql'], [site('routes/y.js', 'const q', 'INSERT INTO system_configs (config_key) VALUES (?)')]],
        ['已登记站点、登记的写入语句被改成带非常量插值（折叠不了，指纹变成源码原文）→ 指纹不符判红', withExtra('routes/y.js', 'function w(x) { return `INSERT INTO system_configs (${x}) VALUES (?)`; }'), null, ['F-sql'], [site('routes/y.js', 'function w', 'INSERT INTO system_configs (config_key) VALUES (?)')]],
        ['站点未登记：提示文字放在对象属性里 → 判红（新增 system_configs 出现点须经审查）', withExtra('routes/y.js', "const o = { reason: '缺失 system_configs.x 为空' };"), null, ['F-sql']],
        ['站点未登记：提示文字赋给变量再传给 logger → 判红', withExtra('routes/y.js', "const msg = 'system_configs 不存在'; logger.warn(msg);"), null, ['F-sql']],
        ['标识符名里含 system_configs', withExtra('routes/y.js', 'const system_configs_cache = 1;'), null, ['F-sql']],
        ['T2 出现在正则字面量里（显式判红）', withExtra('routes/y.js', 'const re2 = /system_configs/;'), null, ['F-regex']],
        ["转义拼写绕开：'system_c\\u006fnfigs'（解码值含记号、原文不含）", withExtra('routes/y.js', "const z = 'system_c\\u006fnfigs';"), null, ['F-escaped', 'F-sql']],
        ['转义拼写绕开 T1：deps[\'readSyst\\u0065mConfig\']', withExtra('routes/y.js', "function g(deps) { return deps['readSyst\\u0065mConfig']('k_a'); }"), null, ['F-escaped', 'F-form']],
        ['N4：转义拼写 + 正则 .source 抵消（旧的“总数相等”核算会漏：字符串解码值 +1、正则文本 +1 互相抵消）→ 按位置核算，两处都判红', withExtra('routes/y.js', "const z4 = 'system_c\\u006fnfigs'; const re4 = /system_configs/; void re4.source;"), null, ['F-escaped', 'F-regex', 'F-sql']],
        ['N4 变体：T1 版——转义的 deps 成员名 + 正则字面量', withExtra('routes/y.js', "function g(deps) { return deps['readSyst\\u0065mConfig']('k_a'); } const re5 = /readSystemConfig/;"), null, ['F-escaped', 'F-form', 'F-regex']],
        ['String.raw 标签模板里的转义：String.raw`system_c\\u006fnfigs`（cooked 含记号、raw 不含）', withExtra('routes/y.js', 'const z6 = String.raw`system_c\\u006fnfigs`;'), null, ['F-escaped', 'F-sql']],
        ['转义的标识符名含 T2：const system_c\\u006fnfigs_x = 1', withExtra('routes/y.js', 'const system_c\\u006fnfigs_x = 1;'), null, ['F-escaped', 'F-sql']],

        // ---------- 判红：白名单自检 / 语法 ----------
        ['白名单与钉钉四键相交', base(), { whitelistKeys: ['k_a', 'k_b'], dingtalkKeys: ['k_b'] }, ['F-wl']],
        ['白名单键名像凭证（…_secret）', withExtra('routes/x.js', "function g() { return readSystemConfig('x_secret'); }"), { whitelistKeys: ['k_a', 'x_secret'], dingtalkKeys: ['k_b'] }, ['F-wl']],
        ['白名单键名像凭证（…token / app_key / robot_code / password）', withExtra('routes/x.js', "function g() { readSystemConfig('my_token'); readSystemConfig('app_key_x'); readSystemConfig('RobotCode'); return readSystemConfig('db_password'); }"), { whitelistKeys: ['k_a', 'my_token', 'app_key_x', 'RobotCode', 'db_password'], dingtalkKeys: ['k_b'] }, ['F-wl']],
        ['语法错误的文件', withExtra('routes/x.js', 'function ((('), null, ['F-parse', 'F-keys-missing']],

        // ---------- 判红：d' 收紧（引用数必须恰好 1）与站点清单 ----------
        ["d' 数组多一处只读引用（KEYS.includes）", withExtra('server.js', "const KEYS_I = ['k_a', 'k_b']; const r = KEYS_I.map(readSystemConfig); KEYS_I.includes('k_a');"), null, ['F-const-array']],
        ["d' 数组多一处 for…of 引用", withExtra('server.js', "const KEYS_W = ['k_a', 'k_b']; const r = KEYS_W.map(readSystemConfig); for (const k of KEYS_W) { void k; }"), null, ['F-const-array']],
        ["d' 数组同一个数组 map 两次（引用 2 处）", withExtra('server.js', "const KEYS_T = ['k_a', 'k_b']; const r = KEYS_T.map(readSystemConfig); const r2 = KEYS_T.map(readSystemConfig);"), null, ['F-const-array']],
        ['站点指纹：已登记站点与代码逐项一致（两条语句，登记顺序与代码顺序相反）→ 判绿', withExtra('routes/x.js', "function w() { const a = 'INSERT INTO system_configs (a) VALUES (1)'; const b = 'DELETE FROM system_configs'; }"), null, [], [site('routes/x.js', 'function w', 'DELETE FROM system_configs', 'INSERT INTO system_configs (a) VALUES (1)')]],
        ['站点指纹：次数不符——代码里 2 处，清单登记 1 处', withExtra('routes/x.js', "function w() { const a = 'INSERT INTO system_configs (a) VALUES (1)'; const b = 'DELETE FROM system_configs'; }"), null, ['F-sql'], [site('routes/x.js', 'function w', 'INSERT INTO system_configs (a) VALUES (1)')]],
        ['站点指纹：次数不符——代码里 1 处，清单登记 2 处', withExtra('routes/x.js', "function w() { const a = 'INSERT INTO system_configs (a) VALUES (1)'; }"), null, ['F-sql'], [site('routes/x.js', 'function w', 'INSERT INTO system_configs (a) VALUES (1)', 'DELETE FROM system_configs')]],
        ['N5：站点内删一处、加一处（数量不变，旧的“次数”核算会漏）→ 指纹多重集不符判红', withExtra('routes/x.js', "function w() { const a = 'INSERT INTO system_configs (a) VALUES (1)'; const c = 'DELETE FROM system_configs WHERE 1'; }"), null, ['F-sql'], [site('routes/x.js', 'function w', 'INSERT INTO system_configs (a) VALUES (1)', 'DELETE FROM system_configs')]],
        ['N5 变体：站点内同一条语句被复制成两条、另一条被删（总数不变）→ 判红', withExtra('routes/x.js', "function w() { const a = 'INSERT INTO system_configs (a) VALUES (1)'; const b = 'INSERT INTO system_configs (a) VALUES (1)'; }"), null, ['F-sql'], [site('routes/x.js', 'function w', 'INSERT INTO system_configs (a) VALUES (1)', 'DELETE FROM system_configs')]],
        ['站点清单：清单里有而代码里已没有的站点', base(), null, ['F-sql'], [site('routes/zz.js', 'function nope', 'DELETE FROM system_configs')]],
        ['站点清单：站点已登记，但值恰好是 system_configs 的表名常量仍判红', withExtra('routes/x.js', "const ONLY = 'system_configs';"), null, ['F-sql'], [site('routes/x.js', 'const ONLY', 'system_configs')]],
        ['站点清单：站点已登记也挡不住 readSystemConfig 函数体内的第二条 SELECT', { 'server.js': SERVER_BASE.replace("[key], () => resolve(null)); });", "[key], () => resolve(null)); db.all('SELECT * FROM system_configs', []); });"), 'routes/x.js': ROUTE_BASE }, null, ['F-sql'], [site('server.js', 'function readSystemConfig', READ_FP, 'SELECT * FROM system_configs')]],
        ['Opus 预筛 P8：可选调用 readSystemConfig?.(新键)', withExtra('routes/x.js', "function g() { return readSystemConfig?.('new_key'); }"), null, ['F-keys-extra']],
        ['Opus 预筛 P9：deps?.readSystemConfig(新键)', withExtra('routes/x.js', "function g(deps) { return deps?.readSystemConfig('new_key'); }"), null, ['F-keys-extra']],
        ['Opus 预筛 P12：序列表达式 (0, readSystemConfig)(…)', withExtra('routes/x.js', "function g() { return (0, readSystemConfig)('k_a'); }"), null, ['F-form']],
        ['Opus 预筛 P13：String.raw 标签模板里的 SELECT system_configs', withExtra('routes/x.js', "function g(db) { return db.get(String.raw`SELECT config_value_encrypted FROM system_configs WHERE config_key = 'new_key'`); }"), null, ['F-sql']],
        ['Opus 预筛 P14：数组 join 拼 SQL', withExtra('routes/x.js', "function g(db) { return db.get(['SELECT config_value_encrypted', 'FROM system_configs'].join(' ')); }"), null, ['F-sql']],
        ['Opus 预筛 P15：拼接中间夹非字面量', withExtra('routes/x.js', "function g(db, c) { return db.get('SELECT ' + c + ' FROM system_configs'); }"), null, ['F-sql']],
        ['Opus 预筛 P16：const 别名当键', withExtra('routes/x.js', "const KEY_Z = 'new_key'; const alias = KEY_Z; function g() { return readSystemConfig(alias); }"), null, ['F-call-arg']],
        ['站点清单：折叠后才出现记号的拼接，未登记即红', withExtra('routes/y.js', "const sp = 'system_' + 'configs x';"), null, ['F-sql']],
        ['站点清单：折叠后才出现记号的拼接（经 const 片段），未登记即红', withExtra('routes/y.js', "const P1 = 'system_'; const P2 = 'configs'; const sq = P1 + P2;"), null, ['F-sql']],
    ];
    for (const [name, files, cfgOverride, expectRules, extraSites] of T) {
        let got;
        try { got = rules(files, cfgOverride, extraSites); } catch (e) { got = [`EXC:${e.message}`]; }
        must(JSON.stringify(got) === JSON.stringify(expectRules.slice().sort()), `${expectRules.length ? '判红' : '判绿'}：${name}`, `期望 ${JSON.stringify(expectRules.slice().sort())} 实得 ${JSON.stringify(got)}`);
    }
}

function printCensus(census, counts, fingerprints) {
    console.log(`  去注释后的文本匹配位置：T1 ${counts.t1.text} 处、T2 ${counts.t2.text} 处；其中落在已归类节点内的：T1 ${counts.t1.covered} 处、T2 ${counts.t2.covered} 处`);
    for (const tok of ['T1', 'T2']) {
        console.log(`  -- ${tok} (${tok === 'T1' ? T1 : T2}) 归类 --`);
        for (const [cat, list] of Object.entries(census[tok])) console.log(`     ${cat} ×${list.length}：${list.join(' ')}`);
    }
    console.log('  -- T2 站点内容指纹表（不含 utils/instance-db.js 整文件豁免）--');
    for (const f of fingerprints) console.log(`     ${f.file}:${f.line} [${f.site}] ${f.folded ? '折叠' : '原文'} :: ${f.fp}`);
}

function main() {
    console.log(`被测源码根目录：${ROOT}${ROOT === SELF_ROOT ? '' : '（变异副本）'}`);
    console.log('\n== 1 真实源码扫描（记号闭集核算）==');
    const instanceDb = require(path.join(ROOT, 'utils/instance-db.js'));
    const whitelistKeys = Object.keys(instanceDb.ISOLATED_CONFIG_WHITELIST);
    const dingtalkKeys = Object.keys(instanceDb.VIRTUAL_DINGTALK_CONFIG);
    must(whitelistKeys.length > 0 && dingtalkKeys.length === 4, `白名单 ${whitelistKeys.length} 键 + 钉钉 ${dingtalkKeys.length} 键（均从 utils/instance-db.js 的导出读取）`, JSON.stringify({ whitelistKeys, dingtalkKeys }));
    const files = loadRealFiles(ROOT);
    const res = evaluate(files, { whitelistKeys, dingtalkKeys });
    console.log(`  扫描文件 ${Object.keys(files).length} 个；读取点 ${res.reads.length} 处；读取键 ${new Set(res.reads.map((r) => r.key)).size} 个`);
    printCensus(res.census, res.counts, res.fingerprints);
    must(res.counts.t1.text > 0 && res.defs === 1, `扫描非空：T1 文本出现 > 0，server.js 顶层定义恰好 1 处`, `t1=${res.counts.t1.text} defs=${res.defs}`);
    if (res.problems.length) {
        for (const p of res.problems) bad(`[${p.rule}] ${p.file}${p.line ? ':' + p.line : ''} ${p.msg}`);
    } else {
        ok(`T1 的每处出现都落在允许形态内；T2 的每处出现都在手写站点清单内且内容指纹多重集一致（${T2_SITES.length} 个站点）；两个记号的每个文本匹配位置都落在已归类节点内（无 F-unaccounted / F-escaped / F-regex）；读取键集合 = 白名单 ∪ 钉钉四键；readSystemConfig 函数体内恰好 1 条 SELECT`);
    }
    if (res.extra.length) console.log(`  多出的键：${res.extra.join(', ')}`);
    if (res.missing.length) console.log(`  缺少的键：${res.missing.join(', ')}`);

    selfTest();

    console.log(`\nverify-instance-config-keys PASS=${pass} FAIL=${fail}`);
    process.exit(fail ? 1 : 0);
}

main();
