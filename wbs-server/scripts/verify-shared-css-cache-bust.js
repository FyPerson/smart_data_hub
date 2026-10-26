/**
 * 页面缓存串守卫（#106 W4 / S6b 重写；原版 2026-08-12 因共享 CSS 改了没 bump 页面 ?v= 而建，codex 352 号收口）
 *
 * ═══ W4 起的规则 ═══
 * public 下页面里指向本地 JS / CSS 的 <script src> / <link href> 一律写 `?v=auto`，缓存串由服务端注入中间件
 * （utils/html-asset-fingerprint.js，挂在 express.static(public) 之前）按资源文件内容算 sha256 前 12 位后替换。
 * 因此“手动 bump 缓存串”作废：改共享资源不再需要改页面，也不再有“忘了 bump”这类事故。
 *
 * ═══ 旧判据为什么删除 ═══
 * 旧版维护一张登记表（每个资源的 version / sha256 / 引用页清单 / 变更日志）并联动 git 状态，逼人在改共享资源的同一批改动里
 * 同步 bump 页面串与登记。注入中间件上线后，指纹由内容决定、页面串恒为 `?v=auto`，那张表里的 version / sha256 / pages 全部失去对象；
 * 保留它只会逼人去维护一份没有读者的登记，所以整体删除，换成下面几条静态断言（不起服务；服务端行为由 verify-html-asset-fingerprint.js
 * 的进程内自检与 verify-html-fingerprint-e2e.js 的隔离实例检查负责）。
 *
 * ═══ 断言（S1 / S1c / S2 / S3 / S4 / S5 / S6 / S7） ═══
 *   S1 引用全为 auto  public 下全部 .html / .htm（递归）里，指向本地 .js / .css 的 <script src> 与 <link href>，查询串恰好是 `v=auto`
 *      （缺失 / 其他值 / 多个 v / 附带其他参数都判红）。CDN（有 scheme 或 // 开头）跳过。用 HTML 标签扫描 + new URL() 取查询串，不用单条大正则。
 *   S1c 解析口径硬门（只拒不放行）  本守卫按 HTML 规范解析，中间件按正则解析，下面四类写法两边结论可能不一致，所以直接禁止：
 *      ① .html / .htm 里出现 `<!-->`、`<!--->`、`--!>` 任一（规范里的“空注释 / 另一种注释结尾”，正则版中间件不认）；
 *      ② 本地 JS / CSS 引用的 src / href 属性值里任何位置出现空白（首尾空格 / 制表 / 换行，或中间的制表 / 换行；浏览器解析 URL 时会去掉，中间件的属性值匹配不去）；
 *      ③ `</script` 或 `</style`（不分大小写）后面不是 `\s*>`（如 `</script/>`、`</script foo>`；中间件用 `</script\s*>` 找结束标签，规范里这些写法也算结束）。
 *      ④ **不分类型**：任何 <script> 的 src 与 type、任何 <link> 的 rel 与 href，**原始**属性值里出现 `&`（字符引用 `&#46;` `&#61;` `&#115;` `&amp;` `&name;`，以及普通的 `&` 查询分隔符）一律判红。
 *         浏览器先解码再解析，中间件按原始文本匹配 `?v=auto`；守卫**不解码**（解码会造成守卫与中间件新的不一致），也不依赖 rel 是否样式类、扩展名是否 .js/.css
 *         （rel 与扩展名本身可以被实体遮住，codex 32-R-M1）。唯一例外：src / href 的原始值以字面 `https://` 开头（不分大小写；`https&#58;//` 不算）——CDN 地址如 Google Fonts。
 *      判据范围：①③是全文匹配（含注释、<script> / <style> 正文里的出现，宁可误红）；②只看 <script src> 与 <link href> 且指向本地 .js / .css 的；④看全部 <script> / <link> 标签。
 *   S2 无手写版本串残留  HTML 全文里不得出现 `<路径>.js|css?v=<非 auto>`（覆盖注释里抄的示例被人误当真、脚本里拼 `x.js?v=` + 变量）。
 *      例外只有本文件 S2_EXEMPT 里的显式登记（file + 原文 + 理由；初始为空；登记了却没有命中的条目判过期）。
 *      计数规则：每个 .html 里 `?v=auto` 子串的出现次数不得多于该页 S1 识别出的本地 JS/CSS 引用条数——`?v=auto` 只许写在真实引用里，
 *      注释 / 脚本字符串 / 样式里的说明文字 / 被字符引用遮住扩展名的引用都算多出（少于的情形由 S1 判红）。
 *   S3 动态加载（**闸门 = 站点显式登记表 S3_SITES**）  public 下 .js 与 .html 内联脚本里，**每一处** `createElement('script'|'link')`（也含 createElementNS、模板串写法、引号与空格变体）
 *      都必须恰好命中 S3_SITES 里的一条登记（同文件、站点所在行包含 snippet）；未登记 / 登记过期（命中 0 处）/ snippet 命中多处 / 一处命中多条 / 字段缺失或 reason 空白，一律判红。
 *      新增动态加载站点 = 先登记并由人工审阅它加载的是什么。现有登记 2 条：Model_Center.html 与 assets/js/app.js 的 xlsx CDN 加载。
 *      第二层（**辅助检查，不是闸门**）：站点之后赋给 .src / .href（或 setAttribute）的值必须是以 https:// 开头的整字符串字面量；元素绑定到变量名时在站点之后到整段代码末尾查对该变量名的每一处赋值，
 *      未绑定变量时看站点后 60 个 token。**已知局限**（codex 32-R-M2、预筛 LOW-1 / LOW-2）：不做词法绑定分析——同名变量跨作用域、站点之前的赋值、变量中转都看不准，
 *      两个方向都可能漏红（别的作用域里同名变量的 https 赋值能满足本站点的“找到赋值”），所以它不能当闸门，也不能说“只会多红、不会漏”。
 *      另禁止 document.write / writeln 写 script / link 标签；import(…) 的参数必须是**单个** https:// 开头的字符串字面量且其后紧跟 `)`（字面量后接 + ? . , 等任何 token 都判红），
 *      import 声明指向非 https:// 字面量判红；`obj.import` / `obj?.import` / `{ import: … }` / `const { import: x }` 里的 import 是属性名，不按导入处理。只拒不放行，不做值追踪。
 *   S4 页面集合非空  扫描到的页面数 >= 1，且与 git 可见集合（git ls-files --cached --others --exclude-standard）里 public 下的页面集合相等
 *      （防扫描静默落空；public 下有符号链接 / 联接点也判红，扫描不跟随）。
 *   S5 禁 <base>  任何 .html / .htm（扩展名不分大小写）在注释、<script>、<style> 之外出现 <base 元素即判红（标签名边界同中间件 `(?=[\t\n\f\r />])`）。
 *      理由：中间件按页面所在目录解析 `?v=auto` 引用，<base href> 会让浏览器实际请求的文件与被计算指纹的文件不一致（codex 31 M1 / 31-R）。
 *      同条另禁 <plaintext>（47R1a-R）：其后全部内容浏览器按文本展示，中间件与守卫都仍按标签扫描——两边**同时**误判时 S7 的全等拦不住，所以直接禁止。
 *      威胁模型（47R1a-R2 收口）：页面由开发者诚实维护；守卫与中间件两个扫描器的分歧由 S7 兜住，两边同时误判的构造（如 RCDATA 元素里塞 <script> 再接 <plaintext>、
 *      <textarea><plaintext></textarea> 被 S5 误红）登记为残余不再逐类补——其最坏后果是文本区被改写或留下字面 ?v=auto（后者由 e2e 与部署就绪检查判红），不会让浏览器加载错版本资源。
 *   S6 CSS 里的本地 css / js 引用（只拒不放行）  public 下 .css 文件、.html 的 <style> 块与 style= 属性里：`@import` 指向本地资源（任何扩展名，@import 载入的就是样式表），
 *      或 `url(…)` 指向本地 .css / .js（含带查询串）即判红——这类引用不经页面里的 `?v=auto`，拿不到内容指纹。指向图片、字体等其他本地资源的 url(…)、
 *      data: / http(s): / // 开头的目标不管（Dashboard 的背景图 `?v=2` 属于此类）。先剥 CSS 注释再判；style= 属性值先还原 &quot; &#39; &apos; &amp; 四种实体。
 *   S7 两个扫描器结论全等（集合级硬门，只拒不放行，不做豁免）  对每个页面，取守卫 S1 识别出的、查询串恰为 `v=auto` 的本地 JS / CSS 引用，按文档顺序得到路径列表
 *      （`?v=auto` 之前、不解码的原文），与中间件 `parsePage(text).refs.map(r => r.x)` 比较：条数与逐项都必须相等；不等即判红，输出页面名与第一个分歧位置（两边各自的列表片段）。
 *      中间件对本页抛错也判红。守卫按 HTML 规范扫描，中间件按正则扫描，二者对“哪些是真引用”的结论一旦分叉（正则分不清标签外 / 属性值里 / noscript 里 / SVG 外来内容里的
 *      文本元素名 `<textarea>` `<title>` 等，把其后的真实 script 当文本吞掉；反方向是 textarea 正文里的演示 `<script>` 被守卫当成引用），响应里就会留下字面 `?v=auto`
 *      而其他规则（S1 / S2 的计数）看不见——S7 不去逐类枚举这些写法，直接要求两个扫描器的结论逐页全等。
 *
 * ═══ 能力边界（登记，审查时不要再当新发现报） ═══
 *   · S3 闸门识别不到的写法：方括号调用 `document['createElement']('script')`、别名 / 解构 / bind 后的调用（`const ce = document.createElement; ce.call(document, 'script')`）、
 *     `new Function(…)` / 字符串形式的 `setTimeout('…')` 里拼出的代码、HTML 事件属性（onclick= 等）与 `javascript:` URL 里的脚本（S3 只扫 .js 文件与内联 `<script>` 正文）。
 *   · S3_SITES 按“同文件 + 站点所在行包含 snippet”匹配，有两条性质：① 原站点删除后，同文件里行文字相同的新站点会继承该登记——reason 必须写明加载目标，审阅 diff 时对照；
 *     ② 同一行上的两个站点无法分别登记（每条登记会同时命中两处而判“不唯一”），须拆成两行。
 *   · S3 的 import 识别是词法级的：名为 `import` 的方法定义 / 类方法 / getter、`export { x as import }` 会被误判红（只拒不放行，可接受）；`export … from '本地'` 不在 S3 范围（public 目前没有 ES 模块）。
 *   · 守卫（HTML 规范扫描）与中间件（正则扫描）的分歧——无引号属性值里含引号字符、RCDATA / RAWTEXT 文本元素（textarea / title / xmp / iframe / noembed / noframes）的开始标签
 *     出现在属性值 / noscript / SVG 外来内容里、文本元素正文里的演示标签等——不再逐类枚举：由 S7 逐页要求两个扫描器的 `?v=auto` 引用列表全等兜住（e2e“响应体无字面 ?v=auto”是第二道）。
 *     S7 只比 `?v=auto` 的本地 JS / CSS 引用；扩展名不是 .js / .css 的 `?v=auto`（如 `<link href="x.png?v=auto">`）守卫不计入、中间件会计入，同样判红（S2 的 ?v=auto 计数也会拦）。
 *   · W4 有意取舍：删除了旧版逐资源的“引用页双向清单”（某页误删了共享资源的引用，不再有通用的静态检测）。现存的部分覆盖：verify-badge-alias.js ①（徽章别名共享层）、
 *     verify-unify12-sticky.js（6 页 components.css 引用）、各模块专属守卫（如 verify-model-script-gen-single-source.js 对模型两页的脚本引用）；其余页面靠人工与 Playwright。
 *   · S6 只看 CSS 文本（文件 / <style> / style=）；JS 里拼出来的样式字符串（el.style.cssText、insertRule、innerHTML 里的 <style>）不在范围。
 *   · S6 用正则识别 `@import` / `url(`，不区分 CSS 字符串：`content: "url(x.css)"` 这类说明文字会被误判红（只拒不放行，可接受）；剥注释的正则也不识别字符串内的 `/*`。
 *   · S3 的站点识别只认 `createElement('script'|'link')` 的字面写法：实参不是字符串字面量（`createElement(tag)`）、拆字符串拼出标签名、innerHTML / insertAdjacentHTML / DOMParser 写入 script / link、
 *     new Worker(…) / importScripts(…) / fetch + eval 都看不到。document.write 只看参数里的字符串字面量与模板串静态段是否含 `<script` / `<link`。
 *   · S1 / S2 / S5 的 HTML 扫描按 HTML 规范处理注释（含 `<!-->` 与 `<!--->` 空注释、`--!>` 结尾——这些写法本身已被 S1c 禁止，扫描器仍按规范处理是为了让 S5 / S1 在它们出现时不被遮住）、<script> / <style> 原始文本；<textarea> / <title> 等 RCDATA 文本元素守卫**不特殊处理**（里面的标签仍按标签算），
 *     而中间件把这些文本元素的正文整段当文本跳过——两边在这一点上口径已分叉：<textarea> 正文里的演示 `<script src="…?v=auto">` 守卫算引用，S2 的计数因此误绿；该分歧不靠本扫描器收敛，由 S7 逐页全等拦截。
 *   · 只扫 public 目录；server.js 里 res.send 出去的 HTML、/uploads 与 /archive 下的 HTML 不在范围。
 *   · 引用的目标文件是否存在不在本守卫内判（静态不起服务）：缺失文件由中间件改用启动时刻戳并记错误日志，e2e 检查会逐页核对指纹等于磁盘字节 sha256 前 12 位。
 *
 * 用法：node scripts/verify-shared-css-cache-bust.js              检查真实 public
 *       node scripts/verify-shared-css-cache-bust.js --self-test  在临时目录与内存里构造正反例，逐条证明 S1–S7 判红 / 判绿（S7 另含三个变异自证）（建不出联接点时打印 SKIP 并计入汇总行的 SKIP 数）
 * 输出：默认模式末行 `=== PASS：<n> 项通过 / 0 项失败 ===`（run-it-ledger-plan-b-checks.js 按此格式取数）或 `=== FAIL：…`；退出码 0 / 1。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const acorn = require('acorn');   // 仓库已有依赖：只用词法器 acorn.tokenizer（verify-inline-handler-syntax.js 同法）
const { parsePage } = require('../utils/html-asset-fingerprint');   // S7：与守卫自己的扫描器逐页对拍的中间件正则扫描器

const tt = acorn.tokTypes;
const WBS_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(WBS_DIR, 'public');
const REPO_ROOT = path.resolve(WBS_DIR, '..');
const PUBLIC_GIT_REL = 'wbs-server/public';

/** S2 的显式例外：{ file: 'X.html'（相对 public，正斜杠）, text: '命中的原文（含路径与 ?v=…）', reason: '理由' }。初始为空。 */
const S2_EXEMPT = Object.freeze([]);

