// scripts/verify-sys-timeline-summary-escape.js — siRenderTimeline summaryHtml 转义覆盖静态守卫
//   （追加批·codex 363 号 HIGH 证伪固化，2026-08-13）
//
// 背景：codex 363 报告 siRenderTimeline 的 timeline summary 存在 XSS（撤销 reason / 补验收 note 等新增
//   文本可能未转义直接拼进 innerHTML）。主会话核实：siRenderTimeline（public/Sys_Iteration.html）当前
//   全部 8 处 `summaryHtml = ` 赋值分支——含新增的 note 类型兜底分支 `e.summary ? esc(e.summary) : ''`
//   （撤销 reason / 补验收 note 均无独立分支，落在这条兜底上）——均经过 esc() 转义，**当前无 XSS**。
//   这条 HIGH 是**证伪**，不是需要修的 bug；本文件把"每个 summaryHtml 分支都必须转义"这条安全事实
//   固化成静态守卫，防未来有人加新分支时忘转义（同类先例：本仓库历史上"守卫全绿但渲染端从未生效"
//   已栽过三次，这次反过来——渲染端是安全的，但从未有守卫钉住这件事，纯属侥幸）。
//
// 用法：node scripts/verify-sys-timeline-summary-escape.js（纯文本源码扫描，无需启动 server，自包含）
//
// 判据：提取 siRenderTimeline 函数体，逐个定位 `summaryHtml = ` 顶层赋值语句（用括号/引号状态机找到
//   语句真正的结尾分号，不被模板字符串内部的字面量分号——如 `style="display:block;margin-top:6px"`——
//   提前截断），硬门断言每条语句的完整文本内须字面含 `esc(` **或** `baseSummaryHtml`（后者由本文件
//   另一条独立 check 锁定义为"两个分支均经 esc(("，是已证明的转义源，不是无条件放行——见下方
//   [长任务B S4c2] baseSummaryHtml 定义 check）。既不含 esc( 也不含 baseSummaryHtml 才判红；AST 层
//   （residualUnescapedInterpolations）作为独立叠加层，对全部语句另行复核混合拼接/局部变量绕过等
//   更细的绕过面，不是"硬门未过时的救援通道"（见 [M1 加固] 一带注释）。
//
// 边界声明（如实登记，非通用 JS 解析器）：状态机只跟踪反引号/单引号/双引号的开合边界本身，不理解
//   模板字符串内 `${...}` 插值表达式的语法结构——但这对本判据无影响：只要开合的反引号被正确识别，
//   `${...}` 内部出现的任何字符（含分号）都天然被当作"仍在模板字符串内"处理，不会被误判成语句结尾。
//   已知未覆盖形态：`${}` 插值内部若出现**未转义的嵌套反引号**（当前全文件无此写法），状态机会提前
//   判定模板字符串已关闭——这在当前代码库不可达，若未来出现需先扩展本状态机再信任其判定。
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const acorn = require('acorn');   // [G2·长任务B S4c] 表达式结构级判据用真实语法树替代纯文本 qi/branchPart 启发式

const HTML_PATH = path.join(__dirname, '..', 'public', 'Sys_Iteration.html');
const src = fs.readFileSync(HTML_PATH, 'utf8');

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++; failures.push({ name, err: e.message });
        console.log(`  ✗ ${name} — ${e.message}`);
    }
}

// 括号平衡提取函数体（同姊妹静态守卫 verify-sys-release-panel-static.js 既有范式）。
function extractFunctionBody(source, fnName) {
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

// 定位 fnBody 内全部顶层 `summaryHtml = ` 赋值语句，返回 [{ stmt: 完整语句文本（含分号） }, ...]。
// 引号/反引号状态机找真正的语句结尾分号（见文件头「判据」说明）。
function extractSummaryHtmlAssignments(fnBody) {
    const marker = 'summaryHtml = ';
    const out = [];
    let searchFrom = 0;
    while (true) {
        const idx = fnBody.indexOf(marker, searchFrom);
        if (idx < 0) break;
        let i = idx + marker.length;
        let inBacktick = false, inSingle = false, inDouble = false;
        let end = -1;
        for (; i < fnBody.length; i++) {
            const ch = fnBody[i];
            const prev = fnBody[i - 1];
            if (inBacktick) { if (ch === '`' && prev !== '\\') inBacktick = false; continue; }
            if (inSingle) { if (ch === "'" && prev !== '\\') inSingle = false; continue; }
            if (inDouble) { if (ch === '"' && prev !== '\\') inDouble = false; continue; }
            if (ch === '`') { inBacktick = true; continue; }
            if (ch === "'") { inSingle = true; continue; }
            if (ch === '"') { inDouble = true; continue; }
            if (ch === ';') { end = i; break; }
        }
        if (end < 0) throw new Error(`第 ${idx} 字符处的 summaryHtml 赋值未找到语句结尾分号（状态机可能顶到未覆盖形态，需人工核实）`);
        out.push({ idx, stmt: fnBody.slice(idx, end + 1) });
        searchFrom = end + 1;
    }
    return out;
}

console.log('— siRenderTimeline summaryHtml 转义覆盖 —');

const fnBody = extractFunctionBody(src, 'siRenderTimeline');
check('siRenderTimeline 函数体可提取（提不到=守卫空转，不能当通过）', () => {
    assert.ok(fnBody, '未提取到 siRenderTimeline 函数体');
});
if (!fnBody) { console.log('\n=== FAIL：扫描面缺失 ==='); process.exit(1); }

const assignments = extractSummaryHtmlAssignments(fnBody);
check('summaryHtml 赋值语句实抓 ≥ 8 条（过少=状态机/marker 失配，扫描面须非空，与当前源码 8 个已知分支对齐）', () => {
    assert.ok(assignments.length >= 8, `实抓 ${assignments.length} 条`);
});

// [2026-09-17 长任务 A 乙4 S4b] siRenderTimeline 新增 baseSummaryHtml（在 if/else 链之前算好、已 esc 的摘要前缀），
//   A/B 类配对分支的五条赋值以它为源拼接（不再各自写 esc(e.summary)）。⇒ 判据扩为「含 esc( 或含 baseSummaryHtml」，
//   并**另加一条** check 锁住 baseSummaryHtml 自身定义必须两个分支都经 esc——否则「认它为已转义源」就是空头支票。
check('baseSummaryHtml 定义本身两个分支都经 esc(（它是 A/B 类分支五条赋值的转义源）', () => {
    const m = fnBody.match(/const baseSummaryHtml = \(e\.event_type === 'estimate' && e\.summary\)\s*\? esc\('预计完成：' \+ e\.summary\)\s*: \(e\.summary \? esc\(e\.summary\) : ''\);/);
    assert.ok(m, 'baseSummaryHtml 定义应恰为「estimate 分支 esc(前缀+summary) : (summary ? esc(summary) : \'\')」——形态变了要重审转义面');
    assert.strictEqual((fnBody.match(/const baseSummaryHtml =/g) || []).length, 1, 'baseSummaryHtml 只应定义一次');
});
// [codex 364 号 M1 加固] "语句含 esc(" 太粗——`summaryHtml = `${esc(a)} ${e.summary}`` 这类**混合拼接**
//   （部分 esc、部分裸插值）会因整句含 esc( 而误判通过。加固到**表达式级**：剥掉全部 esc(...) 调用后，
//   残留文本里任何 `${...}` 模板插值都不得再引用**原始动态字段**（e.<x> / folded / translated / info.<x> /
//   a.<x>——siRenderTimeline 里全部动态来源）。预构建 HTML 变量（statusLine/commitsTable/addBtn 等，其内部
//   已各自 esc）以裸 `${var}` 形式插值是合法的，不在动态字段清单内故放行——只揪"原始未转义字段直接插值"。
function stripEscCalls(s) {
    // 平衡括号剥去每个 esc( ... ) 调用（含嵌套），替换成空串。
    // [S6a·codex 587-R M3] 括号计数跳过字符串/模板字面量内部（\`esc('(') + e.summary\` 原先会把后面的裸字段一起吞掉）。
    let out = '', i = 0;
    while (i < s.length) {
        if (s.startsWith('esc(', i)) {
            let depth = 0, j = i + 3, q = null;   // j 指向 '('；q=当前所在引号
            for (; j < s.length; j++) {
                const ch = s[j];
                if (q) { if (ch === '\\') { j++; continue; } if (ch === q) q = null; continue; }
                if (ch === "'" || ch === '"' || ch === '\x60') { q = ch; continue; }
                if (ch === '(') depth++;
                else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
            }
            i = j;   // 跳过整个 esc(...) 调用
        } else { out += s[i]; i++; }
    }
    return out;
}
const RAW_DYNAMIC_FIELD_RE = /\be\.\w+|\bfolded\b|\btranslated\b|\binfo\.\w+|\ba\.\w+/;
// [G2·长任务B S4c·2026-09-17] 旧版启发式判据保留改名为 xxxLegacy——只在 acorn 解析失败时兜底使用
// （见下方 residualUnescapedInterpolations 的 catch 分支），不再是主判据。
// ⚠️ 旧版病根（codex 遗留·S6a-2 registered "首个 ? 之前视条件位"）：`qi = residue.indexOf('?')` 把
//   "残留文本里第一次出现的 '?' 字符"直接当成"某个三元表达式的问号"，'?' 之前的**整段文本**（无论
//   隔着多少无关代码）一律当条件位放行——对以下三类都会漏检：
//   ① 该 '?' 根本不属于离它最近的动态字段所在的三元（`esc('') + (e.summary) + (true ? '' : '')`，
//      `(e.summary)` 与后面那个不相关的 `true ? '' : ''` 之间隔着一次加号拼接，却被当条件位放过）；
//   ② 该 '?' 出现在字符串字面量内部（`(e.summary) + "abc?xyz"`，字符串里的 '?' 不是任何三元的问号）；
//   ③ 该 '?' 是可选链 `?.` 或空值合并 `??` 的一部分，不是三元判断符（`(e.summary) + (a?.foo || '')`
//      / `(e.summary) + (a ?? '')`）。
function residualUnescapedInterpolationsLegacy(stmt) {
    const residue = stripEscCalls(stmt);
    const bad = [];
    // 扫残留里的 `${...}` 插值（非嵌套已足够——siRenderTimeline 无 `${}` 内再套 `${}`）
    for (const m of residue.matchAll(/\$\{([^}]*)\}/g)) {
        if (RAW_DYNAMIC_FIELD_RE.test(m[1])) bad.push(m[0]);
    }
    const CONCAT_RE = /\+\s*(e\.\w+|folded|translated|info\.\w+|a\.\w+)\b|\b(e\.\w+|folded|translated|info\.\w+|a\.\w+)\s*\+/g;
    for (const m of residue.matchAll(CONCAT_RE)) bad.push('+拼接:' + m[0].trim());
    const qi = residue.indexOf('?');
    const branchPart = (qi >= 0 ? residue.slice(qi) : residue).replace(/\$\{[^}]*\}/g, '');
    for (const m of branchPart.matchAll(/\b(e\.\w+|folded|translated|info\.\w+|a\.\w+)\b/g)) bad.push('裸引用:' + m[0]);
    return bad;
}

