// verify-collab-validation-status-coverage.js — G1：sql_validation_status 唯一枚举 + 写入点
// 全覆盖静态守卫（C1，数据协作接入外部源）
//
// 覆盖面（三节，判据见各自小节头注释）：
//   ① 后端写入点覆盖——扫描面 = server.js + routes/**/*.js + utils/**/*.js（R3〔12a-H4〕动态
//      递归发现，排除 node_modules；见 discoverScanFiles()）里所有 `sql_validation_status = `
//      字面量写入（SET 语境，列名匹配大小写不敏感、接受被双引号/反引号包裹的引用形式），
//      逐点核对：a. 出现在本文件登记表 WRITE_POINTS 里，双向相等（多一处/少一处都红）；
//      b. 写入点邻近必须出现 assertSqlValidationStatus(；c. 登记字面量 ⊆ SQL_VALIDATION_STATUSES。
//      另有一条"动态清空"写入点（return-quality → transitionToDevPending 的 clearFields
//      通用循环）：字段名是运行时变量 f，源码里 "sql_validation_status" 与 "=" 从不相邻——
//      常规正则扫描天然看不到这条写入，改用锚点检测（专门函数校验分支存在 + 分支内有断言调用）。
//   ② 前端三处枚举覆盖——public/Data_Collab.html 的 SQL_VALIDATION_LABELS 对象字面量 /
//      renderValidationSection 函数体 / collabExportValidationStatus 函数体，对枚举每个值
//      断言三处各含该值的字符串 token；并反向核对 SQL_VALIDATION_LABELS 的 key 集合 ⊆ 枚举
//      （防"前端多声明了个不存在于枚举的值"这一半，纯正向包含关系测不出该方向）。
//   ③ 变异自证——①②的核心判定逻辑抽成纯函数（evaluateWriteCoverage / evaluateFrontendCoverage），
//      在内存字符串/内存枚举副本上做多组变异，验证判红/判绿准确，不触碰真实文件。〔L1·codex 05〕
//      组数不在注释里手写数字（本行曾写死"9 组"，实到 18 组后就已过期失真）——实际执行组数由
//      ok/bad 从每条 `★<label>)` 前缀消息里动态提取去重后统计，运行时打印在"③ 变异自证"小节
//      收尾行 + main() 最终汇总行，注释与代码不会再对不上。
//
// 〔R1 返工·2026-09-02 Opus 预筛〕原①只比"登记字面量 ⊆ 枚举"，从不比"登记字面量与站点实际写入值
//   是否一致"——预筛实测把 /submit 的 queued 换成 admin_closed、bypass 的 bypassed 换成 passed 等
//   换值变异全部假绿（因为换后的值仍在枚举里，"⊆ 枚举"这条判据天然测不出"值对不对"）；把 SQL 右值
//   改回硬字面量、assert 调用留着不用，也假绿（因为原判据只查"附近有没有 assert 调用"，不查这个
//   调用的返回值有没有真的被用在 SQL 里）。补两条判据补上这两个缺口：
//   ④ 从邻近的 assertSqlValidationStatus( 调用行抽实参，必须与登记字面量严格相等（null 站点要求
//      实参 null 且同调用带 allowNull:true）——堵"assert 实参被换成另一个合法枚举值"这个假绿口子。
//   ⑤ 写入行右值必须引用"接收该 assert 返回值的那个变量"（从 `const <name> = assertSqlValidationStatus(`
//      抽变量名，检查写入行/紧邻窗口里出现 `'${<name>}'`；null 站点右值须是字面 NULL）——堵
//      "SQL 右值被人手动改回硬字面量、assert 调用只是摆设"这个假绿口子。
//
// 〔身份键：scope + ordinal，不用行号——C1 主会话 2026-09-02 返工裁定〕
//   C2 即将在 /submit（server.js 16035-16613 一带）大量插入代码，届时其后全部登记行号整体
//   漂移，若身份键含行号，G1 每个 commit 都会假红并迫使机械改数字（行号锚是仓内静态守卫的
//   已知反模式，见 guard_static_analysis_gotchas 的"行号锚换结构锚"条）。
//   本版身份键改为 `${file}|${scope}|${ordinal}`：
//     - scope = 该写入点所属的**顶层**（列首、零缩进）路由注册（`app.get/post/put/delete/
//       patch/listen(...)`）或函数声明（`function name(`/`const name = (async)? (`），
//       取"向前最近的一个"。**行号只出现在 desc 字段里作人工定位提示，从不参与匹配**。
//     - ordinal = 同一 scope 内，按出现顺序给写入点编号（从 1 起）。
//   〔实现细节：为什么锚点正则要求"列首"〕原始派单 spec 给的锚点正则
//   （`app\.(get|post|put|delete|patch)\(...`／`function\s+(\w+)\s*\(`／`const\s+(\w+)\s*=\s*
//   (async\s*)?\(`）若不加列首限定，会被路由处理函数体内部大量的**嵌套局部**
//   `const xxx = () => ...`（如 server.js:16070 `const cleanupPending = () => ...`，缩进 8 空格）
//   抢先命中——那样同一个路由端点里不同写入点会被分到不同的"局部变量名"当 scope，
//   反而比行号更不稳定。改为只认**零缩进（行首）**的锚点，恰好排除了这类嵌套局部声明
//   （已用 grep 实测确认：本仓路由处理函数体内所有嵌套 const 箭头函数均有缩进，不会误命中），
//   拿到的就是路由/顶层函数本身。`app.listen(...)` 补进锚点方言：server.js:21088 那处写入点
//   （启动崩溃恢复）不在任何 app.METHOD 路由或具名函数体内，而在 `app.listen(PORT, ..., () =>
//   {...})` 的匿名回调里——是本仓唯一落在这个位置的写入点，补一个方言分支即可，无需引入更
//   复杂的通用匿名函数追踪。
//
// 运行：node scripts/verify-collab-validation-status-coverage.js
'use strict';

const fs = require('fs');
const path = require('path');
const { SQL_VALIDATION_STATUSES } = require('../utils/collab-validation-status');

let pass = 0, fail = 0;
// 〔L1·codex 05〕③ 变异自证每组消息恒以 `★<label>)` 开头（label 可含如 `a-①`/`a-②` 的子编号，
// 正则只取字母部分归并回同一组）——ok/bad 是全部 must() 调用的唯一收敛点，在这里顺手提取
// label 落进 Set 即可拿到"运行时实际执行过的组"，不用逐个改 18+ 个既有变异块。①②主流程的
// must() 消息不带 ★ 前缀，天然不会被计入，作用域自动限定在③变异自证。
const mutationGroupLabels = new Set();
const GROUP_LABEL_RE = /^★([a-zA-Z]+)/;
function trackGroupLabel(m) { const gm = GROUP_LABEL_RE.exec(m); if (gm) mutationGroupLabels.add(gm[1]); }
const ok = (m) => { pass++; trackGroupLabel(m); console.log(`  [OK] ${m}`); };
const bad = (m, d) => { fail++; trackGroupLabel(m); console.log(`  [FAIL] ${m}${d ? '\n         ' + d : ''}`); };
const must = (cond, m, d) => (cond ? ok(m) : bad(m, d));

const ROOT = path.join(__dirname, '..');
const DATA_COLLAB_HTML_PATH = path.join(ROOT, 'public', 'Data_Collab.html');
const NEARBY_WINDOW_LINES = 10;   // ④：assert 调用向"后"（更早）找的窗口
const ANCHOR_WINDOW_LINES = 15;   // F6①：anchor 辅助定位校验的邻域半径（±15 行）
const MAX_REASONABLE_FN_BODY_LINES = 400; // R4：grabFnBody 抽出的函数体行数合理性上限（防收尾锚点找错吞到别处）

// ============================================================
// 通用文本工具
// ============================================================

// acorn 剥注释：注释整体替换为等长空白，**保留位置**（供按 assert 调用邻近窗口定位）。
// 解析失败直接抛错——调用方（本文件顶层 try/catch）fail-closed，不静默放行。
function stripJsCommentsStrict(source) {
    const acorn = require('acorn');
    const comments = [];
    acorn.parse(source, {
        ecmaVersion: 2022, sourceType: 'script', allowReturnOutsideFunction: true,
        onComment: (block, text, start, end) => comments.push([start, end]),
    });
    if (!comments.length) return source;
    comments.sort((a, b) => a[0] - b[0]);
    let out = '', last = 0;
    for (const [start, end] of comments) {
        if (start < last) continue;
        out += source.slice(last, start);
        out += source.slice(start, end).replace(/[^\n\r]/g, ' ');
        last = end;
    }
    return out + source.slice(last);
}