/**
 * S3 的闸门：public 下 .js 与 .html 内联脚本里**每一处** `createElement('script'|'link')`（含 createElementNS、模板串、引号与空格变体）都必须恰好命中这里的一条登记；
 * 未登记 → 红；登记命中 0 处 → 过期（红）；一条登记命中多处 → snippet 不唯一（红）；一处命中多条登记 → 登记重叠（红）；字段缺失或 reason 为空 → 红。
 * 字段：file = 相对 public 的正斜杠路径；snippet = 站点所在**行**里的一段原文（须在该文件内唯一定位到这个站点）；reason = 为什么可以动态加载、加载什么。
 * 新增动态加载站点 = 先在这里登记并由人工审阅它加载的是什么；守卫不去“理解”赋值（赋值检查只是第二层辅助，见 analyzeJs 注释）。
 */
const S3_SITES = Object.freeze([
    { file: 'Model_Center.html', snippet: "const cdn = document.createElement('script')", reason: '加载 CDN 上的 xlsx 库（https://cdn.sheetjs.com/…），非本地资源；S6b 已删本地回退（本地路径 wbs-server/node_modules/xlsx/… 不在 public 下，恒 404）' },
    { file: 'assets/js/app.js', snippet: "const script = document.createElement('script')", reason: '加载 CDN 上的 xlsx 库（https://cdnjs.cloudflare.com/…），非本地资源（该处从来只加载 CDN，没有本地回退）' },
]);

const HTML_EXT_RE =/\.html?$/i;
const JS_EXT_RE = /\.(?:m|c)?js$/i;
const LOCAL_ASSET_PATH_RE = /\.(?:js|css)$/i;
const NON_LOCAL_RE = /^(?:[a-z][a-z0-9+.\-]*:|\/\/)/i;
const WS_RE = /[\t\n\f\r ]/;
const SCRIPT_CLOSE_RE = /<\/script(?=[\t\n\f\r />])/gi;
const STYLE_CLOSE_RE = /<\/style(?=[\t\n\f\r />])/gi;
const TAG_NAME_RE = /<([A-Za-z][^\t\n\f\r />]*)/y;
const S2_RE = /([^\s"'<>()`]*\.(?:js|css))\?v=([^\s"'<>()`&#]*)/gi;
const CSS_EXT_RE = /\.css$/i;
// S1c ①：HTML 规范认、正则版中间件不认的注释写法
const S1C_COMMENT_PATTERNS = Object.freeze(['<!-->', '<!--->', '--!>']);
// S1c ③：</script / </style 后面不是 \s*> 的写法
const S1C_END_TAG_RE = /<\/(script|style)(?!\s*>)/gi;
// S6：@import 与 url(…)（目标取 双引号 / 单引号 / 无引号 三种写法）
const CSS_IMPORT_RE = /@import\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)|"([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/gi;
const JS_TYPE_RE =/^(?:(?:text|application)\/(?:x-)?(?:java|ecma|j|live)script|module)$/i;

const F = (rule, file, line, msg) => ({ rule, file, line, msg });
const toPosix = (p) => p.split(path.sep).join('/');

function lineOf(text, idx) {
    let n = 1;
    for (let i = text.indexOf('\n'); i !== -1 && i < idx; i = text.indexOf('\n', i + 1)) n++;
    return n;
}

// ───────────────────────────── HTML 标签扫描 ─────────────────────────────

/** 从 pos（标签名之后）解析属性，直到 `>`；属性值里的 `>` 不结束标签。重复属性取第一个（浏览器行为）由 attrOf 保证 */
function parseTagAttrs(text, pos) {
    const attrs = [];
    const n = text.length;
    let i = pos;
    for (;;) {
        while (i < n && (WS_RE.test(text[i]) || text[i] === '/')) i++;
        if (i >= n) return { attrs, end: n };
        if (text[i] === '>') return { attrs, end: i + 1 };
        let s = i;
        i++;   // 名字首字符无条件吃掉（规范允许首字符为 =）
        while (i < n && !WS_RE.test(text[i]) && text[i] !== '/' && text[i] !== '>' && text[i] !== '=') i++;
        const name = text.slice(s, i).toLowerCase();
        while (i < n && WS_RE.test(text[i])) i++;
        let value = null;
        if (text[i] === '=') {
            i++;
            while (i < n && WS_RE.test(text[i])) i++;
            const q = text[i];
            if (q === '"' || q === "'") {
                const e = text.indexOf(q, i + 1);
                if (e < 0) { value = text.slice(i + 1); i = n; } else { value = text.slice(i + 1, e); i = e + 1; }
            } else {
                s = i;
                while (i < n && !WS_RE.test(text[i]) && text[i] !== '>') i++;
                value = text.slice(s, i);
            }
        }
        attrs.push({ name, value });
    }
}

/** 返回开始标签列表 [{ name, attrs, start, end, body, bodyStart }]（注释已跳过；script / style 的正文进 body，不再扫描其中的标签） */
function scanHtml(text) {
    const tags = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
        const lt = text.indexOf('<', i);
        if (lt < 0) break;
        if (text.startsWith('<!--', lt)) {
            const from = lt + 4;
            if (text[from] === '>') { i = from + 1; continue; }                       // `<!-->` 是完整的空注释
            if (text[from] === '-' && text[from + 1] === '>') { i = from + 2; continue; }   // `<!--->` 同理
            const a = text.indexOf('-->', from);
            const b = text.indexOf('--!>', from);
            const ends = [a >= 0 ? a + 3 : -1, b >= 0 ? b + 4 : -1].filter((x) => x >= 0);
            i = ends.length ? Math.min(...ends) : n;                                  // 未闭合的注释吞到文件尾（浏览器同）
            continue;
        }
        TAG_NAME_RE.lastIndex = lt;
        const m = TAG_NAME_RE.exec(text);
        if (!m) { i = lt + 1; continue; }   // 结束标签 / 孤立的 `<`
        const name = m[1].toLowerCase();
        const p = parseTagAttrs(text, lt + m[0].length);
        const tag = { name, attrs: p.attrs, start: lt, end: p.end, body: null, bodyStart: -1 };
        i = p.end;
        if (name === 'script' || name === 'style') {
            const re = name === 'script' ? SCRIPT_CLOSE_RE : STYLE_CLOSE_RE;
            re.lastIndex = p.end;
            const c = re.exec(text);
            const bodyEnd = c ? c.index : n;
            tag.body = text.slice(p.end, bodyEnd);
            tag.bodyStart = p.end;
            i = bodyEnd;
        }
        tags.push(tag);
    }
    return tags;
}

const attrOf = (tag, name) => {
    const a = tag.attrs.find((x) => x.name === name);
    return a === undefined ? undefined : (a.value === null ? '' : a.value);
};

// ───────────────────────────── JS 词法分析（S3） ─────────────────────────────

function tokenize(code) {
    const tokens = [];
    try {
        for (const t of acorn.tokenizer(code, { ecmaVersion: 'latest', allowHashBang: true })) tokens.push(t);
    } catch (e) {
        return { tokens, error: e };
    }
    return { tokens, error: null };
}

