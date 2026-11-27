// 信息化资产主题色值静态检查（#200 C1a 起，C1c 精简；方案 v1.5 第四-B 节；只读源码、不起服务）。
//
// 威胁模型（一句话）：只证明「诚实实现写错时会判红」——拼错变量名、漏改映射、挪错作用域、合并冲突带进旧值、新增浮层忘了登记；
//   不防故意绕开守卫的写法，也不做格式容忍。每条保留的检查都是「从源码取一份清单或数值 → 与手写字面量全等」，清单一变即判红、交人核对。
// 写法约束：不写 CSS 解析器、不用 AST。唯一的切分是去注释后用 /([^{}]+)\{([^{}]*)\}/g 取「最内层规则体」（selector + body），body 按 ; 切成 prop: value，只用来列清单。
//
// 检查项（与下方代码段注释的编号一致）：
//   1. 切分完整性硬门 + 颜色字面量。①删之前：每个最内层匹配的规则头（selector 文本，含前面粘连的语句）里不许出现 @（期望清单 = []）——挡住顶部的 @import 语句（会连同紧随其后的选择器被当成一条普通规则）与 @font-face
//      这类没有内层花括号的块。②去注释后把全部最内层匹配删掉，剩下的文本只许是手写外壳清单（当前只有 @media(…){ } 一种）：挡住缺一个 }（合并冲突，后一条规则会吞掉前一条的声明）、CSS 嵌套（外层 selector{ } 残留）、
//      顶层多余的 }、@supports / @layer 等带嵌套规则的块——这些写法会让下面所有按规则体取清单的检查静默失真，残留一律判红交人核对；不解析、不做配平。
//      ③两份模块 CSS（it-ledger.css / it-ledger-theme.css）里，十六进制色与 rgb( / rgba( / hsl( / hsla( 字面量只许出现在自定义属性（--*）声明里，其余属性的值里不得出现这些字面量（具名颜色等见残余）。
//   2. 作用域清单全等：--color-* / --sem-* / --itl-control-border 声明所在规则的选择器，在主题文件里去重后恰好是 [THEMED_SELECTOR]；it-ledger.css 里 --color-* 声明所在规则的选择器去重后恰好是
//      [六个容器用逗号相连的裸容器选择器]；9 个钉死的 --itl-*（ITL_EXPECTED）在两份文件里的（文件 | 名字 | 选择器）声明清单与手写清单全等（当前 = 主题文件 body.itl-theme 上的 9 条，基础样式里没有）；
//      基础样式里不得有 --sem-* 声明；两份文件都不得有 --sb-* 声明。
//   3. 方案 3.2 的 12 个颜色变量、3.3 的 24 个 sem 变量、body.itl-theme 上 9 个 --itl-* 的值钉死（手写字面量表）：每个变量在主题文件里恰好出现 1 次声明、值全等、不带 !important；另外主题文件里所有 --sem-* 声明名（去重、排序）= 这 24 个钉死名；body.itl-theme 上的 background 声明恰好 1 次且值全等 var(--itl-page-bg)。
//   4. 两份文件里自定义属性声明都不带 !important。
//   5. var(--itl-*)（无回退值的引用）都有定义：引用名集合 − 定义名集合 − JS_INJECTED = []（大小写敏感）。
//   6. 挂在 body 下的写法：对每个 it-ledger*.js 用宽口径正则统计「指向 body 元素」的写法次数，与手写清单（文件 → 次数）全等；另有手写的已知浮层类名表，类名字面量必须还在对应文件里、且在 CONTAINERS 里。
//   7. 状态映射表：expiryClasses / statusClasses / resultClasses 的初始化文本（到第一个 }; 为止，空白压成一个空格）与手写期望串全等；这三个标识符在各文件里的出现次数与手写清单（文件:标识符 → 次数）两向全等——实际出现的都在清单里、清单里的每一项都必须在实际文件里找得到，且清单项的标识符必须属于这三个名字之一（否则该项永远不被比较，直接判红）。
//   8. 禁用名：sem-intake / sem-special，旧文件名 it-ledger-plan-b.css 与类名 itl-plan-b，在模块 JS / HTML / CSS 里出现 0 次；assets/css 文件清单里新主题文件存在、旧 plan-b 文件不存在。
//   9. IT_Ledger.html（先去掉 <!-- … --> 注释再提取 <link> 与 <body>，被注释掉的 link 不计）：link 顺序（it-ledger.css 在前、it-ledger-theme.css 在后，均带 ?v=auto）与 <body class="unified-page itl-theme">；扫描面清单全等：assets/css 下 it-ledger*.css 文件名清单 = 当前两份，
//      页面里全部 stylesheet link 的 href（去掉 ?v= 查询串、按页面顺序）= 当前四条（style.css / components.css / it-ledger.css / it-ledger-theme.css）——第三份样式文件不会悄悄绕过上面的色值 / 阴影 / 字号检查。
//  10. 桌面字号：两份 CSS 里所有 font-size px 字面量，五档（12 / 13 / 14 / 16 / 24）以外的「值 → 次数」与手写表全等（手写表 = 窄屏媒体查询里那几条五档外字号，不再区分桌面 / 窄屏上下文）；font 简写的值只许 inherit / initial / unset / revert / revert-layer。
//  11. 两份 CSS 去注释后不含 gradient（不分大小写）。
//  12. 阴影清单：值非 none 的 box-shadow / text-shadow 声明、含 drop-shadow( 的声明，列成 `selector | prop: value` 与手写清单（5 个浮层）全等。
//  13. 字号基线：主题文件里两条零特异性 :where 基线规则——取主题文件全部最内层规则，每条压缩空白后的完整文本「selector { decls }」与期望文本逐条全等，各恰好 1 次（不是子串：选择器前后加字符不算命中）。
// 必带对照组：每条保留规则，真实文件判绿（即上面的检查本身）；向真实文件内存副本注入一处违规判红（注入方式六种：替换锚点 / 锚点后追加 / 文件头前置 / 文件尾追加 / 清单去文件 / 清单加文件；其中替换、锚点后追加都要求原文串恰好出现一次，找不到或多于一次本脚本判红）。
// 源码读取时先把 CRLF 换成 LF（线 worktree 由 git 按 autocrlf 检出为 CRLF）。
// 残余（登记，不处理）：具名颜色（如 color:red）；hwb() / lab() / lch() / oklab() / oklch() / color-mix() / light-dark() / color() 等其他颜色函数；非 px 单位的 font-size（em / rem / 关键字）；
//   写在 @media / @supports / @layer 等条件块里的钉死变量或基线规则（不再检查是否在条件块内）；映射表初始化之后的写操作（只剩出现次数清单兜底，同次数内把读取点改成写入看不见）；
//   窄屏字号的具体位置（只留五档外「值 → 次数」）；CSS 里字符串含花括号或分号（切分会错位）；格式改写（换行 / 压缩 / 空白变体）导致的漏判或误判；
//   JS 里 style.setProperty('--sem…') 与动态拼出的 body 写法；容器外元素使用 var(--itl-control-border)；it-ledger.css 里 --color-* 的取值（只钉所在选择器，不钉值）；
//   切分完整性硬门只认 @media 一种外壳，未来合法新增别的 at-rule 块（或 @media screen and (…) 这类不以 @media( 开头的写法）会判红，需人改 SHELL_RE；源码里留空的 @media(…){ } 外壳（里面没有规则）本身是最内层匹配，按「规则头含 @」判红，需人删掉空壳；
//   新增浮层复用已有挂载入口或已有的 body 引用时，引用次数与浮层类名清单都可能不变，会漏报；
//   经 var() / clamp() 等得到的 px 字号不进静态计数（浏览器字号扫描只覆盖手写的视图清单）；
//   浏览器真实打开证据查看器的检查在 verify-it-ledger-theme-computed-browser.js。
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert/strict');

