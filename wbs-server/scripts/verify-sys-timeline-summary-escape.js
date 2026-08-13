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
//   提前截断），断言每条语句的完整文本内含 `esc(` 子串。裸 `e.summary`/其它变量拼接若不经 esc(，判红。
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

check('全部 summaryHtml 赋值语句均含 esc( 子串（未转义分支会判红，逐条点名）', () => {
    const unescaped = assignments.filter(a => !a.stmt.includes('esc('));
    if (unescaped.length > 0) {
        const detail = unescaped.map(a => `第 ${a.idx} 字符处：${a.stmt.slice(0, 120)}${a.stmt.length > 120 ? '…' : ''}`).join('\n    ');
        throw new Error(`${unescaped.length} 条赋值语句未见 esc(，存在未转义拼接 innerHTML 的风险：\n    ${detail}`);
    }
});

// [codex 364 号 M1 加固] "语句含 esc(" 太粗——`summaryHtml = `${esc(a)} ${e.summary}`` 这类**混合拼接**
//   （部分 esc、部分裸插值）会因整句含 esc( 而误判通过。加固到**表达式级**：剥掉全部 esc(...) 调用后，
//   残留文本里任何 `${...}` 模板插值都不得再引用**原始动态字段**（e.<x> / folded / translated / info.<x> /
//   a.<x>——siRenderTimeline 里全部动态来源）。预构建 HTML 变量（statusLine/commitsTable/addBtn 等，其内部
//   已各自 esc）以裸 `${var}` 形式插值是合法的，不在动态字段清单内故放行——只揪"原始未转义字段直接插值"。
function stripEscCalls(s) {
    // 平衡括号剥去每个 esc( ... ) 调用（含嵌套），替换成空串。
    let out = '', i = 0;
    while (i < s.length) {
        if (s.startsWith('esc(', i)) {
            let depth = 0, j = i + 3;   // 指向 '('
            for (; j < s.length; j++) {
                if (s[j] === '(') depth++;
                else if (s[j] === ')') { depth--; if (depth === 0) { j++; break; } }
            }
            i = j;   // 跳过整个 esc(...) 调用
        } else { out += s[i]; i++; }
    }
    return out;
}
const RAW_DYNAMIC_FIELD_RE = /\be\.\w+|\bfolded\b|\btranslated\b|\binfo\.\w+|\ba\.\w+/;
function residualUnescapedInterpolations(stmt) {
    const residue = stripEscCalls(stmt);
    const bad = [];
    // 扫残留里的 `${...}` 插值（非嵌套已足够——siRenderTimeline 无 `${}` 内再套 `${}`）
    for (const m of residue.matchAll(/\$\{([^}]*)\}/g)) {
        if (RAW_DYNAMIC_FIELD_RE.test(m[1])) bad.push(m[0]);
    }
    return bad;
}
check('[M1 加固·表达式级] 剥离 esc(...) 后残留 ${...} 插值不得引用原始动态字段（拦混合拼接）', () => {
    const mixed = assignments
        .map(a => ({ a, bad: residualUnescapedInterpolations(a.stmt) }))
        .filter(x => x.bad.length > 0);
    if (mixed.length > 0) {
        const detail = mixed.map(x => `第 ${x.a.idx} 字符处残留未转义插值 ${JSON.stringify(x.bad)}：${x.a.stmt.slice(0, 140)}${x.a.stmt.length > 140 ? '…' : ''}`).join('\n    ');
        throw new Error(`${mixed.length} 条赋值语句剥 esc 后仍有原始动态字段裸插值（混合拼接·XSS 面）：\n    ${detail}`);
    }
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