/** 一段 JS 里的 S3 违规，返回 [{ pos, msg }]（pos = 在 code 里的偏移）与站点计数 */
function analyzeJs(code) {
    const { tokens, error } = tokenize(code);
    const out = [];
    const stats = { sites: 0 };
    const add = (pos, msg) => out.push({ pos, msg });
    if (error) add(typeof error.pos === 'number' ? error.pos : 0, `JS 词法解析失败（${error.message}），无法确认有没有动态加载本地资源，按红处理`);
    const N = tokens.length;
    const is = (t, type) => t !== undefined && t.type === type;
    const isName = (t, v) => t !== undefined && t.type === tt.name && (v === undefined || t.value === v);
    const isDot = (t) => t !== undefined && (t.type === tt.dot || t.type === tt.questionDot);
    /** 位置 i 起的静态字符串：字符串字面量，或不含 ${} 的模板串。返回 { value, next } 或 null */
    const staticStringAt = (i) => {
        const t = tokens[i];
        if (t === undefined) return null;
        if (t.type === tt.string) return { value: t.value, next: i + 1 };
        if (t.type === tt.backQuote) {
            if (is(tokens[i + 1], tt.backQuote)) return { value: '', next: i + 2 };
            if (is(tokens[i + 1], tt.template) && is(tokens[i + 2], tt.backQuote)) return { value: tokens[i + 1].value, next: i + 3 };
        }
        return null;
    };
    const END_OK = new Set([tt.semi, tt.comma, tt.parenR, tt.braceR, tt.bracketR]);
    /** 位置 i 的右值是不是“整个右值就是一个以 https:// 开头的字符串字面量”（后面必须是语句 / 实参 / 元素的结束，不能是 + 等续写） */
    const httpsLiteralAt = (i) => {
        const s = staticStringAt(i);
        if (s === null || !/^https:\/\//i.test(s.value)) return false;
        const nx = tokens[s.next];
        if (nx === undefined) return true;
        if (END_OK.has(nx.type)) return true;
        const between = code.slice(tokens[s.next - 1].end, nx.start);
        return between.includes('\n') && (nx.type === tt.name || (nx.type.keyword && nx.type !== tt._in && nx.type !== tt._instanceof));   // 换行后另起一条语句（ASI）
    };

    // —— createElement('script' | 'link') 站点 ——
    const sites = [];
    for (let i = 0; i < N; i++) {
        const t = tokens[i];
        if (!(isName(t, 'createElement') || isName(t, 'createElementNS'))) continue;
        if (!isDot(tokens[i - 1]) || !is(tokens[i + 1], tt.parenL)) continue;
        let j = i + 2;
        if (t.value === 'createElementNS') {   // 跳过命名空间实参，取逗号之后的第二个实参
            let depth = 0;
            for (; j < N && j < i + 40; j++) {
                const k = tokens[j].type;
                if (k === tt.parenL || k === tt.bracketL || k === tt.braceL) depth++;
                else if (k === tt.parenR || k === tt.bracketR || k === tt.braceR) { if (depth === 0) break; depth--; }
                else if (k === tt.comma && depth === 0) { j++; break; }
            }
        }
        const s = staticStringAt(j);
        if (s !== null && /^(?:script|link)$/i.test(s.value)) sites.push({ i, tag: s.value.toLowerCase() });
    }
    stats.sites = sites.length;
    stats.sitePositions = sites.map((s) => tokens[s.i].start);   // 每个 createElement('script'|'link') 站点的偏移，交给 S3_SITES 登记表核对（闸门）
    // ═══ 下面的“赋值必须是 https 字面量”检查是**第二层辅助检查，不是闸门**（闸门 = S3_SITES 站点登记表 + 人工审阅）。
    //   已知局限（codex 32-R-M2、预筛 LOW-1 / LOW-2）：不做词法绑定分析——
    //     · 同名变量跨作用域：别的作用域里同名变量的 https 赋值会满足本站点的“找到赋值”，反过来站点之前（如外层函数里）的本地赋值看不见，两个方向都可能漏红；
    //     · 站点之前的赋值、经变量中转（`const t = s; t.src = …`）、对象方法里改 src 都看不准；
    //     · 变量名重复使用时多扫到别的元素的赋值会多红，但这不能抵消上面的漏红，所以**不能**说“只会多红、不会漏”。
    //   这层只拒不放行；新增 createElement 站点必须先登记进 S3_SITES，由人工审阅它加载什么。
    const reported = new Set();   // 已按“非 https 字面量”报过的右值 token 序号
    for (let si = 0; si < sites.length; si++) {
        const { i, tag } = sites[si];
        // 变量名绑定时在“站点之后到整段代码末尾”里查对该变量的赋值（不以下一个 createElement 站点为终点）。
        const limit = N;
        let bound = null;   // `const x = document.createElement(…)` 的 x（只取名字，不追踪值）
        {
            let k = i - 1;
            while (isDot(tokens[k]) && isName(tokens[k - 1])) k -= 2;
            if (is(tokens[k], tt.eq) && isName(tokens[k - 1])) bound = tokens[k - 1].value;
        }
        let found = 0;
        const needHttps = (idx, what) => {
            found++;
            if (httpsLiteralAt(idx)) return;
            if (reported.has(idx)) return;   // 同一处赋值已被前一个站点（变量名相同）的全文扫描报过，不重复报
            reported.add(idx);
            add(tokens[idx] ? tokens[idx].start : tokens[i].start, `[辅助检查，不是闸门] createElement('${tag}') 之后赋给 ${what} 的值不是以 https:// 开头的字符串字面量（本地路径 / 变量 / 拼接 / 找不到字面量一律判红；局限见 analyzeJs 注释）`);
        };
        if (bound !== null) {
            for (let j = i + 1; j < limit; j++) {
                if (!isName(tokens[j], bound) || isDot(tokens[j - 1])) continue;
                const a = tokens[j + 1];
                if (isDot(a) && isName(tokens[j + 2])) {
                    const prop = tokens[j + 2].value;
                    if (/^(?:src|href)$/i.test(prop)) {
                        if (is(tokens[j + 3], tt.eq)) needHttps(j + 4, `.${prop}`);
                        else if (is(tokens[j + 3], tt.assign)) { found++; add(tokens[j + 2].start, `[辅助检查，不是闸门] createElement('${tag}') 的 .${prop} 用了复合赋值，无法确认值是 https:// 字面量`); }
                    } else if (prop === 'setAttribute' && is(tokens[j + 3], tt.parenL) && tokens[j + 4] && tokens[j + 4].type === tt.string && /^(?:src|href)$/i.test(tokens[j + 4].value) && is(tokens[j + 5], tt.comma)) {
                        needHttps(j + 6, `setAttribute('${tokens[j + 4].value}', …)`);
                    }
                } else if (is(a, tt.bracketL)) {
                    found++;
                    add(tokens[j].start, `[辅助检查，不是闸门] createElement('${tag}') 产生的元素 ${bound} 被用方括号取属性，无法确认 src / href 的值，判红`);
                }
                if (is(tokens[j - 1], tt.parenL) && isName(tokens[j - 2], 'assign') && isDot(tokens[j - 3]) && isName(tokens[j - 4], 'Object')) {
                    found++;
                    add(tokens[j].start, `[辅助检查，不是闸门] createElement('${tag}') 产生的元素 ${bound} 被传给 Object.assign，无法确认 src / href 的值，判红`);
                }
            }
        } else {
            const end = Math.min(N, i + 60);   // 未绑定变量：窗口 60 个 token，不再止于下一个站点
            for (let j = i + 1; j < end; j++) {
                if (isDot(tokens[j]) && isName(tokens[j + 1]) && /^(?:src|href)$/i.test(tokens[j + 1].value) && (is(tokens[j + 2], tt.eq) || is(tokens[j + 2], tt.assign))) {
                    if (is(tokens[j + 2], tt.eq)) needHttps(j + 3, `.${tokens[j + 1].value}`);
                    else { found++; add(tokens[j + 1].start, `[辅助检查，不是闸门] createElement('${tag}') 的 .${tokens[j + 1].value} 用了复合赋值，判红`); }
                    // 不 break：窗口（60 个 token）内每一处 .src / .href 赋值都检查——元素没绑定变量名时无法知道哪一处赋值属于它，
                    //   窗口里别的元素的本地路径赋值也会判红（辅助检查，只拒不放行），第一处 https 赋值不会挡住后面的本地赋值
                }
            }
        }
        if (found === 0) add(tokens[i].start, `[辅助检查，不是闸门] createElement('${tag}') 之后找不到 src / href 的字面量赋值，无法确认加载来源，判红`);
    }

    // —— document.write / writeln 写 script / link 标签 ——
    for (let i = 0; i < N; i++) {
        if (!(isName(tokens[i], 'document') && isDot(tokens[i + 1]) && (isName(tokens[i + 2], 'write') || isName(tokens[i + 2], 'writeln')) && is(tokens[i + 3], tt.parenL))) continue;
        let depth = 0;
        let bad = false;
        for (let j = i + 3; j < N; j++) {
            const tk = tokens[j];
            if (tk.type === tt.parenL) depth++;
            else if (tk.type === tt.parenR) { depth--; if (depth === 0) break; }
            else if (typeof tk.value === 'string' && /<\s*(?:script|link)\b/i.test(tk.value)) bad = true;
        }
        if (bad) add(tokens[i].start, 'document.write / writeln 写入 script / link 标签：这类引用不经页面 ?v=auto，禁止');
    }

    // —— import(…) 与 import 声明 ——
    for (let i = 0; i < N; i++) {
        if (!is(tokens[i], tt._import)) continue;
        if (isDot(tokens[i - 1])) continue;      // obj.import / obj?.import（属性名位置，含 obj.import() 方法调用）
        const nx = tokens[i + 1];
        if (is(nx, tt.colon)) continue;          // { import: true } / const { import: x } = o（对象属性 / 解构键）
        if (is(nx, tt.dot)) continue;            // import.meta
        if (is(nx, tt.parenL)) {
            // 参数必须恰是一个 https:// 开头的字符串字面量，且其后紧跟 `)`：字面量后接 + ? . , 等任何其他 token 都判红（拼接 / 三元 / 第二个实参）
            const s = staticStringAt(i + 2);
            const closed = s !== null && is(tokens[s.next], tt.parenR);
            if (s === null || !/^https:\/\//i.test(s.value) || !closed) add(tokens[i].start, 'import(…) 的实参不是单个以 https:// 开头的字符串字面量（字面量后必须紧跟 `)`；本地模块 / 拼接 / 三元 / 变量都不经指纹，禁止）');
            continue;
        }
        let spec = null;
        for (let j = i + 1; j < N && j < i + 200; j++) {
            if (tokens[j].type === tt.string) { spec = tokens[j].value; break; }
            if (tokens[j].type === tt.semi) break;
        }
        if (spec === null || !/^https:\/\//i.test(spec)) add(tokens[i].start, 'import 声明的模块说明符不是以 https:// 开头的字符串字面量（本地模块不经指纹，禁止）');
    }
    return { problems: out, stats };
}

// ───────────────────────────── 逐文件规则 ─────────────────────────────

/**
 * 一个 HTML 文件的 S1 / S2 / S3（内联脚本）/ S5。
 * opts = { exempt: [...] , usedExempt: Set }；返回 { findings, stats }
 */
function analyzeHtml(rel, text, opts) {
    const findings = [];
    const stats = { localRefs: 0, inlineScripts: 0, sites: 0, styleBlocks: 0, styleAttrs: 0 };
    const autoPaths = [];   // S7：本页 S1 识别出的、查询串恰为 ?v=auto 的本地 JS / CSS 引用的路径（不含查询串，原文不解码），文档顺序
    const siteHits = [];   // 内联脚本里的 createElement('script'|'link') 站点：{ file, line, lineText }，交给 checkS3Sites 与 S3_SITES 核对
    const exempt = (opts && opts.exempt) || S2_EXEMPT;
    const used = opts && opts.usedExempt;
    const tags = scanHtml(text);

    // S1c ③：`</script` / `</style`（不分大小写）后面不是 `\s*>`：中间件用 `</script\s*>` 找结束标签，守卫按规范（后面是空白 / `/` / `>` 都算结束），二者对 `</script/>`、`</script foo>` 结论不同。
    //   全文匹配（注释、字符串里的出现也算），只拒不放行，宁可误红
    S1C_END_TAG_RE.lastIndex = 0;
    for (let em = S1C_END_TAG_RE.exec(text); em !== null; em = S1C_END_TAG_RE.exec(text)) {
        findings.push(F('S1c', rel, lineOf(text, em.index), `出现 ${em[0]} 后面不是 \\s*>：中间件只认 </${em[1].toLowerCase()}\\s*> 作结束标签，与规范解析不一致，禁止`));
    }
    // S1c ①：规范与正则版中间件解析不一致的注释写法（全文子串，宁可误红）
    for (const pat of S1C_COMMENT_PATTERNS) {
        for (let at = text.indexOf(pat); at !== -1; at = text.indexOf(pat, at + 1)) {
            findings.push(F('S1c', rel, lineOf(text, at), `出现 ${pat}：规范里的空注释 / 另一种注释结尾，正则版中间件不认，两边对其后面标签的结论可能不一致，禁止`));
        }
    }

    for (const tag of tags) {
        // S1c ④（不分类型，只拒不放行）：**任何** <script> 的 src 与 type、**任何** <link> 的 rel 与 href，原始属性值里出现 `&`（字符引用 &#46; &#61; &#115; &amp; … 或普通查询分隔符）即判红。
        //   浏览器先解码再解析，中间件按原始文本匹配 `?v=auto`，两边会不一致；守卫**不解码**（解码会造成守卫与中间件新的不一致），也不再依赖 rel 是否样式类、扩展名是否 .js/.css
        //   （rel / 扩展名本身可以用实体遮住，codex 32-R-M1）。唯一例外：src / href 的原始值以字面 `https://` 开头（不分大小写；`https&#58;//` 不算）——CDN 地址（如 Google Fonts）。
        if (tag.name === 'script' || tag.name === 'link') {
            //   <script> 另含 type：type 被实体遮住（`text/j&#97;vascript`）时，下面的 JS_TYPE_RE 用未解码值判定，整段内联脚本会被当成非 JS 而不进 S3（预筛 LOW-1），所以 type 里的 `&` 同样判红（type 没有 https 例外）。
            for (const a of (tag.name === 'script' ? ['src', 'type'] : ['rel', 'href'])) {
                const val = attrOf(tag, a);
                if (val === undefined || !val.includes('&')) continue;
                if ((a === 'src' || a === 'href') && /^https:\/\//i.test(val)) continue;
                findings.push(F('S1c', rel, lineOf(text, tag.start), `<${tag.name} ${a}=${JSON.stringify(val)}> 的原始属性值含 \`&\`（字符引用 / 查询分隔符）：浏览器解码后才解析，中间件按原始文本匹配 ?v=auto，两边结论可能不一致，禁止（守卫不解码；唯一例外是 src / href 以字面 https:// 开头）`));
            }
        }
        // S1
        const attr = tag.name === 'script' ? 'src' : (tag.name === 'link' ? 'href' : null);
        if (attr !== null) {
            const v = attrOf(tag, attr);
            if (v !== undefined && v.trim() !== '') {
                const raw = v.trim();
                if (!NON_LOCAL_RE.test(raw)) {
                    let u = null;
                    try { u = new URL(raw, 'http://local.invalid/dir/page.html'); } catch (_) { u = null; }
                    if (u === null) {
                        findings.push(F('S1', rel, lineOf(text, tag.start), `<${tag.name} ${attr}="${raw}"> 无法按 URL 解析，无法确认查询串`));
                    } else {
                        let decoded = u.pathname;
                        try { decoded = decodeURIComponent(u.pathname); } catch (_) { /* 保留原样 */ }
                        if (LOCAL_ASSET_PATH_RE.test(u.pathname) || LOCAL_ASSET_PATH_RE.test(decoded)) {
                            stats.localRefs++;
                            if (v !== raw || /[\t\n\r]/.test(v)) {
                                findings.push(F('S1c', rel, lineOf(text, tag.start), `<${tag.name} ${attr}=${JSON.stringify(v)}> 属性值首尾有空白或中间含制表 / 换行：浏览器解析 URL 时会去掉，中间件的属性值匹配不去，两边对同一引用的结论可能不一致，禁止`));
                            }
                            if (u.search !== '?v=auto') {
                                findings.push(F('S1', rel, lineOf(text, tag.start), `<${tag.name} ${attr}="${raw}"> 的查询串应恰为 ?v=auto，实得 ${u.search === '' ? '（无）' : u.search}`));
                            } else {
                                autoPaths.push(raw.slice(0, raw.indexOf('?')));   // 与中间件 VALUE_RE 的捕获组 1（`?v=auto` 之前、不含查询串的原文）同口径
                            }
                        }
                    }
                }
            }
        }
        // S5
        if (tag.name === 'base') findings.push(F('S5', rel, lineOf(text, tag.start), '出现 <base> 元素：中间件按页面所在目录解析 ?v=auto 引用，<base href> 会让浏览器请求的文件与被计算指纹的文件不一致'));
        // 47R1a-R M：<plaintext> 之后的全部内容浏览器都当文本，中间件与本守卫却都会继续当标签扫描（两边同时误判，S7 的全等拦不住）→ 直接禁止
        if (tag.name === 'plaintext') findings.push(F('S5', rel, lineOf(text, tag.start), '出现 <plaintext> 元素：其后全部内容浏览器按文本展示，中间件与守卫仍会把其中的标签当引用（两边同时误判，S7 拦不住）'));
        // S6：<style> 块与 style= 属性
        if (tag.name === 'style' && tag.body !== null) {
            stats.styleBlocks++;
            for (const p of analyzeCss(tag.body)) findings.push(F('S6', rel, lineOf(text, tag.bodyStart + p.pos), p.msg));
        }
        const styleAttr = attrOf(tag, 'style');
        if (styleAttr !== undefined && styleAttr !== '') {
            stats.styleAttrs++;
            for (const p of analyzeCss(decodeAttrEntities(styleAttr))) findings.push(F('S6', rel, lineOf(text, tag.start), p.msg + '（style= 属性）'));
        }
        // S3：内联脚本
        if (tag.name === 'script' && attrOf(tag, 'src') === undefined && tag.body !== null) {
            const type = attrOf(tag, 'type');
            if (type === undefined || type.trim() === '' || JS_TYPE_RE.test(type.trim())) {
                stats.inlineScripts++;
                const r = analyzeJs(tag.body);
                stats.sites += r.stats.sites;
                for (const sp of r.stats.sitePositions) siteHits.push({ file: rel, line: lineOf(text, tag.bodyStart + sp), lineText: lineTextAt(text, tag.bodyStart + sp) });
                for (const p of r.problems) findings.push(F('S3', rel, lineOf(text, tag.bodyStart + p.pos), p.msg));
            }
        }
    }

    // S2：全文
    S2_RE.lastIndex = 0;
    let m;
    while ((m = S2_RE.exec(text)) !== null) {
        if (m[2] === 'auto') continue;
        const hit = exempt.findIndex((e) => e && e.file === rel && e.text === m[0]);
        if (hit >= 0) { if (used) used.add(hit); continue; }
        findings.push(F('S2', rel, lineOf(text, m.index), `手写版本串残留：${m[0]}（缓存串由服务端按内容注入，页面里不得再手写 ?v=<值>；注释里的示例也不行）`));
    }
    // S2 计数规则：`?v=auto` 子串只许出现在真实的本地 JS/CSS 引用里——出现次数不得多于本页 S1 识别出的本地引用条数
    //   （注释、脚本字符串、样式里的说明文字、被字符引用遮住扩展名的引用都算多出；少于的情形由 S1 判红，这里不重复）
    const autoLines = [];
    for (let at = text.indexOf('?v=auto'); at !== -1; at = text.indexOf('?v=auto', at + 1)) autoLines.push(lineOf(text, at));
    if (autoLines.length > stats.localRefs) {
        findings.push(F('S2', rel, autoLines[0], `\`?v=auto\` 出现 ${autoLines.length} 次，多于本页 S1 识别出的本地 JS/CSS 引用 ${stats.localRefs} 条（出现在第 ${autoLines.join('、')} 行）：它只许写在真实引用里，注释 / 脚本字符串 / 样式里的说明文字不得出现`));
    }
    return { findings, stats, siteHits, autoPaths };
}

/**
 * S7 的比较：两个路径列表条数与逐项都必须相等。返回第一个分歧位置（0 起），全等返回 -1。
 * 只拒不放行：任何分歧都算，不做豁免（含“只是多 / 少了末尾几项”）。
 */
function compareS7(guardPaths, mwPaths) {
    const n = Math.max(guardPaths.length, mwPaths.length);
    for (let i = 0; i < n; i++) if (guardPaths[i] !== mwPaths[i]) return i;
    return -1;
}

/**
 * S7 两个扫描器结论全等（集合级硬门）：守卫（HTML 规范扫描器）识别出的 `?v=auto` 本地引用路径列表，必须与中间件（正则扫描器 parsePage）
 * 对同一份字节得到的 refs.map(r => r.x) 条数与逐项全等。不等 = 某个写法让两个扫描器对“哪些是真引用”结论不同
 * （中间件漏注入会在响应里留下字面 ?v=auto；反方向则是守卫把文本演示当成引用而判绿）。
 * 路径口径：守卫取 S1 里 raw（去首尾空白的属性值）在第一个 `?` 之前的原文；中间件取 VALUE_RE 捕获的 `?v=auto` 之前原文再 latin1→utf8 还原，
 * 所以这里把页面文本先按 utf8 编码成字节、再以 latin1 喂给 parsePage（与中间件 loadPage 的读法一致），两边都是未做 percent 解码、不带前导补全的原文。
 * deps = { parse, cmp } 仅供自检注入替身 / 变异。
 */
function checkS7(rel, text, guardPaths, deps) {
    const parse = (deps && deps.parse) || ((t) => parsePage(t));
    const cmp = (deps && deps.cmp) || compareS7;
    let mwPaths;
    try {
        mwPaths = parse(Buffer.from(text, 'utf8').toString('latin1')).refs.map((r) => r.x);
    } catch (e) {
        return [F('S7', rel, 0, `中间件 parsePage 对本页抛错：${String((e && e.message) || e).split('\n')[0]}，无法确认两个扫描器结论一致，按红处理`)];
    }
    const at = cmp(guardPaths, mwPaths);
    if (at < 0) return [];
    const show = (a) => JSON.stringify(a.slice(at, at + 3)) + (a.length > at + 3 ? '…' : '');
    return [F('S7', rel, 0, `两个扫描器对 ?v=auto 引用的结论不一致：守卫 ${guardPaths.length} 条、中间件 ${mwPaths.length} 条，第一个分歧在第 ${at + 1} 条（守卫 ${show(guardPaths)} / 中间件 ${show(mwPaths)}）。常见原因：文本元素（textarea / title 等）的开始标签出现在属性值 / noscript / SVG 里，或 textarea 里写了演示用的 <script>——中间件正则分不清，浏览器与守卫按规范解析；改写该处写法`)];
}

/** style= 属性值里的实体还原（只还原 url(…) 引号会用到的几种；&amp; 最后还原） */
function decodeAttrEntities(s) {
    return s.replace(/&quot;|&#0*34;|&#x0*22;/gi, '"').replace(/&apos;|&#0*39;|&#x0*27;/gi, "'").replace(/&amp;/gi, '&');
}

/** 把 CSS 注释换成等长空白（保留换行，偏移与行号不变） */
function stripCssComments(text) {
    return text.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 一段 CSS 文本里的 S6 违规，返回 [{ pos, msg }] */
function analyzeCss(text) {
    const out = [];
    const code = stripCssComments(text);
    const isLocal = (t) => t !== '' && !t.startsWith('#') && !NON_LOCAL_RE.test(t);
    const extOf = (t) => {
        try {
            const u = new URL(t, 'http://local.invalid/dir/page.css');
            let d = u.pathname;
            try { d = decodeURIComponent(u.pathname); } catch (_) { /* 保留原样 */ }
            return { css: CSS_EXT_RE.test(u.pathname) || CSS_EXT_RE.test(d), js: JS_EXT_RE.test(u.pathname) || JS_EXT_RE.test(d), bad: false };
        } catch (_) { return { css: false, js: false, bad: true }; }
    };
    const spans = [];
    CSS_IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = CSS_IMPORT_RE.exec(code)) !== null) {
        spans.push([m.index, m.index + m[0].length]);
        const t = [m[1], m[2], m[3], m[4], m[5]].find((x) => x !== undefined);
        const target = (t === undefined ? '' : t).trim();
        if (isLocal(target)) out.push({ pos: m.index, msg: `@import 指向本地样式表 ${target}：不经页面里的 ?v=auto，拿不到内容指纹，禁止（改成页面里的 <link href="…?v=auto">）` });
    }
    CSS_URL_RE.lastIndex = 0;
    while ((m = CSS_URL_RE.exec(code)) !== null) {
        if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;   // @import url(…) 已按 @import 判过
        const t = [m[1], m[2], m[3]].find((x) => x !== undefined);
        const target = (t === undefined ? '' : t).trim();
        if (!isLocal(target)) continue;
        const e = extOf(target);
        if (e.bad) out.push({ pos: m.index, msg: `url(${target}) 无法按 URL 解析，无法确认是不是本地 css / js，禁止` });
        else if (e.css || e.js) out.push({ pos: m.index, msg: `url(${target}) 指向本地 ${e.css ? '.css' : '.js'}：不经页面里的 ?v=auto，拿不到内容指纹，禁止` });
    }
    return out;
}

/** 一个 .css 文件的 S6 */
function analyzeCssFile(rel, text) {
    return { findings: analyzeCss(text).map((p) => F('S6', rel, lineOf(text, p.pos), p.msg)) };
}

/** 一个 .js 文件的 S3 */
function analyzeJsFile(rel, text) {
    const r = analyzeJs(text);
    return {
        findings: r.problems.map((p) => F('S3', rel, lineOf(text, p.pos), p.msg)),
        stats: { sites: r.stats.sites },
        siteHits: r.stats.sitePositions.map((sp) => ({ file: rel, line: lineOf(text, sp), lineText: lineTextAt(text, sp) })),
    };
}

/** idx 所在**行**的原文（不含换行） */
function lineTextAt(text, idx) {
    const a = text.lastIndexOf('\n', idx - 1) + 1;
    const b = text.indexOf('\n', idx);
    return text.slice(a, b < 0 ? text.length : b).replace(/\r$/, '');
}

/** 登记项字段是否齐全（file / snippet / reason 都是非空字符串，reason 不能只有空白） */
const siteEntryOk = (e) => e && typeof e.file === 'string' && e.file !== '' && typeof e.snippet === 'string' && e.snippet !== '' && typeof e.reason === 'string' && e.reason.trim() !== '';

/**
 * S3 闸门：每一处 createElement('script'|'link') 站点必须恰好命中 registry 里的一条（同文件、站点所在行包含 snippet）。
 * 未登记 / 同一站点命中多条登记 / 登记过期（命中 0 处）/ snippet 不唯一（一条登记命中多处）/ 字段缺失 / reason 为空，都判红。
 */
function checkS3Sites(hits, registry) {
    const out = [];
    registry.forEach((e, i) => {
        if (!siteEntryOk(e)) out.push(F('S3', e && typeof e.file === 'string' ? e.file : '', 0, `S3_SITES[${i}] 格式不合法：file / snippet / reason 必须都是非空字符串（reason 不能只有空白）`));
    });
    const per = registry.map(() => 0);
    for (const h of hits) {
        const idxs = [];
        registry.forEach((e, i) => { if (siteEntryOk(e) && e.file === h.file && h.lineText.includes(e.snippet)) idxs.push(i); });
        if (idxs.length === 0) out.push(F('S3', h.file, h.line, `createElement('script'|'link') 站点未在 S3_SITES 登记：新增动态加载站点必须先登记（file + snippet + reason）并由人工审阅它加载的是什么。本行：${h.lineText.trim().slice(0, 120)}`));
        else if (idxs.length > 1) out.push(F('S3', h.file, h.line, `这一处站点同时命中 ${idxs.length} 条 S3_SITES 登记（序号 ${idxs.join('、')}），登记重叠，改成各自能唯一定位的 snippet`));
        for (const i of idxs) per[i]++;
    }
    registry.forEach((e, i) => {
        if (!siteEntryOk(e)) return;
        if (per[i] === 0) out.push(F('S3', e.file, 0, `S3_SITES[${i}]（${e.snippet}）没有命中任何 createElement 站点，登记已过期，删除它`));
        else if (per[i] > 1) out.push(F('S3', e.file, 0, `S3_SITES[${i}]（${e.snippet}）命中了 ${per[i]} 处站点，snippet 不唯一，改成能唯一定位的原文`));
    });
    return out;
}

/** S2 例外表自检：格式不合法、没被任何命中使用的条目都判红（保持例外表诚实） */
function checkExemptTable(exempt, used) {
    const out = [];
    exempt.forEach((e, i) => {
        const ok = e && typeof e.file === 'string' && e.file !== '' && typeof e.text === 'string' && e.text !== '' && typeof e.reason === 'string' && e.reason.trim() !== '';
        if (!ok) out.push(F('S2', '', 0, `S2_EXEMPT[${i}] 格式不合法：必须同时有非空的 file / text / reason`));
        else if (!used.has(i)) out.push(F('S2', e.file, 0, `S2_EXEMPT[${i}]（${e.text}）没有命中任何手写版本串，登记已过期，删除它`));
    });
    return out;
}

/** S4：页面集合。walked / git 都是相对 public 的正斜杠路径集合 */
function checkS4(walked, gitSet, gitError, symlinks) {
    const out = [];
    if (walked.size < 1) out.push(F('S4', '', 0, `扫描到的页面数为 ${walked.size}（应 >= 1）：扫描静默落空，其余断言全部失去意义`));
    if (gitError) {
        out.push(F('S4', '', 0, `git 可见集合读取失败，无法核对页面集合：${gitError}`));
    } else {
        const onlyWalked = [...walked].filter((p) => !gitSet.has(p)).sort();
        const onlyGit = [...gitSet].filter((p) => !walked.has(p)).sort();
        if (onlyWalked.length) out.push(F('S4', '', 0, `磁盘扫描到但 git 可见集合里没有（被 .gitignore 忽略？）：${onlyWalked.join(', ')}`));
        if (onlyGit.length) out.push(F('S4', '', 0, `git 可见集合里有但磁盘扫描没到（扫描漏了？）：${onlyGit.join(', ')}`));
    }
    for (const s of symlinks) out.push(F('S4', s, 0, 'public 下有符号链接 / 联接点：扫描不跟随它，其内容里的页面和脚本不在守卫范围'));
    return out;
}

// ───────────────────────────── 目录扫描 ─────────────────────────────

/** 递归枚举 public：返回 { files: [{ rel, kind, text }], htmlSet, symlinks } */
function collect(publicDir) {
    const files = [];
    const htmlSet = new Set();
    const symlinks = [];
    const walk = (dir, relDir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
            const rel = relDir === '' ? e.name : `${relDir}/${e.name}`;
            const abs = path.join(dir, e.name);
            if (e.isSymbolicLink()) { symlinks.push(rel); continue; }
            if (e.isDirectory()) { walk(abs, rel); continue; }
            if (!e.isFile()) continue;
            if (HTML_EXT_RE.test(e.name)) { htmlSet.add(rel); files.push({ rel, kind: 'html', text: fs.readFileSync(abs, 'utf8') }); }
            else if (JS_EXT_RE.test(e.name)) files.push({ rel, kind: 'js', text: fs.readFileSync(abs, 'utf8') });
            else if (CSS_EXT_RE.test(e.name)) files.push({ rel, kind: 'css', text: fs.readFileSync(abs, 'utf8') });
        }
    };
    walk(publicDir, '');
    return { files, htmlSet, symlinks };
}

function gitVisibleHtml(publicDir) {
    try {
        const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', PUBLIC_GIT_REL], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        const prefix = PUBLIC_GIT_REL + '/';
        const set = new Set();
        for (const p of out.split('\0')) {
            if (!p || !p.startsWith(prefix)) continue;
            const rel = p.slice(prefix.length);
            if (HTML_EXT_RE.test(rel) && fs.existsSync(path.join(publicDir, rel))) set.add(rel);   // 已在工作区删除、尚未暂存删除的不算
        }
        return { set, error: null };
    } catch (e) {
        return { set: new Set(), error: String((e && e.message) || e).split('\n')[0] };
    }
}

/** 对一个目录跑全部规则。gitInfo = { set, error }（自检传合成值） */
function runAll(publicDir, gitInfo, exempt, s3sites) {
    const { files, htmlSet, symlinks } = collect(publicDir);
    const used = new Set();
    const findings = [];
    const siteHits = [];
    const stats = { pages: htmlSet.size, js: 0, css: 0, localRefs: 0, autoRefs: 0, inlineScripts: 0, sites: 0, styleBlocks: 0, styleAttrs: 0 };
    for (const f of files) {
        if (f.kind === 'html') {
            const r = analyzeHtml(f.rel, f.text, { exempt, usedExempt: used });
            findings.push(...r.findings);
            findings.push(...checkS7(f.rel, f.text, r.autoPaths));
            stats.autoRefs += r.autoPaths.length;
            stats.localRefs += r.stats.localRefs; stats.inlineScripts += r.stats.inlineScripts; stats.sites += r.stats.sites;
            stats.styleBlocks += r.stats.styleBlocks; stats.styleAttrs += r.stats.styleAttrs;
            siteHits.push(...r.siteHits);
        } else if (f.kind === 'css') {
            stats.css++;
            findings.push(...analyzeCssFile(f.rel, f.text).findings);
        } else {
            stats.js++;
            const r = analyzeJsFile(f.rel, f.text);
            findings.push(...r.findings);
            stats.sites += r.stats.sites;
            siteHits.push(...r.siteHits);
        }
    }
    findings.push(...checkS3Sites(siteHits, s3sites === undefined ? S3_SITES : s3sites));
    findings.push(...checkExemptTable(exempt, used));
    findings.push(...checkS4(htmlSet, gitInfo.set, gitInfo.error, symlinks));
    return { findings, stats };
}

// ───────────────────────────── 主流程 ─────────────────────────────

const RULE_TITLES = {
    S1: '本地 JS / CSS 引用全为 ?v=auto',
    S1c: '无规范 / 正则解析不一致的写法（<!--> <!---> --!> 注释、引用属性值含空白 / 换行 / &、</script 与 </style 后不是 \\s*>）',
    S2: '无手写版本串残留，且 ?v=auto 只出现在真实引用里',
    S3: '动态加载站点须在 S3_SITES 登记（闸门）；辅助检查：赋值为 https:// 字面量',
    S4: '页面集合非空且与 git 可见集合相等',
    S5: '不出现 <base> / <plaintext> 元素',
    S6: 'CSS 里不用 @import / url() 引入本地 css / js',
    S7: '两个扫描器结论全等（守卫的 ?v=auto 本地引用路径列表 = 中间件 parsePage 的 refs，逐页条数与逐项相等）',
};

function runReal() {
    console.log('=== 页面缓存串守卫（W4：页面一律 ?v=auto，指纹由服务端中间件注入）===\n');
    const gitInfo = gitVisibleHtml(PUBLIC_DIR);
    const { findings, stats } = runAll(PUBLIC_DIR, gitInfo, S2_EXEMPT);
    console.log(`扫描面：${stats.pages} 个页面、${stats.js} 个 JS 文件、${stats.css} 个 CSS 文件；本地 JS/CSS 引用 ${stats.localRefs} 条（其中 ?v=auto ${stats.autoRefs} 条，S7 逐页与中间件对拍）；内联脚本 ${stats.inlineScripts} 段；<style> 块 ${stats.styleBlocks} 个、style= 属性 ${stats.styleAttrs} 处；createElement(script|link) 站点 ${stats.sites} 处；S2 例外 ${S2_EXEMPT.length} 条\n`);
    let pass = 0;
    let fail = 0;
    for (const rule of ['S1', 'S1c', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']) {
        const mine = findings.filter((f) => f.rule === rule);
        if (mine.length === 0) { pass++; console.log(`  [OK] ${rule} ${RULE_TITLES[rule]}`); continue; }
        fail++;
        console.log(`  [FAIL] ${rule} ${RULE_TITLES[rule]}（${mine.length} 处）`);
        for (const f of mine) console.log(`         ${f.file}${f.line ? ':' + f.line : ''}  ${f.msg}`);
    }
    // 断言 S1 的存在性：至少有一条本地引用被检查到（防解析整体失效后“零引用=全绿”）
    if (stats.localRefs > 0) { pass++; console.log(`  [OK] S1b 至少检查到一条本地引用（${stats.localRefs} 条）`); }
    else { fail++; console.log('  [FAIL] S1b 一条本地 JS/CSS 引用都没检查到：标签解析整体失效，S1 的“全绿”不可信'); }
    console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
    return fail === 0 ? 0 : 1;
}

// ───────────────────────────── 自检 ─────────────────────────────

function rmTree(dir) {
    // 路径可能含中文：不用 fs.rmSync / cpSync，逐层 unlink / rmdir
    let st;
    try { st = fs.lstatSync(dir); } catch (_) { return; }
    if (st.isDirectory() && !st.isSymbolicLink()) {
        for (const n of fs.readdirSync(dir)) rmTree(path.join(dir, n));
        fs.rmdirSync(dir);
    } else {
        fs.unlinkSync(dir);
    }
}

function selfTest() {
    let pass = 0;
    let fail = 0;
    let skip = 0;
    const check = (name, cond, detail) => {
        if (cond) pass++; else { fail++; console.log(`  [FAIL] ${name}${detail ? ' · ' + detail : ''}`); }
    };
    const skipped = (name, why) => { skip++; console.log(`  [SKIP] ${name} · ${why}`); };
    const rulesOf = (r) => r.findings.map((f) => f.rule);
    const htmlCase = (name, html, expectRule, expectCount, opts, allow) => {
        const r = analyzeHtml('p.html', html, opts);
        const got = rulesOf(r).filter((x) => x === expectRule).length;
        // 手写版本串同时命中 S1（标签里查询串不对）与 S2（全文有残留）是设计内的双重覆盖：S1 反例里不把伴随的 S2 算作“别的规则”；allow = 该用例明确容许同时出现的其他规则
        const others = rulesOf(r).filter((x) => x !== expectRule && !(expectRule === 'S1' && x === 'S2') && !(allow || []).includes(x));
        check(`${expectRule} 反例·${name}`, got === expectCount && others.length === 0, `期望 ${expectRule}×${expectCount}，实得 ${JSON.stringify(rulesOf(r))} ${r.findings.map((f) => f.msg).join(' | ').slice(0, 200)}`);
    };
    const htmlGreen = (name, html, opts) => {
        const r = analyzeHtml('p.html', html, opts);
        check(`正例·${name}`, r.findings.length === 0, r.findings.map((f) => `${f.rule}:${f.msg}`).join(' | ').slice(0, 300));
    };
    const jsCase = (name, code, expectCount) => {
        const r = analyzeJsFile('a.js', code);
        check(`S3 反例·${name}`, r.findings.length === expectCount && r.findings.every((f) => f.rule === 'S3'), `期望 ${expectCount} 处，实得 ${r.findings.length}：${r.findings.map((f) => f.msg).join(' | ').slice(0, 240)}`);
    };
    const jsGreen = (name, code) => {
        const r = analyzeJsFile('a.js', code);
        check(`S3 正例·${name}`, r.findings.length === 0, r.findings.map((f) => f.msg).join(' | ').slice(0, 300));
    };

    // —— S1 正例 ——
    htmlGreen('S1 双引号 ?v=auto', '<script src="assets/js/a.js?v=auto"></script><link rel="stylesheet" href="assets/css/a.css?v=auto">');
    htmlGreen('S1 单引号', "<script src='assets/js/a.js?v=auto'></script>");
    htmlGreen('S1 无引号', '<script src=assets/js/a.js?v=auto></script>');
    htmlGreen('S1 大写标签与属性名', '<SCRIPT SRC="a.js?v=auto"></SCRIPT>');
    htmlGreen('S1 ?v=auto 后带 #hash', '<script src="a.js?v=auto#frag"></script>');
    htmlGreen('S1 子目录页的 ../ 引用', '<script src="../assets/js/a.js?v=auto"></script>');
    htmlGreen('S1 https CDN 无 v 跳过', '<script src="https://cdn.example.com/x.min.js"></script><link rel="stylesheet" href="https://cdn.example.com/x.css">');
    htmlGreen('S1 http 与 // CDN 跳过', '<script src="http://cdn.example.com/x.js"></script><script src="//cdn.example.com/x.js"></script>');
    htmlGreen('S1 非 JS/CSS 的 link 不管', '<link rel="icon" href="favicon.ico"><link rel="preload" href="a.png?v=2">');
    htmlGreen('S1 注释里的坏引用不算', '<!-- <script src="a.js"></script> --><script src="b.js?v=auto"></script>');
    htmlGreen('S1 内联脚本字符串里的标签不算', '<script>var s = \'<script src="a.js"><\\/script>\';</script>');
    htmlGreen('S1 style 正文里的伪标签不算', '<style>/* <link href="a.css"> */ a{}</style>');
    htmlGreen('S1 内联脚本没有 src 不算引用', '<script>var x = 1;</script>');
    // —— S1 反例 ——
    htmlCase('缺查询串', '<script src="assets/js/a.js"></script>', 'S1', 1);
    htmlCase('其他值', '<script src="assets/js/a.js?v=v1.2.3_x"></script>', 'S1', 1);
    htmlCase('值为空', '<link rel="stylesheet" href="a.css?v=">', 'S1', 1);
    htmlCase('多个 v（原始值含 & 同时命中 S1c）', '<script src="a.js?v=auto&v=auto"></script>', 'S1', 1, undefined, ['S1c']);
    htmlCase('auto 之后还有别的参数（原始值含 & 同时命中 S1c）', '<script src="a.js?v=auto&x=1"></script>', 'S1', 1, undefined, ['S1c']);
    htmlCase('参数名大小写（?V=auto）', '<script src="a.js?V=auto"></script>', 'S1', 1);
    htmlCase('单引号其他值', "<script src='a.js?v=abc'></script>", 'S1', 1);
    htmlCase('无引号其他值', '<script src=a.js?v=abc></script>', 'S1', 1);
    htmlCase('CSS 缺查询串', '<link rel="stylesheet" href="a.css">', 'S1', 1);
    htmlCase('扩展名大写', '<script src="a.JS?v=1"></script>', 'S1', 1);
    htmlCase('两处各错一条', '<script src="a.js"></script><link rel="stylesheet" href="b.css?v=x">', 'S1', 2);
    htmlCase('属性值里含 > 不截断标签', '<script data-x="a>b" src="a.js"></script>', 'S1', 1);
    htmlCase('百分号编码的扩展名', '<script src="a.j%73"></script>', 'S1', 1);

    // —— S2 ——
    htmlGreen('S2 png 背景图 ?v=2 不管', '<style>a{background:url(\'x.png?v=2\')}</style>');
    htmlGreen('S2 没有扩展名的“?v= bump”文字不管', '<!-- 改了共享样式要 bump ?v= 缓存串 -->');
    // 32a-M5：?v=auto 只许出现在真实引用里（出现次数 > 本页 S1 识别出的本地引用条数即判红）
    htmlCase('注释里的 a.js?v=auto 示例（W4 起算多出的 ?v=auto）', '<!-- 示例：a.js?v=auto -->', 'S2', 1);
    htmlCase('脚本字符串里的 \'?v=auto\'', '<script>var q = \'?v=auto\';</script>', 'S2', 1);
    htmlCase('样式里的说明文字', '<style>/* 缓存串写 ?v=auto */ a{b:c}</style>', 'S2', 1);
    htmlGreen('?v=auto 出现次数 = 真实引用条数（2 条引用 2 次）', '<script src="a.js?v=auto"></script><link rel="stylesheet" href="b.css?v=auto#x">');
    htmlCase('1 条引用、?v=auto 出现 2 次（引用 + 注释）', '<script src="a.js?v=auto"></script><!-- b.js?v=auto -->', 'S2', 1);
    htmlCase('注释里抄的旧示例', '<!-- 须与 <script src="...u-paste.js?v=..._upaste3"> 缓存串一致 -->', 'S2', 1);
    htmlCase('注释里抄的真实旧串', '<!-- see a.css?v=v1.153.0_x -->', 'S2', 1);
    htmlCase('脚本里拼接版本', '<script>var u = \'assets/js/a.js?v=\' + ver;</script>', 'S2', 1);
    htmlCase('auto 之后多了字符（手写串残留 + ?v=auto 子串多出，各一处）', '<!-- a.js?v=autox -->', 'S2', 2);
    {
        const exempt = [{ file: 'p.html', text: 'a.js?v=old', reason: '测试例外' }];
        const used = new Set();
        const r = analyzeHtml('p.html', '<!-- a.js?v=old -->', { exempt, usedExempt: used });
        check('S2 例外：file + 原文都对时放行并记为已使用', r.findings.length === 0 && used.has(0), JSON.stringify(r.findings));
        check('S2 例外已使用时表自检不报', checkExemptTable(exempt, used).length === 0);
        const r2 = analyzeHtml('other.html', '<!-- a.js?v=old -->', { exempt, usedExempt: new Set() });
        check('S2 例外只对登记的文件生效（换文件仍红）', r2.findings.length === 1 && r2.findings[0].rule === 'S2');
        const r3 = analyzeHtml('p.html', '<!-- a.js?v=old2 -->', { exempt, usedExempt: new Set() });
        check('S2 例外只对登记的原文生效（换原文仍红）', r3.findings.length === 1 && r3.findings[0].rule === 'S2');
        const stale = checkExemptTable(exempt, new Set());
        check('S2 例外没被命中 → 过期判红', stale.length === 1 && stale[0].rule === 'S2' && /过期/.test(stale[0].msg));
        const badFmt = checkExemptTable([{ file: 'p.html', text: 'a.js?v=x', reason: '  ' }], new Set([0]));
        check('S2 例外缺理由 → 格式判红', badFmt.length === 1 && /格式不合法/.test(badFmt[0].msg));
    }

    // —— S3：JS 文件 ——
    jsGreen('https 字面量（单引号）', "const s = document.createElement('script');\ns.src = 'https://cdn.example.com/x.js';\ndocument.head.appendChild(s);");
    jsGreen('https 字面量（双引号 + 空格变体）', 'var l = document.createElement ( "link" ) ;\nl.rel = "stylesheet";\nl.href = "https://cdn.example.com/x.css"\ndocument.head.appendChild(l);');
    jsGreen('模板串（无插值）字面量', 'const s = document.createElement(`script`); s.src = `https://cdn.example.com/x.js`;');
    jsGreen('setAttribute 写 https 字面量', "const s = document.createElement('script'); s.setAttribute('src', 'https://cdn.example.com/x.js');");
    jsGreen('createElement 其他标签不管', "const a = document.createElement('a'); a.href = url; const i = document.createElement('img'); i.src = u;");
    jsGreen('注释里的 createElement / document.write / import 不算', "// document.createElement('script'); s.src = local\n/* document.write('<script src=x>'); import('./x.js') */\nconst k = 1;");
    jsGreen('字符串里的 document.write 文字不算', "const t = 'document.write(\"<script src=x>\")';");
    jsGreen('import 的 https 字面量', "import('https://cdn.example.com/x.mjs');");
    jsGreen('x.import 属性名不算', 'obj.import(file);');
    jsGreen('document.write 写非 script/link 内容', "document.write('<p>hi</p>');");
    jsGreen('两个站点各自 https', "var a = document.createElement('script'); a.src = 'https://a.example.com/a.js';\nvar b = document.createElement('link'); b.href = 'https://b.example.com/b.css';");
    jsCase('本地路径字面量', "const s = document.createElement('script'); s.src = 'assets/js/x.js';", 1);
    jsCase('本地路径 + 双引号 link', 'var l = document.createElement("link"); l.rel = "stylesheet"; l.href = "assets/css/x.css";', 1);
    jsCase('变量', "const s = document.createElement('script'); s.src = url;", 1);
    jsCase('拼接（以 https 开头但不是整个字面量）', "const s = document.createElement('script'); s.src = 'https://cdn.example.com/' + name + '.js';", 1);
    jsCase('http 字面量（不是 https）', "const s = document.createElement('script'); s.src = 'http://cdn.example.com/x.js';", 1);
    jsCase('协议相对 //cdn', "const s = document.createElement('script'); s.src = '//cdn.example.com/x.js';", 1);
    jsCase('模板串带插值', 'const s = document.createElement(\'script\'); s.src = `https://cdn.example.com/${n}.js`;', 1);
    jsCase('三元表达式', "const s = document.createElement('script'); s.src = ok ? 'https://a/x.js' : 'x.js';", 1);
    jsCase('复合赋值 +=', "const s = document.createElement('script'); s.src = 'https://a/'; s.src += 'x.js';", 1);
    jsCase('setAttribute 本地', "const s = document.createElement('script'); s.setAttribute('src', 'assets/js/x.js');", 1);
    jsCase('setAttribute 变量', "const s = document.createElement('link'); s.setAttribute('href', cssUrl);", 1);
    jsCase('找不到 src / href 赋值', "const s = document.createElement('script'); s.textContent = code; document.head.appendChild(s);", 1);
    jsCase('方括号写属性', "const s = document.createElement('script'); s['src'] = 'https://a/x.js';", 1);
    jsCase('Object.assign 批量赋值', "const s = document.createElement('script'); Object.assign(s, { src: 'x.js' });", 1);
    jsCase('createElementNS', "const s = document.createElementNS('http://www.w3.org/1999/xhtml', 'script'); s.src = 'x.js';", 1);
    jsCase('不绑定变量的链式写法', "document.head.appendChild(document.createElement('script')).src = 'x.js';", 1);
    jsCase('两个站点一好一坏', "var a = document.createElement('script'); a.src = 'https://a.example.com/a.js';\nvar b = document.createElement('script'); b.src = 'b.js';", 1);
    jsCase('document.write 写 script 标签', "document.write('<script src=\"x.js\"><\\/script>');", 1);
    jsCase('document.write 写 link 标签（模板串）', 'document.writeln(`<link rel="stylesheet" href="x.css">`);', 1);
    jsCase('import() 本地路径', "import('./x.js');", 1);
    jsCase('import() 变量', 'import(p);', 1);
    // 32a-M2：import() 的参数必须是单个字符串字面量且其后紧跟 `)`
    jsCase("import('https://cdn.x/' + name + '.js') 拼接", "import('https://cdn.x/' + name + '.js');", 1);
    jsCase("import('https://a/b.js' ? x : y) 三元", "import('https://a/b.js' ? x : y);", 1);
    jsCase("import('https://a/b.js', opts) 第二个实参", "import('https://a/b.js', { with: { type: 'json' } });", 1);
    jsCase("import('https://a/b.js'.trim()) 方法调用", "import('https://a/b.js'.trim());", 1);
    jsGreen("import('https://a/b.js') 单个字面量", "import('https://a/b.js').then(m => m.default);");
    // 32a-M3：import 作为属性名 / 对象键 / 解构键不是导入
    jsGreen('const o = { import: true } 对象键', 'const o = { import: true };');
    jsGreen('const { import: x } = o 解构键', 'const o = { import: 1 }; const { import: x } = o;');
    jsGreen('obj.import() 方法调用', 'obj.import();');
    jsGreen('obj?.import(file) 可选链方法调用', 'obj?.import(file);');
    jsCase("真实 import('x.js') 仍判红", "import('x.js');", 1);
    jsCase("真实 import x from './a.js' 仍判红", "import x from './a.js';", 1);
    jsCase('import 声明本地路径', "import { a } from './x.js';", 1);
    jsCase('JS 词法解析失败按红处理', 'var s = "unterminated;\n', 1);

    // —— S3：HTML 内联脚本 ——
    htmlCase('内联脚本里本地 createElement', "<script>var s = document.createElement('script'); s.src = 'x.js';</script>", 'S3', 1);
    htmlGreen('内联脚本里 https createElement', "<script>var s = document.createElement('script'); s.src = 'https://cdn.example.com/x.js';</script>");
    htmlGreen('内联 JSON / 模板脚本不按 JS 扫', '<script type="application/json">{"a": "document.write(\'<script>\')"}</script><script type="text/template">createElement(\'script\')</script>');
    htmlCase('type=module 内联脚本照扫', "<script type=\"module\">import('./x.js');</script>", 'S3', 1);
    {
        const r = analyzeHtml('p.html', '<p>\n</p>\n<script>\n// x\nvar s = document.createElement("script");\ns.src = "x.js";\n</script>', {});
        check('S3 内联脚本违规的行号 = 文件内行号（指向赋值的右值所在行）', r.findings.length === 1 && r.findings[0].line === 6, JSON.stringify(r.findings));
    }

    // —— S3 闸门：createElement 站点显式登记表 S3_SITES（32-R-M2）——
    {
        const reason = '测试登记：加载 CDN 上的库';
        const code1 = "const s = document.createElement('script'); s.src = 'https://a.example.com/x.js';";
        const hits1 = analyzeJsFile('assets/js/x.js', code1).siteHits;
        const reg1 = [{ file: 'assets/js/x.js', snippet: "const s = document.createElement('script')", reason }];
        const s3 = (hits, reg) => checkS3Sites(hits, reg).filter((f) => f.rule === 'S3');
        check('S3 闸门：站点被识别（hits 1，含行号与行原文）', hits1.length === 1 && hits1[0].line === 1 && hits1[0].lineText === code1, JSON.stringify(hits1));
        check('S3 闸门·反例：未登记的站点 → 红（即使赋 https）', s3(hits1, []).length === 1 && /未在 S3_SITES 登记/.test(s3(hits1, [])[0].msg), JSON.stringify(s3(hits1, [])));
        check('S3 闸门·正例：登记后（同文件、行含 snippet）→ 绿', s3(hits1, reg1).length === 0, JSON.stringify(s3(hits1, reg1)));
        check('S3 闸门·反例：登记在别的文件 → 红（未登记 + 过期）', s3(hits1, [{ file: 'assets/js/y.js', snippet: "createElement('script')", reason }]).length === 2);
        check('S3 闸门·反例：登记过期（命中 0 处）→ 红', s3([], reg1).length === 1 && /登记已过期/.test(s3([], reg1)[0].msg), JSON.stringify(s3([], reg1)));
        const hits2 = analyzeJsFile('assets/js/x.js', "const a = document.createElement('script'); a.src = 'https://a/1.js';\nconst b = document.createElement('script'); b.src = 'https://a/2.js';").siteHits;
        check('S3 闸门·反例：snippet 命中两处站点 → 红（不唯一）', s3(hits2, [{ file: 'assets/js/x.js', snippet: "document.createElement('script')", reason }]).some((f) => /snippet 不唯一/.test(f.msg)), JSON.stringify(s3(hits2, [{ file: 'assets/js/x.js', snippet: "document.createElement('script')", reason }])));
        check('S3 闸门·正例：两处站点各用能唯一定位的 snippet 登记 → 绿', s3(hits2, [{ file: 'assets/js/x.js', snippet: 'const a = ', reason }, { file: 'assets/js/x.js', snippet: 'const b = ', reason }]).length === 0);
        check('S3 闸门·反例：同一站点命中两条登记 → 红（登记重叠）', s3(hits1, [reg1[0], { file: 'assets/js/x.js', snippet: 's.src', reason }]).some((f) => /登记重叠/.test(f.msg)) || s3(hits1, [reg1[0], { file: 'assets/js/x.js', snippet: "createElement('script')", reason }]).some((f) => /登记重叠/.test(f.msg)));
        check('S3 闸门·反例：reason 为空白 → 红（格式不合法）', s3(hits1, [{ file: 'assets/js/x.js', snippet: "const s = document.createElement('script')", reason: '   ' }]).some((f) => /格式不合法/.test(f.msg)));
        check('S3 闸门·反例：缺 snippet 字段 → 红（格式不合法）', s3(hits1, [{ file: 'assets/js/x.js', reason }]).some((f) => /格式不合法/.test(f.msg)));
        // 32-R 给的反例：外层本地赋值在站点之前，内层同名变量的 https 赋值把“找到赋值”凑齐——辅助检查看不出，闸门必须因“未登记”判红
        const cx = "function loadLocal(){s.src='local.js';}\nconst s=document.createElement('script'); loadLocal(); document.head.appendChild(s);\nfunction unrelated(){const s=document.createElement('script'); s.src='https://cdn.example.com/a.js';}";
        const rx = analyzeJsFile('assets/js/cx.js', cx);
        check('S3 闸门·32-R 反例：辅助检查确实看不出（登记局限，如实记录）', rx.findings.length === 0, JSON.stringify(rx.findings));
        check('S3 闸门·32-R 反例：未登记时两处站点都判红', s3(rx.siteHits, []).length === 2, JSON.stringify(s3(rx.siteHits, [])));
        // 内联脚本里的站点
        const ph = analyzeHtml('P.html', "<p>x</p>\n<script>\nvar el = document.createElement('link'); el.href = 'https://cdn.example.com/a.css';\n</script>", {});
        check('S3 闸门·内联脚本站点：行号 = 文件内行号，未登记判红、登记后判绿', ph.siteHits.length === 1 && ph.siteHits[0].line === 3 && s3(ph.siteHits, []).length === 1 && s3(ph.siteHits, [{ file: 'P.html', snippet: "var el = document.createElement('link')", reason }]).length === 0, JSON.stringify(ph.siteHits));
        // 真实登记表
        check('S3_SITES 现有登记 2 条（Model_Center.html / assets/js/app.js），字段齐全', S3_SITES.length === 2 && S3_SITES.every(siteEntryOk) && S3_SITES.some((e) => e.file === 'Model_Center.html') && S3_SITES.some((e) => e.file === 'assets/js/app.js'));
    }

    // —— S5 ——
    htmlCase('<base href>', '<head><base href="/x/"></head>', 'S5', 1);
    htmlCase('<BASE> 大写', '<BASE HREF="/x/">', 'S5', 1);
    htmlCase('<base/> 自闭合写法', '<base/>', 'S5', 1);
    htmlCase('<base 后换行', '<base\n href="/x/">', 'S5', 1);
    htmlCase('<plaintext> 之后的伪 script（47R1a-R：两个扫描器同时误判，只有 S5 拦得住）', '<plaintext><script src="/demo.js?v=auto"></script>', 'S5', 1);
    htmlCase('<PLAINTEXT> 大写', '<PLAINTEXT>x', 'S5', 1);
    htmlCase('<!--> 空注释之后的 <base> 是活的（同时命中 S1c）', '<!--> <base href="/x/">', 'S5', 1, undefined, ['S1c']);
    htmlCase('<!---> 空注释之后的 <base> 是活的（同时命中 S1c）', '<!---> <base href="/x/">', 'S5', 1, undefined, ['S1c']);
    htmlCase('--!> 结束的注释之后（同时命中 S1c）', '<!-- x --!> <base href="/x/">', 'S5', 1, undefined, ['S1c']);

    // —— S1c ——
    htmlGreen('S1c 普通注释与空内容注释 <!---->', '<!-- x --><!----><script src="a.js?v=auto"></script>');
    htmlGreen('S1c 属性值无首尾空白', '<script src="a.js?v=auto"></script><link rel="stylesheet" href="b.css?v=auto">');
    htmlGreen('S1c 非本地引用（CDN）带空白不管', '<script src=" https://cdn.example.com/x.js "></script>');
    htmlCase('<!--> 空注释', '<!--> <p>x</p>', 'S1c', 1);
    htmlCase('<!---> 空注释', '<!---> <p>x</p>', 'S1c', 1);
    htmlCase('--!> 注释结尾', '<!-- x --!> <p>y</p>', 'S1c', 1);
    htmlCase('<script src> 值前有空白', '<script src=" a.js?v=auto"></script>', 'S1c', 1);
    htmlCase('<link href> 值后有空白', '<link rel="stylesheet" href="a.css?v=auto ">', 'S1c', 1);
    htmlCase('属性值首尾换行', '<script src="\na.js?v=auto\n"></script>', 'S1c', 1);
    htmlCase('三种注释写法各一处', '<!--> a <!---> b <!-- c --!> d', 'S1c', 3);
    // 32a-M4：原始属性值里出现 `&`（字符引用）——守卫不解码，直接判红
    htmlCase('字符引用遮住扩展名 a&#46;js?v=auto', '<script src="assets/js/a&#46;js?v=auto"></script>', 'S1c', 1, undefined, ['S2']);   // 扩展名被遮住，S1 不认它是本地 JS，同时 ?v=auto 多出一次（S2）
    htmlCase('字符引用遮住等号 a.js?v&#61;auto', '<script src="a.js?v&#61;auto"></script>', 'S1c', 1, undefined, ['S1']);   // S1：查询串不是 ?v=auto
    htmlCase('?v=auto 后接 &amp;', '<script src="a.js?v=auto&amp;x=1"></script>', 'S1c', 1, undefined, ['S1']);
    htmlCase('<link rel=stylesheet> 的 href 含字符引用', '<link rel="stylesheet" href="a&#46;css?v=auto">', 'S1c', 1, undefined, ['S2']);
    htmlGreen('CDN 的 &（非本地）不管', '<script src="https://cdn.example.com/x.js?a=1&b=2"></script>');
    // 32-R-M1：不分类型——任何 <script src> / <link rel> / <link href> 的原始值含 &，唯一例外 = src / href 以字面 https:// 开头
    htmlCase('rel 用实体遮住 style&#115;heet + href 用实体遮住扩展名（没有 ?v=auto）', '<link rel="style&#115;heet" href="a&#46;css">', 'S1c', 2);
    htmlCase('<link rel="icon"> 本地 href 含 &', '<link rel="icon" href="x.png?a=1&b=2">', 'S1c', 1);
    htmlCase('rel 本身含 &（href 是 https 也红）', '<link rel="style&#115;heet" href="https://cdn.example.com/a.css">', 'S1c', 1);
    htmlCase('src 用实体写 https&#58;// 不算例外', '<script src="https&#58;//x/a.js"></script>', 'S1c', 1);
    // 预筛 LOW-1：<script type> 里的 & 同样判红（type 被实体遮住时内联脚本不进 S3）
    htmlCase('type 被实体遮住 text/j&#97;vascript（内联脚本里有 createElement）', "<script type=\"text/j&#97;vascript\">document.createElement('script')</script>", 'S1c', 1);
    htmlGreen('type 正常的内联脚本', '<script type="text/javascript">var a = 1;</script><script type="module">var b = 2;</script>');
    htmlGreen('Google Fonts 的 https 地址含 &（字面 https:// 开头）', '<link href="https://fonts.googleapis.com/css2?family=A&display=swap">');
    htmlGreen('https 大写 HTTPS:// 开头含 &', '<script src="HTTPS://cdn.example.com/x.js?a=1&b=2"></script>');
    htmlGreen('rel / href 都没有 &', '<link rel="icon" href="favicon.ico">');
    // LOW-B：属性值中间的制表 / 换行（new URL 会去掉，S1 看不见）
    htmlCase('属性值中间有换行（a.js?v=au\\nto）', '<script src="a.js?v=au\nto"></script>', 'S1c', 1, undefined, ['S2']);   // S2 的全文正则在换行处截断，同时看到 ?v=au
    htmlCase('属性值中间有制表符', '<link rel="stylesheet" href="a.c\tss?v=auto">', 'S1c', 1);
    // LOW-C：</script / </style 后面不是 \s*>
    htmlGreen('S1c </script> </SCRIPT > </style\n> 都是中间件认得的结束标签', '<script>var a=1;</script><script>var b=2;</SCRIPT ><style>a{}</style\n>');
    htmlCase('</script/> 自闭合写法', '<script>var a=1;</script/>', 'S1c', 1);
    htmlCase('</script foo> 带属性', '<script>var a=1;</script foo>', 'S1c', 1);
    htmlCase('</STYLE x> 大写', '<style>a{}</STYLE x>', 'S1c', 1);
    htmlCase('注释里的 </script/> 也算', '<!-- </script/> -->', 'S1c', 1);
    htmlCase('</scriptx> 也不是 \\s*>', '<p>a</scriptx></p>', 'S1c', 1);

    // —— S6 ——
    const cssCase = (name, css, expectCount) => {
        const r = analyzeCssFile('a.css', css);
        check(`S6 ${expectCount ? '反例' : '正例'}·${name}`, r.findings.length === expectCount && r.findings.every((f) => f.rule === 'S6'), `期望 ${expectCount} 处，实得 ${r.findings.length}：${r.findings.map((f) => f.msg).join(' | ').slice(0, 240)}`);
    };
    cssCase('url 指向图片（本地）', 'a{background:url(assets/images/bg.png?v=2)}', 0);
    cssCase('url 指向字体与 svg', "@font-face{src:url('../fonts/a.woff2') format('woff2'),url(\"b.svg#x\")}", 0);
    cssCase('data: 目标', 'a{background:url("data:image/png;base64,AAAA")}', 0);
    cssCase('https 目标（含 .css / .js）', 'a{background:url(https://cdn.example.com/x.css)} @import url("https://fonts.example.com/x.css");', 0);
    cssCase('协议相对目标', '@import "//cdn.example.com/x.css"; a{b:url(//cdn.example.com/y.js)}', 0);
    cssCase('只在注释里', '/* @import "other.css"; url(x.css) */ a{color:red}', 0);
    cssCase('fragment 目标', 'a{filter:url(#blur)}', 0);
    cssCase('@import 本地（双引号）', '@import "other.css";', 1);
    cssCase('@import 后无空白（双引号）@import"x.css";', '@import"x.css";', 1);
    cssCase("@import 后无空白（单引号）@import'x.css';", "@import'x.css';", 1);
    cssCase('@important 之类不是 @import', 'a{b:c} /* @important */ .x{d:e}', 0);
    cssCase('@import 本地（单引号，带查询串）', "@import 'other.css?v=auto';", 1);
    cssCase('@import url() 本地（只报一处，不与 url() 重复）', '@import url(other.css);', 1);
    cssCase('@import url() 带引号', '@import url("../css/other.css") screen;', 1);
    cssCase('@import 本地且无 .css 扩展名', '@import "other";', 1);
    cssCase('url() 指向本地 .css', 'a{background:url(font.css)}', 1);
    cssCase('url() 指向本地 .css 带查询串', "a{background:url('x.css?v=auto')}", 1);
    cssCase('url() 指向本地 .js', 'a{behavior:url(../js/x.js)}', 1);
    cssCase('大写扩展名', 'a{b:url(X.CSS)}', 1);
    cssCase('一个文件里两处', '@import "a.css"; b{c:url(d.js)}', 2);
    htmlGreen('S6 <style> 块里 url 指向图片', '<style>a{background:url(a.png)}</style>');
    htmlGreen('S6 style= 属性里 url 指向图片', '<div style="background:url(\'a.png\')"></div>');
    htmlCase('<style> 块里 @import 本地', '<style>@import url(a.css);</style>', 'S6', 1);
    htmlCase('<style> 块里 url() 指向 .js', '<style>a{b:url(x.js)}</style>', 'S6', 1);
    htmlCase('style= 属性里 url() 指向 .css', '<div style="background:url(a.css)"></div>', 'S6', 1);
    htmlCase('style= 属性里 @import', "<div style='@import \"a.css\"'></div>", 'S6', 1);
    htmlCase('style= 属性里用实体写引号', '<div style="background:url(&quot;a.css&quot;)"></div>', 'S6', 1);
    {
        const r = analyzeHtml('p.html', '<p>\n</p>\n<style>\n/* c */\n@import "x.css";\n</style>', {});
        check('S6 <style> 块违规的行号 = 文件内行号', r.findings.length === 1 && r.findings[0].line === 5, JSON.stringify(r.findings));
    }

    // —— S3 补充：窗口内每一处赋值都检查（预筛 LOW-2）——
    jsCase('元素未绑定变量名时，前面别的 https 赋值不能挡住后面的本地赋值', "const s = ok ? document.createElement('script') : null; img.src = 'https://a/x.png'; s.src = 'local.js';", 1);
    // 32a-M1：绑定变量名时在整段代码里查对该变量的全部赋值，不以下一个站点为终点
    jsCase('交错创建：a 赋 https、再创建 b、再在 a.onerror 里 a.src = 本地', "var a = document.createElement('script'); a.src = 'https://x/a.js';\nvar b = document.createElement('script'); b.src = 'https://x/b.js';\na.onerror = function () { a.src = 'local.js'; };", 1);
    jsGreen('先创建两个元素再统一赋 https', "var a = document.createElement('script'); var b = document.createElement('link');\na.src = 'https://x/a.js'; b.href = 'https://x/b.css';");
    jsGreen('延后赋值：同文件后部 a.src = https', "var a = document.createElement('script');\nfunction other() { return 1; }\nvar x = document.createElement('div');\na.src = 'https://x/a.js';");
    jsCase('延后赋值：同文件后部 a.src = 本地', "var a = document.createElement('script');\nfunction other() { return 1; }\nvar x = document.createElement('div');\na.src = 'local.js';", 1);
    jsCase('第二个站点之后对第一个变量 setAttribute 本地', "var a = document.createElement('script'); a.src = 'https://x/a.js';\nvar b = document.createElement('script'); b.src = 'https://x/b.js';\na.setAttribute('src', 'local.js');", 1);
    jsCase('未绑定变量：窗口不止于下一个站点（第二个站点之后的本地赋值仍被前一个站点的窗口看到）', "document.body.appendChild(document.createElement('script')); document.body.appendChild(document.createElement('script')).src = 'https://x/a.js'; z.src = 'local.js';", 1);
    jsGreen('同样的写法全是 https 赋值时放行', "const s = ok ? document.createElement('script') : null; img.src = 'https://a/x.png'; s.src = 'https://a/x.js';");
    htmlGreen('<basefont> 不是 base', '<basefont size="3"><database></database>');
    htmlGreen('注释里的 <base>', '<!-- <base href="/x/"> -->');
    htmlGreen('<plaintextx> 不是 plaintext、注释里的 <plaintext>', '<plaintextx></plaintextx><!-- <plaintext> -->');
    htmlGreen('脚本字符串里的 <base>', "<script>var s = '<base href=x>';</script>");
    htmlGreen('style 里的 <base>', '<style>/*<base href=x>*/</style>');
    htmlGreen('未闭合注释之后的 <base>（浏览器同样吞到文件尾）', '<!-- 没有结尾 <base href=x>');

    // —— S7：两个扫描器结论全等（守卫的 ?v=auto 本地引用路径列表 vs 中间件 parsePage 的 refs）——
    {
        const S7_RED = [
            ['属性值里的 <title>（placeholder）吞掉其后的真实 script', '<input placeholder="<title>"><script src="a.js?v=auto"></script>'],
            ['属性值里的 <textarea>（data-x）吞掉其后的真实 script', '<div data-x="<textarea>"></div><script src="a.js?v=auto"></script>'],
            ['noscript 里的 <textarea> 吞掉其后的真实 script', '<noscript><textarea></noscript><script src="a.js?v=auto"></script>'],
            ['SVG 里的 <title/> 吞掉其后的真实 script', '<svg><title/></svg><script src="a.js?v=auto"></script>'],
            ['textarea 里的演示 script：守卫算引用、中间件按文本（反方向，LOW-1）', '<textarea><script src="x.js?v=auto"></script></textarea>'],
            ['属性值里的 <iframe> 吞掉其后两条真实引用', '<div title="<iframe>"></div><script src="a.js?v=auto"></script><link rel="stylesheet" href="b.css?v=auto">'],
            ['前一条被吞、后面一条（真 title 之后）仍被中间件认：条数与首项都不同', '<input placeholder="<title>"><script src="a.js?v=auto"></script><title>t</title><script src="b.js?v=auto"></script>'],
        ];
        const S7_GREEN = [
            ['普通页面：script 与 link 各一条', '<link rel="stylesheet" href="assets/css/a.css?v=auto"><script src="assets/js/a.js?v=auto"></script>'],
            ['title 正常写法', '<title>T</title><script src="a.js?v=auto"></script>'],
            ['大写 TITLE 正常写法', '<TITLE>T</TITLE><script src="a.js?v=auto"></script>'],
            ['textarea 正常表单', '<form><textarea name="x">hello</textarea></form><script src="a.js?v=auto"></script><link rel="stylesheet" href="b.css?v=auto">'],
            ['注释里写 <title>', '<!-- <title> --><script src="a.js?v=auto"></script>'],
            ['注释里写 <textarea> 之后有真 title', '<!-- <textarea> --><title>x</title><script src="a.js?v=auto"></script>'],
            ['内联脚本字符串里写 <textarea>', '<script>var s = \'<textarea>\';</script><script src="a.js?v=auto"></script>'],
            ['style 里写 <title>', '<style>/* <title> */</style><script src="a.js?v=auto"></script>'],
            ['没有任何引用的页面（两边都是 0 条）', '<p>x</p>'],
            ['路径形态：../ 相对、前导 /、无引号、?v=auto#hash', '<script src="../assets/js/a.js?v=auto#f"></script><script src=/assets/js/b.js?v=auto></script>'],
            ['路径含中文（utf8 → latin1 → utf8 往返一致）', '<script src="assets/js/中文.js?v=auto"></script>'],
            ['CDN 与非 auto 的本地引用不进两边列表', '<script src="https://cdn.example.com/x.js"></script><link rel="icon" href="favicon.ico">'],
        ];
        const s7Run = (html, deps) => {
            const a = analyzeHtml('p.html', html, {});
            return { a, s7: checkS7('p.html', html, a.autoPaths, deps) };
        };
        // 一套正反例跑一遍，返回没达到预期的用例名；deps 用来注入变异
        const s7Suite = (deps) => {
            const bad = [];
            for (const [name, html] of S7_RED) {
                const r = s7Run(html, deps);
                // 反例的其余规则必须全绿：证明这些写法只有 S7 拦得住（S1 / S2 等看不见）
                if (!(r.s7.length === 1 && r.s7[0].rule === 'S7' && r.a.findings.length === 0)) bad.push(`反例·${name}`);
            }
            for (const [name, html] of S7_GREEN) {
                const r = s7Run(html, deps);
                if (!(r.s7.length === 0 && r.a.findings.length === 0)) bad.push(`正例·${name}`);
            }
            return bad;
        };
        const real = s7Suite(undefined);
        check('S7 正反例：5 种吞引用 / 反方向写法 + 2 种组合判红 S7（其余规则全绿）、12 种正常写法全绿', real.length === 0, real.join(' | '));
        // 变异 1：比较恒相等 —— 自证：所有反例都必须因此漏判（变红），正例不受影响
        const mutAlways = s7Suite({ cmp: () => -1 });
        check('S7 变异·比较恒相等 → 自证变红（全部 7 个反例漏判，正例不变）', mutAlways.length === S7_RED.length && mutAlways.every((x) => x.startsWith('反例·')), mutAlways.join(' | '));
        // 变异 2：只比公共前缀（忽略条数差）—— 吞引用会让中间件列表变短，必须同样变红
        const mutPrefix = s7Suite({ cmp: (g, m) => { const n = Math.min(g.length, m.length); for (let i = 0; i < n; i++) if (g[i] !== m[i]) return i; return -1; } });
        check('S7 变异·只比公共前缀（忽略条数）→ 自证变红', mutPrefix.some((x) => x.startsWith('反例·')) && mutPrefix.every((x) => x.startsWith('反例·')), mutPrefix.join(' | '));
        // 变异 3：中间件列表直接取守卫的列表（比较对象被偷换）—— 同样变红
        const mutSame = s7Suite({ parse: (t) => ({ refs: analyzeHtml('p.html', Buffer.from(t, 'latin1').toString('utf8'), {}).autoPaths.map((x) => ({ x })) }) });
        check('S7 变异·中间件一侧换成守卫自己的列表 → 自证变红', mutSame.length === S7_RED.length, mutSame.join(' | '));
        // 中间件抛错 / 返回形态不对 → 判红
        const thrown = checkS7('p.html', '<p>x</p>', [], { parse: () => { throw new Error('boom'); } });
        check('S7 反例：中间件 parsePage 抛错 → 判红', thrown.length === 1 && thrown[0].rule === 'S7' && /抛错/.test(thrown[0].msg), JSON.stringify(thrown));
        const malformed = checkS7('p.html', '<p>x</p>', [], { parse: () => ({}) });
        check('S7 反例：中间件返回没有 refs → 判红（按抛错处理）', malformed.length === 1 && malformed[0].rule === 'S7', JSON.stringify(malformed));
        // 比较函数本身
        check('S7 比较：全等 / 缺项 / 多项 / 首项不同的分歧位置', compareS7(['a', 'b'], ['a', 'b']) === -1 && compareS7([], []) === -1 && compareS7(['a'], []) === 0 && compareS7(['a', 'b'], ['a']) === 1 && compareS7(['a'], ['a', 'b']) === 1 && compareS7(['a', 'b'], ['x', 'b']) === 0);
        // 报文含页面名、首个分歧位置、两边各自的列表片段
        const msgCase = s7Run('<div data-x="<textarea>"></div><script src="a.js?v=auto"></script>');
        check('S7 报文：含页面名、分歧位置与两边列表片段', msgCase.s7.length === 1 && msgCase.s7[0].file === 'p.html' && /第 1 条/.test(msgCase.s7[0].msg) && /守卫 \["a\.js"\]/.test(msgCase.s7[0].msg) && /中间件 \[\]/.test(msgCase.s7[0].msg), JSON.stringify(msgCase.s7));
    }

    // —— S4：集合 ——
    {
        const mk = (...a) => new Set(a);
        check('S4 正例：非空且与 git 集合相等', checkS4(mk('a.html', 'b.html'), mk('b.html', 'a.html'), null, []).length === 0);
        check('S4 反例：扫描集合为空', checkS4(mk(), mk(), null, []).some((f) => /应 >= 1/.test(f.msg)));
        check('S4 反例：git 有而扫描没有', checkS4(mk('a.html'), mk('a.html', 'b.html'), null, []).some((f) => /扫描漏了/.test(f.msg) && /b\.html/.test(f.msg)));
        check('S4 反例：扫描有而 git 没有', checkS4(mk('a.html', 'c.html'), mk('a.html'), null, []).some((f) => /git 可见集合里没有/.test(f.msg) && /c\.html/.test(f.msg)));
        check('S4 反例：git 读取失败', checkS4(mk('a.html'), mk(), 'boom', []).some((f) => /读取失败/.test(f.msg)));
        check('S4 反例：public 下有符号链接', checkS4(mk('a.html'), mk('a.html'), null, ['link']).some((f) => f.file === 'link'));
    }

    // —— 目录扫描（临时目录：递归、.htm / 大写扩展名、符号链接、整体联动）——
    {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-cachebust-'));
        const pub = path.join(base, 'public');
        try {
            fs.mkdirSync(path.join(pub, 'assets', 'js'), { recursive: true });
            fs.mkdirSync(path.join(pub, 'sub', 'deep'), { recursive: true });
            fs.writeFileSync(path.join(pub, 'good.html'), '<script src="assets/js/a.js?v=auto"></script>');
            fs.writeFileSync(path.join(pub, 'assets', 'js', 'a.js'), 'var a = 1;');
            const clean = runAll(pub, { set: new Set(['good.html']), error: null }, [], []);   // 第 4 个参数 = S3_SITES 登记表（合成目录用空表）
            check('目录扫描正例：干净目录无任何违规', clean.findings.length === 0 && clean.stats.pages === 1 && clean.stats.localRefs === 1, JSON.stringify(clean.findings));
            fs.writeFileSync(path.join(pub, 'sub', 'deep', 'bad.HTM'), '<base href="/x/"><script src="../../assets/js/a.js"></script>');
            fs.writeFileSync(path.join(pub, 'sub', 'Upper.HTML'), '<script src="../assets/js/a.js?v=1"></script>');
            fs.writeFileSync(path.join(pub, 'assets', 'js', 'dyn.js'), "var s = document.createElement('script'); s.src = 'assets/js/a.js';");
            fs.mkdirSync(path.join(pub, 'assets', 'css'), { recursive: true });
            fs.writeFileSync(path.join(pub, 'assets', 'css', 'bad.css'), '@import "other.css";');
            const dirty = runAll(pub, { set: new Set(['good.html', 'sub/deep/bad.HTM', 'sub/Upper.HTML']), error: null }, [], []);
            const byRule = (r) => dirty.findings.filter((f) => f.rule === r);
            check('目录扫描反例：递归到 .HTM 并报 S5 + S1', byRule('S5').some((f) => f.file === 'sub/deep/bad.HTM') && byRule('S1').some((f) => f.file === 'sub/deep/bad.HTM'), JSON.stringify(dirty.findings));
            check('目录扫描反例：扩展名大写的 .HTML 也被扫描（S1 + S2）', byRule('S1').some((f) => f.file === 'sub/Upper.HTML') && byRule('S2').some((f) => f.file === 'sub/Upper.HTML'));
            check('目录扫描反例：子目录里的 .js 被 S3 扫描', byRule('S3').some((f) => f.file === 'assets/js/dyn.js'));
            check('目录扫描反例：子目录里的 .css 被 S6 扫描，且计入 CSS 文件数', byRule('S6').some((f) => f.file === 'assets/css/bad.css') && dirty.stats.css === 1, JSON.stringify(dirty.stats));
            // S7 目录级联动：吞引用写法的页面经 runAll 也判红 S7（指向该文件），干净页面不报
            fs.writeFileSync(path.join(pub, 's7bad.html'), '<input placeholder="<title>"><script src="assets/js/a.js?v=auto"></script>');
            const s7r = runAll(pub, { set: new Set(['good.html', 'sub/deep/bad.HTM', 'sub/Upper.HTML', 's7bad.html']), error: null }, [], []);
            const s7f = s7r.findings.filter((f) => f.rule === 'S7');
            check('目录扫描反例：吞引用写法的页面 → S7 指向该文件，且只有它', s7f.length === 1 && s7f[0].file === 's7bad.html', JSON.stringify(s7f));
            fs.unlinkSync(path.join(pub, 's7bad.html'));
            const gitShort = runAll(pub, { set: new Set(['good.html']), error: null }, [], []);
            check('目录扫描反例：git 集合缺页 → S4 判红', gitShort.findings.some((f) => f.rule === 'S4' && /git 可见集合里没有/.test(f.msg)));
            let linked = false;
            try { fs.symlinkSync(path.join(pub, 'sub'), path.join(pub, 'lnk'), 'junction'); linked = true; } catch (_) { linked = false; }
            if (linked) {
                const r = runAll(pub, { set: new Set(['good.html', 'sub/deep/bad.HTM', 'sub/Upper.HTML']), error: null }, [], []);
                check('目录扫描反例：联接点 / 符号链接 → S4', r.findings.some((f) => f.rule === 'S4' && f.file === 'lnk'));
            } else {
                skipped('目录扫描反例：联接点 / 符号链接 → S4', '本机建不出联接点 / 符号链接（权限或文件系统不支持），这一条没有被验证');
            }
            const empty = path.join(base, 'empty');
            fs.mkdirSync(empty);
            const e = runAll(empty, { set: new Set(), error: null }, [], []);
            check('目录扫描反例：空目录 → S4（扫描集合为空）', e.findings.some((f) => f.rule === 'S4' && /应 >= 1/.test(f.msg)));
        } finally {
            rmTree(base);
        }
        check('临时目录已清理', !fs.existsSync(base));
    }

    // —— 真实 public：不变量对照（守卫不是恒真/恒假）——
    {
        const r = runAll(PUBLIC_DIR, gitVisibleHtml(PUBLIC_DIR), S2_EXEMPT);
        check('真实 public：本守卫当前全绿', r.findings.length === 0, r.findings.slice(0, 3).map((f) => `${f.rule} ${f.file}:${f.line} ${f.msg}`).join(' | '));
        check('真实 public：扫到的本地引用数 > 0（解析没有整体失效）', r.stats.localRefs > 0, JSON.stringify(r.stats));
    }

    console.log(`verify-shared-css-cache-bust --self-test PASS=${pass} FAIL=${fail} SKIP=${skip}`);
    return fail === 0 ? 0 : 1;
}

if (require.main === module) {
    const code = process.argv.includes('--self-test') ? selfTest() : runReal();
    process.exitCode = code;
}
module.exports = { scanHtml, attrOf, analyzeHtml, analyzeJs, analyzeJsFile, checkS4, checkS7, compareS7, runAll, collect, gitVisibleHtml, S2_EXEMPT };