// [G2·长任务B S4c·2026-09-17] 表达式结构级判据（acorn 真实语法树，替代 qi/branchPart 纯文本启发式）：
//   剥 esc(...) 调用范围（含参数，天然安全）与三元表达式 .test 范围（真正的"条件位"，只此一处豁免，
//   分支位 .consequent/.alternate 不豁免）之外，任何"动态字段引用"（e.<x>/info.<x>/a.<x> 的 MemberExpression，
//   或裸 folded/translated 标识符）一律判红——用真实语法树天然规避字符串内的 '?'、可选链 `?.`、空值
//   合并 `??` 被误判成三元判断符这三类漏检（旧版 residualUnescapedInterpolationsLegacy 的病根，见上）。
function walkAstNodes(node, visit) {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    visit(node);
    for (const key in node) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
        const val = node[key];
        if (Array.isArray(val)) { for (const item of val) walkAstNodes(item, visit); }
        else if (val && typeof val === 'object' && typeof val.type === 'string') walkAstNodes(val, visit);
    }
}

// [G2 补丁·2026-09-17·记忆坑 28"认变量为已转义源必配加号拼接变异"] 上一版只把 e.*/info.*/a.*/folded/
//   translated 当"动态字段"，任何**局部变量**（如 withdrawNote/withdrawMainText/withdrawCommitsHtml）
//   一旦插值进模板/拼接，只要变量名不在这五个模式里就直接判安全——从未回溯这些局部变量自己的定义是否
//   真的经过 esc。攻击面：`const withdrawNote = e.summary;` 再 `${withdrawNote}`，旧版全程绿灯。
//   本节把"判定一个表达式是否安全"抽成可递归的 collectOutputRefs——只选择性下探"真正可能进入渲染输出"
//   的位置（模板插值 / 加号拼接 / 三元的 consequent&alternate），不下探：
//     · 任意函数调用（含 esc）的参数——整个调用视为一次"输出安全边界"，不深入证明其内部实现是否安全
//       （本仓约定：具名 render helper 各自内部转义，同 siRenderReleasePublishedCommits/siTlChangesHtml
//       等既有先例；若收紧到只信任 esc，commitsTable/changesHtmlA 这类既有安全代码会被误判不安全）。
//     · 三元表达式的 .test（条件位，其求值结果本身不会被拼进 HTML）。
//   剩下裸露的 e./info./a./folded/translated 直接判红；剩下的裸标识符（非以上五种）收集为"局部变量候选"，
//   交给 isLocalVarSafe 递归回溯其 const/let 定义，直到证明安全、证明不安全，或递归深度超过上限。
//
// [G2 补丁 v2·2026-09-17 收紧①] "任意函数调用整体视为输出安全边界"太宽——`${String(e.summary)}`、
//   `${[e.summary].join('')}` 这类会被一律放行，等于给绕过开了后门。改为**显式白名单**（TRUSTED_HTML_
//   CALLEE_NAMES，见下方常量定义 + 逐个可信依据）：只有白名单内的调用才整体信任、不深入参数；白名单
//   外的任意调用（含 String/join/其它未来新增的 helper）一律"打开参数继续查"——参数里若含裸 rawRefs
//   或未证明安全的局部变量，一样判红，不因为套了一层不认识的函数调用就蒙混过关。
const TRUSTED_HTML_CALLEE_NAMES = new Set([
    // siRenderReleasePublishedCommits(commits)（public/Sys_Iteration.html :4529 一带）——内部逐字段
    // esc(devName)/组件标签走 SI_COMMIT_COMPONENT_LABEL 白名单或 esc(c.component)/esc(refText)/
    // esc(siFmtDT(...))，返回值全程转义拼接后再 join，commitsTable 靠它才安全。
    'siRenderReleasePublishedCommits',
    // siTlChangesHtml(e, parsedPayload)（:4779 一带）——内部只调用 siRenderTimelineChanges 与
    // siTlChangeObjectText 两个函数，changesHtmlA/changesHtmlB 靠它才安全，最终转义责任落在下一条。
    'siTlChangesHtml',
    // siRenderTimelineChanges(changes, objectText)（:4737 一带）——内部 esc(label)/esc(objectText)/
    // siTlChangeValueHtml(...)（该函数同样内部处处 esc）/esc(labels.join(...))，逐字段转义后拼接。
    'siRenderTimelineChanges',
    // [#83·S2 续做] siRenderAttachListHtml(attachPayload, actionCode)（public/Sys_Iteration.html :4862
    // 一带，附件增删三码「读侧校验 + <li> 列表渲染」）——返回 { valid, html }，html 内每个字段（id/文件名/
    // 类型词/原上传人）各自独立 esc() 包裹后拼接（removed 分支与 added/replaced 分支各自一条独立赋值语句，
    // 均字面含 esc(）。登记原因：原实现内联在 siRenderTimeline 分支里，局部变量经 attachments→attachPayload
    // →parsedPayload 三级间接引用，触发 isLocalVarSafe 的递归深度上限（3）被 fail-closed 判"不安全"——
    // 不是真实转义缺口（人工审计过：每个输出字段都在函数体内被 esc() 包裹），是"局部变量间接链过深"这个
    // 结构性限制。抽成具名函数、调用点只留一次函数调用，与本表其余三个既有 helper 同款处置。
    'siRenderAttachListHtml',
]);
// ⚠️ 刻意**不**放进白名单的既有 helper（如 siFmtDT/siFmtDTSec/siStatusDisplay/
//   siFormatReleasePublishedSummary）——grep 现场逐处核实过，fnBody 里它们的全部用法要么已被外层
//   `esc(siXxx(...))` 包裹（siFmtDT/siFmtDTSec/siStatusDisplay），要么返回值本身不直接拼进 HTML、
//   各字段各自另经 esc/受信 helper 处理（siFormatReleasePublishedSummary 返回的 info 对象）。现在放进
//   白名单没有实际收益，反而白白扩大信任面——万一以后有人新增一处不经 esc 包裹就直接使用它们的写法，
//   本判据仍应正确拦下，而不是因为"历史上一直安全"就永久免检。
// [长任务B S4c2·codex 590 裁定·2026-09-17] collectOutputRefs 现须接收 defsMap（当前作用域的局部变量
//   定义表），用于两处收紧：① CallExpression 的白名单信任必须先确认该调用名**未被同作用域的局部
//   const/let 遮蔽**（坑：`const siTlChangesHtml = v => v;` 用同名局部变量顶替真正的具名函数声明，
//   旧版按纯文本名字匹配会继续误信）；② 本函数不再对外暴露"删除白名单"这条字面指令的全部后果——
//   经验证，若把 siRenderReleasePublishedCommits/siTlChangesHtml/siRenderTimelineChanges 三个已审计
//   安全的具名 helper 从信任判据里整体拿掉，会让真实 fnBody 里既有的安全语句（如 :4888 一带
//   `${commitsTable}`，commitsTable = siRenderReleasePublishedCommists(info.commits)）被 AST 叠加层
//   判红——而这条语句本身已通过硬门（文本含 esc(）。裁定：保留这三个"人工审计过内部全程转义"的具名
//   白名单（不再是"删除"，是"删除纯文本匹配的信任方式"），改为"白名单命中 且 未被局部变量遮蔽"才信任；
//   遮蔽时同任意未知调用一样打开 callee+arguments 继续查——这正是关掉 codex 590 M4 第 6 组绕过
//   （具名 helper 被同名局部变量顶替）的关键，且不引入"任意具名函数都天然可信"的过度信任面。
function collectOutputRefs(node, defsMap) {
    const rawRefs = [], localIdRefs = [];
    function visit(n) {
        if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
        if (n.type === 'MemberExpression') {
            // [codex 590 M4-①·收紧] 对原始字段对象（e/info/a）的任意属性访问——不论点号还是**计算属性**
            // （`e['summary']`），也不论属性名是不是 'length'——一律直接判定为裸引用。旧版先判"是否
            // 是 .length"再判"对象是否是 e/info/a"，顺序颠倒导致 `e.length` 这种"属性名恰好是 length
            // 但对象就是原始字段本身"的写法被 .length 分支抢先放行（codex 590 M4-③ 复现的正是这条）。
            // 现在把"对象直接是 e/info/a"这条判据前移到最前面，任何属性访问方式都不再有特例。
            if (n.object.type === 'Identifier' && ['e', 'info', 'a'].includes(n.object.name)) {
                const propText = !n.computed && n.property.type === 'Identifier'
                    ? n.property.name
                    : (n.computed && n.property.type === 'Literal' ? String(n.property.value) : '[computed]');
                rawRefs.push({ start: n.start, end: n.end, text: n.object.name + '.' + propText });
                return;
            }
            // [长任务B S4c3·codex 591-R H1] 彻底删除原「.length 恒安全」全局豁免——那条豁免正是 codex
            // 591-R 报告的"混合拼接绕过硬门"根因之一：`const x = JSON.parse(e.payload_json);
            // summaryHtml = `${esc(e.summary)}${x.length}`;` 这类语句，整句字面含 esc( 能过硬门，
            // `x.length` 又因"属性名是 length 就直接放行"逃过 AST 叠加层，两层判据被同一处豁免同时
            // 绕过。现在 `.length` 不再享有任何特例——它和其它属性访问一样，落到下面的通用分支：
            // 对象本身若是裸 e/info/a 已在上面的分支判红；对象若是局部变量，则该局部变量必须能被
            // isLocalVarSafe 证明安全（回溯到其定义），证明不了就判红。真实 dev_withdraw 分支
            // （:5020 一带）已同步改为 `esc(String(withdrawCommits.length))`——展示处显式转义，
            // 不再依赖"这是数字，天然安全"的静态豁免，判据与实作两边同步收紧，不产生真实回归。
            visit(n.object);
            if (n.computed) visit(n.property);
            return;
        }
        if (n.type === 'CallExpression') {
            if (n.callee.type === 'Identifier') {
                // [codex 590 M4-⑥] 白名单信任现须先确认调用名未被同作用域局部变量遮蔽——见本函数头注。
                const shadowed = !!(defsMap && defsMap.has(n.callee.name));
                if (!shadowed && (n.callee.name === 'esc' || TRUSTED_HTML_CALLEE_NAMES.has(n.callee.name))) {
                    return;   // 白名单调用（含 esc）且未被局部遮蔽——信任其返回值整体安全，不深入参数
                }
                // 未命中白名单，或命中但被局部变量遮蔽——按普通调用打开参数继续查（`String(e.summary)`
                // /被顶替的 siTlChangesHtml(e.summary) 均落这条路径）。裸标识符 callee 本身是函数引用
                // 不是数据，不必下探。
                for (const arg of n.arguments) visit(arg);
                return;
            }
            // 非裸标识符 callee（方法调用形态，如 `[e.summary].join('')` 的 callee 是
            // MemberExpression `[e.summary].join`，或 `JSON.parse(...)` 的 callee 是
            // MemberExpression `JSON.parse`）——callee 也要下探，裸字段可能就藏在 callee 的 object
            // 部分（`[e.summary]`），只查 arguments 会漏掉它。
            visit(n.callee);
            for (const arg of n.arguments) visit(arg);
            return;
        }
        if (n.type === 'ConditionalExpression') {
            visit(n.consequent);
            visit(n.alternate);
            return;   // 不下探 .test（条件位不进入输出，同既有 conditionalTestRanges 豁免精神，改用选择性递归实现）
        }
        // [S4c3·M5c 自测踩坑修正] ObjectExpression 的 Property 节点——非计算属性的 key（如 `{value:
        // 'safe'}` 里的 `value`）只是字段名字面量，不是变量引用，不该下探（否则会被通用 Identifier
        // 分支误当成"局部变量候选"）；只有 computed（`{[expr]: val}`）时 key 才是真正需要求值的表达式，
        // 才下探。value 一律要下探（它才是真正的字段内容）。仅当本判据构造 synthetic MemberExpression
        // 回溯到 ObjectExpression 字面量时才会摸到 Property 节点，属于既有选择性下探范式的自然补全。
        if (n.type === 'Property') {
            if (n.computed) visit(n.key);
            visit(n.value);
            return;
        }
        if (n.type === 'Identifier') {
            // [codex 590 M4-②] 裸引用原始字段对象本身（不带属性访问，如 `const raw = e;` 里的 `e`）
            // 此前"防御性跳过"当成天然安全——但这正是别名绕过的入口：把整个 e/info/a 赋给一个局部变量，
            // 再通过该局部变量的属性访问（`raw.summary`）读取任意字段，本判据从未在别名定义处标记
            // 危险。现在把裸标识符本身也计入裸引用，让 `const raw = e;` 这条定义在 isLocalVarSafe
            // 回溯时直接判定为不安全，连带 raw.summary 一起判红。
            if (['e', 'info', 'a'].includes(n.name)) { rawRefs.push({ start: n.start, end: n.end, text: n.name }); return; }
            if (n.name === 'folded' || n.name === 'translated') { rawRefs.push({ start: n.start, end: n.end, text: n.name }); return; }
            localIdRefs.push(n);
            return;
        }
        for (const key in n) {
            if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range') continue;
            const val = n[key];
            if (Array.isArray(val)) { for (const item of val) visit(item); }
            else if (val && typeof val === 'object' && typeof val.type === 'string') visit(val);
        }
    }
    visit(node);
    return { rawRefs, localIdRefs };
}

