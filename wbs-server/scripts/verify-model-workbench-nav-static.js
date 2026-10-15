#!/usr/bin/env node
/**
 * #77 C3c：「模型配置台」导航项静态守卫（纯 node，不起服务）。
 *
 * 背景：配置台从目录页迁出成独立页面 Model_Workbench.html 后，所有带「数据中心」下拉的页面都要在「模型中心」之后多一项「模型配置台」，
 *   且配置台自己的导航把高亮从「模型中心」移到「模型配置台」。导航是每页各抄一份的手写 HTML，漏一页 / 放错位置 / 写错字很容易，所以用本守卫钉死。
 *
 * 判据（只在每页 <nav class="navbar … </nav> 切片内判断；切片终点用结构锚 </nav>，不对全页做正则）：
 *   ① 页面集合：EXPECTED_PAGES 里每页都必须在 git 可见的 public/*.html 集合里（缺哪页报哪页）；git 可见集合里「数据中心」下拉（.nav-dropdown-menu）
 *      含 /Model_Center.html 链接的页面集合 必须等于 EXPECTED_PAGES（多一页少一页都红）；每页「含 /Model_Center.html 的下拉块」必须恰好 1 个（31 L2）；
 *   ② 每页下拉内：/Model_Workbench.html 链接恰好 1 个、文字为「模型配置台」、紧跟在 /Model_Center.html 那一项之后（按 <a 出现顺序），
 *      且「模型中心」项的 </a> 到新项的 <a 之间只允许空白（不能夹别的元素）；整个 <nav> 切片内 /Model_Workbench.html 链接总数恰为 1（下拉外不能再放一份）（31 L2）；
 *   ③ 各页「模型配置台」项（去掉高亮样式属性、去空白后）逐字相等，取第一页为参照，报出不等的页（含图标 svg）；
 *   ④ 高亮：Model_Workbench.html 里只有「模型配置台」项带高亮样式、Model_Center.html 里只有「模型中心」项带高亮、其余页两项都不带；
 *      「数据中心」下拉触发器（<button class="nav-dropdown-trigger">）的高亮：属于这个分组的 5 页（TRIGGER_HIGHLIGHT_PAGES：资产中心 / 建设总览 / 指标中心 /
 *      模型中心 / 模型配置台）必须带且写法去空白后逐字相等，其余页不得带（31 L1）。
 *
 * 文件集合取 `git ls-files`，不扫磁盘全量（磁盘上被忽略 / 未跟踪的文件会让守卫随本机漂移，见 guard_static_analysis_gotchas 坑 32）。
 * 用法：node scripts/verify-model-workbench-nav-static.js [--self-test]
 * 威胁模型：只防「诚实漏改 / 放错 / 写错」，不防故意绕过（动态生成导航、非 <a> 元素）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CENTER = 'Model_Center.html';
const WORKBENCH = 'Model_Workbench.html';
const CENTER_HREF = '/Model_Center.html';
const WORKBENCH_HREF = '/Model_Workbench.html';
const WORKBENCH_LABEL = '模型配置台';
const EXPECTED_PAGES = [
  'Asset_Center.html', 'Dashboard.html', 'Data_Collab.html', 'Data_Correction.html', 'Issue_Lite.html', 'Issue_Tracker.html', 'IT_Ledger.html',
  'Legacy_Archive.html', 'Metrics.html', 'Model_Center.html', 'My_Workspace.html', 'Periodic_Fetch.html', 'Quick_Log.html', 'Statistics.html',
  'Sys_Iteration.html', 'Task_Pool.html', 'Model_Workbench.html',
];
/** 「数据中心」下拉触发器带高亮的页面：资产中心 / 建设总览 / 指标中心 / 模型中心 / 模型配置台这五页属于该分组（现状如此，写进清单锁住） */
const TRIGGER_HIGHLIGHT_PAGES = ['Asset_Center.html', 'Dashboard.html', 'Metrics.html', 'Model_Center.html', 'Model_Workbench.html'];

