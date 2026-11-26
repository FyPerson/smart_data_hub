'use strict';
// #212 第一步（C1b）只读工具：导出名与字面量反查。
//   用途：每个删除提交确认「删掉的导出名、动作规则键、事件类型在保留文件里没有引用」。
//   只读：不写任何被扫描文件，不连库、不起服务；--out 只写调用方指定的输出文件。
//
// 用法：
//   node wbs-server/scripts/sysbuild-step1/xref-exports.js [--root <仓库根>] [--out <文件>]
//        report 模式：routes/sysbuild/ 每个文件的导出名 → 在其他文件里的引用位置（JSON）
//   node wbs-server/scripts/sysbuild-step1/xref-exports.js --names <json> [--root <仓库根>] [--out <文件>]
//        json 形如 { "exports": [...], "literals": [...], "exclude": [{ "file": "...", "from": 行, "to": 行 }] }
//        有未排除的命中 = 退出码 1，否则 0；扫描失败（无法分词）也算 1（无法确认没有引用）
//   node wbs-server/scripts/sysbuild-step1/xref-exports.js --self-test
//
// 默认扫描面（相对仓库根）：
//   wbs-server/routes/sysbuild/**/*.js、wbs-server/public/assets/js/sysbuild-*.js、wbs-server/public/Sys_Build.html、
//   wbs-server/scripts/lib/sysbuild-*.js、wbs-server/scripts/verify-sysbuild-*.js、scripts/sysbuild-predeploy/**/*.{js,cjs}、wbs-server/server.js、
//   wbs-server/scripts/run-verify-family.js、wbs-server/scripts/lib/test-isolation-registry.js
//   exclude.file 必须写扫描面里的仓库相对全路径（不接受后缀写法；写了不认识的路径 = 参数错误，退出码 2）。
//
// 匹配口径：
//   · JS 用 acorn tokenizer（ecmaVersion latest，允许 hashbang），注释不进 token，所以注释里的名字不命中。
//   · 导出名：只认标识符 token（kind=identifier）与 `.name` 属性访问（kind=property），精确等值；字符串里的同名不算。
//   · 字面量：标识符 token 等值（kind=identifier / property：对象键、OBJECT_OPS.x.can()、变量名）、
//     字符串字面量 token 等值（kind=string）、模板字面量静态片段里的词边界命中（kind=template）、
//     literal 以 .js 结尾（文件名类）时有两条专用判法：① 只对以 ./ 或 ../ 开头的字符串，去掉 .js 的名字是它的完整最后一个路径段才命中
//     （'./x'、'../sysbuild/x' 算；裸写 'x'、'/x'、'./x-y'、'./x.json'、'./xy' 不算；对应不带 .js 的 require）；
//     ② 字符串 / 模板 / HTML 文本里的词边界命中，左侧要求前一个字符是开头或 '/'（'assets/js/x.js' 算，'sysbuild-x.js' 不算）；
//     模板字面量静态片段里的词边界命中（kind=template）、
//     HTML 文本（去掉 <!-- --> 与 <script> 之后）的词边界命中（kind=html-text）；<script> 内联段按 JS 处理。
//     另外把「字符串 token 里词边界包含但不等值」的位置单列为 stringWordAdvisory；未被 exclude 排除的也计入退出码（主会话 C1b 收口改：SQL 串里嵌表名必须算引用）。
//   · 拼接键风险：字符串字面量以 `_` 结尾且紧跟 `+` 运算符的位置（例如 'entry_' + action）单列为 concatRisks，只供人工判断，不计入退出码。
//   · 词边界 = (?<![A-Za-z0-9_])名字(?![A-Za-z0-9_])。
//   · 已知局限（登记，不判定）：
//     - 前端用拼接写的调用地址（'/api/sysbuild/projects/' + id + '/x'）看不到：本工具按 token 匹配，拼出来的地址不会等于 / 包含完整字面量。
//       删除提交要把调用方的静态片段（'/x' 之类）单独登记进 literals，并由浏览器用例覆盖；不要指望只靠完整路径字面量反查前端调用。
//     - 正则字面量（/…/）里的名字不扫；拼接键风险只认 'x_' + 这一种形态（`'x_'.concat(…)`、模板 `x_${…}` 不报）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const acorn = require('acorn');

const tt = acorn.tokTypes;
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..');
const ROUTES_DIR = 'wbs-server/routes/sysbuild';
const SCAN_SPECS = [
    { dir: ROUTES_DIR, re: /\.js$/, recursive: true },
    { dir: 'wbs-server/public/assets/js', re: /^sysbuild-.*\.js$/ },
    { file: 'wbs-server/public/Sys_Build.html' },
    { dir: 'wbs-server/scripts/lib', re: /^sysbuild-.*\.js$/ },
    { dir: 'wbs-server/scripts', re: /^verify-sysbuild-.*\.js$/ },
    { dir: 'scripts/sysbuild-predeploy', re: /\.(js|cjs)$/, recursive: true },
    { file: 'wbs-server/server.js' },
    { file: 'wbs-server/scripts/run-verify-family.js' },
    { file: 'wbs-server/scripts/lib/test-isolation-registry.js' },
];