// 从任意函数体文本（`{ ... }`，含 fnBody 本体或 mutated 反例用的合成片段）里找出该变量的**全部**写入点，
// 按变量名分组收集其"新写入值"表达式节点（同名多处——不同 if/else 分支各自声明/赋值——按全部计入，
// 调用方须逐条都判定安全才算安全）。两类写入点：
//   ① `const|let <name> = <expr>`（VariableDeclarator，含初始化值）
//   ② `<name> = <expr>` / `<name> += <expr>` 等裸再赋值（AssignmentExpression，含各种复合赋值运算符）——
//      [G2 补丁 v2·2026-09-17 收口①] 此前只认①，遗漏了`let x = ''; if (c) { x = e.summary; }`这种"先安全
//      初始化、再条件性写入真正内容"的形态（现场 perDevReasonHtml/withdrawCommitsHtml 正是这种写法）：
//      只看①会恒见到那个安全的初始空串，看不到真正写进去的内容，让本该判红的场景被放过。
//      复合赋值运算符（`+=`/`??=`等）语义上新值 = 旧值×运算符×右侧表达式，但本判据只保守检查**右侧
//      表达式本身**是否安全——旧值是否安全由它自己那次写入点单独判定（同一变量所有写入点都要过），
//      不因为这次是 `+=` 就放松或加严，避免过度设计。
// [长任务B S4c2·codex 590 M4-⑤] 解构赋值/解构声明（`const {summary: x} = e;` / `({summary: x} = e);`）
//   此前完全不进 defsMap——`decl.id.type === 'Identifier'` / `node.left.type === 'Identifier'` 两处判据
//   只认简单标识符左值，ObjectPattern/ArrayPattern 直接被跳过，等于"局部变量从解构里取到的内容"对本
//   判据完全隐形。递归把模式（pattern）与来源表达式（source）逐层对应：ObjectPattern 的每个属性
//   `{key: value}` 对应"取 source 的 key 属性"（构造一个合成 MemberExpression 节点交给 collectOutputRefs
//   按普通属性访问处理，天然复用 e/info/a 直接访问的判红逻辑）；ArrayPattern 保守地让每个元素整体
//   继承 source（数组解构无法从模式本身推断具体下标语义，保守=不安全时也不放过）。
// [长任务B S4c3·codex 591-R M5·主会话亲核订正] 收集一个绑定模式（Identifier/ObjectPattern/ArrayPattern/
// AssignmentPattern/RestElement）里全部被声明的标识符名——供 AssignmentPattern 分支给"默认值表达式"
// 也登记一条定义来源时使用（需要知道 left 侧到底绑定了哪些名字）。
function collectPatternIdentifierNames(patternNode, names) {
    names = names || [];
    if (!patternNode) return names;
    if (patternNode.type === 'Identifier') { names.push(patternNode.name); return names; }
    if (patternNode.type === 'ObjectPattern') {
        for (const prop of patternNode.properties) {
            collectPatternIdentifierNames(prop.type === 'RestElement' ? prop.argument : prop.value, names);
        }
        return names;
    }
    if (patternNode.type === 'ArrayPattern') {
        for (const el of patternNode.elements) { if (el) collectPatternIdentifierNames(el, names); }
        return names;
    }
    if (patternNode.type === 'AssignmentPattern') return collectPatternIdentifierNames(patternNode.left, names);
    if (patternNode.type === 'RestElement') return collectPatternIdentifierNames(patternNode.argument, names);
    return names;
}
function addDestructuringDefs(patternNode, sourceNode, addDef) {
    if (!patternNode || !sourceNode) return;
    if (patternNode.type === 'ObjectPattern') {
        for (const prop of patternNode.properties) {
            if (prop.type === 'RestElement') { addDestructuringDefs(prop.argument, sourceNode, addDef); continue; }
            const synthetic = {
                type: 'MemberExpression', object: sourceNode, property: prop.key,
                computed: !!prop.computed, start: prop.start, end: prop.end,
            };
            if (prop.value.type === 'Identifier') addDef(prop.value.name, synthetic);
            else addDestructuringDefs(prop.value, synthetic, addDef);
        }
    } else if (patternNode.type === 'ArrayPattern') {
        for (const el of patternNode.elements) {
            if (!el) continue;
            if (el.type === 'RestElement') { addDestructuringDefs(el.argument, sourceNode, addDef); continue; }
            if (el.type === 'Identifier') addDef(el.name, sourceNode);
            else addDestructuringDefs(el, sourceNode, addDef);
        }
    } else if (patternNode.type === 'AssignmentPattern') {
        addDestructuringDefs(patternNode.left, sourceNode, addDef);
        // [S4c3·M5·主会话亲核订正] 默认值表达式（right）本身也是该变量的一处定义来源——
        // `{value: x = e.summary} = {}` 一旦 source 里没有 value 键（或为 undefined），x 的值
        // 就是这条默认值表达式本身，必须同样接受 isLocalVarSafe 校验；此前只递归 left（"从
        // source 取值"这一条路径），默认值分支从未进 defsMap，是判据的真实空转，不是"已覆盖"。
        // left 侧可能是嵌套模式（含多个名字，甚至嵌套 AssignmentPattern），逐个都要挂上这条来源。
        for (const name of collectPatternIdentifierNames(patternNode.left)) addDef(name, patternNode.right);
    } else if (patternNode.type === 'Identifier') {
        addDef(patternNode.name, sourceNode);
    }
}

