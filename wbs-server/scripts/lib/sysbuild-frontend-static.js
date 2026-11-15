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

// ── S11：项目管理页的平台导航 = 标准导航 + 「项目管理」一项 ─────────────────────────────────────
// Sys_Build.html 的导航是手抄的共享导航栏；以 Legacy_Archive.html 的导航为参照（参照写法同 verify-it-ledger-panel-static.js：整块对标准页去空白后全等）。
// 对项目管理页的导航切片做且只做三项归一后与参照页去空白全等：① 去掉 <nav> 起始标签上的 aria-label="平台导航"；
// ② LOGO 渐变 id 换成参照页的 id（url(#…) 与 <linearGradient id> 两处）；③ 摘掉「项目管理」这一个 <a> 元素。
// 被摘掉的元素另行断言：整个切片恰好 1 个、紧跟在「系统迭代」链接之后、起始标签与约定写法逐字全等（含 class / aria-current / 选中样式，不许多出 target / hidden 等属性）、
// 恰好 1 个 svg 且带 aria-hidden="true"、去掉 aria-hidden 后与 app.js 里 SVG_ICONS.clipboard 的字面量逐字相同、文字为「项目管理」；
// 以上都通过后，入口整段（去空白）还须与「约定起始标签 + 带 aria-hidden 的图标 + 文字 + </a>」全等（入口里多出别的元素只有这一条能抓到）。
// 另查 assets/css/sysbuild.css：去掉注释后不得出现平台导航的类选择器（.navbar / .nav-item 等），防止本模块样式覆盖共享顶栏。
// 威胁模型：防手抄导航悄悄漂移（漏项 / 错序 / 改字 / 改图标 / 用平台导航类名做的样式覆盖），不防刻意绕过（动态改导航由浏览器用例看）。
const NAV_PAGE = 'Sys_Build.html';
const NAV_REF = 'Legacy_Archive.html';
const NAV_LOGO_ID = 'logo-gradient-sb';
const NAV_ENTRY_LABEL = '项目管理';
const NAV_ENTRY_STYLE = 'style="color:#d97706; font-weight:600;"';
const NAV_ENTRY_OPEN = '<a href="/Sys_Build.html" class="nav-item active" aria-current="page" ' + NAV_ENTRY_STYLE + '>';
const NAV_CSS = 'assets/css/sysbuild.css';
const NAV_APP_JS = 'assets/js/app.js';
// 平台顶栏的类名；sysbuild.css 里出现这些类选择器就会（按特异性）覆盖共享顶栏。按「点号开头的完整类名」匹配，.sbui-nav / .sbui-nav-item 之类本模块类名不会命中。
const NAV_CSS_CLASSES = ['navbar', 'nav-item', 'nav-right', 'nav-left', 'nav-title', 'nav-logo', 'nav-divider', 'nav-dropdown(?:-[A-Za-z0-9_-]+)?', 'fixed-header'];
const NAV_CSS_RE = new RegExp('\\.(' + NAV_CSS_CLASSES.join('|') + ')(?![A-Za-z0-9_-])');
// 去空白归一会把文字与属性值内部的空白也去掉（例如「数仓 任务池」与「数仓任务池」判为相同），
// 与 verify-it-ledger-panel-static.js:20 的既有做法一致，属已知取舍。
const navSquash = (t) => t.replace(/\s+/g, '');
const navCount = (text, part) => text.split(part).length - 1;
function navSlice(html) {
    const m = /<nav class="navbar fixed-header"[^>]*>[\s\S]*?<\/nav>/.exec(html);
    return m ? m[0] : null;
}
function navAnchors(slice, href) {
    const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...slice.matchAll(new RegExp('<a href="' + escaped + '"[^>]*>[\\s\\S]*?<\\/a>', 'g'))].map((m) => ({ start: m.index, end: m.index + m[0].length, text: m[0] }));
}
// 从 app.js 源码里取 SVG_ICONS.clipboard 的字符串字面量（先 CRLF→LF）；取不到返回 null。
function clipboardIcon(appJs) {
    const m = /^\s*clipboard:\s*'([^'\n]*)'/m.exec(appJs.replace(/\r\n/g, '\n'));
    return m ? m[1] : null;
}
// 去掉 /* … */ 注释（保留换行，行号不变）后，逐行找平台导航类选择器；返回 [{ line, text, cls }]（每行只报第一个命中的类名）。
// 已知限制：
//   ① 值里出现同名文本会误报（如 url(img/a.navbar.png)、content: ".nav-item"），方向是判红，不会放过问题；
//   ② 字符串值里出现 /* 会让后面的规则被当成注释吃掉而漏报，属刻意写法，不防；
//   ③ 本检查是类名黑名单，管不到属性选择器（[class~="nav-item"]）、元素选择器（nav a）、id 选择器（#userProfileArea）以及头像下拉的类名这类写法；
//      把选择器改成「必须以 .sbui- 开头或恰为 body:has(#sysbuildApp)」的白名单硬门是已登记的后续项，本批不做。
function navCssHits(cssText) {
    const css = cssText.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''));
    const hits = [];
    css.split('\n').forEach((text, i) => {
        const m = NAV_CSS_RE.exec(text);
        if (m) hits.push({ line: i + 1, text: text.trim(), cls: '.' + m[1] });
    });
    return hits;
}
function checkNav(pageHtml, refHtml, iconSvg) {
    const probs = [];
    const page = navSlice(pageHtml.replace(/\r\n/g, '\n'));
    const ref = navSlice(refHtml.replace(/\r\n/g, '\n'));
    if (!page) return [NAV_PAGE + ' 没有 <nav class="navbar fixed-header …> 标准导航'];
    if (!ref) return [NAV_REF + ' 没有标准导航，无法作为参照比对'];
    let work = page;
    const openTag = '<nav class="navbar fixed-header" aria-label="平台导航">';
    if (!work.startsWith(openTag)) probs.push('导航起始标签应为 ' + openTag);
    else work = '<nav class="navbar fixed-header">' + work.slice(openTag.length);
    const refLogo = /<linearGradient id="([^"]+)"/.exec(ref);
    const urlFrom = 'url(#' + NAV_LOGO_ID + ')';
    const idFrom = '<linearGradient id="' + NAV_LOGO_ID + '"';
    if (!refLogo) probs.push(NAV_REF + ' 的导航里取不到 LOGO 渐变 id');
    else if (navCount(work, urlFrom) !== 1 || navCount(work, idFrom) !== 1) probs.push('LOGO 渐变 id 应为 ' + NAV_LOGO_ID + '，且 url(#…) 与 <linearGradient id> 各恰好 1 处');
    else work = work.split(urlFrom).join('url(#' + refLogo[1] + ')').split(idFrom).join('<linearGradient id="' + refLogo[1] + '"');
    const entries = navAnchors(work, '/Sys_Build.html');
    if (entries.length !== 1) probs.push('整个导航切片里「' + NAV_ENTRY_LABEL + '」入口（href="/Sys_Build.html"）应恰好 1 个，实得 ' + entries.length);
    else {
        const entry = entries[0];
        const iteration = navAnchors(work, '/Sys_Iteration.html');
        if (iteration.length !== 1) probs.push('整个导航切片里「系统迭代」链接（href="/Sys_Iteration.html"）应恰好 1 个，实得 ' + iteration.length);
        else if (iteration[0].end > entry.start || !/^\s*$/.test(work.slice(iteration[0].end, entry.start))) probs.push('「' + NAV_ENTRY_LABEL + '」入口应紧跟在「系统迭代」链接之后（两者之间只允许空白）');
        const open = /^<a\b[^>]*>/.exec(entry.text)[0];
        const before = probs.length;
        if (!open.includes(' aria-current="page"')) probs.push('「' + NAV_ENTRY_LABEL + '」入口应带 aria-current="page"');
        if (!open.includes(' ' + NAV_ENTRY_STYLE)) probs.push('「' + NAV_ENTRY_LABEL + '」入口应带选中样式 ' + NAV_ENTRY_STYLE);
        // 分项诊断之外再要求起始标签逐字全等：class（含 active）、target、hidden 等其余属性的漂移只有这一条能抓到。
        if (open !== NAV_ENTRY_OPEN && probs.length === before) probs.push('「' + NAV_ENTRY_LABEL + '」入口的起始标签与约定写法不逐字相等：应为 ' + NAV_ENTRY_OPEN + '，实得 ' + open);
        const svgs = entry.text.match(/<svg\b[^>]*>/g) || [];
        if (svgs.length !== 1) probs.push('「' + NAV_ENTRY_LABEL + '」入口内 svg 应恰好 1 个，实得 ' + svgs.length);
        else if (!/\saria-hidden="true"/.test(svgs[0])) probs.push('「' + NAV_ENTRY_LABEL + '」入口的 svg 应带 aria-hidden="true"');
        else if (typeof iconSvg !== 'string') probs.push('取不到 ' + NAV_APP_JS + ' 里 SVG_ICONS.clipboard 的字符串字面量，无法核对入口图标');
        else {
            const svgText = (/<svg\b[\s\S]*?<\/svg>/.exec(entry.text) || [''])[0].replace(' aria-hidden="true"', '');
            if (svgText !== iconSvg) probs.push('「' + NAV_ENTRY_LABEL + '」入口的 svg（去掉 aria-hidden 后）与 app.js 的 SVG_ICONS.clipboard 不逐字相等：页面「' + svgText + '」常量「' + iconSvg + '」');
        }
        const label = entry.text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (label !== NAV_ENTRY_LABEL) probs.push('入口文字应为「' + NAV_ENTRY_LABEL + '」，实得「' + label + '」');
        // 整段全等（去空白）：入口 = 约定起始标签 + 带 aria-hidden 的图标 + 文字 + </a>。上面的分项只看各自的部分，
        // 在 svg 前后或文字后多出的元素（如 <i>、<span class="badge">）只有这一条能抓到。已有分项问题时不重复报。
        if (typeof iconSvg === 'string' && probs.length === before) {
            const expectedEntry = NAV_ENTRY_OPEN + iconSvg.replace('<svg', '<svg aria-hidden="true"') + NAV_ENTRY_LABEL + '</a>';
            if (navSquash(entry.text) !== navSquash(expectedEntry)) probs.push('「' + NAV_ENTRY_LABEL + '」入口整段与约定写法不逐字相等：应为 ' + expectedEntry + '，实得 ' + entry.text);
        }
        work = work.slice(0, entry.start) + work.slice(entry.end);
    }
    const got = navSquash(work);
    const want = navSquash(ref);
    if (got !== want) {
        let i = 0;
        while (i < got.length && i < want.length && got[i] === want[i]) i += 1;
        probs.push('归一并摘掉「' + NAV_ENTRY_LABEL + '」后，导航与 ' + NAV_REF + ' 的导航（去空白）不逐字相等；首个差异在第 ' + i + ' 个字符：页面「' + got.slice(Math.max(0, i - 20), i + 40) + '」参照「' + want.slice(Math.max(0, i - 20), i + 40) + '」');
    }
    return probs;
}
function scanNav(publicDir) {
    const findings = [];
    let page;
    let ref;
    let appJs;
    try {
        page = fs.readFileSync(path.join(publicDir, NAV_PAGE), 'utf8');
        ref = fs.readFileSync(path.join(publicDir, NAV_REF), 'utf8');
        appJs = fs.readFileSync(path.join(publicDir, NAV_APP_JS), 'utf8');
    } catch (e) { findings.push({ rule: 'S11', file: NAV_PAGE, line: 0, msg: '无法读取导航比对所需文件：' + e.message }); }
    if (page !== undefined && ref !== undefined && appJs !== undefined) findings.push(...checkNav(page, ref, clipboardIcon(appJs)).map((msg) => ({ rule: 'S11', file: NAV_PAGE, line: 0, msg })));
    try {
        const css = fs.readFileSync(path.join(publicDir, NAV_CSS), 'utf8');
        for (const h of navCssHits(css)) findings.push({ rule: 'S11', file: NAV_CSS, line: h.line, msg: '不得出现平台导航类选择器 ' + h.cls + '（会覆盖共享顶栏）：' + h.text.slice(0, 120) });
    } catch (e) { findings.push({ rule: 'S11', file: NAV_CSS, line: 0, msg: '无法读取 ' + NAV_CSS + '：' + e.message }); }
    return findings;
}
function navSelfTest(publicDir) {
    const page = fs.readFileSync(path.join(publicDir, NAV_PAGE), 'utf8').replace(/\r\n/g, '\n');
    const ref = fs.readFileSync(path.join(publicDir, NAV_REF), 'utf8').replace(/\r\n/g, '\n');
    const icon = clipboardIcon(fs.readFileSync(path.join(publicDir, NAV_APP_JS), 'utf8'));
    const css = fs.readFileSync(path.join(publicDir, NAV_CSS), 'utf8').replace(/\r\n/g, '\n');
    const oldRule = '.navbar:has(+ #sysbuildApp) .nav-item[aria-current="page"] { color: #b45309; border-bottom: 2px solid #d97706; }';
    const entryRe = /<a href="\/Sys_Build\.html"[^>]*>[\s\S]*?<\/a>/;
    const iterationRe = /<a href="\/Sys_Iteration\.html"[^>]*>[\s\S]*?<\/a>/;
    // 变异必须真的改动内容；没改动或锚点不存在就抛错，不能让「没变异」的页面静默通过。
    const change = (html, re, fn) => {
        const m = re.exec(html);
        if (!m) throw new Error('变异锚点不存在：' + re);
        const out = html.slice(0, m.index) + fn(m[0]) + html.slice(m.index + m[0].length);
        if (out === html) throw new Error('变异没有改动内容：' + re);
        return out;
    };
    const cases = [
        ['未变异的项目管理页导航应绿', (h) => h, null],
        ['删掉项目管理入口里的 svg 应红', (h) => change(h, entryRe, (e) => e.replace(/<svg\b[\s\S]*?<\/svg>/, '')), '入口内 svg 应恰好 1 个'],
        ['项目管理入口的 svg 去掉 aria-hidden 应红', (h) => change(h, entryRe, (e) => e.replace(' aria-hidden="true"', '')), 'svg 应带 aria-hidden'],
        ['把项目管理入口挪到系统迭代之前应红', (h) => {
            const entry = entryRe.exec(h)[0];
            return change(h.replace(entry, ''), iterationRe, (e) => entry + '\n            ' + e);
        }, '应紧跟在「系统迭代」链接之后'],
        ['从导航里删掉「统计中心」应红', (h) => change(h, /<a href="\/Statistics\.html"[^>]*>[\s\S]*?<\/a>/, () => ''), '不逐字相等'],
        ['改掉标准导航项「数仓任务池」的文字应红', (h) => change(h, /数仓任务池<\/a>/, () => '数仓任务</a>'), '不逐字相等'],
        ['复制一份项目管理入口应红', (h) => change(h, entryRe, (e) => e + '\n            ' + e), '入口（href="/Sys_Build.html"）应恰好 1 个'],
        ['项目管理入口去掉 aria-current 应红', (h) => change(h, entryRe, (e) => e.replace(' aria-current="page"', '')), '应带 aria-current="page"'],
        ['项目管理入口去掉选中样式应红', (h) => change(h, entryRe, (e) => e.replace(' ' + NAV_ENTRY_STYLE, '')), '应带选中样式'],
        ['项目管理入口文字改名应红', (h) => change(h, entryRe, (e) => e.replace('项目管理</a>', '项目管理台</a>')), '入口文字应为'],
        ['导航起始标签去掉 aria-label 应红', (h) => change(h, /<nav class="navbar fixed-header" aria-label="平台导航">/, () => '<nav class="navbar fixed-header">'), '导航起始标签应为'],
        ['LOGO 渐变 id 改名应红', (h) => {
            const out = h.split(NAV_LOGO_ID).join('logo-gradient-x');
            if (out === h) throw new Error('变异没有改动内容：LOGO 渐变 id');
            return out;
        }, 'LOGO 渐变 id 应为'],
        ['系统迭代与项目管理入口之间插入 <span></span> 应红', (h) => change(h, entryRe, (e) => '<span></span>' + e), '应紧跟在「系统迭代」链接之后'],
        ['项目管理入口去掉 class 属性应红', (h) => change(h, entryRe, (e) => e.replace(' class="nav-item active"', '')), '起始标签与约定写法不逐字相等'],
        ['项目管理入口 class 里去掉 active 应红', (h) => change(h, entryRe, (e) => e.replace('class="nav-item active"', 'class="nav-item"')), '起始标签与约定写法不逐字相等'],
        ['项目管理入口加 target="_blank" 应红', (h) => change(h, entryRe, (e) => e.replace('<a href="/Sys_Build.html"', '<a href="/Sys_Build.html" target="_blank"')), '起始标签与约定写法不逐字相等'],
        ['项目管理入口换掉图标的 path 应红', (h) => change(h, entryRe, (e) => e.replace('<path d="M16 4h2a2', '<path d="M16 4h3a2')), '与 app.js 的 SVG_ICONS.clipboard 不逐字相等'],
        ['项目管理入口的 svg 去掉 width="14" 应红', (h) => change(h, entryRe, (e) => e.replace(' width="14"', '')), '与 app.js 的 SVG_ICONS.clipboard 不逐字相等'],
        ['项目管理入口的 svg 前多一个 <i class="x"></i> 应红', (h) => change(h, entryRe, (e) => e.replace('<svg', '<i class="x"></i><svg')), '入口整段与约定写法不逐字相等'],
        ['项目管理入口文字后多一个 <span class="badge"></span> 应红', (h) => change(h, entryRe, (e) => e.replace('项目管理</a>', '项目管理<span class="badge"></span></a>')), '入口整段与约定写法不逐字相等'],
    ];
    const results = cases.map(([name, mutate, expect]) => {
        const label = 'S11 导航：' + name;
        let mutated;
        try { mutated = mutate(page); } catch (e) { return { name: label + '（变异构造失败：' + e.message + '）', ok: false }; }
        const probs = checkNav(mutated, ref, icon);
        return { name: label, ok: expect === null ? probs.length === 0 : probs.some((p) => p.includes(expect)) };
    });
    // sysbuild.css 不得覆盖平台导航：对真实 css 文本在内存里追加 / 包注释，期望命中的类名列表（空 = 绿；红例同时断言命中类名与条数）。
    const cssCases = [
        ['现有 sysbuild.css 应绿', css, []],
        ['末尾追加旧的 .navbar:has(+ #sysbuildApp) .nav-item[aria-current="page"] 覆盖规则应红（恰 1 条，类名 .navbar）', css + '\n' + oldRule + '\n', ['.navbar']],
        ['末尾追加 .sbui-nav-item { color: red; } 应绿（不误伤本模块类名）', css + '\n.sbui-nav-item { color: red; }\n', []],
        ['旧覆盖规则放进 /* */ 注释里应绿', css + '\n/* ' + oldRule + ' */\n', []],
        ['末尾追加 .nav-dropdown-menu { display: none; } 应红（恰 1 条，类名 .nav-dropdown-menu）', css + '\n.nav-dropdown-menu { display: none; }\n', ['.nav-dropdown-menu']],
    ];
    for (const [name, text, wantClasses] of cssCases) {
        const label = 'S11 样式：' + name;
        if (wantClasses.length > 0 && text === css) { results.push({ name: label + '（变异构造失败：没有改动内容）', ok: false }); continue; }
        const got = navCssHits(text).map((h) => h.cls);
        results.push({ name: label, ok: got.length === wantClasses.length && got.every((c, i) => c === wantClasses[i]) });
    }
    return results;
}
module.exports = { analyzeText, scan, selfTest, scanNav, navSelfTest };