// HTML 内嵌 <script>（无 src）正文抽取 + 宽松剥注释（不要求可被 acorn 完整解析的整页 HTML）——
// 与 scripts/verify-badge-alias.js 的 pageScriptText / stripJsComments(regex 版) 同款写法。
function pageScriptText(html) {
    return [...String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
}
function stripJsCommentsLoose(src) {
    return String(src).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
}
// 取某个具名函数的函数体（按缩进收尾——与各页写法一致：顶层函数收尾 `}` 缩进与 `function` 声明对齐）
// 〔R4 加固〕收尾锚点找不到时**直接判失败**（返回 null），不再"抓到文件尾"当兜底——旧兜底会在
//   收尾 `}` 缩进哪怕错 1 个空格时静默吞下从函数起点到文件结尾的整段文本，仍返回真值让"函数体
//   可提取"判绿，而后续的 token 检查很可能因为"整个文件剩余部分"里确实含各种值字符串而继续判绿，
//   实测这种半途而废的提取能让判据整体误判 4.3 倍体量的假内容为"正常函数体"。
function grabFnBody(src, fnName) {
    const re = new RegExp('(?:async\\s+)?function\\s+' + fnName + '\\s*\\(', 'g');
    const m = re.exec(src);
    if (!m) return null;
    const start = m.index;
    const openIdx = src.indexOf('{', re.lastIndex - 1);
    if (openIdx < 0) return null;
    const indent = (src.slice(0, start).match(/[^\n]*$/) || [''])[0];
    const closer = '\n' + indent + '}';
    const end = src.indexOf(closer, openIdx);
    if (end < 0) return null;
    return src.slice(start, end + closer.length);
}
function lineCountOf(text) { return text ? text.split('\n').length : 0; }
// 取 `const <name> = ...{ ... }` 的整块（花括号深度扫描，跳过字符串/模板串内的花括号）
function grabConstBlock(src, constName) {
    const declRe = new RegExp('const\\s+' + constName + '\\s*=');
    const dm = declRe.exec(src);
    if (!dm) return null;
    const openIdx = src.indexOf('{', dm.index);
    if (openIdx < 0) return null;
    let depth = 0, i = openIdx;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === "'" || c === '"' || c === '`') { i = skipStringLiteral(src, i); continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(dm.index, i);
}
function skipStringLiteral(src, i) {
    const quote = src[i];
    i++;
    while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) return i;
        i++;
    }
    return i;
}
// 〔H1·codex 05 复审〕字符串/模板串感知的花括号深度计算——从 text 开头扫到 targetIdx（不含），
// 返回该位置相对文本起点的花括号嵌套深度。用于判定"某个调用是不是本层花括号的直接子语句"，
// 而不是被套进了一层新开的 `{}`（如箭头函数体/代码块）里。
function computeBraceDepthAt(text, targetIdx) {
    let depth = 0;
    for (let i = 0; i < targetIdx && i < text.length; i++) {
        const c = text[i];
        if (c === "'" || c === '"' || c === '`') { i = skipStringLiteral(text, i); continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
    }
    return depth;
}
function hasValueToken(text, value) {
    if (!text) return false;
    return text.includes(`'${value}'`) || text.includes(`"${value}"`);
}

// ============================================================
// 作用域锚点（scope）——**列首（零缩进）** 的路由注册 / 顶层函数声明。理由见文件头注释。
// ============================================================
// R3〔12a-H4，主会话末次合并审②a〕扫描面从写死的三文件数组扩到 server.js + routes/**/*.js +
// utils/**/*.js（动态递归发现，排除 node_modules）——旧版写死数组意味着"新文件里出现新的
// sql_validation_status 写入点"这种情况永远不会被扫到（不是判红，是压根不进扫描面，比判红更隐蔽）。
// 与 G4（verify-db-connections-writers.js）的 listJsFilesRecursive 同款写法，独立复制一份
// （各 verify-*.js 脚本历来互不 require，保持每个静态守卫自包含）。
function listJsFilesRecursiveForScan(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listJsFilesRecursiveForScan(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}
function relPathForScan(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }
function discoverScanFiles() {
    const files = ['server.js'];
    for (const dir of ['routes', 'utils']) {
        const full = path.join(ROOT, dir);
        if (fs.existsSync(full)) files.push(...listJsFilesRecursiveForScan(full).map(relPathForScan));
    }
    return files;
}
const SCAN_FILES = discoverScanFiles();

const ROUTE_ANCHOR_RE = /^app\.(get|post|put|delete|patch|listen)\(\s*(?:['"]([^'"]+)['"])?/gm;
const FN_ANCHOR_RE = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
const CONST_FN_ANCHOR_RE = /^const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm;

function computeScopeAnchors(strippedSource) {
    const anchors = [];
    let m;
    ROUTE_ANCHOR_RE.lastIndex = 0;
    while ((m = ROUTE_ANCHOR_RE.exec(strippedSource))) {
        const method = m[1];
        const label = method === 'listen' ? 'app.listen(startup)' : `${method.toUpperCase()} ${m[2] || '(unknown path)'}`;
        anchors.push({ index: m.index, label });
    }
    FN_ANCHOR_RE.lastIndex = 0;
    while ((m = FN_ANCHOR_RE.exec(strippedSource))) {
        anchors.push({ index: m.index, label: `function ${m[1]}` });
    }
    CONST_FN_ANCHOR_RE.lastIndex = 0;
    while ((m = CONST_FN_ANCHOR_RE.exec(strippedSource))) {
        anchors.push({ index: m.index, label: `const ${m[1]}` });
    }
    anchors.sort((a, b) => a.index - b.index);
    return anchors;
}
function scopeForIndex(anchors, index) {
    let label = '(module top-level)';
    for (const a of anchors) {
        if (a.index <= index) label = a.label; else break;
    }
    return label;
}

// ============================================================
// ① 后端写入点登记表——身份键 = file + scope + ordinal（行号只在 desc 里作提示）
// ============================================================
// F6①〔R2 返工·2026-09-03 codex 04 审 M3〕每项加 anchor：该站点邻域 ±ANCHOR_WINDOW_LINES 行内
// 应唯一命中的稳定上下文串（错误文案/日志标签/相邻列名等真实代码文本，非注释——注释会被剥掉）。
// 与 scope+ordinal 身份键正交叠加：身份键管"是不是这个站点"，anchor 管"内容层面看起来还是不是
// 原来那个站点"——两者都错才会真正漏判。
const WRITE_POINTS = [
    { file: 'server.js', scope: 'POST /api/collab/requests/:id/submit', ordinal: 1, literal: 'queued', anchor: 'CONCURRENT_PRE_UPDATE', desc: '前置 UPDATE → SUBMITTED + 排队（提示行号 ~16194，非匹配键）' },
    { file: 'server.js', scope: 'POST /api/collab/requests/:id/submit', ordinal: 2, literal: 'failed', anchor: '目标库密码解密失败', desc: '目标库密码解密失败（~16261）' },
    { file: 'server.js', scope: 'POST /api/collab/requests/:id/submit', ordinal: 3, literal: 'failed', anchor: 'sanitizeSqlError(`连接业务库失败', desc: '目标库连接失败（~16288）' },
    { file: 'server.js', scope: 'POST /api/collab/requests/:id/submit', ordinal: 4, literal: 'failed', anchor: '撞墙附件保留', desc: 'SMOKE_TEST_FAILED（smoke test 未通过，~16350）' },
    { file: 'server.js', scope: 'POST /api/collab/requests/:id/submit', ordinal: 5, literal: 'failed', anchor: '提交失败: ', desc: 'activateNewVersion 未知异常兜底（~16523）' },
    { file: 'server.js', scope: 'POST /api/collab/requests/:id/submit-export', ordinal: 1, literal: 'admin_closed', anchor: 'export_summary', desc: 'exporter 提交 → DONE（未走 smoke，~18678）' },
    { file: 'server.js', scope: 'POST /api/collab/requests/:id/bypass', ordinal: 1, literal: 'bypassed', anchor: 'bypass_by_name', desc: 'admin 旁路放行（~19170）' },
    // R2 返工加长了本站点周边注释，原 anchor 'sql_validation_error = NULL' 与写入点行距超出
    // ±15 行窗口——改用离写入点更近的非注释代码文本（if 判断本身）作 anchor。
    { file: 'server.js', scope: 'POST /api/collab/requests/:id/admin-fix', ordinal: 1, literal: null, anchor: "sql_validation_status !== 'external_skipped'", desc: '清空（allowNull，setClauses.push，external_skipped 时跳过）' },
    { file: 'server.js', scope: 'POST /api/collab/requests/:id/admin-submit-on-behalf', ordinal: 1, literal: 'admin_closed', anchor: 'allowedStatesInWhere', desc: 'DONE 三元字面量分支（isDoneFix=false 时，~19989）' },
    { file: 'server.js', scope: 'app.listen(startup)', ordinal: 1, literal: 'failed', anchor: '服务重启时校验流程被中断', desc: '启动崩溃恢复：running 超时判定为中断（~21088）' },
    // C2a：本站点改为按 validationMode 三元二选一（external_skip → 'external_skipped' /
    //   smoke → 'passed'）——一处写入点、多个合法值，用 literalSet 而非单值 literal 登记
    //   （见下方④判定分叉：先试单值 assert 实参解析，不行再试三元实参解析）。
    { file: 'utils/collab-attachment-versioning.js', scope: 'function activateNewVersion', ordinal: 1, literalSet: ['external_skipped', 'passed'], anchor: 'VALIDATION_MODES.external_skip', desc: '激活成功：按 mode 二选一（external_skip→external_skipped / smoke→passed，~585）' },
    { file: 'utils/collab-submit-helpers.js', scope: 'function runRealSmokeTest', ordinal: 1, literal: 'running', anchor: 'globalSmokeTestMutex', desc: '拿到互斥锁后写 running（~384）' },
];

// 动态清空写入点（return-quality → transitionToDevPending 的 clearFields 通用循环）：
// 字段名是运行时变量 f，源码里 "sql_validation_status" 与 "=" 从不相邻，常规正则扫不到——
// 改用锚点检测：定位 `if (f === 'sql_validation_status') { ... }` 分支，要求分支体内含
// assertSqlValidationStatus( 调用。不参与 scope+ordinal 身份键系统（本就无 ordinal 意义——
// 全仓恰一处），scope 字段仅作文档标注。
const DYNAMIC_WRITE_POINT = {
    file: 'utils/collab-submit-helpers.js',
    scope: 'function transitionToDevPending',
    desc: "return-quality → transitionToDevPending clearFields 通用清空循环（server.js:18191 " +
        "clearFields 数组含 'sql_validation_status'，实际清空发生在 collab-submit-helpers.js）",
};
const DYNAMIC_ANCHOR_RE = /if\s*\(\s*f\s*===\s*['"]sql_validation_status['"]\s*\)\s*\{([\s\S]{0,400}?)\n\s*\}/;
// 〔M4·codex 05 复审〕清空循环本体的锚点——for-of 循环体边界要单独抓出来，供"assert 之前不许
// 出现 clearSql +="这条判据在整个循环体范围内核查（不能只看 if 分支内部，真实的旁路手法是把
// 清空动作**移到 if 分支之前**执行，assert 反而变成摆设）。
const CLEAR_FIELDS_LOOP_ANCHOR_RE = /for\s*\(\s*const\s+f\s+of\s+clearFields\s*\)\s*\{/;
// 从"某个 { 的下一个字符"开始做花括号+引号感知深度扫描，找到与之配对的 }——返回花括号内部
// 文本（不含首尾花括号）及其在 text 里的绝对起止 offset。与 grabConstBlock 同款扫描逻辑，
// 差异是调用方已经知道左括号在哪，不用再正则找一次。
function grabBraceBodyFrom(text, openBraceEndIdx) {
    let depth = 1, i = openBraceEndIdx;
    for (; i < text.length; i++) {
        const c = text[i];
        if (c === "'" || c === '"' || c === '`') { i = skipStringLiteral(text, i); continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) return null;
    return { start: openBraceEndIdx, end: i, text: text.slice(openBraceEndIdx, i) };
}

function readAndStripAll(filesList) {
    const out = {};
    for (const f of filesList) {
        const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
        out[f] = stripJsCommentsStrict(raw);
    }
    return out;
}

// F4〔R2 返工·2026-09-03 codex 04 审 M1〕剥掉引号包裹内容——防被字符串字面量里出现的
// SET/WHERE/AND/OR 等词误判为真正的 SQL 关键字（如错误文案 '当前状态 X 不允许旁路' 或某个
// 伪列值恰好含这些大写单词）。〔S6 返工·2026-09-02 主会话预筛〕原版只剥单引号，双引号字符串
// 里出现同样的干扰词照样漏防——本仓虽以单引号 SQL 字面量为主，JS 侧偶有双引号字符串
// （如某些 error 文案），双引号不该是防线的盲区。扩到两种引号都剥。不处理转义（本仓字符串
// 内部转义引号罕见，即使遇到也只是让某一段剥得偏短，不影响"防误判"这条保守性质）。
// 〔M3·codex 05 复审，落地时收窄范围——见文件底部"待主会话裁定"说明〕逐字符扫描（复用
// skipStringLiteral 的转义感知），取代旧版正则 `'[^']*'`/`"[^"]*"`——旧版遇到字符串内的转义
// 引号（如 `'it\'s WHERE'`）会在第一个转义引号处提前收尾，把 `s WHERE'` 这一段原样漏在外面，
// 暴露出的 "WHERE" 字样能把真实写入点误判成读取（变异 v 复现）。新版对单/双引号都走
// skipStringLiteral（转义感知）。
// 〔收窄：不处理反引号〕codex 05 原话要求"模板串（反引号）整体按字符串剥"——但实测直接照做会
// 把真实 server.js 从 172/0 打成 160/9（详见函数外的 "M3 收窄" 说明）：本仓 UPDATE 语句整段
// 包在一个跨多行反引号模板串里，`sql_validation_status = '${x}'` 这类写入点本身就写在这个模板串
// 内部，400 字符回溯窗口天然落在"半个模板串"中途（看不到成对的开合反引号）——把遇到的反引号
// 当"开引号"处理，会把从这个反引号到窗口里下一个（其实属于另一条完全不相关语句的）反引号之间
// 的全部文本（含真正要找的 SET/WHERE 关键字）吞成占位符，直接摧毁分类机制本身。stripQuotedStrings
// 只用来防"短值字面量内容误判关键字"，反引号包的是整条 SQL（关键字本就在其中，不能剥），只剥
// 单/双引号足以覆盖变异 v 的真实场景（一个转义单引号的伪列值），不需要也不能碰反引号。
function stripQuotedStrings(text) {
    let out = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === "'" || c === '"') {
            const closeIdx = skipStringLiteral(text, i);
            if (closeIdx >= text.length) {
                // 找不到配对收尾引号——本函数只喂一段 400 字符回溯窗口（局部片段），窗口起点
                // 常常正好切在某个字符串中间，导致窗口内出现"落单"的引号（真正的配对伙伴在
                // 窗口之外）。旧版正则 `'[^']*'` 要求两个引号都在同一段文本内才算一次匹配，
                // 落单引号天然不匹配、原样留在输出里，其后的文本不受影响；这里必须对齐同一行为
                // ——不能把"找不到收尾"当"没写完的字符串、一路吞到窗口尾"，否则会把窗口尾部
                // 真正要找的 SET/WHERE/AND/OR 关键字一起吞掉（实测：utils/collab-submit-helpers.js
                // 的 running→queued 前置 WHERE 校验窗口，`datetime('now','localtime')` 与
                // `status='SUBMITTED'` 之间的引号计数是奇数，若吞到窗口尾会把随后的 `AND
                // sql_validation_status='queued'` 误判成"歧义→强制当写入"的假阳性）。
                out += c;
                i++;
                continue;
            }
            out += c + c; // 定长占位，只需不再暴露引号内文本，不要求还原长度
            i = closeIdx + 1;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

// 扫描剥注释后的源码，返回所有 `sql_validation_status =` 出现点，并按"向前 400 字符内最近
// 命中的关键字"分类：SET / setClauses.push → 写入；WHERE / AND / OR → 读取（忽略）。
// 〔R2 返工·2026-09-03 codex 04 审 M1，S6 返工·2026-09-02 扩双引号〕两处加固：
//   ① 分类前先 stripQuotedStrings(win)，避免单/双引号字符串内文本干扰关键字定位；
//   ② 窗口内**完全找不到**任何分类关键字（SET/setClauses.push/WHERE/AND/OR 一个都没有）时，
//      不再静默归为"读取"悄悄丢弃——升级为 isAmbiguous=true 并强制并入写入候选集（isWrite=true），
//      让下游"双向相等"核对把它当成一个"扫到但未登记"的新写入点判红，逼人工排查，而不是被过滤
//      条件 `.filter(o => o.isWrite)` 无声吞掉。
// R3〔12a-H4〕列名匹配改大小写不敏感（`i` 标志），并接受该列名被双引号或反引号包裹的引用形式
// （`"sql_validation_status"` / `` `sql_validation_status` ``）——原正则只认裸小写标识符，新文件
// 若用了这类写法会直接漏扫（不是判红，是看不见）。不处理单引号包裹（单引号在 SQL 里是字符串
// 字面量语法，不是标识符引用语法，把它也算进"列名引用"反而会制造新的误判面）。
const WRITE_KEY_RE = /["`]?sql_validation_status["`]?\s*=(?!=)/gi;
function scanWriteOccurrences(strippedSource) {
    const re = new RegExp(WRITE_KEY_RE.source, WRITE_KEY_RE.flags);
    const KEYWORD_RE = /\b(SET|WHERE|AND|OR)\b/g;
    const out = [];
    let m;
    while ((m = re.exec(strippedSource))) {
        const idx = m.index;
        const winStart = Math.max(0, idx - 400);
        const rawWin = strippedSource.slice(winStart, idx);
        const win = stripQuotedStrings(rawWin);
        let nearestPos = -1, nearestKw = null;
        KEYWORD_RE.lastIndex = 0;
        let km;
        while ((km = KEYWORD_RE.exec(win))) {
            if (km.index > nearestPos) { nearestPos = km.index; nearestKw = km[1]; }
        }
        const pushIdx = win.lastIndexOf('setClauses.push');
        if (pushIdx > nearestPos) { nearestPos = pushIdx; nearestKw = 'SET'; } // setClauses.push 视为 SET 同义
        const isAmbiguous = nearestKw === null; // 窗口内一个分类关键字都没有——都不命中
        const isWrite = nearestKw === 'SET' || isAmbiguous; // 都不命中时强制并入候选集，交给下游双向相等判红
        const line = strippedSource.slice(0, idx).split('\n').length;
        out.push({ index: idx, line, isWrite, isAmbiguous });
    }
    return out;
}

// 扫描全部登记文件，给每个"写入"出现点打上 {file, scope, ordinal}（身份键的三要素）
function scanAllWritesWithScope(fileTexts) {
    const result = [];
    for (const file of Object.keys(fileTexts)) {
        const stripped = fileTexts[file];
        const anchors = computeScopeAnchors(stripped);
        const occurrences = scanWriteOccurrences(stripped).filter((o) => o.isWrite);
        const ordinalCounters = {};
        for (const occ of occurrences) {
            const scope = scopeForIndex(anchors, occ.index);
            ordinalCounters[scope] = (ordinalCounters[scope] || 0) + 1;
            result.push({ file, scope, ordinal: ordinalCounters[scope], index: occ.index, line: occ.line, isAmbiguous: occ.isAmbiguous });
        }
    }
    return result;
}
function keyOf(w) { return `${w.file}|${w.scope}|${w.ordinal}`; }

// 定位邻近窗口内**最近的**含 assertSqlValidationStatus( 调用的那一行，返回其在源文本里的
// 字符起止 offset（供 ④ 实参核对 + 变异自证 c/d/h 做定点字符串操作，不依赖行号硬编码）
function findAssertCallLineSpan(strippedSource, matchIndex) {
    const matchLineNo = strippedSource.slice(0, matchIndex).split('\n').length;
    const lines = strippedSource.split('\n');
    const startLine = Math.max(1, matchLineNo - NEARBY_WINDOW_LINES);
    for (let ln = matchLineNo; ln >= startLine; ln--) {
        if (lines[ln - 1].includes('assertSqlValidationStatus(')) {
            const lineStartOffset = lines.slice(0, ln - 1).reduce((acc, l) => acc + l.length + 1, 0);
            const lineEndOffset = lineStartOffset + lines[ln - 1].length; // 不含末尾换行符
            return { line: ln, startOffset: lineStartOffset, endOffset: lineEndOffset, text: lines[ln - 1] };
        }
    }
    return null;
}
// 取 matchIndex 所在的整行文本（不含换行符）——供 ⑤ 单行右值核对 + 变异自证 i 定点替换
function lineTextAt(strippedSource, index) {
    const lineStart = strippedSource.lastIndexOf('\n', index - 1) + 1;
    let lineEnd = strippedSource.indexOf('\n', index);
    if (lineEnd < 0) lineEnd = strippedSource.length;
    return strippedSource.slice(lineStart, lineEnd);
}
// F5〔R2 返工·2026-09-03 codex 04 审 M2〕解析"当前赋值表达式"的精确 RHS 跨度——取代旧版
// forwardWindowText（写入行起向后 N 行的宽窗口 + 子串搜索）。旧版会被"巧合命中在别的列里"的
// 文本骗过（本列已改回硬字面量，但宽窗口仍能在下一列的值里找到同一个变量名子串，照样判绿）。
// 新版从 occurrence 的 `=` 开始扫描，正确处理三种边界：
//   - 顶层（未处于 `${...}` 插值内）遇到反引号 → 当前外层模板字符串本身收尾，RHS 到此为止
//     （如 admin-fix 的 `sql_validation_status = NULL` 紧跟模板字符串收尾反引号）；
//   - 顶层遇到逗号 → 本列 RHS 收尾，下一列另起（多列 SET 用逗号分隔）；
//   - 顶层遇到单/双引号 → 是一段 SQL 字符串字面量（如 `'${queuedStatus}'`），整段跳过
//     （不在字符串内部找边界字符）；
//   - 进入 `${` 插值后（interpDepth>0，真正的 JS 表达式上下文，如三元 `${isDoneFix ? \`a\` : \`b\`}`）：
//     内部允许任意嵌套的单/双/反引号字符串（整段跳过，不解析内部），`{`/`}` 计入插值深度，
//     深度归零时退出插值——插值内的逗号（如函数调用参数分隔）不算顶层逗号，不提前收尾。
//   三元表达式因此整体算作一个 RHS（不会在 `?`/`:` 处提前截断）。
function extractAssignmentRhs(strippedSource, occIndex) {
    const eqIdx = strippedSource.indexOf('=', occIndex);
    if (eqIdx < 0) return null;
    const start = eqIdx + 1;
    let i = start;
    let interpDepth = 0;
    while (i < strippedSource.length) {
        const c = strippedSource[i];
        if (interpDepth === 0) {
            if (c === '`' || c === ',') break;
            if (c === "'" || c === '"') { i = skipStringLiteral(strippedSource, i) + 1; continue; }
            if (c === '$' && strippedSource[i + 1] === '{') { interpDepth = 1; i += 2; continue; }
            i++;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { i = skipStringLiteral(strippedSource, i) + 1; continue; }
        if (c === '{') { interpDepth++; i++; continue; }
        if (c === '}') { interpDepth--; i++; continue; }
        i++;
    }
    return strippedSource.slice(start, i);
}
// R1〔12a-H1〕少数登记站点的 SQL RHS 本身是一个真三元 JS 插值（如 admin-submit-on-behalf 的
// isDoneFix 分支：`${isDoneFix ? \`sql_validation_status\` : \`'${adminFixClosedStatus}'\`}`——
// 为真时列自引用/保留原值（不写任何 assert 过的值），为假时才写字面量）——W5 的严格相等对这类
// 站点会误判红（整段 RHS 显然不等于 `'${varName}'`，但代码语义其实完全正确）。放行规则收得很紧：
// RHS 必须能被解析为 `${cond ? branchA : branchB}` 这个精确形状（分支只能是反引号/单/双引号
// 字符串字面量），且**恰好一支**逐字符等于 `'${varName}'`、**另一支必须逐字符等于裸列名
// `sql_validation_status`**（大小写不敏感，判定它确实是"保持原值不变"而不是另一处可控的值）——
// 不满足"另一支恰为列自引用"这个前提时一律拒绝，不留"两支都可能是任意值、只要其中一支凑巧对上
// 就放行"的口子（那样会让 CASE/三元包裹的注入值一样能蒙混过关）。
const RHS_TERNARY_SHAPE_RE = /^\$\{[\s\S]*?\?\s*(`(?:[^`\\]|\\.)*`|'[^']*'|"[^"]*")\s*:\s*(`(?:[^`\\]|\\.)*`|'[^']*'|"[^"]*")\s*\}$/;
function rhsIsColumnSelfReference(branchText) {
    return /^sql_validation_status$/i.test(branchText.trim());
}
function rhsMatchesTernarySelfRefOrLiteral(normalizedRhs, expectedLiteralRhs) {
    const m = RHS_TERNARY_SHAPE_RE.exec(normalizedRhs);
    if (!m) return false;
    const branchA = m[1].slice(1, -1);
    const branchB = m[2].slice(1, -1);
    if (branchA === expectedLiteralRhs && rhsIsColumnSelfReference(branchB)) return true;
    if (branchB === expectedLiteralRhs && rhsIsColumnSelfReference(branchA)) return true;
    return false;
}
// F6①〔R2 返工〕anchor 辅助定位窗口——按"行号 ± radius"取文本（与 scope+ordinal 身份键互补的
// 内容层校验，见 evaluateWriteCoverage 调用处注释）。
function anchorWindowText(strippedSource, occLine, radius) {
    const lines = strippedSource.split('\n');
    const start = Math.max(1, occLine - radius);
    const end = Math.min(lines.length, occLine + radius);
    return lines.slice(start - 1, end).join('\n');
}
// ④：从 assert 调用行文本抽「第一实参」+「第二实参（选项对象）文本」。
//   支持 assertSqlValidationStatus('x') / ("x") / (null, { allowNull: true })。
const ASSERT_CALL_ARG_RE = /assertSqlValidationStatus\(\s*(null|'[^']*'|"[^"]*")\s*(?:,\s*(\{[^}]*\}))?\s*\)/;
function parseAssertCallArg(lineText) {
    const m = ASSERT_CALL_ARG_RE.exec(lineText);
    if (!m) return null;
    const rawArg = m[1];
    const argLiteral = rawArg === 'null' ? null : rawArg.slice(1, -1); // 去引号
    const optsText = m[2] || '';
    return { argLiteral, hasAllowNullTrue: /allowNull\s*:\s*true/.test(optsText) };
}
// C2b〔一处写入点、多个合法值〕：支持 assertSqlValidationStatus(<cond> ? 'a' : 'b')
//   —— 实参是三元表达式而非单个字面量时，ASSERT_CALL_ARG_RE 匹配不上（`parsed` 会是 null，
//   ④「assert 调用行可解析出实参」会假红，即使代码完全正确）。给 wp.literalSet 类站点走这条
//   备用解析路径。
// 〔H2·codex 05 复审，取代旧版 assertCallArgWindowText + ASSERT_CALL_TERNARY_ARG_RE〕旧版把
//   "assert 调用起始行向后 4 行"整体喂给懒惰正则 `assertSqlValidationStatus\(\s*[\s\S]*?\?...\)`
//   ——`[\s\S]*?` 一旦本次调用自己的实参里找不到 `?`（如实参被换成裸变量 `mode2`），会继续懒惰
//   扩展匹配范围，越过本次调用自己的右括号，跨到窗口里后续几行**另一处**恰好也长得像三元的文本
//   上去，把那处的两个分支字面量误判成"本次调用的实参"——即便本次调用实际是一个完全不可
//   静态验证的裸变量，也会被判绿（实测复现：把实参换成 `mode2` 后，3 行内另塞一段同款
//   `flag ? 'external_skipped' : 'passed'`，旧实现仍判绿）。
//   新版先用括号 + 引号感知扫描（extractCallArgsText，复用 skipStringLiteral）从
//   assertSqlValidationStatus( 的左括号截出**这一次调用自己**的完整实参文本（精确匹配到与之
//   配对的右括号为止，不管跨几行），只在这段被物理边界圈定的文本内解析三元——结构上不可能
//   越界抓到窗口里别处的文本，无论那处文本多像三元。
function extractCallArgsText(text, openParenIdx) {
    let depth = 1, i = openParenIdx + 1;
    for (; i < text.length; i++) {
        const c = text[i];
        if (c === "'" || c === '"' || c === '`') { i = skipStringLiteral(text, i); continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) return null; // 右括号一路扫到文件尾都没配平——视为解析失败，不猜测
    return text.slice(openParenIdx + 1, i);
}
// 定位某次 assertSqlValidationStatus( 调用的左括号在 strippedSource 里的绝对偏移——
// span 由 findAssertCallLineSpan 给出（该调用所在的那一行的起止 offset）。
function findAssertCallOpenParenIdx(strippedSource, span) {
    const nameOffsetInLine = span.text.indexOf('assertSqlValidationStatus(');
    if (nameOffsetInLine < 0) return -1;
    return span.startOffset + nameOffsetInLine + 'assertSqlValidationStatus'.length;
}
// 三元解析只在"这一次调用自己的实参文本"（已被括号扫描物理圈定）内做——锚定整段文本
// （trim 后 ^...$），要求两个分支都是字面量，不满足就返回 null（不做 AST 化，保持 M2 的
// "不做 AST 化"边界；条件表达式本身允许任意内容，构不成新的跨调用攻击面，因为已经被
// extractCallArgsText 物理圈定在这一次调用内）。
const TERNARY_ARGS_ANCHORED_RE = /^[\s\S]*?\?\s*('[^']*'|"[^"]*")\s*:\s*('[^']*'|"[^"]*")\s*$/;
function parseTernaryArgsText(argsText) {
    const m = TERNARY_ARGS_ANCHORED_RE.exec(argsText.trim());
    if (!m) return null;
    return { branchLiterals: [m[1].slice(1, -1), m[2].slice(1, -1)] };
}
// ⑤：从 `const <name> = assertSqlValidationStatus(` 抽接收变量名（裸调用/无赋值 → null）
function parseAssertReceiverVar(lineText) {
    const m = /const\s+(\w+)\s*=\s*assertSqlValidationStatus\(/.exec(lineText);
    return m ? m[1] : null;
}

// R1〔12a-H1，主会话末次合并审②a〕接收变量的"整个初始化器"完整性校验——旧版 parseAssertReceiverVar
// 只锚定 `const <name> = assertSqlValidationStatus(` 这个**前缀**，对括号闭合之后、`;` 之前还跟了
// 什么完全不设防：`const receiverVar = assertSqlValidationStatus('queued') && 'admin_closed';` 这类
// 写法，前缀正则照样匹配出 receiverVar，④ 对调用本身的实参解析（'queued'）也完全合法——但 JS 短路
// 求值下 receiverVar 运行时实际取到的是 'admin_closed'（右操作数），而 SQL 写入行仍写
// `sql_validation_status = '${receiverVar}'`，文本层面 ④⑤ 两条判据都会误判绿，实际落库的值与
// 登记字面量不同。修复：要求"从 `=` 到语句级顶层 `;`"这一整段初始化器，剥掉首尾空白后**恰好**是
// 一次 assertSqlValidationStatus(...) 调用——不多不少，调用的右括号必须正好是初始化器的最后一个
// 非空白字符。任何跟在调用后面的 `&&`/`||`/`?`/`+`/`,` 等表达式都会在"右括号后仍有残留文本"这条
// 检查上现形，不需要为每个运算符单独维护一张禁用符号表。
//
// 从 startIdx（strippedSource 里"="之后第一个非空白字符的绝对偏移）开始，做括号/中括号/花括号
// +字符串感知扫描，直到遇到顶层（深度 0）的 `;` 为止，返回这段初始化器文本（不含分号）。
function extractStatementInitializer(strippedSource, startIdx) {
    let i = startIdx, depth = 0;
    while (i < strippedSource.length) {
        const c = strippedSource[i];
        if (c === "'" || c === '"' || c === '`') { i = skipStringLiteral(strippedSource, i) + 1; continue; }
        if (c === '(' || c === '{' || c === '[') { depth++; i++; continue; }
        if (c === ')' || c === '}' || c === ']') { depth--; i++; continue; }
        if (c === ';' && depth === 0) break;
        i++;
    }
    return strippedSource.slice(startIdx, i);
}
// 核对：span（含该行 assertSqlValidationStatus( 调用）所在的 `const <name> = ...;` 语句，其
// 初始化器恰为一次 assertSqlValidationStatus(...) 调用（无尾随表达式）。span.text 必须已经匹配过
// parseAssertReceiverVar（调用方保证），本函数只做"初始化器精确性"这一层独立校验。
function checkInitializerExactness(strippedSource, span) {
    const initStartRe = /const\s+\w+\s*=\s*(?=assertSqlValidationStatus\()/;
    const im = initStartRe.exec(span.text);
    if (!im) return { ok: false, text: '' };
    const initStartAbs = span.startOffset + im.index + im[0].length;
    const initText = extractStatementInitializer(strippedSource, initStartAbs);
    const trimmed = initText.trim();
    if (!trimmed.startsWith('assertSqlValidationStatus(')) return { ok: false, text: initText };
    const openParenIdx = trimmed.indexOf('(');
    const argsText = extractCallArgsText(trimmed, openParenIdx);
    if (argsText === null) return { ok: false, text: initText };
    const closeParenIdx = openParenIdx + 1 + argsText.length; // extractCallArgsText 已定位到匹配的 ')'
    const remainder = trimmed.slice(closeParenIdx + 1).trim();
    return { ok: remainder === '', text: initText };
}

// ============================================================
// ① 核心判定（纯函数，report 由调用方注入——真实运行传 must，变异自证传静默收集器）
// ============================================================
function evaluateWriteCoverage(fileTexts, writePoints, enumList, report) {
    const scannedWrites = scanAllWritesWithScope(fileTexts);
    const scannedKeys = new Set(scannedWrites.map(keyOf));
    const registeredKeys = new Set(writePoints.map(keyOf));
    const onlyInScan = [...scannedKeys].filter((k) => !registeredKeys.has(k));
    const onlyInRegistry = [...registeredKeys].filter((k) => !scannedKeys.has(k));
    report(onlyInScan.length === 0 && onlyInRegistry.length === 0,
        `写入点集合与登记表双向相等（登记 ${writePoints.length} 处，扫描到 ${scannedWrites.length} 处，身份键=file|scope|ordinal）`,
        [onlyInScan.length ? `扫到但未登记：${onlyInScan.join(', ')}` : '',
            onlyInRegistry.length ? `登记但扫不到：${onlyInRegistry.join(', ')}` : ''].filter(Boolean).join('；'));

    // F4〔R2 返工·2026-09-03 codex 04 审 M1〕"都不命中"显式判失败——不满足于让它靠双向相等
    // 顺带被抓出来（那只在它恰好占了一个未登记的 scope+ordinal 槽位时才生效），直接逐条报错，
    // 指名哪个出现点的分类窗口内一个 SET/WHERE/AND/OR/setClauses.push 关键字都找不到。
    const ambiguous = scannedWrites.filter((w) => w.isAmbiguous);
    report(ambiguous.length === 0,
        `扫描到的写入候选点分类窗口内均能明确归类为 SET 或 WHERE/AND/OR（无"都不命中"歧义点）`,
        ambiguous.length ? `歧义点：${ambiguous.map(keyOf).join(', ')}` : '');

    for (const wp of writePoints) {
        const stripped = fileTexts[wp.file];
        if (stripped === undefined) { report(false, `${keyOf(wp)}：未提供该文件文本`); continue; }
        const occ = scannedWrites.find((w) => keyOf(w) === keyOf(wp));
        if (!occ) { report(false, `${keyOf(wp)}：登记但扫描未命中（见上条双向核对）`); continue; }

        if (wp.literalSet) {
            const allInEnum = wp.literalSet.every((v) => enumList.includes(v));
            report(allInEnum, `[W1] ${keyOf(wp)}：登记字面量集合 {${wp.literalSet.join(', ')}} ⊆ 枚举 —— ${wp.desc}`,
                allInEnum ? '' : `不在枚举内：${wp.literalSet.filter((v) => !enumList.includes(v)).join(', ')}`);
        } else if (wp.literal !== null) {
            report(enumList.includes(wp.literal),
                `[W1] ${keyOf(wp)}：登记字面量 '${wp.literal}' ⊆ 枚举 —— ${wp.desc}`);
        }

        // F6①〔R2 返工·2026-09-03 codex 04 审 M3〕anchor 辅助定位校验：登记表每项额外声明一个
        // "该站点邻域内应唯一出现"的稳定上下文串（错误文案/日志标签/相邻列名等，非注释——注释会
        // 被剥掉），核对它在 occurrence 所在行 ±ANCHOR_WINDOW_LINES 行内恰好命中一次。scope+ordinal
        // 已经是身份键，anchor 是叠加的"人工可读、内容层面"校验——身份键算错位/挂到别的相似写入点
        // 上时，anchor 大概率对不上，能多一层独立信号。
        // S7〔主会话预筛·2026-09-02，分工边界声明〕anchor 只证明"occurrence 邻域 ±15 行内确实
        // 存在这段熟悉的上下文文本"，不证明"这段代码没有被整块搬到文件里另一个完全不相关的
        // 位置、且搬移后邻居代码也跟着一起搬"（即"整块搬移但内部相对位置不变"这种退化场景，
        // anchor 依然会命中——因为它只看局部窗口，不看这段代码在全文件里的绝对/相对角色）。
        // 这类"看起来像但语境已经变了"的整体性问题，交给人工 codex 审查 + 行为断言（G2 的
        // HTTP/单元测试真跑一遍看效果）兜底，不指望一个基于行号窗口的静态字符串匹配能覆盖。
        if (wp.anchor) {
            // 〔M2·codex 05〕anchor 窗口半径可选按登记项覆盖（缺省 ANCHOR_WINDOW_LINES=15）——
            // anchor 本身只是"人工可读、内容层面"的辅助信号，与 scope+ordinal 身份键正交叠加
            // （S7 已注明：命中不代表代码没有被整体搬到别处），不做 AST 化，只加一个可配置窗口。
            const radius = wp.anchorWindow || ANCHOR_WINDOW_LINES;
            const win = anchorWindowText(stripped, occ.line, radius);
            const cnt = win.split(wp.anchor).length - 1;
            report(cnt === 1,
                `[W2] ${keyOf(wp)}：anchor '${wp.anchor}' 在邻域 ±${radius} 行内恰好命中 1 次 —— ${wp.desc}`,
                `命中 ${cnt} 次`);
        }

        // ④：邻近 assert 调用存在 + 实参与登记字面量严格相等（R1 返工）+ literalSet 三元实参（C2b）
        const span = findAssertCallLineSpan(stripped, occ.index);
        report(!!span, `[W3] ${keyOf(wp)}：邻近 ${NEARBY_WINDOW_LINES} 行内有 assertSqlValidationStatus( 调用 —— ${wp.desc}`);
        let varName = null;
        if (span) {
            let parsed = parseAssertCallArg(span.text);
            let ternaryParsed = null;
            if (!parsed && wp.literalSet) {
                // 单值解析失败 + 该站点登记为 literalSet → 试三元实参解析（H2：括号+引号感知
                // 扫描截出这一次调用自己的完整实参范围，不依赖跨行窗口子串搜索）
                const openParenIdx = findAssertCallOpenParenIdx(stripped, span);
                const argsText = openParenIdx >= 0 ? extractCallArgsText(stripped, openParenIdx) : null;
                ternaryParsed = argsText !== null ? parseTernaryArgsText(argsText) : null;
            }
            report(!!parsed || !!ternaryParsed, `[W4] ${keyOf(wp)}：assert 调用行可解析出实参 —— ${wp.desc}`,
                (parsed || ternaryParsed) ? '' : `原文：${span.text.trim()}`);
            if (wp.literalSet) {
                if (ternaryParsed) {
                    const sortedParsed = [...ternaryParsed.branchLiterals].sort();
                    const sortedRegistry = [...wp.literalSet].sort();
                    const eq = sortedParsed.length === sortedRegistry.length
                        && sortedParsed.every((v, i) => v === sortedRegistry[i]);
                    report(eq,
                        `[W4] ${keyOf(wp)}：三元 assert 实参两分支集合与登记 literalSet 严格相等（实参={${sortedParsed.join(', ')}}）—— ${wp.desc}`,
                        eq ? '' : `登记={${sortedRegistry.join(', ')}}，实参={${sortedParsed.join(', ')}}`);
                } else if (parsed) {
                    // 单值实参形态（理论上 literalSet 站点也可能被改写成单值调用）——要求该值 ∈ literalSet
                    report(wp.literalSet.includes(parsed.argLiteral),
                        `[W4] ${keyOf(wp)}：单值 assert 实参 ∈ 登记 literalSet（实参='${parsed.argLiteral}'）—— ${wp.desc}`,
                        wp.literalSet.includes(parsed.argLiteral) ? '' : `登记={${wp.literalSet.join(', ')}}，实参='${parsed.argLiteral}'`);
                }
            } else if (parsed) {
                if (wp.literal === null) {
                    report(parsed.argLiteral === null && parsed.hasAllowNullTrue,
                        `[W4] ${keyOf(wp)}：assert 实参 = null 且同调用含 allowNull:true —— ${wp.desc}`,
                        `实参=${JSON.stringify(parsed.argLiteral)}, allowNull:true=${parsed.hasAllowNullTrue}`);
                } else {
                    report(parsed.argLiteral === wp.literal,
                        `[W4] ${keyOf(wp)}：assert 实参与登记字面量严格相等（实参='${parsed.argLiteral}'）—— ${wp.desc}`,
                        parsed.argLiteral === wp.literal ? '' : `登记='${wp.literal}'，实参='${parsed.argLiteral}'`);
                }
            }
            varName = parseAssertReceiverVar(span.text);
            // R1〔12a-H1〕接收变量存在时（单值/literalSet 两类站点都会走到这里，null 裸调用站点
            // varName 本就是 null，天然跳过），额外核对它的初始化器"恰为一次调用，无尾随表达式"——
            // 与④原有的"实参解析/取值正确"是两条互补判据：④管"调用参数对不对"，这条管"调用返回值
            // 有没有被别的表达式再加工一次才赋给接收变量"。标记 [W4]：与④同属"assert 调用正确性"
            // 这一条规则族（12a-M2 变异自证规则 ID 精确断言用）。
            if (varName) {
                const initCheck = checkInitializerExactness(stripped, span);
                report(initCheck.ok,
                    `[W4] ${keyOf(wp)}：接收变量 ${varName} 的初始化器恰为一次 assertSqlValidationStatus(...) 调用（无 &&/||/?/+/, 等尾随表达式）—— ${wp.desc}`,
                    initCheck.ok ? '' : `初始化器原文：${initCheck.text.trim().slice(0, 200)}`);
            }
        }

        // ⑤〔R2 返工·2026-09-03 codex 04 审 M2〕写入行右值必须引用 ④ 里那个 assert 返回值变量；
        //     null 站点右值须是字面 NULL。旧版用 forwardWindowText（写入行起向后 5 行的宽窗口）做
        //     子串搜索，测不出"巧合命中在别的列里"这种假绿（如本列已改回硬字面量，但下一列碰巧也
        //     引用了同名变量，宽窗口子串搜索照样通过）。改用 extractAssignmentRhs 精确解析"当前
        //     赋值表达式"的跨度（从本 occurrence 的 `=` 起，到顶层逗号或外层模板字符串收尾为止，
        //     三元整体算一个 RHS），只在这个精确范围内核对，不越界到邻列。
        const rhs = extractAssignmentRhs(stripped, occ.index);
        if (wp.literal === null) {
            report(!!rhs && rhs.trim() === 'NULL',
                `[W5] ${keyOf(wp)}：写入行右值为字面 NULL —— ${wp.desc}`,
                rhs ? `实得 RHS：${rhs.trim()}` : '(RHS 解析失败)');
        } else {
            report(!!varName, `[W5] ${keyOf(wp)}：assert 调用行可解出接收变量名（供核对写入行是否真引用它）—— ${wp.desc}`,
                varName ? '' : `assert 调用原文：${span ? span.text.trim() : '(未找到)'}`);
            if (varName) {
                // R1〔12a-H1〕严格相等取代旧版 .includes() 子串检查——旧版只要求 RHS 文本"包含"
                // `'${varName}'` 这个子串即判绿，测不出 `CASE WHEN ... THEN '${varName}' ELSE 'x' END`
                // 这类"把真正引用包裹在一段更大的 SQL 表达式里、SQL 层面并不恒等于该变量值"的写法——
                // 子串确实存在，但整条 RHS 已经不是"纯引用该变量"这么简单。改为：RHS 折叠连续空白
                // 后 trim，必须与 `'${varName}'` **逐字符相等**，不允许任何前后缀内容。
                const normalizedRhs = rhs ? rhs.replace(/\s+/g, ' ').trim() : '';
                const expectedLiteralRhs = `'\${${varName}}'`;
                const hit = normalizedRhs === expectedLiteralRhs
                    || rhsMatchesTernarySelfRefOrLiteral(normalizedRhs, expectedLiteralRhs);
                report(hit,
                    `[W5] ${keyOf(wp)}：写入行右值（精确 RHS 跨度，规范化空白后）严格等于 '\${${varName}}'，或为"列自引用 vs 该字面量"两支三元 —— ${wp.desc}`,
                    hit ? '' : `规范化 RHS：${normalizedRhs.slice(0, 200)}`);
            }
        }
    }

    const dyn = fileTexts[DYNAMIC_WRITE_POINT.file];
    if (dyn !== undefined) {
        const m = DYNAMIC_ANCHOR_RE.exec(dyn);
        report(!!m, `[D1] 动态清空写入点锚点存在（f==='sql_validation_status' 分支，scope=${DYNAMIC_WRITE_POINT.scope}）—— ${DYNAMIC_WRITE_POINT.desc}`);
        if (m) {
            const branchBody = m[1];
            report(branchBody.includes('assertSqlValidationStatus('),
                `[D2] 动态清空写入点分支内调用 assertSqlValidationStatus( —— ${DYNAMIC_WRITE_POINT.desc}`);
            // 〔R2 返工·2026-09-03 codex 04 审 F2〕光"分支内含调用"不够——必须核对该调用的实参
            // 真是 null+allowNull:true（复用 parseAssertCallArg，与①单值站点同一套判据），并核对
            // 该调用在分支内**无条件执行**（分支体不含嵌套 if，不会被进一步的条件绕过）+ 位置在
            // 紧随分支结束后的 `clearSql +=` 无条件清空语句**之前**（清空动作对每个白名单字段一视
            // 同仁，断言必须先于它执行，不能"先清空、断言只是摆设、事后没人看"）。
            const branchLines = branchBody.split('\n');
            const assertLineText = branchLines.find((l) => l.includes('assertSqlValidationStatus('));
            if (assertLineText) {
                const parsed = parseAssertCallArg(assertLineText);
                report(!!parsed, `[D3] 动态清空写入点：assert 调用行可解析出实参 —— ${DYNAMIC_WRITE_POINT.desc}`,
                    parsed ? '' : `原文：${assertLineText.trim()}`);
                if (parsed) {
                    report(parsed.argLiteral === null && parsed.hasAllowNullTrue,
                        `[D4] 动态清空写入点：assert 实参 = null 且同调用含 allowNull:true —— ${DYNAMIC_WRITE_POINT.desc}`,
                        `实参=${JSON.stringify(parsed.argLiteral)}, allowNull:true=${parsed.hasAllowNullTrue}`);
                }
                report(!/\bif\s*\(/.test(branchBody),
                    `[D5] 动态清空写入点：assert 调用在 if 分支内无条件执行（分支体不含嵌套 if）—— ${DYNAMIC_WRITE_POINT.desc}`);
                // R3〔主会话预筛返工·2026-09-02〕上面两条（"含调用" + "无嵌套 if"）测不出
                // `flag && assertSqlValidationStatus(null, {allowNull:true})` 这种短路旁路——
                // `.includes('assertSqlValidationStatus(')` 和 parseAssertCallArg 的正则都不锚定
                // 行首，`flag && X` 里 X 前面接了什么完全不影响这两条判据；短路写法下 assert 只在
                // flag 为真时才求值，NULL 站点的"清空前必经断言"契约名存实亡。补两条硬约束：
                //   ① 调用行 trim 后必须**以** `assertSqlValidationStatus(` 开头（不允许任何前缀，
                //      包括短路操作数/三元分支/switch-case 标签）；
                //   ② 分支体本身不得出现 `&&`/`||`/`?`/`switch`/`try` 这类会让"是否执行 assert
                //      调用"变成条件性的结构。
                report(assertLineText.trim().startsWith('assertSqlValidationStatus('),
                    `[D6] 动态清空写入点：assert 调用行 trim 后以 assertSqlValidationStatus( 开头（拒短路/三元前缀）—— ${DYNAMIC_WRITE_POINT.desc}`,
                    `原文：${assertLineText.trim()}`);
                const shortCircuitRe = /&&|\|\||\?|switch|try/;
                report(!shortCircuitRe.test(branchBody),
                    `[D7] 动态清空写入点：分支体不含 &&/||/?/switch/try（assert 调用不可被短路/条件化）—— ${DYNAMIC_WRITE_POINT.desc}`,
                    shortCircuitRe.test(branchBody) ? `命中：${shortCircuitRe.exec(branchBody)[0]}` : '');

                // 〔H1·codex 05 复审〕上面"不含嵌套 if"+"分支体无 &&/||/?/switch/try"两条测不出
                // 把 assert 调用整个包进一个新声明、但从不调用的函数/循环体里这种旁路——
                // `const run = () => { assertSqlValidationStatus(null, { allowNull: true }); };`
                // 既不含 if，也不含 &&/||/?/switch/try，两条既有判据都会误判绿，但断言实际从未
                // 在清空前被执行过。补两条硬约束：
                //   ① 分支体不得出现 =>/function/for/while/return 关键字（能把 assert 调用包进
                //      一层新的、可延迟/可不执行的代码块）；
                //   ② assert 调用自身起点的花括号嵌套深度必须为 0（相对分支体起点算——调用自己
                //      第二实参 `{ allowNull: true }` 的花括号在调用起点**之后**才打开，不影响
                //      起点处的深度读数）。
                const dynBannedKeywordRe = /=>|\bfunction\b|\bfor\b|\bwhile\b|\breturn\b/;
                report(!dynBannedKeywordRe.test(branchBody),
                    `[D8] 动态清空写入点：分支体不含 =>/function/for/while/return（assert 调用不可被包进嵌套函数/循环/条件返回）—— ${DYNAMIC_WRITE_POINT.desc}`,
                    dynBannedKeywordRe.test(branchBody) ? `命中：${dynBannedKeywordRe.exec(branchBody)[0]}` : '');
                const assertCallIdxInBranch = branchBody.indexOf('assertSqlValidationStatus(');
                if (assertCallIdxInBranch >= 0) {
                    const depthAtAssert = computeBraceDepthAt(branchBody, assertCallIdxInBranch);
                    report(depthAtAssert === 0,
                        `[D9] 动态清空写入点：assert 调用位于分支体花括号深度 0（未被套进额外的 {}）—— ${DYNAMIC_WRITE_POINT.desc}`,
                        `实得深度=${depthAtAssert}`);
                }

                // 〔M4·codex 05 复审〕旧版只找"分支结束后第一个 clearSql +="并比较其与 assert 的
                // 前后位置——测不出"把真正生效的清空语句挪到 assert 之前执行、分支后另外追加一句
                // 无关的 clearSql += ''"这种旁路（分支后第一个 clearSql += 仍落在分支之后，位置
                // 比较照样通过，但真正对字段 f 生效的清空早就跑在 assert 前面、断言已经名存实亡）。
                // 改成两条判据都必须成立：
                //   ① 循环体内、assert 调用位置**之前**不允许出现任何 clearSql += （不局限于
                //      "紧邻分支"这个更窄的范围，覆盖循环体从头到 assert 之间的整段）；
                //   ② 分支结束后**紧邻**（只隔空白）的下一条语句必须是 clearSql += 且其右值文本
                //      含 `${f}`（确认是真对当前字段 f 生效的那一句，不是随便一句同名占位调用）。
                const assertOffsetInDyn = m.index + branchBody.indexOf(assertLineText);
                const loopAnchorMatch = CLEAR_FIELDS_LOOP_ANCHOR_RE.exec(dyn);
                report(!!loopAnchorMatch,
                    `[D10] 动态清空写入点：可定位 clearFields 循环体（for (const f of clearFields) {）—— ${DYNAMIC_WRITE_POINT.desc}`);
                if (loopAnchorMatch) {
                    const loopBody = grabBraceBodyFrom(dyn, loopAnchorMatch.index + loopAnchorMatch[0].length);
                    report(!!loopBody, `[D12] 动态清空写入点：循环体花括号可配对提取 —— ${DYNAMIC_WRITE_POINT.desc}`);
                    if (loopBody) {
                        // R2〔12a-H2〕新增前置校验：DYNAMIC_ANCHOR_RE.exec(dyn) 不带 g 标志，只取
                        // "文件中第一个匹配"，从不校验这个匹配点是否真落在 clearFields 循环体范围
                        // 内——若真实分支被挪到循环之前的一个 if (false) {...} 死代码块里（循环体内
                        // 不再含任何 sql_validation_status 分支），m 会先命中这个循环外的替身，
                        // 下面"assert 之前有没有 clearSql +="这条判据实际拿"替身坐标"去跟"真实循环
                        // 体"的坐标区间比较——因为 assertOffsetInDyn < loopBody.start，
                        // dyn.slice(loopBody.start, assertOffsetInDyn) 天然是空字符串，"不包含
                        // clearSql +="恒真，构成假绿。这条前置校验直接堵上：匹配点必须落在循环体
                        // [loopBody.start, loopBody.end) 范围内。
                        const branchInLoop = m.index >= loopBody.start && (m.index + m[0].length) <= loopBody.end;
                        report(branchInLoop,
                            `[D11] 动态清空写入点：匹配到的 if (f === 'sql_validation_status') 分支落在 clearFields 循环体范围内（非循环外替身）—— ${DYNAMIC_WRITE_POINT.desc}`,
                            branchInLoop ? '' : `分支绝对偏移 [${m.index}, ${m.index + m[0].length}) 不在循环体 [${loopBody.start}, ${loopBody.end}) 内`);
                        // R6〔12a-M2，精确断言收敛〕D13/D14/D15 都依赖"m.index/assertOffsetInDyn 是
                        // 循环体内的有效坐标"这个前提——一旦 branchInLoop 已经为 false（分支根本不在
                        // 循环体范围内），这三条判据拿到的位置比较结果本身就没有诊断意义（要么因为
                        // slice(start,end) 在 start>end 时返回空字符串而巧合判绿，要么因为"分支结束后
                        // 紧邻的文本"变成了循环声明本身之类的无关内容而判红）——两种巧合都不是这三条
                        // 判据真正想核对的事。branchInLoop 已经把"位置不对"这个根因单独判红了，这里
                        // 跳过而不是让 D13-D15 在无效坐标上产出误导性的（哪怕碰巧正确的）红/绿。
                        if (branchInLoop) {
                            const beforeAssert = dyn.slice(loopBody.start, assertOffsetInDyn);
                            report(!beforeAssert.includes('clearSql +='),
                                `[D13] 动态清空写入点：循环体内 assert 调用之前不存在任何 clearSql += 语句 —— ${DYNAMIC_WRITE_POINT.desc}`,
                                beforeAssert.includes('clearSql +=') ? '命中：assert 之前已有 clearSql += 语句' : '');
                            const branchEndIdx = m.index + m[0].length;
                            const afterBranch = dyn.slice(branchEndIdx, Math.min(dyn.length, branchEndIdx + 200));
                            const immediateMatch = /^\s*clearSql\s*\+=\s*([^;]*);/.exec(afterBranch);
                            report(!!immediateMatch,
                                `[D14] 动态清空写入点：分支结束后紧邻的下一条语句是 clearSql += —— ${DYNAMIC_WRITE_POINT.desc}`,
                                immediateMatch ? '' : `紧邻文本：${afterBranch.trim().slice(0, 80)}`);
                            if (immediateMatch) {
                                report(immediateMatch[1].includes('${f}'),
                                    `[D15] 动态清空写入点：紧邻的 clearSql += 语句右值含 \${f}（真对当前字段 f 生效，非无关占位）—— ${DYNAMIC_WRITE_POINT.desc}`,
                                    `实得：${immediateMatch[1]}`);
                            }
                        }
                    }
                }
            }
        }
    } else {
        report(false, `${DYNAMIC_WRITE_POINT.file}：未提供该文件文本（动态清空写入点无法检测）`);
    }
}

// ============================================================
// ② 前端三处枚举覆盖
// ============================================================
function extractFrontendBlocks() {
    const html = fs.readFileSync(DATA_COLLAB_HTML_PATH, 'utf8');
    const scriptSrc = pageScriptText(html);
    const stripped = stripJsCommentsLoose(scriptSrc);
    return {
        labelsBlock: grabConstBlock(stripped, 'SQL_VALIDATION_LABELS'),
        renderFnBody: grabFnBody(stripped, 'renderValidationSection'),
        exportFnBody: grabFnBody(stripped, 'collabExportValidationStatus'),
    };
}

// F6②〔R2 返工·2026-09-03 codex 04 审 M3/M4〕精确映射登记——SQL_VALIDATION_LABELS 每个枚举值
// 对应的 cls（挂到 DOM class 上的那一格，真正的白名单落点）。旧版 hasValueToken 只查"这个字符串
// token 有没有在函数体/对象字面量文本里出现过"，测不出"两个键的 cls 被互换"这类改一格错位——
// 互换后两个 cls 值仍都在文本里，只是挂到了错的 key 上，纯 token 存在性检查天然看不出来。
const SQL_VALIDATION_LABEL_CLS_MAP = Object.freeze({
    passed: 'val-passed',
    failed: 'val-failed',
    running: 'val-running',
    bypassed: 'val-bypassed',
    queued: 'val-running',
    admin_closed: 'val-admin-closed',
    external_skipped: 'val-external',
});

// 提取 `else if (<condRe 命中>) { ... }` 分支体（花括号深度扫描，跳过字符串/模板串内的花括号，
// 与 grabConstBlock 同款写法，复用 skipStringLiteral）。
function extractIfElseBranchBody(fnBody, condRe) {
    if (!fnBody) return null;
    const m = condRe.exec(fnBody);
    if (!m) return null;
    const openIdx = fnBody.indexOf('{', m.index + m[0].length);
    if (openIdx < 0) return null;
    let depth = 0, i = openIdx;
    for (; i < fnBody.length; i++) {
        const c = fnBody[i];
        if (c === "'" || c === '"' || c === '`') { i = skipStringLiteral(fnBody, i); continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return fnBody.slice(openIdx, i);
}

// 〔M1·codex 05 复审〕renderValidationSection / collabExportValidationStatus 的逐值覆盖检查从
// "字符串 token 在函数体文本里出现过没有"升级为"结构化"——旧版 hasValueToken 只做子串存在性
// 检查，测不出"return 语句被改写、但某个 token 恰好还残留在别处"这类改法（变异 u 复现：把某个
// return 分支改写掉、但把这个值的字面量留在函数体别的地方当"障眼法"，旧检查照样判绿）。
//   ① collabExportValidationStatus：要求存在 `if (...r.sql_validation_status === '<v>'...)
//      return '<非空字符串>'`——核心比较式落在同一个 if(...) 条件内，紧跟 return 一个非空字符串
//      字面量。条件内允许出现其它 ||/&& 分支（真实的 bypassed 站点写法是 `if (r.bypass_validation
//      === 1 || r.sql_validation_status === 'bypassed') return '旁路放行';`），不要求
//      sql_validation_status 比较式是条件里唯一的子表达式——只要求这次比较 + 紧邻的 return 都在。
//   ② renderValidationSection：要求 `vs === '<v>'` 这个比较式本身出现（真实 bypassed 站点写法是
//      `const isBypassed = d.bypass_validation === 1 || vs === 'bypassed';`——比较式本身仍是
//      这个精确 token 序列，出现在赋值表达式里也算数，允许 || 组合）。
const EXPORT_STRUCT_RE_CACHE = {};
function exportStructRegexFor(v) {
    if (!EXPORT_STRUCT_RE_CACHE[v]) {
        const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        EXPORT_STRUCT_RE_CACHE[v] = new RegExp(
            `if\\s*\\([^)]*r\\.sql_validation_status\\s*===\\s*'${escaped}'[^)]*\\)\\s*return\\s*'[^']+'`);
    }
    return EXPORT_STRUCT_RE_CACHE[v];
}
function renderVsRegexFor(v) {
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 〔08-M5·codex 08 审〕原正则只要求 `vs === '<v>'` 在函数体任意位置出现即可判绿——一处无关的
    // 装饰性赋值（如 `const decoy = vs === 'passed'`）也能让判据误判"该分支判断存在"。收窄为必须
    // 出现在 if(/else if( 的条件括号内才算真的构成一条渲染分支判断（变异 ★x 自证）。
    const directRe = new RegExp(`(?:if|else\\s+if)\\s*\\([^)]*\\bvs\\s*===\\s*'${escaped}'`);
    // 〔S3·Opus 预筛，收窄自 08-M5〕布尔别名通道**只对 'bypassed' 开放，且别名名必须精确等于
    // 'isBypassed'**——这是本仓唯一一处真实需要"两个来源 `||` 合并、不能直接内联进 if(...)"写法
    // 的分支（`const isBypassed = d.bypass_validation === 1 || vs === 'bypassed'`）。此前对全部
    // 6 个枚举值通用开放这条别名通道、只要求"别名被某个 if( 引用"，被证明太宽：
    // `const decoy = vs === 'passed'; if (decoy && false) {}` 这种恒为死代码的构造也能命中
    // "别名被 if 引用"（正则只看 if( 后紧跟别名名，测不出 `&& false` 让分支永远不执行），照样
    // 误判绿（变异 ★x2 自证）。其余五值不该有任何别名逃生通道，一律强制走 direct 条件——
    // 收窄后 `v !== 'bypassed'` 时直接返回 directRe 本体（原生 RegExp 自带 .test()，接口不变）。
    if (v !== 'bypassed') return directRe;
    const aliasAssignRe = new RegExp(`const\\s+isBypassed\\s*=\\s*[^;]*\\bvs\\s*===\\s*'${escaped}'[^;]*;`);
    const aliasUsedRe = /(?:if|else\s+if)\s*\(\s*isBypassed\b/;
    return {
        test(text) {
            if (directRe.test(text)) return true;
            return aliasAssignRe.test(text) && aliasUsedRe.test(text);
        },
    };
}

function evaluateFrontendCoverage(blocks, enumList, report) {
    report(!!blocks.labelsBlock, 'SQL_VALIDATION_LABELS 对象字面量可提取');
    report(!!blocks.renderFnBody, 'renderValidationSection 函数体可提取');
    // R4 加固：函数体行数合理性上限——grabFnBody 收尾锚点找错时（如收尾 `}` 缩进被人为改动 1 格）
    //   旧实现会兜底"抓到文件尾"，体量可以膨胀到正常函数体的数倍仍返回真值；行数上限把这类
    //   "提取成功但内容早已跑偏"的情况变成显式判红，而不是指望后续 token 检查侥幸也判红。
    if (blocks.renderFnBody) {
        const lc = lineCountOf(blocks.renderFnBody);
        report(lc < MAX_REASONABLE_FN_BODY_LINES,
            `renderValidationSection 函数体行数合理（${lc} 行 < ${MAX_REASONABLE_FN_BODY_LINES}）`,
            lc < MAX_REASONABLE_FN_BODY_LINES ? '' : `实得 ${lc} 行，疑似收尾锚点没找准（吞到别的函数/文件尾）`);
    }
    report(!!blocks.exportFnBody, 'collabExportValidationStatus 函数体可提取');
    if (blocks.exportFnBody) {
        const lc = lineCountOf(blocks.exportFnBody);
        report(lc < MAX_REASONABLE_FN_BODY_LINES,
            `collabExportValidationStatus 函数体行数合理（${lc} 行 < ${MAX_REASONABLE_FN_BODY_LINES}）`,
            lc < MAX_REASONABLE_FN_BODY_LINES ? '' : `实得 ${lc} 行，疑似收尾锚点没找准（吞到别的函数/文件尾）`);
    }
    if (!blocks.labelsBlock || !blocks.renderFnBody || !blocks.exportFnBody) return;

    for (const v of enumList) {
        report(hasValueToken(blocks.labelsBlock, v), `[F1] SQL_VALIDATION_LABELS 含 '${v}' 分支`);
        // 〔M1〕②：renderValidationSection 须含结构化比较式 `vs === '<v>'`（允许出现在 || 组合里）
        report(renderVsRegexFor(v).test(blocks.renderFnBody), `[F2] renderValidationSection 含结构化条件 vs === '${v}'`);
        // 〔M1〕①：collabExportValidationStatus 须含结构化分支 `if (...sql_validation_status === '<v>'...) return '...'`
        report(exportStructRegexFor(v).test(blocks.exportFnBody),
            `[F3] collabExportValidationStatus 含结构化分支 if (...sql_validation_status === '${v}'...) return '...'`);
    }

    // 反向核对：LABELS 声明的 key 集合 ⊆ 枚举（防"前端多声明了个不存在于枚举的值"——
    // 纯正向包含关系测不出这一半，也是变异 a) 让 ② 判红的必要一环）
    const labelKeys = [...blocks.labelsBlock.matchAll(/'([a-z_]+)'\s*:\s*Object\.freeze/g)].map((x) => x[1]);
    report(labelKeys.length > 0, 'SQL_VALIDATION_LABELS 可提取 key 集合（反向核对用）');
    const extra = labelKeys.filter((k) => !enumList.includes(k));
    report(extra.length === 0, 'SQL_VALIDATION_LABELS 的 key 集合 ⊆ 枚举（无多余/幽灵值）',
        extra.length ? `多出：${extra.join(', ')}` : '');

    // R4〔主会话预筛返工·2026-09-02〕SQL_VALIDATION_LABEL_CLS_MAP 键集合须与 enumList 双向相等——
    // 下面的精确映射循环是"驱动方=CLS_MAP 自己的键"，天然测不出"枚举新增了一个值，但 CLS_MAP
    // 忘了同步登记"这种缺口（循环压根不知道有这个新值存在）。这里单独做一次双向 diff。
    const clsMapKeys = Object.keys(SQL_VALIDATION_LABEL_CLS_MAP);
    const enumMissingInClsMap = enumList.filter((v) => !clsMapKeys.includes(v));
    const clsMapExtraNotInEnum = clsMapKeys.filter((k) => !enumList.includes(k));
    report(enumMissingInClsMap.length === 0 && clsMapExtraNotInEnum.length === 0,
        'SQL_VALIDATION_LABEL_CLS_MAP 键集合与枚举双向相等（无枚举新值漏登记，无 CLS_MAP 幽灵键）',
        [enumMissingInClsMap.length ? `枚举有但 CLS_MAP 未登记：${enumMissingInClsMap.join(', ')}` : '',
            clsMapExtraNotInEnum.length ? `CLS_MAP 有但枚举没有：${clsMapExtraNotInEnum.join(', ')}` : ''].filter(Boolean).join('；'));

    // F6②：精确映射断言——逐键核对 SQL_VALIDATION_LABELS[key].cls 严格等于登记值，不满足于
    // "cls 字符串存在于文本某处"。
    for (const [key, expectedCls] of Object.entries(SQL_VALIDATION_LABEL_CLS_MAP)) {
        const re = new RegExp(`'${key}'\\s*:\\s*Object\\.freeze\\(\\{[^}]*cls\\s*:\\s*'([^']*)'`);
        const m = re.exec(blocks.labelsBlock);
        report(!!m && m[1] === expectedCls,
            `SQL_VALIDATION_LABELS.${key}.cls 精确等于 '${expectedCls}'`,
            m ? `实得 '${m[1]}'` : '未匹配到该 key 的 cls 定义');
    }

    // F6②：renderValidationSection 的 external_skipped 分支必须使用 val-external-bg（详情框底色
    // class，与 badge/胶囊用的 val-external 是不同层级——分开断言，防止两者被混用/漏写任一个）。
    const externalBranch = extractIfElseBranchBody(blocks.renderFnBody, /vs\s*===\s*'external_skipped'/);
    report(!!externalBranch, 'renderValidationSection 可提取 external_skipped 分支体');
    if (externalBranch) {
        report(externalBranch.includes('val-external-bg'),
            "renderValidationSection 的 external_skipped 分支内含 'val-external-bg'");
    }
}

// ============================================================
// ③ 变异自证——纯内存操作，不写真实文件
// ============================================================
// R6〔12a-M2 部分，主会话末次合并审②a〕规则 ID 精确断言——W1-W5（后端写入点五条断言）、
// F1-F3（前端三处枚举断言）、D1-D15（动态清空站点各分支判据）在其 report() 消息前缀
// `[<ID>]` 标注（同一文件既有的 `★<label>)` 前缀是"这是第几组变异"，`[<ID>]` 是"这组变异
// 命中了哪条具体规则"，两套标注正交独立）。收集失败消息里的 ID 集合，供变异自证断言
// "这组变异应该且只应该让某条规则判红"——比"failCount > 0"更精确：能证明修复只堵住了
// 目标口子，没有因为逻辑耦合而误伤别的规则，也没有因为判据太粗糙而放过了本该独立触发的
// 其它规则。
const RULE_ID_RE = /^\[([A-Z]\d+)\]/;
function ruleIdOf(msg) { const m = RULE_ID_RE.exec(msg); return m ? m[1] : null; }
// 精确断言："这组变异应该且只应该命中 expectedIds 里列出的这些规则 ID"——size 相等 + 逐个存在，
// 两个方向都要核（size 相等排除"多命中了别的规则"，逐个存在排除"目标规则其实没中，只是凑巧
// 别的规则也变红让 failCount>0"）。
function idsExactly(failedRuleIds, expectedIds) {
    return failedRuleIds.size === expectedIds.length && expectedIds.every((id) => failedRuleIds.has(id));
}
function makeCollector() {
    const problems = [];
    const report = (cond, msg) => { if (!cond) problems.push(msg); };
    return {
        report, problems,
        get failCount() { return problems.length; },
        get failedRuleIds() { return new Set(problems.map(ruleIdOf).filter(Boolean)); },
    };
}

// 解析某个登记写入点在"当前"扫描结果里的物理位置（index），供变异 c/d 定位——
// 用 scope+ordinal 查找，不依赖硬编码行号/硬编码变量名字符串。
function locateOccurrence(fileTexts, wp) {
    const scanned = scanAllWritesWithScope(fileTexts);
    return scanned.find((w) => keyOf(w) === keyOf(wp)) || null;
}

function runMutationSelfTests(realFileTexts, realBlocks) {
    console.log('\n— ③ 变异自证（内存字符串/内存枚举副本，不写真实文件）—');

    // e) 对照组：原文 → 全绿
    {
        const c1 = makeCollector();
        evaluateWriteCoverage(realFileTexts, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
        const c2 = makeCollector();
        evaluateFrontendCoverage(realBlocks, SQL_VALIDATION_STATUSES, c2.report);
        must(c1.failCount === 0 && c2.failCount === 0,
            '★e) 对照组：真实文件 ①+② 全绿',
            (c1.failCount || c2.failCount)
                ? `①失败 ${c1.failCount} 项 / ②失败 ${c2.failCount} 项：${[...c1.problems, ...c2.problems].join(' | ')}`
                : '');
    }

    // a) 枚举删掉 'failed'（既是 4 处写入点字面量、又是 LABELS key）→ ①②同时判红
    {
        const mutatedEnum = SQL_VALIDATION_STATUSES.filter((v) => v !== 'failed');
        const c1 = makeCollector();
        evaluateWriteCoverage(realFileTexts, WRITE_POINTS, mutatedEnum, c1.report);
        const c2 = makeCollector();
        evaluateFrontendCoverage(realBlocks, mutatedEnum, c2.report);
        must(c1.failCount > 0, "★a-①) 枚举删掉 'failed' → 写入点覆盖判红（4 处 failed 写入点字面量不再 ⊆ 枚举）");
        must(c2.failCount > 0, "★a-②) 枚举删掉 'failed' → 前端覆盖判红（LABELS.failed 的 key 反向核对不再 ⊆ 枚举）");
    }

    // b) 枚举加一值 'zzz' → ② 判红（前端三处均无 'zzz' 分支）
    {
        const mutatedEnum = [...SQL_VALIDATION_STATUSES, 'zzz'];
        const c2 = makeCollector();
        evaluateFrontendCoverage(realBlocks, mutatedEnum, c2.report);
        must(c2.failCount > 0, "★b) 枚举加一值 'zzz' → 前端覆盖判红（三处均无 'zzz' 分支，正向包含关系缺口）");
    }

    // c) 抹掉一处 assertSqlValidationStatus( 调用（字符串替换为空，只动这一处）→ ① 判红
    //    目标用 scope+ordinal 解析出物理位置，不硬编码行号/变量名
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/submit' && w.ordinal === 2); // failedStatus1
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★c) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const span = findAssertCallLineSpan(realFileTexts[target.file], occ.index);
            must(!!span, `★c) 自检：在该写入点邻近窗口内定位到 assertSqlValidationStatus( 所在行`);
            if (span) {
                const mutatedLine = span.text.split('assertSqlValidationStatus(').join('');
                const mutatedServerJs = realFileTexts[target.file].slice(0, span.startOffset) + mutatedLine + realFileTexts[target.file].slice(span.endOffset);
                const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount > 0, `★c) 抹掉 ${keyOf(target)} 邻近的 assertSqlValidationStatus( 调用 → ① 判红`);
            }
        }
    }

    // d) 把某处 assert 调用挪进 /* */ 注释（在剥注释**之前**操作原始源码，再重新剥注释）→ ① 判红
    //    ——证明是"剥注释"机制本身在生效，不是巧合擦掉了别的字符串。同样用 scope+ordinal 定位。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/bypass' && w.ordinal === 1); // bypassedStatus
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★d) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const span = findAssertCallLineSpan(realFileTexts[target.file], occ.index);
            must(!!span, '★d) 自检：在该写入点邻近窗口内定位到 assertSqlValidationStatus( 所在行');
            if (span) {
                const rawSource = fs.readFileSync(path.join(ROOT, target.file), 'utf8');
                // stripJsCommentsStrict 是等长空白替换（保位置），raw 与 stripped 的字符 offset 完全对齐，
                // 可直接把 stripped 侧算出的行 offset 用到 raw 文本上。
                const rawLineText = rawSource.slice(span.startOffset, span.endOffset);
                must(rawLineText.includes('assertSqlValidationStatus('),
                    '★d) 自检：raw/stripped 文本 offset 对齐（该行原文确实含 assertSqlValidationStatus( 调用）');
                const wrappedRaw = rawSource.slice(0, span.startOffset) + '/*' + rawLineText + '*/' + rawSource.slice(span.endOffset);
                let mutatedStripped = null;
                try {
                    mutatedStripped = stripJsCommentsStrict(wrappedRaw);
                } catch (e) {
                    bad('★d) 变异后 server.js 仍可被 acorn 解析', e.message);
                }
                if (mutatedStripped !== null) {
                    const mutatedFiles = { ...realFileTexts, [target.file]: mutatedStripped };
                    const c1 = makeCollector();
                    evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                    must(c1.failCount > 0, `★d) 把 ${keyOf(target)} 的 assert 调用挪进 /* */ 注释后剥注释 → ① 判红（证明剥注释生效）`);
                }
            }
        }
    }

    // f) 〔身份键脱钩行号自证〕在 server.js **原文顶部插入 50 个空行**（内存），重新剥注释 + 重新
    //    扫描 scope/ordinal，登记表 WRITE_POINTS 原样不动 → 期望仍然①②全绿——证明身份键
    //    （scope+ordinal）与行号无关：所有写入点的行号整体 +50，但 scope 标签与 ordinal 顺序不变。
    {
        const rawServerJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        const shiftedRaw = '\n'.repeat(50) + rawServerJs;
        let shiftedStripped = null;
        try {
            shiftedStripped = stripJsCommentsStrict(shiftedRaw);
        } catch (e) {
            bad('★f) 插入 50 空行后 server.js 仍可被 acorn 解析', e.message);
        }
        if (shiftedStripped !== null) {
            const shiftedFiles = { ...realFileTexts, 'server.js': shiftedStripped };
            const c1 = makeCollector();
            evaluateWriteCoverage(shiftedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
            must(c1.failCount === 0,
                '★f) server.js 顶部插入 50 空行（全文行号 +50）→ ① 依然全绿（证明身份键与行号解耦）',
                c1.failCount ? c1.problems.join(' | ') : '');
        }
    }

    // g) 〔双向相等仍能抓真变化〕在 bypass 端点作用域内**注入一处新的** sql_validation_status
    //    写入（内存，紧邻既有写入的 SET 语境，与该端点 ordinal=1 的既有写入同一 scope）→
    //    该 scope 下扫描到的写入数变多（ordinal 出现 2），登记表仍只登记 ordinal=1 →
    //    双向相等判红——证明"身份键脱钩行号"不等于"守卫失去了发现新增写入点的能力"。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/bypass' && w.ordinal === 1);
        const anchorSnippet = `sql_validation_status = '\${bypassedStatus}',`;
        const stripped = realFileTexts[target.file];
        const idx = stripped.indexOf(anchorSnippet);
        must(idx >= 0, '★g) 自检：定位到 bypass 端点既有写入行原文（前置条件，非最终判据）');
        if (idx >= 0) {
            const insertAt = idx + anchorSnippet.length;
            const injectedLine = `\n                sql_validation_status = 'passed', /* G1 self-test injected extra write */`;
            const mutatedServerJs = stripped.slice(0, insertAt) + injectedLine + stripped.slice(insertAt);
            const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
            const c1 = makeCollector();
            evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
            must(c1.failCount > 0,
                `★g) 在 ${target.scope} 作用域内注入一处新写入（ordinal 变 2 处）→ 双向相等判红（登记表仍只登记 ordinal=1）`);
        }
    }

    // h)〔R1 返工·C2a 改换目标站点〕把某站点 assert 实参换成枚举内**另一个合法值**（字符串替换，
    //    只动这一处）→ ④ 判红（实参与登记字面量不再严格相等）。原用 versioning 的 passed 站点，
    //    C2a 把该站点改造成 literalSet 三元写法后（见下方 o 组），单值互换场景改在
    //    submit-export 的 admin_closed 站点复现（同样是单值 assert 调用，未受 C2a 影响）。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/submit-export' && w.ordinal === 1); // exporterDoneStatus
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★h) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const span = findAssertCallLineSpan(realFileTexts[target.file], occ.index);
            must(!!span, '★h) 自检：在该写入点邻近窗口内定位到 assertSqlValidationStatus( 所在行');
            if (span) {
                const originalCall = `assertSqlValidationStatus('${target.literal}')`;
                const swappedCall = `assertSqlValidationStatus('bypassed')`; // 枚举内另一个合法值，但与登记 'admin_closed' 不同
                must(span.text.includes(originalCall), '★h) 自检：assert 调用行原文含预期的原实参写法（前置条件）');
                if (span.text.includes(originalCall)) {
                    const mutatedLine = span.text.split(originalCall).join(swappedCall);
                    const mutatedServerJs = realFileTexts[target.file].slice(0, span.startOffset) + mutatedLine + realFileTexts[target.file].slice(span.endOffset);
                    const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
                    const c1 = makeCollector();
                    evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                    must(c1.failCount > 0, `★h) 把 ${keyOf(target)} 的 assert 实参从 '${target.literal}' 换成 'bypassed'（枚举内另一值）→ ④ 判红`);
                    // R6〔12a-M2〕精确断言：只应命中 [W4]（assert 实参判定），不应误伤 W1/W2/W3/W5
                    // 或任何 D* 规则——证明这条判据的定位精确，不是靠别的规则"顺带"判红凑出来的。
                    const ids = c1.failedRuleIds;
                    must(idsExactly(ids, ['W4']), `★h) 精确断言：仅 [W4] 判红（实得 IDs={${[...ids].join(', ')}}）`);
                }
            }
        }
    }

    // o)〔C2a 新增，呼应 handoff §1.5 第 6 条〕literalSet 三元站点：把某一支字面量换成**第三个**
    //    枚举值（既不是 'passed' 也不是 'external_skipped'）→ ④ 判红。用 versioning 的
    //    activateNewVersion 站点（C2a 改造成三元后唯一的 literalSet 站点）。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'function activateNewVersion' && w.ordinal === 1);
        must(!!target && !!target.literalSet, '★o) 自检：目标站点已登记为 literalSet（前置条件）');
        if (target && target.literalSet) {
            const stripped = realFileTexts[target.file];
            const originalBranch = "'external_skipped' : 'passed'";
            const swappedBranch = "'external_skipped' : 'bypassed'"; // 枚举内第三个值，既不是 external_skipped 也不是 passed
            must(stripped.includes(originalBranch), '★o) 自检：三元站点原文含预期的两分支写法（前置条件）');
            if (stripped.includes(originalBranch)) {
                const mutatedText = stripped.split(originalBranch).join(swappedBranch);
                const mutatedFiles = { ...realFileTexts, [target.file]: mutatedText };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount > 0, "★o) 三元站点某一支字面量从 'passed' 换成 'bypassed'（第三个枚举值）→ ④ 判红");
            }
        }
    }

    // i)〔R1 返工〕把某站点 SQL 写入行右值改回硬字面量、assert 调用原样保留（未被引用）→
    //    ⑤ 判红。用 submit 端点的 queued 站点。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/submit' && w.ordinal === 1); // queuedStatus
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★i) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const stripped = realFileTexts[target.file];
            const writeLine = lineTextAt(stripped, occ.index);
            const interpolatedRhs = `sql_validation_status = '\${queuedStatus}',`;
            must(writeLine.includes(interpolatedRhs), '★i) 自检：写入行原文含预期的变量插值写法（前置条件）');
            if (writeLine.includes(interpolatedRhs)) {
                const hardLiteralRhs = `sql_validation_status = '${target.literal}',`;
                const idx = stripped.indexOf(interpolatedRhs);
                const mutatedServerJs = stripped.slice(0, idx) + hardLiteralRhs + stripped.slice(idx + interpolatedRhs.length);
                const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount > 0, `★i) 把 ${keyOf(target)} 的写入行右值从 '\${queuedStatus}' 改回硬字面量 '${target.literal}'（assert 调用原样保留但不再被引用）→ ⑤ 判红`);
                const ids = c1.failedRuleIds;
                must(idsExactly(ids, ['W5']), `★i) 精确断言：仅 [W5] 判红（实得 IDs={${[...ids].join(', ')}}）`);
            }
        }
    }

    // j)〔R2 返工·2026-09-03 codex 04 审 F2〕动态清空站点：assert 实参丢弃 allowNull:true → 判红
    {
        const dyn = realFileTexts[DYNAMIC_WRITE_POINT.file];
        const original = 'assertSqlValidationStatus(null, { allowNull: true })';
        const mutated = 'assertSqlValidationStatus(null)';
        must(dyn.includes(original), '★j) 自检：动态清空站点原文含预期的 assert 调用写法（前置条件）');
        if (dyn.includes(original)) {
            const mutatedText = dyn.split(original).join(mutated);
            const mutatedFiles = { ...realFileTexts, [DYNAMIC_WRITE_POINT.file]: mutatedText };
            const c1 = makeCollector();
            evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
            must(c1.failCount > 0, '★j) 动态清空站点 assert 实参丢弃 allowNull:true → ① 判红');
            const ids = c1.failedRuleIds;
            must(idsExactly(ids, ['D4']), `★j) 精确断言：仅 [D4] 判红（实得 IDs={${[...ids].join(', ')}}）`);
        }
    }

    // k)〔R2 返工〕动态清空站点：assert 实参换成合法枚举内另一个值 'passed' → 判红
    {
        const dyn = realFileTexts[DYNAMIC_WRITE_POINT.file];
        const original = 'assertSqlValidationStatus(null, { allowNull: true })';
        const mutated = "assertSqlValidationStatus('passed', { allowNull: true })";
        must(dyn.includes(original), '★k) 自检：动态清空站点原文含预期的 assert 调用写法（前置条件）');
        if (dyn.includes(original)) {
            const mutatedText = dyn.split(original).join(mutated);
            const mutatedFiles = { ...realFileTexts, [DYNAMIC_WRITE_POINT.file]: mutatedText };
            const c1 = makeCollector();
            evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
            must(c1.failCount > 0, "★k) 动态清空站点 assert 实参换成 'passed' → ① 判红");
            const ids = c1.failedRuleIds;
            must(idsExactly(ids, ['D4']), `★k) 精确断言：仅 [D4] 判红（实得 IDs={${[...ids].join(', ')}}）`);
        }
    }

    // l)〔R2 返工·2026-09-03 codex 04 审 F4〕SET/WHERE 分类抗字符串干扰自证：在真实写入点前面
    //    同一模板串里插入一个"值本身含 WHERE 字样"的伪列（单引号字符串内），验证剥引号修复生效——
    //    不剥的话，quoted 文本里的 WHERE 会被当成比真正 SET 更近的关键字，误将这条真写入判成
    //    "读取"而漏登记（双向相等会因"登记但扫不到"判红）；剥了之后应仍全绿。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/submit' && w.ordinal === 3); // failedStatus2
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★l) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const stripped = realFileTexts[target.file];
            const anchorLine = `sql_validation_status = '\${failedStatus2}',`;
            must(stripped.includes(anchorLine), '★l) 自检：写入行原文含预期写法（前置条件）');
            if (stripped.includes(anchorLine)) {
                const decoy = "decoy_col = 'this literal text contains the word WHERE inside quotes',\n                        ";
                const idx = stripped.indexOf(anchorLine);
                const mutatedServerJs = stripped.slice(0, idx) + decoy + stripped.slice(idx);
                const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount === 0,
                    `★l) 在 ${keyOf(target)} 前插入含 'WHERE' 字样的伪列（单引号字符串内）→ ① 仍全绿（剥引号修复生效，未被字符串内容误导误判为读取）`,
                    c1.failCount ? c1.problems.join(' | ') : '');
            }
        }
    }

    // m)〔R2 返工·2026-09-03 codex 04 审 F5〕⑤ 精确 RHS 定界自证：某站点写入行右值改回硬字面量，
    //    且紧跟着的下一列塞入引用该 assert 接收变量的伪装文本（audit_note='${queuedStatus}'）→
    //    仍应判红——旧版 ⑤（forwardWindowText 宽窗口子串搜索）会被这类"跑到别的列里"的巧合命中
    //    骗过；新版按"当前赋值表达式精确跨度"定位，只认本列 RHS，不认邻列。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/submit' && w.ordinal === 1); // queuedStatus
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★m) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const stripped = realFileTexts[target.file];
            const writeLine = lineTextAt(stripped, occ.index);
            const interpolatedRhs = `sql_validation_status = '\${queuedStatus}',`;
            must(writeLine.includes(interpolatedRhs), '★m) 自检：写入行原文含预期的变量插值写法（前置条件）');
            if (writeLine.includes(interpolatedRhs)) {
                const hardLiteralPlusDecoy = `sql_validation_status = '${target.literal}',\n                        audit_note = '\${queuedStatus}',`;
                const idx = stripped.indexOf(interpolatedRhs);
                const mutatedServerJs = stripped.slice(0, idx) + hardLiteralPlusDecoy + stripped.slice(idx + interpolatedRhs.length);
                const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount > 0, `★m) 把 ${keyOf(target)} 写入行右值改回硬字面量、下一列塞入伪装引用 → ⑤ 精确 RHS 定界仍判红（不被邻列巧合命中骗过）`);
            }
        }
    }

    // n)〔R2 返工·2026-09-03 codex 04 审 F6〕精确映射自证：把 LABELS 里两个键的 cls 互换
    //    （admin_closed ⇄ external_skipped）→ ② 判红——旧版 hasValueToken 只查 token 存在性，
    //    互换后两个 cls 字符串仍都在文本里（只是挂错了 key），测不出这种"改一格"错位；
    //    新版逐键精确比对能测出。
    {
        const html = fs.readFileSync(DATA_COLLAB_HTML_PATH, 'utf8');
        const clsA = "cls: 'val-admin-closed'";
        const clsB = "cls: 'val-external'";
        must(html.includes(clsA) && html.includes(clsB), '★n) 自检：LABELS 原文含预期的两个 cls 字面量（前置条件）');
        if (html.includes(clsA) && html.includes(clsB)) {
            const placeholder = '__G1_SELFTEST_SWAP_PLACEHOLDER__';
            const swappedHtml = html.split(clsA).join(placeholder).split(clsB).join(clsA).split(placeholder).join(clsB);
            const scriptSrc = pageScriptText(swappedHtml);
            const stripped = stripJsCommentsLoose(scriptSrc);
            const mutatedBlocks = {
                labelsBlock: grabConstBlock(stripped, 'SQL_VALIDATION_LABELS'),
                renderFnBody: grabFnBody(stripped, 'renderValidationSection'),
                exportFnBody: grabFnBody(stripped, 'collabExportValidationStatus'),
            };
            const c2 = makeCollector();
            evaluateFrontendCoverage(mutatedBlocks, SQL_VALIDATION_STATUSES, c2.report);
            must(c2.failCount > 0, "★n) LABELS.admin_closed ⇄ external_skipped 的 cls 互换 → ② 精确映射判红");
        }
    }

    // p)〔R3 返工·2026-09-03 主会话预筛〕动态清空站点：assert 调用行前缀塞短路操作数
    //    （flag && assertSqlValidationStatus(...)）→ 判红。旧版"分支内含调用"+"分支体无嵌套 if"
    //    两条测不出这种旁路：短路操作数不含 if 关键字，parseAssertCallArg 的正则也不锚定行首，
    //    两条判据都会对着 `flag && assertSqlValidationStatus(null,{allowNull:true})` 误判绿——
    //    实测过（主会话预筛全绿复现）。新增"调用行 trim 后须以 assertSqlValidationStatus( 开头"
    //    + "分支体不含 &&/||/?/switch/try" 两条硬约束后，这条应稳定判红。
    {
        const dyn = realFileTexts[DYNAMIC_WRITE_POINT.file];
        const original = 'assertSqlValidationStatus(null, { allowNull: true })';
        const mutated = 'someShortCircuitFlag && assertSqlValidationStatus(null, { allowNull: true })';
        must(dyn.includes(original), '★p) 自检：动态清空站点原文含预期的 assert 调用写法（前置条件）');
        if (dyn.includes(original)) {
            const mutatedText = dyn.split(original).join(mutated);
            const mutatedFiles = { ...realFileTexts, [DYNAMIC_WRITE_POINT.file]: mutatedText };
            const c1 = makeCollector();
            evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
            must(c1.failCount > 0, '★p) 动态清空站点 assert 调用前缀塞短路操作数（flag &&）→ 判红（原全绿假绿口子已堵）');
        }
    }

    // q)〔R4 返工·2026-09-03 主会话预筛〕SQL_VALIDATION_LABEL_CLS_MAP 键集合须与
    //    SQL_VALIDATION_STATUSES 双向相等——枚举加一个新值但 CLS_MAP 忘了同步加 → 判红
    //    （反向：正向包含关系只测得出"CLS_MAP 多余键"，测不出"枚举新增值 CLS_MAP 漏登记"）。
    {
        const mutatedEnum = [...SQL_VALIDATION_STATUSES, 'zzz_new_status'];
        const c2 = makeCollector();
        evaluateFrontendCoverage(realBlocks, mutatedEnum, c2.report);
        must(c2.failCount > 0, "★q) 枚举加值 'zzz_new_status' 但 CLS_MAP 未同步登记 → ② 判红（键集合双向核对）");
    }

    // r)〔S6 返工·2026-09-02 主会话预筛〕SET/WHERE 分类抗双引号字符串干扰自证：同 l) 但伪列
    //    值改用双引号包裹含 WHERE 字样的文本，验证 stripQuotedStrings 扩到双引号后依然正确
    //    判写入（不会被双引号字符串里的 WHERE 误导成"读取"而漏登记）。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/submit' && w.ordinal === 4); // failedStatus3
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★r) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const stripped = realFileTexts[target.file];
            const anchorLine = `sql_validation_status = '\${failedStatus3}',`;
            must(stripped.includes(anchorLine), '★r) 自检：写入行原文含预期写法（前置条件）');
            if (stripped.includes(anchorLine)) {
                const decoy = 'decoy_col_dq = "this literal text contains the word WHERE inside double quotes",\n                            ';
                const idx = stripped.indexOf(anchorLine);
                const mutatedServerJs = stripped.slice(0, idx) + decoy + stripped.slice(idx);
                const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount === 0,
                    `★r) 在 ${keyOf(target)} 前插入含 'WHERE' 字样的双引号伪列 → ① 仍全绿（双引号剥除同样生效）`,
                    c1.failCount ? c1.problems.join(' | ') : '');
            }
        }
    }

    // s)〔H1·codex 05 复审〕动态清空站点：把 assert 调用包进一个新声明、但从未被调用的箭头函数
    //    （const run = () => { ... };）——调用自己所在行"assertSqlValidationStatus(null, {
    //    allowNull: true }); };"trim 后仍以 assertSqlValidationStatus( 开头（R3 既有判据测不出），
    //    分支体也不含 &&/||/?/switch/try（p 组既有判据也测不出）；箭头函数的收尾 `};` 特意放在
    //    assert 调用同一行（不是另起一行独立缩进），避开 DYNAMIC_ANCHOR_RE 懒惰匹配把"\n\s*}"
    //    误认成分支收尾、提前截断 branchBody 导致其余判据意外失真的干扰，让这组变异干净地只命中
    //    新增的两条：分支体含 =>（"分支体禁 =>/function/for/while/return"）+ assert 调用花括号
    //    深度非 0（"assert 调用花括号深度须为 0"）。
    {
        const dyn = realFileTexts[DYNAMIC_WRITE_POINT.file];
        const original = "if (f === 'sql_validation_status') {\r\n            assertSqlValidationStatus(null, { allowNull: true });\r\n        }";
        const mutated = "if (f === 'sql_validation_status') {\r\n            const run = () => {\r\n                assertSqlValidationStatus(null, { allowNull: true }); };\r\n        }";
        must(dyn.includes(original), '★s) 自检：动态清空站点原文含预期的 if 分支写法（前置条件）');
        if (dyn.includes(original)) {
            const mutatedText = dyn.split(original).join(mutated);
            const mutatedFiles = { ...realFileTexts, [DYNAMIC_WRITE_POINT.file]: mutatedText };
            const c1 = makeCollector();
            evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
            must(c1.failCount > 0, '★s) 动态清空站点 assert 调用被整个包进 const run = () => {...}（从未调用，调用本身单独一行仍以 assertSqlValidationStatus( 开头）→ 判红（H1 嵌套函数绕过口子已堵）');
            // R6〔12a-M2〕这组变异按设计会同时触发两条独立判据（分支体含 => 关键字 / assert
            // 调用花括号深度非 0）——精确断言要求恰好是这两条，不多不少。
            const ids = c1.failedRuleIds;
            must(idsExactly(ids, ['D8', 'D9']), `★s) 精确断言：仅 [D8][D9] 判红（实得 IDs={${[...ids].join(', ')}}）`);
        }
    }

    // t)〔H2·codex 05 复审〕三元 literalSet 站点：把这一次调用自己的实参换成裸变量 mode2
    //    （不含任何 ? 或字面量），并在紧邻的下一行塞入一段"值集合与登记 literalSet 完全一致、且
    //    末尾带一个多余右括号、且同样引用 anchor 关键字 VALIDATION_MODES.external_skip"的同款
    //    三元文本——旧版懒惰正则 `assertSqlValidationStatus\(\s*[\s\S]*?\?...\)` 会越过本次调用
    //    自己早已用尽的右括号，继续懒惰扩展匹配范围，直到这行末尾的多余 `)` 才收尾，把这段无关
    //    文本错当成"本次调用的实参"抓走（实测复现：不带这个多余右括号时，旧正则反而因为窗口内
    //    找不到可收尾的 `)` 而自然匹配失败，不能证明问题——多余右括号是这组变异复现旧 bug 的
    //    必要条件，真实代码里 codex 05 描述的场景就是"3 行内**恰好**存在另一处右括号"）；即便
    //    真实调用参数是完全不可静态验证的裸变量也会被旧正则判绿。装饰性三元里刻意重复
    //    anchor 关键字，让登记表 anchor 字段（F6①，独立于 H2 的判据）在窗口 ±15 行内维持恰好
    //    命中 1 次——不这样做的话，删掉真实三元会顺带删掉 anchor 的唯一出现点，让这组变异同时
    //    绊到 anchor 检查，测不出这组变异究竟是被 H2 新判据挡下、还是被无关的 anchor 缺失挡下
    //    （anchor 检查独立在前，与④ 的三元解析判据分属不同判据，混在一起会让这组变异证明力不足）。
    //    新版括号+引号感知扫描把实参范围物理圈定在本次调用**自己**的括号内（在 mode2 之后遇到
    //    第一个 `)` 就收口，不会跨越到装饰性的多余右括号），裸变量 mode2 解不出任何字面量/三元，
    //    应稳定判红。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'function activateNewVersion' && w.ordinal === 1);
        must(!!target && !!target.literalSet, '★t) 自检：目标站点已登记为 literalSet（前置条件）');
        if (target && target.literalSet) {
            const stripped = realFileTexts[target.file];
            const originalBlock = "            validationMode === VALIDATION_MODES.external_skip ? 'external_skipped' : 'passed'\r\n        );";
            const mutatedBlock = "            mode2\r\n        );\r\n        x = anotherFlag === VALIDATION_MODES.external_skip ? 'external_skipped' : 'passed');";
            must(stripped.includes(originalBlock), '★t) 自检：三元站点原文含预期的三元实参 + 调用收尾写法（前置条件）');
            if (stripped.includes(originalBlock)) {
                const mutatedText = stripped.split(originalBlock).join(mutatedBlock);
                const mutatedFiles = { ...realFileTexts, [target.file]: mutatedText };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount > 0, "★t) 三元站点实参换成裸变量 mode2，紧邻下一行塞入值集合完全相同、带多余右括号且复用 anchor 关键字的同款三元文本 → ④ 仍判红（H2 跨调用误抓口子已堵，且非因 anchor 缺失误伤）");
                const ids = c1.failedRuleIds;
                must(idsExactly(ids, ['W4']), `★t) 精确断言：仅 [W4] 判红，非因 anchor([W2]) 缺失误伤（实得 IDs={${[...ids].join(', ')}}）`);
            }
        }
    }

    // u)〔M1·codex 05 复审〕导出函数结构化断言：把 passed 分支的 return 语句改写掉，但把
    //    'passed' 这个 token 保留在别处（改成一个不生效的局部变量赋值）——旧版 hasValueToken
    //    只查 token 是否在函数体文本里出现过，'passed' 仍在（藏在 const keepToken 里），照样
    //    判绿；新版要求结构化的 `if (...sql_validation_status === 'passed'...) return '...'`，
    //    结构已被破坏，应判红。
    {
        const original = "if (r.sql_validation_status === 'passed') return '已通过';";
        const mutated = "if (r.sql_validation_status === 'other_marker') { const keepToken = 'passed'; }";
        must(!!realBlocks.exportFnBody && realBlocks.exportFnBody.includes(original),
            '★u) 自检：导出函数原文含预期的 passed 分支写法（前置条件）');
        if (realBlocks.exportFnBody && realBlocks.exportFnBody.includes(original)) {
            const mutatedExportFnBody = realBlocks.exportFnBody.split(original).join(mutated);
            const mutatedBlocks = { ...realBlocks, exportFnBody: mutatedExportFnBody };
            const c2 = makeCollector();
            evaluateFrontendCoverage(mutatedBlocks, SQL_VALIDATION_STATUSES, c2.report);
            must(c2.failCount > 0, "★u) 导出函数 passed 分支的 return 改写掉、'passed' token 保留在别处（结构不再是 if(...)return'...'）→ ② 判红（M1 结构化检查口子已堵）");
        }
    }

    // v)〔M3·codex 05 复审〕SET/WHERE 分类抗转义引号干扰自证：在真实写入点前插入一处值含转义
    //    单引号的伪列（'it\'s WHERE'）——旧版 stripQuotedStrings 用正则 `'[^']*'`，遇到转义引号
    //    会在第一个转义引号处提前收尾，把 `s WHERE'` 这段原样漏出来，暴露的 "WHERE" 字样能把
    //    紧随其后的真实写入点误判成读取而漏登记；新版逐字符扫描（转义感知）应仍把整段
    //    `'it\'s WHERE'` 当一个字符串整体剥掉，① 仍应全绿。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/submit' && w.ordinal === 1); // queuedStatus
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★v) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const stripped = realFileTexts[target.file];
            const anchorLine = `sql_validation_status = '\${queuedStatus}',`;
            must(stripped.includes(anchorLine), '★v) 自检：写入行原文含预期写法（前置条件）');
            if (stripped.includes(anchorLine)) {
                const decoy = "sql_validation_error_decoy = 'it\\'s WHERE',\n                        ";
                const idx = stripped.indexOf(anchorLine);
                const mutatedServerJs = stripped.slice(0, idx) + decoy + stripped.slice(idx);
                const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount === 0,
                    `★v) 在 ${keyOf(target)} 前插入含转义单引号的伪列（'it\\'s WHERE'）→ ① 仍全绿（M3 转义感知修复生效，未被提前收尾的引号误判成读取而漏登记）`,
                    c1.failCount ? c1.problems.join(' | ') : '');
            }
        }
    }

    // w)〔M4·codex 05 复审〕动态清空站点：把真正生效的清空语句（clearSql += `, ${f} = NULL`）
    //    挪到 if 分支之前执行，分支结束后另外追加一句无关的 clearSql += ''——旧版只找"分支结束
    //    后第一个 clearSql +="并比较位置，这个无关的追加语句恰好还是落在分支之后，位置比较照样
    //    通过，但真正对字段 f 生效的清空早就跑在 assert 之前，断言名存实亡；新版"assert 之前不许
    //    出现任何 clearSql +="+"紧邻语句须含 ${f}"两条应能拦住。
    {
        const dyn = realFileTexts[DYNAMIC_WRITE_POINT.file];
        const originalBlock = "        if (f === 'sql_validation_status') {\r\n            assertSqlValidationStatus(null, { allowNull: true });\r\n        }\r\n        clearSql += `, ${f} = NULL`;";
        const mutatedBlock = "        clearSql += `, ${f} = NULL`;\r\n        if (f === 'sql_validation_status') {\r\n            assertSqlValidationStatus(null, { allowNull: true });\r\n        }\r\n        clearSql += '';";
        must(dyn.includes(originalBlock), '★w) 自检：动态清空站点原文含预期的「分支→真实 clearSql」顺序写法（前置条件）');
        if (dyn.includes(originalBlock)) {
            const mutatedText = dyn.split(originalBlock).join(mutatedBlock);
            const mutatedFiles = { ...realFileTexts, [DYNAMIC_WRITE_POINT.file]: mutatedText };
            const c1 = makeCollector();
            evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
            must(c1.failCount > 0, "★w) 真实 clearSql 挪到 assert 之前执行、分支后追加无关 clearSql += '' → 判红（M4 顺序绕过口子已堵）");
        }
    }

    // x)〔08-M5·codex 08 审〕renderValidationSection 结构化断言：删掉真实的
    //    `else if (vs === 'passed')` 分支判断本身，但把 `vs === 'passed'` 这个 token 保留在一个
    //    不生效的装饰性局部变量赋值里——旧版 renderVsRegexFor 只要求 token 在函数体文本任意位置
    //    出现即可判绿（decoy 藏着它，照样命中）；新版要求出现在 if(/else if( 的条件括号内，
    //    结构已被破坏，应判红。
    {
        const original = "} else if (vs === 'passed') {";
        const mutated = "} else { const decoy = vs === 'passed';";
        must(!!realBlocks.renderFnBody && realBlocks.renderFnBody.includes(original),
            '★x) 自检：渲染函数原文含预期的 passed 分支写法（前置条件）');
        if (realBlocks.renderFnBody && realBlocks.renderFnBody.includes(original)) {
            const mutatedRenderFnBody = realBlocks.renderFnBody.split(original).join(mutated);
            const mutatedBlocks = { ...realBlocks, renderFnBody: mutatedRenderFnBody };
            const c2 = makeCollector();
            evaluateFrontendCoverage(mutatedBlocks, SQL_VALIDATION_STATUSES, c2.report);
            must(c2.failCount > 0, "★x) renderValidationSection 的 passed 分支判断删掉、'passed' token 保留在装饰性局部变量里（结构不再是 if(/else if( 条件内）→ ② 判红（08-M5 结构化检查口子已堵）");
        }
    }

    // x2)〔S3·Opus 预筛〕比 ★x 更狡猾的绕过尝试：不只把 token 藏进装饰性局部变量，还把这个变量
    //    塞进一个恒为假的 if 条件（`if (decoy && false) {}`）——如果判据的"别名通道"是通用开放
    //    给全部枚举值的（旧版 08-M5 实现就是这样），只检查"if( 后紧跟别名名"会命中这个 if，
    //    误判"别名确实被条件引用"而判绿，测不出 `&& false` 让分支永远不执行。S3 收窄后别名通道
    //    只对 'bypassed'（且别名名精确为 'isBypassed'）开放，'passed' 这类值走纯 direct 通道，
    //    这个绕过对它应完全无效，仍应判红。
    {
        const original = "} else if (vs === 'passed') {";
        const mutated = "} else { const decoy = vs === 'passed'; if (decoy && false) {} }";
        must(!!realBlocks.renderFnBody && realBlocks.renderFnBody.includes(original),
            '★x2) 自检：渲染函数原文含预期的 passed 分支写法（前置条件）');
        if (realBlocks.renderFnBody && realBlocks.renderFnBody.includes(original)) {
            const mutatedRenderFnBody = realBlocks.renderFnBody.split(original).join(mutated);
            const mutatedBlocks = { ...realBlocks, renderFnBody: mutatedRenderFnBody };
            const c2 = makeCollector();
            evaluateFrontendCoverage(mutatedBlocks, SQL_VALIDATION_STATUSES, c2.report);
            must(c2.failCount > 0, "★x2) renderValidationSection 的 passed 分支判断删掉、'passed' token 藏进恒假 if 条件（if (decoy && false)）→ ② 仍判红（S3：别名通道收窄到只对 bypassed 开放，'passed' 无逃生通道）");
        }
    }

    // y)〔R1 返工·12a-H1，主会话末次合并审②a〕接收变量初始化器尾随短路表达式：
    //    `const queuedStatus = assertSqlValidationStatus('queued') && 'admin_closed';` —— 旧版
    //    parseAssertReceiverVar 只锚定"const <name> = assertSqlValidationStatus("这个前缀，对
    //    括号闭合之后跟了什么完全不设防；④ 对调用本身实参的解析（'queued'）依然合法，⑤ 的写入
    //    行右值仍原样引用 queuedStatus，两条判据都会误判绿——但 JS 短路求值下 queuedStatus
    //    运行时实际取到的是 'admin_closed'（&& 右操作数），落库值与登记字面量不同，文本层面却
    //    测不出来。新增的"接收变量初始化器恰为一次调用，无尾随表达式"判据应能拦住。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/submit' && w.ordinal === 1); // queuedStatus
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★y) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const span = findAssertCallLineSpan(realFileTexts[target.file], occ.index);
            must(!!span, '★y) 自检：在该写入点邻近窗口内定位到 assertSqlValidationStatus( 所在行');
            if (span) {
                const originalDecl = `const queuedStatus = assertSqlValidationStatus('${target.literal}');`;
                const mutatedDecl = `const queuedStatus = assertSqlValidationStatus('${target.literal}') && 'admin_closed';`;
                must(span.text.includes(originalDecl), '★y) 自检：assert 调用行原文含预期的整句声明写法（前置条件）');
                if (span.text.includes(originalDecl)) {
                    const mutatedLine = span.text.split(originalDecl).join(mutatedDecl);
                    const mutatedServerJs = realFileTexts[target.file].slice(0, span.startOffset) + mutatedLine + realFileTexts[target.file].slice(span.endOffset);
                    const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
                    const c1 = makeCollector();
                    evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                    must(c1.failCount > 0, `★y) 把 ${keyOf(target)} 的接收变量初始化器加尾随 && 'admin_closed'（短路求值让运行时实际值变成 admin_closed，文本层④⑤仍判绿）→ 判红（12a-H1 口子已堵）`);
                    const ids = c1.failedRuleIds;
                    must(idsExactly(ids, ['W4']), `★y) 精确断言：仅 [W4]（接收变量初始化器精确性）判红（实得 IDs={${[...ids].join(', ')}}）`);
                }
            }
        }
    }

    // z)〔R1 返工·12a-H1〕SQL RHS 用 CASE WHEN 包裹住合法的变量引用：
    //    `sql_validation_status = CASE WHEN 1=1 THEN '${failedStatus4}' ELSE 'x' END,` —— 旧版 ⑤
    //    用 `.includes()` 子串检查，'${failedStatus4}' 这个子串确实"包含"在 RHS 里，照样判绿；
    //    但整条 RHS 已经不是"纯粹引用该变量"，ELSE 分支的 'x' 是一条完全不受 assert 约束的旁路
    //    值（运行时视 CASE 条件而定，可能写入的根本不是 assert 校验过的字面量）。新版严格相等
    //    （规范化空白后逐字符比较）应判红。
    {
        const target = WRITE_POINTS.find((w) => w.scope === 'POST /api/collab/requests/:id/submit' && w.ordinal === 5); // failedStatus4
        const occ = locateOccurrence(realFileTexts, target);
        must(!!occ, `★z) 自检：用 scope+ordinal（${keyOf(target)}）定位到物理写入点（前置条件，非最终判据）`);
        if (occ) {
            const stripped = realFileTexts[target.file];
            const writeLine = lineTextAt(stripped, occ.index);
            const interpolatedRhs = `sql_validation_status = '\${failedStatus4}',`;
            must(writeLine.includes(interpolatedRhs), '★z) 自检：写入行原文含预期的变量插值写法（前置条件）');
            if (writeLine.includes(interpolatedRhs)) {
                const caseWrappedRhs = `sql_validation_status = CASE WHEN 1=1 THEN '\${failedStatus4}' ELSE 'x' END,`;
                const idx = stripped.indexOf(interpolatedRhs);
                const mutatedServerJs = stripped.slice(0, idx) + caseWrappedRhs + stripped.slice(idx + interpolatedRhs.length);
                const mutatedFiles = { ...realFileTexts, [target.file]: mutatedServerJs };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount > 0, `★z) 把 ${keyOf(target)} 的写入行右值改成 CASE WHEN 1=1 THEN '\${failedStatus4}' ELSE 'x' END 包裹（子串仍"包含"变量引用，但整条 RHS 已非纯引用）→ ⑤ 判红（12a-H1 口子已堵）`);
                const ids = c1.failedRuleIds;
                must(idsExactly(ids, ['W5']), `★z) 精确断言：仅 [W5] 判红（实得 IDs={${[...ids].join(', ')}}）`);
            }
        }
    }

    // aa)〔R2 返工·12a-H2，主会话末次合并审②a〕动态清空站点：把真实分支从循环体内搬到循环之前
    //    的一个 if (false) {...} 死代码块里（循环体内不再含任何 sql_validation_status 分支）——
    //    旧版 DYNAMIC_ANCHOR_RE.exec(dyn) 不带 g 标志，只取"文件中第一个匹配"，从不校验这个
    //    匹配点是否真落在 clearFields 循环体范围内；替身移到循环之前后会先被 exec 命中，"assert
    //    之前有没有 clearSql +="这条判据实际拿"替身坐标"去跟"真实循环体"的坐标区间比较——区间
    //    不重叠导致 dyn.slice(loopBody.start, assertOffsetInDyn) 天然是空字符串（因为
    //    assertOffsetInDyn < loopBody.start），"不包含 clearSql +="恒真，构成假绿。新增的
    //    "匹配点必须落在循环体范围内"前置校验应能直接拦住。
    {
        const dyn = realFileTexts[DYNAMIC_WRITE_POINT.file];
        const originalBranch = "if (f === 'sql_validation_status') {\r\n            assertSqlValidationStatus(null, { allowNull: true });\r\n        }";
        must(dyn.includes(originalBranch), '★aa) 自检：动态清空站点原文含预期的 if 分支写法（前置条件）');
        if (dyn.includes(originalBranch)) {
            const withoutReal = dyn.split(originalBranch).join('');
            const loopAnchorMatch = CLEAR_FIELDS_LOOP_ANCHOR_RE.exec(withoutReal);
            must(!!loopAnchorMatch, '★aa) 自检：可在移除真实分支后的文本里定位到 clearFields 循环体锚点（前置条件）');
            if (loopAnchorMatch) {
                const decoyBlock = `if (false) {\r\n        ${originalBranch}\r\n    }\r\n    `;
                const mutatedText = withoutReal.slice(0, loopAnchorMatch.index) + decoyBlock + withoutReal.slice(loopAnchorMatch.index);
                const mutatedFiles = { ...realFileTexts, [DYNAMIC_WRITE_POINT.file]: mutatedText };
                const c1 = makeCollector();
                evaluateWriteCoverage(mutatedFiles, WRITE_POINTS, SQL_VALIDATION_STATUSES, c1.report);
                must(c1.failCount > 0, '★aa) 真实分支挪到循环之前的 if (false) {...} 死代码块（循环体内不再含该分支）→ 判红（12a-H2：分支必须落在循环体范围内的前置校验已堵）');
                const ids = c1.failedRuleIds;
                must(idsExactly(ids, ['D11']), `★aa) 精确断言：仅 [D11]（分支落在循环体范围内）判红（实得 IDs={${[...ids].join(', ')}}）`);
            }
        }
    }

    // 〔L1·codex 05〕动态打印实际执行组数（不手写数字）——见 ok/bad 里的 trackGroupLabel。
    console.log(`\n— ③ 变异自证：实际执行 ${mutationGroupLabels.size} 组（${[...mutationGroupLabels].sort().join(', ')}）—`);
    return mutationGroupLabels.size;
}