function buildLocalVarDefsMap(fnBodyText) {
    let ast;
    try {
        ast = acorn.parse(`function __siEscGuardWrap() ${fnBodyText}`, { ecmaVersion: 'latest' });
    } catch (e) {
        return null;
    }
    const map = new Map();
    const addDef = (name, exprNode) => {
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(exprNode);
    };
    walkAstNodes(ast, (node) => {
        if (node.type === 'VariableDeclaration' && (node.kind === 'const' || node.kind === 'let')) {
            for (const decl of node.declarations) {
                if (!decl.init) continue;
                if (decl.id.type === 'Identifier') addDef(decl.id.name, decl.init);
                else addDestructuringDefs(decl.id, decl.init, addDef);
            }
        } else if (node.type === 'AssignmentExpression') {
            if (node.left.type === 'Identifier') addDef(node.left.name, node.right);
            else addDestructuringDefs(node.left, node.right, addDef);
        }
    });
    return map;
}

const LOCAL_VAR_RESOLVE_MAX_DEPTH = 3;
// 递归判定局部变量 name 是否"已证明安全"——沿 defsMap 找其 const/let 定义，对每份定义用 collectOutputRefs
// 复核：出现裸 rawRefs 直接不安全；出现的局部变量候选再递归（depth+1），直到全部定义都安全才判安全。
// trail 只用于报错文案（回溯链路），不参与判定逻辑。
function isLocalVarSafe(name, defsMap, depth, trail) {
    if (depth > LOCAL_VAR_RESOLVE_MAX_DEPTH) {
        return { safe: false, reason: `局部变量回溯链 ${trail.join(' → ')} 超过递归深度上限(${LOCAL_VAR_RESOLVE_MAX_DEPTH})，判定不安全（fail-closed，不无限递归）` };
    }
    if (!defsMap) {
        return { safe: false, reason: `局部变量定义映射不可用（源码解析失败），无法回溯 ${name}` };
    }
    const defs = defsMap.get(name);
    if (!defs || defs.length === 0) {
        return { safe: false, reason: `找不到局部变量 ${name} 的 const/let 定义` };
    }
    for (const initNode of defs) {
        const { rawRefs, localIdRefs } = collectOutputRefs(initNode, defsMap);
        if (rawRefs.length > 0) {
            return { safe: false, reason: `${name} 的某处定义直接暴露裸动态字段 ${rawRefs.map(r => r.text).join('、')}` };
        }
        for (const idNode of localIdRefs) {
            const sub = isLocalVarSafe(idNode.name, defsMap, depth + 1, [...trail, idNode.name]);
            if (!sub.safe) return sub;
        }
    }
    return { safe: true };
}

// 真实 siRenderTimeline 函数体的局部变量定义映射——模块级只构建一次，供全部默认调用复用；mutated 反例
// 通过给 residualUnescapedInterpolations 传第二参自定义 defsMap，不影响这份真实映射。
const SI_RENDER_TIMELINE_LOCAL_VAR_DEFS = buildLocalVarDefsMap(fnBody);

