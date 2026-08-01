// verify-unify-static.js — 前端统一 静态断言（纯文本检查，不起 server）
//   范围：静态守卫只覆盖四个 migrated pages（Data_Correction / Sys_Iteration / Issue_Tracker / Data_Collab），
//   Periodic_Fetch 有意排除（保 teal 设计决策，不迁移）；五页口径仅属于 visual harness
//   （test-unify-visual-playwright.js 拍照覆盖含 Periodic_Fetch）。（codex 末次合并审 LOW-1）
//
//   style污染根治 · B 方案（20260709 v1.1）后断言模型改版：共享组件层不再靠 `:where(.unified-page)`
//   门控隔离，而是给每个组件根类加 `u-` 前缀（如 `.btn-primary` → `.u-btn-primary`）从命名空间上彻底
//   避开 style.css 全站遗留同名类。断言相应从"残留是否裸写了与 components.css 逐字相等的 selector"
//   改为"components.css 与迁移页里还有没有旧（无 u- 前缀）的共享根类裸名"——用固定黑名单（OLD_NAMES，
//   对齐前端统一_style污染根治_方案_20260709_v1.1.md §二"只给根类加 u-"清单）逐词精确匹配，排除
//   `u-`/`si-` 前缀与元素/修饰类（active/open/full/ellip/s-*/t-*/n-* 等，这些不在黑名单里，天然豁免）。
//   C0-C4 每个 commit 验收必跑。
//
//   断言清单：
//   ⓪ components.css 里不得出现任何裸 OLD_NAMES 选择器 token（黑名单精确匹配，逐字符串边界安全，
//      不误伤 `u-corr-table`/`si-drawer` 等——用负向前瞻/后顾保证匹配到的是独立 token，不是更长
//      标识符的子串）。防漏加 u- 前缀 = 该规则全局泄漏到未迁移页。
//   ⓪b（codex B 代码审 LOW-1 补）自动派生：逐条抽 components.css 规则的根选择器，校验必为 `.u-*`
//      （或 `.unified-page` 覆盖钩子）。⓪ 是黑名单只抓已知旧名，⓪b 不依赖黑名单——新增任何黑名单外
//      的裸根类/元素裸选择器一律判失败，堵住"未来往 components.css 加漏 u- 的新类"缺口。
//   ① 迁移页 body class：MIGRATED_PAGES 列出的每个页面，<body> 须含且仅含一次 unified-page class
//      （防漏加 / 防手滑重复加两次导致 class 列表脏；u- 改名与此断言无关，逻辑不变）。
//   ② 迁移页残留 <style>(②a) + JS 模板串 class=/className=(②b) + JS DOM API(②c) 不得裸写/引用
//      任何 OLD_NAMES token（同⓪ 黑名单）。②c（LOW-2 补）覆盖 classList.add/remove/toggle/contains/
//      replace、setAttribute('class')、querySelector(All)/closest/matches、getElementsByClassName——
//      只扫 OLD_NAMES 根类，修饰类（open/active/s-*/t-*）不在黑名单天然豁免、零误报。CSS 注释比对前剥离。
//   ③ unify-helpers.js 输出的共享 DOM 结构（statusBadge/typeTag）必须使用 u- 根类
//      （`u-status-badge`/`u-type-tag`），不得残留裸 `status-badge`/`type-tag`。
'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COMPONENTS_CSS = path.join(PUBLIC_DIR, 'assets', 'css', 'components.css');
const UNIFY_HELPERS_JS = path.join(PUBLIC_DIR, 'assets', 'js', 'unify-helpers.js');

// ============================================================
// 配置区
// ============================================================

// 已完成"前端统一"改造迁移的页面文件名（相对 wbs-server/public/）。C1-C4 每迁一页往这里加一个。
// Quick_Log.html（2026-08-02 零星台账独立页）系新建即全程 u- 范式——非"迁移"但纳入同一守卫，
// 防未来往新页塞裸旧类名漂移（codex 231 轮随批裁定加入）。
const MIGRATED_PAGES = ['Data_Correction.html', 'Sys_Iteration.html', 'Issue_Tracker.html', 'Data_Collab.html', 'Statistics.html', 'Quick_Log.html'];