// ── 文件清单 ───────────────────────────────────────────────────────────────────────────
function listDir(absDir, relDir, re, recursive, out) {
    let ents;
    try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch (e) { return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
        if (ent.name === 'node_modules') continue;
        const rel = relDir + '/' + ent.name;
        if (ent.isDirectory()) { if (recursive) listDir(path.join(absDir, ent.name), rel, re, recursive, out); } else if (ent.isFile() && re.test(ent.name)) out.push(rel);
    }
}
function listScanFiles(root) {
    const out = [];
    for (const spec of SCAN_SPECS) {
        if (spec.file) { if (fs.existsSync(path.join(root, spec.file))) out.push(spec.file); } else listDir(path.join(root, spec.dir), spec.dir, spec.re, !!spec.recursive, out);
    }
    return Array.from(new Set(out)).sort();
}

// ── 分词 ───────────────────────────────────────────────────────────────────────────────
// 返回 token 数组：{ k: 'name'|'string'|'template'|'plus'|'dot'|'other', v, line, col }；
//   name 含关键字（obj.default 这类属性名要能命中）；template 只收静态片段（value 为 cooked，缺失时取原文）。
function tokenizeJs(src, lineBase) {
    const out = [];
    const base = lineBase || 0;
    const tz = acorn.tokenizer(src, { ecmaVersion: 'latest', allowHashBang: true, locations: true });
    for (const t of tz) {
        let k = 'other';
        let v = null;
        if (t.type === tt.name || t.type.keyword) { k = 'name'; v = t.value !== undefined && t.value !== null ? String(t.value) : t.type.keyword; } else if (t.type === tt.string) { k = 'string'; v = t.value; } else if (t.type === tt.template) { k = 'template'; v = t.value !== null && t.value !== undefined ? t.value : src.slice(t.start, t.end); } else if (t.type === tt.plusMin && t.value === '+') k = 'plus';
        else if (t.type === tt.dot || t.type === tt.questionDot) k = 'dot';
        out.push({ k, v, line: t.loc.start.line + base, col: t.loc.start.column + 1 });
    }
    return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (name, flags) => new RegExp('(?<![A-Za-z0-9_])' + escapeRe(name) + '(?![A-Za-z0-9_])', flags || '');
const lineOf = (text, offset) => { let n = 1; for (let i = 0; i < offset; i += 1) if (text.charCodeAt(i) === 10) n += 1; return n; };

// HTML：先按「注释 | script 块」切；注释整段丢弃（保留换行），script 内联段按 JS 分词，其余是文本（script 内容、注释都替换成空白，保留换行以对齐行号）。
function splitHtml(text) {
    const re = /<!--[\s\S]*?-->|(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;
    const scripts = [];
    let plain = '';
    let last = 0;
    let m;
    const blank = (s) => s.replace(/[^\n]/g, ' ');
    while ((m = re.exec(text)) !== null) {
        plain += text.slice(last, m.index);
        if (m[0].startsWith('<!--')) plain += blank(m[0]);
        else {
            const open = m[1];
            const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(open);
            const type = typeMatch ? typeMatch[1].toLowerCase() : '';
            const isJs = type === '' || /javascript|ecmascript|^module$/.test(type);
            const hasSrc = /\bsrc\s*=/i.test(open);
            plain += open; // 开始标签（含 src 等属性）仍是 HTML 文本
            if (isJs && !hasSrc) {
                scripts.push({ text: m[2], line: lineOf(text, m.index + open.length) });
                plain += blank(m[2]);
            } else plain += m[2];
            plain += m[3];
        }
        last = m.index + m[0].length;
    }
    plain += text.slice(last);
    return { plain, scripts };
}

function scanFile(root, rel) {
    const abs = path.join(root, rel);
    const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    const rec = { rel, kind: rel.endsWith('.html') ? 'html' : 'js', tokens: [], htmlText: null, error: null };
    try {
        if (rec.kind === 'html') {
            const { plain, scripts } = splitHtml(text);
            rec.htmlText = plain;
            for (const s of scripts) rec.tokens.push(...tokenizeJs(s.text, s.line - 1));
        } else rec.tokens = tokenizeJs(text, 0);
    } catch (e) { rec.error = e.message; }
    return rec;
}
function scanAll(root) { return listScanFiles(root).map((rel) => scanFile(root, rel)); }

// ── 导出名 ─────────────────────────────────────────────────────────────────────────────
function walkAst(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc') continue;
        const v = node[key];
        if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walkAst(c, visit); } else if (v && typeof v.type === 'string') walkAst(v, visit);
    }
}
function propName(p) {
    if (p.computed) return p.key.type === 'Literal' ? String(p.key.value) : null;
    return p.key.type === 'Identifier' ? p.key.name : (p.key.type === 'Literal' ? String(p.key.value) : null);
}
function extractExports(src) {
    const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true, locations: true });
    const out = [];
    const notes = [];
    const isModExports = (n) => n && n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'module' && n.property.name === 'exports';
    const isExportsId = (n) => n && n.type === 'Identifier' && n.name === 'exports';
    const addObject = (obj, form) => {
        for (const p of obj.properties) {
            if (p.type === 'SpreadElement') { notes.push({ line: p.loc.start.line, note: '展开导出（...）：名字取不到' }); continue; }
            const name = propName(p);
            if (name === null) notes.push({ line: p.loc.start.line, note: '计算键导出：名字取不到' });
            else out.push({ name, line: p.loc.start.line, form });
        }
    };
    walkAst(ast, (n) => {
        if (n.type === 'AssignmentExpression' && n.operator === '=') {
            if (isModExports(n.left)) {
                const r = n.right;
                if (r.type === 'ObjectExpression') addObject(r, 'module.exports = {}');
                else if (r.type === 'Identifier') out.push({ name: r.name, line: n.loc.start.line, form: 'module.exports = <标识符>' });
                else if ((r.type === 'FunctionExpression' || r.type === 'ClassExpression') && r.id) out.push({ name: r.id.name, line: n.loc.start.line, form: 'module.exports = <具名函数/类>' });
                else notes.push({ line: n.loc.start.line, note: 'module.exports 赋值的右侧不是对象 / 标识符：名字取不到' });
            } else if (n.left.type === 'MemberExpression' && (isModExports(n.left.object) || isExportsId(n.left.object))) {
                const name = n.left.computed ? (n.left.property.type === 'Literal' ? String(n.left.property.value) : null) : n.left.property.name;
                if (name === null) notes.push({ line: n.loc.start.line, note: '计算键导出：名字取不到' });
                else out.push({ name, line: n.loc.start.line, form: isModExports(n.left.object) ? 'module.exports.x =' : 'exports.x =' });
            }
        }
        if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && n.callee.object.type === 'Identifier' && n.callee.object.name === 'Object' && n.callee.property.name === 'assign' && n.arguments.length >= 2 && (isModExports(n.arguments[0]) || isExportsId(n.arguments[0]))) {
            for (const a of n.arguments.slice(1)) {
                if (a.type === 'ObjectExpression') addObject(a, 'Object.assign(module.exports, {})');
                else notes.push({ line: a.loc.start.line, note: 'Object.assign 的来源不是对象字面量：名字取不到' });
            }
        }
    });
    return { exports: out, notes };
}

