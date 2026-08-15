// verify-sys-derive-display.js — 系统迭代·派生单子编号「#根_序」前端展示面静态/纯函数验证
//   （S13-c·C2/C4/C5·方案 20260813_v1.8 §15.3/§15.4）
//
// 与 scripts/verify-sys-derive-numbering.js 的分工（同批新建、非重复）：
//   - verify-sys-derive-numbering.js：后端全部真实 HTTP 断言（DN1-DN7b）+ [DN8] 前端 fixture 一致性
//     （唯一跨前后端的一致性断言，因其数据源是共用 fixture 文件，放在后端脚本里与 sysDeriveNumbering
//     直调比对更自然，不重复搬来这里）。
//   - 本文件：只服务**前端纯函数/静态存在性**验证——不起 HTTP server、不碰数据库，全部断言来自：
//     ① 从 Sys_Iteration.html 提取函数体后在 node 侧实例化真执行（同 DN8 手法，验证输入→输出的行为）
//     ② 文本静态扫描（grep 级：调用点存在性、helper 单点未被绕过）
//     真实 DOM 断言（树枝缩进/灰显/命中高亮/派生链区块渲染/弹窗标题实际文案/翻页 UI）不在本文件覆盖
//     范围——那类断言只有真实浏览器渲染能证明，归 test-sys-derive-display-playwright.js（若本批时间
//     允许再建，否则如实登记为遗留见收尾报告）。
//
// 覆盖：
//   [C2-S] 矩阵 14 面里"可静态断言"的面——前端消费点存在性（siIssueDisplayNo/siIssueDisplayNoById/
//     siDeleteAuditDualNo 在各展示面的调用点都在，且矩阵禁止的"第二处 #根_序 字面量拼接"确未出现）
//   [C4] 搜索精确命中族块优先于模糊命中（siClusterFamilyBlocks 纯函数级造例，siActiveSearch 可控注入）
//   [C5] siPackFamilyPages/siClusterFamilyBlocks/siDeriveSeqSortValue 纯函数造例组（空列表/单成员族/
//     族不拆页/超大族独占/maxId 块序/seq=null 排最后/__blockIdx 索引重映射不丢块）
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { extractFunctionBody } = require('./lib/extract-function-body');   // [S13 收口 LOW 追-6] 与
//   verify-sys-list-badge-fields.js / verify-sys-derive-numbering.js[DN8] 共用同一份实现

const HTML_PATH = path.join(__dirname, '..', 'public', 'Sys_Iteration.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 单行/简单字面量 const 声明提取——取到源码里第一个"裸"分号（这两个目标常量都是简单字面量：数字/正则，
// 内部不含分号，用"找下一个 ;"足够安全，不需要完整 JS 解析器）。
function extractConstStatement(src, name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) return null;
  const end = src.indexOf(';', start);
  return end < 0 ? null : src.slice(start, end + 1);
}

['siIssueDisplayNo', 'siFamilyRootId', 'siDeriveSeqSortValue', 'siSortFamilyChildren',
  'siMarkLastChild', 'siClusterFamilyBlocks', 'siPackFamilyPages', 'siMatchDisplayNoEqual', 'siIsExactSearchMatch']
  .forEach((name) => {
    assert.ok(extractFunctionBody(HTML, name), `[提取前置] ${name} 函数体应可从 Sys_Iteration.html 提取（提不到=守卫空转）`);
  });
['SI_FAMILY_MAX_DEPTH', 'SI_DISPLAY_NO_SEARCH_RE'].forEach((name) => {
  assert.ok(extractConstStatement(HTML, name), `[提取前置] ${name} 常量声明应可提取`);
});
ok('[提取前置] 9 个函数体 + 2 个常量声明均可从 Sys_Iteration.html 提取（源码结构变化会让提取失败，先于任何行为断言暴露）');