const publicRoot = path.resolve(__dirname, '../public');
const cssDir = path.join(publicRoot, 'assets/css'), jsDir = path.join(publicRoot, 'assets/js');
const BASE_CSS = 'it-ledger.css', THEME_CSS = 'it-ledger-theme.css';
const CONTAINERS = ['.itl-workbench', '.itl-modal', '.itl-rack-overlay', '.itl-hardware-overlay', '.itl-evidence-viewer', '.itl-toast'];
const SEM_GROUPS = ['active', 'done', 'staging', 'archived'], SEM_PARTS = ['bg', 'fg', 'bd', 'bds', 'dot', 'deco'];
// 方案 v1.4 3.3：四组覆盖（手写字面量表）
const SEM_EXPECTED = {
  active:   { bg: '#ebedee', fg: '#353736', bd: '#ebedee', bds: 'solid', dot: '#8a8d90', deco: 'none' },
  done:     { bg: '#ebedee', fg: '#353736', bd: '#ebedee', bds: 'solid', dot: '#8a8d90', deco: 'none' },
  staging:  { bg: '#ffffff', fg: '#353736', bd: '#cdced1', bds: 'solid', dot: '#9a9da0', deco: 'none' },
  archived: { bg: '#f4f6f8', fg: '#5d5f60', bd: '#cdced1', bds: 'dashed', dot: '#9a9da0', deco: 'none' }
};
// 方案 v1.4 3.2：颜色变量（模块容器上）
const COLOR_EXPECTED = {
  '--color-bg-page': '#eef2f5', '--color-bg-card': '#ffffff', '--color-bg-elevated': '#f4f6f8',
  '--color-text-primary': '#131416', '--color-text-secondary': '#5d5f60', '--color-text-muted': '#6b6b6b',
  '--color-border': '#e8eaec', '--color-border-subtle': '#f0f1f2', '--itl-control-border': '#cdced1',
  '--color-accent': '#1b6c80', '--color-accent-hover': '#155a6b', '--color-accent-soft': '#e4eff2'
};
// 方案 v1.4 3.1 / 3.2：body.itl-theme 上的 --itl-*
const ITL_EXPECTED = {
  '--itl-page-bg': '#eef2f5', '--itl-nav-active-bg': '#e1e7ec', '--itl-primary': '#1d1f20', '--itl-primary-hover': '#000000',
  '--itl-rack-device-bg': '#e4eff2', '--itl-rack-device-border': '#c3dbe2',
  '--itl-slot-ok': '#1b6c80', '--itl-slot-warn': '#a86f0c', '--itl-slot-bad': '#c4242a'
};
const JS_INJECTED = new Set(['--itl-type', '--itl-overview-height', '--itl-overview-step', '--itl-u-k']); // 由 it-ledger-racks.js 内联 style 注入
// --itl-metric-cols（巡检详情指标条内联注入）不登记：CSS 里只有带回退值的引用 var(--itl-metric-cols,5)，检查 5 只抓不带回退值的引用，登记反而放宽放行集合（C0b 复看 L-new-1）。
const THEMED_SELECTOR = '.itl-theme :is(' + CONTAINERS.join(',') + ')';
const BASE_CONTAINER_SELECTOR = CONTAINERS.join(','); // it-ledger.css 里 --color-* 默认值所在的裸容器选择器（与预筛取值 `.itl-workbench,.itl-modal,.itl-rack-overlay,.itl-hardware-overlay,.itl-evidence-viewer,.itl-toast` 一致）

const normalize = t => t.replace(/\r\n/g, '\n');
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const squash = s => s.replace(/\s+/g, ' ').trim();
const count = (text, needle) => text.split(needle).length - 1;
// 注入：原文串必须恰好出现一次，找不到或多于一次都抛错（脚本判红）
const mutateOnce = (text, from, to, what) => { const n = count(text, from); assert.equal(n, 1, 'mutation anchor must occur exactly once (' + what + '): found ' + n); return text.replace(from, () => to); };
// 多重集全等：多一条、少一条都报出来
function listDiff(actual, expected, what) {
  const bad = [], left = [...expected].sort();
  for (const x of [...actual].sort()) { const i = left.indexOf(x); if (i < 0) bad.push(`${what}: not in the hand-written list: ${x}`); else left.splice(i, 1); }
  for (const x of left) bad.push(`${what}: in the hand-written list but missing / changed in the files: ${x}`);
  return bad;
}
// 「值 → 次数」表全等
function tableDiff(actual, expected, what) {
  const bad = [];
  for (const k of new Set([...Object.keys(actual), ...Object.keys(expected)])) if ((actual[k] || 0) !== (expected[k] || 0)) bad.push(`${what}: ${k} appears ${actual[k] || 0} times, list says ${expected[k] || 0}`);
  return bad;
}

// ---- 最内层规则体：去注释后取 selector { body }，body 按 ; 切成 prop: value；只用来列清单，不做配平校验 ----
function innerRules(cssText) {
  const css = stripComments(normalize(cssText)), out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = m[2].split(';').map(s => { const i = s.indexOf(':'); return i > 0 ? { prop: s.slice(0, i).trim(), value: s.slice(i + 1).trim() } : null; }).filter(Boolean);
    out.push({ selector: squash(m[1]), decls });
  }
  return out;
}

// ---- 切分完整性硬门（不解析）：去注释后把全部最内层匹配删掉，剩下的文本只许由手写外壳清单组成。
// 手写外壳清单（当前两份文件的全部外壳）：`@media(…){ }` 一种——条件块被删空后只剩它的开头与结尾。
// 它挡住的是 innerRules 的静默失真：缺一个 }（合并冲突）会让后一条规则的 selector 吞掉前一条的声明、前一条的开头残留在剩余文本里；
// CSS 嵌套（外层规则里套内层规则）删掉内层后，外层的 `selector{ }` 残留；顶层多出来的 } 或 @supports / @layer 等带嵌套规则的块同理。残留一律判红，交人核对。
// 第二道（删之前）：每个最内层匹配的规则头（selector 文本，含前面粘连的语句）里不许出现 @——挡住顶部的 @import 语句（它会连同紧随其后的选择器被当成一条普通规则删掉）和 @font-face 这类没有内层花括号的块
// （它们本身就是一个最内层匹配）。期望清单 = []（两份文件当前实测为空）；有内层规则的 @media 外壳不是最内层匹配，由 SHELL_RE 单独放行。
// 注意：源码里留空的 `@media(…){ }`（里面没有任何规则）本身就是一个最内层匹配，规则头含 @，会按这一道判红——需人删掉空壳，不是误报。
const SHELL_RE = /@media\s*\([^{}]*\)\s*\{\s*\}/g;
function shellViolations(cssText, label) {
  const css = stripComments(normalize(cssText)), bad = [];
  for (const h of atRuleHeads(css)) bad.push(`${label}: at-rule head inside an innermost rule: "${h.slice(0, 80)}" (@import / @font-face / any @ statement or block that is not an @media shell)`);
  const rest = squash(css.replace(/([^{}]+)\{([^{}]*)\}/g, '').replace(SHELL_RE, ''));
  if (rest) bad.push(`${label}: text left after removing every innermost rule and every @media shell: "${rest.slice(0, 80)}" (missing / stray brace or nested rule)`);
  return bad;
}
const atRuleHeads = css => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => squash(m[1])).filter(h => h.includes('@'));