// ============================================================
// 主流程
// ============================================================
function main() {
    console.log('=== G1：sql_validation_status 唯一枚举 + 写入点全覆盖静态守卫（scope+ordinal 身份键版）===');
    console.log(`枚举（${SQL_VALIDATION_STATUSES.length} 值）：${SQL_VALIDATION_STATUSES.join(', ')}`);

    let realFileTexts, realBlocks;
    try {
        realFileTexts = readAndStripAll(SCAN_FILES);
    } catch (e) {
        bad('后端文件可读取 + 可被 acorn 解析（剥注释前置条件）', e.message);
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        process.exit(1);
    }
    try {
        realBlocks = extractFrontendBlocks();
    } catch (e) {
        bad('前端文件可读取（Data_Collab.html）', e.message);
        realBlocks = { labelsBlock: null, renderFnBody: null, exportFnBody: null };
    }

    console.log('\n— ① 后端写入点覆盖 —');
    evaluateWriteCoverage(realFileTexts, WRITE_POINTS, SQL_VALIDATION_STATUSES, must);

    console.log('\n— ② 前端三处枚举覆盖 —');
    evaluateFrontendCoverage(realBlocks, SQL_VALIDATION_STATUSES, must);

    const mutationGroupCount = runMutationSelfTests(realFileTexts, realBlocks);

    console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败（含变异自证 ${mutationGroupCount} 组）===`);
    process.exit(fail === 0 ? 0 : 1);
}

main();