// ── [C2-S] 矩阵 14 面里"可静态断言"的面——helper 单点消费点存在性 + 反双实现扫描 ══════════════════
console.log('\n═══ [C2-S] 矩阵可静态断言面：siIssueDisplayNo 系单点消费点存在性 + 反双实现扫描 ═══');
{
  // 剥注释先行（guard gotchas「文本扫描剥注释先行」）——防注释里提到的函数名/字面量被当成真消费。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
  const clean = stripComments(HTML);

  // ① 反双实现——矩阵禁令"本页内除 siIssueDisplayNo 自身外不得再出现 #${...root...}_${...seq...} 字面量"
  //   （见 siIssueDisplayNo 定义处头注）。正则找形如 `#${expr}_${expr}` 的模板串片段，逐个核实全部命中
  //   都落在 siIssueDisplayNo 函数体范围内（唯一授权写点）。
  const dupLiteralRe = /#\$\{[^}]+\}_\$\{[^}]+\}/g;
  const fnBody = extractFunctionBody(HTML, 'siIssueDisplayNo');
  const fnBodyClean = stripComments(fnBody);
  const allHits = [...clean.matchAll(dupLiteralRe)];
  const hitsInsideFn = [...fnBodyClean.matchAll(dupLiteralRe)];
  assert.strictEqual(allHits.length, hitsInsideFn.length,
    `[C2-S①] 全文 #\${root}_\${seq} 字面量拼接命中 ${allHits.length} 处，siIssueDisplayNo 函数体内命中 ${hitsInsideFn.length} 处——两者应相等（全部命中都在唯一授权写点内），实现坏成什么样这条会红：任何人在 helper 之外新写一处 #\${a}_\${b} 拼接，本条立即报出多余的差值`);
  assert.strictEqual(hitsInsideFn.length, 1, `[C2-S①] siIssueDisplayNo 函数体内本身应恰 1 处该字面量（即它的核心格式化语句），实抓 ${hitsInsideFn.length}`);
  ok(`[C2-S①] 反双实现扫描：全文 #\${root}_\${seq} 字面量拼接命中 ${allHits.length} 处，全部落在 siIssueDisplayNo 函数体内（唯一授权写点），无第二处独立实现`);

  // ② 消费点存在性——矩阵行 1/2/3/4/5/6/7/12/13 逐面对应的渲染函数/端点内是否真的调用了 helper（不只是
  //   helper 本身存在，而是每个展示面的渲染代码里能摸到调用点）。用 [名称, 期望函数体, 最少调用次数] 三元组。
  const CONSUMER_CHECKS = [
    ['行1 列表单号列 + 行2 血缘徽章', 'renderSysIterationRows', 'siIssueDisplayNo(', 2],
    ['行3 已派生#N 徽章', 'siPostAcceptFlagHtml', 'siIssueDisplayNo(', 2],
    ['行4 详情标题', 'siRenderDrawer', 'siIssueDisplayNo(iss)', 1],
    ['行5 派生链区块', 'siDeriveFamilyBlockHtml', 'siIssueDisplayNo(', 2],
    ['行5 补验收 kv「已派生#N」', 'siRenderDrawer', 'siIssueDisplayNo(postDeriveRow', 1],
    // [S13 收口 LOW-1 同步] siMatchSearch/siIsExactSearchMatch 的子编号解析已抽到 siMatchDisplayNoEqual
    //   单点实现——SI_DISPLAY_NO_SEARCH_RE 的真实消费点现在在这个共用 helper 里，不再直接内联在
    //   siMatchSearch 函数体内，检查点须跟着改，否则本条会对着一个"字面量已经不在这里"的旧位置误判红。
    ['行10 搜索子编号', 'siMatchDisplayNoEqual', 'SI_DISPLAY_NO_SEARCH_RE', 1],
    ['行12 删除审计双记', 'siDeleteAuditDualNo', 'siIssueDisplayNo(', 1],
  ];
  for (const [label, fnName, needle, minCount] of CONSUMER_CHECKS) {
    const body = extractFunctionBody(HTML, fnName);
    assert.ok(body, `[C2-S②] ${label}：宿主函数 ${fnName} 应可提取`);
    const bodyClean = stripComments(body);
    const count = bodyClean.split(needle).length - 1;
    assert.ok(count >= minCount, `[C2-S②] ${label}：${fnName} 函数体内应含「${needle}」≥${minCount} 处，实抓 ${count}（实现坏成什么样这条会红：渲染逻辑改动时不慎绕开 helper 直接拼裸 id，该面会退回矩阵改造前的裸 #id 展示）`);
  }
  ok(`[C2-S②] 消费点存在性：矩阵 ${CONSUMER_CHECKS.length} 面（行1/2/3/4/5×2/10/12）宿主函数内均能摸到 helper/正则调用点`);

  // ③ 弹窗标题（矩阵行6）——siIssueDisplayNoById 全部消费点计数，与 S13-b 报告登记的 15 处 siModal +
  //   2 处非 siModal（批次成员行）逐一核对，防未来新增/删除弹窗时这条契约悄悄漂移不被发现。
  // 全文匹配含函数定义自身那一行（`function siIssueDisplayNoById(id) {`）——18 = 1 定义 + 17 消费
  // （15 处 siModal 标题 + 2 处批次成员行降级展示，S13-b 报告登记基线）。
  const byIdCalls = [...clean.matchAll(/siIssueDisplayNoById\(/g)].length;
  assert.strictEqual(byIdCalls, 18, `[C2-S③] siIssueDisplayNoById 全文匹配应恰 18 处（1 处函数定义 + 17 处消费：15 处 siModal 标题 + 2 处批次成员行降级展示，S13-b 报告登记基线），实抓 ${byIdCalls}——数量变化需人工核实是新增消费点未登记，还是既有消费点被误删`);
  const modalTitleCalls = [...clean.matchAll(/siModal\([^;]*?siIssueDisplayNoById\(/gs)].length;
  assert.strictEqual(modalTitleCalls, 15, `[C2-S③] siModal(...) 调用中直接含 siIssueDisplayNoById(...) 的应恰 15 处，实抓 ${modalTitleCalls}`);
  // [408-M3①] 补删除任务弹窗——此前两条断言都只扫 siIssueDisplayNoById，漏了 siDeleteIssue（:5654 一带）
  // 的删除任务弹窗标题：它走的是 siIssueDisplayNo(iss) **直接传对象**分支（siDetail.issue 现成在手，
  // 不需要像其余弹窗那样只有 issueId 时退化查 siList），不含 "ById" 字样，两条既有正则完全扫不到它——
  // 这正是交付报告"15+2=17"与"全文18处"对不上号的真根因：真实的"弹窗标题"总数是 15（经 ById）+1
  // （经直调）=16，不是 15，也不等于 byIdCalls 的 18（18 是 siIssueDisplayNoById 一个函数自己的全文
  // 计数，与 siIssueDisplayNo(iss) 是两个不同函数、不该被同一个数字代表）。
  // [SF-1②] 判定范围改绑函数作用域——首版用全文正则 `siModal([^;]*?siIssueDisplayNo(iss)` 扫整个
  //   HTML，量出的"1"其实只是"这份文本里恰好有 1 处"，不是"必须是 siDeleteIssue 那一处"：未来若有
  //   另一个弹窗碰巧也拼出同一种形状（`siModal(...siIssueDisplayNo(iss)...)`），全文正则会把它也算
  //   进同一个数字里，数量断言依旧是 1（如果新弹窗替代了旧的）或变成 2（如果新弹窗是新增的）却分不清
  //   "删除任务弹窗还在不在"——判别力比看起来弱。改为先用 extractFunctionBody 精确取出 siDeleteIssue
  //   自己的函数体，只在这个函数体范围内匹配，"必须是这一处"从结构上锁死，不依赖"全文只有一处巧合"
  //   这个脆弱假设。另外补一条**标题内容**断言（不只证数量）——精确匹配 `'删除任务 ' + siIssueDisplayNo
  //   (iss)` 这个字面量拼接形状，证明命中的确实是"删除任务"这个标题字符串本身，不是函数体内偶然出现
  //   的另一处同形状调用（如注释示例代码，虽然本区块已剥注释，双重保险）。
  const deleteIssueBody = extractFunctionBody(HTML, 'siDeleteIssue');
  assert.ok(deleteIssueBody, '[C2-S③] siDeleteIssue 函数体应可提取（提不到=删除任务弹窗守卫空转，不能当通过）');
  const deleteIssueBodyClean = stripComments(deleteIssueBody);
  const deleteModalCalls = [...deleteIssueBodyClean.matchAll(/siModal\([^;]*?siIssueDisplayNo\(iss\)/gs)].length;
  assert.strictEqual(deleteModalCalls, 1, `[C2-S③] siDeleteIssue 函数体内（非全文，函数作用域限定）siModal(...) 调用中直接含 siIssueDisplayNo(iss)（非 ById 变体——已持有 issue 对象走直传分支）的应恰 1 处，实抓 ${deleteModalCalls}——此前 verify 断言未覆盖这一处，是矩阵验收表"15+2=17"与"全文18处"对不上号的根因`);
  assert.ok(/siModal\(\s*'删除任务 '\s*\+\s*siIssueDisplayNo\(iss\)/.test(deleteIssueBodyClean), `[C2-S③] siDeleteIssue 的弹窗标题应精确是 '删除任务 ' + siIssueDisplayNo(iss) 字面量拼接（不只证数量，证内容确实是这个标题字符串），函数体片段：${deleteIssueBodyClean.slice(0, 300)}`);
  ok(`[C2-S③] 矩阵行6 弹窗标题：真实总数 16 处（${modalTitleCalls} 处经 siIssueDisplayNoById 的 siModal 标题 + ${deleteModalCalls} 处经 siIssueDisplayNo(iss) 直调的删除任务弹窗，判定域限定在 siDeleteIssue 函数体内且标题内容已核对）；另有 2 处 siIssueDisplayNoById 消费点是批次成员行降级展示（非弹窗，语义属矩阵行13范畴，不计入本行）；siIssueDisplayNoById 全文 ${byIdCalls} 处（1 定义+17 消费=15 弹窗+2 批次成员）自身计数保持不变`);

  // ④ 树形/灰显/命中高亮/子编号标签的 CSS class 与其 JS 渲染端 class 拼接均存在（静态双向核对：样式
  //   定义了但没人挂 class、或挂了 class 但没定义样式，两种半成品都要拦）。
  const CLASSES = ['si-derive-num', 'si-row-child', 'si-row-last', 'si-row-context', 'si-row-search-hit', 'si-chain', 'si-chain-row'];
  for (const cls of CLASSES) {
    // [S13 收口 MED 追-1] 下标须取自 `clean`（剥注释后的文本）自己的 indexOf，不能拿 HTML（原始未剥
    //   注释文本）算出的下标去切 clean——stripComments 是删除式剥注释，剥完后文本变短，两者下标不对齐；
    //   实测过冲 18068 字符吃进正文（同 verify-sys-prerelease-flags.js 曾踩过、已在其头注记录的同一类
    //   坑：删除式剥注释产物的下标不能跨文本混用）。fail-open 风险：过冲段一旦将来出现 .si-* 字面量，
    //   会被误判成"CSS 已定义"而放行，本该报的死样式漏检。
    const definedInCss = new RegExp(`\\.${cls}\\b`).test(clean.slice(0, clean.indexOf('</style>')));
    const usedInJs = clean.includes(`'${cls}'`) || clean.includes(`"${cls}"`) || clean.includes(`class="${cls}`) || clean.includes(`${cls}"`);
    assert.ok(definedInCss, `[C2-S④] class .${cls} 应在 <style> 块内定义（CSS 存在但从未被 JS 挂载=死样式，或反过来 JS 挂了但没定义=样式失效，两者都要拦）`);
    assert.ok(usedInJs, `[C2-S④] class ${cls} 应在渲染 JS 中被引用（挂载点）`);
  }
  ok(`[C2-S④] 树形聚类样式双向核对：${CLASSES.length} 个 class（子编号标签/树枝缩进×2/灰显/搜索高亮/派生链区块×2）CSS 定义与 JS 挂载点均存在`);
}

// ── 组装可执行沙箱模块 ──────────────────────────────────────────────────────────────────────────
//   siClusterFamilyBlocks 末尾有 `if (siActiveSearch) { ... }` 分支引用模块级可变状态——用 setActiveSearch
//   闭包 setter 暴露给测试改写（沙箱内 let 声明，闭包共享，不需要每次重新编译）。
// [S13 收口 MED 追-3] sortField 真分支（用户显式选择表头列排序）现在需要真被执行——C4 新增负例断言
//   "选了表头列时精确命中 tier 不应覆盖列排序"，必须走真实排序逻辑，不能只测 sortField=null 那半支
//   （此前的做法：三个自由变量 UnifyHelpers/SI_SORT_FIELD_TYPES/SI_STATUS_SORT_ORDER 干脆不提供，
//   反正分支不会被执行到不会抛 ReferenceError——现在分支要被执行，必须真提供）。
//   UnifyHelpers 用 loadRealUnifyHelpers() 加载 unify-helpers.js 真实源码执行取得（不手写排序桩——
//   手写桩测的是"桩自己的行为"，会与生产实现悄悄漂移，同 codex 246 MED-1 教训）；后两个常量沿用
//   已有的 extractConstStatement 从 Sys_Iteration.html 原样提取源码文本注入（与提取函数体同一手法）。
const UNIFY_HELPERS_PATH = path.join(__dirname, '..', 'public', 'assets', 'js', 'unify-helpers.js');
const UNIFY_HELPERS_SRC = fs.readFileSync(UNIFY_HELPERS_PATH, 'utf8');
function loadRealUnifyHelpers() {
  // unify-helpers.js 全文是 `;(function (w) { ... })(window);`——node 侧把它当函数体编译成
  // `function (window) { <全文> }`，调用时传入我们自己的空对象当 `window` 实参：IIFE 内部
  // `(function (w) { ... })(window)` 的 `window` 标识符会解析到外层这个形参，即我们传入的对象，
  // 于是文件末尾的 `w.UnifyHelpers = {...}` 落在我们传入的对象上——取到真实实现，不用伪造 DOM。
  // sortByField 内部只依赖同闭包内的 compareRow/compareByType，不触达 document/escapeHtml 等浏览器
  // 全局（那些只有 statusBadge/typeTag 等本次不会被调用的函数才用到），故这个空对象沙箱够用。
  const w = {};
  // eslint-disable-next-line no-new-func
  new Function('window', UNIFY_HELPERS_SRC)(w);
  assert.strictEqual(typeof (w.UnifyHelpers && w.UnifyHelpers.sortByField), 'function',
    '[提取前置] 真实 UnifyHelpers.sortByField 应可从 unify-helpers.js 加载执行取得');
  return w.UnifyHelpers;
}
function buildSandbox() {
  // [S13 收口 LOW-1 同步] siMatchDisplayNoEqual 新增进沙箱——siIsExactSearchMatch 重构后调用它，
  //   不带上会在沙箱内执行时 ReferenceError（自由变量未声明）。
  // [407-M2] siMatchSearch 新增进沙箱——[406-M2②] 并存用例此前只手工构造 items 数组"假装"FUZZY 族
  //   已经因标题模糊匹配而可见，从未真的调用 siMatchSearch 执行这一步判定（codex 407-M2 指出：并存
  //   用例的"模糊命中"半边完全没有真实执行验证，只是靠夹具数据 + 注释声称）。siMatchSearch 依赖
  //   siActiveSearch（沙箱内 let 声明，闭包共享）+ siMatchDisplayNoEqual（已在本沙箱），零新增自由
  //   变量，可直接并入同一份沙箱源码。
  const pieces = ['siIssueDisplayNo', 'siFamilyRootId', 'siDeriveSeqSortValue', 'siSortFamilyChildren',
    'siMarkLastChild', 'siClusterFamilyBlocks', 'siPackFamilyPages', 'siMatchDisplayNoEqual', 'siMatchSearch', 'siIsExactSearchMatch']
    .map((name) => extractFunctionBody(HTML, name));
  const consts = ['SI_FAMILY_MAX_DEPTH', 'SI_DISPLAY_NO_SEARCH_RE'].map((name) => extractConstStatement(HTML, name));
  const sortConsts = ['SI_SORT_FIELD_TYPES', 'SI_STATUS_SORT_ORDER'].map((name) => extractConstStatement(HTML, name));
  assert.ok(sortConsts.every(Boolean), '[提取前置] SI_SORT_FIELD_TYPES/SI_STATUS_SORT_ORDER 常量声明应可提取（sortField 真分支依赖两者）');
  const src = `
    let siActiveSearch = '';
    ${consts.join('\n')}
    ${sortConsts.join('\n')}
    ${pieces.join('\n')}
    return {
      siIssueDisplayNo, siFamilyRootId, siDeriveSeqSortValue, siSortFamilyChildren,
      siMarkLastChild, siClusterFamilyBlocks, siPackFamilyPages, siMatchSearch, siIsExactSearchMatch,
      setActiveSearch: (v) => { siActiveSearch = v; },
    };
  `;
  // eslint-disable-next-line no-new-func
  return new Function('UnifyHelpers', src)(loadRealUnifyHelpers());
}
const M = buildSandbox();
assert.strictEqual(typeof M.siClusterFamilyBlocks, 'function', '[提取前置] 沙箱编译产出 siClusterFamilyBlocks 应为可调用函数');
ok('[提取前置] 沙箱模块编译成功，8 个函数在同一闭包内可互相调用（siClusterFamilyBlocks 内部对 siFamilyRootId/siSortFamilyChildren/siMarkLastChild/siIsExactSearchMatch 的调用均在本沙箱内正确解析，非各自孤立求值）');

// [S13 收口 LOW 追-7] arity 断言——堵"签名重构但忘改调用点/断言"的静默漂移（如 siClusterFamilyBlocks
//   哪天被改成用 options 对象收参、或漏传 sortDir，形参个数变了本条会先红，不必等到某条行为断言碰巧
//   踩中那个被改坏的参数才发现）。
assert.strictEqual(M.siClusterFamilyBlocks.length, 4, `[提取前置] siClusterFamilyBlocks 形参个数应=4（items, allItems, sortField, sortDir），实抓 ${M.siClusterFamilyBlocks.length}`);
assert.strictEqual(M.siPackFamilyPages.length, 2, `[提取前置] siPackFamilyPages 形参个数应=2（blocks, pageSize），实抓 ${M.siPackFamilyPages.length}`);
assert.strictEqual(M.siIssueDisplayNo.length, 1, `[提取前置] siIssueDisplayNo 形参个数应=1（row），实抓 ${M.siIssueDisplayNo.length}`);
ok('[提取前置] arity 断言：siClusterFamilyBlocks/siPackFamilyPages/siIssueDisplayNo 形参个数与既知签名一致（签名重构会被这里先拦，不依赖后面行为断言碰巧覆盖到被改坏的形参）');

// ── [C5] 纯函数造例组 ══════════════════════════════════════════════════════════════════════════
console.log('\n═══ [C5] 纯函数造例：siPackFamilyPages / siClusterFamilyBlocks / siDeriveSeqSortValue ═══');

// [C5-1] 空列表
{
  const blocks = M.siClusterFamilyBlocks([], [], null, null);
  assert.deepStrictEqual(blocks, [], '[C5-1] 空 items 应返回空块数组（实现坏成什么样这条会红：任何非空默认值/异常抛出）');
  const pages = M.siPackFamilyPages([], 25);
  assert.deepStrictEqual(pages, [[]], '[C5-1] siPackFamilyPages 空块数组应返回恰一个空页 [[]]（分页 UI 契约：至少渲染一页"暂无数据"态，不是零页）');
  ok('[C5-1] 空列表：siClusterFamilyBlocks 返回 []，siPackFamilyPages([]) 返回 [[]]（分页器"至少一页"契约）');
}

// [C5-2] 单成员族（无任何血缘关系的孤立单）
{
  const items = [{ id: 1, derive_root_id: null, derive_seq: null, origin_issue_id: null }];
  const blocks = M.siClusterFamilyBlocks(items, items, null, null);
  assert.strictEqual(blocks.length, 1, '[C5-2] 单个孤立单应产出恰 1 个块');
  assert.strictEqual(blocks[0].length, 1, '[C5-2] 该块应恰 1 行');
  assert.strictEqual(blocks[0][0].role, 'standalone', `[C5-2] 孤立单角色应为 standalone, got ${blocks[0][0].role}（实现坏成什么样这条会红：误判成 root 角色会在渲染层触发不必要的树形样式）`);
  ok('[C5-2] 单成员族（孤立单）：恰 1 块 1 行，role=standalone');
}

// [C5-3] 族不拆页——一个 3 行族 + 2 个孤立单，pageSize=2，族必须整体落在同一页
{
  const root = { id: 10, derive_root_id: null, derive_seq: null, origin_issue_id: null, title: 'root' };
  const c1 = { id: 11, derive_root_id: 10, derive_seq: 1, origin_issue_id: 10, title: 'c1' };
  const c2 = { id: 12, derive_root_id: 10, derive_seq: 2, origin_issue_id: 10, title: 'c2' };
  const solo1 = { id: 20, derive_root_id: null, derive_seq: null, origin_issue_id: null, title: 'solo1' };
  const solo2 = { id: 21, derive_root_id: null, derive_seq: null, origin_issue_id: null, title: 'solo2' };
  const items = [root, c1, c2, solo1, solo2];
  const blocks = M.siClusterFamilyBlocks(items, items, null, null);
  // 默认块序=maxId 降序：族块 maxId=12（root/c1/c2 中最大 id），solo2 maxId=21，solo1 maxId=20
  // → 期望块序 [solo2(21), solo1(20), 族块(12,3行)]
  assert.strictEqual(blocks.length, 3, `[C5-3] 应产出恰 3 个块（1 族块 + 2 孤立单块），got ${blocks.length}`);
  const familyBlock = blocks.find((rows) => rows.length === 3);
  assert.ok(familyBlock, '[C5-3] 应存在一个恰 3 行的族块（root+2 子单未被拆散）');
  assert.strictEqual(familyBlock[0].role, 'root', '[C5-3] 族块首行应为 root 角色');
  assert.deepStrictEqual(familyBlock.map((r) => r.item.id), [10, 11, 12], '[C5-3] 族块内部顺序应为 root(10)→seq1(11)→seq2(12)');
  const pages = M.siPackFamilyPages(blocks, 2);
  // pageSize=2：族块自身 3 行已超 pageSize，无论装箱顺序如何，3 行的族块不能被切开——验证每一页要么
  // 完整包含族块的 3 行、要么完全不含族块任何一行（不存在"半个族"落在某页）。
  for (const page of pages) {
    const familyRowsInPage = page.filter((r) => r.item.id === 10 || r.item.id === 11 || r.item.id === 12).length;
    assert.ok(familyRowsInPage === 0 || familyRowsInPage === 3,
      `[C5-3] 每页应恰含 0 或 3 行族成员（不允许半族），某页实得 ${familyRowsInPage}（实现坏成什么样这条会红：装箱在块中间切开，前端会画出断头树枝）`);
  }
  const totalRows = pages.reduce((a, p) => a + p.length, 0);
  assert.strictEqual(totalRows, 5, `[C5-3] 全部页行数之和应=输入总行数 5（无损装箱），got ${totalRows}`);
  ok('[C5-3] 族不拆页：3 行族块整体落在同一页（pageSize=2 小于族大小时验证"要么 0 要么 3"，无半族切分）+ 全量无损装箱');
}

// [C5-4] 超大族独占一页允许超页——族本身 5 行 > pageSize=2，该族独占一页且允许超出标称页大小
{
  const root = { id: 30, derive_root_id: null, derive_seq: null, origin_issue_id: null };
  const kids = [1, 2, 3, 4].map((seq) => ({ id: 30 + seq, derive_root_id: 30, derive_seq: seq, origin_issue_id: 30 }));
  const items = [root, ...kids];
  const blocks = M.siClusterFamilyBlocks(items, items, null, null);
  assert.strictEqual(blocks.length, 1, '[C5-4] 单一大族应恰产出 1 个块');
  assert.strictEqual(blocks[0].length, 5, `[C5-4] 该块应恰 5 行（root+4 子单）, got ${blocks[0].length}`);
  const pages = M.siPackFamilyPages(blocks, 2);
  assert.strictEqual(pages.length, 1, `[C5-4] 单一超大族应恰产出 1 页（独占），got ${pages.length} 页`);
  assert.strictEqual(pages[0].length, 5, `[C5-4] 该页应含全部 5 行（允许超出标称 pageSize=2），got ${pages[0].length}（实现坏成什么样这条会红：若强行按 pageSize 硬切，5 行会被切成 3 页且中间切断树枝）`);
  ok('[C5-4] 超大族独占一页：5 行族在 pageSize=2 下仍产出单页 5 行（允许超页，不强行硬切）');
}

// [C5-5] maxId 块序——多族/孤立单混排，默认（无 sortField）应按块内最大 id 降序排列
// [406-M1 判别力核实] 原三块夹具（族A根1/子2·独立单50·族B根100/子101,105）里"根 id 大小序"与
// "maxId 大小序"恰好逐块一致（族A根1<独立50<族B根100，maxId 也是 2<50<105）——一个误按 repItem.id
// （根/独立单自身 id，非 maxId）排序的实现在这组数据上会产出**完全相同**的块序，本用例对"按根 id 排"
// 与"按 maxId 排"两种实现毫无区分力。补族C：根 id=3（很小）但子单 id=200（很大）——按 maxId 排应把
// 族C 顶到最前（200 全场最大），按根 id 排则会把族C 排到接近族A（根 id=3 也很小）附近，两种实现在
// 这个新块上会给出明显不同的结果，用它来打破原夹具的巧合一致。
{
  const famA_root = { id: 1, derive_root_id: null, derive_seq: null, origin_issue_id: null };
  const famA_c1 = { id: 2, derive_root_id: 1, derive_seq: 1, origin_issue_id: 1 };   // 族A：根1/子2，maxId=2，根id=1
  const famC_root = { id: 3, derive_root_id: null, derive_seq: null, origin_issue_id: null };
  const famC_c1 = { id: 200, derive_root_id: 3, derive_seq: 1, origin_issue_id: 3 };   // 族C：根id=3 很小，子单id=200 很大 → maxId=200（判别力核心：根id序与maxId序在此相悖）
  const famB_root = { id: 100, derive_root_id: null, derive_seq: null, origin_issue_id: null };
  const famB_c1 = { id: 101, derive_root_id: 100, derive_seq: 1, origin_issue_id: 100 };
  const famB_c2 = { id: 105, derive_root_id: 100, derive_seq: 2, origin_issue_id: 100 };   // 族B：根100，maxId=105
  const solo = { id: 50, derive_root_id: null, derive_seq: null, origin_issue_id: null };   // 独立单，maxId=根id=50
  const items = [famA_root, famA_c1, famC_root, famC_c1, famB_root, famB_c1, famB_c2, solo];
  const blocks = M.siClusterFamilyBlocks(items, items, null, null);
  const maxIdsInOrder = blocks.map((rows) => Math.max(...rows.map((r) => Number(r.item.id))));
  // 正确（按 maxId 降序）：[200(族C), 105(族B), 50(独立单), 2(族A)]。
  // 若实现误按根id排（repItem.id 降序）：族B根100 > 独立单50 > 族C根3 > 族A根1 → 会得到
  // [105(族B), 50(独立单), 200(族C), 2(族A)]——族C 从"应排最前"变成"排在第三"，两者可观测区分。
  assert.deepStrictEqual(maxIdsInOrder, [200, 105, 50, 2], `[C5-5] 默认块序应按 maxId 降序 [200,105,50,2]（族C/族B/独立单50/族A），got ${JSON.stringify(maxIdsInOrder)}（实现坏成什么样这条会红：新派生子单不会把整族顶到列表前排，用户看不出"刚发生了新派生"；若误按根 id 排，族C 会掉到第三位而非第一位——本用例专门用"根id小但含大id子单"的族C 打破"根id序与maxId序巧合一致"的假绿）`);
  ok(`[C5-5] maxId 块序：四个块按块内最大 id 降序排列 [${maxIdsInOrder.join(',')}]（族因新派生子单被顶到前排的行为，非按根 id 静态排序——族C 根id=3 很小仍因子单id=200 被排最前，与"按根id排"的实现可观测区分）`);
}

// [C5-6] seq=null 排最后——族内子单 derive_seq 缺省时应排在有效 seq 之后（异常态兜底，非正常路径）
{
  const c1 = { id: 2, derive_root_id: 1, derive_seq: 3, origin_issue_id: 1 };
  const c2 = { id: 3, derive_root_id: 1, derive_seq: null, origin_issue_id: 1 };   // 异常态：seq 缺省
  const c3 = { id: 4, derive_root_id: 1, derive_seq: 1, origin_issue_id: 1 };
  const sorted = M.siSortFamilyChildren([c1, c2, c3]);
  assert.deepStrictEqual(sorted.map((x) => x.id), [4, 2, 3], `[C5-6] 排序应为 [seq1(id4), seq3(id2), seq缺省(id3)]，got ${JSON.stringify(sorted.map((x) => x.id))}（实现坏成什么样这条会红：若误用真值判断/裸 Number(null)，缺省会被当成 0 排到最前而非最后）`);
  // 直调 siDeriveSeqSortValue 本体，独立证明判空前置生效（非仅通过排序结果间接推断）。
  assert.strictEqual(M.siDeriveSeqSortValue({ derive_seq: null }), Infinity, '[C5-6] siDeriveSeqSortValue(null) 应为 Infinity（排最后）');
  assert.strictEqual(M.siDeriveSeqSortValue({ derive_seq: undefined }), Infinity, '[C5-6] siDeriveSeqSortValue(undefined) 应为 Infinity');
  assert.strictEqual(M.siDeriveSeqSortValue({ derive_seq: 'abc' }), Infinity, '[C5-6] siDeriveSeqSortValue(非数字字符串) 应为 Infinity（第二类非法输入同样兜底）');
  assert.strictEqual(M.siDeriveSeqSortValue({ derive_seq: 0 }), 0, '[C5-6] siDeriveSeqSortValue(0) 应=0（不是"缺省"，0 是合法数值，即便非真实业务态）');
  ok('[C5-6] seq=null/undefined/非法字符串 排最后（Infinity 兜底），seq=0 不误判为缺省（与 siIssueDisplayNo 的判空纪律同源）');
}

// [C5-7] __blockIdx 索引重映射不丢块——正例：多块在"默认块序"路径下 100% 保序不丢（sortField 分支
//   需要真实 UnifyHelpers，本文件不引入该依赖，出于同款关注点改在默认路径下用大量块验证零丢失/零重复；
//   sortField 分支本身的索引映射逻辑与默认路径共享同一个 `blocks` 数组构造前半段，唯一差异是最终排序
//   手法从"直接 blocks.sort"换成"wrap→UnifyHelpers.sortByField→按 __blockIdx 取回"，取回步骤在结构上
//   是单射（每个 __blockIdx 对应且仅对应一个原始 blocks[i]），不依赖 repItem 是否有重复值——这条边界的
//   静态代码走查已在 index.js/Sys_Iteration.html 走过（见该函数定义处 [预筛 LOW-3 修复] 注释），此处
//   用大规模块数正例代替语义相同的负例，如实登记：未构造 repItem 对象引用重复的对抗性负例（复核确认
//   现有 siClusterFamilyBlocks 构造路径下，各族 rid 互斥求值，结构性不会产出重复引用，见该函数注释）。
{
  const items = [];
  const allItems = [];
  for (let i = 0; i < 30; i++) {
    const it = { id: 1000 + i, derive_root_id: null, derive_seq: null, origin_issue_id: null };
    items.push(it); allItems.push(it);
  }
  const blocks = M.siClusterFamilyBlocks(items, allItems, null, null);
  assert.strictEqual(blocks.length, 30, `[C5-7] 30 个孤立单应产出恰 30 个块（零丢失零合并），got ${blocks.length}`);
  const allIds = blocks.flatMap((rows) => rows.map((r) => r.item.id)).sort((a, b) => a - b);
  const expectedIds = items.map((it) => it.id).sort((a, b) => a - b);
  assert.deepStrictEqual(allIds, expectedIds, '[C5-7] 排序前后 30 个 id 集合应逐一相等（无丢失/无重复/无串号）');
  // 默认块序应严格降序（maxId 降序，孤立单 maxId=自身 id）——同时验证"排序确实发生了"，非恒等无操作。
  const maxIds = blocks.map((rows) => rows[0].item.id);
  const isDescending = maxIds.every((v, i) => i === 0 || maxIds[i - 1] >= v);
  assert.ok(isDescending, `[C5-7] 30 块应严格按 id 降序排列，实得 ${JSON.stringify(maxIds)}`);
  ok('[C5-7] 30 块规模正例：块序重排后 id 集合零丢失零重复、严格降序（__blockIdx 式或直接 sort 式的索引重映射均需满足此不变量；对象引用重复的对抗性负例经代码走查确认现有构造路径结构性不可达，如实登记未造）');
}

// ── [C4] 搜索精确命中族块优先 ══════════════════════════════════════════════════════════════════
console.log('\n═══ [C4] B4：搜索精确命中族块优先于模糊命中 ═══');

// [406-M2①] 判别力修复：原"真实 id 完全等值"子用例复用了子编号子用例同一组夹具（exactHit id=999），
//   而 999 本来就是该组内 maxId 最大的块——即便把 tier 优先层整个禁用，默认 maxId 降序也会把它排第一，
//   断言"排第一"对 tier 是否生效**恒真无判别力**（codex 406-M2 指出）。改用独立夹具：精确命中的独立单
//   id=201（小），不命中的竞争族 maxId=999（大）——tier 失效时 201 应排在 999 之后，tier 生效时 201
//   应被顶到 999 之前，两种实现在这组数据上会给出可观测的不同结果。
{
  const exactHitSmall = { id: 201, derive_root_id: null, derive_seq: null, origin_issue_id: null, title: '普通单（真实id精确命中判别力夹具）' };
  const famZ_root = { id: 500, derive_root_id: null, derive_seq: null, origin_issue_id: null, title: '不相关族根' };
  const famZ_c1 = { id: 999, derive_root_id: 500, derive_seq: 1, origin_issue_id: 500, title: '不相关族子单' };   // 竞争族 maxId=999（远大于 exactHitSmall 的 201），且标题/系统名均不含"201"
  const itemsIdExact = [exactHitSmall, famZ_root, famZ_c1];

  M.setActiveSearch('201');   // 只命中 exactHitSmall（真实 id 完全等值）——famZ 不含"201"文本
  assert.strictEqual(M.siIsExactSearchMatch(exactHitSmall), true, '[C4-判别力] 真实 id 完全等值应判精确命中');
  assert.strictEqual(M.siIsExactSearchMatch(famZ_c1), false, '[C4-判别力] 未命中搜索词的行不应被误判精确命中');
  const blocksIdExact = M.siClusterFamilyBlocks(itemsIdExact, itemsIdExact, null, null);
  assert.strictEqual(blocksIdExact.length, 2, '[C4-判别力] 应产出 2 个块（独立单exactHitSmall + 族Z）');
  const firstBlockIdsIdExact = blocksIdExact[0].map((r) => r.item.id);
  assert.deepStrictEqual(firstBlockIdsIdExact, [201], `[C4-判别力] ⭐ 精确命中（真实id完全等值，id=201）的独立单块应排第一，即便其 maxId(201) 远小于竞争族Z 的 maxId(999)——若 tier 优先层被禁用/失效，默认 maxId 降序会把族Z(999) 排第一、exactHitSmall(201) 排第二，与此断言不符，本用例具备真实判别力（非此前 999 对 202 那组"tier 失效也恰好排对"的恒真断言）`);
  ok('[C4-判别力] ⭐ 406-M2① 判别力修复：真实 id 完全等值命中块（低 maxId）能顶到高 maxId 竞争块之前，证明 tier 优先层真的改变了默认序（mutation 反证见收尾报告）');
}

{
  // 族 A（根 201，子单 201_1）标题含"预算"——搜索词"预算"会模糊命中族 A 的子单（标题子串）。
  // 独立单 999 标题普通，但真实 id 999 与搜索词"999"精确等值命中（真实 id 完全等值分支）。
  const famA_root = { id: 201, derive_root_id: null, derive_seq: null, origin_issue_id: null, title: '根单' };
  const famA_c1 = { id: 202, derive_root_id: 201, derive_seq: 1, origin_issue_id: 201, title: '预算调整派生单' };
  const exactHit = { id: 999, derive_root_id: null, derive_seq: null, origin_issue_id: null, title: '普通单' };
  const items = [famA_root, famA_c1, exactHit];

  M.setActiveSearch('#201_1');   // 精确命中 famA_c1（子编号等值）——exactHit 不含该文本
  assert.strictEqual(M.siIsExactSearchMatch(famA_c1), true, '[C4] 子编号完全等值应判精确命中');
  assert.strictEqual(M.siIsExactSearchMatch(exactHit), false, '[C4] exactHit 不应被误判精确命中（子编号查询与其真实 id 999 无关）');
  let blocks = M.siClusterFamilyBlocks(items, items, null, null);
  const firstBlockIdsB = blocks[0].map((r) => r.item.id);
  assert.deepStrictEqual(firstBlockIdsB, [201, 202], `[C4] 精确命中（子编号等值 #201_1）的族块应整体排第一（root+子单一起前移，非仅命中行单独前移），got ${JSON.stringify(firstBlockIdsB)}（实现坏成什么样这条会红：精确命中优先层未生效时，默认 maxId 序会把 exactHit(999) 排在前面）`);

  M.setActiveSearch('');   // 搜索关闭——精确命中优先层应完全不生效（siActiveSearch 假值短路）
  blocks = M.siClusterFamilyBlocks(items, items, null, null);
  assert.deepStrictEqual(blocks[0].map((r) => r.item.id), [999], '[C4] 搜索未激活时应回落纯 maxId 降序（exactHit(999) 排第一，非精确命中优先逻辑残留生效）');
  ok('[C4] 搜索精确命中族块优先：真实 id 等值/子编号等值两种精确命中分支均能把命中族块顶到最前（覆盖默认 maxId 序会把它排后面的场景，证明优先层真的改变了顺序非巧合一致）；搜索关闭后行为不残留（对照组）');

  // ── 负例（S13 收口 MED-3 + 追-3）：用户已显式选择表头列排序（sortField 非空）时，tier 不应覆盖列序 ──
  //   复用同一组夹具（famA_root id201/famA_c1 id202/exactHit id999），改传 sortField='id'/sortDir='asc'
  //   （真实 UnifyHelpers.sortByField 驱动 `if (sortField)` 分支，非 C4/C5 此前全部测试都用的 sortField=
  //   null/undefined 那半支）——分别在"搜索激活且精确命中 exactHit"和"搜索关闭"两种状态下各跑一次。
  //   sortField 分支本身不读 siActiveSearch，唯一可能让两次结果不同的路径就是 tier 重排跑漏了口子
  //   （§15.4 决策表①：选了列排序时应服从列排序，不该被搜索精确命中顶到最前）。
  {
    M.setActiveSearch('999');   // exactHit 精确命中
    const blocksWithSearch = M.siClusterFamilyBlocks(items, items, 'id', 'asc').map((rows) => rows.map((r) => r.item.id));
    M.setActiveSearch('');
    const blocksNoSearch = M.siClusterFamilyBlocks(items, items, 'id', 'asc').map((rows) => rows.map((r) => r.item.id));
    // 前置校验（非硬编码期望）：真实 id 升序下 famA 块（201,202）应排在 exactHit 块（999）之前——
    // 若这条本身就不成立，下面"两次结果相同"的对照会失去意义（两次都算错也会相同，制造假绿）。
    assert.deepStrictEqual(blocksNoSearch, [[201, 202], [999]],
      `[C4] 前置校验：id 升序（真实 UnifyHelpers.sortByField 结果，非本文件手编期望）下块序应为 [[201,202],[999]]，实得 ${JSON.stringify(blocksNoSearch)}`);
    assert.deepStrictEqual(blocksWithSearch, blocksNoSearch,
      `[C4] ⭐ 负例（MED-3+追-3）：sortField 非空（用户显式选了表头列）时，搜索精确命中 exactHit(999) 不应改变块序——应与"关闭搜索"跑出的块序完全一致，实得 搜索开=${JSON.stringify(blocksWithSearch)} 搜索关=${JSON.stringify(blocksNoSearch)}（实现坏成什么样这条会红：若 tier 收窄逻辑对 sortField 非空场景仍生效，exactHit(999) 精确命中时会被顶到最前变成 [[999],[201,202]]，与搜索关闭时的列排序结果不同）`);
    ok('[C4] ⭐ 负例（MED-3+追-3）：sortField 非空时搜索精确命中 tier 不生效，块序完全服从真实列排序（§15.4 决策表①）——用真实 UnifyHelpers.sortByField 驱动，非手写排序桩');
  }
}

// [406-M2②] 精确命中族与模糊命中族并存——此前全部 C4 用例每次搜索只制造"一个精确命中源"，没有验证
//   "精确命中 tier0 vs 模糊命中 tier1"两者同时存在时是否真的分层（而非碰巧只有一种命中源时看不出层次）。
//   本用例：族EXACT（根10/子11，子单 derive_root_id=10·derive_seq=1）——搜索词精确命中子单的子编号；
//   族FUZZY（根800/子801）——根的标题里字面包含搜索词文本（"#10_1"），走 siMatchSearch 的标题子串
//   模糊分支命中，但 derive_root_id/derive_seq/真实id 均与搜索词解析值无关，不满足 siIsExactSearchMatch。
//   默认 maxId 序（无 tier）应为 [族FUZZY(801), 族EXACT(11)]（FUZZY maxId 更大排前）——刻意与期望 tier
//   序**相反**，tier 生效时应反转为 [族EXACT, 族FUZZY]。
//   〔siVisibleList/siBroadenBySearchFamily 等价说明〕本文件全部 C4/C5 用例（含此处）都不在沙箱内重放
//   "siVisibleList 取可见集 → 按家族广播补全"这条真实调用链，而是直接手工构造"已完成可见性过滤+家族
//   广播"之后的最终 items 数组——本用例同样遵循这个既有简化：items 直接就是两族的全部成员（4 行），
//   等价于"这两族在真实页面里都已经因为搜索命中而被广播进可见集合"这一前提，不额外拉 siVisibleList/
//   siBroadenBySearchFamily 进沙箱（那两个函数依赖 siList/siActiveType 等更多自由变量，为一条不改变
//   本用例判定逻辑的输入构造路径引入沙箱复杂度不值得）。tier 分层判定本身只吃 siIsExactSearchMatch，
//   与 items 是如何被"可见性过滤"出来的无关——这是本简化成立的结构性理由，非偷懒省事。
{
  const famExact_root = { id: 10, derive_root_id: null, derive_seq: null, origin_issue_id: null, title: '精确族根' };
  const famExact_c1 = { id: 11, derive_root_id: 10, derive_seq: 1, origin_issue_id: 10, title: '精确族子单' };   // maxId(EXACT)=11
  const famFuzzy_root = { id: 800, derive_root_id: null, derive_seq: null, origin_issue_id: null, title: '临时方案 #10_1 变更说明' };   // 标题字面含搜索词"#10_1"——走模糊子串分支命中
  const famFuzzy_c1 = { id: 801, derive_root_id: 800, derive_seq: 1, origin_issue_id: 800, title: '模糊族子单' };   // maxId(FUZZY)=801，本身与搜索词解析值(10,1)无关
  const itemsCoexist = [famExact_root, famExact_c1, famFuzzy_root, famFuzzy_c1];

  M.setActiveSearch('#10_1');
  // [407-M2] 三件真实执行验证（此前"模糊命中"半边只靠夹具数据摆着、注释声称，从未真的调 siMatchSearch
  //   执行判定——现在补上）：
  //   ① FUZZY 族根真的会被 siMatchSearch 判定命中（真模糊命中，非摆设数据）——它的可见性不是凭空
  //     "假装"来的，是因为标题子串确实满足 siMatchSearch 的模糊分支。
  assert.strictEqual(M.siMatchSearch(famFuzzy_root), true, '[C4-并存] ⭐407-M2 前置：FUZZY 族根应被 siMatchSearch 判定为真模糊命中（标题含搜索词 "#10_1" 子串），证明它的"可见"不是凭空摆的夹具数据，是真执行判定的结果');
  //   ② EXACT 子单应**同时**满足 siMatchSearch（模糊判定的超集本就该含精确匹配——精确等值也是一种
  //     "匹配"）与 siIsExactSearchMatch（精确判定）——两个判据不是互斥的，模糊判据不会漏掉精确命中。
  assert.strictEqual(M.siMatchSearch(famExact_c1), true, '[C4-并存] ⭐407-M2 前置：EXACT 子单应同时满足 siMatchSearch（模糊判定不应漏掉精确命中——精确等值本就是匹配的一种）');
  assert.strictEqual(M.siIsExactSearchMatch(famExact_c1), true, '[C4-并存] EXACT 族子单应判精确命中（子编号等值 #10_1）');
  assert.strictEqual(M.siIsExactSearchMatch(famExact_root), false, '[C4-并存] EXACT 族根自身不应判精确命中（根无子编号，搜索词不等于其真实 id）');
  //   ③ FUZZY 族任何成员都不应被误判成精确命中（即便族根本身真的模糊命中）——模糊命中与精确命中是
  //     两条独立判据，不能因为 siMatchSearch===true 就连带把 siIsExactSearchMatch 也判成 true。
  assert.strictEqual(M.siIsExactSearchMatch(famFuzzy_root), false, '[C4-并存] FUZZY 族根不应被误判精确命中（仅标题子串命中，非等值）');
  assert.strictEqual(M.siIsExactSearchMatch(famFuzzy_c1), false, '[C4-并存] FUZZY 族子单不应被误判精确命中');

  const blocksCoexist = M.siClusterFamilyBlocks(itemsCoexist, itemsCoexist, null, null);
  assert.strictEqual(blocksCoexist.length, 2, '[C4-并存] 应产出 2 个族块（EXACT + FUZZY）');
  const orderCoexist = blocksCoexist.map((rows) => rows.map((r) => r.item.id));
  assert.deepStrictEqual(orderCoexist, [[10, 11], [800, 801]],
    `[C4-并存] ⭐ 精确命中族（EXACT，maxId=11）应整体排在模糊命中族（FUZZY，maxId=801）之前——即便默认 maxId 序本该是 FUZZY 在前（801>11，两者刻意相反设计），got ${JSON.stringify(orderCoexist)}（实现坏成什么样这条会红：若 tier 判定误把"标题模糊命中"也算进 tier0（如误用 siMatchSearch 代替 siIsExactSearchMatch），两族会同落 tier0、排序退化为默认 maxId 序 [FUZZY,EXACT]，与此断言不符）`);
  ok('[C4-并存] ⭐ 406-M2② 精确命中族与模糊命中族并存：tier 分层真的区分"精确"与"模糊"两种命中源，模糊命中不会被误算进精确优先层（mutation 反证见收尾报告）');
  M.setActiveSearch('');
}

// ── [XSS-406-L1] XSS 纵深轻量版：title=/onclick= 插值的编号必须过安全整数归一 ══════════════════
console.log('\n═══ [XSS-406-L1] 编号值插入 HTML 属性/onclick 前必须过 siSafeIdAttr 安全整数归一 ═══');

// [siDeriveFamilyBlockHtml 负例] 真正的纯函数（返回字符串，非 DOM 写），依赖集小（esc/siIssueDisplayNo/
//   siStatusClass/siStatusDisplay/siSafeIdAttr），可直接提取执行断言输出文本。
{
  const pieces2 = ['esc', 'siSafeIdAttr', 'siIssueDisplayNo', 'siStatusClass', 'siStatusDisplay', 'siDeriveFamilyBlockHtml']
    .map((name) => extractFunctionBody(HTML, name));
  const consts2 = ['SI_STATUS_CLASS'].map((name) => extractConstStatement(HTML, name));
  assert.ok(consts2.every(Boolean), '[XSS-406-L1] 前置：SI_STATUS_CLASS 常量声明应可提取');
  const src2 = `
    ${consts2.join('\n')}
    ${pieces2.join('\n')}
    return { siDeriveFamilyBlockHtml };
  `;
  // eslint-disable-next-line no-new-func
  const M2 = new Function(src2)();
  assert.strictEqual(typeof M2.siDeriveFamilyBlockHtml, 'function', '[XSS-406-L1] 前置：沙箱编译产出 siDeriveFamilyBlockHtml 应为可调用函数');

  // 脏 derive_root_id 字符串值（含单引号，典型属性/事件处理器逃逸载荷）——正常应恒为 SQLite INTEGER
  //   列取值，本用例模拟"万一某行已经是脏值"（历史遗留/旁路写入/运维直连 SQL）时渲染层是否守住。
  const cleanRoot = { id: 1, derive_root_id: null, derive_seq: null, title: '根单', status: '待受理' };
  const dirtyChild = {
    id: 2, derive_root_id: null, derive_seq: 1, title: '脏派生子单', status: '待受理',
    derive_reason: '正常原因',
  };
  // 直接在"根"这一行本身注入脏值，制造"根 id 本身不安全"的场景（比只脏 child 更贴近 codex 反例
  // 意图——family.find 找到的 rootMember 就是这一行，siSafeIdAttr(m.id) 直接消费它）。
  cleanRoot.id = "1' onmouseover='alert(1)";
  dirtyChild.derive_root_id = "1' onmouseover='alert(1)";
  const dirtyFamily = [cleanRoot, dirtyChild];
  const htmlOut = M2.siDeriveFamilyBlockHtml(dirtyFamily, 2);
  assert.ok(typeof htmlOut === 'string' && htmlOut.length > 0, '[XSS-406-L1] siDeriveFamilyBlockHtml 应正常返回非空字符串（脏值不应导致抛异常/空渲染）');
  assert.ok(!htmlOut.includes("1' onmouseover='alert(1)"), `[XSS-406-L1] ⭐ 输出 HTML 不应含脏 id 原始注入字符串（单引号未被拦，会断开 title= 属性），实得片段：${htmlOut.slice(0, 400)}`);
  // ⚠️ 不用"全文不含 onmouseover= 子串"这类粗正则——dispNo（`esc(siIssueDisplayNo(m))`，业务展示文本，
  //   非本次 406-L1 的整改对象）本身会把脏 id 原样格式化进可见文本再转义（单引号变 &#39;），文本里
  //   合法出现 "onmouseover=" 字样不代表属性被攻破，粗正则会把这种良性转义结果误判成漏洞（此为本文件
  //   实测撞见：初版用 `/onmouseover=(?!")/` 在这条干净转义输出上误报，已改用精确锚点断言）。
  //   改断言 title= 属性本身是否**干净闭合**——siSafeIdAttr 对脏值应归一成空串，属性应紧跟着闭合为
  //   `title="真实编号 #">`，若被注入撑开，这个精确子串就不会出现。
  assert.ok(htmlOut.includes('title="真实编号 #">'), `[XSS-406-L1] ⭐ 脏 id 根行的 title 属性应清洁闭合为 title="真实编号 #">（siSafeIdAttr 归一后应是空串，属性紧跟闭合，不应被注入内容撑开/断开），实得片段：${htmlOut.slice(0, 400)}`);
  // 正例对照：干净的家族（同结构，id 均为安全整数）应正常显示真实编号，不因"脏值兜底改空串"这条
  //   防线而误伤所有情况——防止一个"恒输出空串"的过度防御实现也能通过上面的负例断言（假绿）。
  const cleanFamily = [
    { id: 10, derive_root_id: null, derive_seq: null, title: '干净根单', status: '待受理' },
    { id: 11, derive_root_id: 10, derive_seq: 1, title: '干净子单', status: '待受理' },
  ];
  const cleanHtmlOut = M2.siDeriveFamilyBlockHtml(cleanFamily, 11);
  assert.ok(cleanHtmlOut.includes('真实编号 #11'), `[XSS-406-L1] 对照组：干净 id=11 应正常显示"真实编号 #11"（证明防御不是靠"恒输出空串"通过负例，而是真的区分脏净），实得：${cleanHtmlOut.slice(0, 400)}`);
  ok('[XSS-406-L1] siDeriveFamilyBlockHtml 负例：脏 derive_root_id/id 字符串值（含单引号）经 siSafeIdAttr 归一后不再能断开 title= 属性；干净 id 对照组仍正常显示真实编号（非恒空防御）');
}

// [renderSysIterationRows 负例] 该函数直写 DOM（`tb.innerHTML = ...`），非纯函数——沙箱内提供最小
//   document/document.getElementById 桩（只捕获 innerHTML 赋值，不做真实 DOM），其余非本用例关心的
//   依赖（类型/优先级/风险/系统/开发者/commit/时间格式化/各 flag helper）打桩成空串——本负例只关心
//   "id/derive_root_id 类脏值能不能断开 title=/onclick=)"这一件事，不重复验证那些字段各自的展示逻辑
//   （它们已有 C2-S②/其余既有断言覆盖）。
{
  const pieces3 = ['esc', 'siSafeIdAttr', 'siIssueDisplayNo', 'siStatusClass', 'siStatusDisplay', 'renderSysIterationRows']
    .map((name) => extractFunctionBody(HTML, name));
  const consts3 = ['SI_STATUS_CLASS'].map((name) => extractConstStatement(HTML, name));
  assert.ok(pieces3.every(Boolean), '[XSS-406-L1] 前置：renderSysIterationRows 及其依赖函数体均应可提取');
  const src3 = `
    ${consts3.join('\n')}
    let siActiveSearch = '';
    let siList = [];
    function siMatchSearch() { return false; }
    function siIsExactSearchMatch() { return false; }
    function siTypeClass() { return ''; }
    function siTypeLabel() { return ''; }
    function siPriRiskCellHtml() { return ''; }
    function siSystemCellHtml() { return ''; }
    function siDevRosterCellHtml() { return ''; }
    function siRenderCommitRefs() { return ''; }
    function siFmtDT() { return ''; }
    function siFmtDeadline() { return ''; }
    function siPrereleaseFlagHtml() { return ''; }
    function siPostAcceptFlagHtml() { return ''; }
    function siFastlaneFlagHtml() { return ''; }
    function siTechLeadNotifyBadgeHtml() { return ''; }
    function siHeldDaysHtml() { return ''; }
    function isAdmin() { return true; }
    let __capturedHtml = null;
    const document = {
      getElementById: function (id) {
        return {
          set innerHTML(v) { __capturedHtml = v; },
          get innerHTML() { return __capturedHtml; },
        };
      },
    };
    ${pieces3.join('\n')}
    return {
      renderSysIterationRows,
      getCapturedHtml: function () { return __capturedHtml; },
    };
  `;
  // eslint-disable-next-line no-new-func
  const M3 = new Function(src3)();
  assert.strictEqual(typeof M3.renderSysIterationRows, 'function', '[XSS-406-L1] 前置：沙箱编译产出 renderSysIterationRows 应为可调用函数');

  const dirtyItem = {
    id: 2, derive_root_id: "1' onmouseover='alert(1)", derive_seq: 1,
    title: '脏行', status: '待受理', type: 'bug',
  };
  M3.renderSysIterationRows([{ item: dirtyItem, role: 'child', isContext: false, isLast: true, rooted: true }]);
  const capturedDirty = M3.getCapturedHtml();
  assert.ok(typeof capturedDirty === 'string' && capturedDirty.length > 0, '[XSS-406-L1] renderSysIterationRows 应正常写出非空 innerHTML（脏值不应导致抛异常/空渲染）');
  assert.ok(!capturedDirty.includes("1' onmouseover='alert(1)"), `[XSS-406-L1] ⭐ 列表行输出不应含脏 derive_root_id 原始注入字符串，实得片段：${capturedDirty.slice(0, 500)}`);
  // 精确锚点断言（同上方 siDeriveFamilyBlockHtml 用例理由——不用粗正则扫"onmouseover="子串，
  //   dispNo=esc(siIssueDisplayNo(i)) 会把脏 derive_root_id 原样格式化进可见文本再转义，合法出现该
  //   字样不代表属性被攻破）：i.id=2 干净、rootIdForTitle=脏 derive_root_id，siSafeIdAttr 归一后
  //   前者应正常显示、后者应归空，title 属性应精确闭合为 title="真实编号 #2·链根 #">。
  assert.ok(capturedDirty.includes('title="真实编号 #2·链根 #">'), `[XSS-406-L1] ⭐ 脏 derive_root_id 行的 title 属性应清洁闭合为 title="真实编号 #2·链根 #">（干净 id=2 正常显示、脏值归空，属性未被注入内容撑开/断开），实得片段：${capturedDirty.slice(0, 500)}`);

  // 对照组：干净 id 应正常出现在 onclick= 里（同上，防"恒空防御"假绿）。
  const cleanItem = { id: 20, derive_root_id: null, derive_seq: null, title: '干净行', status: '待受理', type: 'bug' };
  M3.renderSysIterationRows([{ item: cleanItem, role: 'standalone', isContext: false, isLast: false, rooted: false }]);
  const capturedClean = M3.getCapturedHtml();
  assert.ok(capturedClean.includes('onclick="siOpenDrawer(20)"'), `[XSS-406-L1] 对照组：干净 id=20 应原样出现在 onclick="siOpenDrawer(20)" 里，实得：${capturedClean.slice(0, 300)}`);
  ok('[XSS-406-L1] renderSysIterationRows 负例：脏 derive_root_id 字符串值（含单引号）经 siSafeIdAttr 归一后不再能断开 title=/onclick= 属性；干净 id 对照组仍正常出现在 onclick= 里（非恒空防御，mutation 反证见收尾报告）');
}

// [407-L1] siSafeIdAttr 契约收紧——首版裸 `Number(v)` 转换会把几类"看着不像编号实则被 JS 强转规则
//   悄悄安全整数化"的输入误放行成"合法编号"插值（codex 407-L1 指出）：`Number('')===0`（空字符串）、
//   `Number(true)===1`（布尔值）、`Number('0x10')===16`（十六进制字符串，插出的十进制值与源字符串
//   字面意思对不上）。这类不是"含注入字符的脏字符串"（406-L1 的负例已覆盖那一类），是"类型/格式本身
//   就不该被当成十进制整数编号"——直接单测 siSafeIdAttr 本体 + 补一个 renderSysIterationRows 的脏
//   i.id 用例直接覆盖 onclick= 插值点（406-L1 的负例都是脏 derive_root_id，没有一条直接脏 i.id 走
//   onclick= 那一支，本次补齐）。
console.log('\n═══ [407-L1] siSafeIdAttr 契约收紧：空串/布尔/十六进制字符串不再被 Number() 误放行 ═══');
{
  const pieces4 = ['siSafeIdAttr'].map((name) => extractFunctionBody(HTML, name));
  assert.ok(pieces4.every(Boolean), '[407-L1] 前置：siSafeIdAttr 函数体应可提取');
  const src4 = `
    ${pieces4.join('\n')}
    return { siSafeIdAttr };
  `;
  // eslint-disable-next-line no-new-func
  const M4 = new Function(src4)();
  assert.strictEqual(typeof M4.siSafeIdAttr, 'function', '[407-L1] 前置：沙箱编译产出 siSafeIdAttr 应为可调用函数');

  assert.strictEqual(M4.siSafeIdAttr(''), '', `[407-L1] ⭐ 空字符串应归空串，不应被 Number('')===0 误放行成编号 "0"，实得 ${JSON.stringify(M4.siSafeIdAttr(''))}`);
  assert.strictEqual(M4.siSafeIdAttr(true), '', `[407-L1] ⭐ 布尔值 true 应归空串，不应被 Number(true)===1 误放行成编号 "1"，实得 ${JSON.stringify(M4.siSafeIdAttr(true))}`);
  assert.strictEqual(M4.siSafeIdAttr('0x10'), '', `[407-L1] ⭐ 十六进制字符串 '0x10' 应归空串，不应被 Number('0x10')===16 误放行成编号 "16"（源字符串字面写的是十六进制，插出的十进制编号与它对不上），实得 ${JSON.stringify(M4.siSafeIdAttr('0x10'))}`);

  // 对照组：干净整数（number 类型 / 十进制整数字符串，含 trim 场景）仍应正常放行——防"恒空防御"假绿。
  assert.strictEqual(M4.siSafeIdAttr(42), '42', `[407-L1] 对照组：number 类型安全整数 42 应正常放行，实得 ${JSON.stringify(M4.siSafeIdAttr(42))}`);
  assert.strictEqual(M4.siSafeIdAttr('42'), '42', `[407-L1] 对照组：十进制整数字符串 '42' 应正常放行，实得 ${JSON.stringify(M4.siSafeIdAttr('42'))}`);
  assert.strictEqual(M4.siSafeIdAttr('  42  '), '42', `[407-L1] 对照组：带前后空白的整数字符串 trim 后应正常放行，实得 ${JSON.stringify(M4.siSafeIdAttr('  42  '))}`);
  ok('[407-L1] siSafeIdAttr 契约收紧：空字符串/布尔值/十六进制字符串三类曾被 Number() 误放行的危险输入均归空串；干净整数（number/十进制字符串/trim）对照组仍正常放行（非恒空防御，mutation 反证见收尾报告）');

  // renderSysIterationRows 脏 i.id 用例——直接覆盖 onclick= 插值点（406-L1 的负例都走的是脏
  // derive_root_id/title=，没有一条直接脏 i.id 走 `<tr onclick="siOpenDrawer(${siSafeIdAttr(i.id)})">`
  // 那一支，本次补齐；role='standalone' 让 idCell 走非派生子单分支（esc(siIssueDisplayNo(i))，不消费
  // siSafeIdAttr），干净隔离出"只测 onclick 插值点"这一件事）。
  const pieces5 = ['esc', 'siSafeIdAttr', 'siIssueDisplayNo', 'siStatusClass', 'siStatusDisplay', 'renderSysIterationRows']
    .map((name) => extractFunctionBody(HTML, name));
  const consts5 = ['SI_STATUS_CLASS'].map((name) => extractConstStatement(HTML, name));
  assert.ok(pieces5.every(Boolean), '[407-L1] 前置：renderSysIterationRows 及其依赖函数体均应可提取');
  const src5 = `
    ${consts5.join('\n')}
    let siActiveSearch = '';
    let siList = [];
    function siMatchSearch() { return false; }
    function siIsExactSearchMatch() { return false; }
    function siTypeClass() { return ''; }
    function siTypeLabel() { return ''; }
    function siPriRiskCellHtml() { return ''; }
    function siSystemCellHtml() { return ''; }
    function siDevRosterCellHtml() { return ''; }
    function siRenderCommitRefs() { return ''; }
    function siFmtDT() { return ''; }
    function siFmtDeadline() { return ''; }
    function siPrereleaseFlagHtml() { return ''; }
    function siPostAcceptFlagHtml() { return ''; }
    function siFastlaneFlagHtml() { return ''; }
    function siTechLeadNotifyBadgeHtml() { return ''; }
    function siHeldDaysHtml() { return ''; }
    function isAdmin() { return true; }
    let __capturedHtml = null;
    const document = {
      getElementById: function (id) {
        return {
          set innerHTML(v) { __capturedHtml = v; },
          get innerHTML() { return __capturedHtml; },
        };
      },
    };
    ${pieces5.join('\n')}
    return {
      renderSysIterationRows,
      getCapturedHtml: function () { return __capturedHtml; },
    };
  `;
  // eslint-disable-next-line no-new-func
  const M5 = new Function(src5)();
  assert.strictEqual(typeof M5.renderSysIterationRows, 'function', '[407-L1] 前置：沙箱编译产出 renderSysIterationRows 应为可调用函数');

  const hexIdItem = { id: '0x10', derive_root_id: null, derive_seq: null, title: '脏 id 行（十六进制字符串）', status: '待受理', type: 'bug' };
  M5.renderSysIterationRows([{ item: hexIdItem, role: 'standalone', isContext: false, isLast: false, rooted: false }]);
  const capturedHex = M5.getCapturedHtml();
  assert.ok(typeof capturedHex === 'string' && capturedHex.length > 0, '[407-L1] renderSysIterationRows 应正常写出非空 innerHTML（脏 id 不应导致抛异常/空渲染）');
  assert.ok(!capturedHex.includes('onclick="siOpenDrawer(16)"'), `[407-L1] ⭐ 十六进制字符串 id='0x10' 不应被误转成十进制 16 插进 onclick（源字符串写的是十六进制，Number('0x10')===16 与源数据字面意思对不上，不该被当成真实 id=16 插值），实得片段：${capturedHex.slice(0, 400)}`);
  assert.ok(capturedHex.includes('onclick="siOpenDrawer()"'), `[407-L1] ⭐ 脏 id 归一后 onclick 应清洁收窄为 siOpenDrawer()（空参数，不误插任何编号），实得片段：${capturedHex.slice(0, 400)}`);
  ok('[407-L1] renderSysIterationRows 直接覆盖 onclick 插值点：脏 i.id="0x10"（十六进制字符串）经收紧后的 siSafeIdAttr 归一为空，onclick 清洁收窄为 siOpenDrawer()，不再被误转成十进制 16（mutation 反证见收尾报告）');
}

// ── [406-L2] scripts/lib/extract-function-body.js 词法感知升级：三种"花括号计数会被字面量内容
//    带偏"的形态均正确提取 ══════════════════════════════════════════════════════════════════════
//   放在本文件而非独立 lib/ 同目录小脚本——本文件已是 extractFunctionBody 的既有消费方之一，三处
//   消费方共用同一份实现，负例放消费方里天然"并入 sweep"（scripts/verify-sys-*.js 全量自动纳入
//   run-verify-family.js 扫描面，lib/ 目录本身不在该扫描面内，见 run-verify-family.js 头注"扫描面=
//   scripts/verify-sys-*.js 全部"）。用**合成源码片段**（非真实 Sys_Iteration.html 文本）精确控制
//   三种边界形态，不依赖生产源码里恰好存在这些写法。
console.log('\n═══ [406-L2] extract-function-body 词法感知：字符串/正则内的 } 不干扰花括号计数，注释里的同名签名不误命中 ═══');
{
  // ① 目标函数体内含 `'}'` 字符串——朴素花括号计数会在字符串内容的 `}` 处提前收尾，漏掉真正的
  //   函数收尾 `}`（进而丢失 `return s;` 那行）。
  const srcStringBrace = [
    'function decoyBefore() { return 1; }',
    'function targetA(x) {',
    "  const s = 'a}b';",
    '  return s;',
    '}',
    'function decoyAfter() { return 2; }',
  ].join('\n');
  const gotA = extractFunctionBody(srcStringBrace, 'targetA');
  const expectedA = 'function targetA(x) {\n' +
    "  const s = 'a}b';\n" +
    '  return s;\n' +
    '}';
  assert.strictEqual(gotA, expectedA, `[406-L2①] 目标函数含 '}' 字符串——应提取到完整函数体（含 return 行），不被字符串内容里的假花括号带偏提前收尾。实得：${JSON.stringify(gotA)}`);

  // ② 目标函数体内含 `/}/ ` 正则字面量——同①同一类风险，正则内容里的 `}` 也不该参与深度计数。
  const srcRegexBrace = [
    'function decoyBefore() { return 1; }',
    'function targetB(x) {',
    '  const re = /}/;',
    '  return re.test(x);',
    '}',
    'function decoyAfter() { return 2; }',
  ].join('\n');
  const gotB = extractFunctionBody(srcRegexBrace, 'targetB');
  const expectedB = 'function targetB(x) {\n' +
    '  const re = /}/;\n' +
    '  return re.test(x);\n' +
    '}';
  assert.strictEqual(gotB, expectedB, `[406-L2②] 目标函数含 /}/ 正则字面量——应提取到完整函数体，不被正则内容里的假花括号带偏提前收尾。实得：${JSON.stringify(gotB)}`);

  // ③ 注释里写了同名函数签名示例（本仓惯用的大段中文注释很容易在描述"写法类似 XXX"时带出一个
  //   看起来像函数定义的片段）——提取器必须跳过注释里的假命中，落到真正的 `function targetC(` 定义。
  const srcCommentSignature = [
    '// 示例：写法类似 function targetC(x) { return x; } 但下面这个才是真的定义',
    'function targetC(x) {',
    '  return x + 1;',
    '}',
  ].join('\n');
  const gotC = extractFunctionBody(srcCommentSignature, 'targetC');
  const expectedC = 'function targetC(x) {\n' +
    '  return x + 1;\n' +
    '}';
  assert.strictEqual(gotC, expectedC, `[406-L2③] 注释含同名函数签名——应跳过注释里的假命中，提取到真正的函数定义（含 return x + 1 那行，非注释里描述的 return x）。实得：${JSON.stringify(gotC)}`);

  ok('[406-L2] extract-function-body 词法感知：字符串/正则字面量内的 } 不干扰花括号计数、注释里的同名函数签名不误命中——三种形态均正确提取到真正的函数体（mutation 反证见收尾报告）');
  // 三个消费方（badge-fields/derive-numbering/本文件）跑通不回归——不在此处用 spawnSync 嵌套跑其余
  // 两个消费方（run-verify-family.js 本就会把 scripts/verify-sys-*.js 全量各自独立跑一遍，嵌套重跑
  // 是重复劳动+拖慢本文件本身的运行时间）；三者是否全绿以 run-verify-family.js 的全家扫描结果为准，
  // 见收尾报告的验证记录。
}

// [407-H1] 正则起点判定须看"前一个完整 token"而非前一个单字符——`return /}/.test(x)` 里 `/` 前一个
//   字符是 "return" 的末字母 "n"，旧实现按单字符判定会误判成除号上下文，让正则内容的 `}` 参与深度
//   计数（codex 407-H1 指出：模块头注声称支持 `return /re/` 与实现矛盾）。
console.log('\n═══ [407-H1] 正则起点按完整 token 判定：return//throw 关键字后的正则不再被误判成除号 ═══');
{
  const srcReturnRegex = [
    'function decoyBefore() { return 1; }',
    'function targetD(x) {',
    '  return /}/.test(x);',
    '}',
    'function decoyAfter() { return 2; }',
  ].join('\n');
  const gotD = extractFunctionBody(srcReturnRegex, 'targetD');
  const expectedD = 'function targetD(x) {\n' +
    '  return /}/.test(x);\n' +
    '}';
  assert.strictEqual(gotD, expectedD, `[407-H1①] return /}/.test(x)——"return" 关键字后的正则不应被误判成除号上下文，应提取到完整函数体。实得：${JSON.stringify(gotD)}`);

  const srcThrowRegex = [
    'function decoyBefore() { return 1; }',
    'function targetE(x) {',
    '  if (x) throw /}/;',
    '  return x;',
    '}',
  ].join('\n');
  const gotE = extractFunctionBody(srcThrowRegex, 'targetE');
  const expectedE = 'function targetE(x) {\n' +
    '  if (x) throw /}/;\n' +
    '  return x;\n' +
    '}';
  assert.strictEqual(gotE, expectedE, `[407-H1②] throw /}/——"throw" 关键字后的正则同样不应被误判成除号上下文。实得：${JSON.stringify(gotE)}`);

  ok('[407-H1] 正则起点按完整 token 判定：return/throw 关键字后的 /}/ 正则均正确识别为正则字面量（非除号误判），完整函数体提取无误（mutation 反证见收尾报告）');
}

// [407-H2] 删除行注释判定里"前一字符不是冒号"的旧例外——`label: // }` 这类真代码（label 语法后跟
//   行注释）会被误判成"冒号后不算注释"，注释里的 `}` 混进花括号深度计数（codex 407-H2 指出：该例外
//   原为防字符串内 http:// 误判，字符串已由独立状态保护，例外已是纯害处死代码）。
console.log('\n═══ [407-H2] 冒号后的行注释不再被误判成代码：label: // } 场景 ═══');
{
  // ⚠️ 冒号与 `//` 之间**刻意不留空格**——旧例外判据是 `s[i-1] !== ':'`，只看"`/` 前一个原始字符"，
  //   `label: // 注释`（冒号后带空格再接注释，本仓惯常写法）里 `/` 前一个字符是空格不是冒号，旧例外
  //   根本不会触发，不是有效反例；只有 `label://注释`（冒号紧邻 `//`，中间无空格）才真的踩中旧例外
  //   判据本身。踩坑记录：初版造例带了空格，在恢复旧例外的 mutation 下依然全绿（没测到该测的东西），
  //   已改成无空格版本，重新验证过 mutation 确实能让它变红。
  const srcColonComment = [
    'function decoyBefore() { return 1; }',
    'function targetF(x) {',
    '  loop://stray brace in comment should not count }',
    '  return x;',
    '}',
  ].join('\n');
  const gotF = extractFunctionBody(srcColonComment, 'targetF');
  const expectedF = 'function targetF(x) {\n' +
    '  loop://stray brace in comment should not count }\n' +
    '  return x;\n' +
    '}';
  assert.strictEqual(gotF, expectedF, `[407-H2] label://} （冒号与注释间无空格，真正踩中旧例外判据）——冒号后的行注释应正常判定为注释（注释里的 } 不参与计数），应提取到含 return x 那行的完整函数体，不被注释里的假 } 提前截断。实得：${JSON.stringify(gotF)}`);
  ok('[407-H2] 冒号后行注释正确识别：label://} 场景（冒号紧邻注释起始、无空格，真正踩中旧例外判据）注释内容不再混进花括号深度计数（mutation 反证见收尾报告）');
}

// [408-H1] 属性访问后的关键字同名词是属性名，不是语法关键字——`obj.return`/`obj.of`/`obj.new` 里的
//   return/of/new 只是属性名，白名单判定不该命中（codex 408-H1 指出：407-H1 的白名单只看"词是什么"，
//   没看"词在什么位置"，`obj.return / 2` 里的 `/` 会被误判成正则起点）。三个造例都把"误判正则起点"
//   的真实后果构造出来——同一行内后面紧跟一个真实 `/}/`  正则：若 `obj.X` 后的 `/` 被误判成正则起点，
//   会把 " ...; var re = " 当成假正则内容一路吞到真正则的开头 `/`，误当成假正则的收尾；真正则自己的
//   `/}/` 就会有一半（`}/`）被当成真代码解析，其中的 `}` 提前触发深度归零，把函数体截断在这里——
//   单独测"`/` 后面紧跟换行"测不出这个后果（换行本身会让状态机的正则容错兜底就地弹回代码态，看不出
//   误判的真实危害），故意把两者放同一行才有真实的破坏力可观测。
console.log('\n═══ [408-H1] 属性访问同名关键字不再误判成正则起点：obj.return/obj.of/obj.new 场景 ═══');
{
  const mk = (prop) => [
    'function decoyBefore() { return 1; }',
    `function target_${prop}(x) {`,
    `  var y = obj.${prop} / 2; var re = /}/; return re.test(x) + y;`,
    '}',
    'function decoyAfter() { return 2; }',
  ].join('\n');
  const expect = (prop) => `function target_${prop}(x) {\n` +
    `  var y = obj.${prop} / 2; var re = /}/; return re.test(x) + y;\n` +
    '}';

  for (const prop of ['return', 'of', 'new']) {
    const got = extractFunctionBody(mk(prop), `target_${prop}`);
    assert.strictEqual(got, expect(prop), `[408-H1] obj.${prop} / 2——属性访问同名关键字后的 / 不应被误判成正则起点，应提取到完整函数体（含后续真实 /}/  正则与 return 行），不被误判正则吞掉真实正则的 } 提前截断。实得：${JSON.stringify(got)}`);
  }

  // [SF-1①] 补 obj?.return / 2（可选链属性访问）——实现注释明确声称"`obj?.return` 与 `obj.return`
  //   从这个 `.` 往前看是同一种形状，不必再单独识别 `?`"，此前三例只覆盖了 `.` 形态，从未真的造过一条
  //   `?.` 形态的用例去验证这句声称本身，补上（同款设计：同一行紧跟真实 /}/ 正则，制造可观测后果）。
  const srcOptChain = [
    'function decoyBefore() { return 1; }',
    'function target_optreturn(x) {',
    '  var y = obj?.return / 2; var re = /}/; return re.test(x) + y;',
    '}',
    'function decoyAfter() { return 2; }',
  ].join('\n');
  const expectOptChain = 'function target_optreturn(x) {\n' +
    '  var y = obj?.return / 2; var re = /}/; return re.test(x) + y;\n' +
    '}';
  const gotOptChain = extractFunctionBody(srcOptChain, 'target_optreturn');
  assert.strictEqual(gotOptChain, expectOptChain, `[408-H1] obj?.return / 2（可选链属性访问）——"?." 里紧邻属性名的仍是 "."，应与 "obj.return" 同样判除号，不应被误判成正则起点。实得：${JSON.stringify(gotOptChain)}`);

  ok('[408-H1] 属性访问后的关键字同名词（obj.return/obj.of/obj.new，含 obj?.return 可选链形态）正确判除号，不再误判正则起点吞掉后续真实正则的收尾 }（mutation 反证见收尾报告）');
}

console.log(`\n✅ verify-sys-derive-display 全绿：${passed} 项`);