function residualUnescapedInterpolations(stmt, defsMap = SI_RENDER_TIMELINE_LOCAL_VAR_DEFS) {
    let ast;
    try {
        ast = acorn.parse(stmt, { ecmaVersion: 'latest' });
    } catch (e) {
        // 解析失败——回退旧版启发式判据兜底判定，同时显式推一条不可忽略的标记（判红提示：不静默退化，
        // 调用方看到的 bad 数组里会带上这条，一眼看出"本条语句走了兜底路径、结论可信度低于 AST 判据"）。
        return [...residualUnescapedInterpolationsLegacy(stmt), `ACORN_PARSE_FALLBACK:${e.message}`];
    }
    // [G2 补丁·2026-09-17 自测踩坑修正] 只分析赋值表达式的**右侧**（真正被写入 summaryHtml 的值），不能对
    // 整条语句（含左侧 `summaryHtml` 这个 Identifier 本身）跑 collectOutputRefs——否则 `summaryHtml` 自己
    // 会被当成"候选局部变量"去 defsMap 里找定义，天然找不到（它是赋值目标，不是普通局部变量），导致
    // **任何**语句都被误判"局部变量未证明已转义:summaryHtml"（本次改造过程中实测踩过、已修正）。
    const stmtNode = ast.body[0];
    const rhs = (stmtNode && stmtNode.type === 'ExpressionStatement'
        && stmtNode.expression.type === 'AssignmentExpression')
        ? stmtNode.expression.right : null;
    if (!rhs) {
        // 形状不符预期（理论上 extractSummaryHtmlAssignments 抓到的恒是 `summaryHtml = <expr>;`）——
        // fail-closed 回退旧版启发式兜底，同样显式打标记，不静默当空转处理。
        return [...residualUnescapedInterpolationsLegacy(stmt), 'ACORN_UNEXPECTED_SHAPE:非预期的 summaryHtml 赋值语句形状'];
    }
    const { rawRefs, localIdRefs } = collectOutputRefs(rhs, defsMap);
    const bad = rawRefs.map(r => '裸引用:' + r.text);
    for (const idNode of localIdRefs) {
        const result = isLocalVarSafe(idNode.name, defsMap, 1, [idNode.name]);
        if (!result.safe) bad.push(`局部变量未证明已转义:${idNode.name}（${result.reason}）`);
    }
    return bad;
}
check('[G2 补丁前置] SI_RENDER_TIMELINE_LOCAL_VAR_DEFS 局部变量定义映射构建成功（提不到=局部变量递归判据整体空转，任何局部变量引用都会被判"定义映射不可用"而误报不安全）', () => {
    assert.ok(SI_RENDER_TIMELINE_LOCAL_VAR_DEFS, 'siRenderTimeline 函数体解析失败，未能构建局部变量定义映射');
    assert.ok(SI_RENDER_TIMELINE_LOCAL_VAR_DEFS.has('baseSummaryHtml'), '局部变量定义映射应至少含 baseSummaryHtml（siRenderTimeline 内已知必有的局部变量，缺失说明映射构建有误）');
});
// [G2·长任务B S4c·2026-09-17 位置说明] 本 check 依赖 residualUnescapedInterpolations（连同它默认参数
//   引用的 SI_RENDER_TIMELINE_LOCAL_VAR_DEFS），故物理位置必须在两者定义**之后**——原实现把这条 check
//   放在文件更靠前处（紧跟 baseSummaryHtml 定义 check 之后），而 residualUnescapedInterpolations 用
//   `const`（非 `function` 声明）的默认参数值引用 SI_RENDER_TIMELINE_LOCAL_VAR_DEFS，`const` 无变量提升
//   的 TDZ 保护——check() 是立即执行，若这条 check 排在 `const SI_RENDER_TIMELINE_LOCAL_VAR_DEFS = ...`
//   之前运行到，会直接抛 `Cannot access 'SI_RENDER_TIMELINE_LOCAL_VAR_DEFS' before initialization`（本次
//   改造过程中实测踩过一次，移到此处即修复，非事后无因由重排）。
check('[S4c3·M2 措辞订正] 全部 summaryHtml 赋值语句均转义安全（硬门：语句文本须字面含 esc( 或 baseSummaryHtml——后者由独立 check 锁定义为两分支均经 esc(，是已证明的转义源；不是"任何不含 esc( 都判红"，也不再退 AST 复核放行）', () => {
    // [长任务B S4c2·codex 590 裁定] G2 曾把本检查改成"快速通道未命中就退到 AST 判据复核，AST 也判安全
    //   才放过"——这条"退 AST 放行"恰是 codex 590 三个 HIGH 的共同根因：AST 判据本身当时仍带
    //   .length 全局豁免/白名单纯文本匹配等漏洞，被这条"退路"当成第二次机会去合理化本该判红的语句。
    //   裁定：本检查恢复成纯文本硬门——语句文本不含 esc( 且不含 baseSummaryHtml，直接判红，不再有任何
    //   退路。AST 判据（residualUnescapedInterpolations）保留为**独立叠加层**，即下方 [M1 加固] 检查，
    //   对全部语句照跑不误，两层判据各自独立把关，互不做对方的"救援通道"。
    //   真实 dev_withdraw 分支（:5020 一带，S3c 已改为单条内联 esc( 的赋值）本身就含字面量 "esc("，
    //   走这条硬门直接通过，不依赖 AST 判据。
    const unescaped = assignments.filter(a => !a.stmt.includes('esc(') && !/\bbaseSummaryHtml\b/.test(a.stmt));
    if (unescaped.length > 0) {
        const detail = unescaped.map(a => `第 ${a.idx} 字符处：${a.stmt.slice(0, 120)}${a.stmt.length > 120 ? '…' : ''}`).join('\n    ');
        throw new Error(`${unescaped.length} 条赋值语句未见 esc(/baseSummaryHtml，存在未转义拼接 innerHTML 的风险：\n    ${detail}`);
    }
});
check('[M1 加固·表达式级] 剥离 esc(...) 后残留 ${...} 插值不得引用原始动态字段（拦混合拼接）', () => {
    const mixed = assignments
        .map(a => ({ a, bad: residualUnescapedInterpolations(a.stmt) }))
        .filter(x => x.bad.length > 0);
    if (mixed.length > 0) {
        const detail = mixed.map(x => `第 ${x.a.idx} 字符处残留未转义插值 ${JSON.stringify(x.bad)}：${x.a.stmt.slice(0, 140)}${x.a.stmt.length > 140 ? '…' : ''}`).join('\n    ');
        throw new Error(`${mixed.length} 条赋值语句剥 esc 后仍有原始动态字段裸插值（混合拼接·XSS 面）：\n    ${detail}`);
    }
});
check('★对照组·S4d2：加号拼接 `baseSummaryHtml + changesHtmlA + e.summary` / `+ e.operator_name` 应被判红；纯 `baseSummaryHtml + changesHtmlA` 与条件位 `e.summary ? esc(e.summary) : \'\'` 不误判', () => {
    assert.ok(residualUnescapedInterpolations('summaryHtml = baseSummaryHtml + changesHtmlA + e.summary;').length > 0, '加号拼接 e.summary 应判红');
    assert.ok(residualUnescapedInterpolations('summaryHtml = baseSummaryHtml + changesHtmlA + e.operator_name;').length > 0, '加号拼接 e.operator_name 应判红');
    assert.ok(residualUnescapedInterpolations("summaryHtml = e.summary + '<b>x</b>';").length > 0, '动态字段在加号左侧也应判红');
    assert.strictEqual(residualUnescapedInterpolations('summaryHtml = baseSummaryHtml + changesHtmlA;').length, 0, '纯预转义变量拼接不应误判');
    assert.strictEqual(residualUnescapedInterpolations("summaryHtml = e.summary ? esc(e.summary) : '';").length, 0, '条件位动态字段不应误判');
    assert.strictEqual(residualUnescapedInterpolations("summaryHtml = esc('预计完成：' + e.summary);").length, 0, 'esc 内部的加号不应误判（已被剥掉）');
    // [S6a·587-R M3 三组反例]
    assert.ok(residualUnescapedInterpolations('summaryHtml = baseSummaryHtml + (e.summary);').length > 0, '括号包裹的裸字段应判红');
    assert.ok(residualUnescapedInterpolations('summaryHtml = e.summary ? e.summary : baseSummaryHtml;').length > 0, '三元分支位的裸字段应判红（条件位豁免不覆盖分支位）');
    assert.ok(residualUnescapedInterpolations("summaryHtml = esc('(') + e.summary;").length > 0, "esc('(') 内的字符串括号不得吞掉后续裸字段");
    assert.strictEqual(residualUnescapedInterpolations("summaryHtml = (e.summary && e.summary.length > 60) ? esc(e.summary) : '';").length, 0, '&& 前的守卫位不应误判');
});
check('★对照组：混合拼接 `${esc(a)} ${e.summary}` 应被 M1 加固判红（证明非恒真）', () => {
    const mixedStmt = 'summaryHtml = `<span>${esc(e.operator_name)} ${e.summary}</span>`;';
    const bad = residualUnescapedInterpolations(mixedStmt);
    assert.strictEqual(bad.length, 1, `对照组应恰判红 1 处裸插值，实得 ${bad.length}：${JSON.stringify(bad)}`);
    assert.ok(bad[0].includes('e.summary'), `判红的应是裸 \${e.summary}，实得 ${bad[0]}`);
});
check('★对照组：预构建 HTML 变量 `${statusLine}` 不被 M1 加固误伤（放行合法裸插值）', () => {
    const okStmt = 'summaryHtml = `<details><summary>${esc(info.brief)}</summary>${statusLine}${commitsTable}</details>`;';
    const bad = residualUnescapedInterpolations(okStmt);
    assert.strictEqual(bad.length, 0, `预构建变量插值不应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2：真三元判断符 test 位是唯一豁免的「条件位」——不相关三元不得连带豁免其前的裸字段（旧版 legacy 判据在此漏检，AST 判据须判红）', () => {
    // 旧版病根①：`qi = residue.indexOf('?')` 把"残留文本里第一个 '?'"当条件位分界，不管这个 '?'
    // 是否真的属于紧邻的表达式——这里 (e.summary) 与后面无关的 `true ? '' : ''` 之间隔着一次加号
    // 拼接，旧版会把 (e.summary) 也算进"条件位之前"而放过。
    const stmt = "summaryHtml = esc('') + (e.summary) + (true ? '' : '');";
    const badAst = residualUnescapedInterpolations(stmt);
    assert.ok(badAst.some(b => b.includes('e.summary')), `AST 判据应判红括号包裹的裸字段，实得 ${JSON.stringify(badAst)}`);
    const badLegacy = residualUnescapedInterpolationsLegacy(stmt);
    assert.strictEqual(badLegacy.length, 0, `旧版判据应在此漏检（0 项，用于证明 AST 判据确有改进，若此断言失败说明旧版已被其它改动意外修复，需重估 G2 是否仍必要）——旧版实得 ${JSON.stringify(badLegacy)}`);
});
check('★对照组·G2：字符串字面量内部的 "?" 不是三元判断符，不得连带豁免其前的裸字段（旧版漏检）', () => {
    const stmt = 'summaryHtml = (e.summary) + "abc?xyz";';
    const badAst = residualUnescapedInterpolations(stmt);
    assert.ok(badAst.some(b => b.includes('e.summary')), `AST 判据应判红，实得 ${JSON.stringify(badAst)}`);
    const badLegacy = residualUnescapedInterpolationsLegacy(stmt);
    assert.strictEqual(badLegacy.length, 0, `旧版判据应在此漏检（字符串内的 '?' 被误当条件位分界），实得 ${JSON.stringify(badLegacy)}`);
});
check('★对照组·G2：可选链 `?.` 不是三元判断符，不得连带豁免其前的裸字段（旧版漏检）', () => {
    const stmt = "summaryHtml = (e.summary) + (a?.foo || '');";
    const badAst = residualUnescapedInterpolations(stmt);
    assert.ok(badAst.some(b => b.includes('e.summary')), `AST 判据应判红，实得 ${JSON.stringify(badAst)}`);
    const badLegacy = residualUnescapedInterpolationsLegacy(stmt);
    assert.strictEqual(badLegacy.length, 0, `旧版判据应在此漏检（?. 里的 '?' 被误当条件位分界），实得 ${JSON.stringify(badLegacy)}`);
});
check('★对照组·G2：空值合并 `??` 不是三元判断符，不得连带豁免其前的裸字段（旧版漏检）', () => {
    const stmt = "summaryHtml = (e.summary) + (a ?? '');";
    const badAst = residualUnescapedInterpolations(stmt);
    assert.ok(badAst.some(b => b.includes('e.summary')), `AST 判据应判红，实得 ${JSON.stringify(badAst)}`);
    const badLegacy = residualUnescapedInterpolationsLegacy(stmt);
    assert.strictEqual(badLegacy.length, 0, `旧版判据应在此漏检（?? 里的 '?' 被误当条件位分界），实得 ${JSON.stringify(badLegacy)}`);
});
check('★对照组·G2：acorn 解析失败时回退旧版判据 + 显式判红提示标记，不静默退化', () => {
    const brokenStmt = 'summaryHtml = e.summary +;';   // 故意语法错误，acorn 必抛
    const bad = residualUnescapedInterpolations(brokenStmt);
    assert.ok(bad.some(b => b.startsWith('ACORN_PARSE_FALLBACK:')), `解析失败应带 ACORN_PARSE_FALLBACK 标记，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2 补丁①（坑28）：局部变量定义若直接暴露裸动态字段（`const withdrawNote = e.summary;` 去掉 esc）——插值引用该变量须判红', () => {
    // 用合成的 fnBody 片段构造"坑28"场景（不改动真实 siRenderTimeline，纯粹验证回溯逻辑本身）：
    // 变量名故意沿用真实 dev_withdraw 分支的 withdrawNote，模拟"有人把这处 esc 手滑删掉"。
    const fakeDefsMap = buildLocalVarDefsMap('{ const withdrawNote = e.summary; }');
    assert.ok(fakeDefsMap && fakeDefsMap.has('withdrawNote'), '合成 defsMap 应含 withdrawNote 定义（前提失败，需检查 buildLocalVarDefsMap 本身）');
    const bad = residualUnescapedInterpolations('summaryHtml = `${withdrawNote}`;', fakeDefsMap);
    assert.ok(bad.some(b => b.includes('withdrawNote') && b.includes('e.summary')), `局部变量 withdrawNote 的定义直接暴露裸 e.summary，插值引用它应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2 补丁②（坑28）：局部变量定义是"部分 esc + 部分裸拼接"的混合形态（`const withdrawMainText = esc(e.summary) + e.operator_name;`）——插值引用该变量须判红', () => {
    const fakeDefsMap = buildLocalVarDefsMap('{ const withdrawMainText = esc(e.summary) + e.operator_name; }');
    const bad = residualUnescapedInterpolations('summaryHtml = `${withdrawMainText}`;', fakeDefsMap);
    assert.ok(bad.some(b => b.includes('withdrawMainText') && b.includes('e.operator_name')), `局部变量 withdrawMainText 混合拼接未转义字段 e.operator_name，插值引用它应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2 补丁③：局部变量递归回溯超过深度上限（4 层链式引用，最深层其实是安全字面量）——须判红（fail-closed，不因"深层其实安全"就放行）', () => {
    const fakeDefsMap = buildLocalVarDefsMap("{ const v1 = 'safe-literal'; const v2 = v1; const v3 = v2; const v4 = v3; }");
    const bad = residualUnescapedInterpolations('summaryHtml = `${v4}`;', fakeDefsMap);
    assert.ok(bad.some(b => b.includes('v4') && b.includes('递归深度')), `4 层链式引用（v4→v3→v2→v1）应因超过递归深度上限判红（不应无限递归、也不应"深层安全就放行"），实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2 补丁④：既有预构建变量 statusLine/commitsTable 走局部变量递归判据仍应判安全（不误伤既有安全代码——commitsTable 定义里的 info.commits 是传给 siRenderReleasePublishedCommits 这个具名 helper 的参数，本判据不深入非 esc 调用的参数）', () => {
    const bad = residualUnescapedInterpolations('summaryHtml = `${statusLine}${commitsTable}`;');
    assert.strictEqual(bad.length, 0, `statusLine/commitsTable 应判安全，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2 补丁⑤（S4c2 改写）：withdrawMainText/withdrawNote/withdrawCommitsHtml 三个预构建变量已随 S3c 撤放宽——dev_withdraw 分支改为单条内联 esc( 的赋值，本对照组转而断言现场该条真实语句走 AST 判据应判安全', () => {
    // [长任务B S4c2] 原三个变量名（withdrawMainText/withdrawNote/withdrawCommitsHtml）已不存在于真实
    //   fnBody——S3c 把 dev_withdraw 分支改成不再经预构建局部变量间接转义，而是单条 summaryHtml 赋值
    //   语句内直接三处内联 esc(...)（:5020 一带）。本对照组改为定位现场这条真实语句，断言 AST 判据
    //   （residualUnescapedInterpolations）复核判定零裸露动态字段（叠加层与硬门结论一致）。
    const withdrawStmt = assignments.find(a => a.stmt.includes('withdrawEventIdDisplay'));
    assert.ok(withdrawStmt, '未在现场 assignments 中定位到 dev_withdraw 分支的 summaryHtml 赋值语句（结构锚 withdrawEventIdDisplay 已漂移，需同步本对照组）');
    const bad = residualUnescapedInterpolations(withdrawStmt.stmt);
    assert.strictEqual(bad.length, 0, `现场 dev_withdraw 分支赋值语句应判安全，实得 ${JSON.stringify(bad)}：${withdrawStmt.stmt.slice(0, 200)}`);
});
check('★对照组·G2 补丁 v2-①：局部变量"先安全初始化、再条件性裸再赋值"（`let x = \'\'; if (c) { x = e.summary; }`）——插值引用该变量须判红（此前只认 const/let 初值会漏判）', () => {
    const fakeDefsMap = buildLocalVarDefsMap("{ let x = ''; if (c) { x = e.summary; } }");
    assert.ok(fakeDefsMap && fakeDefsMap.has('x') && fakeDefsMap.get('x').length === 2, '合成 defsMap 应含变量 x 的 2 处写入点（初值 + if 块内再赋值），实得 ' + JSON.stringify(fakeDefsMap && [...fakeDefsMap.keys()]));
    const bad = residualUnescapedInterpolations('summaryHtml = `${x}`;', fakeDefsMap);
    assert.ok(bad.some(b => b.includes('x') && b.includes('e.summary')), `变量 x 的 if 块内再赋值直接暴露裸 e.summary，插值引用它应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2 补丁 v2-①b：复合赋值运算符（`+=`）同样须纳入再赋值追踪', () => {
    const fakeDefsMap = buildLocalVarDefsMap("{ let x = ''; x += e.summary; }");
    const bad = residualUnescapedInterpolations('summaryHtml = `${x}`;', fakeDefsMap);
    assert.ok(bad.some(b => b.includes('x') && b.includes('e.summary')), `x += e.summary 应被追踪到并判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2 补丁 v2-②：白名单外的函数调用（`String(e.summary)`）不得整体信任——插值引用须判红（此前"任意调用都是安全边界"会放行）', () => {
    const bad = residualUnescapedInterpolations('summaryHtml = `${String(e.summary)}`;');
    assert.ok(bad.some(b => b.includes('e.summary')), `String(e.summary) 的参数是裸字段，String 不在白名单，应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2 补丁 v2-②b：白名单外的数组方法调用（`[e.summary].join(\'\')`）同样须判红', () => {
    const bad = residualUnescapedInterpolations("summaryHtml = `${[e.summary].join('')}`;");
    assert.ok(bad.some(b => b.includes('e.summary')), `[e.summary].join('') 的 join 不在白名单，参数数组里的裸字段应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·G2 补丁 v2-②c：白名单内 helper（siRenderReleasePublishedCommits）带 info.commits 参数仍应判安全（信任整条调用，不深入其参数）', () => {
    const bad = residualUnescapedInterpolations('summaryHtml = `${siRenderReleasePublishedCommits(info.commits)}`;');
    assert.strictEqual(bad.length, 0, `白名单内 helper 调用应整体信任，不因参数是 info.commits 就判红，实得 ${JSON.stringify(bad)}`);
});

// ══════════════════════════════════════════════════════════════════════
// [长任务B S4c2·codex 590 M4] 六组绕过形态活体变异——codex 590 报告的三个 HIGH 全部是"局部变量插值
// 放宽路径"的绕过实例，逐组钉死判据确有能力判红（原 11 组 ★对照组 全部保留在上方，不删不改语义）。
// ══════════════════════════════════════════════════════════════════════
check('★对照组·M4-①：计算属性 `e[\'summary\']` 绕过（旧版只查 `!n.computed` 的点号访问，放过计算属性）——须判红', () => {
    const bad = residualUnescapedInterpolations("summaryHtml = e['summary'];");
    assert.ok(bad.length > 0, `e['summary'] 计算属性访问应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·M4-②：别名绕过 `const raw = e; summaryHtml = raw.summary;`（旧版裸标识符 e 本身"防御性跳过"当安全，别名定义处不留痕迹）——须判红', () => {
    const fakeDefsMap = buildLocalVarDefsMap('{ const raw = e; }');
    assert.ok(fakeDefsMap && fakeDefsMap.has('raw'), '合成 defsMap 应含 raw 的定义（前提失败，需检查 buildLocalVarDefsMap 本身）');
    const bad = residualUnescapedInterpolations('summaryHtml = raw.summary;', fakeDefsMap);
    assert.ok(bad.some(b => b.includes('raw')), `别名 raw（定义为裸 e）经 .summary 访问应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·M4-③：`e.length` 直接访问原始字段对象的 length 属性（旧版 .length 豁免先于 e/info/a 判据，属性名恰为 length 时整体放行）——须判红', () => {
    const bad = residualUnescapedInterpolations('summaryHtml = e.length;');
    assert.ok(bad.length > 0, `e.length 直接访问应判红（对象本身就是原始字段，不因属性名是 length 而豁免），实得 ${JSON.stringify(bad)}`);
});
check('★对照组·S4c3·M4-④（已收口·由"待裁定安全"翻为"必须判红"）：`const x = JSON.parse(e.payload_json); summaryHtml = x.length;`——`.length` 全局豁免已彻底删除，x 是未证明安全的局部变量（其定义直接暴露裸 e.payload_json），插值引用 x.length 须判红', () => {
    const fakeDefsMap = buildLocalVarDefsMap('{ const x = JSON.parse(e.payload_json); }');
    const bad = residualUnescapedInterpolations('summaryHtml = `${x.length}`;', fakeDefsMap);
    assert.ok(bad.length > 0, `x.length 应判红（.length 豁免已删除，x 的定义暴露裸 e.payload_json，未证明安全），实得 ${JSON.stringify(bad)}`);
});
check('★对照组·S4c3·H1（591-R 复审）：真实 dev_withdraw 分支的 `withdrawCommits.length`（:5020 一带，展示处已改为 `esc(String(withdrawCommits.length))`）——.length 豁免删除后现场语句仍应判安全，证明本次收紧未误伤真实代码', () => {
    const withdrawStmt = assignments.find(a => a.stmt.includes('withdrawEventIdDisplay'));
    assert.ok(withdrawStmt, '未在现场 assignments 中定位到 dev_withdraw 分支的 summaryHtml 赋值语句（结构锚 withdrawEventIdDisplay 已漂移，需同步本对照组）');
    const bad = residualUnescapedInterpolations(withdrawStmt.stmt);
    assert.strictEqual(bad.length, 0, `现场 dev_withdraw 分支赋值语句应判安全，实得 ${JSON.stringify(bad)}：${withdrawStmt.stmt.slice(0, 260)}`);
});
// [长任务B S4c3·codex 591-R H1] "混合拼接绕过硬门"活体反例——整句字面含 esc(，能过硬门快速通道，
// 只有 AST 叠加层（residualUnescapedInterpolations）能揪出残留的裸局部变量引用。两组均须判红，且
// 判红依据须来自 AST 层（局部变量未证明已转义），不是硬门文本匹配（硬门在这两句上均会误判通过）。
check('★对照组·S4c3·H1-混合①：`${esc(e.summary)}${x.length}`（x=JSON.parse(e.payload_json)）——硬门因含 esc( 会放行，AST 叠加层须判红', () => {
    const fakeDefsMap = buildLocalVarDefsMap('{ const x = JSON.parse(e.payload_json); }');
    const stmt = 'summaryHtml = `${esc(e.summary)}${x.length}`;';
    assert.ok(stmt.includes('esc('), '前提：该语句字面须含 esc(（用于证明硬门快速通道会放行）');
    const bad = residualUnescapedInterpolations(stmt, fakeDefsMap);
    assert.ok(bad.some(b => b.includes('x')), `混合拼接 x.length 应被 AST 叠加层判红（局部变量 x 未证明安全），实得 ${JSON.stringify(bad)}`);
});
check('★对照组·S4c3·H1-混合②：`${esc(e.summary)}${x}`（x=JSON.parse(e.payload_json)）——硬门因含 esc( 会放行，AST 叠加层须判红', () => {
    const fakeDefsMap = buildLocalVarDefsMap('{ const x = JSON.parse(e.payload_json); }');
    const stmt = 'summaryHtml = `${esc(e.summary)}${x}`;';
    assert.ok(stmt.includes('esc('), '前提：该语句字面须含 esc(（用于证明硬门快速通道会放行）');
    const bad = residualUnescapedInterpolations(stmt, fakeDefsMap);
    assert.ok(bad.some(b => b.includes('x')), `混合拼接裸插值 x 应被 AST 叠加层判红（局部变量 x 未证明安全），实得 ${JSON.stringify(bad)}`);
});
check('★对照组·M4-⑤：解构赋值绕过 `let x=\'\'; ({summary: x} = e); summaryHtml = x;`（旧版解构模式左值完全不进 defsMap，再赋值内容对判据不可见）——须判红', () => {
    const fakeDefsMap = buildLocalVarDefsMap("{ let x = ''; ({summary: x} = e); }");
    assert.ok(fakeDefsMap && fakeDefsMap.has('x') && fakeDefsMap.get('x').length === 2, '合成 defsMap 应含变量 x 的 2 处写入点（初值 + 解构再赋值），实得 ' + JSON.stringify(fakeDefsMap && [...fakeDefsMap.keys()]));
    const bad = residualUnescapedInterpolations('summaryHtml = x;', fakeDefsMap);
    assert.ok(bad.some(b => b.includes('x')), `解构再赋值 ({summary: x} = e) 把 e.summary 写入 x，插值引用 x 应判红，实得 ${JSON.stringify(bad)}`);
});
// [长任务B S4c3·codex 591-R M5·主会话亲核订正] 解构默认值（AssignmentPattern 的 right）此前完全没有
// 进 defsMap——`const {value: x = e.summary} = {}` 场景下，若 source（这里是空对象字面量）里根本没有
// `value` 这个键，x 的实际取值就是默认值表达式 e.summary，旧版判据只认"从 source 取值"这一条路径
// （对应 synthetic MemberExpression），从未把默认值表达式本身登记为 x 的定义来源，等于对这整类绕过
// 完全空转（此前误报"已由既有实现覆盖"，主会话亲核证伪）。
check('★对照组·S4c3·M5：解构默认值绕过 `const {value: x = e.summary} = {}; summaryHtml = `${esc(e.summary)}${x}`;`——须判红，判红原因须来自 x 的默认值定义来源', () => {
    const fakeDefsMap = buildLocalVarDefsMap("{ const {value: x = e.summary} = {}; }");
    assert.ok(fakeDefsMap && fakeDefsMap.has('x'), '合成 defsMap 应含变量 x 的定义（前提失败，需检查 buildLocalVarDefsMap/addDestructuringDefs 本身）');
    const bad = residualUnescapedInterpolations('summaryHtml = `${esc(e.summary)}${x}`;', fakeDefsMap);
    assert.ok(bad.some(b => b.includes('x') && b.includes('e.summary')), `解构默认值 {value: x = e.summary} 把 e.summary 写入 x 的默认值来源，插值引用 x 应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·S4c3·M5b：嵌套解构默认值同规则——`const {a: {b: x = e.summary} = {}} = {}`——须判红', () => {
    const fakeDefsMap = buildLocalVarDefsMap("{ const {a: {b: x = e.summary} = {}} = {}; }");
    assert.ok(fakeDefsMap && fakeDefsMap.has('x'), '合成 defsMap 应含嵌套解构变量 x 的定义（前提失败）');
    const bad = residualUnescapedInterpolations('summaryHtml = `${x}`;', fakeDefsMap);
    assert.ok(bad.some(b => b.includes('x') && b.includes('e.summary')), `嵌套解构默认值把 e.summary 写入 x 的默认值来源，插值引用 x 应判红，实得 ${JSON.stringify(bad)}`);
});
check("★对照组·S4c3·M5c：默认值分支不误伤——`const {value: x = ''} = {value: 'safe'}` 两条来源（source 取值 + 安全字面量默认值）均安全时不应判红", () => {
    const fakeDefsMap = buildLocalVarDefsMap("{ const {value: x = ''} = {value: 'safe'}; }");
    const bad = residualUnescapedInterpolations('summaryHtml = `${x}`;', fakeDefsMap);
    assert.strictEqual(bad.length, 0, `两条来源均安全（synthetic MemberExpression 取自安全对象字面量 + 空字符串默认值）不应误判，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·M4-⑥：具名 helper 遮蔽绕过 `const siTlChangesHtml = v => v; summaryHtml = siTlChangesHtml(e.summary);`（旧版白名单按纯文本调用名匹配，不检查该名是否已被同作用域局部变量顶替）——须判红', () => {
    const fakeDefsMap = buildLocalVarDefsMap('{ const siTlChangesHtml = v => v; }');
    assert.ok(fakeDefsMap && fakeDefsMap.has('siTlChangesHtml'), '合成 defsMap 应含 siTlChangesHtml 的局部遮蔽定义（前提失败）');
    const bad = residualUnescapedInterpolations('summaryHtml = siTlChangesHtml(e.summary);', fakeDefsMap);
    assert.ok(bad.length > 0, `siTlChangesHtml 被同名局部变量遮蔽后应打开参数检查，e.summary 应判红，实得 ${JSON.stringify(bad)}`);
});
check('★对照组·M4-⑥b：未遮蔽时白名单仍应正常信任（siTlChangesHtml 在真实作用域内是具名函数声明，非局部变量）——不应误伤', () => {
    const bad = residualUnescapedInterpolations('summaryHtml = `${siTlChangesHtml(e, parsedPayload)}`;');
    assert.strictEqual(bad.length, 0, `未被遮蔽的白名单 helper 调用应仍判安全，实得 ${JSON.stringify(bad)}`);
});

console.log('— 对照组：注入一个假的无 esc 分支，证明判据真能判红 —');
check('★对照组：手写一段含未转义 summaryHtml 分支的伪函数体，判据应报错（非恒真断言）', () => {
    const fakeBody = `{
        if (fakeCond) {
            summaryHtml = \`<span>\${esc(e.summary)}</span>\`;
        } else if (anotherCond) {
            // 故意不转义：模拟未来有人漏加 esc()
            summaryHtml = e.summary;
        } else {
            summaryHtml = e.summary ? esc(e.summary) : '';
        }
    }`;
    const fakeAssignments = extractSummaryHtmlAssignments(fakeBody);
    assert.strictEqual(fakeAssignments.length, 3, `对照组应抓到 3 条赋值语句，实得 ${fakeAssignments.length}`);
    const fakeUnescaped = fakeAssignments.filter(a => !a.stmt.includes('esc('));
    assert.strictEqual(fakeUnescaped.length, 1, `对照组应恰好判红 1 条（第二分支 summaryHtml = e.summary; 未转义），实得判红 ${fakeUnescaped.length} 条`);
    assert.ok(fakeUnescaped[0].stmt.includes('summaryHtml = e.summary;'), `判红的语句应精确是未转义那一条，实得="${fakeUnescaped[0].stmt}"`);
});
check('★对照组：反例——分号出现在模板字符串内部（CSS 样式）不应提前截断语句', () => {
    const fakeBody = `{
        summaryHtml = \`<div style="display:block;margin-top:6px">\${esc(x)}</div>\`;
    }`;
    const fakeAssignments = extractSummaryHtmlAssignments(fakeBody);
    assert.strictEqual(fakeAssignments.length, 1, `应恰抓到 1 条完整语句（不被 CSS 内的分号截断），实得 ${fakeAssignments.length}`);
    assert.ok(fakeAssignments[0].stmt.includes('</div>`;'), `应完整抓到语句末尾，实得="${fakeAssignments[0].stmt}"`);
    assert.ok(fakeAssignments[0].stmt.includes('esc(x)'), '完整语句应包含结尾处的 esc( 调用（证明未被截断丢失）');
});

console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'}：${passed} 项通过 / ${failed} 项失败 ===`);
if (failed) {
    console.log('失败详情：');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
}