// ── 命中 ───────────────────────────────────────────────────────────────────────────────
function idHits(rec, name) {
    const hits = [];
    for (let i = 0; i < rec.tokens.length; i += 1) {
        const t = rec.tokens[i];
        if (t.k !== 'name' || t.v !== name) continue;
        const prev = i > 0 ? rec.tokens[i - 1] : null;
        hits.push({ file: rec.rel, line: t.line, col: t.col, kind: prev && prev.k === 'dot' ? 'property' : 'identifier' });
    }
    return hits;
}
// 文件名类 literal（以 .js 结尾）的两条专用判法（MED-2，免得 history.js 误报 'history' 标签名、sysbuild-history.js 脚本名）：
//   ① 不带 .js 的 require：只对以 ./ 或 ../ 开头的字符串 token 生效，去掉 .js 后的名字是它的完整最后一个路径段才命中
//      （'./x'、'../sysbuild/x' 算；裸写 'x'、'/x'、'./x-y'、'./x.json'、'./xy' 不算）。
//   ② 字符串 / 模板 / HTML 文本里的词边界命中，左侧再加路径段边界：命中位置前一个字符必须是开头或 '/'
//      （'assets/js/x.js' 算；'sysbuild-x.js'、'a.x.js'、'a_x.js' 不算）；右侧仍是词边界。
const lastSegment = (s) => String(s).split('/').pop();
const isRelativeSpec = (s) => /^\.\.?\//.test(String(s));
// 左边界：开头、'/'、引号、'='、空白（预筛复看 LOW-1：<script src="x.js"> 与 src='x.js' 也要命中）
const fileBoundRe = (name, flags) => new RegExp('(?<![^/"\'=\\s])' + escapeRe(name) + '(?![A-Za-z0-9_])', flags || '');
function literalHits(rec, value) {
    const isFileLike = value.endsWith('.js') && value.length > 3;
    const mkRe = (flags) => (isFileLike ? fileBoundRe(value, flags) : wordRe(value, flags));
    const re = mkRe('g');
    const hits = [];
    const advisory = [];
    const stem = isFileLike ? value.slice(0, -3) : null;
    for (let i = 0; i < rec.tokens.length; i += 1) {
        const t = rec.tokens[i];
        if (t.k === 'name') {
            // 标识符 token（对象键、属性访问、变量名）与字面量等值也是引用：OBJECT_OPS.confirm_zz.can()、{ confirm_zz: … }
            if (t.v === value) {
                const prev = i > 0 ? rec.tokens[i - 1] : null;
                hits.push({ file: rec.rel, line: t.line, col: t.col, kind: prev && prev.k === 'dot' ? 'property' : 'identifier' });
            }
        } else if (t.k === 'string') {
            if (t.v === value) hits.push({ file: rec.rel, line: t.line, col: t.col, kind: 'string' });
            else if (stem !== null && typeof t.v === 'string' && isRelativeSpec(t.v) && lastSegment(t.v) === stem) hits.push({ file: rec.rel, line: t.line, col: t.col, kind: 'string' });
            else if (typeof t.v === 'string' && mkRe().test(t.v)) advisory.push({ file: rec.rel, line: t.line, col: t.col, kind: 'string-word', text: t.v.length > 80 ? t.v.slice(0, 77) + '...' : t.v });
        } else if (t.k === 'template' && typeof t.v === 'string') {
            const m = mkRe().exec(t.v);
            if (m) hits.push({ file: rec.rel, line: t.line + (t.v.slice(0, m.index).match(/\n/g) || []).length, col: t.col, kind: 'template' });
        }
    }
    if (rec.htmlText) {
        let m;
        while ((m = re.exec(rec.htmlText)) !== null) hits.push({ file: rec.rel, line: lineOf(rec.htmlText, m.index), col: 0, kind: 'html-text' });
    }
    return { hits, advisory };
}
function concatRisks(rec) {
    const out = [];
    for (let i = 0; i + 1 < rec.tokens.length; i += 1) {
        const t = rec.tokens[i];
        if (t.k === 'string' && typeof t.v === 'string' && t.v.endsWith('_') && rec.tokens[i + 1].k === 'plus') out.push({ file: rec.rel, line: t.line, col: t.col, text: t.v });
    }
    return out;
}