// 共享组件根类黑名单（方案 §二"只给根类加 u-"清单，逐字对齐 components.css 定义的组件本体类名）。
// 不含状态/变体/枚举修饰类（active/open/full/ellip/wide/s-*/t-*/n-*）——这些保留原名，不在黑名单里。
const OLD_NAMES = [
    'btn-primary', 'btn-secondary', 'btn-danger',
    'status-badge', 'type-tag', 'notify-badge',
    'stats-row', 'stat-card', 'stat-icon', 'stat-info', 'stat-num', 'stat-label',
    'corr-table-wrap', 'corr-table',
    'filter-bar', 'filter-label',
    'req', 'hint',
    'form-group', 'form-row',
    'modal-overlay', 'modal-box', 'modal-header', 'modal-body', 'modal-footer',
    'drawer-overlay', 'drawer-header', 'drawer-body', 'drawer-close', 'drawer-title-reason', 'drawer',
    'drawer-footer', // codex 末次合并审 MED-1：C4 新引入页面级根类 u-drawer-footer，补黑名单防裸名回退
    'detail-section', 'kv-grid', 'kv-item',
    'history-item', 'att-item',
    'action-bar',
    'notify-row', 'nr-label', 'nr-body', 'nb-btn',
    'empty-state',
    'sortable', 'sort-icon', // 排序机制升共享层（迁自 Data_Collab 页内 .sortable/.sort-icon → u-sortable/u-sort-icon）
];

// ============================================================
// 断言 helper
// ============================================================
let pass = 0;
let fail = 0;
const failures = [];

function check(cond, label, detail) {
    if (cond) {
        pass++;
        console.log(`  [OK] ${label}`);
    } else {
        fail++;
        failures.push({ label, detail });
        console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
    }
}

function readFileOrNull(p) {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
}

function readPage(pageFile) {
    return readFileOrNull(path.join(PUBLIC_DIR, pageFile));
}

// 去 CSS 注释 /* ... */
function stripCssComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

// 在给定文本里查找裸 OLD_NAMES token（不含 u-/si- 前缀，独立 token 边界）。
// 返回命中列表：[{ name, index }]（去重按 name）。
function findBareOldNames(text) {
    const hits = new Set();
    for (const name of OLD_NAMES) {
        const re = new RegExp('(?<![\\w-])' + escapeRegExp(name) + '(?![\\w-])', 'g');
        if (re.test(text)) hits.add(name);
    }
    return [...hits];
}

