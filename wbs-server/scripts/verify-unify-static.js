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
//
//   ── 状态徽章统一 S1 新增（方案 20260808 v1.2 §1/§2.1/§2.2/§4-S1）─────────────────────
//   ④ 语义色板：:root 唯一 + token 键集合与 14 层 × 6 后缀的笛卡尔积**精确相等**（多一个未知层/
//      未知后缀/游离 token 都红）+ 声明条数恰为 84 + 每键仅定义一次（重复定义会静默覆盖）。
//   ⑤ `.u-status-badge.sem-*` 14 条齐全；选择器必须**精确等于** `.u-status-badge.sem-<层>`
//      （拒作用域前缀/组合选择器/同层重复——它们会造成"守卫读一条、浏览器级联用另一条"的分叉假绿）；
//      每条六个 --sb-* 各**出现且仅出现一次**（漏写会退回 base fallback 变成半吊子继承，首审 H-1 成因；
//      重复写则后者覆盖前者而断言取首个 = 又一处分叉）。
//   ⑥ 语义类 → token 链路：14 层 × 6 键**逐项**严格等于 `var(--sem-<本层>-<本键>)`（引错层、写字面量
//      色值都红）+ token 侧特殊值钉死（archived-bds=dashed / voided-deco=line-through，二者是"色之外
//      的第二传义通道"，丢一个就退化为纯色区分）+ `--sem-*` **定义**不得出现在 components.css 之外
//      （页面内联 <style> 重定义会以更高优先级覆盖共享层而守卫看不见；引用 var(--sem-*) 不算）。
//   ⑦ WCAG 对比度校验（用户 2026-08-08 拍板入 S1）：逐层算 fg/bg 与 dot/bg 的对比度。
//      fg/bg ≥ 4.5:1 硬断言（11px 小字按 WCAG 2.x 正常文本标准，不走大字 3:1 宽免）；
//      dot/bg ≥ 3:1 警示级（console.warn 不 fail——色点是冗余通道，文字本身已达标）。
//      豁免表 CONTRAST_EXEMPT 见下方常量，仅豁 fg/bg 硬线，dot 警示照出。
//   ⑧ statusBadgeByMap() 白名单变体输出形态（复审 H-1 / 终审 M）：未命中必须退化为无修饰类的
//      u-status-badge 并 console.warn，不得把 map 外的原值拼进 class。
//   ⑨-⑫（S2 页面层）在 scripts/verify-badge-alias.js —— 六别名页的状态 key 全集→别名规则连通、
//      六值齐设逐项层名对应、反双存（禁 direct 色值残留）、非受控三页的 frozen 白名单 + 渲染点走 gate。
//      拆文件是因为关注点不同（共享层封版 vs 页面层逐页接线）且它带一张按页组织的大配置表；
//      但本文件 require 并运行它，保证**跑这一条命令就全跑到**（项目无聚合 runner，独立文件易被漏跑）。
'use strict';

const fs = require('fs');
const path = require('path');
const { runBadgeAliasAssertions, PAGE_ALIAS_SPECS, hasClassOutputEvidence } = require('./verify-badge-alias');

// LOW-9：受状态徽章体系管辖的页面清单，从 PAGE_ALIAS_SPECS **派生**而非各处手抄。
//   此前 MIGRATED_PAGES（7 页别名）与 spec（现 8 页，含 S3 收编的 PF/MC）两份名单各自演进，
//   每加一页就要记得同步 assertNoNulBytes / assertSemTokensOnlyInSharedLayer 两处清单——
//   典型的"清单漂移"。改为派生后，加页只需改 spec 一处。
const BADGE_SPEC_PAGES = PAGE_ALIAS_SPECS.map((s) => s.file);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COMPONENTS_CSS = path.join(PUBLIC_DIR, 'assets', 'css', 'components.css');
const UNIFY_HELPERS_JS = path.join(PUBLIC_DIR, 'assets', 'js', 'unify-helpers.js');

// ============================================================
// 配置区
// ============================================================

// 已完成"前端统一"改造迁移的页面文件名（相对 wbs-server/public/）。C1-C4 每迁一页往这里加一个。
// Quick_Log.html（2026-08-02 零星台账独立页）系新建即全程 u- 范式——非"迁移"但纳入同一守卫，
// 防未来往新页塞裸旧类名漂移（codex 231 轮随批裁定加入）。
// 状态徽章统一 S0 双矩阵实测补漏：Issue_Lite 是六别名页之一（body 已带 unified-page、页内有 5 条
//   .u-status-badge.s-* direct 声明、引 components.css + unify-helpers.js），此前一直漏在守卫之外。
// ⚠️ 本名单当前语义 = "已迁移页"，不是"全站页"。方案 §2.3 要求的**全 19 页扫描**扩展承接在
//   S5b 收口（方案 §4-S5b）——那时才把未迁移页（Task_Pool/My_Workspace/Periodic_Fetch/Model_Center 等）
//   纳入，且需为它们另设断言口径（未迁移页本就允许裸旧类，不能套 MIGRATED_PAGES 的黑名单断言）。
const MIGRATED_PAGES = ['Data_Correction.html', 'Sys_Iteration.html', 'Issue_Tracker.html', 'Data_Collab.html', 'Statistics.html', 'Quick_Log.html', 'Issue_Lite.html'];

// LOW-9：状态徽章体系的**全部管辖页** = 迁移页 ∪ 徽章 spec 页（后者含 S3 收编的 PF/MC）。
//   NUL 检查、--sem-* 越界检查这类"与 u- 迁移无关、只跟徽章体系有关"的断言一律用这份，
//   加页时只改 verify-badge-alias.js 的 spec 一处即可，不必再记得回来同步清单。
const BADGE_SCOPE_PAGES = [...new Set([...MIGRATED_PAGES, ...BADGE_SPEC_PAGES])];

// ══════════════════════════════════════════════════════════════
// 〔S5b〕全站 19 页分级扫描（方案 §4-S5b·S0 A.4 缺口·22B L2 承接收口）
// ══════════════════════════════════════════════════════════════
// 在此之前，守卫的扫描面 = BADGE_SCOPE_PAGES（10 spec 页 + Quick_Log）。剩下 8 页从未被任何断言
//   看过一眼——它们不是"验过是好的"，是"根本没验"。S5b 把扫描面拉到 public/ 下**全部** .html。
//
// ⚠️ 口径（22B L2 当时承接的注记，在此兑现）：**未迁移页断言的是「不越界」，不是「已迁移」。**
//   这两件事的判据完全相反：迁移页要求"必须用 u- 前缀、不许留裸旧类"；未迁移页则**本来就该**
//   留着裸旧类（它们连 components.css 都没引，旧类是它们唯一的样式来源）。把 MIGRATED_PAGES
//   那套黑名单套上去会得到一片假红。未迁移页真正该守的只有一条：**别把手伸到共享层这边来**——
//   用共享徽章类却不引共享层 = 徽章裸奔成无样式文本；私自定义 --sem-* = 污染全站色板真相源。
//
// 分级不写死名单，**按页面实测状态派生**（是否真的 <link> 了 components.css）：
//   名单会漂移，事实不会。某页哪天真引了共享层，它自动离开 T3、进入 T2/缺口桶，不需要谁记得
//   回来改名单——这正是 LOW-9 当初把 BADGE_SCOPE_PAGES 改成派生的同一条理由，只是覆盖面更大。
// 〔S5b-fix·M7〕**递归**枚举 public/**/*.html，不是只扫一层。
//   平铺的 readdirSync 有个静默前提："页面都在 public/ 根下"。这前提今天成立，而它一旦不成立
//   （谁新建一个 public/reports/xxx.html），那一页不会报错、不会 SKIP，就是**根本不在名单里**——
//   分级完备性断言也拦不住它，因为它连 ALL_PAGES 都没进。递归枚举把"没被发现"这种失败形态消掉。
//   路径统一用 POSIX 相对形式（`sub/page.html`）：报告可读，且与 readPage 的 path.join 兼容。
function listPagesRecursive(dir, relBase) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
        if (ent.isDirectory()) out.push(...listPagesRecursive(path.join(dir, ent.name), rel));
        else if (ent.isFile() && ent.name.toLowerCase().endsWith('.html')) out.push(rel);
    }
    return out;
}
const ALL_PAGES = listPagesRecursive(PUBLIC_DIR, '').sort();

// 共享徽章体系的"符号面"——逐字对齐 components.css 里实际定义的类（不是凭印象列的）：
//   .u-status-badge / .u-pri / .u-type-tag / .u-notify-badge 四个组件根类 + 14 个 .sem-* 语义层。
//   未引 components.css 的页面写了这些 class，浏览器一条规则也匹配不到 —— 徽章退化成纯文本，
//   而任何静态断言、任何 computed 抽样都不会去看那一页，缺陷可以一直活着。
const SHARED_BADGE_CLASS_RE_SRC = '\\b(u-status-badge|u-pri|u-type-tag|u-notify-badge)\\b';
const SEM_VAR_REF_RE_SRC = 'var\\(\\s*--sem-[\\w-]+';
// ⚠️ 语义层类的正则**必须惰性构造**：SEM_TIERS 声明在本段之后（TDZ），在模块顶层求值会
//   直接 ReferenceError。宁可每次现拼一个小正则，也不为省这点开销去挪 SEM_TIERS 的位置
//   —— 那会让「14 层色板」这个真相源离它的一堆消费方更远。
//   `(?<!-)` 是必需的：`--sem-done-bg` 里也含 `sem-done`，而 `-` 是非词字符 ⇒ `\bsem-done\b` 会命中它。
//   不排掉的话，一处 token **定义/引用**会被同时报成"用了语义层类"，两条断言各红一次、其中一条
//   说的还不是实情。token 面本来就有 SEM_VAR_REF_RE 和 ⑥c 两条各管一段，这里排掉不丢任何覆盖。
function sharedSemClassReSrc() { return `(?<!-)\\bsem-(${SEM_TIERS.join('|')})\\b`; }