const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
// exclude.file 必须是仓库相对全路径（与扫描面里的路径逐字相等），不接受后缀写法（后缀会让同名文件被一并排除）。
function excludedBy(hit, excludes) {
    return excludes.some((e) => hit.file === normPath(e.file) && hit.line >= e.from && hit.line <= e.to);
}
function badExcludeFiles(root, excludes) {
    const known = new Set(listScanFiles(root));
    return (excludes || []).map((e) => normPath(e.file)).filter((f) => !known.has(f));
}

// ── report 模式 ────────────────────────────────────────────────────────────────────────
function buildReport(root) {
    const recs = scanAll(root);
    const files = [];
    const errors = recs.filter((r) => r.error).map((r) => ({ file: r.rel, error: r.error }));
    for (const rec of recs) {
        if (!rec.rel.startsWith(ROUTES_DIR + '/')) continue;
        let ex;
        try { ex = extractExports(fs.readFileSync(path.join(root, rec.rel), 'utf8').replace(/\r\n/g, '\n')); } catch (e) { errors.push({ file: rec.rel, error: '解析失败：' + e.message }); continue; }
        const names = new Map();
        for (const e of ex.exports) if (!names.has(e.name)) names.set(e.name, e);
        const list = [];
        for (const [name, e] of names) {
            const refs = [];
            for (const other of recs) {
                if (other.rel === rec.rel) continue;
                refs.push(...idHits(other, name));
            }
            list.push({ name, line: e.line, form: e.form, referenceCount: refs.length, referenceFiles: Array.from(new Set(refs.map((r) => r.file))), references: refs });
        }
        files.push({ file: rec.rel, exports: list, notes: ex.notes });
    }
    return { mode: 'report', root: normPath(root), scannedFileCount: recs.length, files, errors };
}

// ── --names 模式 ───────────────────────────────────────────────────────────────────────
function buildNames(root, spec) {
    const recs = scanAll(root);
    const excludes = Array.isArray(spec.exclude) ? spec.exclude : [];
    const errors = recs.filter((r) => r.error).map((r) => ({ file: r.rel, error: r.error }));
    const exportsOut = [];
    for (const name of spec.exports || []) {
        const hits = [];
        for (const rec of recs) hits.push(...idHits(rec, name));
        exportsOut.push({ name, hits: hits.filter((h) => !excludedBy(h, excludes)), excluded: hits.filter((h) => excludedBy(h, excludes)) });
    }
    const literalsOut = [];
    for (const value of spec.literals || []) {
        const hits = [];
        const advisory = [];
        for (const rec of recs) { const r = literalHits(rec, value); hits.push(...r.hits); advisory.push(...r.advisory); }
        literalsOut.push({ value, hits: hits.filter((h) => !excludedBy(h, excludes)), excluded: hits.filter((h) => excludedBy(h, excludes)), stringWordAdvisory: advisory.filter((h) => !excludedBy(h, excludes)) });
    }
    const allNames = [...(spec.exports || []), ...(spec.literals || [])];
    const risks = [];
    for (const rec of recs) {
        for (const r of concatRisks(rec)) risks.push({ ...r, excluded: excludedBy(r, excludes), prefixOf: allNames.filter((n) => n.startsWith(r.text) && n !== r.text) });
    }
    const active = exportsOut.reduce((a, x) => a + x.hits.length, 0) + literalsOut.reduce((a, x) => a + x.hits.length, 0);
    const excl = exportsOut.reduce((a, x) => a + x.excluded.length, 0) + literalsOut.reduce((a, x) => a + x.excluded.length, 0);
    return {
        mode: 'names', root: normPath(root), scannedFileCount: recs.length, exports: exportsOut, literals: literalsOut, concatRisks: risks, errors,
        summary: { activeHits: active, excludedHits: excl, concatRiskCount: risks.length, advisoryCount: literalsOut.reduce((a, x) => a + x.stringWordAdvisory.length, 0), errorCount: errors.length },
        // 主会话 C1b 收口改：字符串里词边界命中（如 SQL 串里嵌表名）也算未排除命中——表名主要写在 SQL 串里，只当提示会漏
        ok: active === 0 && literalsOut.every((x) => x.stringWordAdvisory.length === 0) && errors.length === 0,
    };
}