// 从 class="..." / class='...' 属性值（含 JS 模板串内联写法）与 .className = '...' 赋值里
// 抽取空白分隔的 token，检查是否命中 OLD_NAMES（整词精确匹配，比正则子串扫描更贴合"属性值语义"）。
function findBareOldNamesInClassAttrs(html) {
    const hits = new Set();
    const attrRe = /class=(["'])([\s\S]*?)\1/g;
    const classNameRe = /\.className\s*=\s*(["'])([^"']*)\1/g;
    let m;
    while ((m = attrRe.exec(html)) !== null) {
        for (const tok of m[2].split(/\s+/)) {
            if (OLD_NAMES.includes(tok)) hits.add(tok);
        }
    }
    while ((m = classNameRe.exec(html)) !== null) {
        for (const tok of m[2].split(/\s+/)) {
            if (OLD_NAMES.includes(tok)) hits.add(tok);
        }
    }
    return [...hits];
}

// 断言②c（codex B 代码审 LOW-2 补）：JS DOM API 里对旧共享根类的引用。
// class=/className= 只覆盖"写 class 字符串"，抓不到 classList.add/remove/toggle/contains/replace、
// setAttribute('class', ...)、querySelector(All)/closest/matches('.x')、getElementsByClassName('x')
// 这些"按类名操作 DOM"的写法。只扫 OLD_NAMES（根类黑名单）token——修饰类（open/active/s-*/t-*）
// 不在黑名单里，天然豁免，故对 classList.add('open') 之类零误报（第十人视角前置约束）。
function findBareOldNamesInJsDomApis(html) {
    const apiRe = /(?:classList\s*\.\s*(?:add|remove|toggle|contains|replace)|getElementsByClassName|querySelectorAll|querySelector|closest|matches|setAttribute)\s*\(([^)]*)\)/g;
    const argChunks = [];
    let m;
    while ((m = apiRe.exec(html)) !== null) {
        argChunks.push(m[1]);
    }
    // 复用 findBareOldNames 的整词边界匹配：'.status-badge' 与 'status-badge' 都命中，
    // 'u-status-badge'（前置 '-'）被负向后顾排除。
    return findBareOldNames(argChunks.join('\n'));
}

// 拆出 components.css 每条规则的选择器头（逗号分组后逐条），供断言⓪b 校验根类。
// 纯文本切割（组件层是扁平 CSS 无 @media 嵌套）：注释剥离 → 按 '}' 分块 → 取 '{' 前选择器组 → 逗号拆分。
function extractSelectorHeads(css) {
    const noComments = stripCssComments(css);
    const heads = [];
    for (const chunk of noComments.split('}')) {
        const braceIdx = chunk.indexOf('{');
        if (braceIdx === -1) continue;
        const selectorGroup = chunk.slice(0, braceIdx).trim();
        if (!selectorGroup) continue;
        for (let sel of selectorGroup.split(',')) {
            sel = sel.trim();
            if (sel) heads.push(sel);
        }
    }
    return heads;
}

// ── 断言⓪ components.css 无裸 OLD_NAMES ──────────
function assertComponentsCssNoBareOldNames(componentsCss) {
    const noComments = stripCssComments(componentsCss);
    const hits = findBareOldNames(noComments);
    check(hits.length === 0, 'components.css：不含任何裸（无 u- 前缀）共享根类',
        hits.length ? `命中 ${hits.length} 个裸名：${hits.join(' | ')}（应改为 u-${hits[0]} 等）` : '');
}

// ── 断言⓪b（codex B 代码审 LOW-1 补）：从 components.css 自动派生根类，逐条校验根选择器必带 u- ──────────
// ⓪ 是黑名单（只抓已知旧名）；⓪b 是自动派生（不依赖黑名单）——任何新增规则若根选择器不是 .u-*
// （也非 .unified-page 覆盖钩子），一律判失败，堵住"加了黑名单外的新裸根类 → 泄漏到 style.css"的缺口。
function assertComponentsCssRootClassesArePrefixed(componentsCss) {
    const heads = extractSelectorHeads(componentsCss);
    const bad = heads.filter((sel) => !(/^\.u-[\w-]+/.test(sel) || /^\.unified-page\b/.test(sel)));
    check(bad.length === 0, 'components.css：每条规则的根选择器均为 .u-*（或 .unified-page 覆盖钩子）',
        bad.length ? `发现 ${bad.length} 条非 u- 根选择器（新增裸根类/元素选择器会泄漏到未迁移页）：${bad.slice(0, 5).join(' | ')}${bad.length > 5 ? ' …' : ''}` : '');
}

// ── 断言① 迁移页 body class ──────────
function assertBodyUnifiedClass(pageFile, html) {
    const bodyTagMatch = html.match(/<body\b[^>]*>/i);
    check(!!bodyTagMatch, `${pageFile}：存在 <body> 标签`, bodyTagMatch ? '' : '未找到 <body ...> 开始标签');
    if (!bodyTagMatch) return;
    const bodyTag = bodyTagMatch[0];

    const classAttrMatch = bodyTag.match(/\bclass\s*=\s*"([^"]*)"/i) || bodyTag.match(/\bclass\s*=\s*'([^']*)'/i);
    check(!!classAttrMatch, `${pageFile}：<body> 含 class 属性`, classAttrMatch ? '' : `实际标签：${bodyTag}`);
    if (!classAttrMatch) return;

    const classList = classAttrMatch[1].trim().split(/\s+/).filter(Boolean);
    const unifiedCount = classList.filter((c) => c === 'unified-page').length;
    check(unifiedCount === 1, `${pageFile}：<body> class 含且仅含一次 unified-page`,
        `实际出现 ${unifiedCount} 次，class 列表：[${classList.join(', ')}]`);
}

// ── 断言② 迁移页残留 <style> + JS 模板串（class=/className=）不得裸写 OLD_NAMES ──────────
function assertNoBareSharedSelectors(pageFile, html) {
    // ②a：残留 <style> 块里的 CSS 选择器（注释剥离后）
    const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
    const styleText = stripCssComments(styleBlocks.join('\n'));
    const styleHits = findBareOldNames(styleText);
    check(styleHits.length === 0, `${pageFile}：残留 <style> 未裸写任何共享根类选择器`,
        styleHits.length ? `裸写了 ${styleHits.length} 个共享根类（应加 u- 前缀）：${styleHits.join(' | ')}` : '');

    // ②b：全文 class="..." 属性值 / .className = '...' 赋值（覆盖静态 HTML 与 JS 模板串两种写法）
    const attrHits = findBareOldNamesInClassAttrs(html);
    check(attrHits.length === 0, `${pageFile}：class= 属性值 / className 赋值未裸写任何共享根类`,
        attrHits.length ? `裸写了 ${attrHits.length} 个共享根类（应加 u- 前缀）：${attrHits.join(' | ')}` : '');

    // ②c：JS DOM API（classList.*/setAttribute('class')/querySelector 等）里对旧根类的引用
    const apiHits = findBareOldNamesInJsDomApis(html);
    check(apiHits.length === 0, `${pageFile}：classList/querySelector/setAttribute 等 DOM API 未引用裸共享根类`,
        apiHits.length ? `DOM API 里引用了 ${apiHits.length} 个裸共享根类（应加 u- 前缀）：${apiHits.join(' | ')}` : '');
}

// ── 断言③ unify-helpers.js 输出 u- 根类 ──────────
function assertHelperOutputsUnifiedClasses(helperJs) {
    const hasUStatusBadge = /class="u-status-badge/.test(helperJs) || /'u-status-badge/.test(helperJs);
    const hasUTypeTag = /class="u-type-tag/.test(helperJs) || /'u-type-tag/.test(helperJs);
    check(hasUStatusBadge, 'unify-helpers.js：statusBadge() 输出 u-status-badge 根类',
        hasUStatusBadge ? '' : '未找到 u-status-badge 字面量，statusBadge() 可能仍输出裸 status-badge');
    check(hasUTypeTag, 'unify-helpers.js：typeTag() 输出 u-type-tag 根类',
        hasUTypeTag ? '' : '未找到 u-type-tag 字面量，typeTag() 可能仍输出裸 type-tag');

    // 反向兜底：确认没有裸 'status-badge '/'type-tag ' 残留（防止 u- 版本加了但旧版本没删）
    const bareLeftover = findBareOldNames(helperJs).filter((n) => n === 'status-badge' || n === 'type-tag');
    check(bareLeftover.length === 0, 'unify-helpers.js：不含裸 status-badge/type-tag 残留',
        bareLeftover.length ? `命中：${bareLeftover.join(' | ')}` : '');
}

// ============================================================
// 主流程
// ============================================================
(function main() {
    console.log('=== 前端统一 静态断言（style污染根治 B 方案 · u- 前缀模型）===\n');

    if (MIGRATED_PAGES.length === 0) {
        console.log('MIGRATED_PAGES 为空数组（尚无页面完成迁移）→ 0 个迁移页，静态断言跳过（PASS）。');
        console.log('\n=== 骨架态：0 项断言执行，PASS（退出码 0）===');
        process.exit(0);
    }

    console.log('--- components.css 前置检查（断言⓪）---');
    const componentsCss = readFileOrNull(COMPONENTS_CSS);
    check(componentsCss !== null, `components.css 存在于 assets/css/`, componentsCss === null ? `未找到 ${COMPONENTS_CSS}` : '');
    if (componentsCss === null) {
        console.log('\n=== FAIL：找不到 components.css（退出码 1）===');
        process.exit(1);
    }
    assertComponentsCssNoBareOldNames(componentsCss);
    assertComponentsCssRootClassesArePrefixed(componentsCss);
    console.log('');

    console.log('--- unify-helpers.js 前置检查（断言③）---');
    const helperJs = readFileOrNull(UNIFY_HELPERS_JS);
    check(helperJs !== null, `unify-helpers.js 存在于 assets/js/`, helperJs === null ? `未找到 ${UNIFY_HELPERS_JS}` : '');
    if (helperJs !== null) assertHelperOutputsUnifiedClasses(helperJs);
    console.log('');

    console.log(`待校验迁移页（${MIGRATED_PAGES.length} 个）：${MIGRATED_PAGES.join('、')}\n`);

    for (const pageFile of MIGRATED_PAGES) {
        console.log(`--- ${pageFile} ---`);
        const html = readPage(pageFile);
        check(html !== null, `${pageFile}：文件存在于 public/`, html === null ? `未找到 ${path.join(PUBLIC_DIR, pageFile)}` : '');
        if (html === null) continue;

        assertBodyUnifiedClass(pageFile, html);
        assertNoBareSharedSelectors(pageFile, html);
        console.log('');
    }

    console.log(`=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
    if (fail > 0) {
        console.log('\n失败明细：');
        failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}${f.detail ? ' — ' + f.detail : ''}`));
    }
    process.exit(fail === 0 ? 0 : 1);
})();