// ---- 检查 1：颜色字面量只许在自定义属性声明里 ----
const HEX = /#[0-9a-fA-F]{3,8}\b/, COLOR_FN = /(?<![\w-])(?:rgba?|hsla?)\(/i;
function colorViolations(cssText, label) {
  const bad = [];
  for (const r of innerRules(cssText)) for (const d of r.decls) {
    if (d.prop.startsWith('--')) continue;
    if (HEX.test(d.value) || COLOR_FN.test(d.value)) bad.push(`${label}: ${r.selector.slice(-60)} { ${d.prop}: ${d.value.slice(0, 60)} }`);
  }
  return bad;
}

// ---- 检查 2：--color-* / --sem-* / --itl-control-border / --sb-* 与九个钉死的 --itl-* 的作用域 ----
function scopeViolations(baseCss, themeCss) {
  const bad = [];
  const selectorsOf = (css, test) => [...new Set(innerRules(css).filter(r => r.decls.some(d => test(d.prop))).map(r => r.selector))];
  const themed = selectorsOf(themeCss, p => /^--(color|sem)-|^--itl-control-border$/.test(p));
  if (JSON.stringify(themed) !== JSON.stringify([THEMED_SELECTOR])) bad.push(`${THEME_CSS}: --color-* / --sem-* / --itl-control-border are declared on ${JSON.stringify(themed)}, expected exactly [${JSON.stringify(THEMED_SELECTOR)}]`);
  // 基础样式里的 --color-* 只许在裸容器选择器（六个容器，逗号相连）上
  const baseColor = selectorsOf(baseCss, p => /^--color-/.test(p));
  if (JSON.stringify(baseColor) !== JSON.stringify([BASE_CONTAINER_SELECTOR])) bad.push(`${BASE_CSS}: --color-* are declared on ${JSON.stringify(baseColor)}, expected exactly [${JSON.stringify(BASE_CONTAINER_SELECTOR)}]`);
  // 9 个钉死的 --itl-*（ITL_EXPECTED）：两份文件里的（文件 | 名字 | 选择器）声明清单与手写清单全等（当前只有主题文件的 body.itl-theme，基础样式里一条都没有；基础样式后代选择器上的同名局部覆盖会多出一行）
  const itlNames = Object.keys(ITL_EXPECTED), itlDecls = [];
  for (const [label, css] of [[BASE_CSS, baseCss], [THEME_CSS, themeCss]]) for (const r of innerRules(css)) for (const d of r.decls) if (itlNames.includes(d.prop)) itlDecls.push(`${label} | ${d.prop} | ${r.selector}`);
  bad.push(...listDiff(itlDecls, itlNames.map(n => `${THEME_CSS} | ${n} | body.itl-theme`), 'pinned --itl-* declarations'));
  for (const [label, css] of [[BASE_CSS, baseCss], [THEME_CSS, themeCss]]) for (const r of innerRules(css)) for (const d of r.decls) {
    if (d.prop.startsWith('--sb-')) bad.push(`${label}: ${d.prop} declared in "${r.selector.slice(-50)}" (--sb-* belongs to the shared layer)`);
    if (label === BASE_CSS && d.prop.startsWith('--sem-')) bad.push(`${label}: ${d.prop} declared in "${r.selector.slice(-50)}" (sem groups are overridden in the theme file only)`);
  }
  return bad;
}

// ---- 检查 3：钉死变量的值；检查 4：自定义属性不带 !important ----
function pinnedEntries() {
  const out = [];
  for (const g of SEM_GROUPS) for (const p of SEM_PARTS) out.push([`--sem-${g}-${p}`, SEM_EXPECTED[g][p]]);
  return out.concat(Object.entries(COLOR_EXPECTED), Object.entries(ITL_EXPECTED));
}
function pinnedViolations(themeCss) {
  const text = stripComments(normalize(themeCss)), bad = [];
  // 清单全等：主题文件里所有 --sem-* 声明的名字（去重、排序）= 24 个钉死名（由 SEM_EXPECTED 生成）
  const declaredSem = [...new Set([...text.matchAll(/(?<![\w-])(--sem-[\w-]+)\s*:/g)].map(m => m[1]))].sort();
  bad.push(...listDiff(declaredSem, pinnedEntries().map(e => e[0]).filter(n => n.startsWith('--sem-')), 'sem declarations'));
  for (const [name, expected] of pinnedEntries()) {
    const found = [...text.matchAll(new RegExp('(?<![\\w-])' + name + '\\s*:\\s*([^;}]+)', 'g'))].map(m => m[1].trim());
    if (found.length !== 1) { bad.push(`${name} declared ${found.length} times (pinned variables must be declared exactly once)`); continue; }
    if (/!\s*important/i.test(found[0])) bad.push(`${name} declared with !important`);
    else if (found[0] !== expected) bad.push(`${name} = ${found[0]} (expected ${expected})`);
  }
  // body.itl-theme 上的 background 声明恰好 1 次，值全等 var(--itl-page-bg)
  const bodyBg = innerRules(themeCss).filter(r => r.selector === 'body.itl-theme').flatMap(r => r.decls).filter(d => d.prop === 'background').map(d => d.value);
  if (JSON.stringify(bodyBg) !== JSON.stringify(['var(--itl-page-bg)'])) bad.push(`body.itl-theme background declarations are ${JSON.stringify(bodyBg)}, expected exactly ["var(--itl-page-bg)"]`);
  return bad;
}
function importantViolations(cssText, label) {
  return [...stripComments(normalize(cssText)).matchAll(/--[\w-]+\s*:[^;}]*!important/g)].map(m => `${label}: custom property with !important: ${m[0].slice(0, 60)}`);
}