// ── 命令行 ─────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const o = { root: DEFAULT_ROOT, out: null, names: null, selfTest: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--self-test') o.selfTest = true;
        else if (a === '--root' || a === '--out' || a === '--names') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(a + ' 需要一个参数');
            const v = argv[i + 1];
            i += 1;
            if (a === '--root') o.root = path.resolve(v); else if (a === '--out') o.out = path.resolve(v); else o.names = path.resolve(v);
        } else throw new Error('未知参数 ' + a);
    }
    return o;
}
function emit(obj, out) {
    const text = JSON.stringify(obj, null, 2) + '\n';
    if (out) fs.writeFileSync(out, text); else process.stdout.write(text);
}
function main(argv) {
    let o;
    try { o = parseArgs(argv); } catch (e) { console.error('用法错误：' + e.message); return 2; }
    if (o.selfTest) return selfTest();
    if (o.names) {
        let spec;
        try { spec = JSON.parse(fs.readFileSync(o.names, 'utf8')); } catch (e) { console.error('--names 文件无法读取或不是 JSON：' + e.message); return 2; }
        const bad = [];
        if (spec.exports !== undefined && !(Array.isArray(spec.exports) && spec.exports.every((x) => typeof x === 'string' && x !== ''))) bad.push('exports 须为非空字符串数组');
        if (spec.literals !== undefined && !(Array.isArray(spec.literals) && spec.literals.every((x) => typeof x === 'string' && x !== ''))) bad.push('literals 须为非空字符串数组');
        if (spec.exclude !== undefined && !(Array.isArray(spec.exclude) && spec.exclude.every((e) => e && typeof e.file === 'string' && Number.isInteger(e.from) && Number.isInteger(e.to) && e.from <= e.to))) bad.push('exclude 每项须有 file / from / to（整数，from <= to）');
        if (bad.length === 0) {
            const wrong = badExcludeFiles(o.root, spec.exclude);
            if (wrong.length) bad.push('exclude.file 必须是扫描面里的仓库相对全路径（不接受后缀写法），不认识：' + wrong.join(', '));
        }
        if (bad.length) { console.error('--names 内容不合法：' + bad.join('；')); return 2; }
        const r = buildNames(o.root, spec);
        emit(r, o.out);
        console.error(`xref：扫描 ${r.scannedFileCount} 个文件；未排除命中 ${r.summary.activeHits}（计入退出码），字符串含词命中 ${r.summary.advisoryCount}（未排除的计入退出码），已排除 ${r.summary.excludedHits}，扫描失败 ${r.summary.errorCount}（计入退出码）；拼接键风险 ${r.summary.concatRiskCount}（只供人工判断，不计入退出码）；${r.ok ? '无未排除命中' : '有未排除命中或扫描失败'}`);
        return r.ok ? 0 : 1;
    }
    const r = buildReport(o.root);
    emit(r, o.out);
    console.error(`xref report：扫描 ${r.scannedFileCount} 个文件，routes/sysbuild 文件 ${r.files.length} 个，导出名 ${r.files.reduce((a, f) => a + f.exports.length, 0)} 个，扫描失败 ${r.errors.length}`);
    return r.errors.length ? 1 : 0;
}