const squash = (t) => t.replace(/\s+/g, '');
/** 高亮样式：目录页 / 配置台给「本页项」加的 style="color:#d97706; font-weight:600;" */
const HL_RE = /\sstyle="[^"]*(?:#d97706|font-weight:\s*600)[^"]*"/;
const stripHighlight = (tag) => tag.replace(HL_RE, '');

/** 取 <nav class="navbar … </nav> 切片（先去掉 HTML 注释）；没有 navbar 返回 null */
function navSlice(html) {
  const h = html.replace(/<!--[\s\S]*?-->/g, '');
  const s = h.indexOf('<nav class="navbar');
  if (s < 0) return null;
  const e = h.indexOf('</nav>', s);
  return e < 0 ? null : h.slice(s, e);
}
/** 从 start 处的 <div …> 起，按 <div> 深度配对到匹配的 </div>，返回 { inner, end }（inner 不含外层标签；end = </div> 之后的位置） */
function matchDiv(text, openStart, openLen) {
  let depth = 1; const tag = /<div\b|<\/div>/g; tag.lastIndex = openStart + openLen; let t;
  while ((t = tag.exec(text))) {
    if (t[0] === '</div>') { depth--; if (depth === 0) return { inner: text.slice(openStart + openLen, t.index), end: t.index + t[0].length }; } else depth++;
  }
  return null;
}
/** 切片里所有 .nav-dropdown-menu 块：{ inner, start }（start = 菜单起始标签在切片里的位置） */
function dropdownMenus(nav) {
  const out = [];
  const re = /<div\b[^>]*class="[^"]*\bnav-dropdown-menu\b[^"]*"[^>]*>/g; let m;
  while ((m = re.exec(nav))) { const b = matchDiv(nav, m.index, m[0].length); if (b) out.push({ inner: b.inner, start: m.index }); }
  return out;
}
/** 块里的 <a …>…</a> 列表：{ open, full, href, label, start, end }（start / end 是在块内的位置） */
function anchors(block) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g; let m;
  while ((m = re.exec(block))) {
    const href = (m[1].match(/\bhref="([^"]*)"/) || [])[1] || '';
    out.push({ open: '<a' + m[1] + '>', full: m[0], href, label: m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}
/** 页面导航信息：{ nav, menus（含 /Model_Center.html 的下拉块列表，每个 { block, anchors, trigger }）}；没有 navbar 返回 null */
function pageNav(html) {
  const nav = navSlice(html);
  if (!nav) return null;
  const menus = [];
  for (const d of dropdownMenus(nav)) {
    const a = anchors(d.inner);
    if (!a.some(x => x.href === CENTER_HREF)) continue;
    // 触发器 = 该下拉块之前最近的 <button class="nav-dropdown-trigger …>
    const before = nav.slice(0, d.start); const ti = before.lastIndexOf('<button class="nav-dropdown-trigger');
    const trigger = ti < 0 ? null : before.slice(ti, before.indexOf('>', ti) + 1);
    menus.push({ block: d.inner, anchors: a, trigger });
  }
  return { nav, menus };
}

/** pages：{ 文件名: html }；返回问题列表 */
function check(pages) {
  const probs = [];
  const found = [];
  const newItems = {}; const triggers = {};
  for (const name of EXPECTED_PAGES) if (!(name in pages)) probs.push(`① ${name} 在清单里，但不在 git 可见的 public/*.html 集合里（页面被删 / 改名 / 未加入版本库）`);
  for (const name of Object.keys(pages).sort()) {
    const pn = pageNav(pages[name]);
    if (!pn || !pn.menus.length) continue;
    found.push(name);
    if (pn.menus.length !== 1) { probs.push(`① ${name}：含 ${CENTER_HREF} 的「数据中心」下拉块应恰好 1 个，实得 ${pn.menus.length}`); }
    const menu = pn.menus[0]; const a = menu.anchors;
    const ci = a.findIndex(x => x.href === CENTER_HREF);
    const wbs = a.map((x, i) => ({ x, i })).filter(o => o.x.href === WORKBENCH_HREF);
    const navWbCount = (pn.nav.match(/href="\/Model_Workbench\.html"/g) || []).length;
    if (navWbCount !== 1) probs.push(`② ${name}：整个 <nav> 内 ${WORKBENCH_HREF} 链接总数应恰为 1，实得 ${navWbCount}`);
    if (wbs.length !== 1) { probs.push(`② ${name}：下拉里 ${WORKBENCH_HREF} 链接应恰好 1 个，实得 ${wbs.length}`); }
    else {
      const { x, i } = wbs[0];
      if (x.label !== WORKBENCH_LABEL) probs.push(`② ${name}：新项文字应为「${WORKBENCH_LABEL}」，实得「${x.label}」`);
      if (i !== ci + 1) probs.push(`② ${name}：新项应紧跟在「模型中心」项之后（模型中心在第 ${ci + 1} 个，新项在第 ${i + 1} 个）`);
      else if (!/^\s*$/.test(menu.block.slice(a[ci].end, x.start))) probs.push(`② ${name}：「模型中心」项与「${WORKBENCH_LABEL}」项之间只允许空白，实得「${menu.block.slice(a[ci].end, x.start).replace(/\s+/g, ' ').trim().slice(0, 60)}」`);
      newItems[name] = squash(stripHighlight(x.full));
      // ④ 高亮
      const wantWb = name === WORKBENCH, wantCenter = name === CENTER;
      if (HL_RE.test(x.open) !== wantWb) probs.push(`④ ${name}：「${WORKBENCH_LABEL}」项高亮应为 ${wantWb}，实得 ${!wantWb}`);
      if (HL_RE.test(a[ci].open) !== wantCenter) probs.push(`④ ${name}：「模型中心」项高亮应为 ${wantCenter}，实得 ${!wantCenter}`);
    }
    // ④ 触发器高亮（31 L1）
    const trig = menu.trigger;
    if (trig === null) probs.push(`④ ${name}：没找到「数据中心」下拉触发器（<button class="nav-dropdown-trigger">）`);
    else {
      const has = HL_RE.test(trig); const want = TRIGGER_HIGHLIGHT_PAGES.includes(name);
      if (has !== want) probs.push(`④ ${name}：「数据中心」下拉触发器高亮应为 ${want}，实得 ${has}`);
      if (has) triggers[name] = squash((trig.match(HL_RE) || [''])[0]);
    }
  }
  // ① 页面集合双向
  for (const n of EXPECTED_PAGES) if (n in pages && !found.includes(n)) probs.push(`① ${n} 在清单里，但没找到含 ${CENTER_HREF} 的「数据中心」下拉（页面缺失或导航被改）`);
  for (const n of found) if (!EXPECTED_PAGES.includes(n)) probs.push(`① ${n} 带有含 ${CENTER_HREF} 的导航下拉，却不在 EXPECTED_PAGES 清单里（新增了带导航的页面？请登记并补「${WORKBENCH_LABEL}」项）`);
  // ③ 逐字相等
  const names = Object.keys(newItems).sort();
  if (names.length) {
    const ref = newItems[names[0]];
    for (const n of names.slice(1)) if (newItems[n] !== ref) probs.push(`③ ${n}：「${WORKBENCH_LABEL}」项（去高亮、去空白后）与 ${names[0]} 不逐字相等`);
  }
  // ④ 触发器高亮写法两页（目录页 / 配置台）一致，且五页互相一致
  if (triggers[CENTER] !== undefined && triggers[WORKBENCH] !== undefined && triggers[CENTER] !== triggers[WORKBENCH]) probs.push(`④ ${CENTER} 与 ${WORKBENCH} 的「数据中心」下拉触发器高亮写法不一致`);
  const tn = Object.keys(triggers).sort();
  for (const n of tn.slice(1)) if (triggers[n] !== triggers[tn[0]]) probs.push(`④ ${n}：「数据中心」下拉触发器高亮写法与 ${tn[0]} 不一致`);
  return probs;
}

function loadPages() {
  const r = spawnSync('git', ['ls-files', '--', 'public/*.html'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error('git ls-files 失败：' + (r.stderr || r.status));
  const files = r.stdout.split('\n').map(s => s.trim()).filter(Boolean).filter(f => /^public\/[^/]+\.html$/.test(f));
  if (!files.length) throw new Error('git ls-files 无输出，疑似不在仓库内运行（或 public/*.html 都没进版本库）');
  const pages = {};
  for (const f of files) pages[path.basename(f)] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  return pages;
}

function selfTest(pages) {
  const base = check(pages);
  if (base.length) { console.log('[self-test] 对照组（未变异）应全绿，实得：\n  ' + base.join('\n  ')); return 1; }
  console.log('[self-test] 对照组（未变异）全绿');
  const ANCHOR_RE = /<a href="\/Model_Workbench\.html"[^>]*>[\s\S]*?<\/a>/;
  const mut = (name, fn) => (p) => { const q = { ...p }; q[name] = fn(q[name]); if (q[name] === p[name]) throw new Error('变异没有改动 ' + name); return q; };
  const HLSTYLE = ' style="color:#d97706; font-weight:600;"';
  /** 复制「数据中心」下拉容器（<div class="nav-dropdown"> … 匹配的 </div>，且其中含 Model_Center 链接）紧跟在原容器之后 */
  const dupDropdown = (h) => {
    const re = /<div class="nav-dropdown">/g; let m;
    while ((m = re.exec(h))) { const b = matchDiv(h, m.index, m[0].length); if (b && b.inner.includes('href="/Model_Center.html"')) return h.slice(0, b.end) + '\n' + h.slice(m.index, b.end) + h.slice(b.end); }
    throw new Error('没找到数据中心下拉容器');
  };
  // 每条：[标签, 变异函数, 预期判据前缀]（判红时必须至少有一条问题以该前缀开头，否则自测失败并打印实际问题）
  const muts = [
    ['某页（多行）删掉新项', mut('Asset_Center.html', h => h.replace(ANCHOR_RE, '')), '②'],
    ['某页（单行）删掉新项', mut('Quick_Log.html', h => h.replace(ANCHOR_RE, '')), '②'],
    ['新增一页带导航却不在清单', (p) => ({ ...p, 'Fake_Page.html': p['Asset_Center.html'] }), '①'],
    ['清单里的页面不在 git 可见集合里（缺哪页报哪页）', (p) => { const q = { ...p }; delete q['Statistics.html']; return q; }, '① Statistics.html'],
    ['某页把新项放到「指标中心」后', mut('Dashboard.html', h => { const m = h.match(ANCHOR_RE)[0]; const noNew = h.replace(ANCHOR_RE, ''); return noNew.replace(/(<a href="\/Metrics\.html"[^>]*>[\s\S]*?<\/a>)/, (x) => x + '\n' + m); }), '②'],
    ['某页新项文字改成「配置台」', mut('Task_Pool.html', h => h.replace(ANCHOR_RE, (x) => x.replace('模型配置台', '配置台'))), '②'],
    ['某页新项 svg 少一个属性（单行页）', mut('Quick_Log.html', h => h.replace(ANCHOR_RE, (x) => x.replace(' stroke-linecap="round"', ''))), '③'],
    ['某页新项 svg 少一个属性（多行页）', mut('Metrics.html', h => h.replace(ANCHOR_RE, (x) => x.replace(' stroke-width="2"', ''))), '③'],
    ['某页新项图标少一条线', mut('Statistics.html', h => h.replace(ANCHOR_RE, (x) => x.replace('<line x1="16" y1="18" x2="16" y2="22"/>', ''))), '③'],
    ['配置台高亮留在「模型中心」项（新项不带）', mut(WORKBENCH, h => h.replace(/(<a href="\/Model_Center\.html")>/, '$1' + HLSTYLE + '>').replace(new RegExp('(<a href="/Model_Workbench\\.html")' + HLSTYLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '>'), '$1>')), '④'],
    ['配置台两项都带高亮', mut(WORKBENCH, h => h.replace(/(<a href="\/Model_Center\.html")>/, '$1' + HLSTYLE + '>')), '④'],
    ['目录页高亮被移到新项', mut(CENTER, h => h.replace(new RegExp('(<a href="/Model_Center\\.html")' + HLSTYLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '>'), '$1>').replace(/(<a href="\/Model_Workbench\.html")>/, '$1' + HLSTYLE + '>')), '④'],
    ['某普通页给新项加高亮（单行页）', mut('Issue_Lite.html', h => h.replace(/(<a href="\/Model_Workbench\.html")>/, '$1' + HLSTYLE + '>')), '④'],
    ['某普通页给新项加高亮（多行页）', mut('Periodic_Fetch.html', h => h.replace(/(<a href="\/Model_Workbench\.html")>/, '$1' + HLSTYLE + '>')), '④'],
    ['某页出现两个新项', mut('Sys_Iteration.html', h => h.replace(ANCHOR_RE, (x) => x + '\n' + x)), '②'],
    ['某页导航里的「模型中心」链接没了（页面集合少一页）', mut('Statistics.html', h => h.replace('<a href="/Model_Center.html">', '<a href="/Model_Center_x.html">')), '①'],
    // 31 L1 触发器高亮
    ['配置台「数据中心」触发器去掉高亮', mut(WORKBENCH, h => h.replace('<button class="nav-dropdown-trigger"' + HLSTYLE + '>', '<button class="nav-dropdown-trigger">')), '④ Model_Workbench.html'],
    ['目录页触发器高亮写法与配置台不一致', mut(CENTER, h => h.replace('<button class="nav-dropdown-trigger"' + HLSTYLE + '>', '<button class="nav-dropdown-trigger" style="color:#d97706; font-weight:700;">')), '④'],
    ['某普通页（单行页）触发器带高亮', mut('Quick_Log.html', h => h.replace('<button class="nav-dropdown-trigger">', '<button class="nav-dropdown-trigger"' + HLSTYLE + '>')), '④ Quick_Log.html'],
    // 31 L2
    ['新项与「模型中心」之间插入一个 <span></span>（多行页）', mut('Dashboard.html', h => h.replace(ANCHOR_RE, (x) => '<span></span>\n' + x)), '②'],
    ['新项与「模型中心」之间插入一个 <span></span>（单行页）', mut('Quick_Log.html', h => h.replace(ANCHOR_RE, (x) => '<span></span>' + x)), '②'],
    ['nav 顶层（下拉外）再放一份新项', mut('Task_Pool.html', h => { const i = h.indexOf('</nav>'); return h.slice(0, i) + '<a href="/Model_Workbench.html">模型配置台</a>\n' + h.slice(i); }), '② Task_Pool.html：整个 <nav>'],
    ['复制出第二个「数据中心」下拉块', mut('Metrics.html', dupDropdown), '① Metrics.html'],
  ];
  let bad = 0;
  for (const [label, fn, expectPrefix] of muts) {
    let probs;
    try { probs = check(fn(pages)); } catch (e) { console.log(`[self-test] FAIL ${label}：构造变异失败（${e.message}）`); bad++; continue; }
    if (!probs.length) { console.log(`[self-test] FAIL ${label}：变异后仍全绿（判别力不足）`); bad++; continue; }
    if (!probs.some(p => p.startsWith(expectPrefix))) { console.log(`[self-test] FAIL ${label}：判红了，但不是预期判据「${expectPrefix}」；实际问题：\n    ${probs.join('\n    ')}`); bad++; continue; }
    console.log(`[self-test] OK   ${label}：按预期判据「${expectPrefix}」判红（${probs.find(p => p.startsWith(expectPrefix)).slice(0, 110)}）`);
  }
  return bad ? 1 : 0;
}

function main() {
  const pages = loadPages();
  if (process.argv.includes('--self-test')) return selfTest(pages);
  const probs = check(pages);
  probs.forEach(p => console.log('[FAIL] ' + p));
  console.log(`[model-workbench-nav] 清单 ${EXPECTED_PAGES.length} 页；问题 ${probs.length}`);
  return probs.length ? 1 : 0;
}
process.exit(main());