// 〔S5b-fix·M7〕扫描前剥掉**注释**——注释里的说明文字不是页面行为。
//   本轮 S5b 自己就是活例子：几个页面的 <style> 注释里写着"这里原本用 .u-status-badge …"这类
//   迁移说明，按字符串扫会把它当成"该页用了共享徽章类"判红。假红比漏报更伤——它逼人去改注释，
//   或者更糟：逼人把断言放宽。
//   只剥 HTML 注释 + <style> 内的 CSS 注释这两种**定界符明确**的形态。
//   ⚠️ 有意**不**剥 <script> 里的 JS 行注释：朴素的 `//` 剥离会被 'http://…' 这种字符串腰斩，
//   把后半行连同其中真实的 class 一起吃掉 —— 那是往守卫里凿一个静默盲区。JS 注释造成的假红是
//   **吵**（fail-closed 方向），处理方式是改注释或显式登记，代价可控；凿盲区不可控。
//
// 〔S5b-fix2·M7 收口〕**先把 <script> 的内容占位保护起来，剥完再放回去。**
//   起因是老式脚本包装：
//       <script><!--
//           el.className = 'u-status-badge sem-done';
//       //--></script>
//   这是 90 年代给不认识 <script> 的浏览器兜底的写法，`<!--` 在 JS 里只是行注释、代码照常执行。
//   naive 的"全文剥 HTML 注释"会把整段真代码当注释吃掉 —— 于是一页真真正正在用共享徽章类，
//   守卫却看不见，**绿灯**。这是剥注释这件事引入的新盲区，方向比它原本要治的假红更危险。
//   占位保护后：script 里的一切原样保留（含它自己的 `<!--`），script **外**的 HTML 注释照剥。
//   ⚠️ 占位符用**纯 ASCII 哨兵**而不是控制字符：往守卫源码里塞不可见字符，正是本文件另一条
//     NUL 断言在防的那类麻烦（git / grep / 审查工具对控制字符各有各的脾气）。哨兵进场前先查一次
//     碰撞，撞上就抛 —— 宁可炸也不要静默串台。全过程只在内存里，不落盘。
const SCRIPT_GUARD = (i) => `@@U_SCRIPT_GUARD_${i}@@`;
const SCRIPT_GUARD_RE = /@@U_SCRIPT_GUARD_(\d+)@@/g;

//   〔26C-L·登记接受〕开标签用 `[^>]*` 匹配：若某天出现 `<script data-x="a>b">` 这种属性值内含 `>`
//   的写法，开标签会被提前截断、保护窗口错位（实测当前全站 56 个 <script> 中此形态 0 例）。
//   最坏后果是 script 内的 `<!--` 被当 HTML 注释剥掉 ⇒ **假红**（fail-closed 方向），
//   不会退化成漏报；真出现时按报错改注释或换写法即可，故登记接受、不引入完整 HTML 解析。
function stripPageCommentary(html) {
    SCRIPT_GUARD_RE.lastIndex = 0;
    if (SCRIPT_GUARD_RE.test(html)) {
        SCRIPT_GUARD_RE.lastIndex = 0;
        throw new Error('页面源码里出现了 stripPageCommentary 的占位哨兵 @@U_SCRIPT_GUARD_n@@，会与保护机制串台 —— 请换一个哨兵');
    }
    SCRIPT_GUARD_RE.lastIndex = 0;
    // ① 抽出所有 <script> 的**内容**（保留开闭标签，免得影响后续按标签匹配的正则）
    const scriptBodies = [];
    const guarded = html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, open, body, close) => {
        scriptBodies.push(body);
        return `${open}${SCRIPT_GUARD(scriptBodies.length - 1)}${close}`;
    });
    // ② 剥 script 之外的 HTML 注释
    //    （若某个 <script> 整体被包在 HTML 注释里，占位符会随注释一起消失——那段脚本本就是
    //      被注释掉的，不还原正是对的）
    let out = guarded.replace(/<!--[\s\S]*?-->/g, '');
    // ③ 剥 <style> 内的 CSS 注释
    out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a, body, b) => a + stripCssComments(body) + b);
    // ④ 还原 script 内容
    return out.replace(SCRIPT_GUARD_RE, (_m, i) => scriptBodies[+i]);
}

// 页面用到共享徽章符号的三种形态（组件根类 / 语义层类 / token 引用），返回命中清单供报错点名。
function sharedBadgeSymbolHits(rawHtml) {
    const html = stripPageCommentary(rawHtml);
    const hits = [];
    const m1 = html.match(new RegExp(SHARED_BADGE_CLASS_RE_SRC, 'g'));
    if (m1) hits.push(`组件根类 ${[...new Set(m1)].join('/')}（${m1.length} 处）`);
    const m2 = html.match(new RegExp(sharedSemClassReSrc(), 'g'));
    if (m2) hits.push(`语义层类 ${[...new Set(m2)].slice(0, 4).join('/')}（${m2.length} 处）`);
    const m3 = html.match(new RegExp(SEM_VAR_REF_RE_SRC, 'g'));
    if (m3) hits.push(`token 引用 var(--sem-*)（${m3.length} 处）`);
    return hits;
}