// ── 自检 ───────────────────────────────────────────────────────────────────────────────
function selfTest() {
    let total = 0;
    let ok = 0;
    const check = (pass, label) => { total += 1; if (pass) ok += 1; console.log(`  ${pass ? '✓' : '✗'} ${label}`); };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-xref-'));
    const created = [];
    const put = (rel, text) => {
        const abs = path.join(dir, ...rel.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text);
        created.push(abs);
    };
    try {
        put('wbs-server/routes/sysbuild/a.js', [
            "'use strict';",
            "// sysbuild_zz_comment 只在注释里",
            "function alpha() { return 'sysbuild_zz_str'; }",
            'function beta() {}',
            "module.exports = { alpha, beta: beta, 'gamma': 1, ...extra };",
            'module.exports.delta = 2;',
            'exports.eps = 3;',
            '',
        ].join('\n'));
        put('wbs-server/routes/sysbuild/b.js', [
            "'use strict';",
            '// gamma only appears in this comment',
            "const a = require('./a');",
            "const { beta } = require('./a');",
            'a.alpha();',
            "const k = 'entry_' + action;",
            'const t = `SELECT 1 FROM sysbuild_zz_tpl WHERE id = ${id}`;',
            "const s = 'sysbuild_zz_str';",
            "const longer = 'prefix sysbuild_zz_str suffix';",
            "const part = 'sysbuild_zz_strx';",
            "const tail = 'tail_';",
            "const r1 = require('./zz-old');",
            "const r2 = require('../sysbuild/zz-old');",
            "const r3 = require('./zz-old-y');",
            "const r4 = require('./zz-old.json');",
            "const r5 = require('./zz-oldy');",
            "const r6 = require('zz-old');",
            "const t1 = A.registerTab('history', fn);",
            "const t2 = 'assets/js/sysbuild-confirm.js';",
            "const t3 = '/projects/:id/invitations';",
            "const t4 = 'assets/js/zz-old.js';",
            '',
        ].join('\n'));
        put('wbs-server/public/assets/js/sysbuild-x.js', "'use strict';\nfunction use() { return delta + eps; }\n/* alpha in block comment */\nconst OPS = { confirm_zz: Object.freeze({}) };\nOPS.confirm_zz.can();\nconst confirm_zz_x = 1;\n");
        put('wbs-server/public/Sys_Build.html', [
            '<!doctype html>',
            '<p>sysbuild_zz_html</p>',
            '<!-- sysbuild_zz_comment <script>var c = "evt_zz_commented";</script> -->',
            '<script>',
            "var q = 'evt_zz';",
            '</script>',
            '<p>after sysbuild_zz_html_more</p>',
            '<script src="assets/js/sysbuild-zz-src.js"></script>',
            '<script src="assets/js/zz-old.js?v=auto"></script>',
            '<script src="assets/js/sysbuild-history.js"></script>',
            '',
        ].join('\n'));
        put('wbs-server/routes/other.js', "module.exports = 'sysbuild_zz_str';\n");

        // 扫描面
        const files = listScanFiles(dir);
        check(JSON.stringify(files) === JSON.stringify(['wbs-server/public/Sys_Build.html', 'wbs-server/public/assets/js/sysbuild-x.js', 'wbs-server/routes/sysbuild/a.js', 'wbs-server/routes/sysbuild/b.js']), '扫描面只含约定的 4 个文件（routes/other.js 不在扫描面）：' + files.join(','));

        check(['wbs-server/scripts/run-verify-family.js', 'wbs-server/scripts/lib/test-isolation-registry.js'].every((f) => SCAN_SPECS.some((s) => s.file === f)), '默认扫描面含 run-verify-family.js 与 lib/test-isolation-registry.js');
        put('wbs-server/scripts/run-verify-family.js', "const family = 'x';\n");
        check(listScanFiles(dir).includes('wbs-server/scripts/run-verify-family.js'), '默认扫描面：run-verify-family.js 存在时被扫到');
        fs.unlinkSync(path.join(dir, 'wbs-server', 'scripts', 'run-verify-family.js'));

        // report 模式
        const rep = buildReport(dir);
        const fa = rep.files.find((f) => f.file === 'wbs-server/routes/sysbuild/a.js');
        const names = fa ? fa.exports.map((e) => e.name) : [];
        check(JSON.stringify(names) === JSON.stringify(['alpha', 'beta', 'gamma', 'delta', 'eps']), 'report：a.js 的导出名 = alpha,beta,gamma,delta,eps（对象字面量 / module.exports.x / exports.x 三种写法）：' + names.join(','));
        check(fa && fa.notes.length === 1 && /展开/.test(fa.notes[0].note), 'report：展开导出（...extra）记为名字取不到的提示');
        const alpha = fa && fa.exports.find((e) => e.name === 'alpha');
        check(alpha && alpha.referenceCount === 1 && alpha.references[0].file === 'wbs-server/routes/sysbuild/b.js' && alpha.references[0].line === 5 && alpha.references[0].kind === 'property', 'report：alpha 只在 b.js:5 以属性访问引用（自身文件、块注释里的 alpha 都不算）');
        const beta = fa && fa.exports.find((e) => e.name === 'beta');
        check(beta && beta.referenceCount === 1 && beta.references[0].kind === 'identifier' && beta.references[0].line === 4, 'report：beta 在 b.js:4 以标识符引用（解构）');
        const gamma = fa && fa.exports.find((e) => e.name === 'gamma');
        check(gamma && gamma.referenceCount === 0, 'report：gamma 只在注释和字符串键里出现，引用为 0');
        const delta = fa && fa.exports.find((e) => e.name === 'delta');
        check(delta && delta.referenceFiles.length === 1 && delta.referenceFiles[0] === 'wbs-server/public/assets/js/sysbuild-x.js', 'report：delta 在前端脚本里被引用');

        // names 模式
        const spec = { exports: ['alpha', 'gamma', 'nonexist'], literals: ['sysbuild_zz_str', 'sysbuild_zz_tpl', 'sysbuild_zz_html', 'sysbuild_zz_comment', 'evt_zz', 'evt_zz_commented', 'entry_zzz'], exclude: [] };
        const r = buildNames(dir, spec);
        const ex = (n) => r.exports.find((x) => x.name === n);
        const lit = (v) => r.literals.find((x) => x.value === v);
        check(ex('alpha').hits.length === 3, 'names：alpha 命中 3 处（a.js 函数声明、a.js 导出对象、b.js 属性）：' + ex('alpha').hits.length);
        check(ex('gamma').hits.length === 0 && ex('nonexist').hits.length === 0, 'names：只在注释 / 字符串键里的 gamma、不存在的名字都是 0 命中');
        check(lit('sysbuild_zz_str').hits.length === 2 && lit('sysbuild_zz_str').hits.every((h) => h.kind === 'string'), 'names：字符串等值命中 2 处（a.js:3、b.js:8），长字符串里的包含与 sysbuild_zz_strx 不算命中');
        check(lit('sysbuild_zz_str').stringWordAdvisory.length === 1 && lit('sysbuild_zz_str').stringWordAdvisory[0].line === 9, 'names：「字符串里词边界包含但不等值」单列为提示（b.js:9），sysbuild_zz_strx 不进提示');
        check(lit('sysbuild_zz_tpl').hits.length === 1 && lit('sysbuild_zz_tpl').hits[0].kind === 'template' && lit('sysbuild_zz_tpl').hits[0].line === 7, 'names：模板字面量静态片段命中（b.js:7）');
        const htmlHits = lit('sysbuild_zz_html').hits;
        check(htmlHits.length === 1 && htmlHits[0].kind === 'html-text' && htmlHits[0].line === 2, 'names：HTML 文本命中 1 处（第 2 行），sysbuild_zz_html_more 因词边界不算');
        check(lit('sysbuild_zz_comment').hits.length === 0, 'names：只在 JS 注释 / HTML 注释里出现的字面量不命中');
        const evt = lit('evt_zz').hits;
        check(evt.length === 1 && evt[0].kind === 'string' && evt[0].file === 'wbs-server/public/Sys_Build.html' && evt[0].line === 5, 'names：HTML 内联 <script> 按 JS 处理，字符串命中行号对齐 HTML（第 5 行）');
        check(lit('evt_zz_commented').hits.length === 0, 'names：HTML 注释里包着的 <script> 不命中');
        const srcHits = buildNames(dir, { literals: ['sysbuild-zz-src'] }).literals[0].hits;
        check(srcHits.length === 1 && srcHits[0].line === 8 && srcHits[0].kind === 'html-text','names：带 src 的 <script> 开始标签属于 HTML 文本（src 里的文件名按词边界命中，第 8 行）');
        check(r.concatRisks.length === 1 && r.concatRisks[0].text === 'entry_' && r.concatRisks[0].line === 6, 'names：拼接键风险只报 \'entry_\' + action（b.js:6），\'tail_\' 后面不是 + 不报');
        check(r.concatRisks[0].prefixOf.includes('entry_zzz') && r.summary.concatRiskCount === 1, 'names：拼接键风险附带「会被该前缀拼出的待查名字」');
        check(r.ok === false && r.summary.activeHits > 0, 'names：有未排除命中时 ok=false');

        // H-1：字面量也命中标识符 token（对象键、属性访问），更长的标识符不命中
        const idLit = buildNames(dir, { literals: ['confirm_zz'] }).literals[0];
        check(idLit.hits.length === 2 && idLit.hits.some((h) => h.kind === 'identifier' && h.line === 4) && idLit.hits.some((h) => h.kind === 'property' && h.line === 5), 'names：字面量命中标识符 token——对象键 confirm_zz: Object.freeze(…)（identifier，sysbuild-x.js:4）与 OPS.confirm_zz.can()（property，:5）；confirm_zz_x 作为更长标识符不命中');
        // M-1：不带 .js 的 require
        const zzOld = buildNames(dir, { literals: ['zz-old.js'] }).literals[0];
        const inB = (list) => list.filter((h) => h.file.endsWith('/b.js')).map((h) => h.line);
        check(JSON.stringify(inB(zzOld.hits)) === JSON.stringify([12, 13]), 'names：literal 以 .js 结尾时，require(\'./zz-old\') / (\'../sysbuild/zz-old\') 命中（b.js:12、13）；裸写 \'zz-old\'（:17）、./zz-old-y、./zz-old.json、./zz-oldy 不命中：' + JSON.stringify(inB(zzOld.hits)));
        check(JSON.stringify(inB(zzOld.stringWordAdvisory)) === JSON.stringify([21]) && zzOld.hits.some((h) => h.kind === 'html-text' && h.line === 9), 'names：\'assets/js/zz-old.js\'（左边是 /，b.js:21）进字符串含词命中，<script src="assets/js/zz-old.js?v=auto">（HTML 第 9 行）命中 html-text → 红');
        const greens = ['history.js', 'confirm.js', 'invitations.js'].map((v) => { const l = buildNames(dir, { literals: [v] }).literals[0]; return l.hits.length + l.stringWordAdvisory.length; });
        check(JSON.stringify(greens) === JSON.stringify([0, 0, 0]), 'names：registerTab(\'history\', …) 对 history.js、\'assets/js/sysbuild-confirm.js\' / <script src=…sysbuild-history.js> 对 confirm.js / history.js、\'/projects/:id/invitations\' 对 invitations.js → 全部绿（0 命中 0 提示）：' + JSON.stringify(greens));
        const noJs = buildNames(dir, { literals: ['zz-old'] }).literals[0];
        check(JSON.stringify(inB(noJs.hits)) === JSON.stringify([17]), 'names：literal 不以 .js 结尾时不做路径段 / 路径边界判法（zz-old 只与整串等值的 require(\'zz-old\') 命中，./zz-old 不命中，只进提示）');

        // exclude
        const spec2 = { exports: ['alpha'], literals: ['sysbuild_zz_str'], exclude: [{ file: 'wbs-server/routes/sysbuild/a.js', from: 1, to: 10 }, { file: 'wbs-server/routes/sysbuild/b.js', from: 5, to: 9 }] };
        const r2 = buildNames(dir, spec2);
        check(r2.summary.activeHits === 0 && r2.summary.excludedHits === 5 && r2.summary.advisoryCount === 0 && r2.ok === true, 'exclude：区间内的命中与字符串内词边界命中全部被排除（a.js 3 处 + b.js 2 处，b.js:9 的提示也在区间内），ok=true（文件名写仓库相对全路径）：' + JSON.stringify(r2.summary));
        const r2b = buildNames(dir, { exports: ['alpha'], literals: ['sysbuild_zz_str'], exclude: [{ file: 'wbs-server/routes/sysbuild/a.js', from: 1, to: 10 }, { file: 'wbs-server/routes/sysbuild/b.js', from: 5, to: 8 }] });
        check(r2b.summary.activeHits === 0 && r2b.summary.advisoryCount === 1 && r2b.ok === false, 'exclude：只剩字符串内词边界命中（b.js:9，如 SQL 串里嵌表名）没被排除时 ok=false（主会话 C1b 收口改）：' + JSON.stringify(r2b.summary));
        const spec3 = { exports: ['alpha'], exclude: [{ file: 'wbs-server/routes/sysbuild/b.js', from: 6, to: 8 }] };
        const r3 = buildNames(dir, spec3);
        check(r3.exports[0].hits.some((h) => h.file.endsWith('b.js') && h.line === 5) && r3.exports[0].excluded.length === 0, 'exclude：区间没覆盖到的行（b.js:5）仍是未排除命中');

        // 命令行与退出码
        const specFile = path.join(dir, 'names1.json');
        const specFile2 = path.join(dir, 'names2.json');
        fs.writeFileSync(specFile, JSON.stringify(spec));
        fs.writeFileSync(specFile2, JSON.stringify(spec2));
        const cli = (args) => spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 60000 });
        const c1 = cli(['--root', dir, '--names', specFile, '--out', path.join(dir, 'out1.json')]);
        check(c1.status === 1 && JSON.parse(fs.readFileSync(path.join(dir, 'out1.json'), 'utf8')).mode === 'names', 'CLI：有未排除命中时退出码 1，--out 写出 JSON');
        const c2 = cli(['--root', dir, '--names', specFile2, '--out', path.join(dir, 'out2.json')]);
        check(c2.status === 0, 'CLI：命中全被 exclude 覆盖时退出码 0（实际 ' + c2.status + '）');
        const c3 = cli(['--root', dir, '--out', path.join(dir, 'out3.json')]);
        check(c3.status === 0 && JSON.parse(fs.readFileSync(path.join(dir, 'out3.json'), 'utf8')).mode === 'report', 'CLI：不带 --names 走 report 模式');
        const c4 = cli(['--root', dir, '--names']);
        check(c4.status === 2, 'CLI：--names 缺参数是用法错误（退出码 2）');
        const specSuffix = path.join(dir, 'names3.json');
        fs.writeFileSync(specSuffix, JSON.stringify({ exports: ['alpha'], exclude: [{ file: 'b.js', from: 1, to: 99 }] }));
        const c5 = cli(['--root', dir, '--names', specSuffix]);
        check(c5.status === 2 && /仓库相对全路径/.test(c5.stderr), 'CLI：exclude.file 写后缀（b.js）→ 参数错误（退出码 2），提示要仓库相对全路径');
        check(/计入退出码/.test(c1.stderr) && /不计入退出码/.test(c1.stderr), 'CLI：汇总文案分清哪些计入退出码、哪些只供人工判断（L-6）');
        fs.writeFileSync(path.join(dir, 'wbs-server', 'routes', 'sysbuild', 'zz_bad.js'), "const s = 'unterminated;\n");
        created.push(path.join(dir, 'wbs-server', 'routes', 'sysbuild', 'zz_bad.js'));
        const bad = buildNames(dir, { exports: ['nothing_here'], literals: [] });
        check(bad.errors.length === 1 && bad.ok === false, '无法分词的文件记为扫描失败，ok=false（无法确认没有引用）');
    } finally {
        // 清理：先删文件再自下而上删目录（不用 fs.rmSync）
        for (const f of created) { try { fs.unlinkSync(f); } catch (e) { /* 已被删 */ } }
        for (const f of ['names1.json', 'names2.json', 'names3.json', 'out1.json', 'out2.json', 'out3.json']) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 可能不存在 */ } }
        const dirs = [];
        (function collect(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) { collect(path.join(d, e.name)); dirs.push(path.join(d, e.name)); } }(dir));
        for (const d of dirs) { try { fs.rmdirSync(d); } catch (e) { console.error('  [清理] 目录未删除: ' + d); } }
        try { fs.rmdirSync(dir); } catch (e) { console.error('  [清理] 临时目录未删除（保留现场）: ' + dir + ' — ' + e.message); }
    }
    console.log(`\n${ok}/${total} 通过`);
    return ok === total ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { listScanFiles, scanAll, extractExports, buildReport, buildNames, tokenizeJs, splitHtml };
