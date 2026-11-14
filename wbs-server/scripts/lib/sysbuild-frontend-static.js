'use strict';
// Browser DOM regression guard: catches direct executable HTML sinks in this module.
// It does not perform taint analysis, prove shared app.js safe, or cover deliberately hidden/reflected calls.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const crypto = require('crypto');
const SHARED = new Set(['assets/js/app.js', 'assets/js/unify-helpers.js', 'assets/js/u-paste.js']);
// 唯一受控srcdoc出口：固定端点鉴权取确认单，A.id校验，复核页面代次，sandbox不含allow-scripts。
// 对整段AST做显式固定散列；业务改动须重新核对安全条件、更新正反例与浏览器探针，不能按函数名直接放行。
const SHEET_FILE = 'assets/js/sysbuild-evidence.js';
const SHEET_AST_HASH = '7214c2d2a388294e8f305e30a79389e37fcb69e5f2195369891cd5d67a016449';
function canonical(node) {
    if (Array.isArray(node)) return node.map(canonical);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'loc', 'raw'].includes(key)).map(([key, value]) => [key, canonical(value)]));
}
function sheetFunctions(ast) {
    const found = [];
    function visit(n) {
        if (!n || typeof n !== 'object') return;
        if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'confirmationSheetFrame') found.push(n);
        for (const [key, value] of Object.entries(n)) {
            if (['loc', 'start', 'end'].includes(key)) continue;
            if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
        }
    }
    visit(ast); return found;
}
function literalKey(node) {
    if (node.type === 'Literal') return node.value;
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
    return null;
}
function prop(node) {
    if (!node || node.type !== 'MemberExpression') return null;
    return node.computed ? literalKey(node.property) : node.property.name;
}
function analyzeText(text, file) {
    const source = text.replace(/\r\n/g, '\n');
    const findings = [];
    let ast;
    try { ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); }
    catch (e) { return [{ rule: 'S10', file, line: e.loc && e.loc.line || 0, msg: '前端脚本无法解析：' + e.message }]; }
    const candidates = sheetFunctions(ast);
    const trusted = file === SHEET_FILE && candidates.length === 1 && crypto.createHash('sha256').update(JSON.stringify(canonical(candidates[0]))).digest('hex') === SHEET_AST_HASH ? candidates[0] : null;
    function add(n, message) { findings.push({ rule: 'S10', file, line: n.loc.start.line, msg: message }); }
    function checkWrite(n, target) {
        if (!target) return;
        if (target.type === 'MemberExpression' && target.computed && prop(target) === null) add(n, '禁止非字面量计算属性写入');
        if (target.type === 'ObjectPattern') target.properties.forEach((p) => checkWrite(n, p.type === 'RestElement' ? p.argument : p.value));
        if (target.type === 'ArrayPattern') target.elements.forEach((item) => checkWrite(n, item));
        if (target.type === 'RestElement') checkWrite(n, target.argument);
        if (target.type === 'AssignmentPattern') checkWrite(n, target.left);
    }
    function walk(n, inSheet) {
        if (!n || typeof n !== 'object') return;
        const trustedSheet = inSheet === true || n === trusted;
        if (['AssignmentExpression', 'UpdateExpression'].includes(n.type)) {
            checkWrite(n, n.type === 'AssignmentExpression' ? n.left : n.argument);
        }
        if (['ForInStatement', 'ForOfStatement'].includes(n.type)) checkWrite(n, n.left);
        if (n.type === 'UnaryExpression' && n.operator === 'delete') checkWrite(n, n.argument);
        if (n.type === 'Property' && n.computed && literalKey(n.key) === null) add(n, '禁止非字面量计算属性定义');
        if (n.type === 'AssignmentExpression' && ['innerHTML', 'outerHTML'].includes(prop(n.left))) add(n, '本模块不直接写 HTML，使用 textContent / DOM');
        if (n.type === 'AssignmentExpression' && prop(n.left) === 'srcdoc' && !trustedSheet) add(n, 'srcdoc仅允许固定鉴权确认单与无脚本sandbox的受控函数');
        if (n.type === 'AssignmentExpression' && (prop(n.left) === 'sandbox' || prop(n.left && n.left.object) === 'sandbox')) add(n, '不得改写iframe sandbox');
        if (n.type === 'AssignmentExpression' && typeof prop(n.left) === 'string' && /^on/i.test(prop(n.left))) add(n, '事件使用 addEventListener，不写 on* 属性');
        if (n.type === 'CallExpression') {
            const p = prop(n.callee);
            if (['insertAdjacentHTML', 'createContextualFragment', 'parseFromString'].includes(p)) add(n, '禁止可执行 HTML 解析 / 注入调用');
            if (['write', 'writeln'].includes(p)) add(n, '禁止任何对象的 write / writeln');
            const forwarded = ['call', 'apply'].includes(p) ? prop(n.callee.object) : null;
            if (['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'createContextualFragment', 'parseFromString', 'write', 'writeln', 'setAttribute'].includes(forwarded)) add(n, '禁止转调 HTML 注入方法');
            if (p === 'setAttribute') {
                const a = n.arguments[0];
                if (!a || a.type !== 'Literal' || typeof a.value !== 'string' || /^on/i.test(a.value) || a.value.toLowerCase() === 'srcdoc') add(n, 'setAttribute 只用明确的非事件属性，srcdoc 须受控');
                if (a && a.type === 'Literal' && String(a.value).toLowerCase() === 'sandbox' && !trustedSheet) add(n, 'sandbox只允许受控确认单函数设置');
            }
            if (['removeAttribute', 'toggleAttribute'].includes(p)) {
                const a = n.arguments[0];
                if (!a || a.type !== 'Literal' || typeof a.value !== 'string' || a.value.toLowerCase() === 'sandbox') add(n, '不得移除或动态切换iframe sandbox');
            }
            if (prop(n.callee.object) === 'sandbox') add(n, '不得经token列表修改iframe sandbox');
            if (p === 'createElement' && n.arguments[0] && n.arguments[0].type === 'Literal' && String(n.arguments[0].value).toLowerCase() === 'script') add(n, '禁止动态加载脚本');
            if ((n.callee.type === 'Identifier' && ['eval', 'Function'].includes(n.callee.name)) || ['eval', 'Function'].includes(p) || ['eval', 'Function'].includes(forwarded)) add(n, '禁止动态执行代码');
            const timer = n.callee.type === 'Identifier' ? n.callee.name : p;
            const callback = ['call', 'apply'].includes(p) ? n.arguments[1] : n.arguments[0];
            if ((['setTimeout', 'setInterval'].includes(timer) || ['setTimeout', 'setInterval'].includes(forwarded)) && callback && ['Literal', 'TemplateLiteral', 'BinaryExpression', 'ArrayExpression'].includes(callback.type)) add(n, '计时器回调不能是字符串');
        }
        if (n.type === 'NewExpression') {
            const name = n.callee.type === 'Identifier' ? n.callee.name : prop(n.callee);
            if (name === 'Function') add(n, '禁止动态执行代码');
            if (name === 'Blob' && n.arguments[1]) {
                const opts = n.arguments[1];
                const types = opts.type === 'ObjectExpression' ? opts.properties.filter((p) => p.type === 'Property' && !p.computed && (p.key.name || p.key.value) === 'type') : [];
                if (opts.type !== 'ObjectExpression' || opts.properties.some((p) => p.type === 'SpreadElement' || p.computed) || types.some((type) => type.value.type !== 'Literal' || typeof type.value.value !== 'string' || /(?:text\/html|application\/xhtml\+xml)/i.test(type.value.value))) add(n, '禁止 HTML 类型或不明确类型的 Blob');
            }
        }
        for (const [key, value] of Object.entries(n)) {
            if (key === 'loc' || key === 'start' || key === 'end') continue;
            if (Array.isArray(value)) value.forEach((item) => walk(item, trustedSheet));
            else if (value && typeof value === 'object') walk(value, trustedSheet);
        }
    }
    walk(ast);
    return findings;
}
function scan(publicDir) {
    const findings = [];
    const add = (file, message) => findings.push({ rule: 'S10', file, line: 0, msg: message });
    const page = path.join(publicDir, 'Sys_Build.html');
    let html;
    try {
        if (fs.lstatSync(page).isSymbolicLink()) throw new Error('页面不能是联接 / 符号链接');
        html = fs.readFileSync(page, 'utf8').replace(/\r\n/g, '\n');
    } catch (e) { add('Sys_Build.html', '无法读取项目管理页面：' + e.message); return { findings, files: [] }; }
    if (/\son[a-z]+\s*=/i.test(html)) add('Sys_Build.html', '页面不得有内联事件属性');
    const declared = new Set();
    let inlineNo = 0;
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const src = /\bsrc\s*=\s*(['"])(.*?)\1/i.exec(m[1]);
        if (!src) { inlineNo += 1; findings.push(...analyzeText(m[2], 'Sys_Build.html#inline-' + inlineNo)); continue; }
        const raw = src[2];
        const file = raw.split('?')[0].replace(/^\.\//, '');
        if (SHARED.has(file)) continue;
        if (!/^assets\/js\/sysbuild-[a-z0-9-]+\.js$/.test(file)) { add('Sys_Build.html', '未登记的脚本引用：' + raw); continue; }
        if (declared.has(file)) add('Sys_Build.html', '重复加载本模块脚本：' + file);
        declared.add(file);
    }
    if (declared.size === 0) add('Sys_Build.html', '没有加载本模块脚本');
    const scripts = path.join(publicDir, 'assets', 'js');
    const files = [];
    try {
        for (const entry of fs.readdirSync(scripts, { withFileTypes: true })) {
            if (!/^sysbuild-.*\.js$/.test(entry.name)) continue;
            const rel = 'assets/js/' + entry.name;
            const absolute = path.join(scripts, entry.name);
            if (!entry.isFile() || fs.lstatSync(absolute).isSymbolicLink()) { add(rel, '本模块脚本必须是普通文件'); continue; }
            files.push(rel);
            if (!declared.has(rel)) add(rel, '本模块脚本未由页面加载');
            findings.push(...analyzeText(fs.readFileSync(absolute, 'utf8'), rel));
        }
    } catch (e) { add('assets/js', '无法枚举本模块脚本：' + e.message); }
    for (const file of declared) if (!files.includes(file)) add(file, '页面引用的本模块脚本不存在');
    return { findings, files };
}
function selfTest(sheetSource) {
    const fixtures = [
        ['textContent / DOM 正例', 'const n = document.createElement("p"); n.textContent = user; n.replaceChildren(document.createTextNode(user)); n.addEventListener("click", handler);', false],
        ['注释与普通字符串正例', '// x.innerHTML = user\nconst hint = "不要使用 innerHTML";', false],
        ['innerHTML', 'n.innerHTML = user;', true],
        ['计算属性 innerHTML', 'n["innerHTML"] = user;', true],
        ['outerHTML', 'n.outerHTML = user;', true],
        ['insertAdjacentHTML', 'n.insertAdjacentHTML("beforeend", user);', true],
        ['document.write', 'document.write(user);', true],
        ['iframe document.write', 'frame.contentDocument.write(user);', true],
        ['打印窗口 document.write', 'w.document.write(user);', true],
        ['任意对象 writeln', 'output.writeln(user);', true],
        ['普通 DOM append 正例', 'output.append(document.createTextNode(user));', false],
        ['模板字面量属性', 'n[`innerHTML`] = user;', true],
        ['模板普通属性正例', 'n[`textContent`] = user;', false],
        ['动态计算属性写入', 'n[key] = user;', true],
        ['模板动态计算属性写入', 'n[`prefix${key}`] = user;', true],
        ['动态计算属性递增', 'n[key]++;', true],
        ['解构计算属性写入', '({ value: n[key] } = payload);', true],
        ['循环计算属性写入', 'for (n[key] of values) {}', true],
        ['对象动态计算属性定义', 'const n = { [key]: user };', true],
        ['对象固定计算属性正例', 'const n = { ["textContent"]: user };', false],
        ['动态计算属性只读正例', 'const value = n[key];', false],
        ['insertAdjacentHTML.call', 'n.insertAdjacentHTML.call(n, "beforeend", user);', true],
        ['document.write.apply', 'w.document.write.apply(w.document, [user]);', true],
        ['普通回调 call 正例', 'handler.call(n, event);', false],
        ['HTML Blob iframe src', 'frame.src = URL.createObjectURL(new Blob([user], { type: "text/html" }));', true],
        ['XHTML Blob', 'new window.Blob([user], { type: "application/xhtml+xml;charset=utf-8" });', true],
        ['动态 Blob 类型', 'new Blob([user], { type: mime });', true],
        ['后项 HTML Blob 类型', 'new Blob([user], { type: "text/plain", type: "text/html" });', true],
        ['普通图片 Blob 正例', 'new Blob([bytes], { type: "image/png" });', false],
        ['普通文本 Blob 正例', 'new Blob([user], { type: "text/plain" });', false],
        ['contextual fragment', 'range.createContextualFragment(user);', true],
        ['DOMParser', 'parser.parseFromString(user, "text/html");', true],
        ['srcdoc', 'frame.srcdoc = user;', true],
        ['事件属性', 'n.onclick = handler;', true],
        ['setAttribute 事件', 'n.setAttribute("onerror", user);', true],
        ['setAttribute srcdoc', 'n.setAttribute("srcdoc", user);', true],
        ['setAttribute 动态属性名', 'n.setAttribute(name, user);', true],
        ['setAttribute 固定属性正例', 'n.setAttribute("aria-label", user);', false],
        ['动态脚本', 'document.createElement("script");', true],
        ['eval', 'eval(user);', true],
        ['成员 eval', 'window.eval(user);', true],
        ['成员 Function', 'window.Function(user);', true],
        ['成员 Function 构造', 'new window.Function(user);', true],
        ['eval.call', 'window.eval.call(window, user);', true],
        ['普通成员函数正例', 'window.render(user);', false],
        ['Function', 'new Function(user);', true],
        ['计时器字符串', 'setTimeout("doWork()", 1);', true],
        ['成员计时器字符串', 'window.setTimeout("doWork()", 1);', true],
        ['成员间隔字符串', 'window.setInterval(`doWork()`, 1);', true],
        ['拼接字符串计时器', 'window.setTimeout("do" + code, 1);', true],
        ['成员计时器函数正例', 'window.setTimeout(() => doWork(), 1);', false],
        ['成员间隔函数正例', 'window.setInterval(handler, 1);', false],
        ['计时器函数正例', 'setTimeout(() => doWork(), 1);', false],
        ['移除sandbox', 'frame.removeAttribute("sandbox");', true],
        ['动态移除属性', 'frame.removeAttribute(name);', true],
        ['切换sandbox', 'frame.toggleAttribute("sandbox", false);', true],
        ['sandbox token', 'frame.sandbox.add("allow-scripts");', true],
        ['sandbox属性', 'frame.sandbox = "allow-scripts";', true],
        ['sandbox.value', 'frame.sandbox.value = "allow-scripts";', true],
    ];
    const results = fixtures.map(([name, source, red]) => ({ name, ok: (analyzeText(source, 'fixture.js').length > 0) === red }));
    const sheet = sheetSource === undefined ? fs.readFileSync(path.resolve(__dirname, '../../public/assets/js/sysbuild-evidence.js'), 'utf8') : sheetSource;
    const parsed = acorn.parse(sheet, { ecmaVersion: 'latest', sourceType: 'script' });
    const functions = sheetFunctions(parsed);
    const approved = functions.length === 1 ? sheet.slice(functions[0].start, functions[0].end) : '';
    const checks = [
        ['受控确认单整段AST正例', approved, SHEET_FILE, false],
        ['受控确认单换文件不得放行', approved, 'fixture.js', true],
        ['确认单sandbox加脚本', approved.replace('allow-same-origin allow-modals', 'allow-same-origin allow-modals allow-scripts'), SHEET_FILE, true],
        ['确认单换任意端点', approved.replace('/confirmation-sheet', '/arbitrary-html'), SHEET_FILE, true],
        ['确认单删复核代次', approved.replace('A.assertCurrent(c);', 'void c;'), SHEET_FILE, true],
        ['同文件第二个srcdoc出口', approved + '\nother.srcdoc = user;', SHEET_FILE, true],
        ['同名函数重复', approved + '\n' + approved, SHEET_FILE, true],
        ['函数外改sandbox', approved + '\nother.setAttribute("sandbox", "allow-scripts");', SHEET_FILE, true],
    ];
    checks.forEach(([name, source, file, red]) => results.push({ name, ok: !!approved && (analyzeText(source, file).length > 0) === red }));
    return { results, ok: results.every((x) => x.ok) };
}
module.exports = { analyzeText, scan, selfTest };