// components.css 的**有效** <link>（注释掉的不算——与 verify-badge-alias.js 的判据同口径）
function linksComponentsCss(html) {
    const noHtmlComments = html.replace(/<!--[\s\S]*?-->/g, '');
    return /<link\b[^>]*href\s*=\s*["'][^"']*components\.css/i.test(noHtmlComments);
}

// 全站分级：T1 徽章 spec 页 / T2 引共享层的非徽章页 / T3 未引共享层的未迁移页 / GAP 漏登记桶。
//   GAP 是这次分级顺带堵上的一个真缺口：一个页面**引了** components.css、**用了**共享徽章类、
//   却没进 PAGE_ALIAS_SPECS，它会同时躲开 T1 的全量断言（不在 spec 里）和 T3 的越界断言
//   （引了共享层，不算越界）—— 两头都不管。故单列一桶，非空即红。
function classifyPages() {
    const specSet = new Set(BADGE_SPEC_PAGES);
    const out = { T1: [], T2: [], T3: [], GAP: [], missing: [] };
    for (const f of ALL_PAGES) {
        const html = readPage(f);
        if (html === null) { out.missing.push(f); continue; }
        if (specSet.has(f)) { out.T1.push(f); continue; }
        if (linksComponentsCss(html)) {
            (sharedBadgeSymbolHits(html).length ? out.GAP : out.T2).push(f);
        } else {
            out.T3.push(f);
        }
    }
    return out;
}

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

// ── 状态徽章统一 S1 配置区 ────────────────────────────────────────────────
// 语义层清单（15 层）。与 components.css :root 块、方案 v1.2 §1 色板表三方同源——
// 加层/改层名必须三处同步，否则断言④⑤会立刻红灯（这正是它存在的意义）。
// prerelease = 第 14 层（待上线可见性 20260812 v1.0·D1b），「待上线」专属橙色相，
//   与 staging（交付/传输·数据协作 EXPORTING/TRANSFERRING 共用）分层而非改它。
// fastlane = 第 15 层（先行上线两步化 S7·方案 20260813 v1.8 §6·2026-08-14 启动门拍板），
//   「待先行部署 x/N」专属靛紫色相，与 prerelease 区分——见 components.css 该层注释。
const SEM_TIERS = [
    'wait', 'intake', 'active', 'review', 'special', 'staging', 'prerelease', 'fastlane',
    'done', 'hold', 'rejected', 'failed', 'archived', 'voided', 'legacy',
];

// 每层六 token 后缀：三色 + 边框形态 + 色点 + 文字修饰。
const SEM_TOKEN_SUFFIXES = ['bg', 'fg', 'bd', 'bds', 'dot', 'deco'];

// 语义类内必须齐设的六个消费端变量（与上方六 token 一一对应）。
const SB_VARS = ['--sb-bg', '--sb-fg', '--sb-bd', '--sb-bds', '--sb-dot', '--sb-deco'];

// WCAG 对比度阈值：正文 4.5:1（11px 属正常文本，不适用大字 3:1）；非文本图形 3:1。
const CONTRAST_TEXT_MIN = 4.5;
const CONTRAST_DOT_MIN = 3.0;

// 对比度硬线豁免表 = **产品层可访问性例外**（用户 2026-08-08 拍板，方案 v1.2 §4-S1）。
//   voided（作废）/ legacy（历史旧态）是**刻意弱化**的两层：它们表达"这条记录已失效 / 是早年遗留态"，
//   视觉上必须比活跃状态更淡，拉到 4.5:1 会让它们和正常状态一样醒目，语义反而错。
//   ⚠️ 这是产品取舍，**不主张符合 WCAG 的某条豁免条款**——状态徽章是静态文本不是禁用控件，
//   套「非活动用户界面组件」条款依据不足（codex 21 号审 M6）。诚实表述：明知不达 4.5:1 而接受，
//   靠冗余通道保底——voided 带 line-through、legacy 文案本身即"旧态"字样，信息不靠对比度单独承载。
//   豁免只豁 fg/bg 硬线，dot/bg 警示照常输出；新增豁免项必须在此写明理由，禁止静默放过。
//
//   ⚠️〔S5a-fix HIGH-1·适用范围条款〕**豁免层仅主状态徽章族（.u-status-badge）可用；次级族禁用。**
//   豁免能成立，全靠"line-through + 文案冗余"这道**第二传义通道**兜底；而终审 L 规定
//   通知/类型/优先级/次级族**不继承 deco**——它们用了豁免层，等于拿了豁免又把豁免赖以成立的
//   冗余通道拆掉，结果是一段真的低于 4.5:1 且没有任何补偿的文字。
//   这不是配色偏好，是可访问性缺口。硬闸门落在 verify-badge-alias.js 的族级断言里
//   （CONTRAST_EXEMPT_TIERS：次级族登记表引用 voided/legacy 一律判红）。
//   S5a 首版四处次级族映射到豁免层、全套断言一条没红，就是因为当时缺这道闸门。
const CONTRAST_EXEMPT = ['voided', 'legacy'];

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

// 〔N5-fix·守卫口径统一·2026-08-09〕**扫描前先剥注释**——与 emoji 守卫（verify-badge-alias.js
//   stripJsComments）同款纪律，本轮已是第三次栽在同一个坑上（① emoji 守卫把注释里的 👀 判红
//   ② 计数审计把"解释旧写法"的注释判红 ③ 断言②c 把注释里提到的裸类名判红），按 pattern-sweep
//   原则一次扫干净，不留第四次。
//   剥三类：HTML 注释 / JS 块注释 / JS 行注释。行注释的 `//` 要求前一个字符不是 `:"'\`\\`，
//   以躲开 `https://`、`"//foo"` 这类**不是注释**的双斜杠（CSS 里的 `/* */` 由块注释规则一并吃掉）。
//   ⚠️ 只作用于"找裸类名"这类**文本扫描**断言；需要看注释内容的断言（如覆盖声明表登记）不得用它。
function stripCommentsForScan(text) {
    return String(text)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
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
function findBareOldNamesInClassAttrs(rawHtml) {
    const html = stripCommentsForScan(rawHtml);   // 〔N5-fix〕剥注释先行：注释里写的类名不是渲染出去的类名
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

// 〔N5-fix〕剥注释检测器的**两向**对照组：只证"注释不判红"是不够的——万一剥过头把真代码也吃了，
//   守卫会从此静默放行（比误报危险得多）。故两向都要证：注释里的裸类名**不**判红 ∧ 真代码里的**仍**判红。
//   语料取一个真实存在于 OLD_NAMES 的根类，避免用编的名字导致判据恒空。
function assertStripCommentsSelfTest(check) {
    const name = OLD_NAMES.find((n) => /-/.test(n)) || OLD_NAMES[0];
    if (!name) { check(false, '剥注释对照组：OLD_NAMES 为空，语料无从构造（守卫空转）'); return; }

    // ① 注释形态（行注释 / 块注释 / HTML 注释）——都不该判红
    const inComment = [
        `<script>\n// 历史写法演示：document.querySelector('.${name}') 已废弃\n</script>`,
        `<script>\n/* 旧代码：el.classList.add('${name}') */\n</script>`,
        `<!-- 迁移前是 class="${name}" -->`,
    ];
    const commentHits = inComment.flatMap((s) => findBareOldNamesInJsDomApis(s).concat(findBareOldNamesInClassAttrs(s)));
    check(commentHits.length === 0,
        `剥注释对照组·向一：注释里的裸共享根类**不判红**（行/块/HTML 三种注释各一条语料·用真名 ${name}）`,
        commentHits.length ? `误报 ${commentHits.join(' | ')}` : '');

    // ② 真代码形态——必须仍判红（防"剥过头"把判定力一起剥没了）
    const liveApi = `<script>\ndocument.querySelector('.${name}');\n</script>`;
    const liveAttr = `<div class="${name}"></div>`;
    const apiHit = findBareOldNamesInJsDomApis(liveApi);
    const attrHit = findBareOldNamesInClassAttrs(liveAttr);
    check(apiHit.includes(name), `剥注释对照组·向二a：真代码里的 DOM API 裸类名**仍判红**（剥注释没剥过头）`,
        apiHit.length ? '' : `期望命中 ${name}，实得空`);
    check(attrHit.includes(name), `剥注释对照组·向二b：真代码里的 class 属性裸类名**仍判红**`,
        attrHit.length ? '' : `期望命中 ${name}，实得空`);

    // ③ 边界：`https://` 这类非注释双斜杠不得被当行注释吃掉（吃掉会让其后整行判定失效）
    const urlLine = `<script>\nconst u = "https://x.test/a"; document.querySelector('.${name}');\n</script>`;
    check(findBareOldNamesInJsDomApis(urlLine).includes(name),
        '剥注释对照组·向三：同一行里有 `https://` 时，其后的真代码仍被扫到（`//` 判据带前置字符约束）');
}

// 断言②c（codex B 代码审 LOW-2 补）：JS DOM API 里对旧共享根类的引用。
// class=/className= 只覆盖"写 class 字符串"，抓不到 classList.add/remove/toggle/contains/replace、
// setAttribute('class', ...)、querySelector(All)/closest/matches('.x')、getElementsByClassName('x')
// 这些"按类名操作 DOM"的写法。只扫 OLD_NAMES（根类黑名单）token——修饰类（open/active/s-*/t-*）
// 不在黑名单里，天然豁免，故对 classList.add('open') 之类零误报（第十人视角前置约束）。
function findBareOldNamesInJsDomApis(rawHtml) {
    const html = stripCommentsForScan(rawHtml);   // 〔N5-fix〕剥注释先行：注释里演示/复盘一段旧写法不该判红
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

// ── 断言⓪c 源文件不得含 NUL 字节（2026-08-08 本轮两次踩坑后固化）──────────
// 一个 NUL 就会让 git 把文本文件判成 binary：`git diff` 只显示 "Bin x -> y bytes"、`grep` 报
//   "Binary file matches"、代码审查工具直接读不到内容——**改动看似提交了，实际没人能审**。
//   这不是假设：本项目此前有过"一个 NUL 让两轮审查对最高风险文件全落空"的记录，而本轮
//   写共享层与守卫时又连中两次（本该是普通空格的分隔符被写成了 NUL）。故加成常驻断言，覆盖状态徽章
//   体系涉及的全部源文件——它便宜、确定，且失败信息能直接指到行。
function assertNoNulBytes() {
    const files = [
        ['assets/css/components.css', COMPONENTS_CSS],
        ['assets/js/unify-helpers.js', UNIFY_HELPERS_JS],
        // S4 起 app.js 与 style.css 也是徽章体系的直接改动面（渲染点 + 遗留层退场），一并纳入
        ['assets/js/app.js', path.join(PUBLIC_DIR, 'assets', 'js', 'app.js')],
        ['assets/css/style.css', path.join(PUBLIC_DIR, 'assets', 'css', 'style.css')],
        ['scripts/verify-unify-static.js', path.join(__dirname, 'verify-unify-static.js')],
        ['scripts/verify-badge-alias.js', path.join(__dirname, 'verify-badge-alias.js')],
        ['scripts/test-badge-computed-playwright.js', path.join(__dirname, 'test-badge-computed-playwright.js')],
        // 〔S5b〕PF computed 补跑编排（造数 → 跑 computed → 清理 → 0 残留），同属徽章体系源文件
        ['scripts/run-badge-computed-with-pf-fixture.js', path.join(__dirname, 'run-badge-computed-with-pf-fixture.js')],
        // 〔S5b〕页面清单从 BADGE_SCOPE_PAGES（10 spec + Quick_Log）扩到 public/ 下**全部** .html。
        //   NUL 与"是否迁移"毫无关系：它伤的是 git/grep/审查工具读文件的能力，未迁移页中一个
        //   同样会让那一页的改动无人可审。这条断言便宜到没有任何理由只扫一部分。
        ...ALL_PAGES.map((f) => [f, path.join(PUBLIC_DIR, f)]),
    ];
    const hits = [];
    for (const [label, p] of files) {
        if (!fs.existsSync(p)) continue;
        const buf = fs.readFileSync(p);
        const idx = buf.indexOf(0);
        if (idx !== -1) {
            const line = buf.slice(0, idx).toString('utf8').split('\n').length;
            hits.push(`${label}:${line}`);
        }
    }
    check(hits.length === 0, '状态徽章体系源文件均不含 NUL 字节（防 git/grep/审查工具把文本判成 binary）',
        hits.length ? `${hits.length} 个文件含 NUL：${hits.join(' | ')} —— 含 NUL 的文件 git diff 只显示 "Bin"、grep 报 binary、审查工具读不到内容` : '');
}

// ── 断言⑯ style.css 遗留徽章族「退场到位 + 不过头」（状态徽章统一 S4）──────────
// 这条断言有两个方向，缺一不可：
//   **退场到位**：`.badge-open/claimed/done/hold/archived` 五条修饰 + 抽屉作用域覆盖段
//     （`.drawer-info-item .info-value .status-badge…`）必须消失。它们实测只被
//     Task_Pool / My_Workspace 消费，两页已迁到共享层；留着就是"两套徽章色值并存"，
//     哪天有人给这两页加回旧类名，观感会静默回退到渐变层而守卫全绿。
//   **不过头**：`.status-badge` base **必须还在**，且保留 box-shadow / letter-spacing /
//     text-transform 三条形态属性。这是 §9 待追认 P1 的口径：Asset_Center 与 Domain_Manager
//     两页页内只重定义了盒模型类属性，靠这条 base 提供其余形态，删了它们当场变形。
//     没有这半条，"顺手清理干净"是一次很自然、很难被发现的破坏——两页不在任何 spec 里，
//     没有任何别的断言会为它们说话。
const RETIRED_BADGE_MODIFIERS = ['badge-open', 'badge-claimed', 'badge-done', 'badge-hold', 'badge-archived'];
// 五条 = S0 双矩阵附录 A.2 逐条举证的「两页页内**未**重定义、只能靠 base 提供」的属性全集。
//   与举证同源，不多不少：少列一条就等于默许它被删掉而无人发现。
const RETAINED_BASE_PROPS = ['box-shadow', 'letter-spacing', 'text-transform', 'white-space', 'flex-shrink'];

function assertLegacyStyleCssBadgeRetirement() {
    const styleCss = readFileOrNull(path.join(PUBLIC_DIR, 'assets', 'css', 'style.css'));
    check(styleCss !== null, 'style.css 存在于 assets/css/', styleCss === null ? '未找到' : '');
    if (styleCss === null) return;
    const noComments = stripCssComments(styleCss);

    // 逐条规则（选择器头 + 规则体）——注释已剥，注释里提及旧类名不算数
    const rules = [];
    for (const chunk of noComments.split('}')) {
        const braceIdx = chunk.indexOf('{');
        if (braceIdx === -1) continue;
        const group = chunk.slice(0, braceIdx).trim();
        if (!group) continue;
        const body = chunk.slice(braceIdx + 1);
        for (const sel of group.split(',')) {
            const t = sel.trim();
            if (t) rules.push({ sel: t, body });
        }
    }

    // ① 五条修饰类零残留（标识符级边界：不误伤 badge-admin / badge-active 等 admin 角色族）
    const strays = rules.filter((r) => RETIRED_BADGE_MODIFIERS
        .some((name) => new RegExp('(?<![\\w-])' + escapeRegExp(name) + '(?![\\w-])').test(r.sel)));
    check(strays.length === 0, `style.css：遗留徽章修饰类已退场（${RETIRED_BADGE_MODIFIERS.join(' / ')}）`,
        strays.length ? `${strays.length} 条仍在：${strays.map((r) => r.sel).join(' | ')} —— 两页已改输出 sem-*，这些规则要么是漏删、要么是有人把旧类名加了回来` : '');

    // ② 抽屉作用域覆盖段零残留
    const drawerScoped = rules.filter((r) => /(?<![\w-])drawer-info-item(?![\w-])/.test(r.sel)
        && /(?<![\w-])status-badge(?![\w-])/.test(r.sel));
    check(drawerScoped.length === 0, 'style.css：抽屉作用域的徽章覆盖段已退场（.drawer-info-item .info-value .status-badge…）',
        drawerScoped.length ? `${drawerScoped.length} 条仍在：${drawerScoped.map((r) => r.sel).join(' | ')}` : '');

    // ③ base 仍在且形态属性完整（P1：保留是裁定，不是遗漏）
    const baseRules = rules.filter((r) => r.sel === '.status-badge');
    check(baseRules.length === 1, 'style.css：`.status-badge` base 仍在且恰一条（P1 口径·Asset_Center/Domain_Manager 依赖）',
        baseRules.length === 0
            ? 'base 被删了——Asset_Center 与 Domain_Manager 的徽章会丢失 box-shadow/letter-spacing/text-transform 等形态属性当场变形。'
              + '若确要完全退场，须先把这两页页内 base 补自足，并同步更新本断言与任务锚点 §9 的 P1 裁定'
            : `发现 ${baseRules.length} 条同名 base（应恰一条）`);
    if (baseRules.length === 1) {
        const missing = RETAINED_BASE_PROPS.filter((p) => !new RegExp('(?<![\\w-])' + escapeRegExp(p) + '\\s*:').test(baseRules[0].body));
        check(missing.length === 0, `style.css：\`.status-badge\` base 保留形态属性（${RETAINED_BASE_PROPS.join(' / ')}）`,
            missing.length ? `缺 ${missing.join(' | ')} —— 这几条正是另两页没有重定义、只能靠 base 提供的属性` : '');
    }
}

// ── 断言⑯b 遗留 base 的两个消费页仍在消费（S4 回归确认的静态证明）──────────
// `.status-badge` base 之所以保留，理由是 Asset_Center / Domain_Manager 靠它补形态属性。
//   这条断言把那个**理由**本身钉住：只要这两页还在页内重定义 + 还在输出该类，保留就成立；
//   哪天它们不再消费了，这条会红，逼人回来重估 P1（那时 base 才该真正退场）。
//   没有它，"为什么留着这段死不了的旧 CSS"过一阵就没人说得清了。
const LEGACY_BASE_CONSUMERS = [
    { page: 'Asset_Center.html', outputFile: 'Asset_Center.html' },
    { page: 'Domain_Manager.html', outputFile: 'assets/js/domain_manager.js' },
];

function assertLegacyBaseConsumersIntact() {
    const tokenRe = () => /(?<![\w-])status-badge(?![\w-])/;
    for (const c of LEGACY_BASE_CONSUMERS) {
        const html = readPage(c.page);
        if (html === null) { check(false, `${c.page}：文件存在于 public/`, '未找到'); continue; }
        const styleText = stripCssComments([...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'));
        check(tokenRe().test(styleText), `${c.page}：页内仍重定义 .status-badge（S4 未动，观感不变）`,
            '页内重定义不见了——它与 style.css base 是配套的，若确要移除，须同时重估 base 的保留裁定（P1）');

        // 〔B9〕输出点证据改「正文 class 属性解析 + JS class sink」，不再是全文关键词。
        //   全文关键词的问题：CSS 定义里必然出现同一个词，于是上面那条"页内仍重定义"
        //   顺手就把这条也喂绿了——两条断言其实只有一条在干活，而"还有没有真的在渲染它"
        //   才是 P1 保留裁定真正依赖的事实。
        const outSrc = readFileOrNull(path.join(PUBLIC_DIR, c.outputFile));
        const kind = /\.js$/i.test(c.outputFile) ? 'js' : 'html';
        const hasOutput = outSrc !== null && hasClassOutputEvidence(outSrc, 'status-badge', kind);
        check(hasOutput, `${c.page}：仍有 status-badge **真实输出点**（${c.outputFile}·正文 class 属性/JS class sink）`,
            outSrc === null
                ? `读不到 ${c.outputFile}`
                : '找不到任何真实渲染点（只有 CSS 定义不算）——该页已不再消费遗留 base，P1「保留」的理由随之失效，请回来重估');
    }

    // Dashboard 冒烟级：S0 实测零徽章族消费，S4 改 app.js 对它零风险。这条把"零"钉住——
    //   哪天有人在 Dashboard 里用了旧徽章类，回归面就变了，得重新评估而不是默认无关。
    const dash = readPage('Dashboard.html');
    if (dash !== null) {
        const hits = ['status-badge', 'badge-open', 'badge-claimed', 'badge-done', 'badge-hold', 'badge-archived']
            .filter((t) => new RegExp('(?<![\\w-])' + escapeRegExp(t) + '(?![\\w-])').test(dash));
        check(hits.length === 0, 'Dashboard.html：零徽章族消费（S4 回归面确认·冒烟级）',
            hits.length ? `出现了 ${hits.join(' | ')} —— 本页原本与徽章体系无关，回归面须重新评估` : '');
    }
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
// 状态徽章统一 S1 补：`:root` 加入白名单（且仅此一个字面量，不放开任何伪类/元素选择器）。
//   理由——⓪b 防的是"裸根类规则泄漏到未迁移页"，而 :root 块只声明自定义属性（--sem-*），
//   自定义属性本身零视觉效果，只有被 var() 引用时才生效，对未迁移页是纯惰性数据，无泄漏面。
//   方案 v1.2 §2.1 明确要求色板落 :root（次级族 val-badge 等非 .u-status-badge 元素在 S5a
//   也要引用这批 token，挂在 .u-status-badge 上会够不着）。
function assertComponentsCssRootClassesArePrefixed(componentsCss) {
    const heads = extractSelectorHeads(componentsCss);
    const bad = heads.filter((sel) => !(/^\.u-[\w-]+/.test(sel) || /^\.unified-page\b/.test(sel) || sel === ':root'));
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

// ── 断言③ unify-helpers.js 输出 u- 根类（预筛 M4：改为逐函数体验证）──────────
// 原实现在**全文件**层面找 `u-status-badge` 字面量。statusBadgeByMap() 加入后，文件里有了
//   两处该字面量——此时把 statusBadge() 改回输出裸 `status-badge`，全文件扫描仍能在 byMap 里
//   找到字面量而判绿（另一条裸名断言也只是"不含裸残留"，改成 `'status-' + 'badge'` 之类即可绕过）。
//   即"函数 A 的证据替函数 B 背了书"。故拆成逐函数体验证：谁的输出谁自己举证。
const HELPER_OUTPUT_SPECS = [
    { fn: 'statusBadge', rootClass: 'u-status-badge' },
    { fn: 'statusBadgeByMap', rootClass: 'u-status-badge' },
    { fn: 'typeTag', rootClass: 'u-type-tag' },
];

function assertHelperOutputsUnifiedClasses(helperJs) {
    for (const spec of HELPER_OUTPUT_SPECS) {
        const body = extractFunctionSource(helperJs, spec.fn);
        const runaway = body.length > 0 && new RegExp('\\bfunction\\s+(?!' + escapeRegExp(spec.fn) + '\\b)\\w+\\s*\\(').test(body);
        check(body.length > 0 && !runaway, `unify-helpers.js：${spec.fn}() 函数体可提取且未越界`,
            body.length === 0
                ? '未找到该函数或花括号一路不平衡——下面的输出断言会退化为恒真'
                : (runaway ? '提取结果混入其他具名函数（花括号不平衡吃过头），输出断言会在邻居代码上假绿' : ''));
        if (!body.length || runaway) continue;

        const emits = new RegExp('class="' + escapeRegExp(spec.rootClass) + '(?![\\w-])').test(body);
        check(emits, `unify-helpers.js：${spec.fn}() 函数体内输出 ${spec.rootClass} 根类`,
            emits ? '' : `函数体内未找到 class="${spec.rootClass}" 字面量——该函数可能仍输出裸根类（此断言只看本函数体，不再被同文件其他函数的字面量喂绿）`);

        // 逐函数体反向兜底：本函数体内不得出现裸 status-badge / type-tag。
        const bare = findBareOldNames(body).filter((n) => n === 'status-badge' || n === 'type-tag');
        check(bare.length === 0, `unify-helpers.js：${spec.fn}() 函数体内不含裸 status-badge/type-tag`,
            bare.length ? `命中：${bare.join(' | ')}` : '');
    }

    // 三个 helper 分别挂到命名空间（导出漏一个 = 页面调不到，但函数本身全绿）。
    for (const spec of HELPER_OUTPUT_SPECS) {
        const exported = new RegExp('UnifyHelpers\\.' + escapeRegExp(spec.fn) + '\\s*=').test(helperJs);
        check(exported, `unify-helpers.js：${spec.fn} 已挂到 UnifyHelpers 命名空间`,
            exported ? '' : '函数已定义但未导出，页面调不到');
    }
}

// ============================================================
// 状态徽章统一 S1 断言（④-⑧）
// ============================================================

// ── 断言④a `:root` 唯一性（预筛 MED-2）──────────
// 为什么必须硬断言"有且仅有 1 个 :root"：
//   ⓪b 的白名单放行的是"选择器 == ':root'"，它不区分第 1 个还是第 5 个；而下方 extractSemTokens
//   用的是**非贪婪匹配第一个** `:root { ... }`。二者叠加出一个静默失效通道——文件里追加第二个
//   `:root { --sem-done-fg: #ccc; }`，浏览器按后来者胜级联真实渲染成低对比灰，而断言④⑦读到的
//   仍是第一个块里的旧值，全绿放行。即"断言对象与真实级联值分叉"。
//   单一 :root 是把这条通道从根上焊死：色板只能有一个真相源，改值只能改那一处。
//   （extractSemTokens 已更名 extractSemTokenDecls，行为同上：仍只读第一个 :root 块。）
function assertSingleRootBlock(componentsCss) {
    const noComments = stripCssComments(componentsCss);
    const heads = extractSelectorHeads(noComments);
    const rootCount = heads.filter((sel) => sel === ':root').length;
    check(rootCount === 1, 'components.css：:root 块有且仅有 1 个（色板单一真相源）',
        rootCount === 0
            ? '未找到 :root 块——语义色板缺失'
            : `发现 ${rootCount} 个 :root 块：后写的会按级联覆盖先写的，而 token 断言只读第一个，造成"断言对象与真实渲染值分叉"的假绿。请合并为一个块。`);
}

// 从 components.css 的 :root 块抽 --sem-* 定义。
//   返回**声明列表** [{ key, value }] 而非直接折叠成对象（预筛 L1）：折叠会让"同一 key 定义两次"
//   静默消失（后写的覆盖先写的），而重复定义正是需要被抓出来的问题——守卫读到的是后者、
//   人读文件时容易只看到前者。保留列表，由断言④自行判重。
function extractSemTokenDecls(componentsCss) {
    const noComments = stripCssComments(componentsCss);
    const rootMatch = noComments.match(/:root\s*\{([\s\S]*?)\}/);
    if (!rootMatch) return null;
    const decls = [];
    // 有意宽松匹配 key（[\w-]+ 而非 SEM_TIERS 枚举）：把"游离/拼错的 --sem-xxx"也收进来，
    // 交给断言④的"键集合完全相等"去判红，而不是在提取阶段静默丢弃。
    const re = /--sem-([\w-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(rootMatch[1])) !== null) {
        decls.push({ key: m[1], value: m[2].trim() });
    }
    return decls;
}

// 声明列表 → { key: value }（取最后一次定义，与浏览器级联一致）。判重由断言④负责。
function tokensFromDecls(decls) {
    if (!decls) return null;
    const tokens = {};
    for (const d of decls) tokens[d.key] = d.value;
    return tokens;
}

// 抽 `.u-status-badge.sem-X { ... }` 规则 → { tier: { body, selector } }，外加异常清单。
//   预筛 M2/M3：原实现用子串匹配 /\.u-status-badge\.sem-([a-z]+)\s*\{([^}]*)\}/g，有两个洞——
//   ① 作用域/组合选择器（`.u-wrapper .u-status-badge.sem-done`、`.x, .u-status-badge.sem-done`）
//      会被当成合法的层规则收下，而它实际只在特定祖先下生效，断言绿了但大部分场景没接线；
//   ② 同层重复规则（写了两条 .sem-done）只留第一条，浏览器却按最后一条渲染 = 断言对象与真实
//      级联值分叉的假绿（与 :root 唯一性同款失效模式）。
//   故改为**规则级**提取：按选择器头逐条判定，只接受**精确等于** `.u-status-badge.sem-<层>` 的规则，
//   其余一律进 anomalies 由断言⑤报红。
function extractSemRules(componentsCss) {
    const noComments = stripCssComments(componentsCss);
    const rules = {};
    const anomalies = [];
    const seen = {};

    for (const chunk of noComments.split('}')) {
        const braceIdx = chunk.indexOf('{');
        if (braceIdx === -1) continue;
        const selectorGroup = chunk.slice(0, braceIdx).trim();
        const body = chunk.slice(braceIdx + 1);
        if (!selectorGroup || selectorGroup.indexOf('sem-') === -1) continue;

        const heads = selectorGroup.split(',').map((s) => s.trim()).filter(Boolean);
        for (const sel of heads) {
            if (sel.indexOf('sem-') === -1) continue;
            const exact = sel.match(/^\.u-status-badge\.sem-([a-z]+)$/);
            if (!exact) {
                anomalies.push(`选择器 \`${sel}\` 不是精确的 .u-status-badge.sem-<层>（作用域前缀/组合选择器会让接线只在特定祖先下生效）`);
                continue;
            }
            const tier = exact[1];
            if (seen[tier]) {
                anomalies.push(`.sem-${tier} 有重复规则（守卫读第一条、浏览器级联用最后一条 = 分叉假绿）`);
                continue;
            }
            seen[tier] = true;
            // 选择器组里混写多个选择器时规则体是共享的，取到的都是同一段 body（下面另有断言拦合并书写）。
            rules[tier] = body;
            if (heads.length > 1) {
                anomalies.push(`.sem-${tier} 与其他选择器共用一条规则（\`${selectorGroup}\`）——层与值应一一对应，禁止合并书写`);
            }
        }
    }
    return { rules, anomalies };
}

// ── 断言④ token 集合精确相等 + 无重复定义（预筛 L1 收紧）──────────
// 原版只查"该有的都在"（缺一报红），查不出三类问题：多出未知层（--sem-foo-bg）、
// 多出未知后缀（--sem-done-shadow）、同一 key 定义两次（后者悄悄覆盖前者）。
// 收紧为三问：总数恰为 84（14 层 × 6 后缀·加层时随 SEM_TIERS 自动重算，本行只是说明）/
//   键集合与 SEM_TIERS×SUFFIXES 笛卡尔积完全相等 / 每键仅定义一次。
function assertSemTokensComplete(decls) {
    if (decls === null) {
        check(false, 'components.css：存在 :root 语义色板块', '未找到 `:root { ... }` 块');
        return;
    }
    const expectedKeys = [];
    for (const tier of SEM_TIERS) {
        for (const suf of SEM_TOKEN_SUFFIXES) expectedKeys.push(`${tier}-${suf}`);
    }
    const expectedSet = new Set(expectedKeys);
    const actualKeys = decls.map((d) => d.key);
    const actualSet = new Set(actualKeys);

    const missing = expectedKeys.filter((k) => !actualSet.has(k));
    const extra = [...actualSet].filter((k) => !expectedSet.has(k));
    const dupes = [...new Set(actualKeys.filter((k, i) => actualKeys.indexOf(k) !== i))];

    check(missing.length === 0 && extra.length === 0,
        `components.css：语义色板 token 键集合精确相等（${SEM_TIERS.length} 层 × ${SEM_TOKEN_SUFFIXES.length} = ${expectedKeys.length} 个，多一个少一个都不行）`,
        (missing.length || extra.length)
            ? `${missing.length ? '缺 ' + missing.length + ' 个：' + missing.slice(0, 6).join(' | ') + (missing.length > 6 ? ' …' : '') : ''}` +
              `${(missing.length && extra.length) ? '；' : ''}` +
              `${extra.length ? '多 ' + extra.length + ' 个游离/拼错 token：' + extra.map((k) => '--sem-' + k).slice(0, 6).join(' | ') + (extra.length > 6 ? ' …' : '') : ''}`
            : '');

    check(decls.length === expectedKeys.length,
        `components.css：语义色板声明条数恰为 ${expectedKeys.length}`,
        `实际 ${decls.length} 条（重复定义/多余声明都会让这条与键集合断言分别报）`);

    check(dupes.length === 0, 'components.css：语义色板每个 token 仅定义一次',
        dupes.length ? `${dupes.length} 个 token 重复定义（后写的静默覆盖先写的）：${dupes.map((k) => '--sem-' + k).join(' | ')}` : '');
}

// ── 断言⑤ sem-* 14 条齐全 + 选择器形态合法 + 每变量出现且仅出现一次 ──────────
function assertSemClassesComplete(rules, anomalies) {
    // ⑤a 选择器形态（预筛 M2/M3）：作用域前缀、组合选择器、同层重复，都在提取阶段进 anomalies。
    check(anomalies.length === 0, 'components.css：sem-* 规则选择器形态合法（精确 .u-status-badge.sem-<层>·无重复·无合并书写）',
        anomalies.length ? `${anomalies.length} 处异常：${anomalies.join('；')}` : '');

    const missingTiers = SEM_TIERS.filter((t) => !rules[t]);
    check(missingTiers.length === 0, `components.css：.u-status-badge.sem-* 覆盖全部 ${SEM_TIERS.length} 层`,
        missingTiers.length ? `缺 ${missingTiers.length} 条：${missingTiers.map((t) => '.sem-' + t).join(' | ')}` : '');

    const extraTiers = Object.keys(rules).filter((t) => !SEM_TIERS.includes(t));
    check(extraTiers.length === 0, 'components.css：无 SEM_TIERS 之外的游离 sem-* 规则',
        extraTiers.length ? `多出 ${extraTiers.length} 条（新增层须同步 SEM_TIERS 与方案 §1 色板表）：${extraTiers.map((t) => '.sem-' + t).join(' | ')}` : '');

    // ⑤b 六变量各"出现且仅出现一次"——同一规则体内写两次 --sb-fg，后者覆盖前者，
    //    而下面断言⑥的取值校验用的是首次匹配 = 又一处"断言对象与真实级联值分叉"。
    const incomplete = [];
    for (const tier of SEM_TIERS) {
        const body = rules[tier];
        if (!body) continue;
        for (const v of SB_VARS) {
            const hits = (body.match(new RegExp(escapeRegExp(v) + '\\s*:', 'g')) || []).length;
            if (hits === 0) incomplete.push(`.sem-${tier} 缺 ${v}`);
            else if (hits > 1) incomplete.push(`.sem-${tier} 的 ${v} 重复 ${hits} 次（后者覆盖前者）`);
        }
    }
    check(incomplete.length === 0, `components.css：每条 sem-* 六值各出现且仅出现一次（${SB_VARS.join(' / ')}）`,
        incomplete.length ? `${incomplete.length} 处：${incomplete.join('；')}` : '');
}

// ── 断言⑥ 语义类 → token 链路（预筛 M2/M3 升级：2 键 → 六键全覆盖）──────────
// 分两问，缺一不可：
//   ⑥a 类侧——14 层 × **六个** --sb-* 是否**逐项恰好**引用本层同名 token（var(--sem-<本层>-<后缀>)）？
//       上一版只校 bds/deco 两键，bg/fg/bd/dot 只要是 var() 甚至直接写死色值都能过——而"写死色值"
//       正是本次重构要消灭的东西（色板将不再是唯一真相源），"引错层"（sem-done 的 --sb-fg 引
//       --sem-hold-fg）更是肉眼极难发现的错配。故六键全校、且严格比对整串。
//       写字面量一律判失败：字面量会让 token 变成无人引用的死数据，改 token 不生效而注释仍声称
//       "颜色/形态进 token"=声称超实现。
//   ⑥b token 侧——archived-bds 必须真是 dashed、voided-deco 必须真是 line-through。
//       ⑥a 只保证"链路通"，链路通但两端都写 solid/none，虚线和删除线照样消失。
//       这两个特殊值是"色之外的第二传义通道"（done/archived 同绿系全靠它区分），必须钉死。
function assertShapeContractPairs(rules, tokens) {
    // ⑥a 逐层逐键链路（六键：bg/fg/bd/bds/dot/deco）
    const brokenLinks = [];
    for (const tier of SEM_TIERS) {
        const body = rules[tier];
        if (!body) continue;   // 缺规则由断言⑤报，这里不重复
        for (const suf of SEM_TOKEN_SUFFIXES) {
            const m = body.match(new RegExp('--sb-' + suf + '\\s*:\\s*([^;]+);'));
            if (!m) continue;  // 缺值/重复由断言⑤报
            const actual = m[1].trim();
            const expected = `var(--sem-${tier}-${suf})`;
            if (actual !== expected) {
                brokenLinks.push(`.sem-${tier} 的 --sb-${suf}=\`${actual}\`（应为 \`${expected}\`）`);
            }
        }
    }
    check(brokenLinks.length === 0,
        `components.css：${SEM_TIERS.length} 层 × ${SEM_TOKEN_SUFFIXES.length} 键均逐项引用本层同名 token（--sb-<键> → var(--sem-<层>-<键>)）`,
        brokenLinks.length
            ? `${brokenLinks.length} 处断链/引错层/写死：${brokenLinks.join('；')}`
            : '');

    // ⑥b token 侧特殊值
    if (tokens) {
        const tokDashed = (tokens['archived-bds'] || '') === 'dashed';
        const tokLine = (tokens['voided-deco'] || '') === 'line-through';
        check(tokDashed && tokLine,
            'components.css：形态特殊值成对存在（--sem-archived-bds:dashed + --sem-voided-deco:line-through）',
            `--sem-archived-bds=${tokens['archived-bds'] || '(缺)'}（应 dashed）；--sem-voided-deco=${tokens['voided-deco'] || '(缺)'}（应 line-through）——丢一个即退化为纯色区分`);
    }
}

// ── 断言⑥c `--sem-*` 定义只许落共享层（预筛 L2 低成本版）──────────
// 色板要当"唯一真相源"，就不能允许任何页面/遗留样式表**再定义**一份同名 token：
//   页面内联 <style> 里的 `--sem-done-fg: #xxx` 会以更高优先级覆盖共享层，让全站 token 出现
//   "这一页不一样"的暗坑；而守卫只读 components.css，永远看不见 = 假绿。
// 只查**定义**不碰**引用**：两种形态天然可分——定义写成 `--sem-xxx:`（属性名后紧跟冒号），
//   引用写成 `var(--sem-xxx)`（token 名被包在 var( … ) 里，后面是 `)` 或 `,` 而非 `:`）。
//   所以「token 名 + 冒号」这个模式只会命中定义，不需要任何前瞻/后顾技巧。
//   这条区分很关键：S2 已落地的 43 条别名规则、S5a 的次级族，全都要大量 var() 引用 token，
//   误伤引用会把正常接线整片判红。
// ⚠️ 当前扫描面 = style.css + MIGRATED_PAGES 的内联 <style>；全 19 页扩展承接 S5b（方案 §4-S5b）。
// B-H6① components.css 自身：--sem-* 定义只许出现在**那唯一一个 :root 块**里。
//   断言④a 已保证 :root 只有一个，但没人管 `:root` 之外的规则——`.page { --sem-done-bg: red }`
//   会在该选择器命中的子树里整片改写 token，而所有 token 断言只读 :root 块，全绿。
//   做法：把唯一 :root 块的正文从全文里挖掉，剩下的文本里再出现 --sem-*: 定义即判红。
function assertSemDefsConfinedToRoot(componentsCss) {
    const noComments = stripCssComments(componentsCss);
    const rootMatch = noComments.match(/:root\s*\{([\s\S]*?)\}/);
    const rest = rootMatch ? noComments.replace(rootMatch[0], '') : noComments;
    const strays = [...new Set((rest.match(/--sem-[\w-]+\s*:/g) || []))];
    check(strays.length === 0, 'components.css：--sem-* 定义只出现在唯一 :root 块内',
        strays.length ? `:root 之外还有 ${strays.length} 处定义：${strays.slice(0, 6).join(' ')} —— 它们会在对应选择器的子树里改写 token，而 token 断言只读 :root，属"断言对象与真实渲染值分叉"` : '');
}

// ── 〔S5b〕断言⑰ 全站 19 页分级扫描 ──────────────────────────
// 三级 + 一个缺口桶，逐级的断言强度**不同**，故报告里必须把归属打出来 —— 全绿时人也能一眼
//   看清"哪一页享受的是哪一档保护"，而不是被一行 PASS 糊弄成"19 页都验到位了"。
function assertPageTierCoverage(tiers) {
    // ① 完备性：分级必须刚好切完 public/ 下全部 .html，不重不漏。
    //   这条是其余各条的前提——只要有一页掉出分级，它就同时掉出了所有断言，而报告照样全绿。
    const covered = tiers.T1.length + tiers.T2.length + tiers.T3.length + tiers.GAP.length + tiers.missing.length;
    check(covered === ALL_PAGES.length && tiers.missing.length === 0,
        `全站 ${ALL_PAGES.length} 个页面全部落入分级（T1 ${tiers.T1.length} / T2 ${tiers.T2.length} / T3 ${tiers.T3.length}）`,
        tiers.missing.length ? `${tiers.missing.length} 页读不出内容：${tiers.missing.join(' | ')}`
            : (covered !== ALL_PAGES.length ? `分级合计 ${covered} ≠ 实际 ${ALL_PAGES.length}` : ''));

    // ② 缺口桶必须空：引了共享层 + 用了共享徽章符号 + 没进 PAGE_ALIAS_SPECS = 两头不管的死角。
    const gapDetail = tiers.GAP.map((f) => `${f}（${sharedBadgeSymbolHits(readPage(f) || '').join('；')}）`);
    check(tiers.GAP.length === 0,
        '无"引共享层且用了共享徽章符号、却未登记 PAGE_ALIAS_SPECS"的页面',
        gapDetail.length ? `${gapDetail.length} 页两头不管：${gapDetail.join(' | ')} —— 它躲开 T1 全量断言（不在 spec）也躲开 T3 越界断言（引了共享层），`
            + '页内徽章接线无人校验。要么补进 PAGE_ALIAS_SPECS，要么把徽章符号撤掉' : '');

    // ③ T3（未迁移页）越界扫描 —— **断言的是「不越界」，不是「已迁移」**。
    //   未迁移页留裸旧类是正常的（旧类是它们唯一样式来源），故这里绝不套 MIGRATED_PAGES 的黑名单。
    //   只守一条：没引 components.css 就别用共享徽章符号 —— 那些 class 一条规则都匹配不到，
    //   徽章会静默退化成无样式纯文本，而它既不在 spec 里也不在 computed 抽样里，没有任何人会发现。
    const trespass = [];
    for (const f of tiers.T3) {
        const html = readPage(f);
        if (html === null) continue;
        const hits = sharedBadgeSymbolHits(html);
        if (hits.length) trespass.push(`${f}：${hits.join('；')}`);
    }
    check(trespass.length === 0,
        `${tiers.T3.length} 个未迁移页均未使用共享徽章符号（未引 components.css 就用 = 徽章裸奔成无样式文本）`,
        trespass.length ? `${trespass.length} 页越界：${trespass.join(' | ')} —— 这些页没有 <link> components.css，`
            + '写了共享徽章类也匹配不到任何规则。要用就先引共享层并登记进 PAGE_ALIAS_SPECS' : '');
}

function assertSemTokensOnlyInSharedLayer() {
    const offenders = [];
    // `--sem-xxx:` 是定义；`var(--sem-xxx)` 是引用。用负向后顾排除 var( 场景后再看是否跟冒号。
    const defRe = /--sem-[\w-]+\s*:/g;

    const styleCss = readFileOrNull(path.join(PUBLIC_DIR, 'assets', 'css', 'style.css'));
    if (styleCss !== null) {
        const hits = (stripCssComments(styleCss).match(defRe) || []);
        if (hits.length) offenders.push(`assets/css/style.css（${hits.length} 处：${[...new Set(hits)].slice(0, 4).join(' ')}）`);
    }

    // LOW-9：扫描面从 spec 派生——S3 收编的 PF/MC 也该被这条管住，不能只扫"迁移页"
    // 〔S5b〕再扩到全 19 页：**未迁移页私自定义 --sem-* 的危害比迁移页更大**——它一样能污染
    //   色板真相源（同名 token 被就近重定义），却因为不在任何 spec 里而完全没人看。
    //   这里刻意不按分级区别对待：色板是全站唯一真相源，"哪一级的页面"不构成重定义它的理由。
    for (const pageFile of ALL_PAGES) {
        const html = readPage(pageFile);
        if (html === null) continue;
        const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
        const hits = (stripCssComments(styleBlocks.join('\n')).match(defRe) || []);
        if (hits.length) offenders.push(`${pageFile} 内联 <style>（${hits.length} 处：${[...new Set(hits)].slice(0, 4).join(' ')}）`);
    }

    check(offenders.length === 0,
        `components.css 之外不得定义 --sem-* token（扫 style.css + 全站 ${ALL_PAGES.length} 个页面内联 <style>）`,
        offenders.length ? `${offenders.length} 处越界定义（引用 var(--sem-*) 不算，这些是重新赋值）：${offenders.join('；')}` : '');
}

// ── 断言⑦ WCAG 对比度 ──────────
// WCAG 2.x 相对亮度：先做 sRGB 反伽马，再按 0.2126/0.7152/0.0722 加权。
function relativeLuminance(hex) {
    const h = String(hex).trim().replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    const lin = [0, 2, 4].map((i) => {
        const c = parseInt(full.substr(i, 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrastRatio(hexA, hexB) {
    const la = relativeLuminance(hexA);
    const lb = relativeLuminance(hexB);
    if (la === null || lb === null) return null;
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
}

function assertContrast(tokens) {
    if (!tokens) return;
    const textFailures = [];
    const dotWarnings = [];
    const unparsable = [];
    const table = [];

    for (const tier of SEM_TIERS) {
        const bg = tokens[`${tier}-bg`];
        const fg = tokens[`${tier}-fg`];
        const dot = tokens[`${tier}-dot`];
        const exempt = CONTRAST_EXEMPT.includes(tier);
        const cText = contrastRatio(fg, bg);
        const cDot = contrastRatio(dot, bg);
        if (cText === null || cDot === null) {
            unparsable.push(`${tier}（fg=${fg} bg=${bg} dot=${dot}）`);
            continue;
        }
        table.push({ tier, cText, cDot, exempt });
        if (!exempt && cText < CONTRAST_TEXT_MIN) {
            textFailures.push(`${tier} fg/bg=${cText.toFixed(2)}:1 < ${CONTRAST_TEXT_MIN}`);
        }
        if (cDot < CONTRAST_DOT_MIN) {
            dotWarnings.push(`${tier} dot/bg=${cDot.toFixed(2)}:1`);
        }
    }

    // 实测值表（永远打印，便于改色时肉眼看余量，不只在失败时才有信息）
    console.log('  ── WCAG 对比度实测（fg/bg 硬线 ≥4.5:1，dot/bg 警示线 ≥3:1）──');
    for (const r of table) {
        const textMark = r.exempt ? '豁免' : (r.cText >= CONTRAST_TEXT_MIN ? 'PASS' : 'FAIL');
        const dotMark = r.cDot >= CONTRAST_DOT_MIN ? 'ok' : 'warn';
        console.log(`     ${r.tier.padEnd(9)} fg/bg ${r.cText.toFixed(2).padStart(5)}:1 ${textMark.padEnd(5)}  dot/bg ${r.cDot.toFixed(2).padStart(5)}:1 ${dotMark}`);
    }

    check(unparsable.length === 0, 'components.css：全部语义层色值可解析为 6 位十六进制',
        unparsable.length ? `${unparsable.length} 层解析失败：${unparsable.join(' | ')}` : '');

    check(textFailures.length === 0,
        `components.css：非豁免层 fg/bg 对比度均 ≥ ${CONTRAST_TEXT_MIN}:1（豁免层：${CONTRAST_EXEMPT.join('/')}）`,
        textFailures.length ? `${textFailures.length} 层未达标：${textFailures.join(' | ')}（改色或经用户拍板进豁免表二选一）` : '');

    if (dotWarnings.length) {
        console.log(`  [WARN] ${dotWarnings.length} 层色点对比度 < ${CONTRAST_DOT_MIN}:1（警示级不阻断——色点是冗余通道，文字已达标）：${dotWarnings.join(' | ')}`);
    }
}

// 按花括号配对抽出具名函数的完整源码（含函数头）。扫描时跳过字符串字面量与注释，
//   所以函数体里的 `'<span class="u-status-badge">'`、`// 注释里的 }` 都不会干扰配对。
//   与"找收尾 } 的正则"相比，本法不依赖任何缩进/格式约定，也不会在格式漂移时跑过头咬到下一个函数。
//   已知边界：不识别正则字面量（如 /\}/）内的花括号——本文件此函数内无正则字面量；
//   若将来在函数体内写含花括号的正则，需在此补状态机分支（届时表现为提取异常=红灯，不会静默）。
// 返回 '' 表示未找到函数、或花括号一路不平衡到文件末尾；若函数自身少一个 }，配对会一直吃到外层
//   （如 IIFE）的收尾括号而返回一段**越界**源码——这种情况由调用方的"越界哨兵"断言兜（见断言⑧）。
function extractFunctionSource(js, fnName) {
    const declRe = new RegExp('function\\s+' + escapeRegExp(fnName) + '\\s*\\(');
    const m = declRe.exec(js);
    if (!m) return '';
    const start = m.index;
    let i = js.indexOf('{', m.index + m[0].length - 1);
    if (i === -1) return '';

    let depth = 0;
    let quote = null;       // 当前所在字符串的引号字符
    let inLineComment = false;
    let inBlockComment = false;

    for (; i < js.length; i++) {
        const c = js[i];
        const n = js[i + 1];
        if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
        if (inBlockComment) { if (c === '*' && n === '/') { inBlockComment = false; i++; } continue; }
        if (quote) {
            if (c === '\\') { i++; continue; }        // 跳过转义字符
            if (c === quote) quote = null;
            continue;
        }
        if (c === '/' && n === '/') { inLineComment = true; i++; continue; }
        if (c === '/' && n === '*') { inBlockComment = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
        if (c === '{') { depth++; continue; }
        if (c === '}') {
            depth--;
            if (depth === 0) return js.slice(start, i + 1);
        }
    }
    return '';
}

// ── 断言⑧ statusBadgeByMap 行为形态 ──────────
// 函数存在性 / 导出 / 函数体可提取且未越界，已由断言③逐函数统一验过（预筛 M4 后合并，避免重复断言）。
// 本函数只管 byMap **独有的白名单行为**：未命中降级形态 + warn 留痕 + 不得直拼原值。
// 三条全部在**函数体内**判定不扫全文件（预筛 LOW-2）：扫全文件会让"别处碰巧有一条
//   <span class="u-status-badge">"把本函数的兜底断言喂绿。
// 提取用花括号配对（extractFunctionSource），不用正则边界（预筛 LOW-1 的实修）：
//   原写法 /function\s+statusBadgeByMap[\s\S]*?\n {2}\}/ 依赖"收尾 } 缩进恰为 2 空格"。
//   实测把收尾缩进改成 tab 后，非贪婪匹配并不会落空，而是**跑过头**咬到下一个 2 空格 `}`
//   （即 typeTag() 的收尾），抓出 916 字符的越界 body——三条子断言在这段越界文本里照样全命中，
//   守卫静默失效且总数不变，比"提取失败"更隐蔽。故只加 body.length>0 兜底救不了，必须换提取方式。
function assertStatusBadgeByMapShape(helperJs) {
    const body = extractFunctionSource(helperJs, 'statusBadgeByMap');
    const runaway = body.length > 0 && /\bfunction\s+(?!statusBadgeByMap\b)\w+\s*\(/.test(body);
    if (!body.length || runaway) return;   // 断言③已就此报红，这里不重复计数

    // 未命中分支必须输出"无修饰类"的裸 base，且必须 warn 留痕。
    const hasBareFallback = /<span class="u-status-badge">/.test(body);
    check(hasBareFallback, 'unify-helpers.js：statusBadgeByMap 未命中时退化为无修饰类 u-status-badge',
        hasBareFallback ? '' : '函数体内未找到无修饰类兜底输出，未命中可能仍在拼原值');

    // 告警留痕：允许直接 console.warn，也允许委托给 warnBadgeOnce（A-L1 去重）。
    //   但**不能只认"调用了某个名字像告警的函数"就放行**——那等于把断言改成"改名即可绕过"。
    //   委托路径必须连着验：warnBadgeOnce 自己的函数体里得真有 console.warn。
    const warnsDirect = /console\.warn/.test(body);
    const delegates = /warnBadgeOnce\s*\(/.test(body);
    let delegateOk = false;
    if (delegates) {
        const helperBody = extractFunctionSource(helperJs, 'warnBadgeOnce');
        delegateOk = helperBody.length > 0 && /console\.warn/.test(helperBody);
    }
    check(warnsDirect || delegateOk, 'unify-helpers.js：statusBadgeByMap 未命中时留痕告警（直接 warn 或经 warnBadgeOnce 委托）',
        delegates && !delegateOk
            ? 'statusBadgeByMap 委托给了 warnBadgeOnce，但后者函数体里查不到 console.warn —— 委托链断了，等于静默降级'
            : '未命中静默降级会让"后端加了状态、前端忘了加 map 条目"永远发现不了');

    // 去重机制本身也要有（A-L1）：列表几十行同一未知状态刷屏，会把真正有用的那一条淹掉。
    const helperBody = extractFunctionSource(helperJs, 'warnBadgeOnce');
    const dedupOk = helperBody.length > 0 && /\.has\(/.test(helperBody) && /\.add\(/.test(helperBody);
    check(dedupOk, 'unify-helpers.js：warnBadgeOnce 具备去重（Set has/add）',
        dedupOk ? '' : '未找到 Set 去重逻辑——同一未知状态会按渲染行数刷屏');

    // 反向：函数体内不得出现"把 status 原值直接拼进 class"的写法。
    // ⚠️ 上一版只认紧贴形态（`u-status-badge' + status`），漏掉带前缀的 `u-status-badge s-' + status`
    //    ——而后者恰恰是本函数要防的主形态（六别名页的 class 就是 s-/si-s-/status- 前缀 + 原值）。
    //    改为「u-status-badge 与引号之间允许任意非引号字符」，把带前缀写法一并罩住。
    //    对现行正确代码零误报：命中需要 `+ status`，而正确代码拼的是 `+ frag` / `+ w.escapeHtml(label)`。
    const rawConcat = /u-status-badge[^'"]*['"]\s*\+\s*status\b/.test(body)
        || /u-status-badge[^`$]*\$\{\s*status\b/.test(body);
    check(!rawConcat, 'unify-helpers.js：statusBadgeByMap 未把 status 原值直接拼进 class',
        rawConcat ? '函数体内发现 status 原值直拼 class 的写法，白名单被架空' : '');
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
    assertNoNulBytes();
    assertComponentsCssNoBareOldNames(componentsCss);
    // 〔S5b〕全站分级先算出来：下面的越界断言按级施加，报告里也要把归属打出来
    const pageTiers = classifyPages();
    assertComponentsCssRootClassesArePrefixed(componentsCss);
    assertLegacyStyleCssBadgeRetirement();
    assertLegacyBaseConsumersIntact();
    console.log('');

    console.log('--- 状态徽章语义色板（断言④⑤⑥⑦）---');
    const semDecls = extractSemTokenDecls(componentsCss);
    const semTokens = tokensFromDecls(semDecls);
    const { rules: semRules, anomalies: semAnomalies } = extractSemRules(componentsCss);
    assertSingleRootBlock(componentsCss);
    assertSemTokensComplete(semDecls);
    assertSemClassesComplete(semRules, semAnomalies);
    assertShapeContractPairs(semRules, semTokens);
    assertSemDefsConfinedToRoot(componentsCss);
    assertSemTokensOnlyInSharedLayer();
    assertContrast(semTokens);
    console.log('');

    console.log('--- unify-helpers.js 前置检查（断言③⑧）---');
    const helperJs = readFileOrNull(UNIFY_HELPERS_JS);
    check(helperJs !== null, `unify-helpers.js 存在于 assets/js/`, helperJs === null ? `未找到 ${UNIFY_HELPERS_JS}` : '');
    if (helperJs !== null) {
        assertHelperOutputsUnifiedClasses(helperJs);
        assertStatusBadgeByMapShape(helperJs);
    }
    console.log('');

    // ── 〔S5b〕全站 19 页分级扫描（断言⑰）──────────
    console.log(`--- 全站分级扫描（断言⑰·${ALL_PAGES.length} 页）---`);
    console.log(`  T1 徽章 spec 页（全量断言·${pageTiers.T1.length}）：${pageTiers.T1.join('、')}`);
    console.log(`  T2 引共享层的非徽章页（共享层断言·${pageTiers.T2.length}）：${pageTiers.T2.join('、') || '(无)'}`);
    console.log(`  T3 未迁移页（只断言不越界·${pageTiers.T3.length}）：${pageTiers.T3.join('、') || '(无)'}`);
    assertPageTierCoverage(pageTiers);
    console.log('');

    console.log(`待校验迁移页（${MIGRATED_PAGES.length} 个）：${MIGRATED_PAGES.join('、')}\n`);

    // ── 〔N5-fix〕剥注释检测器·**两向对照组自证**（先证判据两边都真在动，再谈它绿）──────────
    console.log('--- 剥注释先行：检测器两向对照组 ---');
    assertStripCommentsSelfTest(check);
    console.log('');

    for (const pageFile of MIGRATED_PAGES) {
        console.log(`--- ${pageFile} ---`);
        const html = readPage(pageFile);
        check(html !== null, `${pageFile}：文件存在于 public/`, html === null ? `未找到 ${path.join(PUBLIC_DIR, pageFile)}` : '');
        if (html === null) continue;

        assertBodyUnifiedClass(pageFile, html);
        assertNoBareSharedSelectors(pageFile, html);
        console.log('');
    }

    // ── S2 页面层断言（⑨-⑫，实现在 verify-badge-alias.js，并入本流程统一计数）──────────
    console.log('=== 状态徽章统一 S2 · 六别名页接线断言（verify-badge-alias.js）===\n');
    runBadgeAliasAssertions(check);

    console.log(`=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
    if (fail > 0) {
        console.log('\n失败明细：');
        failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}${f.detail ? ' — ' + f.detail : ''}`));
    }
    process.exit(fail === 0 ? 0 : 1);
})();