// ---- 检查 5：悬空的 --itl-* 引用（无回退值的引用；大小写敏感） ----
function danglingViolations(...cssTexts) {
  const all = cssTexts.map(t => stripComments(normalize(t))), defined = new Set(JS_INJECTED);
  for (const t of all) for (const m of t.matchAll(/(--itl-[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1]);
  const bad = [];
  for (const t of all) for (const m of t.matchAll(/var\(\s*(--itl-[A-Za-z0-9_-]+)\s*\)/g)) if (!defined.has(m[1])) bad.push(`var(${m[1]}) has no definition`);
  return bad;
}

// ---- 检查 6：挂在 body 下的写法 —— 次数清单硬门（清单变化即判红交人核对，不做逐调用分类推理） ----
// 宽口径：只要「指向 body 元素」的写法都计数（注释里出现也计）。window.document.body 被第一条覆盖。
const BODY_PATTERNS = [
  /document\s*(?:\?\.|\.)\s*body\b/g,
  /document\s*\[\s*['"]body['"]\s*\]/g,
  /querySelector(?:All)?\s*\(\s*['"]\s*body\b/g,
  /getElementsByTagName\s*\(\s*['"]body/g,
  /\{[^}]*\bbody\b[^}]*\}\s*=\s*(?:window\s*\.\s*)?document\b/g
];
const bodyRefCount = text => BODY_PATTERNS.reduce((sum, re) => sum + (text.match(re) || []).length, 0);
// 手写清单：文件 → 次数。disks:17 evidence:23 + :27(MutationObserver.observe) export-layout:31(隐藏下载链接) inspection-sheets(巡检照片查看器) racks:48 reconciles:64(隐藏下载链接)
const BODY_REF_EXPECTED = { 'it-ledger-disks.js': 1, 'it-ledger-evidence.js': 2, 'it-ledger-export-layout.js': 1, 'it-ledger-inspection-sheets.js': 1, 'it-ledger-racks.js': 1, 'it-ledger-reconciles.js': 1 };
// 已知浮层类名表（手写）：这些文件各自创建一个挂 body 的浮层，类名必须在 CONTAINERS 里（主题选择器由检查 2 钉死为 CONTAINERS 的完整列表）
const OVERLAY_CLASSES = { 'it-ledger-racks.js': 'itl-rack-overlay', 'it-ledger-disks.js': 'itl-hardware-overlay', 'it-ledger-evidence.js': 'itl-evidence-viewer', 'it-ledger-inspection-sheets.js': 'itl-evidence-viewer' };
const BODY_HINT = '挂在 body 下的写法变了：核对新浮层的类名已加进主题 CSS 的模块容器名单与本脚本 CONTAINERS，再更新本清单';
function bodyMountViolations(files /* [{name,text}] */) {
  const bad = [];
  for (const f of files) {
    const got = bodyRefCount(f.text), want = BODY_REF_EXPECTED[f.name] || 0;
    if (got !== want) bad.push(`${f.name}: body references ${got}, list says ${want} — ${BODY_HINT}`);
  }
  for (const name of Object.keys(BODY_REF_EXPECTED)) if (!files.some(f => f.name === name)) bad.push(`${name}: listed in the body-reference table but not found among module scripts`);
  return bad;
}
function overlayClassViolations(files) {
  const bad = [];
  for (const [file, cls] of Object.entries(OVERLAY_CLASSES)) {
    const f = files.find(x => x.name === file);
    if (!f) { bad.push(`${file}: overlay file missing`); continue; }
    if (!new RegExp('(?<![\\w-])' + cls + '(?![\\w-])').test(f.text)) bad.push(`${file}: overlay class literal "${cls}" no longer appears in the file`);
    if (!CONTAINERS.includes('.' + cls)) bad.push(`${file}: "${cls}" is not in CONTAINERS`);
  }
  return bad;
}

// ---- 检查 7：三张状态映射表的初始化文本与手写期望串全等 + 标识符出现次数清单 ----
// 期望串按当前文件实际内容抄（空白压成一个空格后），键值与 sem 类名与方案 3.3 的映射一致。
const MAPPING_EXPECTED = {
  'it-ledger-category-views.js': { name: 'expiryClasses', init: "{expired:'sem-failed',soon30:'sem-failed',soon60:'sem-prerelease',soon90:'sem-hold',normal:'sem-done',unset:'sem-wait',cancelled:'sem-voided'}" },
  'it-ledger-inspection-sheets.js': { name: 'statusClasses', init: "{ draft: 'sem-wait', submitted: 'sem-done', archived: 'sem-archived' }" },
  'it-ledger-reconciles.js': { name: 'resultClasses', init: "{pending:'sem-wait',found:'sem-done',missing:'sem-failed',mismatch:'sem-hold',not_in_ledger:'sem-hold',ledger_added:'sem-hold',not_in_sheet:'sem-hold',confirmed_off_book:'sem-done',ambiguous:'sem-hold',ledger_fixed:'sem-hold'}" }
};
function mappingViolations(files) {
  const bad = [];
  for (const [file, spec] of Object.entries(MAPPING_EXPECTED)) {
    const f = files.find(x => x.name === file);
    if (!f) { bad.push(`${file}: mapping file missing`); continue; }
    const m = new RegExp('const\\s+' + spec.name + '\\s*=\\s*(\\{[\\s\\S]*?\\});').exec(f.text);
    if (!m) bad.push(`${file}: initialiser of ${spec.name} not found`);
    else if (squash(m[1]) !== spec.init) bad.push(`${file}: ${spec.name} initialiser is ${squash(m[1])} (expected ${spec.init})`);
  }
  return bad;
}
// 手写次数清单（文件:标识符 → 次数）：每个表 = 1 处声明 + 1 处读取。it-ledger.js 里另有一张同名 statusClasses（资产状态表，不在 3.3 改映射范围内），只钉次数。
const IDENT_COUNTS = { 'it-ledger-category-views.js:expiryClasses': 2, 'it-ledger-inspection-sheets.js:statusClasses': 2, 'it-ledger-reconciles.js:resultClasses': 2, 'it-ledger.js:statusClasses': 2 };
const MAPPING_IDS = ['expiryClasses', 'statusClasses', 'resultClasses'];
function identCountViolations(files, counts = IDENT_COUNTS) {
  const bad = [];
  // 两向比较：①实际出现的（每个文件 × 三个标识符，未列的期望 0 次）都要与清单一致；②清单里的每个（文件, 标识符）都必须在实际文件里能找到，且标识符必须属于遍历的三个名字（否则该清单项永远不被比较）
  for (const f of files) for (const id of MAPPING_IDS) {
    const got = (f.text.match(new RegExp('\\b' + id + '\\b', 'g')) || []).length, want = counts[`${f.name}:${id}`] || 0;
    if (got !== want) bad.push(`${f.name}: ${id} appears ${got} times, list says ${want} — 映射表多了读写点：确认没有初始化后改写，再更新次数`);
  }
  for (const key of Object.keys(counts)) {
    const [file, id] = key.split(':');
    if (!MAPPING_IDS.includes(id)) bad.push(`${key}: identifier "${id}" in the identifier-count list is not one of ${MAPPING_IDS.join(' / ')}, so it would never be compared`);
    if (!files.some(f => f.name === file)) bad.push(`${key}: listed in the identifier-count list but its file is not among the module scripts`);
  }
  return bad;
}

// ---- 检查 8：禁用名；新主题文件在、旧 plan-b 文件不在 ----
function themeFileViolations(cssFileNames) {
  const bad = [];
  if (!cssFileNames.includes(THEME_CSS)) bad.push(`assets/css: ${THEME_CSS} does not exist`);
  if (cssFileNames.includes('it-ledger-plan-b.css')) bad.push('assets/css: it-ledger-plan-b.css exists again');
  return bad;
}
function bannedNameViolations(texts /* [{name,text}] */) {
  const bad = [];
  for (const t of texts) for (const m of t.text.matchAll(/sem-(?:intake|special)\b|it-ledger-plan-b\.css|itl-plan-b/g)) bad.push(`${t.name}: ${m[0]}`);
  return bad;
}

// ---- 检查 9：IT_Ledger.html 引用 ----
// 先去掉 <!-- … --> 注释再提取 <link> 与 <body>：被注释掉的 link 页面不会加载，不能计入加载顺序与 link 清单
const stripHtmlComments = h => h.replace(/<!--[\s\S]*?-->/g, '');
function htmlViolations(rawHtml) {
  const html = stripHtmlComments(rawHtml), bad = [], links = [...html.matchAll(/<link rel="stylesheet" href="assets\/css\/([^"?]+)\?v=auto">/g)].map(m => m[1]);
  if (!(links.indexOf(BASE_CSS) >= 0 && links.indexOf(THEME_CSS) > links.indexOf(BASE_CSS))) bad.push(`IT_Ledger.html: stylesheet links are [${links.join(',')}], expected ${BASE_CSS} before ${THEME_CSS}, both with ?v=auto`);
  if (!html.includes('<body class="unified-page itl-theme">')) bad.push('IT_Ledger.html: body class must be "unified-page itl-theme"');
  return bad;
}
// 扫描面钉死：assets/css 下 it-ledger*.css 的文件名清单、IT_Ledger.html 里所有 stylesheet link 的 href（去掉 ?v= 查询串，按页面顺序）都与手写清单全等；
// 新建第三份 it-ledger-*.css 或在页面里多挂一份样式，本脚本的色值 / 阴影 / 字号检查就扫不到它，所以出现即判红交人核对。
const CSS_FILES_EXPECTED = ['it-ledger-theme.css', 'it-ledger.css'];
const STYLESHEET_HREFS_EXPECTED = ['assets/css/style.css', 'assets/css/components.css', 'assets/css/it-ledger.css', 'assets/css/it-ledger-theme.css'];
function surfaceViolations(cssFileNames, rawHtml) {
  const html = stripHtmlComments(rawHtml), bad = [], files = cssFileNames.filter(f => /^it-ledger.*\.css$/.test(f)).sort();
  if (JSON.stringify(files) !== JSON.stringify(CSS_FILES_EXPECTED)) bad.push(`assets/css it-ledger*.css files are ${JSON.stringify(files)}, expected ${JSON.stringify(CSS_FILES_EXPECTED)}`);
  const hrefs = [...html.matchAll(/<link\b[^>]*>/g)].map(m => m[0]).filter(tag => /\brel="stylesheet"/.test(tag)).map(tag => ((/\bhref="([^"]*)"/.exec(tag) || [])[1] || '(no href)').replace(/\?.*$/, ''));
  if (JSON.stringify(hrefs) !== JSON.stringify(STYLESHEET_HREFS_EXPECTED)) bad.push(`IT_Ledger.html stylesheet links are ${JSON.stringify(hrefs)}, expected ${JSON.stringify(STYLESHEET_HREFS_EXPECTED)}`);
  return bad;
}

// ---- 检查 10：桌面字号（五档以外的「值 → 次数」清单）与 font 简写 ----
const FONT_TIERS_PX = [12, 13, 14, 16, 24];
// 手写表：窄屏媒体查询里那几条五档外字号（it-ledger.css：.itl-module-name 15px、.itl-heading h1 18px、.nav-title 17px、.itl-rack-title strong 19px），两份 CSS 合计
const FONT_OTHER_EXPECTED = { 15: 1, 17: 1, 18: 1, 19: 1 };
function fontViolations(files /* [{label,text}] */) {
  const bad = [], other = {};
  for (const f of files) {
    const text = stripComments(normalize(f.text));
    for (const m of text.matchAll(/(?<![\w-])font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) { const v = Number(m[1]); if (!FONT_TIERS_PX.includes(v)) other[v] = (other[v] || 0) + 1; }
    for (const m of text.matchAll(/(?<![\w-])font\s*:\s*([^;}]*)/g)) if (!/^(?:inherit|initial|unset|revert|revert-layer)\s*(?:!\s*important)?$/i.test(m[1].trim())) bad.push(`${f.label}: font shorthand "${m[1].trim().slice(0, 40)}" — font 简写的值只允许 CSS 全局关键字，请用 font-size 长写属性`);
  }
  return bad.concat(tableDiff(other, FONT_OTHER_EXPECTED, 'non-tier font-size px'));
}

// ---- 检查 11：无渐变 ----
const gradientViolations = (cssText, label) => [...stripComments(normalize(cssText)).matchAll(/gradient/gi)].map(() => `${label}: "gradient" appears — 模块 CSS 任何位置都不得出现 gradient`);

// ---- 检查 12：阴影清单 ----
function shadowList(files /* [{label,text}] */) {
  const out = [];
  for (const f of files) for (const r of innerRules(f.text)) for (const d of r.decls) {
    if ((/^(-webkit-)?(box|text)-shadow$/i.test(d.prop) && !/^none$/i.test(d.value)) || /drop-shadow\s*\(/i.test(d.value)) out.push(`${r.selector} | ${d.prop}: ${squash(d.value)}`);
  }
  return out;
}
// 手写清单（5 条）：全部是浮层（菜单面板、提示条、机柜弹层、硬件弹层、详情抽屉）；静止卡片 / 标记不许有阴影。
const SHADOW_EXPECTED = [
  '.itl-menu-panel | box-shadow: var(--shadow-md)',
  '.itl-toast | box-shadow: var(--shadow-lg)',
  '.itl-rack-dialog | box-shadow: 0 20px 80px var(--itl-shadow-ink)',
  '.itl-hardware-dialog | box-shadow: 0 20px 70px var(--itl-shadow-ink)',
  '.itl-workspace>.itl-drawer | box-shadow: -4px 0 24px var(--itl-shadow-drawer)'
];

// ---- 检查 13：字号基线（零特异性 :where 规则，作用域与六个容器全等；每条规则压缩空白后的完整文本与期望逐条全等，各恰好 1 次） ----
const BASELINE_HEAD = ':where(.itl-theme) :where(' + CONTAINERS.join(',') + ') ';
const BASELINE_EXPECTED = [BASELINE_HEAD + ':where(small) { font-size:12px; }', BASELINE_HEAD + ':where(button,input,select,textarea) { font-size:13px; }'];
// 取主题文件全部最内层规则，每条规则压成「selector { prop:value; … }」完整文本，与期望文本逐条全等计数（不是子串：选择器前后加字符、改成别的祖先都不再算命中）
function baselineViolations(themeCss) {
  const ruleTexts = innerRules(themeCss).map(r => `${r.selector} { ${r.decls.map(d => d.prop + ':' + d.value + ';').join(' ')} }`), bad = [];
  for (const want of BASELINE_EXPECTED) { const n = ruleTexts.filter(t => t === want).length; if (n !== 1) bad.push(`${THEME_CSS}: font baseline rule "${want}" must appear exactly once as a whole rule (found ${n})`); }
  return bad;
}

// ================= 运行 =================
let pass = 0;
function check(name, fn) { fn(); pass++; console.log('[OK] ' + name); }
const read = p => normalize(fs.readFileSync(p, 'utf8'));
const baseCss = read(path.join(cssDir, BASE_CSS)), themeCss = read(path.join(cssDir, THEME_CSS));
const html = read(path.join(publicRoot, 'IT_Ledger.html'));
const moduleJs = fs.readdirSync(jsDir).filter(f => /^it-ledger.*\.js$/.test(f)).sort().map(f => ({ name: f, text: read(path.join(jsDir, f)) }));
const cssFiles = [{ label: BASE_CSS, text: baseCss }, { label: THEME_CSS, text: themeCss }];
const none = (list, what) => assert.deepEqual(list, [], what + '\n  ' + list.join('\n  '));
assert.ok(moduleJs.length > 0, 'module scripts found');
const withFile = (name, text) => moduleJs.map(f => f.name === name ? { name, text } : f);
const jsFile = name => moduleJs.find(f => f.name === name).text;
const views = 'it-ledger-category-views.js', sheets = 'it-ledger-inspection-sheets.js', recs = 'it-ledger-reconciles.js', racks = 'it-ledger-racks.js';
const bannedTexts = (js, h, b, t) => [...js, { name: 'IT_Ledger.html', text: h }, { name: BASE_CSS, text: b }, { name: THEME_CSS, text: t }];
// 注入锚点：各取一条在真实文件里恰好出现一次的完整规则，注入 = 紧跟其后追加规则（mutateOnce 会校验唯一性）
const BASE_ANCHOR = '.itl-menu-panel { padding:5px; min-width:164px; }', THEME_ANCHOR = '.itl-theme .itl-sidebar { padding:18px 10px; background:transparent; border-right:0; }';
const injectBase = extra => mutateOnce(baseCss, BASE_ANCHOR, BASE_ANCHOR + '\n' + extra, 'base anchor');
const injectTheme = extra => mutateOnce(themeCss, THEME_ANCHOR, THEME_ANCHOR + '\n' + extra, 'theme anchor');

check('1. split integrity (no @ in any innermost rule head; only @media shells left after removing every innermost rule) and colour literals: hex / rgb( / rgba( / hsl( / hsla( only inside custom-property declarations in both module CSS files', () => none([...shellViolations(baseCss, BASE_CSS), ...shellViolations(themeCss, THEME_CSS), ...colorViolations(baseCss, BASE_CSS), ...colorViolations(themeCss, THEME_CSS)], 'split integrity / literal colours outside variable declarations'));
check('2. scope: --color-* / --sem-* / --itl-control-border selectors in the theme file are exactly [the full themed selector]; --color-* in it-ledger.css only on the bare container list; the 9 pinned --itl-* declarations (file | name | selector) equal the hand-written list (theme file, body.itl-theme only); no --sem-* in it-ledger.css; no --sb-* in either file', () => none(scopeViolations(baseCss, themeCss), 'scope violations'));
check('3. pinned variables (12 colour + 24 sem + 9 --itl-*): declared exactly once in the theme file, value equal to the plan tables, no !important', () => {
  none(pinnedViolations(themeCss), 'pinned variables');
  assert.equal(pinnedEntries().length, 12 + 24 + 9, 'pinned table size');
});
check('4. no custom property declaration carries !important (either file)', () => none([...importantViolations(baseCss, BASE_CSS), ...importantViolations(themeCss, THEME_CSS)], '!important on custom properties'));
check('5. every var(--itl-*) without fallback is defined in the two CSS files or injected by racks.js (case-sensitive)', () => none(danglingViolations(baseCss, themeCss), 'dangling variables'));
check('6. body-reference list: every module script has exactly the hand-written number of references to the body element (unlisted files 0); the known overlay class literals are still in their files and in CONTAINERS', () => none([...bodyMountViolations(moduleJs), ...overlayClassViolations(moduleJs)], 'body references / overlay classes'));
check('7. the three status-class tables equal the hand-written initialiser strings; the identifier-count list holds (no read / write points added after initialisation)', () => none([...mappingViolations(moduleJs), ...identCountViolations(moduleJs)], 'status mapping tables'));
check('8. no sem-intake / sem-special / it-ledger-plan-b.css / itl-plan-b in module JS, HTML or CSS; it-ledger-theme.css exists and it-ledger-plan-b.css is gone', () => {
  none(themeFileViolations(fs.readdirSync(cssDir)), 'theme file / old file');
  none(bannedNameViolations(bannedTexts(moduleJs, html, baseCss, themeCss)), 'banned names');
});
check('9. IT_Ledger.html loads it-ledger.css then it-ledger-theme.css (both ?v=auto) and uses body class "unified-page itl-theme"; the it-ledger*.css file list and the page stylesheet link list equal the hand-written lists', () => none([...htmlViolations(html), ...surfaceViolations(fs.readdirSync(cssDir), html)], 'IT_Ledger.html / stylesheet surface'));
check('10. desktop font sizes: font-size px values outside 12 / 13 / 14 / 16 / 24 equal the hand-written "value -> count" table; font shorthand only CSS global keywords', () => none(fontViolations(cssFiles), 'font sizes'));
check('11. no "gradient" anywhere in either module CSS (comments stripped, case-insensitive)', () => none([...gradientViolations(baseCss, BASE_CSS), ...gradientViolations(themeCss, THEME_CSS)], 'gradient'));
check('12. non-none box-shadow / text-shadow and drop-shadow( declarations equal the hand-written list of 5 overlay selectors', () => none(listDiff(shadowList(cssFiles), SHADOW_EXPECTED, 'shadow list'), 'shadow list'));
check('13. font baseline: the two zero-specificity :where rules (small 12px; button / input / select / textarea 13px) appear exactly once each in the theme file', () => none(baselineViolations(themeCss), 'font baseline'));

// ================= 对照组：注入一处违规必须判红（原文串恰好出现一次 → 替换） =================
check('control 1 (split integrity and colour literals): an injected #hex / rgb( is flagged; a --custom-property hex is not; a missing }, CSS nesting, an @supports block, a top @import and an @font-face are flagged', () => {
  assert.equal(colorViolations(injectBase('.x{color:#123456}'), BASE_CSS).length, 1);
  assert.equal(colorViolations(injectTheme('.x{background:rgb(1,2,3)}'), THEME_CSS).length, 1);
  assert.deepEqual(colorViolations(injectTheme('.x{--y:#123456}'), THEME_CSS), []);
  // 切分完整性：删掉一个 } 、加一段 CSS 嵌套各判红；真实文件的外壳（@media）不判红
  assert.deepEqual(shellViolations(baseCss, BASE_CSS), []); assert.deepEqual(shellViolations(themeCss, THEME_CSS), []);
  assert.equal(shellViolations(mutateOnce(themeCss, THEME_ANCHOR, THEME_ANCHOR.slice(0, -1), 'drop a closing brace'), THEME_CSS).length, 1, 'missing }');
  assert.equal(shellViolations(injectBase('.itl-nest{ .itl-inner{color:var(--c)} }'), BASE_CSS).length, 1, 'CSS nesting');
  assert.equal(shellViolations(injectTheme('@supports(display:grid){.x{color:var(--c)}}'), THEME_CSS).length, 1, 'at-rule other than @media');
  // 规则头里的 @：顶部注入 @import 语句（连同紧随其后的选择器被当作一条规则删掉）、注入 @font-face（本身是一个最内层匹配）各判红，且报的是规则头而不是残留
  const imported = shellViolations('@import url(x.css);\n' + themeCss, THEME_CSS);
  assert.equal(imported.length, 1, '@import at the top'); assert.ok(imported[0].includes('at-rule head'), imported[0]);
  const fontFace = shellViolations(injectBase('@font-face{font-family:x;src:url(x)}'), BASE_CSS);
  assert.equal(fontFace.length, 1, '@font-face'); assert.ok(fontFace[0].includes('at-rule head'), fontFace[0]);
});
check('control 2 (scope): a --sem-* on another selector in the theme file, a --sem-* in the base file and a --sb-* in either file are flagged; --color-* on a card selector in the base file, --itl-control-border and a pinned --itl-* on another selector in the theme file, and a pinned --itl-* local override in the base file are flagged', () => {
  assert.ok(scopeViolations(baseCss, injectTheme('body.itl-theme{--sem-done-bg:#ffffff}')).length >= 1, '--sem-* on body.itl-theme');
  assert.ok(scopeViolations(injectBase('.itl-modal{--sem-done-bg:#ffffff}'), themeCss).length >= 1, '--sem-* in base');
  assert.ok(scopeViolations(injectBase('.x{--sb-bg:#ffffff}'), themeCss).length >= 1, '--sb-* in base');
  assert.ok(scopeViolations(baseCss, injectTheme('.x{--sb-bg:#ffffff}')).length >= 1, '--sb-* in theme');
  assert.ok(scopeViolations(injectBase('.itl-pending-card{--color-accent:#2e7861}'), themeCss).some(m => m.includes(BASE_CSS + ': --color-* are declared on')), '--color-* on a card selector in base');
  assert.ok(scopeViolations(baseCss, injectTheme('.x{--itl-control-border:#cdced1}')).some(m => m.includes('--itl-control-border')), '--itl-control-border on another selector in theme');
  assert.ok(scopeViolations(baseCss, injectTheme('.x{--itl-primary:#1d1f20}')).some(m => m.includes('pinned --itl-* declarations')), 'pinned --itl-* on another selector in theme');
  assert.ok(scopeViolations(injectBase('.itl-pending-card{--itl-primary:#000}'), themeCss).some(m => m.includes('pinned --itl-* declarations') && m.includes(BASE_CSS + ' | --itl-primary | .itl-pending-card')), 'pinned --itl-* local override in base');
  assert.deepEqual(scopeViolations(baseCss, themeCss), [], 'real files are green');
});
check('control 3 (pinned): a changed value, a duplicate declaration, a missing declaration and !important on a pinned variable are flagged', () => {
  assert.ok(pinnedViolations(mutateOnce(themeCss, '--color-accent:#1b6c80;', '--color-accent:#2e7861;', 'accent')).some(m => m.includes('--color-accent =')), 'changed value');
  assert.ok(pinnedViolations(injectTheme(THEMED_SELECTOR + '{--sem-done-bg:#ebedee}')).some(m => m.includes('--sem-done-bg declared 2 times')), 'duplicate declaration');
  assert.ok(pinnedViolations(injectTheme(THEMED_SELECTOR + '{--sem-xxx-bg:#ffffff}')).some(m => m.includes('sem declarations: not in the hand-written list: --sem-xxx-bg')), 'unpinned --sem-* declaration');
  assert.ok(pinnedViolations(mutateOnce(themeCss, '--sem-archived-bds:dashed;', '', 'archived bds')).some(m => m.includes('--sem-archived-bds declared 0 times')), 'missing declaration');
  assert.ok(pinnedViolations(mutateOnce(themeCss, '--sem-done-bg:#ebedee;', '--sem-done-bg:#ebedee !important;', 'done bg')).some(m => m.includes('--sem-done-bg declared with !important')), '!important');
  assert.deepEqual(pinnedViolations(themeCss), [], 'real file is green');
  assert.ok(pinnedViolations(mutateOnce(themeCss, 'background:var(--itl-page-bg);\n}', 'background:var(--itl-primary);\n}', 'body background')).some(m => m.includes('body.itl-theme background declarations')), 'body.itl-theme background value changed');
  assert.ok(pinnedViolations(injectTheme('body.itl-theme{background:var(--itl-page-bg)}')).some(m => m.includes('body.itl-theme background declarations')), 'body.itl-theme background declared twice');
});
check('control 4 (!important): !important on a custom property is flagged in either file; on an ordinary property it is not', () => {
  assert.equal(importantViolations(injectBase('.x{--y:#ffffff !important}'), BASE_CSS).length, 1);
  assert.equal(importantViolations(injectTheme('.x{--y:#ffffff!important}'), THEME_CSS).length, 1);
  assert.deepEqual(importantViolations(injectTheme('.x{color:var(--c) !important}'), THEME_CSS), []);
});
check('control 5 (dangling): an undefined var(--itl-xxx) is flagged; a wrong-case name is flagged; a JS-injected name and a name defined in either file are not', () => {
  assert.equal(danglingViolations(injectBase('.x{width:var(--itl-xxx)}'), themeCss).length, 1, 'undefined name');
  assert.equal(danglingViolations(baseCss, injectTheme('.x{color:var(--itl-Primary)}')).length, 1, 'wrong case of an existing name');
  assert.equal(danglingViolations(baseCss, injectTheme('.x{bottom:calc(var(--itl-u-kk) * 1px)}')).length, 1, 'typo of a JS-injected name');
  assert.deepEqual(danglingViolations(baseCss, injectTheme('.x{bottom:calc(var(--itl-u-k) * 1px);color:var(--itl-primary)}')), [], 'injected / defined names pass');
});
check('control 6 (body references): one more document.body in racks.js and a body reference in an unlisted file are flagged; a listed file that disappeared is flagged; a renamed overlay class literal is flagged', () => {
  assert.ok(bodyMountViolations(withFile(racks, mutateOnce(jsFile(racks), 'document.body', '(document.body, document.body)', 'racks body mount'))).some(m => m.includes('racks.js: body references 2') && m.includes('list says 1')));
  assert.ok(bodyMountViolations(withFile('it-ledger-forms.js', jsFile('it-ledger-forms.js') + '\nfunction g(el){document.body.append(el);}')).some(m => m.startsWith('it-ledger-forms.js:')), 'unlisted file');
  assert.ok(bodyMountViolations(moduleJs.filter(f => f.name !== racks)).some(m => m.includes('not found among module scripts')), 'listed file disappeared');
  assert.ok(overlayClassViolations(withFile(racks, mutateOnce(jsFile(racks), 'itl-rack-overlay', 'itl-rack-overlay-x', 'racks overlay class'))).some(m => m.includes('"itl-rack-overlay" no longer appears')), 'class literal renamed');
});
check('control 7 (mapping tables): a changed value, an added key and a removed key in the initialiser are flagged; a use added after initialisation, a use in an unlisted file, a listed file removed from the in-memory file list and a count-list key whose identifier is not one of the three traversed names are flagged by the count list', () => {
  assert.ok(mappingViolations(withFile(views, mutateOnce(jsFile(views), "soon60:'sem-prerelease'", "soon60:'sem-done'", 'soon60'))).some(m => m.includes('expiryClasses initialiser')), 'value changed');
  assert.ok(mappingViolations(withFile(recs, mutateOnce(jsFile(recs), "found:'sem-done',", "found:'sem-done',extra:'sem-wait',", 'found'))).some(m => m.includes('resultClasses initialiser')), 'key added');
  assert.ok(mappingViolations(withFile(sheets, mutateOnce(jsFile(sheets), " draft: 'sem-wait',", '', 'draft'))).some(m => m.includes('statusClasses initialiser')), 'key removed');
  assert.ok(identCountViolations(withFile(recs, jsFile(recs) + "\nresultClasses.not_in_sheet='sem-done';")).some(m => m.includes('resultClasses appears 3 times')), 'write after initialisation');
  assert.ok(identCountViolations(withFile('it-ledger-forms.js', jsFile('it-ledger-forms.js') + '\nstatusClasses.draft="x";')).some(m => m.startsWith('it-ledger-forms.js:')), 'unlisted file');
  assert.ok(identCountViolations(moduleJs.filter(f => f.name !== 'it-ledger.js')).some(m => m.startsWith('it-ledger.js:statusClasses: listed in the identifier-count list')), 'a listed file removed from the in-memory file list');
  assert.ok(identCountViolations(moduleJs, { ...IDENT_COUNTS, 'x.js:fooClasses': 2 }).some(m => m.startsWith('x.js:fooClasses: identifier "fooClasses"')), 'a key whose identifier is not one of the three traversed names');
  assert.deepEqual(identCountViolations(moduleJs), [], 'real files are green');
});
check('control 8 (banned names / theme file): sem-intake in a module script, the old class itl-plan-b in the HTML and the old file name in the CSS are each flagged; the in-memory CSS file list without the new theme file and with the old plan-b file added is flagged', () => {
  assert.equal(bannedNameViolations(bannedTexts(withFile(views, mutateOnce(jsFile(views), "normal:'sem-done'", "normal:'sem-intake'", 'normal')), html, baseCss, themeCss)).length, 1);
  assert.equal(bannedNameViolations(bannedTexts(moduleJs, mutateOnce(html, '<body class="unified-page itl-theme">', '<body class="unified-page itl-plan-b">', 'body class'), baseCss, themeCss)).length, 1);
  assert.equal(bannedNameViolations(bannedTexts(moduleJs, html, injectBase('/* x */ .x{background:url(it-ledger-plan-b.css)}'), themeCss)).length, 1);
  const cssNames = fs.readdirSync(cssDir);
  assert.deepEqual(themeFileViolations(cssNames), [], 'real file list is green');
  assert.equal(themeFileViolations(cssNames.filter(f => f !== THEME_CSS)).length, 1, 'new theme file missing');
  assert.equal(themeFileViolations([...cssNames, 'it-ledger-plan-b.css']).length, 1, 'old plan-b file back');
});
check('control 9 (IT_Ledger.html): a missing itl-theme body class, a missing ?v=auto on the theme link and the two links swapped are flagged; a third it-ledger-*.css file, an extra stylesheet link, a removed stylesheet link and the theme link wrapped in an HTML comment are flagged by the stylesheet surface lists', () => {
  assert.ok(htmlViolations(mutateOnce(html, '<body class="unified-page itl-theme">', '<body class="unified-page">', 'body class')).length === 1);
  assert.ok(htmlViolations(mutateOnce(html, 'assets/css/it-ledger-theme.css?v=auto', 'assets/css/it-ledger-theme.css', 'theme link')).length === 1);
  const step1 = mutateOnce(html, 'assets/css/it-ledger.css?v=auto', 'assets/css/@@.css?v=auto', 'swap 1');
  const step2 = mutateOnce(step1, 'assets/css/it-ledger-theme.css?v=auto', 'assets/css/it-ledger.css?v=auto', 'swap 2');
  assert.ok(htmlViolations(mutateOnce(step2, 'assets/css/@@.css?v=auto', 'assets/css/it-ledger-theme.css?v=auto', 'swap 3')).length === 1, 'links swapped');
  // 扫描面：多一份 it-ledger-*.css 文件、页面多挂一条样式 link、页面少一条 link 各判红
  const files = fs.readdirSync(cssDir);
  assert.deepEqual(surfaceViolations(files, html), [], 'real surface is green');
  assert.equal(surfaceViolations([...files, 'it-ledger-extra.css'], html).length, 1, 'a third it-ledger-*.css file');
  assert.equal(surfaceViolations(files, mutateOnce(html, '<link rel="stylesheet" href="assets/css/it-ledger-theme.css?v=auto">', '<link rel="stylesheet" href="assets/css/it-ledger-theme.css?v=auto">\n<link rel="stylesheet" href="assets/css/it-ledger-extra.css?v=auto">', 'extra link')).length, 1, 'a fifth stylesheet link');
  assert.equal(surfaceViolations(files, mutateOnce(html, '<link rel="stylesheet" href="assets/css/components.css?v=auto">', '', 'drop link')).length, 1, 'a stylesheet link removed');
  // 只把主题 link 包进 HTML 注释：页面不再加载主题样式，加载顺序检查与 link 清单检查都要判红
  const themeLink = '<link rel="stylesheet" href="assets/css/it-ledger-theme.css?v=auto">';
  const commented = mutateOnce(html, themeLink, '<!-- ' + themeLink + ' -->', 'comment out the theme link');
  assert.equal(htmlViolations(commented).length, 1, 'load-order check sees the commented-out theme link as missing');
  assert.equal(surfaceViolations(files, commented).length, 1, 'link list check sees the commented-out theme link as missing');
});
check('control 10 (fonts): an injected 11px / 15px, a changed existing value and a font shorthand are flagged; font:inherit is not', () => {
  assert.ok(fontViolations([{ label: BASE_CSS, text: injectBase('.x{font-size:11px}') }, cssFiles[1]]).some(m => m.includes('11 appears 1 times')), 'new 11px');
  assert.ok(fontViolations([{ label: BASE_CSS, text: injectBase('.x{font-size:15px}') }, cssFiles[1]]).some(m => m.includes('15 appears 2 times')), 'second 15px');
  assert.ok(fontViolations([cssFiles[0], { label: THEME_CSS, text: injectTheme('.x{font:12px Arial}') }]).some(m => m.includes('font shorthand')), 'font shorthand');
  assert.ok(fontViolations([{ label: BASE_CSS, text: mutateOnce(baseCss, 'font-size: 24px; letter-spacing: .03em; margin: 4px 0 8px;', 'font-size: 20px; letter-spacing: .03em; margin: 4px 0 8px;', 'h1 size') }, cssFiles[1]]).some(m => m.includes('20 appears 1 times')), 'changed existing value');
  assert.deepEqual(fontViolations([{ label: BASE_CSS, text: injectBase('.x{font:inherit}') }, cssFiles[1]]), []);
});
check('control 11 (gradient): an injected linear-gradient in either file is flagged; the word inside a comment is not', () => {
  assert.equal(gradientViolations(injectBase('.x{background:linear-gradient(var(--a),var(--b))}'), BASE_CSS).length, 1);
  assert.equal(gradientViolations(injectTheme('.x{mask-image:LINEAR-GRADIENT(var(--a),var(--b))}'), THEME_CSS).length, 1);
  assert.deepEqual(gradientViolations(injectTheme('/* linear-gradient(x) */'), THEME_CSS), []);
});
check('control 12 (shadows): a new box-shadow / text-shadow / drop-shadow, a changed listed shadow and a removed listed shadow turn the list red; box-shadow:none does not', () => {
  const bad = (b, t) => listDiff(shadowList([{ label: BASE_CSS, text: b }, { label: THEME_CSS, text: t }]), SHADOW_EXPECTED, 'shadow');
  assert.equal(bad(injectBase('.x{box-shadow:0 1px 2px var(--c)}'), themeCss).length, 1, 'new box-shadow');
  assert.equal(bad(baseCss, injectTheme('.x{filter:drop-shadow(0 1px 2px var(--c))}')).length, 1, 'new drop-shadow');
  assert.equal(bad(baseCss, injectTheme('.x{text-shadow:0 1px 2px var(--c)}')).length, 1, 'new text-shadow');
  assert.equal(bad(mutateOnce(baseCss, 'box-shadow:0 20px 80px var(--itl-shadow-ink)', 'box-shadow:0 1px 2px var(--c)', 'rack dialog shadow'), themeCss).length, 2, 'changed listed shadow (one missing + one unlisted)');
  assert.equal(bad(mutateOnce(baseCss, 'box-shadow:0 20px 70px var(--itl-shadow-ink); ', '', 'hardware dialog shadow'), themeCss).length, 1, 'removed listed shadow');
  assert.deepEqual(bad(injectBase('.x{box-shadow:none}'), themeCss), []);
});
check('control 13 (font baseline): a deleted baseline rule, a changed baseline value, a duplicated baseline rule and a baseline selector prefixed with "body " are flagged', () => {
  const small = BASELINE_EXPECTED[0], button = BASELINE_EXPECTED[1];
  // 注入用的原文串：基线规则在真实文件里是单行规则，原文与期望文本一致；先确认两条规则的原文都恰好一次
  assert.equal(count(themeCss, small), 1); assert.equal(count(themeCss, button), 1);
  assert.ok(baselineViolations(mutateOnce(themeCss, small + '\n', '', 'small rule')).some(m => m.includes('(found 0)')), 'deleted');
  assert.ok(baselineViolations(mutateOnce(themeCss, button, button.replace('13px', '11px'), 'button rule')).some(m => m.includes('(found 0)')), 'value changed');
  assert.ok(baselineViolations(mutateOnce(themeCss, small, small + '\n' + small, 'small rule dup')).some(m => m.includes('(found 2)')), 'duplicated');
  // 选择器挪错：给基线选择器加祖先前缀（子串计数仍会命中，整条规则全等不会）
  assert.ok(baselineViolations(mutateOnce(themeCss, small, 'body ' + small, 'small rule prefixed')).some(m => m.includes('(found 0)')), 'small rule selector prefixed with "body "');
  assert.ok(baselineViolations(mutateOnce(themeCss, button, 'body ' + button, 'button rule prefixed')).some(m => m.includes('(found 0)')), 'button rule selector prefixed with "body "');
  assert.deepEqual(baselineViolations(themeCss), [], 'real file is green');
});
console.log(`PASS=${pass} FAIL=0`);
