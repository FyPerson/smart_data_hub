#!/usr/bin/env node
/**
 * #77 C4b-1：目录页纯函数核心 public/assets/js/model-catalog-core.js 的手写期望表守卫（纯 node，不起服务）。
 *
 * 判据（全部从手写夹具与手写期望出发，期望值不由被测函数生成）：
 *   一 两端一致：node require 的核心 vs vm 里按浏览器方式（window 全局、先加载 model-detail-normalize.js 再加载核心、无 module）加载的核心，
 *     对本文件全部夹具调用 computeView / matchRow / upstreamNames，JSON 相等；浏览器方式加载后 window 上只多出 ModelCatalogCore 一个键。
 *   二 上游名与后端同源（D-10）：upstreamNames(row) 与「后端 upstreamOfModel(row) 拍平成名字」逐项相等（含顺序），并对 #50/#52/#55 等写手写名单。
 *   三 方案 §3.4 契约表逐行一例（C1–C7，另加筛选 F1–F3、三态排序 N1–N3、clampPage / locate L1–L2）。
 *   四 方案 §3.4 事件表逐行一例（E1 / E1b / E2a–c / E3 / E4 / E4b）。
 *   五 搜索逐字段（S:*）与 D-11 的 #id 规则、大小写 / 空白 / 通配。
 *   六 排序：10 个排序键 × desc / asc 的手写期望序列（含空值、未知状态、日期并列与不同分隔符），不使用被测的 sortByField 生成期望；另验证显式稳定次序（不稳定排序引擎下仍按输入序）。
 *   七 搬入件逐字：核心里的 SORT_FIELD_TYPES / STATUS_SORT_ORDER / parseSqliteTs / sortByField 与 model-catalog.js 里同名声明 token 序列逐个相等（V:*）。
 *   （一节只证明加载 / 导出路径一致，不作语义判据；语义由三至六节的手写期望承担。）
 *   九 接线（静态，#77 C4b-2）：目录页核心标签的 ?v= 后缀 = 核心源码里的 CORE_VERSION；model-catalog.js 不再声明已搬进核心的四个名字；
 *     renderModelsPage / goToPage / highlightModel / getSortedModels / getCatalogView / loadModels 经 ModelCatalogCore 计算；loadModels 不带 keyword；
 *     pageSize 声明为 20；model-catalog.js 代码里不出现按行算页的写法（W:*）。七节的对照源改为 git show 931397fa 的 model-catalog.js（git 不可用即判红）。
 *     C4c-2 起另有：renderModelsPage 的视图只来自参数或 catalogViewRaw()（W:core-calls，不再用「函数体出现 ModelCatalogCore.」这种会被 acceptanceView 调用蒙混的判据）；
 *     CAT 里 innerHTML / outerHTML / insertAdjacentHTML 的赋值或调用只出现在 renderPagination 与 showDesignNotesPopover（W:innerhtml）；escapeHtml( 恰一处且是设计说明分发的第 2 实参（W:escape）；
 *     除 renderPagination 外不出现 onclick=、setAttribute('on…')、on* 属性赋值（W:onclick）；renderModelsPage 里权限函数各恰一次（W:perm）；菜单 / 分发 / 渲染相关函数体（含渲染路径的 catalogEl / catalogActionSpecs / catalogMenuItem / catalogBuildMenu / catalogBuildActions / catalogBuildAcceptance / catalogBuildEntry）与 document 级监听回调同步（W:sync，DOM 契约 14）。
 *     2c 追加：renderModelsPage 的全部调用点（CAT 与 MC 内联）只能是 0 个参数或恰为 catalogViewRaw() 的结果（W:render-args）；renderPagination 的模板插值限定为数值类表达式或常量间的选择（W:innerhtml）；
 *     showDesignNotesPopover 在 MC 内联脚本 / 静态 HTML 里的调用点第 2 实参也必须是 escapeHtml(...)（W:escape）；catalogCall 经 window[name] 调用的处理函数在 MC 内联脚本里必须是 function 声明（W:handlers，const / let 不挂 window）。
 *     2e 追加：MC 内联脚本块解析失败不再静默跳过——解析失败的块里出现 showDesignNotesPopover / renderModelsPage 字样即判红（W:escape，变异 W34）。
 *     C4c-3 3b 追加：loadModels 三态返回值与 listFailed 接线（W:track / W:list-fail）、ready 口径与 data-catalog-state 唯一写入点（W:list-ready）、上游名匹配与后端 asciiLower 同口径（W:ascii-lower，行为比对）、
 *       MC 初始化 ?focus / ?id 只在 'arrived' 时执行（W:list-init）、重试按钮接线（W:list-retry）。变异 WL1–WL9。C4c-3 3c 追加：catch 转失败前 console.warn（W:list-fail）、空态文案只在数据至少成功套用过一次之后显示（W:list-ready）；变异 WL10–WL11。C4c-3 3d 追加：W:expand-state 拦整体替换 catalogEventState（右值白名单）与 Object.assign(catalogEventState, …)；变异 WX10–WX11。
 *   C4c-4 4a 追加：四节 P36（setQuery 搜索词 trim 后不变 / gotoPage 翻到当前页 = 条件没变，状态原样；大小写不同、词内空白不同按改搜索；P36:*，变异 P36a–P36j）；
 *     九节 W:filters（筛选单一来源 catalogFilters：每个 filters: 属性值都是标识符 catalogFilters 且 ≥ 3 处、只在 catalogAdoptFilters 里赋值、复制写回、focus 调用它）、
 *     W:total（页头在册数取 railCounts(allModelsData).total，只在 loadModels 成功路径更新）、W:p36（applyCatalogSearch 的旧词取 catalogRenderedQuery，只在 renderModelsPage 里记录）、catalogUpdateTotal / catalogAdoptFilters 纳入 W:sync；变异 WF1–WF6 / WT1–WT3 / WP1–WP2 / WS1–WS2；
 *     版本握手 mcc2 → mcc3（M41 / W7 / B2 的字面量，W7 的变异改为 mcc3 → mcc4）。
 *   C4c-4 4b 追加：W:rail（左栏：ModelCatalogCore.setFilter 只在 catalogRailPick / catalogRailClear 里调用；catalogAdoptFilters 写回后重画左栏；计数 = railCounts(allModelsData) 且只在 loadModels 成功路径更新；点击委托接线；再点已选中项 / 本来就是「全部」的口径；清除只清筛选；MC 静态 aside#catalogRail）、
 *     W:filters 扩展（每个 setFilter( 之后同函数里都有 catalogAdoptFilters( 写回）、左栏渲染 / 点击函数纳入 W:sync；变异 WRL1–WRL10（原 WR1–WR10，4d 改名：与 D-7 的 W:write 变异 WR1–WR11 重号）/ WS3–WS4。
 *   C4c-4 4c 追加：W:unowned（未归属对象：catalogLoadUnowned 只在初始化与重试里调用且 URL 逐字；请求序号三处丢弃检查的位置；模式 / 数据状态各只有一个写入点；重试在途守卫与按钮置灰；loadModels / renderModelsPage 不碰未归属；
 *     catalogSetUnownedMode 的调用方清单与「点筛选 / 清除先退出」的顺序；入口按钮不带 data-rail / data-act / data-entry；徽章格单一构建函数 catalogObjBadgeKids；失败不弹 toast；MC 的 hidden 面板与隐藏规则）、
 *     未归属相关函数纳入 W:sync；变异 WU1–WU24。
 *   C4c-4 4d 追加（预筛修复）：W:filters 补成员写入 / delete / ++ / Object.assign(catalogFilters, …) 两条判据，以及 catalogRailPick / catalogRailClear 里 catalogAdoptFilters( 的实参必须是本函数内 ModelCatalogCore.setFilter(…) 的返回值（r.state 或由 setFilter 结果累积的变量）——变异 WFM1–WFM6；
 *     W:p36 补组字标记（catalogComposing：声明、只在 initCatalogSearch 里写、清位监听先于 applyCatalogSearch 注册、catalogRenderedQuery 的赋值整个包在 if (!catalogComposing) 里）——变异 WC1–WC4；
 *     W:unowned 补 focusCatalogModel 先退出未归属模式（调用方清单加它、调用在核心 focus 之前）——变异 WFX1–WFX2；未归属「刷新」按钮（ok 态才有、在途置灰、与重试同走 catalogRetryUnowned、委托接线）——变异 WRF1–WRF5；
 *     W:rail 补左栏按键就地更新（catalogRenderRail 以 catalogRailReconcile 收尾、左栏函数里不出现 replaceChildren / innerHTML、reconcile 只在需要时移动节点）——变异 WRC1–WRC5；W:sync 清单加 applyCatalogSearch / focusCatalogModel / 左栏三个就地更新函数——变异 WS5–WS9。
 *   C4c-4 codex 41 收口追加：W:filters 实参来源判据分开「结果对象」与「状态」（采用 r.state 时 r 必须直接来自 ModelCatalogCore.setFilter(…) 调用；采用累积变量时种子只能是 catalogSyncState()、其余赋值必须是 setFilter(…).state）——变异 WZ1–WZ2；
 *     W:rail 补 catalogRailPatch 的执行条件（属性对齐分支 oldEl.getAttribute(a.name) !== a.value、叶子文字分支 oldEl.textContent !== freshEl.textContent，运算符与操作数都核）——变异 WZ3–WZ4，catalogRenderRail 焦点归还（41-L1）——变异 WZ5–WZ6；
 *     W:unowned 补 catalogRenderUnowned 就地更新（不得对面板整体 replaceChildren / innerHTML / textContent，以 catalogRailReconcile(panel, […]) 收尾；41-M1）——变异 WZ7–WZ8，类型列走 catalogOrDash（41-L2）——变异 WZ9；清旧文字语句（fix41b 预筛 LOW-2，页面层由 W81 钉住）——变异 WZ10；
 *     P36 的「条件不变」用例补完整返回状态与入参逐字段相等的比较（含 query 原值，当前词为 null / undefined 的对照；41Td-M4）——变异 P36k–P36n。
 *   八 不修改入参：深冻结全部入参后跑一遍（I1）；导出表冻结（Z1）。
 *   行尾：自证读入核心与 normalize 源码后先统一成 LF 再定位锚点（工作区可能是 CRLF），并带一个「整体转 CRLF」的对照组。
 * 用法：node scripts/verify-model-catalog-core.js [--self-test]
 *   --self-test：把核心源码连同 model-detail-normalize.js 复制到临时目录，逐个施加锚定替换（锚点不存在即报错），子进程重跑本文件，
 *     每个变异必须判红且首条失败以指定用例编号开头；对照组（只加注释 / 空行）必须全绿。
 *   环境变量 MC_CORE_DIR（内部用）：指定核心与 normalize 所在目录，默认 public/assets/js。
 * 威胁模型：只防「诚实实现写错」（排序不按组 / 分页按行 / 重载回第 1 页 / 令牌不比对 / 字段表漏项…），不防故意绕开观测。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const acorn = require('acorn');

const REAL_JS_DIR = path.join(__dirname, '..', 'public', 'assets', 'js');
const JS_DIR = process.env.MC_CORE_DIR ? path.resolve(process.env.MC_CORE_DIR) : REAL_JS_DIR;
const CORE_FILE = path.join(JS_DIR, 'model-catalog-core.js');
const KIT_FILE = path.join(JS_DIR, 'model-detail-normalize.js');
const CAT_FILE = process.env.MC_CAT_FILE ? path.resolve(process.env.MC_CAT_FILE) : path.join(REAL_JS_DIR, 'model-catalog.js');   // 接线节读它；--self-test 的接线变异用 MC_CAT_FILE 指向变异副本
const PAGE_FILE = process.env.MC_PAGE_FILE ? path.resolve(process.env.MC_PAGE_FILE) : path.join(__dirname, '..', 'public', 'Model_Center.html');   // 接线节读它；--self-test 的 D-7 变异用 MC_PAGE_FILE 指向变异副本
/**
 * 七节冻结值：四个搬入件的 token 序列（tokenizer 的 type.label + 值；正则字面量按 /pattern/flags；token 之间用 \u0002 连接）的数量与 sha256。
 * 来源：2026-10-07 对 `git show 931397fa:wbs-server/public/assets/js/model-catalog.js`（C4a 提交里 model-catalog.js 的原件）取同名声明后一次性算出
 *   （一次性脚本 E:/tmp/mc77-c4/c4b2/fix/freeze.js）；不再依赖 git 历史（浅克隆 / git archive / squash 合并后依然可跑）。核心里的搬入件必须与它逐 token 相同。
 */
const FROZEN_TOKENS = {
  SORT_FIELD_TYPES: { n: 46, sha256: 'de834af924f5b3bf48b84eb5436508204bfc6f31ce47c60dbd6f8298db270388' },
  STATUS_SORT_ORDER: { n: 26, sha256: 'a1174f5d81e138fb551078e98cfd51d2a6a4a5a62d25f5bd9b697b72d67dc10c' },
  parseSqliteTs: { n: 94, sha256: 'de35361d6a4e23247791d148c36fcf195d0776195c17df4ebdfc5dff1d62da6e' },
  sortByField: { n: 256, sha256: 'cad5fecf0ff4425b803cf25ce7f8f6ea65036dea8f7daf31f38a6f25803f7e55' },
};
const MODELS_JSON = path.join(__dirname, 'fixtures', 'model-workbench-baseline', 'models.json');

// ───────────────────────────── 自测变异表 ─────────────────────────────
// [编号, 说明, 锚点（须在核心源码里恰好出现一次）, 替换, 期望首条失败的用例编号（null = 对照组，须全绿）]
const MUTATIONS = [
  ['M1', '排序不按组：直接按行排序（伴生按自己的字段值散落）', 'groups = sortedPrimaries.map(function (p) { return groupOf.get(p); });',
    "var flatRows = []; kept.forEach(function (g) { g.members.forEach(function (m) { flatRows.push(m); }); }); groups = sortByField(flatRows, o.sortBy, o.sortDir).map(function (m) { return { id: m.id, primary: m, members: [m], orphan: false }; });", 'C3'],
  ['M2', '分页按行切（pageIds 取前 pageSize 行）', 'pageIds: flatIds(pageGroups),',
    'pageIds: flatIds(groups).slice((page - 1) * pageSize, page * pageSize),', 'C4'],
  ['M3', '数据重载回第 1 页（listArrived 里 page = 1）', 'c.page = clampPage(S.page, v.totalPages);', 'c.page = 1;', 'E1'],
  ['M5', 'listArrived 不比对令牌', 'if (!a.token || a.token !== S.listToken) {', 'if (false) {', 'E1'],
  ['M6', 'gotoPage 不清展开与令牌', 'c.page = p;\n        clearExpand(c);', 'c.page = p;', 'C5'],
  ['M7', '落单伴生被丢弃（不自成一组）', 'if (isPrimary || !attached) {', 'if (isPrimary) {', 'C1'],
  ['M8', 'ID 规则改成数值相等（0052 命中 #52）', 'idm[1] === String(row.id)', 'Number(idm[1]) === Number(row.id)', 'S:id0052'],
  ['M9', '分层筛选改成大小写敏感', "String(row.layer || '').toUpperCase() === String(v).toUpperCase()", "String(row.layer || '') === String(v)", 'F1'],
  ['M10', '未登记的筛选键不再抛错', "throw new Error('model-catalog-core：未登记的筛选键 ' + k);", 'continue;', 'F2'],
  ['M11', 'matchRow 不去首尾空白', "var q = String(query === null || query === undefined ? '' : query).trim();", "var q = String(query === null || query === undefined ? '' : query);", 'S:ws'],
  ['M12', 'toggleSort 清空展开集合', 'c.sortDir = n.sortDir;\n        c.page = 1;', 'c.sortDir = n.sortDir;\n        c.page = 1;\n        clearExpand(c);', 'C5'],
  ['M13', 'focus 自动展开目标', 'c.page = loc.page;', 'c.page = loc.page; c.expanded = [a.id];', 'E4'],
  ['M14', '数据重载不夹紧页码（D-13）', 'c.page = clampPage(S.page, v.totalPages);', 'c.page = S.page;', 'E1b'],
  ['M15', 'ODS 上游名不去首尾空白', 'var sys = trimmedNonEmpty(row.source_system);', 'var sys = row.source_system ? String(row.source_system) : null;', 'U'],
  ['M16', 'parseDimConfig 不解第二层 JSON', "if (typeof v === 'string') v = JSON.parse(v);", '', 'U'],
  ['M17', 'sortByField 搬入件被改写（cmp * mult → mult * cmp，行为等价，只有逐字比对能发现）', 'return cmp * mult;', 'return mult * cmp;', 'V:sortByField'],
  ['M17b', 'sortByField 行为被改（空值排首，比较器不再自洽）', 'if (aEmpty) return 1;', 'if (aEmpty) return -1;', 'P:table_comment.'],
  ['M18', 'relationsArrived 不比对令牌', 'if (cur === undefined || a.token !== cur)', 'if (false)', 'C6'],
  ['M19', 'nextSort 第三击不清排序', "return { sortBy: null, sortDir: 'desc' };\n    }\n\n    /**\n     * 分组", "return { sortBy: sortBy, sortDir: 'desc' };\n    }\n\n    /**\n     * 分组", 'N3'],
  ['M20', 'locate 页号差一', 'Math.floor(gi / view.pageSize) + 1', 'Math.floor((gi + 1) / view.pageSize) + 1', 'L2'],
  ['M21', '字段表去掉 impl_obj_names（对象名不可搜）', 'if (Array.isArray(row.impl_obj_names)) fields = fields.concat(row.impl_obj_names);', '', 'S:obj'],
  ['M22', '字段表去掉 impl_note（实现说明不可搜）', 'row.impl_note, ', '', 'S:note'],
  ['M23', 'copyState 不复制 expanded（入参被改）', 'c.expanded = (S.expanded || []).slice();', 'c.expanded = S.expanded;', 'I1'],
  ['M24', 'totalPages 按行算（H2）', 'totalPages: Math.ceil(totalGroups / pageSize),', 'totalPages: Math.ceil(flatIds(groups).length / pageSize),', 'C4'],
  ['M25', '数字查询只做 ID 全等、丢掉子串匹配（D-11）', 'if (idm && idm[1] === String(row.id)) return true;', 'if (idm) return idm[1] === String(row.id);', 'S:id60'],
  ['M26', '只折 ASCII 改成 toLowerCase（C-4）', 'return String(s).replace(/[A-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 32); });', 'return String(s).toLowerCase();', 'S:fold'],
  ['M27', '单遍 groupBy（遇到伴生就按伴生位置新开组）', 'function buildGroups(rows) {', (src) => {
    const a = src.indexOf('    function buildGroups(rows) {');
    const b = src.indexOf('    /** 搜索命中');
    if (a < 0 || b < a) throw new Error('buildGroups 边界找不到');
    const one = [
      '    function buildGroups(rows) {',
      '        var groups = [], byKey = {}, primaryIds = {}, i, r;',
      '        for (i = 0; i < rows.length; i++) { r = rows[i]; if (isBlankLink(r.companion_of)) primaryIds[String(r.id)] = true; }',
      '        for (i = 0; i < rows.length; i++) {',
      '            r = rows[i];',
      '            var isPrimary = isBlankLink(r.companion_of);',
      '            var key = isPrimary ? String(r.id) : String(r.companion_of);',
      '            if (!isPrimary && (key === String(r.id) || !hasOwn.call(primaryIds, key))) { groups.push({ id: r.id, primary: r, members: [r], orphan: true }); continue; }',
      '            var g = byKey[key];',
      '            if (!g) { g = { id: null, primary: null, members: [], orphan: false }; byKey[key] = g; groups.push(g); }',
      '            if (isPrimary) { g.id = r.id; g.primary = r; g.members.unshift(r); } else { g.members.push(r); }',
      '        }',
      '        return groups;',
      '    }',
      '', ''].join('\n');
    return src.slice(0, a) + one + src.slice(b);
  }, 'C1'],
  ['M28', 'parseSqliteTs 正则字面量改写（[ T] → [T ]，语义等价）', '[ T](\\d{2})', '[T ](\\d{2})', 'V:parseSqliteTs'],
  ['M29', 'parseSqliteTs 正则丢掉秒分组（updated_at 排序整体失效）', ':(\\d{2}):(\\d{2})/.exec', ':(\\d{2})/.exec', 'P:updated_at.'],
  ['M30', 'UMD 壳外多一个顶层 var（泄漏全局）', ';(function (root, factory) {', 'var leakedTopLevel = 1;\n;(function (root, factory) {', 'B3'],
  ['M31', '主模型集合误含伴生（伴生指向伴生时整行消失）', 'if (isBlankLink(r.companion_of) && !primaryIds.has(String(r.id))) primaryIds.set(String(r.id), true);', 'if (!primaryIds.has(String(r.id))) primaryIds.set(String(r.id), true);', 'G1'],
  ['M32', '组内伴生倒序', 'groupOfPrimary.get(pk).members.push(r);', 'groupOfPrimary.get(pk).members.splice(1, 0, r);', 'G2'],
  ['M33', '字段表去掉 source_system（非 ODS 行不可搜）', ', row.source_system];', '];', 'S:sys'],
  ['M34', '字段表去掉 source_table（非 ODS 行不可搜）', 'row.source_table, ', '', 'S:srctbl'],
  ['M35', '导出的 FILTER_PREDICATES 不冻结', 'Object.freeze(FILTER_PREDICATES);', '', 'Z1'],
  ['M36', 'setFilter 不校验键（脏键写进状态）', "if (!hasOwn.call(FILTER_PREDICATES, key)) throw new Error('model-catalog-core：未登记的筛选键 ' + key);\n        var c = copyState(S);", 'var c = copyState(S);', 'F2'],
  ['M37', 'clampPage 死循环（自证子进程须超时判红）', 'function clampPage(page, totalPages) {', 'function clampPage(page, totalPages) { while (true) {}', 'TIMEOUT', 4000],
  ['M38', '反转状态优先级（CREATED 排到 OFFLINE 之后）', 'CREATED: 0,', 'CREATED: 5,', 'P:status.'],
  ['M39', '日期按字符串比较（不解析）', 'cmp = parseSqliteTs(va) - parseSqliteTs(vb);', 'cmp = String(va) < String(vb) ? -1 : (String(va) > String(vb) ? 1 : 0);', 'P:updated_at.'],
  ['M40', 'P23：成员循环改为分别 some(matchRow) 与 some(passesFilters) 后取 AND', 'hit = matchRow(all[i].members[j], o.query) && passesFilters(all[i].members[j], o.filters);', 'hit = all[i].members.some(function (m) { return matchRow(m, o.query); }) && all[i].members.some(function (m) { return passesFilters(m, o.filters); });', 'F3'],
  ['M41', 'UMD 内改写既有全局 root.ModelDetailKit', "var CORE_VERSION = 'mcc3';", "var CORE_VERSION = 'mcc3';\n    if (root) { root.ModelDetailKit = {}; }", 'B3'],
  ['M42', '未登记的排序字段不抛错', "if (!hasOwn.call(SORT_FIELD_TYPES, o.sortBy)) throw new Error('model-catalog-core：未登记的排序字段 ' + String(o.sortBy));", '', 'SF1'],
  ['M43', 'relationsArrived 不保存关系数据', 'c.relations[key] = a.data === undefined ? null : a.data;', '', 'R1'],
  ['M44', '迟到响应也写入关系数据', "if (cur === undefined || a.token !== cur) return { state: c, effects: [{ type: 'discard-relations', id: a.id, token: a.token }] };", "if (cur === undefined || a.token !== cur) { if (a.ok) c.relations[key] = a.data; return { state: c, effects: [{ type: 'discard-relations', id: a.id, token: a.token }] }; }", 'R2'],
  ['M45', '收起不清该行的关系数据', "delete c.expandStatus[key];\n            delete c.relations[key];\n            return", "delete c.expandStatus[key];\n            return", 'R3'],
  ['M46', '列表重载到达不清旧关系数据', "c.expandStatus = dict();\n        c.relations = dict();\n        c.expanded.forEach(", "c.expandStatus = dict();\n        c.expanded.forEach(", 'E1c'],
  ['M47', 'computeView 不校验每页组数', "if (pageSize !== PAGE_SIZE) throw new Error('model-catalog-core：每页固定 ' + PAGE_SIZE + ' 组（实得 pageSize ' + String(pageSize) + '）');", '', 'C4'],
  ['M48', 'computeView 不校验页码', "assertPositiveInteger(page, 'page');", '', 'PG2'],
  ['M49', 'gotoPage 不校验页码', "assertPositiveInteger(p, 'page');", '', 'PG3'],
  ['M50', '收起按原值严格比较 id（数字 / 字符串交叉失效）', 'if (String(x) === key) at = i;', 'if (x === a.id) at = i;', 'T1'],
  ['M51', '重载保留判定按原值（数字 / 字符串交叉失效）', 'return onPage.get(String(id)) === true;', (src) => src.replace('onPage.set(String(id), true)', 'onPage.set(id, true)').replace('return onPage.get(String(id)) === true;', 'return onPage.get(id) === true;'), 'T3'],
  ['M52', '排序去掉输入序号作最终次序（依赖引擎稳定性）', 'return compareByField(a, b, o.sortBy, o.sortDir) || (order.get(a) - order.get(b));', 'return compareByField(a, b, o.sortBy, o.sortDir);', 'ST1'],
  ['M53', 'groupOfPrimary 改用普通对象（__proto__ 等 id 被原型语义污染）', 'var groupOfPrimary = new Map();', 'var groupOfPrimary = (function () { var o = {}; return { has: function (k) { return k in o; }, get: function (k) { return o[k]; }, set: function (k, v) { o[k] = v; } }; }());', 'G4'],
  ['M54', '空串 sortBy 被当作未排序（判定改回 if (o.sortBy)）', 'var sorting = o.sortBy !== null && o.sortBy !== undefined;', 'var sorting = !!o.sortBy;', 'SF1'],
  ['M55', '事件函数接受 pageSize 参数（不再抛错）', "if (a && hasOwn.call(a, 'pageSize')) throw new Error('model-catalog-core：事件函数不接收 pageSize（每页固定 PAGE_SIZE = ' + PAGE_SIZE + '）');", '', 'PS1'],
  ['M56', 'createState 返回非法初始页（page 0）', "page: 1, sortBy: null, sortDir: 'desc', query: '', filters: {}, expanded: [],", "page: 0, sortBy: null, sortDir: 'desc', query: '', filters: {}, expanded: [],", 'CS1'],
  ['W1', '接线：goToPage 改回按行算页（allModelsData.length / pageSize）', 'const totalPages = getCatalogView().totalPages; // 总页数唯一来源：核心视图（按组算）', 'const totalPages = Math.ceil(allModelsData.length / pageSize);', 'W:rowpage', undefined, 'cat'],
  ['W2', "接线：loadModels 加回 keyword 参数", "const res = await authFetch('/api/models');", "const keyword = document.getElementById('searchKeyword').value;\n            const res = await authFetch('/api/models?keyword=' + encodeURIComponent(keyword));", 'W:keyword', undefined, 'cat'],
  ['W3', '接线：目录代码里重新声明 sortByField', 'let catalogEventState = null;', 'let catalogEventState = null;\n        function sortByField(list) { return list; }', 'W:decl', undefined, 'cat'],
  ['W4', '接线：pageSize 改成 21', 'const pageSize = 20;', 'const pageSize = 21;', 'W:pagesize', undefined, 'cat'],
  ['W5', '接线：renderModelsPage 不再经核心取视图（改读 allModelsData 切片）', 'view = view || catalogViewRaw(); // C4b：经核心按组分页（不在渲染里夹紧页码）', 'view = { pageGroups: [], totalModels: allModelsData.length, totalGroups: 0, totalPages: 1 };', 'W:core-calls', undefined, 'cat'],
  ['W19', 'C4c-2：renderModelsPage 的视图换成 allModelsData 切片、同时保留 ModelCatalogCore.acceptanceView 调用（旧判据「函数体出现 ModelCatalogCore.」会被它蒙混）', 'view = view || catalogViewRaw(); // C4b：经核心按组分页（不在渲染里夹紧页码）', "view = { pageGroups: allModelsData.slice(0, 20).map(function (r) { return { id: r.id, members: [r], orphan: false }; }), totalModels: allModelsData.length, totalGroups: allModelsData.length, totalPages: 1 }; ModelCatalogCore.acceptanceView(null);", 'W:core-calls', undefined, 'cat'],
  ['W20', 'C4c-2：renderModelsPage 里出现 innerHTML 赋值（列表区拼 HTML）', 'list.replaceChildren(frag);', "list.innerHTML = ''; list.replaceChildren(frag);", 'W:innerhtml', undefined, 'cat'],
  ['W21', 'C4c-2：表名按钮文字多一处 escapeHtml(（escapeHtml 不再只在设计说明分发那一处）', 'text: m.table_name,', 'text: escapeHtml(m.table_name),', 'W:escape', undefined, 'cat'],
  ['W22', 'C4c-2：设计说明分发去掉 escapeHtml（气泡 innerHTML 直接吃原文）', 'showDesignNotesPopover(btn, escapeHtml(m.design_notes));', 'showDesignNotesPopover(btn, m.design_notes);', 'W:escape', undefined, 'cat'],
  ['W23', 'C4c-2：列表状态同步（原 renderModelsPage 末尾的 ready 设置，3b 起在 catalogSyncListState）旁多一条 setAttribute(onclick …)', "else list.setAttribute('data-catalog-state', state);", "else list.setAttribute('data-catalog-state', state); list.setAttribute('onclick', 'x()');", 'W:onclick', undefined, 'cat'],
  ['W24', 'C4c-2：空态文案里夹带 onclick= 字面量（内联事件属性回潮）', "text: '暂无模型数据'", "text: '暂无模型数据<span onclick=x>'", 'W:onclick', undefined, 'cat'],
  ['W25', 'C4c-2：给列表容器赋 onclick 属性（el.onclick = …）', 'catalogListBound = true;', 'catalogListBound = true; list.onclick = function () {};', 'W:onclick', undefined, 'cat'],
  ['W26', 'C4c-2：renderModelsPage 里 userCanValidateModel(m) 调用两次（权限判断不再恰一次）', 'const canValidateThisModel = userCanValidateModel(m);', 'const canValidateThisModel = userCanValidateModel(m) && userCanEditModel(m);', 'W:perm', undefined, 'cat'],
  ['W27', 'C4c-2：菜单打开改成 setTimeout 延迟（契约 14：须同步）', 'if (!wasOpen) catalogSetMenu(trigger, menu, true);', 'if (!wasOpen) setTimeout(function () { catalogSetMenu(trigger, menu, true); }, 0);', 'W:sync', undefined, 'cat'],
  ['W28', 'C4c-2 2c：CAT 里某个 renderModelsPage 调用点传了手拼视图（参数不是 catalogViewRaw() 的结果）', 'renderModelsPage(); // 渲染当前页', 'renderModelsPage({ pageGroups: [], totalModels: 0, totalGroups: 0, totalPages: 1 }); // 渲染当前页', 'W:render-args', undefined, 'cat'],
  ['W28b', 'C4c-2 2c：Model_Center.html 内联脚本里某处调用 renderModelsPage 并传手拼视图（MC 里原本没有调用点）', 'function mdcRenderFootSection(detail, model) {', (src) => src.replace('function mdcRenderFootSection(detail, model) {', 'function mdcRenderFootSection(detail, model) { renderModelsPage({ pageGroups: [], totalModels: 0, totalGroups: 0, totalPages: 1 });'), 'W:render-args', undefined, 'page'],
  ['W29', 'C4c-2 2c：分页统计文案的 innerHTML 模板里插入搜索词（getCatalogQuery() 的返回值，非数值类插值）', '显示第 ${startNum}-${endNum} 组`;', '显示第 ${startNum}-${endNum} 组${getCatalogQuery()}`;', 'W:innerhtml', undefined, 'cat'],
  ['W30', 'C4c-2 2c：Model_Center.html 内联脚本里用原文调用 showDesignNotesPopover（第 2 实参不是 escapeHtml(...)）', 'function mdcRenderFootSection(detail, model) {', (src) => src.replace('function mdcRenderFootSection(detail, model) {', 'function mdcRenderFootSection(detail, model) { showDesignNotesPopover(document.body, model.design_notes);'), 'W:escape', undefined, 'page'],
  ['W31', 'C4c-2 2c：catalogMenuItem（渲染路径函数，W:sync 新增清单）里出现 setTimeout', 'function catalogMenuItem(spec) {', 'function catalogMenuItem(spec) { setTimeout(function () {}, 0);', 'W:sync', undefined, 'cat'],
  ['W32', 'C4c-2 2c：catalogBuildAcceptance（渲染路径函数，W:sync 新增清单）里出现 Promise', 'function catalogBuildAcceptance(v, rootClass) {', 'function catalogBuildAcceptance(v, rootClass) { void Promise.resolve();', 'W:sync', undefined, 'cat'],
  ['W33', 'C4c-2 2c：处理函数 openWorkbench 在 MC 里从 function 声明改成 const 赋值（window[name] 取不到）', 'function openWorkbench(modelId, mode) {', 'const openWorkbench = function (modelId, mode) {', 'W:handlers', undefined, 'page'],
  ['W34', 'C4c-2 2e：Model_Center.html 多一个无法解析的内联脚本块，里面含 showDesignNotesPopover（旧判据解析失败即 continue，会蒙混过关）', '</body>', '<script>showDesignNotesPopover(document.body, ;</script></body>', 'W:escape', undefined, 'page'],
  ['WX1', 'C4c-3 3a：catalogFetchRelations 的令牌取事件态里当前令牌（迟到响应永远通过核对）', 'token: token, ok: got.ok, data: got.data', 'token: catalogEventState.expandTokens[String(id)], ok: got.ok, data: got.data', 'W:expand-token', undefined, 'cat'],
  ['WX2', 'C4c-3 3a：catalogApplyPane 直接写事件态里的关系数据（不按不可变对待）', 'function catalogApplyPane(id) {', 'function catalogApplyPane(id) { catalogEventState.relations[String(id)] = null;', 'W:expand-state', undefined, 'cat'],
  ['WX3', 'C4c-3 3a：catalogExpandedOnPage 不再与 view.pageIds 取交集', 'return expanded.map(String).filter(id => onPage.has(id));', 'return expanded.map(String);', 'W:expand-page', undefined, 'cat'],
  ['WX4', 'C4c-3 3a：renderModelsPage 绕过 catalogExpandedOnPage 直接读事件态的展开集合', 'const expandedHere = catalogExpandedOnPage(view);', 'const expandedHere = catalogEventState.expanded.map(String);', 'W:expand-page', undefined, 'cat'],
  ['WX5', 'C4c-3 3a：展开按钮的点击接到 catalogRetryExpand（接错函数）', "catalogToggleExpand(entry.getAttribute('data-id'));", "catalogRetryExpand(entry.getAttribute('data-id'));", 'W:expand-delegate', undefined, 'cat'],
  ['WX6', 'C4c-3 3a：catalogApplyPane（W:sync 新增清单）里出现 setTimeout', 'function catalogApplyPane(id) {', 'function catalogApplyPane(id) { setTimeout(function () {}, 0);', 'W:sync', undefined, 'cat'],
  ['WX7', 'C4c-3 3a：catalogBuildEntry 里多读一处事件态的关系数据（关系数据只读 catalogMakePane 一处）', 'function catalogBuildEntry(m, canEdit, canValidate, isViewer, expanded) {', 'function catalogBuildEntry(m, canEdit, canValidate, isViewer, expanded) { void catalogEventState.relations[String(m.id)];', 'W:expand-data', undefined, 'cat'],
  ['WX8', 'C4c-3 3a：面板里的模型链接用 innerHTML 写入文本（W:innerhtml 越界）', "return catalogEl('button', { className: 'catalog-model-link', type: 'button', 'data-open-model': String(modelId), text: text });", "const b = catalogEl('button', { className: 'catalog-model-link', type: 'button', 'data-open-model': String(modelId) }); b.innerHTML = text; return b;", 'W:innerhtml', undefined, 'cat'],
  ['WX9', 'C4c-3 3a：面板里对数据多一处 escapeHtml(（escapeHtml( 不再只在设计说明分发那一处）', "catalogEl('span', { className: 'catalog-pane-msg', text: '加载中…' })", "catalogEl('span', { className: 'catalog-pane-msg', text: escapeHtml('加载中…') })", 'W:escape', undefined, 'cat'],
  ['WL1', 'C4c-3 3b：loadModels 的非 2xx 分支不调 catalogFailList（直接返回 failed，核心 listFailed 不被调用）', 'if (!res || !res.ok) return catalogFailList(token);', "if (!res || !res.ok) return 'failed';", 'W:list-fail', undefined, 'cat'],
  ['WL2', 'C4c-3 3b：catalogFailList 里弹 toast（P28 / Q15：列表失败不弹 toast）', 'catalogListError = true;\n            catalogSyncListState();', "catalogListError = true;\n            showToast('列表刷新失败', 'error');\n            catalogSyncListState();", 'W:list-fail', undefined, 'cat'],
  ['WL3', 'C4c-3 3b：ready 不看「是否成功套用过」（数据到达前也设 ready）', "const state = catalogListError ? 'error' : (catalogListApplied ? 'ready' : '');", "const state = catalogListError ? 'error' : 'ready';", 'W:list-ready', undefined, 'cat'],
  ['WL4', 'C4c-3 3b：数据套用标记提前到请求发出时置位（数据没到就算套用过）', 'const reqId = ++catalogListReqSeq;', 'const reqId = ++catalogListReqSeq; catalogListApplied = true;', 'W:list-ready', undefined, 'cat'],
  ['WL5', 'C4c-3 3b：catalogAsciiLower 改用 toLowerCase（非 ASCII 字符也被改写，与后端 asciiLower 不同口径）', 'return String(s).replace(/[A-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 32); });', 'return String(s).toLowerCase();', 'W:ascii-lower', undefined, 'cat'],
  ['WL6', 'C4c-3 3b：Model_Center.html 初始化去掉「只在 arrived 时执行 ?focus / ?id」的门', "if (loadResult !== 'arrived') return;", '', 'W:list-init', undefined, 'page'],
  ['WL7', 'C4c-3 3b：renderModelsPage 里又直接把 data-catalog-state 设成 ready（旁路 catalogSyncListState）', '            catalogLoadDomains();   // 业务域映射：首次渲染时发一次请求\n', "            list.setAttribute('data-catalog-state', 'ready');\n            catalogLoadDomains();   // 业务域映射：首次渲染时发一次请求\n", 'W:list-ready', undefined, 'cat'],
  ['WL8', 'C4c-3 3b：重试按钮的处理函数先走 reloadCatalogIfStale（有去重条件，不再「直接发一次列表请求」）', 'function catalogRetryList() {\n            loadModels()', 'function catalogRetryList() {\n            reloadCatalogIfStale();\n            loadModels()', 'W:list-retry', undefined, 'cat'],
  ['WL9', 'C4c-3 3b：catalogFailList 里 catalogListError 不再置位（失败后 ready / 提示都不变）', 'catalogListError = true;\n            catalogSyncListState();', 'catalogSyncListState();', 'W:list-fail', undefined, 'cat'],
  ['WL10', 'C4c-3 3c：loadModels 的 catch 转失败前不再 console.warn（异常被静默吞掉）', "{ console.warn('[模型目录] 列表加载失败：', e && e.message); return catalogFailList(myToken); }", '{ return catalogFailList(myToken); }', 'W:list-fail', undefined, 'cat'],
  ['WL11', 'C4c-3 3c：空态「暂无模型数据」不看 catalogListApplied（从未成功 / 数据没到也显示）', 'if (view.totalModels === 0 && catalogListApplied) frag.appendChild(', 'if (view.totalModels === 0) frag.appendChild(', 'W:list-ready', undefined, 'cat'],
  ['WX10', 'C4c-3 3d（codex 40Tc-M2）：catalogCollapseAll 把事件态整体换成对象字面量展开写法（{ ...catalogEventState, relations: {} }）', 'catalogEventState = s;', 'catalogEventState = { ...catalogEventState, relations: {} };', 'W:expand-state', undefined, 'cat'],
  ['WX11', 'C4c-3 3d（codex 40Tc-M2）：catalogCollapseAll 之后 Object.assign(catalogEventState, { relations: {} }) 原地覆盖关系缓存', 'catalogEventState = s;', 'catalogEventState = s;\n            Object.assign(catalogEventState, { relations: {} });', 'W:expand-state', undefined, 'cat'],
  ['W6', '接线：getSortedModels 改成直接按行排序（不经核心）', 'getSortedModels() {\n            return ModelCatalogCore.computeView(allModelsData, {', 'getSortedModels() {\n            return ModelCatalogCoreX.computeView(allModelsData, {', 'W:core-calls', undefined, 'cat'],
  ['W7', '接线：运行时版本握手的字面量与核心 CORE_VERSION 不一致（mcc3 → mcc4）', "core.CORE_VERSION !== 'mcc3'", "core.CORE_VERSION !== 'mcc4'", 'W:corever', undefined, 'cat'],
  ['W8', '在途计数：catalogTrackWrite 不再计数', 'catalogWritesInFlight++;', '', 'W:track', undefined, 'cat'],
  ['W9', '重载条件：reloadCatalogIfStale 不再看「带钩子的弹窗是否开着」（reopen-ignore）', 'if (catalogWritesInFlight > 0 || catalogHookModalOpen()) return;', 'if (catalogWritesInFlight > 0) return;', 'W:track', undefined, 'cat'],
  ['W10', '写请求结束不再调用 reloadCatalogIfStale', 'catalogWritesDone++;\n                reloadCatalogIfStale();', 'catalogWritesDone++;', 'W:track', undefined, 'cat'],
  ['W11', '去重判断被删（no-dedupe）：已有覆盖全部写入的请求在途时仍再发一个', 'if (catalogListReqSeen === catalogWritesDone) return;', '', 'W:track', undefined, 'cat'],
  ['W12', 'loadModels 失败路径返回值被丢（裸 return;，3b 起失败返回 catalogFailList(token) 的结果）', 'if (!res || !res.ok) return catalogFailList(token);', 'if (!res || !res.ok) return;', 'W:track', undefined, 'cat'],
  ['W15', 'seen-at-arrival：catalogListSeen 取到达时的 catalogWritesDone（而非发出时）', 'catalogListSeen = Math.max(catalogListSeen, seen);', 'catalogListSeen = Math.max(catalogListSeen, catalogWritesDone);', 'W:track', undefined, 'cat'],
  ['W16', 'seen-on-failure：失败 / 被取代时也推进 catalogListSeen（移到 finally）', 'if (catalogListReqSeq === reqId) catalogListReqSeen = -1;', 'if (catalogListReqSeq === reqId) catalogListReqSeen = -1;\n                catalogListSeen = Math.max(catalogListSeen, seen);', 'W:track', undefined, 'cat'],
  ['W17', 'done-not-counted：finally 里不递增 catalogWritesDone', 'catalogWritesDone++;\n                reloadCatalogIfStale();', 'reloadCatalogIfStale();', 'W:track', undefined, 'cat'],
  ['W18', 'finally 里不再清「最新请求」的在途记录', 'if (catalogListReqSeq === reqId) catalogListReqSeen = -1;', '', 'W:track', undefined, 'cat'],
  ['WR1', 'D-7 静态判据：saveCustomDDL 的第一个写请求不再被 catalogTrackWrite 包住（改名 catalogTrackWriteX）', 'function saveCustomDDL(', (src) => { const i = src.indexOf('function saveCustomDDL('); if (i < 0) throw new Error('找不到 saveCustomDDL'); const j = src.indexOf('catalogTrackWrite(', i); if (j < 0) throw new Error('saveCustomDDL 里找不到 catalogTrackWrite('); return src.slice(0, j) + 'catalogTrackWriteX(' + src.slice(j + 'catalogTrackWrite('.length); }, 'W:write', undefined, 'page'],
  ['WR2', 'D-7 静态判据：saveAllCustomETL 的第一个写请求不再被 catalogTrackWrite 包住（改名 catalogTrackWriteX）', 'function saveAllCustomETL(', (src) => { const i = src.indexOf('function saveAllCustomETL('); if (i < 0) throw new Error('找不到 saveAllCustomETL'); const j = src.indexOf('catalogTrackWrite(', i); if (j < 0) throw new Error('saveAllCustomETL 里找不到 catalogTrackWrite('); return src.slice(0, j) + 'catalogTrackWriteX(' + src.slice(j + 'catalogTrackWrite('.length); }, 'W:write', undefined, 'page'],
  ['WR3', 'D-7 静态判据：saveEtlEdits 的第一个写请求不再被 catalogTrackWrite 包住（改名 catalogTrackWriteX）', 'function saveEtlEdits(', (src) => { const i = src.indexOf('function saveEtlEdits('); if (i < 0) throw new Error('找不到 saveEtlEdits'); const j = src.indexOf('catalogTrackWrite(', i); if (j < 0) throw new Error('saveEtlEdits 里找不到 catalogTrackWrite('); return src.slice(0, j) + 'catalogTrackWriteX(' + src.slice(j + 'catalogTrackWrite('.length); }, 'W:write', undefined, 'page'],
  ['WR4', 'D-7 静态判据：saveAllDwdEtl 的第一个写请求不再被 catalogTrackWrite 包住（改名 catalogTrackWriteX）', 'function saveAllDwdEtl(', (src) => { const i = src.indexOf('function saveAllDwdEtl('); if (i < 0) throw new Error('找不到 saveAllDwdEtl'); const j = src.indexOf('catalogTrackWrite(', i); if (j < 0) throw new Error('saveAllDwdEtl 里找不到 catalogTrackWrite('); return src.slice(0, j) + 'catalogTrackWriteX(' + src.slice(j + 'catalogTrackWrite('.length); }, 'W:write', undefined, 'page'],
  ['WR5', 'D-7 静态判据：silentSaveScripts 的第一个写请求不再被 catalogTrackWrite 包住（改名 catalogTrackWriteX）', 'function silentSaveScripts(', (src) => { const i = src.indexOf('function silentSaveScripts('); if (i < 0) throw new Error('找不到 silentSaveScripts'); const j = src.indexOf('catalogTrackWrite(', i); if (j < 0) throw new Error('silentSaveScripts 里找不到 catalogTrackWrite('); return src.slice(0, j) + 'catalogTrackWriteX(' + src.slice(j + 'catalogTrackWrite('.length); }, 'W:write', undefined, 'page'],
  ['WR6', 'D-7 静态判据：runValidation 的第一个写请求不再被 catalogTrackWrite 包住（改名 catalogTrackWriteX）', 'function runValidation(', (src) => { const i = src.indexOf('function runValidation('); if (i < 0) throw new Error('找不到 runValidation'); const j = src.indexOf('catalogTrackWrite(', i); if (j < 0) throw new Error('runValidation 里找不到 catalogTrackWrite('); return src.slice(0, j) + 'catalogTrackWriteX(' + src.slice(j + 'catalogTrackWrite('.length); }, 'W:write', undefined, 'page'],
  ['WR7', 'D-7 静态判据：autoSaveOdsScripts 的第一个写请求不再被 catalogTrackWrite 包住（改名 catalogTrackWriteX）', 'function autoSaveOdsScripts(', (src) => { const i = src.indexOf('function autoSaveOdsScripts('); if (i < 0) throw new Error('找不到 autoSaveOdsScripts'); const j = src.indexOf('catalogTrackWrite(', i); if (j < 0) throw new Error('autoSaveOdsScripts 里找不到 catalogTrackWrite('); return src.slice(0, j) + 'catalogTrackWriteX(' + src.slice(j + 'catalogTrackWrite('.length); }, 'W:write', undefined, 'page'],
  ['WR8', 'D-7 静态判据：selfArchiveFromValidation 的第一个写请求不再被 catalogTrackWrite 包住（改名 catalogTrackWriteX）', 'function selfArchiveFromValidation(', (src) => { const i = src.indexOf('function selfArchiveFromValidation('); if (i < 0) throw new Error('找不到 selfArchiveFromValidation'); const j = src.indexOf('catalogTrackWrite(', i); if (j < 0) throw new Error('selfArchiveFromValidation 里找不到 catalogTrackWrite('); return src.slice(0, j) + 'catalogTrackWriteX(' + src.slice(j + 'catalogTrackWrite('.length); }, 'W:write', undefined, 'page'],
  ['WR9', 'D-7 静态判据：confirmSemanticReview 的第一个写请求不再被 catalogTrackWrite 包住（改名 catalogTrackWriteX）', 'function confirmSemanticReview(', (src) => { const i = src.indexOf('function confirmSemanticReview('); if (i < 0) throw new Error('找不到 confirmSemanticReview'); const j = src.indexOf('catalogTrackWrite(', i); if (j < 0) throw new Error('confirmSemanticReview 里找不到 catalogTrackWrite('); return src.slice(0, j) + 'catalogTrackWriteX(' + src.slice(j + 'catalogTrackWrite('.length); }, 'W:write', undefined, 'page'],
  ['HK1', 'D-7 静态判据：closeValidationModal 删掉 reloadCatalogIfStale() 钩子', 'function closeValidationModal(', (src) => { const i = src.indexOf('function closeValidationModal('); if (i < 0) throw new Error('找不到 closeValidationModal'); const j = src.indexOf('reloadCatalogIfStale();', i); if (j < 0) throw new Error('closeValidationModal 里找不到 reloadCatalogIfStale();'); return src.slice(0, j) + '' + src.slice(j + 'reloadCatalogIfStale();'.length); }, 'W:hook', undefined, 'page'],
  ['HK2', 'D-7 静态判据：closeDimDdlPreviewModal 删掉 reloadCatalogIfStale() 钩子', 'function closeDimDdlPreviewModal(', (src) => { const i = src.indexOf('function closeDimDdlPreviewModal('); if (i < 0) throw new Error('找不到 closeDimDdlPreviewModal'); const j = src.indexOf('reloadCatalogIfStale();', i); if (j < 0) throw new Error('closeDimDdlPreviewModal 里找不到 reloadCatalogIfStale();'); return src.slice(0, j) + '' + src.slice(j + 'reloadCatalogIfStale();'.length); }, 'W:hook', undefined, 'page'],
  ['HK3', 'D-7 静态判据：closeDimEtlPreviewModal 删掉 reloadCatalogIfStale() 钩子', 'function closeDimEtlPreviewModal(', (src) => { const i = src.indexOf('function closeDimEtlPreviewModal('); if (i < 0) throw new Error('找不到 closeDimEtlPreviewModal'); const j = src.indexOf('reloadCatalogIfStale();', i); if (j < 0) throw new Error('closeDimEtlPreviewModal 里找不到 reloadCatalogIfStale();'); return src.slice(0, j) + '' + src.slice(j + 'reloadCatalogIfStale();'.length); }, 'W:hook', undefined, 'page'],
  ['HK4', 'D-7 静态判据：closeDwdDdlModal 删掉 reloadCatalogIfStale() 钩子', 'function closeDwdDdlModal(', (src) => { const i = src.indexOf('function closeDwdDdlModal('); if (i < 0) throw new Error('找不到 closeDwdDdlModal'); const j = src.indexOf('reloadCatalogIfStale();', i); if (j < 0) throw new Error('closeDwdDdlModal 里找不到 reloadCatalogIfStale();'); return src.slice(0, j) + '' + src.slice(j + 'reloadCatalogIfStale();'.length); }, 'W:hook', undefined, 'page'],
  ['HK5', 'D-7 静态判据：closeDwdEtlPreviewModal 删掉 reloadCatalogIfStale() 钩子', 'function closeDwdEtlPreviewModal(', (src) => { const i = src.indexOf('function closeDwdEtlPreviewModal('); if (i < 0) throw new Error('找不到 closeDwdEtlPreviewModal'); const j = src.indexOf('reloadCatalogIfStale();', i); if (j < 0) throw new Error('closeDwdEtlPreviewModal 里找不到 reloadCatalogIfStale();'); return src.slice(0, j) + '' + src.slice(j + 'reloadCatalogIfStale();'.length); }, 'W:hook', undefined, 'page'],
  ['W13', 'A3：focusCatalogModel 直接清输入框（不取核心结果的 state.query）', 'if (el) el.value = r.state.query;', "if (el) el.value = '';", 'W:focus', undefined, 'cat'],
  ['W14', 'A3：focusCatalogModel 不再调用核心 focus 事件（改名）', 'ModelCatalogCore.focus(catalogSyncState()', 'ModelCatalogCore.focusX(catalogSyncState()', 'W:focus', undefined, 'cat'],
  ['WR10', 'T5：silentSaveScripts 里加一个未包装的变量 opts 写请求（const opts = { method: POST }; authFetch(url, opts)）', 'function silentSaveScripts(', (src) => { const i = src.indexOf('function silentSaveScripts('); const j = src.indexOf('{', src.indexOf(')', i)); return src.slice(0, j + 1) + " const __o = { method: 'POST' }; authFetch('/api/models/0/save-scripts', __o);" + src.slice(j + 1); }, 'W:write', undefined, 'page'],
  ['WR11', 'T5：silentSaveScripts 里加一个 method 非字面量的未包装请求', 'function silentSaveScripts(', (src) => { const i = src.indexOf('function silentSaveScripts('); const j = src.indexOf('{', src.indexOf(')', i)); return src.slice(0, j + 1) + " const __m = 'PO' + 'ST'; authFetch('/api/models/0/save-scripts', { method: __m });" + src.slice(j + 1); }, 'W:write', undefined, 'page'],
  ["P36a", "C4c-4 P36：setQuery 去掉同词守卫（同词也回第 1 页并清空）", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (false) {", "P36:q.same"],
  ["P36b", "C4c-4 P36：gotoPage 去掉同页守卫（翻到当前页也清空展开）", "if (p === S.page) return { state: c, effects: [] };", "", "P36:p.same"],
  ["P36c", "C4c-4 P36：setQuery 的比较改成大小写不敏感（大小写不同应按「改搜索」处理）", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q).trim().toLowerCase() === String(S.query === null || S.query === undefined ? '' : S.query).trim().toLowerCase()) {", "P36:q.case"],
  ["P36d", "C4c-4 P36：setQuery 的比较不 trim（首尾空格不同算改搜索）", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q) === String(S.query === null || S.query === undefined ? '' : S.query)) {", "P36:q.same.pad"],
  ["P36e", "C4c-4 P36：setQuery 对 undefined / null 不按空串（String(undefined) 变成字面量）", "String(q === null || q === undefined ? '' : q).trim()", "String(q).trim()", "P36:q.empty"],
  ["P36f", "C4c-4 P36：setQuery 同词分支仍回第 1 页", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) { c.page = 1;", "P36:q.same"],
  ["P36g", "C4c-4 P36：setQuery 同词分支仍清展开", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) { clearExpand(c);", "P36:q.same"],
  ["P36h", "C4c-4 P36：gotoPage 同页分支仍清展开", "if (p === S.page) return { state: c, effects: [] };", "if (p === S.page) { clearExpand(c); return { state: c, effects: [] }; }", "P36:p.same"],
  ["P36i", "C4c-4 P36：gotoPage 守卫写成 p <= S.page（向前翻页被当成没变）", "if (p === S.page) return { state: c, effects: [] };", "if (p <= S.page) return { state: c, effects: [] };", "E2c"],
  ["P36j", "C4c-4 P36：gotoPage 把同页判断放在参数校验之前（page 0 同页判断绕过校验不可能，但 totalPages 非法时同页直接返回）", "var p = a.page;\n        assertPositiveInteger(p, 'page');", "var p = a.page;\n        if (p === S.page) return { state: c, effects: [] };\n        assertPositiveInteger(p, 'page');", "PG3"],
  ["P36k", "codex 41Td-M4：setQuery 同词分支仍把 query 改写成新词原值（c.query = q）", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) { c.query = q;", "P36:q.same.pad.full"],
  ["P36l", "codex 41Td-M4：setQuery 同词分支把 query 改写成 trim 后的新词（只在当前词自带首尾空格时看得出）", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) { c.query = String(q === null || q === undefined ? '' : q).trim();", "P36:q.same.basepad.full"],
  ["P36n", "codex 41Td-M4：setQuery 同词分支把 null / undefined 的 query 改写成空串（只在当前词为 null / undefined 的对照里看得出）", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) { if (S.query === null || S.query === undefined) c.query = '';", "P36:q.nullbase.full"],
  ["WZ1", "codex 41Td-M1：Pick 里 const r = setFilter(…).state 但仍传 r.state（采用的其实是 undefined）", "const r = ModelCatalogCore.setFilter(catalogSyncState(), key, next);", "const r = ModelCatalogCore.setFilter(catalogSyncState(), key, next).state;", "W:filters", undefined, "cat"],
  ["WZ2", "codex 41Td-M1：Clear 的累积赋值漏写 .state（acc 成了结果对象）", "keys.forEach(k => { acc = ModelCatalogCore.setFilter(acc, k, '').state; });", "keys.forEach(k => { acc = ModelCatalogCore.setFilter(acc, k, ''); });", "W:filters", undefined, "cat"],
  ["WZ3", "codex 41Td-M2：catalogRailPatch 属性对齐分支的比较条件写反（!== 改成 ===）", "Array.from(freshEl.attributes).forEach(a => { if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value); });", "Array.from(freshEl.attributes).forEach(a => { if (oldEl.getAttribute(a.name) === a.value) oldEl.setAttribute(a.name, a.value); });", "W:rail", undefined, "cat"],
  ["WZ4", "codex 41Td-M2：catalogRailPatch 叶子文字分支的比较条件写反（!== 改成 ===）", "if (oldEl.children.length > 0 || oldEl.textContent !== freshEl.textContent) oldEl.textContent = freshEl.textContent;", "if (oldEl.children.length > 0 || oldEl.textContent === freshEl.textContent) oldEl.textContent = freshEl.textContent;", "W:rail", undefined, "cat"],
  ["WZ5", "codex 41-L1：catalogRenderRail 对齐后不归还焦点", "            if (focused && focused !== document.activeElement && rail.contains(focused)) focused.focus({ preventScroll: true });   // codex 41-L1\n", "", "W:rail", undefined, "cat"],
  ["WZ6", "codex 41-L1：catalogRenderRail 不记对齐前的焦点元素（focused 没有声明）", "            const focused = document.activeElement;   // codex 41-L1：reconcile 可能把有焦点的按钮 insertBefore 搬动（搬动即失焦），对齐后归还\n", "", "W:rail", undefined, "cat"],
  ["WZ7", "codex 41-M1：catalogRenderUnowned 改回整面板 panel.replaceChildren（返回按钮随每次重画被换掉，mousedown 与 mouseup 之间重画丢点击）", "catalogRailReconcile(panel, [", (src) => src.replace("catalogRailReconcile(panel, [", "panel.replaceChildren(").replace("                body\n            ]);", "                body\n            );"), "W:rail", undefined, "cat"],   // 首红落在 W:rail 的 reconcile 调用方清单（catalogRenderUnowned 不再调用它）；W:unowned 的新判据同样判红（WZ8 单独证明）
  ["WZ8", "codex 41-M1：catalogRenderUnowned 先整面板清空（panel.textContent = ''）再就地对齐（等同整面板重建）", "            if (!catalogUnownedMode) return;\n            let body;", "            if (!catalogUnownedMode) return;\n            panel.textContent = '';\n            let body;", "W:unowned", undefined, "cat"],
  ["WZ9", "codex 41-L2：未归属表类型列退回 catalogText（空串 / 纯空白 / null / 缺失显示空白而不是「—」）", "catalogEl('td', { className: 'catalog-obj-type', text: catalogOrDash(o.obj_type) }),", "catalogEl('td', { className: 'catalog-obj-type', text: catalogText(o.obj_type) }),", "W:unowned", undefined, "cat"],
  ["WZ10", "fix41b（预筛 LOW-2）：catalogRailPatch 删掉「纯文字叶子换成有子元素时先清旧文字」那一行（旧文字残留在新子元素之前）", "            if (oldEl.children.length === 0 && oldEl.textContent !== '') oldEl.textContent = '';   // codex 41：旧节点是纯文字叶子、新节点有子元素（「加载中…」→「加载失败」+ 重试）：先清掉旧文字，否则它残留在新子元素之前\n", "", "W:rail", undefined, "cat"],
  ["WF1", "C4c-4 4a：catalogSyncState 的 filters 改回 {}（第 1 处）", "sortDir: currentSortDir, query: getCatalogQuery(), filters: catalogFilters,", "sortDir: currentSortDir, query: getCatalogQuery(), filters: {},", "W:filters", undefined, "cat"],
  ["WF2", "C4c-4 4a：catalogViewRaw 的 filters 改回 {}（第 2 处）", "filters: catalogFilters, sortBy: currentSortBy, sortDir: currentSortDir,\n                page: page", "filters: {}, sortBy: currentSortBy, sortDir: currentSortDir,\n                page: page", "W:filters", undefined, "cat"],
  ["WF3", "C4c-4 4a：getSortedModels 的 filters 改回 {}（第 3 处）", "filters: catalogFilters, sortBy: currentSortBy, sortDir: currentSortDir, page: 1, pageSize: pageSize,", "filters: {}, sortBy: currentSortBy, sortDir: currentSortDir, page: 1, pageSize: pageSize,", "W:filters", undefined, "cat"],
  ["WF4", "C4c-4 4a：renderModelsPage 里多出第二个 catalogFilters 写入点", "catalogRenderedQuery = getCatalogQuery();", "catalogRenderedQuery = getCatalogQuery();\n            catalogFilters = {};", "W:filters", undefined, "cat"],
  ["WF5", "C4c-4 4a：focusCatalogModel 不再把 focus 结果的筛选写回 catalogFilters", "catalogAdoptFilters(r.state);   // focus 清空筛选：回写单一来源，不让页面层残留旧筛选", "", "W:filters", undefined, "cat"],
  ["WF6", "C4c-4 4a：catalogAdoptFilters 与核心状态共享 filters 引用（不复制）", "catalogFilters = Object.assign({}, state.filters);", "catalogFilters = state.filters;", "W:filters", undefined, "cat"],
  ["WT1", "C4c-4 4a：loadModels 成功路径不再更新页头在册数", "catalogUpdateTotal();   // C4c-4（4a）：页头在册数随数据到达更新", "", "W:total", undefined, "cat"],
  ["WT2", "C4c-4 4a：在册数取 allModelsData.length（不经 railCounts）", "el.textContent = String(ModelCatalogCore.railCounts(allModelsData).total);", "el.textContent = String(allModelsData.length);", "W:total", undefined, "cat"],
  ["WT3", "C4c-4 4a：在册数更新挪到 renderModelsPage 之后（渲染抛错时数不更新）", "catalogUpdateTotal();   // C4c-4（4a）：页头在册数随数据到达更新\n                catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）\n                renderModelsPage(); // 渲染当前页", "catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）\n                renderModelsPage(); // 渲染当前页\n                catalogUpdateTotal();", "W:total", undefined, "cat"],
  ["WP1", "C4c-4 4a P36：applyCatalogSearch 的旧词取 catalogSyncState().query（已是输入框新词，任何输入都被判成没变）", "ModelCatalogCore.setQuery(Object.assign({}, catalogSyncState(), { query: catalogRenderedQuery }), getCatalogQuery())", "ModelCatalogCore.setQuery(catalogSyncState(), getCatalogQuery())", "W:p36", undefined, "cat"],
  ["WP2", "C4c-4 4a P36：renderModelsPage 不再记录 catalogRenderedQuery", "catalogRenderedQuery = getCatalogQuery();", "", "W:p36", undefined, "cat"],
  ["WS1", "C4c-4 4a：catalogUpdateTotal（W:sync 清单）里出现 setTimeout", "function catalogUpdateTotal() {", "function catalogUpdateTotal() { setTimeout(function () {}, 0);", "W:sync", undefined, "cat"],
  ["WS2", "C4c-4 4a：catalogAdoptFilters（W:sync 清单）里出现 Promise", "function catalogAdoptFilters(state) {", "function catalogAdoptFilters(state) { void Promise.resolve();", "W:sync", undefined, "cat"],
  ["WRL1", "C4c-4 4b：左栏单击（catalogRailPick）不再把核心返回的筛选写回 catalogFilters", "catalogEventState = r.state;\n            catalogAdoptFilters(r.state);\n            currentPage = r.state.page;", "catalogEventState = r.state;\n            currentPage = r.state.page;", "W:filters", undefined, "cat"],
  ["WRL2", "C4c-4 4b：「清除 N 项」（catalogRailClear）不再写回 catalogFilters", "catalogEventState = acc;\n            catalogAdoptFilters(acc);", "catalogEventState = acc;", "W:filters", undefined, "cat"],
  ["WRL3", "C4c-4 4b：catalogAdoptFilters 写回后不再重画左栏（选中态与 catalogFilters 脱节）", "catalogRenderRail();   // 4b：左栏选中态永远跟着 catalogFilters 走", "", "W:rail", undefined, "cat"],
  ["WRL4", "C4c-4 4b：loadModels 成功路径不再刷新左栏计数", "catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）", "", "W:rail", undefined, "cat"],
  ["WRL5", "C4c-4 4b：列表请求失败（catalogFailList）时也刷新左栏计数（失败应保留上次计数）", "catalogListError = true;\n            catalogSyncListState();", "catalogListError = true;\n            catalogRefreshRail();\n            catalogSyncListState();", "W:rail", undefined, "cat"],
  ["WRL6", "C4c-4 4b：applyCatalogSearch 里多一处 ModelCatalogCore.setFilter（左栏点击不再是筛选的唯一入口）", "const r = ModelCatalogCore.setQuery(Object.assign({}, catalogSyncState(), { query: catalogRenderedQuery }), getCatalogQuery());", "const r = ModelCatalogCore.setQuery(Object.assign({}, catalogSyncState(), { query: catalogRenderedQuery }), getCatalogQuery());\n            ModelCatalogCore.setFilter(catalogSyncState(), 'layer', 'ODS');", "W:rail", undefined, "cat"],
  ["WRL7", "C4c-4 4b：左栏计数改取当前过滤后的行（getSortedModels，随筛选 / 搜索联动，违反 D-8）", "catalogRailCounts = ModelCatalogCore.railCounts(allModelsData);", "catalogRailCounts = ModelCatalogCore.railCounts(getSortedModels());", "W:rail", undefined, "cat"],
  ["WRL8", "C4c-4 4b：catalogRailPick 去掉「该组本来就是全部时再点全部不调核心」", "if (next === cur) return;", "", "W:rail", undefined, "cat"],
  ["WRL9", "C4c-4 4b：「清除 N 项」顺手清空搜索框（只清筛选的口径被破坏）", "if (keys.length === 0) return;\n            let acc = catalogSyncState();", "if (keys.length === 0) return;\n            document.getElementById('searchKeyword').value = '';\n            let acc = catalogSyncState();", "W:rail", undefined, "cat"],
  ["WRL10", "C4c-4 4b：MC 左栏 aside 去掉 aria-label", '<aside id="catalogRail" class="catalog-rail" aria-label="筛选与分组"></aside>', '<aside id="catalogRail" class="catalog-rail"></aside>', "W:rail", undefined, "page"],
  ["WS3", "C4c-4 4b：catalogRenderRail（W:sync 清单）里出现 setTimeout", "function catalogRenderRail() {", "function catalogRenderRail() { setTimeout(function () {}, 0);", "W:sync", undefined, "cat"],
  ["WS4", "C4c-4 4b：catalogRailPick（W:sync 清单）里出现 Promise", "function catalogRailPick(spec) {", "function catalogRailPick(spec) { void Promise.resolve();", "W:sync", undefined, "cat"],
  ["WU1", "C4c-4 4c：loadModels 成功路径重取未归属清单（模型列表重载不应重取）", "catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）", "catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）\n                catalogLoadUnowned();", "W:unowned", undefined, "cat"],
  ["WU2", "C4c-4 4c：loadModels 成功路径退出未归属模式（重载不应退出）", "catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）", "catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）\n                catalogSetUnownedMode(false);", "W:unowned", undefined, "cat"],
  ["WU3", "C4c-4 4c：catalogLoadUnowned 的请求序号不再递增（旧响应永远算最新）", "const seq = ++catalogUnownedSeq;", "const seq = catalogUnownedSeq;", "W:unowned", undefined, "cat"],
  ["WU4", "C4c-4 4c：catalogLoadUnowned 去掉 await authFetch 之后的序号检查", "const res = await authFetch('/api/model-impl-objects?unowned=1');\n                if (seq !== catalogUnownedSeq) return 'discarded';", "const res = await authFetch('/api/model-impl-objects?unowned=1');", "W:unowned", undefined, "cat"],
  ["WU5", "C4c-4 4c：catalogLoadUnowned 的 catch 开头去掉序号检查（迟到的网络错误会覆盖新结果）", "} catch (e) {\n                if (seq !== catalogUnownedSeq) return 'discarded';\n", "} catch (e) {\n", "W:unowned", undefined, "cat"],
  ["WU6", "C4c-4 4c：catalogRetryUnowned 去掉在途守卫", "if (catalogUnownedBusy) return;\n            catalogLoadUnowned().catch(", "catalogLoadUnowned().catch(", "W:unowned", undefined, "cat"],
  ["WU7", "C4c-4 4c：重试按钮在途时不置灰", "'data-catalog-act': 'retry-unowned', disabled: catalogUnownedBusy, text: '重试'", "'data-catalog-act': 'retry-unowned', text: '重试'", "W:unowned", undefined, "cat"],
  ["WU8", "C4c-4 4c：catalogRailPick 点筛选项不先退出未归属模式", "catalogSetUnownedMode(false);   // 4c：未归属模式下点任一筛选项——先退出（同「返回」），再按 4b 现行为执行\n", "", "W:unowned", undefined, "cat"],
  ["WU9", "C4c-4 4c：catalogRailPick 的退出挪到「next === cur 就返回」之后（点已是「全部」的「全部」不退出）", "catalogSetUnownedMode(false);   // 4c：未归属模式下点任一筛选项——先退出（同「返回」），再按 4b 现行为执行\n", (src) => { const a = "catalogSetUnownedMode(false);   // 4c：未归属模式下点任一筛选项——先退出（同「返回」），再按 4b 现行为执行\n"; if (src.split(a).length - 1 !== 1) throw new Error('锚点不唯一'); const b = src.split(a).join(''); const c = 'if (next === cur) return;'; if (b.split(c).length - 1 !== 1) throw new Error('next === cur 锚点不唯一'); return b.split(c).join(c + '\n            catalogSetUnownedMode(false);'); }, "W:unowned", undefined, "cat"],
  ["WU10", "C4c-4 4c：catalogRailClear 点「清除 N 项」不先退出", "catalogSetUnownedMode(false);   // 4c：未归属模式下点「清除 N 项」——先退出，再清筛选\n", "", "W:unowned", undefined, "cat"],
  ["WU11", "C4c-4 4c：入口按钮带 data-rail（会被左栏读法当成筛选项）", "id: 'catalogRailUnowned', 'data-catalog-act': 'unowned',", "id: 'catalogRailUnowned', 'data-rail': 'unowned:', 'data-catalog-act': 'unowned',", "W:unowned", undefined, "cat"],
  ["WU12", "C4c-4 4c：入口按钮带 data-act（会被 C40 的行动作读法当成行内动作）", "id: 'catalogRailUnowned', 'data-catalog-act': 'unowned',", "id: 'catalogRailUnowned', 'data-act': 'history', 'data-catalog-act': 'unowned',", "W:unowned", undefined, "cat"],
  ["WU13", "C4c-4 4c：未归属表的徽章格不走 catalogObjBadgeKids（自己再写一套）", "catalogEl('td', { className: 'catalog-obj-badges' }, catalogObjBadgeKids(o)),", "catalogEl('td', { className: 'catalog-obj-badges' }, [catalogBuildImplBadge('doc', o.badges ? o.badges.doc : null)]),", "W:unowned", undefined, "cat"],
  ["WU14", "C4c-4 4c：未归属表的摘要格用 innerHTML 写入", "catalogEl('td', { className: 'catalog-obj-summary', text: catalogOrDash(o.summary) }),", "(() => { const t = catalogEl('td', { className: 'catalog-obj-summary' }); t.innerHTML = catalogOrDash(o.summary); return t; })(),", "W:innerhtml", undefined, "cat"],
  ["WU15", "C4c-4 4c：未归属加载失败时弹 toast", "catalogUnownedStatus = rows === null ? 'error' : 'ok';", "catalogUnownedStatus = rows === null ? 'error' : 'ok';\n            if (rows === null) showToast('未归属对象加载失败', 'error');", "W:unowned", undefined, "cat"],
  ["WU16", "C4c-4 4c：未归属请求丢掉 ?unowned=1（会取回全部对象）", "authFetch('/api/model-impl-objects?unowned=1')", "authFetch('/api/model-impl-objects')", "W:unowned", undefined, "cat"],
  ["WU17", "C4c-4 4c：MC 的未归属面板不带 hidden（平时就显示）", "<div id=\"catalogUnownedPanel\" class=\"catalog-unowned\" role=\"region\" aria-label=\"未归属对象\" hidden></div>", "<div id=\"catalogUnownedPanel\" class=\"catalog-unowned\" role=\"region\" aria-label=\"未归属对象\"></div>", "W:unowned", undefined, "page"],
  ["WU18", "C4c-4 4c：MC 的隐藏规则只隐藏 .catalog-wrap、不隐藏分页", "#modelListSection.is-unowned > .catalog-wrap, #modelListSection.is-unowned > #paginationContainer { display: none !important; }", "#modelListSection.is-unowned > .catalog-wrap { display: none !important; }", "W:unowned", undefined, "page"],
  ["WU19", "C4c-4 4c：catalogRenderUnowned（W:sync 清单）里出现 setTimeout", "function catalogRenderUnowned() {", "function catalogRenderUnowned() { setTimeout(function () {}, 0);", "W:sync", undefined, "cat"],
  ["WU20", "C4c-4 4c：catalogSetUnownedMode（W:sync 清单）里出现 Promise", "function catalogSetUnownedMode(on) {", "function catalogSetUnownedMode(on) { void Promise.resolve();", "W:sync", undefined, "cat"],
  ["WU21", "C4c-4 4c：catalogLeaveUnowned 里直接改 catalogUnownedMode（第二个写入点）", "function catalogLeaveUnowned() {\n            catalogSetUnownedMode(false);\n", "function catalogLeaveUnowned() {\n            catalogUnownedMode = false;\n            catalogSetUnownedMode(false);\n", "W:unowned", undefined, "cat"],
  ["WU22", "C4c-4 4c：initListSorting 不再发起始请求", "catalogLoadUnowned().catch((e) => console.warn('[模型目录] 未归属对象加载异常：', e && e.message));", "", "W:unowned", undefined, "cat"],
  ["WU23", "C4c-4 4c：renderModelsPage 因未归属模式跳过渲染", "view = view || catalogViewRaw(); // C4b：经核心按组分页（不在渲染里夹紧页码）", "view = view || catalogViewRaw(); // C4b：经核心按组分页（不在渲染里夹紧页码）\n            if (catalogUnownedMode) return;", "W:unowned", undefined, "cat"],
  ["WU24", "C4c-4 4c：catalogLoadUnowned 去掉 res.json() 之后的序号检查（W 套件里这一处与 await authFetch 之后那处互为冗余，行为用例拦不住，只靠静态判据钉位置）", "const data = await res.json();\n                    if (seq !== catalogUnownedSeq) return 'discarded';", "const data = await res.json();", "W:unowned", undefined, "cat"],
  ["WFM1", "C4c-4 4d：catalogRailPick 里用成员写入 catalogFilters[key] = next（绕过 catalogAdoptFilters 的整体复制赋值）", "const next = catalogRailSame(key, cur, value) ? '' : value;", "const next = catalogRailSame(key, cur, value) ? '' : value;\n            catalogFilters[key] = next;", "W:filters", undefined, "cat"],
  ["WFM2", "C4c-4 4d：catalogRailPick 里 Object.assign(catalogFilters, { layer: 'ODS' }) 原地改筛选", "const next = catalogRailSame(key, cur, value) ? '' : value;", "const next = catalogRailSame(key, cur, value) ? '' : value;\n            Object.assign(catalogFilters, { layer: 'ODS' });", "W:filters", undefined, "cat"],
  ["WFM3", "C4c-4 4d：catalogRailPick 的 catalogAdoptFilters 实参改成 catalogEventState（不是本函数内 setFilter 的返回值；运行时恰好等值，只有静态判据能看出）", "catalogEventState = r.state;\n            catalogAdoptFilters(r.state);\n            currentPage = r.state.page;", "catalogEventState = r.state;\n            catalogAdoptFilters(catalogEventState);\n            currentPage = r.state.page;", "W:filters", undefined, "cat"],
  ["WFM4", "C4c-4 4d：catalogRailClear 的 catalogAdoptFilters 实参改成 catalogEventState", "catalogEventState = acc;\n            catalogAdoptFilters(acc);", "catalogEventState = acc;\n            catalogAdoptFilters(catalogEventState);", "W:filters", undefined, "cat"],
  ["WFM5", "C4c-4 4d：catalogRailPick 里 delete catalogFilters.layer", "const next = catalogRailSame(key, cur, value) ? '' : value;", "const next = catalogRailSame(key, cur, value) ? '' : value;\n            delete catalogFilters.layer;", "W:filters", undefined, "cat"],
  ["WFM6", "C4c-4 4d：catalogRailPick 里 catalogFilters.n++（UpdateExpression）", "const next = catalogRailSame(key, cur, value) ? '' : value;", "const next = catalogRailSame(key, cur, value) ? '' : value;\n            catalogFilters.n++;", "W:filters", undefined, "cat"],
  ["WC1", "C4c-4 4d：renderModelsPage 不看组字标记，无条件记 catalogRenderedQuery", "if (!catalogComposing) { catalogRenderedQuery = getCatalogQuery(); }", "catalogRenderedQuery = getCatalogQuery();", "W:p36", undefined, "cat"],
  ["WC2", "C4c-4 4d：清位监听挪到 applyCatalogSearch 之后注册（应用搜索时标记还是真）", "el.addEventListener('compositionend', () => { catalogComposing = false; });\n            el.addEventListener('compositionend', applyCatalogSearch);", "el.addEventListener('compositionend', applyCatalogSearch);\n            el.addEventListener('compositionend', () => { catalogComposing = false; });", "W:p36", undefined, "cat"],
  ["WC3", "C4c-4 4d：去掉 compositionstart 置位监听", "el.addEventListener('compositionstart', () => { catalogComposing = true; });", "", "W:p36", undefined, "cat"],
  ["WC4", "C4c-4 4d：去掉 compositionend 清位监听", "el.addEventListener('compositionend', () => { catalogComposing = false; });", "", "W:p36", undefined, "cat"],
  ["WFX1", "C4c-4 4d：focusCatalogModel 不再先退出未归属模式", "catalogSetUnownedMode(false);   // 4d：?focus= 是明确的定位意图——此刻若在未归属模式（列表被隐藏）先退出，否则下面的清搜索 / 跳页 / 高亮都落在看不见的列表上\n", "", "W:unowned", undefined, "cat"],
  ["WFX2", "C4c-4 4d：focusCatalogModel 的退出挪到核心 focus 之后", "catalogSetUnownedMode(false);   // 4d：?focus= 是明确的定位意图——此刻若在未归属模式（列表被隐藏）先退出，否则下面的清搜索 / 跳页 / 高亮都落在看不见的列表上\n", (src) => { const a = "catalogSetUnownedMode(false);   // 4d：?focus= 是明确的定位意图——此刻若在未归属模式（列表被隐藏）先退出，否则下面的清搜索 / 跳页 / 高亮都落在看不见的列表上\n"; if (src.split(a).length - 1 !== 1) throw new Error('锚点不唯一'); const b = src.split(a).join(''); const c = "const r = ModelCatalogCore.focus(catalogSyncState(), { id: modelId, rows: allModelsData });"; if (b.split(c).length - 1 !== 1) throw new Error('focus 锚点不唯一'); return b.split(c).join(c + '\n            catalogSetUnownedMode(false);'); }, "W:unowned", undefined, "cat"],
  ["WRF1", "C4c-4 4d：刷新按钮在途不置灰", "'data-catalog-act': 'refresh-unowned', disabled: catalogUnownedBusy, text: '刷新'", "'data-catalog-act': 'refresh-unowned', text: '刷新'", "W:unowned", undefined, "cat"],
  ["WRF2", "C4c-4 4d：刷新按钮在所有状态下都显示（加载中 / 失败态也有）", "catalogUnownedStatus === 'ok' ? catalogEl('button', { className: 'catalog-unowned-refresh'", "true ? catalogEl('button', { className: 'catalog-unowned-refresh'", "W:unowned", undefined, "cat"],
  ["WRF3", "C4c-4 4d：面板委托不处理刷新按钮", "const refresh = t.closest('[data-catalog-act=\"refresh-unowned\"]');\n                if (refresh && panel.contains(refresh)) { if (!refresh.disabled) catalogRetryUnowned(); }", "", "W:unowned", undefined, "cat"],
  ["WRF4", "C4c-4 4d：刷新处理绕过 catalogRetryUnowned 的在途守卫，直接调 catalogLoadUnowned", "if (refresh && panel.contains(refresh)) { if (!refresh.disabled) catalogRetryUnowned(); }", "if (refresh && panel.contains(refresh)) { if (!refresh.disabled) catalogLoadUnowned().catch(() => {}); }", "W:unowned", undefined, "cat"],
  ["WRF5", "C4c-4 4d：刷新按钮带 data-act（会被 C40 的行动作读法当成行内动作）", "className: 'catalog-unowned-refresh', type: 'button', 'data-catalog-act': 'refresh-unowned',", "className: 'catalog-unowned-refresh', type: 'button', 'data-act': 'history', 'data-catalog-act': 'refresh-unowned',", "W:unowned", undefined, "cat"],
  ["WRC1", "C4c-4 4d：catalogRenderRail 改回整栏 replaceChildren（mousedown 与 mouseup 之间重画会丢点击）", "catalogRailReconcile(rail, [toggle, head, viewSec, layerSec, statusSec, domainSec, orphan]);", "rail.replaceChildren(toggle, head, viewSec, layerSec, statusSec, domainSec, orphan);", "W:rail", undefined, "cat"],
  ["WRC2", "C4c-4 4d：reconcile 对所有节点都重新 appendChild（无谓移动；移动也会让进行中的点击丢失）", "keep.forEach((el, i) => { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });", "keep.forEach((el) => { parent.appendChild(el); });", "W:rail", undefined, "cat"],
  ["WRC3", "C4c-4 4d：reconcile 不删除没配上的旧节点", "pool.forEach(q => q.forEach(el => el.remove()));", "", "W:rail", undefined, "cat"],
  ["WRC4", "C4c-4 4d：patch 不对齐属性（aria-pressed / class 停在旧值）", "Array.from(freshEl.attributes).forEach(a => { if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value); });", "", "W:rail", undefined, "cat"],
  ["WRC5", "C4c-4 4d：patch 不对齐叶子文字（计数 / 名称停在旧值）", "if (oldEl.children.length > 0 || oldEl.textContent !== freshEl.textContent) oldEl.textContent = freshEl.textContent;", "", "W:rail", undefined, "cat"],
  ["WD1", "C4d-a：左栏折叠状态写进 localStorage（要求只存页面变量、不持久化）", "catalogRailOpen = !catalogRailOpen;", "catalogRailOpen = !catalogRailOpen; try { localStorage.setItem('catalogRailOpen', String(catalogRailOpen)); } catch (e) { /* x */ }", "W:rail", undefined, "cat"],
  ["WD2", "C4d-a：第二行开头容器里的状态徽章另写一份（不走 catalogBuildStatusBadge）", "                    catalogEl('span', { className: 'catalog-status-m' }, [catalogBuildStatusBadge(m)]),\n                    catalogBuildAcceptance(accView, 'catalog-cell catalog-acc-m'),", "                    catalogEl('span', { className: 'catalog-status-m' }, [catalogEl('span', { className: 'u-status-badge ' + mdcStatusClass(m.status), text: m.status })]),\n                    catalogBuildAcceptance(accView, 'catalog-cell catalog-acc-m'),", "W:rail", undefined, "cat"],
  ["WD3", "C4d-a：折叠按钮的 aria-controls 漏列一个区块 id", " catalogRailSecDomain catalogRailOrphan',", " catalogRailSecDomain',", "W:rail", undefined, "cat"],
  ["WD4", "C4d-a：catalogToggleRail（W:sync 清单）里出现 setTimeout", "function catalogToggleRail() {", "function catalogToggleRail() { setTimeout(function () {}, 0);", "W:sync", undefined, "cat"],
  ["WD5", "C4d-a：catalogBuildStatusBadge（W:sync 清单）里出现 Promise", "function catalogBuildStatusBadge(m) {", "function catalogBuildStatusBadge(m) { void Promise.resolve();", "W:sync", undefined, "cat"],
  ["WD6", "C4d-a：第二行开头容器里的负责人用 innerHTML 写入（W:innerhtml 越界）", "catalogEl('span', { className: 'catalog-owner-m', title: ownerTitle, text: ownerText }),", "(() => { const s = catalogEl('span', { className: 'catalog-owner-m' }); s.innerHTML = ownerText; return s; })(),", "W:innerhtml", undefined, "cat"],
  ["WD7", "C4d-a：折叠状态默认展开（要求默认收起）", "let catalogRailOpen = false;", "let catalogRailOpen = true;", "W:rail", undefined, "cat"],
  ["WD8", "C4d-b ⑤：highlightModel 不再先退出未归属模式", "function highlightModel(modelId) {\n            catalogSetUnownedMode(false);", "function highlightModel(modelId) {\n            void 0;", "W:unowned", undefined, "cat"],
  ["WD9", "C4d-b P40：「清除 N 项」之后不再把焦点移到「全部模型」", "if (allView) allView.focus({ preventScroll: true });", "", "W:rail", undefined, "cat"],
  ["WD10", "C4d-b：组包装去掉 role=listitem（列表的直接子元素缺角色）", "className: 'catalog-group', role: 'listitem', 'data-group': g.id", "className: 'catalog-group', 'data-group': g.id", "W:a11y", undefined, "cat"],
  ["WD11", "C4d-b：空态去掉 role=listitem", "className: 'catalog-empty', role: 'listitem', text: '暂无模型数据'", "className: 'catalog-empty', text: '暂无模型数据'", "W:a11y", undefined, "cat"],
  ["WD12", "C4d-b：焦点在菜单内移动也关闭菜单（去掉 inside 判断）", "if (!inside) catalogCloseMenus();", "catalogCloseMenus();", "W:a11y", undefined, "cat"],
  ["WD13", "C4d-b：焦点移出菜单时抢焦点（关闭后把焦点还给触发按钮）", "if (!inside) catalogCloseMenus();", "if (!inside) { const tr0 = catalogTriggerOf(open[0]); catalogCloseMenus(); if (tr0) tr0.focus(); }", "W:a11y", undefined, "cat"],
  ["WD14", "C4d-b：catalogOnFocusIn（W:sync 清单）里出现 setTimeout", "function catalogOnFocusIn(e) {", "function catalogOnFocusIn(e) { setTimeout(function () {}, 0);", "W:sync", undefined, "cat"],
  ["WD15", "C4d-b：focusin 监听没有注册", "document.addEventListener('focusin', catalogOnFocusIn);", "", "W:a11y", undefined, "cat"],
  ["WD16", "C4d-b：MC 列头重新带上 role=row", '<div class="catalog-head">', '<div class="catalog-head" role="row">', "W:a11y", undefined, "page"],
  ["WD17", "C4d-b：MC 焦点框规则缺工具条这一类容器", ".catalog-toolbar :focus-visible, #catalogRail :focus-visible,", "#catalogRail :focus-visible,", "W:a11y", undefined, "page"],
  ["WD18", "C4d 预筛修复 LOW-5：首行验收格自己再算一次摘要（一个条目算两次）", "catalogBuildAcceptance(accView),\n                catalogEl('div', { className: 'catalog-cell catalog-owner'", "catalogBuildAcceptance(catalogAcceptanceViewOf(m)),\n                catalogEl('div', { className: 'catalog-cell catalog-owner'", "W:rail", undefined, "cat"],
  ["WD19", "C4d 预筛修复 LOW-3：首行状态格没有 title", "{ className: 'catalog-cell catalog-status', title: statusBadge.title }", "{ className: 'catalog-cell catalog-status' }", "W:rail", undefined, "cat"],
  ["WD20", "C4d 预筛修复 LOW-3：首行负责人格没有 title", "{ className: 'catalog-cell catalog-owner', title: ownerTitle, text: ownerText }", "{ className: 'catalog-cell catalog-owner', text: ownerText }", "W:rail", undefined, "cat"],
  ["WD21", "C4d 预筛修复 LOW-4：catalogLeaveUnowned 入口不可见时不回退聚焦折叠按钮", "            if (shown(tg)) tg.focus({ preventScroll: true });\n", "", "W:unowned", undefined, "cat"],
  ["WD22", "C4d 预筛修复 LOW-5：catalogAcceptanceViewOf（W:sync 清单）里出现 setTimeout", "function catalogAcceptanceViewOf(m) {", "function catalogAcceptanceViewOf(m) { setTimeout(function () {}, 0);", "W:sync", undefined, "cat"],
  ["WD23", "C4d 预筛修复 LOW-5：catalogBuildAcceptance 里又去调核心算摘要（建节点函数不得再算）", "function catalogBuildAcceptance(v, rootClass) {", "function catalogBuildAcceptance(v, rootClass) { ModelCatalogCore.acceptanceView(null);", "W:rail", undefined, "cat"],
  ["WD24", "codex 42Tc-L1：在 row2Kids 最前面插入一个元素（移动端摘要仍先于 catalog-id，但不再是数组首项）", "            const row2Kids = [\n", "            const row2Kids = [\n                catalogEl('span', { className: 'catalog-x', text: '' }),\n", "W:rail", undefined, "cat"],
  ["WD25", "fix42b LOW-4：row2Kids 的唯一声明挪到另一个顶层函数里（catalogBuildEntry 里改名）——声明数仍恰为 1、首项仍是 catalog-mobile-meta，只有「声明在 catalogBuildEntry 里」这一条能判红", "            const row2Kids = [\n", (src) => src.replace("            const row2Kids = [\n", "            const row2KidsX = [\n").replace("catalogEl('div', { className: 'catalog-row2' }, row2Kids)", "catalogEl('div', { className: 'catalog-row2' }, row2KidsX)").replace("function catalogBuildStatusBadge(m) {\n", "function catalogBuildStatusBadge(m) {\n            const row2Kids = [catalogEl('div', { className: 'catalog-mobile-meta' }, [])];\n"), "W:rail", undefined, "cat"],
  ["WD26", "fix42b MED-1：第二行容器里的状态徽章直接放进容器（不经 span.catalog-status-m 包装层）", "catalogEl('span', { className: 'catalog-status-m' }, [catalogBuildStatusBadge(m)]),\n                    catalogBuildAcceptance(accView, 'catalog-cell catalog-acc-m'),", "catalogBuildStatusBadge(m),\n                    catalogBuildAcceptance(accView, 'catalog-cell catalog-acc-m'),", "W:rail", undefined, "cat"],
  ["WS5", "C4c-4 4d：applyCatalogSearch（W:sync 清单）里出现 await", "function applyCatalogSearch() {", "async function applyCatalogSearch() { await Promise.resolve();", "W:sync", undefined, "cat"],
  ["WS6", "C4c-4 4d：focusCatalogModel（W:sync 清单）里出现 setTimeout", "function focusCatalogModel(modelId) {", "function focusCatalogModel(modelId) { setTimeout(function () {}, 0);", "W:sync", undefined, "cat"],
  ["WS7", "C4c-4 4d：catalogRailReconcile（W:sync 清单）里出现 Promise", "function catalogRailReconcile(parent, fresh) {", "function catalogRailReconcile(parent, fresh) { void Promise.resolve();", "W:sync", undefined, "cat"],
  ["WS8", "C4c-4 4d：catalogRailPatch（W:sync 清单）里出现 setTimeout", "function catalogRailPatch(oldEl, freshEl) {", "function catalogRailPatch(oldEl, freshEl) { setTimeout(function () {}, 0);", "W:sync", undefined, "cat"],
  ["WS9", "C4c-4 4d：catalogRailKey（W:sync 清单）里出现 queueMicrotask", "function catalogRailKey(el) {", "function catalogRailKey(el) { queueMicrotask(function () {});", "W:sync", undefined, "cat"],
  ['CRLF', '对照组：核心整体转 CRLF（锚点仍可定位、本体全绿）', null, (src) => src.replace(/\n/g, '\r\n'), null],
  ['CTRL', '对照组：只加注释与空行', 'var hasOwn = Object.prototype.hasOwnProperty;', 'var hasOwn = Object.prototype.hasOwnProperty;\n\n    // 对照组：注释与空行不应改变任何结果\n\n', null],
];
// ───────────────────────────── 自测模式 ─────────────────────────────
if (process.argv.includes('--self-test')) process.exit(selfTest());

function selfTest() {
  // 工作区可能是 CRLF（core.autocrlf=true）：读入后统一成 LF 再定位锚点；变异文件以 LF 写出（本体断言不依赖行尾）
  const toLF = (t) => t.replace(/\r\n/g, '\n');
  const coreSrc = toLF(fs.readFileSync(REAL_JS_DIR + '/model-catalog-core.js', 'utf8'));
  const kitSrc = toLF(fs.readFileSync(REAL_JS_DIR + '/model-detail-normalize.js', 'utf8'));
  const catRealSrc = toLF(fs.readFileSync(REAL_JS_DIR + '/model-catalog.js', 'utf8'));
  const pageRealSrc = toLF(fs.readFileSync(path.join(__dirname, '..', 'public', 'Model_Center.html'), 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-selftest-'));
  const DEFAULT_TIMEOUT = Number(process.env.MC_SELFTEST_TIMEOUT_MS) || 60000;
  let bad = 0;
  const runWith = (src, label, timeoutMs, catSrc, pageSrc) => {
    const dir = path.join(root, label);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model-catalog-core.js'), src);
    fs.writeFileSync(path.join(dir, 'model-detail-normalize.js'), kitSrc);
    const env = Object.assign({}, process.env, { MC_CORE_DIR: dir });
    if (catSrc !== undefined) { fs.writeFileSync(path.join(dir, 'model-catalog.js'), catSrc); env.MC_CAT_FILE = path.join(dir, 'model-catalog.js'); }
    if (pageSrc !== undefined) { fs.writeFileSync(path.join(dir, 'Model_Center.html'), pageSrc); env.MC_PAGE_FILE = path.join(dir, 'Model_Center.html'); }
    const r = spawnSync(process.execPath, [__filename], { env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: timeoutMs || DEFAULT_TIMEOUT });
    const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
    const lines = String(r.stdout || '').split(/\r?\n/);
    return { status: r.status, timedOut, first: lines.find(l => l.startsWith('FAIL ')) || null, stderr: String(r.stderr || '').trim().split(/\r?\n/)[0] };
  };
  const base = runWith(coreSrc, 'base');
  if (base.timedOut || base.status !== 0 || base.first) { console.log('[self-test] 未变异的核心应全绿，实得 ' + (base.timedOut ? '超时' : (base.first || ('退出码 ' + base.status + ' ' + base.stderr)))); return 1; }
  console.log('[self-test] 未变异：全绿');
  for (const [id, desc, anchor, repl, want, timeoutMs, target] of MUTATIONS) {
    let mutated;
    let catMutated;
    let pageMutated;
    const subject = target === 'cat' ? catRealSrc : (target === 'page' ? pageRealSrc : coreSrc);   // 变异对象：核心（默认）或 model-catalog.js（接线变异）
    try {
      if (anchor !== null) {
        const n = subject.split(anchor).length - 1;
        if (n !== 1) { console.log('[self-test] FAIL ' + id + '：变异锚点不存在或不唯一（出现 ' + n + ' 次）'); bad++; continue; }
      }
      mutated = typeof repl === 'function' ? repl(subject) : subject.split(anchor).join(repl);
      if (target === 'cat') { catMutated = mutated; mutated = coreSrc; }
      if (target === 'page') { pageMutated = mutated; mutated = coreSrc; }
      if (anchor !== null && (target === 'cat' ? catMutated === catRealSrc : (target === 'page' ? pageMutated === pageRealSrc : mutated === coreSrc))) { console.log('[self-test] FAIL ' + id + '：变异构造后源码没有变化'); bad++; continue; }
    } catch (e) { console.log('[self-test] FAIL ' + id + '：构造变异失败（' + e.message + '）'); bad++; continue; }
    const r = runWith(mutated, id, timeoutMs, catMutated, pageMutated);
    if (want === 'TIMEOUT') {
      if (r.timedOut) console.log('[self-test] OK   ' + id + '（' + desc + '）：子进程超时判红');
      else { console.log('[self-test] FAIL ' + id + '（' + desc + '）：示例开发N时判红，实得 ' + (r.first || ('退出码 ' + r.status))); bad++; }
      continue;
    }
    if (r.timedOut) { console.log('[self-test] FAIL ' + id + '（' + desc + '）：子进程超时（判红应在超时前给出首条失败）'); bad++; continue; }
    if (want === null) {
      if (r.status === 0 && !r.first) console.log('[self-test] OK   ' + id + '（' + desc + '）：全绿');
      else { console.log('[self-test] FAIL ' + id + '：对照组不应判红，实得 ' + (r.first || r.stderr)); bad++; }
      continue;
    }
    if (r.status === 0 || !r.first) { console.log('[self-test] FAIL ' + id + '（' + desc + '）：变异后仍全绿（判别力不足）'); bad++; continue; }
    if (!r.first.startsWith('FAIL ' + want + ' ') && !r.first.startsWith('FAIL ' + want + ':') && !(want.endsWith('.') && r.first.startsWith('FAIL ' + want))) { console.log('[self-test] FAIL ' + id + '（' + desc + '）：首条失败应以 ' + want + ' 开头，实得 ' + r.first.slice(0, 160)); bad++; continue; }
    console.log('[self-test] OK   ' + id + '（' + desc + '）：首条判红 ' + r.first.slice(0, 120));
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结论 */ }
  console.log(bad ? '[self-test] ' + bad + ' 项失败' : '[self-test] 全部通过');
  return bad ? 1 : 0;
}

// ───────────────────────────── 断言框架 ─────────────────────────────
const core = require(CORE_FILE);
let pass = 0, fail = 0;
const late = [];   // 异步检查（sqlite3 LIKE 对拍），结束前统一等待
const perSection = {};
let curSection = '';
const J = (v) => JSON.stringify(v);
function check(code, name, cond, detail) {
  perSection[curSection] = (perSection[curSection] || 0) + 1;
  if (cond) { pass++; return; }
  fail++;
  console.log(`FAIL ${code} | ${name}${detail === undefined ? '' : '\n  ' + detail}`);
}
const eq = (code, name, got, want) => check(code, name, J(got) === J(want), `got=${J(got)} want=${J(want)}`);
function section(name, fn) {
  curSection = name;
  try { fn(); } catch (e) { check(name.split(' ')[0] + ':THROW', `${name} 抛异常`, false, String(e && e.stack || e).split('\n').slice(0, 3).join(' / ')); }
}

// ───────────────────────────── 夹具 ─────────────────────────────
const R = (o) => Object.assign({
  id: 0, layer: 'ods', table_name: '', table_comment: null, impl_note: null, source_table: null, source_system: null,
  config_mode: 'standard', companion_of: null, dim_config: null, impl_obj_names: [], status: 'ONLINE',
  updated_at: '2026-01-02 08:00:00', tech_owner: '', biz_owner: '', update_cycle: 'df', archived_task_count: 0,
}, o);
const pad2 = (n) => String(n).padStart(2, '0');
const fillers = (n, start) => Array.from({ length: n }, (_, i) => R({
  id: start + i, layer: 'ods', table_name: `ods_f${pad2(i + 1)}_df`, table_comment: '填充', source_table: `filler_${pad2(i + 1)}`, source_system: 'SYS_A',
}));

/** 契约表基础夹具（输入顺序 = 后端顺序）：伴生 #21 排在主模型 #22 前面；#41 落单 */
const BASE = [
  R({ id: 10, layer: 'dim', table_name: 'dim_alpha', table_comment: '阿尔法维度表' }),
  R({ id: 21, layer: 'DWD', table_name: 'dwd_beta_change_di', table_comment: '贝塔变更表', config_mode: 'companion', companion_of: 22 }),
  R({ id: 22, layer: 'dwd', table_name: 'dwd_beta_df', table_comment: '贝塔宽表', impl_note: '首句。第二句',
    dim_config: JSON.stringify({ sourceTables: [{ name: 'ods_up_one' }, { name: '  ' }] }) }),
  R({ id: 30, layer: 'ods', table_name: 'ods_gamma_df', table_comment: '伽马原始表', source_system: 'ERP', source_table: 'T_ORDER', impl_obj_names: ['dbo.usp_gamma'] }),
  R({ id: 41, layer: 'dwd', table_name: 'dwd_orphan_change_di', table_comment: '落单伴生', config_mode: 'companion', companion_of: 999 }),
  R({ id: 52, layer: 'dim', table_name: 'dim_delta', table_comment: '德尔塔维度表', impl_obj_names: null }),
];
const P20 = (o) => Object.assign({ query: '', filters: {}, sortBy: null, sortDir: 'desc', page: 1, pageSize: 20 }, o || {});
const view = (rows, o) => core.computeView(rows, P20(o));
const S0 = (o) => Object.assign({ page: 1, sortBy: null, sortDir: 'desc', query: '', filters: {}, expanded: [], listToken: 0, expandTokens: {}, expandStatus: {}, relations: {}, seq: 0 }, o || {});

// 上游夹具：照 scripts/verify-model-relations.js:131–145 的 UP_FIX 复制（复制日期 2026-10-07），加本文件的 ODS / 双重编码 / 不可解析例
const UP_FIX = [
  { key: 'u1', layer: 'DWD', dim_config: { sourceTables: [{ name: 'ods_a', alias: 'a', isPrimary: true }, { name: 'ods_b', alias: 'b', joinType: 'LEFT', joinCondition: 'a.id = b.id' }] }, want: ['ods_a', 'ods_b'] },
  { key: 'u2', layer: 'DIM', dim_config: { sourceTables: [{ name: '  ods_c  ', alias: ' c ', joinType: '' }] }, want: ['ods_c'] },
  { key: 'u3', layer: 'dwd', dim_config: { sourceTables: [{ tableName: 'only_old_key' }, { name: 'ods_d', isPrimary: 1 }] }, want: ['ods_d'] },
  { key: 'u4', layer: 'DWD', dim_config: { sourceTables: 'not-an-array' }, want: [] },
  { key: 'u5', layer: 'DWD', dim_config: { other: 1 }, want: [] },
  { key: 'u6', layer: 'DWD', config_mode: 'custom', dim_config: { sourceTables: [{ name: 'ods_custom' }] }, want: [] },
  { key: 'u7', layer: 'DWD', companion_of: 12345, dim_config: { sourceTables: [{ name: 'ods_comp' }] }, want: [] },
  { key: 'u8', layer: 'ADS', dim_config: { sourceTables: [{ name: 'ods_ads' }] }, want: [] },
  { key: 'u9', layer: 'DWD', dim_config: null, want: [] },
];
const textOf = (v) => (v === null ? null : J(v));
const UP_ROWS = UP_FIX.map(f => ({ id: 1000 + Number(f.key.slice(1)), layer: f.layer, config_mode: f.config_mode, companion_of: f.companion_of, dim_config: textOf(f.dim_config), table_name: 'up_' + f.key }));
const UP_EXTRA = [
  { key: 'dbl', row: { layer: 'DWD', dim_config: J(J({ sourceTables: [{ name: 'ods_dbl' }] })) }, want: ['ods_dbl'] },
  { key: 'bad', row: { layer: 'DWD', dim_config: 'not json {' }, want: [] },
  { key: 'empty', row: { layer: 'DWD', dim_config: '' }, want: [] },
  { key: 'ods-trim', row: { layer: 'ods', source_system: ' ERP ', source_table: 'T_ORDER' }, want: ['ERP', 'T_ORDER'] },
  { key: 'ods-sys-only', row: { layer: 'ODS', source_system: 'ERP', source_table: '' }, want: ['ERP'] },
  { key: 'ods-table-only', row: { layer: 'ODS', source_system: null, source_table: ' T_X ' }, want: ['T_X'] },
  { key: 'ods-both-empty', row: { layer: 'ODS', source_system: '', source_table: null }, want: [] },
  { key: 'ods-dimcfg', row: { layer: 'ODS', dim_config: J({ sourceTables: [{ name: 'x' }] }) }, want: [] },
  { key: 'dim-object', row: { layer: 'DIM', dim_config: { sourceTables: [{ name: 'ods_obj' }] } }, want: ['ods_obj'] },
].map(e => ({ key: e.key, row: Object.assign({ id: 2000, table_name: 'x_' + e.key }, e.row), want: e.want }));

const MODEL_ROWS = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf8')).rows;   // 11 行；dim_config 是对象
const asListText = (r) => Object.assign({}, r, { dim_config: r.dim_config == null ? null : J(r.dim_config) });   // 列表接口里 dim_config 是 TEXT
const MODEL_ROWS_LIST = MODEL_ROWS.map(asListText);

// 排序性质夹具：models.json 11 行 + 25 填充（多种值 / 空值 / 并列 / 未知状态）+ 2 个伴生 + 1 个落单伴生
const LAYERS = ['ods', 'dim', 'dwd', 'ODS'];
const STATUSES = ['CREATED', 'DEVELOPING', 'REVIEWING', 'ONLINE', 'OFFLINE', 'WEIRD', null];
const SORT_ROWS = MODEL_ROWS_LIST.concat(
  Array.from({ length: 25 }, (_, i) => R({
    id: 300 + i, layer: LAYERS[i % 4], table_name: i % 6 === 0 ? '' : `t_${(i * 7) % 11}`, table_comment: i % 5 === 0 ? null : `注释${(i * 3) % 7}`,
    tech_owner: ['', '甲', '乙', '丙'][i % 4], biz_owner: i % 3 === 0 ? null : '业务' + (i % 2), update_cycle: ['df', 'di', 'mf'][i % 3],
    status: STATUSES[i % 7], archived_task_count: i % 4 === 0 ? null : (i % 3), updated_at: i % 5 === 1 ? null : `2026-0${1 + (i % 3)}-1${i % 9} 0${i % 9}:00:00`,
  })),
  [R({ id: 401, layer: 'dwd', table_name: 'a_comp_of_50', config_mode: 'companion', companion_of: 50, status: 'CREATED', updated_at: '2025-12-31 23:59:59' }),
    R({ id: 402, layer: 'ods', table_name: 'z_comp_of_6', config_mode: 'companion', companion_of: '6', status: 'OFFLINE', archived_task_count: 9 }),
    R({ id: 403, layer: 'dwd', table_name: 'm_orphan', config_mode: 'companion', companion_of: 9999, status: 'REVIEWING', archived_task_count: 5 })]
);

// ═════════ 一、两端一致 ═════════
// 本节只证明「加载 / 导出路径一致」（node require 与浏览器全局方式得到同一份行为），不作语义判据；语义由三至六节的手写期望承担。
section('一 加载路径一致', () => {
  const kitSrc = fs.readFileSync(KIT_FILE, 'utf8').replace(/\r\n/g, '\n');
  const coreSrc = fs.readFileSync(CORE_FILE, 'utf8').replace(/\r\n/g, '\n');
  // 上下文全局对象即 window：壳外的 var / function 声明会落在它上面，才看得见
  const ctx = vm.createContext({});
  vm.runInContext('var window = this;', ctx);
  const globalNames = () => vm.runInContext('Object.getOwnPropertyNames(this)', ctx);
  vm.runInContext(kitSrc, ctx);
  const namesAfterKit = globalNames();
  const identityOf = (n) => vm.runInContext('this[' + J(n) + ']', ctx);
  const identitiesBefore = new Map(namesAfterKit.map(n => [n, identityOf(n)]));
  vm.runInContext(coreSrc, ctx);
  const bc = vm.runInContext('window.ModelCatalogCore', ctx);
  check('B1', '浏览器方式（window、无 module）加载得到 ModelCatalogCore', !!bc && typeof bc.computeView === 'function');
  check('B2', '浏览器方式下 CORE_VERSION === mcc3', !!bc && bc.CORE_VERSION === 'mcc3' && core.CORE_VERSION === 'mcc3');
  eq('B3', '加载核心后（上下文全局即 window）全局只多出 ModelCatalogCore 一个名字', globalNames().filter(k => !namesAfterKit.includes(k)), ['ModelCatalogCore']);
  const overwritten = namesAfterKit.filter(n => !Object.is(identityOf(n), identitiesBefore.get(n)));
  eq('B3', '加载核心后既有全局（含 ModelDetailKit）的值 / 对象身份无一被覆盖', overwritten, []);
  const shellBody = acorn.parse(coreSrc, { ecmaVersion: 2022 }).body.filter(n => n.type !== 'EmptyStatement');
  check('B3', 'UMD 壳外没有顶层声明（含 let / const / class）：Program.body 去掉空语句后恰为 1 条表达式语句', shellBody.length === 1 && shellBody[0].type === 'ExpressionStatement', shellBody.map(n => n.type).join());
  eq('B4', '导出键两端相同', Object.keys(bc).sort(), Object.keys(core).sort());
  const ALL = [BASE, BASE.concat(fillers(30, 101)), MODEL_ROWS_LIST, SORT_ROWS, UP_ROWS, UP_EXTRA.map(e => e.row)];
  const queries = ['', '  ', 'beta', 'BETA', '#22', '52', '0052', 'erp', 't_order', 'ods_up_one', 'usp_gamma', '第二句', 'dim_', '%', '_', 'w0007', 'ods_a', 'ods_d'];
  const optsList = [P20(), P20({ sortBy: 'id', sortDir: 'asc' }), P20({ sortBy: 'table_name', sortDir: 'desc' }), P20({ sortBy: 'updated_at', sortDir: 'asc', page: 2 }), P20({ filters: { layer: 'dwd' } })];
  let n = 0;
  ALL.forEach((rows, ri) => {
    optsList.forEach((o, oi) => {
      const a = core.computeView(rows, o), b = bc.computeView(rows, o);
      check('B5', `computeView 两端一致 [数据${ri} 选项${oi}]`, J(a) === J(b), `node=${J(a.orderedIds)} browser=${J(b.orderedIds)}`);
      n++;
    });
    rows.forEach(r => {
      check('B6', `upstreamNames 两端一致 #${r.id}`, J(core.upstreamNames(r)) === J(bc.upstreamNames(r)));
      queries.forEach(q => { if (core.matchRow(r, q) !== bc.matchRow(r, q)) check('B7', `matchRow 两端一致 #${r.id} "${q}"`, false); });
    });
  });
  check('B8', '至少比对了 30 组 computeView', n >= 30);
  // 缺依赖时的报错：在调用时抛，不在加载时抛
  const bare = { window: {} };
  vm.runInNewContext(coreSrc, bare);
  check('B9', '缺 ModelDetailKit 时加载不抛', !!bare.window.ModelCatalogCore);
  let msg = '';
  try { bare.window.ModelCatalogCore.upstreamNames({ layer: 'DWD', dim_config: '{}' }); } catch (e) { msg = String(e.message); }
  check('B10', '缺 ModelDetailKit 时调用 upstreamNames 抛带说明的 Error', /ModelDetailKit/.test(msg), msg);
  check('B11', '缺 ModelDetailKit 时 ODS 路径不依赖 kit', J(bare.window.ModelCatalogCore.upstreamNames({ layer: 'ODS', source_system: 'a', source_table: 'b' })) === J(['a', 'b']));
});

// ═════════ 二 上游名与后端同源（D-10）═════════
section('二 上游名与后端同源', () => {
  const rel = require('../routes/model-center/model-relations.js');
  const backendNames = (row) => {
    const up = rel.upstreamOfModel(row);
    const out = [];
    const isOds = String(row.layer || '').toUpperCase() === 'ODS';
    for (const u of up) {
      if (isOds) { if (u.source_system) out.push(u.source_system); if (u.source_table) out.push(u.source_table); }
      else if (u.name) out.push(u.name);
    }
    return out;
  };
  for (const r of UP_ROWS) {
    const f = UP_FIX.find(x => 1000 + Number(x.key.slice(1)) === r.id);
    eq('U', `与后端同源 ${f.key}（${f.layer}）`, core.upstreamNames(r), backendNames(r));
    eq('U', `手写期望 ${f.key}（${f.layer}）`, core.upstreamNames(r), f.want);
  }
  for (const e of UP_EXTRA) {
    eq('U', `与后端同源 ${e.key}`, core.upstreamNames(e.row), backendNames(e.row));
    eq('U', `手写期望 ${e.key}`, core.upstreamNames(e.row), e.want);
  }
  for (const r of MODEL_ROWS_LIST) eq('U', `与后端同源 models.json #${r.id}（dim_config 为 TEXT）`, core.upstreamNames(r), backendNames(r));
  const byId = (id) => MODEL_ROWS_LIST.find(r => r.id === id);
  // 手写期望：按 models.json 里 dim_config.sourceTables 的 name 原样（不去重、保序）
  eq('U', '手写期望 #50', core.upstreamNames(byId(50)), ['ods_w0006_w0007_w0008_change_df', 'ods_w0006_w0007_w0008_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0037_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df']);
  eq('U', '手写期望 #52', core.upstreamNames(byId(52)), ['ods_w0001_df', 'ods_w0001_w0061_w0062_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0004_w0047_df', 'ods_w0006_w0007_w0008_df', 'ods_w0006_w0037_df']);
  eq('U', '手写期望 #55', core.upstreamNames(byId(55)), ['ods_w0006_w0037_df', 'ods_w0006_w0037_df', 'ods_w0006_w0037_df', 'ods_w0006_w0037_df', 'w0037_w0144']);
  eq('U', '手写期望 #6（ODS）', core.upstreamNames(byId(6)), ['W0003', 'w0002_w0001']);
  eq('U', '手写期望 #8（ODS）', core.upstreamNames(byId(8)), ['W0003', 'w0006_w0007_w0008']);
  eq('U', '手写期望 #53（伴生）', core.upstreamNames(byId(53)), []);
  eq('U', '手写期望 #58（custom）', core.upstreamNames(byId(58)), []);
});

// ═════════ 三 §3.4 契约表逐行一例 ═════════
section('三 契约表', () => {
  // C1 分组单位（伴生在输入里排在主模型前面也跟在主模型后）
  const v1 = view(BASE);
  eq('C1', '分组单位：默认序 orderedIds', v1.orderedIds, [10, 22, 21, 30, 41, 52]);
  eq('C1', '分组单位：#41 落单伴生自成一组（orphan:true），其余 false', v1.groups.map(g => [g.id, g.orphan]), [[10, false], [22, false], [30, false], [41, true], [52, false]]);
  eq('C1', '分组单位：#22 组成员 = [22,21]', v1.groups[1].members.map(m => m.id), [22, 21]);
  eq('C1', '分组单位：totalGroups / totalModels', [v1.totalGroups, v1.totalModels], [5, 6]);
  // 伴生 companion_of 为字符串 / 空串
  const vs = view([R({ id: 5, table_name: 'p' }), R({ id: 6, table_name: 'c', companion_of: '5' }), R({ id: 7, table_name: 'e', companion_of: '' })]);
  eq('C1', '分组单位：companion_of 为字符串 id 也挂到主模型下；空串视为主模型', vs.orderedIds, [5, 6, 7]);
  const farRows = [R({ id: 1, table_name: 'a' }), R({ id: 2, table_name: 'b', config_mode: 'companion', companion_of: 3 }), R({ id: 5, table_name: 'e' }), R({ id: 3, table_name: 'c' })];
  eq('C1', '分组位置：伴生在输入里排在主模型前、中间隔着其他模型，组仍按主模型位置排', view(farRows).orderedIds, [1, 5, 3, 2]);
  // G 落单兜底两分支、组内伴生顺序、行守恒（L1 / L2）
  const g1 = view([R({ id: 1, table_name: 'p' }), R({ id: 2, table_name: 'c2', config_mode: 'companion', companion_of: 3 }), R({ id: 3, table_name: 'c3', config_mode: 'companion', companion_of: 1 })]);
  eq('G1', '落单：伴生指向另一个伴生 → 自成一组（#3 仍挂在 #1 下）', [g1.orderedIds, g1.groups.map(g => [g.id, g.orphan])], [[1, 3, 2], [[1, false], [2, true]]]);
  const g1b = view([R({ id: 4, table_name: 'self', config_mode: 'companion', companion_of: 4 })]);
  eq('G1', '落单：伴生指向自己 → 自成一组', [g1b.orderedIds, g1b.groups.map(g => [g.id, g.orphan])], [[4], [[4, true]]]);
  const g2 = view([R({ id: 1, table_name: 'p' }), R({ id: 9, table_name: 'c9', config_mode: 'companion', companion_of: 1 }), R({ id: 5, table_name: 'c5', config_mode: 'companion', companion_of: 1 }), R({ id: 7, table_name: 'c7', config_mode: 'companion', companion_of: 1 })]);
  eq('G2', '一主多伴：组内伴生按输入顺序（不按 id）', g2.groups[0].members.map(m => m.id), [1, 9, 5, 7]);
  const g2b = view([R({ id: 9, table_name: 'c9', config_mode: 'companion', companion_of: 1 }), R({ id: 1, table_name: 'p' }), R({ id: 5, table_name: 'c5', config_mode: 'companion', companion_of: 1 })]);
  eq('G2', '一主多伴：伴生在主模型前也按输入顺序', g2b.groups[0].members.map(m => m.id), [1, 9, 5]);
  for (const [label, rowsX] of [['BASE', BASE], ['SORT_ROWS', SORT_ROWS], ['farRows', farRows], ['落单两例', [R({ id: 1 }), R({ id: 2, companion_of: 3 }), R({ id: 3, companion_of: 1 }), R({ id: 4, companion_of: 4 })]]]) {
    const out = core.buildGroups(rowsX).reduce((acc, g) => acc.concat(g.members.map(m => m.id)), []).sort((x, y) => x - y);
    eq('G3', '行守恒：buildGroups 展开后的 id 多重集合 = 输入（' + label + '）', out, rowsX.map(r => r.id).sort((x, y) => x - y));
  }
  {
    let out;
    try {
      const pr = view([R({ id: '__proto__', table_name: 'p_proto' }), R({ id: 'c1', table_name: 'c_proto', config_mode: 'companion', companion_of: '__proto__' }), R({ id: 'toString', table_name: 'p_ts' })]);
      out = [pr.orderedIds, pr.groups.map(g => g.orphan)];
    } catch (e) { out = 'THROW ' + e.message; }
    eq('G4', 'id 为 "__proto__" / "toString" 的主模型不污染映射：伴生仍挂在其下、不落单', out, [['__proto__', 'c1', 'toString'], [false, false]]);
  }
  // C2 命中：只命中伴生 → 整组显示
  eq('C2', '命中：伴生命中（beta_change）→ 整组', view(BASE, { query: 'beta_change' }).orderedIds, [22, 21]);
  eq('C2', '命中：主模型命中 → 整组带伴生', view(BASE, { query: 'dwd_beta_df' }).orderedIds, [22, 21]);
  eq('C2', '命中：落单伴生命中 → 只有它自己', view(BASE, { query: 'orphan' }).orderedIds, [41]);
  // C3 排序作用于主模型
  eq('C3', '排序：id asc（伴生不按自己的 id 散开）', view(BASE, { sortBy: 'id', sortDir: 'asc' }).orderedIds, [10, 22, 21, 30, 41, 52]);
  eq('C3', '排序：table_name desc', view(BASE, { sortBy: 'table_name', sortDir: 'desc' }).orderedIds, [30, 41, 22, 21, 52, 10]);
  eq('C3', '排序：id desc', view(BASE, { sortBy: 'id', sortDir: 'desc' }).orderedIds, [52, 41, 30, 22, 21, 10]);
  eq('C3', '排序：清除（sortBy null）回到分组默认序', view(BASE, { sortBy: null, sortDir: 'desc' }).orderedIds, [10, 22, 21, 30, 41, 52]);
  // 伴生的 id 比主模型小时，按行排会把它放到别处——对照
  const rowSorted = core.sortByField(BASE, 'id', 'asc').map(r => r.id);
  eq('C3', '对照：按行排序会得到 [10,21,22,…]（证明用例有区分力）', rowSorted.slice(0, 3), [10, 21, 22]);
  // C4 分页：按组，伴生不占位
  const big = BASE.concat(fillers(16, 101));
  const p1 = view(big, { page: 1 }), p2 = view(big, { page: 2 });
  eq('C4', '分页：21 组 → totalGroups / totalPages', [p1.totalGroups, p1.totalPages], [21, 2]);
  eq('C4', '分页：第 1 页 20 组', p1.pageGroups.length, 20);
  eq('C4', '分页：第 1 页 pageIds.length = 21（#22 组带伴生不占位）', p1.pageIds.length, 21);
  eq('C4', '分页：第 2 页 1 组 / pageIds = [116]', [p2.pageGroups.length, p2.pageIds], [1, [116]]);
  eq('C4', '分页：totalModels = 22', p1.totalModels, 22);
  // H2：20 组 21 行——按行算会多出一个空的第 2 页
  const g20 = BASE.concat(fillers(15, 101));
  const v20 = view(g20);
  eq('C4', '分页：20 组 21 行 → totalGroups / totalModels / totalPages = 20 / 21 / 1（按行算会得 2 页）', [v20.totalGroups, v20.totalModels, v20.totalPages], [20, 21, 1]);
  eq('C4', '分页：20 组 21 行 → 第 1 页 20 组 21 行；第 2 页不存在（pageGroups 空）', [v20.pageGroups.length, v20.pageIds.length, view(g20, { page: 2 }).pageGroups.length], [20, 21, 0]);
  eq('C4', '分页：page 原样返回、不夹紧', [view(big, { page: 9 }).page, view(big, { page: 9 }).pageIds], [9, []]);
  eq('C4', '分页：0 组 → totalPages 0', view([], {}).totalPages, 0);
  let thrown = false;
  try { core.computeView(BASE, { query: '', filters: {}, page: 1 }); } catch (e) { thrown = true; }
  check('C4', '分页：pageSize 必填（缺省抛错）', thrown);
  // C5 展开态
  {
    let r = core.toggleExpand(S0({ page: 1 }), { id: 22 });
    const S = r.state;
    eq('C5', '展开态：展开 #22 → expanded [22]', S.expanded, [22]);
    const g = core.gotoPage(S, { page: 2, totalPages: 2 }).state;
    const q = core.setQuery(S, 'x').state;
    const f = core.setFilter(S, 'layer', 'dwd').state;
    eq('C5', '展开态：gotoPage 后 expanded / 令牌 / 状态全清', [g.expanded, g.expandTokens, g.expandStatus], [[], {}, {}]);
    eq('C5', '展开态：setQuery 后全清', [q.expanded, q.expandTokens, q.expandStatus], [[], {}, {}]);
    eq('C5', '展开态：setFilter 后全清', [f.expanded, f.expandTokens, f.expandStatus], [[], {}, {}]);
    const t = core.toggleSort(S, 'id').state;
    eq('C5', '展开态：toggleSort 后 expanded / 令牌 / 状态不变', [t.expanded, t.expandTokens, t.expandStatus], [S.expanded, S.expandTokens, S.expandStatus]);
  }
  // C6 展开加载
  {
    const a = core.toggleExpand(S0({}), { id: 22 });
    const t1 = a.state.expandTokens[22];
    eq('C6', '展开加载：首次展开发出 fetch-relations 带令牌', a.effects, [{ type: 'fetch-relations', id: 22, token: 1 }]);
    eq('C6', '展开加载：展开后状态 loading', a.state.expandStatus, { 22: 'loading' });
    const b = core.toggleExpand(a.state, { id: 22 });
    eq('C6', '展开加载：收起 → expanded 空、令牌与状态删除', [b.state.expanded, b.state.expandTokens, b.state.expandStatus], [[], {}, {}]);
    const c = core.relationsArrived(b.state, { id: 22, token: t1, ok: true });
    eq('C6', '展开加载：收起后迟到的响应被丢弃', [c.effects, c.state.expandStatus], [[{ type: 'discard-relations', id: 22, token: 1 }], {}]);
    const d = core.toggleExpand(c.state, { id: 22 });
    const t2 = d.state.expandTokens[22];
    check('C6', '展开加载：再展开发新令牌（≠ t1）', t2 !== t1 && t2 === 2, `t1=${t1} t2=${t2}`);
    const e = core.relationsArrived(d.state, { id: 22, token: t1, ok: true });
    eq('C6', '展开加载：旧令牌 t1 的响应仍丢弃、状态保持 loading', [e.effects.map(x => x.type), e.state.expandStatus], [['discard-relations'], { 22: 'loading' }]);
    const f = core.relationsArrived(d.state, { id: 22, token: t2, ok: false });
    eq('C6', '展开加载：失败 → error 且无 toast 类 effect', [f.state.expandStatus, f.effects], [{ 22: 'error' }, []]);
    const g = core.retryExpand(f.state, { id: 22 });
    eq('C6', '展开加载：重试 → 新令牌 + loading + fetch-relations', [g.state.expandStatus, g.state.expandTokens, g.effects], [{ 22: 'loading' }, { 22: 3 }, [{ type: 'fetch-relations', id: 22, token: 3 }]]);
    const h = core.relationsArrived(g.state, { id: 22, token: 3, ok: true });
    eq('C6', '展开加载：成功 → loaded', h.state.expandStatus, { 22: 'loaded' });
    const noRetry = core.retryExpand(h.state, { id: 22 });
    eq('C6', '展开加载：非 error 态 retryExpand 无动作', [noRetry.effects, noRetry.state.expandStatus], [[], { 22: 'loaded' }]);
    const never = core.relationsArrived(S0({}), { id: 7, token: undefined, ok: true });
    eq('C6', '展开加载：从未展开过的 id 收到响应（token 缺失）也丢弃', never.effects.map(x => x.type), ['discard-relations']);
  }
  // F 筛选
  eq('F1', '筛选：layer=DIM 大小写不敏感 → dim 行', view(BASE, { filters: { layer: 'DIM' } }).orderedIds, [10, 52]);
  eq('F1', '筛选：layer=dwd → 伴生与主模型同层 → 整组 + 落单', view(BASE, { filters: { layer: 'dwd' } }).orderedIds, [22, 21, 41]);
  eq('F1', '筛选：值为 null / 空串 → 不筛', [view(BASE, { filters: { layer: null } }).totalGroups, view(BASE, { filters: { layer: '' } }).totalGroups], [5, 5]);
  let msg = '';
  try { view(BASE, { filters: { nosuch: 'x' } }); } catch (e) { msg = e.message; }
  check('F2', '筛选：未登记的键抛错（fail-closed）', /nosuch/.test(msg), msg);
  msg = '';
  try { view(BASE, { filters: { nosuch: '' } }); } catch (e) { msg = e.message; }
  check('F2', '筛选：未登记的键即使值为空也抛错', /nosuch/.test(msg), msg);
  {
    const st = S0({ page: 2, expanded: [22] });
    const before = J(st);
    let m2 = '';
    try { core.setFilter(st, 'nosuch', 'x'); } catch (e) { m2 = e.message; }
    check('F2', 'setFilter：未登记的键立即抛错（脏键不会写进状态）', /nosuch/.test(m2), m2);
    check('F2', 'setFilter：抛错时入参状态不变', J(st) === before);
  }
  // F3：搜索只命中伴生、筛选只通过主模型 → 同一成员须同时满足（按派单「任一成员 matchRow 且通过全部筛选」字面）；见报告「待裁定」
  const split = [R({ id: 1, layer: 'dim', table_name: 'p_main' }), R({ id: 2, layer: 'dwd', table_name: 'c_hit', config_mode: 'companion', companion_of: 1 })];
  eq('F3', '筛选 × 搜索：搜索命中伴生（dwd）、筛选 layer=dim 只通过主模型 → 无单一成员同时满足 → 组不显示', view(split, { query: 'c_hit', filters: { layer: 'dim' } }).orderedIds, []);
  eq('F3', '筛选 × 搜索：搜索与筛选落在同一成员 → 整组显示', view(split, { query: 'c_hit', filters: { layer: 'dwd' } }).orderedIds, [1, 2]);
  check('F3', 'GROUP_HIT_RULE 导出为 same-member（P23 当前口径；接线层与用例只引用此常量）', core.GROUP_HIT_RULE === 'same-member');
  // SF 排序字段 fail-closed
  const throwsMsg = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message); } };
  check('SF1', '未登记的 sortBy 抛错（不再静默落入 string 分支）', /排序字段/.test(throwsMsg(() => view(BASE, { sortBy: 'nosuch', sortDir: 'asc' }))));
  check('SF1', '未登记的 sortBy（原型键 toString / constructor）也抛错', /排序字段/.test(throwsMsg(() => view(BASE, { sortBy: 'toString', sortDir: 'asc' }))) && /排序字段/.test(throwsMsg(() => view(BASE, { sortBy: 'constructor', sortDir: 'asc' }))));
  check('SF1', 'sortDir 不是 asc / desc 抛错', /sortDir/.test(throwsMsg(() => view(BASE, { sortBy: 'id', sortDir: 'up' }))));
  check('SF1', "空字符串 sortBy 抛错（只有 null / undefined 表示未排序）", /排序字段/.test(throwsMsg(() => view(BASE, { sortBy: '', sortDir: 'asc' }))) && /排序字段/.test(throwsMsg(() => view(BASE, { sortBy: '', sortDir: 'desc' }))));
  check('SF1', 'toggleSort 对空字符串字段抛错', /排序字段/.test(throwsMsg(() => core.toggleSort(S0({}), ''))));
  check('SF1', 'sortBy 为 null / undefined 表示未排序，不抛错且是默认序', J(view(BASE, { sortBy: null }).orderedIds) === J(view(BASE, { sortBy: undefined }).orderedIds) && J(view(BASE, { sortBy: null }).orderedIds) === J([10, 22, 21, 30, 41, 52]));
  check('SF1', 'toggleSort 对未登记字段抛错', /排序字段/.test(throwsMsg(() => core.toggleSort(S0({}), 'nosuch'))));
  // PS 事件函数不收 pageSize（传了即抛错）
  {
    const armed = core.reloadStart(S0({})).state;
    for (const ps of [20, 19, '20', undefined]) {
      check('PS1', 'listArrived 的参数里带 pageSize=' + String(ps) + ' 抛错', /不接收 pageSize/.test(throwsMsg(() => core.listArrived(armed, { token: armed.listToken, rows: BASE, pageSize: ps }))));
      check('PS1', 'listArrived（令牌不符的丢弃路径）带 pageSize=' + String(ps) + ' 也抛错', /不接收 pageSize/.test(throwsMsg(() => core.listArrived(armed, { token: 999, rows: BASE, pageSize: ps }))));
      check('PS1', 'focus 的参数里带 pageSize=' + String(ps) + ' 抛错', /不接收 pageSize/.test(throwsMsg(() => core.focus(S0({}), { id: 22, rows: BASE, pageSize: ps }))));
    }
    check('PS1', '不带 pageSize 的事件调用正常（每页固定 PAGE_SIZE）', core.listArrived(armed, { token: armed.listToken, rows: BASE }).state.page === 1 && core.focus(S0({}), { id: 22, rows: BASE }).state.page === 1);
  }
  // CS createState：合法初始状态，能直接喂给 computeView 与每个事件函数
  {
    const cs = core.createState();
    eq('CS1', 'createState 返回约定的初始状态', J(cs), J({ page: 1, sortBy: null, sortDir: 'desc', query: '', filters: {}, expanded: [], listToken: 0, seq: 0, expandTokens: {}, expandStatus: {}, relations: {} }));
    check('CS1', 'createState 每次返回独立对象（改一份不影响另一份）', (() => { const a = core.createState(); a.expanded.push(1); a.filters.layer = 'x'; a.expandTokens[1] = 1; const b = core.createState(); return b.expanded.length === 0 && !('layer' in b.filters) && !(1 in b.expandTokens); })());
    const vw = core.computeView(BASE, { query: cs.query, filters: cs.filters, sortBy: cs.sortBy, sortDir: cs.sortDir, page: cs.page, pageSize: core.PAGE_SIZE });
    eq('CS1', 'createState 直接喂 computeView：默认序', vw.orderedIds, [10, 22, 21, 30, 41, 52]);
    const rs = core.reloadStart(cs);
    const la = core.listArrived(rs.state, { token: rs.state.listToken, rows: BASE });
    const steps = [
      ['reloadStart', () => rs.state.listToken === 1],
      ['listArrived', () => la.state.page === 1 && la.state.listToken === 0],
      ['setQuery', () => core.setQuery(core.createState(), 'beta').state.query === 'beta'],
      ['setFilter', () => core.setFilter(core.createState(), 'layer', 'dim').state.filters.layer === 'dim'],
      ['gotoPage', () => core.gotoPage(core.createState(), { page: 1, totalPages: 1 }).state.page === 1],
      ['toggleSort', () => core.toggleSort(core.createState(), 'id').state.sortBy === 'id'],
      ['focus', () => core.focus(core.createState(), { id: 22, rows: BASE }).effects[0].type === 'highlight'],
      ['toggleExpand', () => core.toggleExpand(core.createState(), { id: 22 }).effects[0].type === 'fetch-relations'],
      ['relationsArrived', () => core.relationsArrived(core.toggleExpand(core.createState(), { id: 22 }).state, { id: 22, token: 1, ok: true, data: 'D' }).state.expandStatus[22] === 'loaded'],
      ['retryExpand', () => core.retryExpand(core.createState(), { id: 22 }).effects.length === 0],
    ];
    for (const [name, fn] of steps) check('CS1', 'createState 直接喂 ' + name + '：不抛错且结果合法', (() => { try { return fn() === true; } catch (e) { return false; } })());
  }
  // PG 每页固定 20 组、页码正整数
  eq('PG1', 'PAGE_SIZE 导出为 20', core.PAGE_SIZE, 20);
  for (const ps of [19, 21, 1000, 0, undefined, '20']) check('PG1', 'computeView 拒绝 pageSize=' + String(ps), /每页固定/.test(throwsMsg(() => core.computeView(BASE, { query: '', filters: {}, page: 1, pageSize: ps }))));
  for (const pg of [0, -1, 1.5, NaN, Infinity, '2', undefined, null]) check('PG2', 'computeView 拒绝 page=' + String(pg), /page 必须是正整数/.test(throwsMsg(() => core.computeView(BASE, { query: '', filters: {}, page: pg, pageSize: 20 }))));
  for (const pg of [0, -1, 1.5, NaN, Infinity, '2', undefined]) check('PG3', 'gotoPage 拒绝 page=' + String(pg), /page 必须是正整数/.test(throwsMsg(() => core.gotoPage(S0({}), { page: pg, totalPages: 3 }))));
  for (const tp of [1.5, NaN, -1, '3', undefined]) check('PG3', 'gotoPage 拒绝 totalPages=' + String(tp), /totalPages/.test(throwsMsg(() => core.gotoPage(S0({}), { page: 1, totalPages: tp }))));
  eq('PG3', 'gotoPage 超出 totalPages（合法整数）→ 状态原样', J(core.gotoPage(S0({ page: 2 }), { page: 3, totalPages: 2 }).state), J(S0({ page: 2 })));
  // N 三态排序
  eq('N1', '三态：新列 → desc', core.nextSort(null, 'desc', 'id'), { sortBy: 'id', sortDir: 'desc' });
  eq('N2', '三态：同列 desc → asc', core.nextSort('id', 'desc', 'id'), { sortBy: 'id', sortDir: 'asc' });
  eq('N3', '三态：同列 asc → 清除', core.nextSort('id', 'asc', 'id'), { sortBy: null, sortDir: 'desc' });
  eq('N4', '三态：换列 → 新列 desc（无论原方向）', core.nextSort('id', 'asc', 'layer'), { sortBy: 'layer', sortDir: 'desc' });
  // L clampPage / locate
  eq('L1', 'clampPage：0 页 → 1；越界 → 末页；< 1 → 1；区间内原样', [core.clampPage(3, 0), core.clampPage(5, 2), core.clampPage(0, 2), core.clampPage(2, 2), core.clampPage(1, 3)], [1, 2, 1, 2, 1]);
  const bv = view(big);
  eq('L2', 'locate：#116（第 21 组）→ 第 2 页第 1 个；#21（伴生）→ 第 1 页第 2 个；#9999 → null', [core.locate(bv, 116), core.locate(bv, 21), core.locate(bv, 9999)], [{ page: 2, index: 1 }, { page: 1, index: 2 }, null]);
  eq('L2', 'locate：第 20 组（#115）在第 1 页末位（页边界）', core.locate(bv, 115), { page: 1, index: 20 });
});

// ═════════ 四 §3.4 事件表逐行一例 ═════════
const EV_ROWS = BASE.concat(fillers(30, 101));    // 35 组：第 1 页 20 组、第 2 页 15 组（101+15=116 起）
section('四 事件表', () => {
  // E1 数据重载：令牌与保留
  {
    let S = S0({});
    S = core.gotoPage(S, { page: 2, totalPages: 2 }).state;
    S = core.toggleExpand(S, { id: 120 }).state;   // 令牌 1（第 2 页）
    S = core.toggleExpand(S, { id: 22 }).state;    // 令牌 2（第 1 页）
    eq('E1', '重载前：page 2、expanded [120,22]、令牌 {120:1,22:2}', [S.page, S.expanded, S.expandTokens], [2, [120, 22], { 120: 1, 22: 2 }]);
    const r1 = core.reloadStart(S);
    eq('E1', '重载 t1：fetch-list 令牌 3、展开令牌全部作废、listToken 3', [r1.effects, r1.state.expandTokens, r1.state.listToken], [[{ type: 'fetch-list', token: 3 }], {}, 3]);
    const r2 = core.reloadStart(r1.state);
    eq('E1', '重载 t2：令牌 4', [r2.effects, r2.state.listToken], [[{ type: 'fetch-list', token: 4 }], 4]);
    const late = core.listArrived(r2.state, { token: 3, rows: EV_ROWS });
    eq('E1', '迟到的 t1 响应：丢弃且状态不变', [late.effects, J(late.state)], [[{ type: 'discard-list', token: 3 }], J(r2.state)]);
    const ok = core.listArrived(r2.state, { token: 4, rows: EV_ROWS });
    eq('E1', 't2 到达：page 保持 2（D-13）', ok.state.page, 2);
    eq('E1', 't2 到达：expanded 只留仍在新当前页的 [120]', ok.state.expanded, [120]);
    eq('E1', 't2 到达：对 120 发新 fetch-relations（令牌 5 ≠ 旧令牌 1），先显示加载态', [ok.effects, ok.state.expandTokens, ok.state.expandStatus], [[{ type: 'fetch-relations', id: 120, token: 5 }], { 120: 5 }, { 120: 'loading' }]);
    eq('E1', 't2 到达：listToken 归 0', ok.state.listToken, 0);
    const dup = core.listArrived(ok.state, { token: 4, rows: EV_ROWS });
    eq('E1', '同一令牌再次到达：丢弃（listToken 已归 0）', dup.effects.map(x => x.type), ['discard-list']);
    // 重载时按「当前」查询 / 排序重算：展开的 id 被筛掉也不保留
    const q = Object.assign({}, r2.state, { query: 'f20', page: 1, expanded: [120, 22] });
    const okq = core.listArrived(q, { token: 4, rows: EV_ROWS });
    eq('E1', '重载按当前搜索重算：query=f20 → 只剩 #120 一组 → page 1、expanded 仍含 120、不含已被筛掉的 22', [okq.state.page, okq.state.expanded], [1, [120]]);
  }
  // E1c 重载保留多个展开项：两项都 loading、各拿新的不同令牌、旧数据不复用；被筛掉的不请求
  {
    const st0 = S0({ page: 2, query: 'ods_f', expanded: [122, 125, 22], expandTokens: { 122: 3, 125: 4, 22: 5 }, expandStatus: { 122: 'loaded', 125: 'loaded', 22: 'loaded' }, relations: { 122: 'old1', 125: 'old2', 22: 'old3' }, seq: 5 });
    const r1 = core.reloadStart(st0);
    eq('E1c', '重载开始：listToken 6、展开令牌作废', [r1.state.listToken, J(r1.state.expandTokens)], [6, '{}']);
    const ok = core.listArrived(r1.state, { token: 6, rows: EV_ROWS });
    eq('E1c', '重载到达：page 2、expanded 只留 [122,125]（22 被搜索筛掉）', [ok.state.page, ok.state.expanded], [2, [122, 125]]);
    eq('E1c', '重载到达：两项各发 fetch-relations，令牌 7 / 8 互不相同且不复用旧令牌 3 / 4；22 不请求', ok.effects, [{ type: 'fetch-relations', id: 122, token: 7 }, { type: 'fetch-relations', id: 125, token: 8 }]);
    eq('E1c', '重载到达：两项都是 loading、令牌 {122:7,125:8}、旧关系数据全部清空', [J(ok.state.expandStatus), J(ok.state.expandTokens), J(ok.state.relations), ok.state.seq, ok.state.listToken], [J({ 122: 'loading', 125: 'loading' }), J({ 122: 7, 125: 8 }), '{}', 8, 0]);
  }
  // R 关系数据所有权（核心按 id 保存，页面只从状态读取）
  {
    const a = core.toggleExpand(S0({}), { id: 22 });
    const DATA = { upstream: [{ name: 'x' }], objects: [] };
    const ok = core.relationsArrived(a.state, { id: 22, token: 1, ok: true, data: DATA });
    eq('R1', '令牌通过且 ok：状态 loaded、数据按 id 存进 state.relations', [J(ok.state.expandStatus), J(ok.state.relations)], [J({ 22: 'loaded' }), J({ 22: DATA })]);
    const bad = core.relationsArrived(a.state, { id: 22, token: 1, ok: false, data: DATA });
    eq('R1', '失败：状态 error、不保存数据', [J(bad.state.expandStatus), J(bad.state.relations)], [J({ 22: 'error' }), '{}']);
    const late = core.relationsArrived(a.state, { id: 22, token: 99, ok: true, data: DATA });
    eq('R2', '令牌不符的迟到响应：丢弃且不写入数据', [late.effects.map(x => x.type), J(late.state.relations), J(late.state.expandStatus)], [['discard-relations'], '{}', J({ 22: 'loading' })]);
    const collapsed = core.toggleExpand(ok.state, { id: 22 });
    eq('R3', '收起：清掉该行的关系数据、令牌、状态', [J(collapsed.state.relations), J(collapsed.state.expandTokens), J(collapsed.state.expandStatus)], ['{}', '{}', '{}']);
    const lateAfter = core.relationsArrived(collapsed.state, { id: 22, token: 1, ok: true, data: DATA });
    eq('R2', '收起后的迟到响应：丢弃且不写入数据', [lateAfter.effects.map(x => x.type), J(lateAfter.state.relations)], [['discard-relations'], '{}']);
    const kept = core.toggleExpand(core.toggleExpand(ok.state, { id: 30 }).state, { id: 30 });
    eq('R3', '收起另一行不影响已加载行的数据', J(kept.state.relations), J({ 22: DATA }));
    const rt = core.retryExpand(core.relationsArrived(core.toggleExpand(S0({}), { id: 22 }).state, { id: 22, token: 1, ok: false }).state, { id: 22 });
    eq('R1', '重试：状态回 loading、仍无数据', [J(rt.state.expandStatus), J(rt.state.relations)], [J({ 22: 'loading' }), '{}']);
    const st = S0({ page: 2, query: '', expanded: [120], expandTokens: { 120: 1 }, expandStatus: { 120: 'loaded' }, relations: { 120: 'OLD' }, seq: 1 });
    const rl = core.reloadStart(st);
    eq('R4', '重载开始：已收到的数据保留到新列表到达（展开令牌作废）', [J(rl.state.relations), J(rl.state.expandTokens)], [J({ 120: 'OLD' }), '{}']);
    const arr = core.listArrived(rl.state, { token: rl.state.listToken, rows: EV_ROWS });
    eq('R4', '重载到达：保留展开的行清掉旧数据、状态 loading、重新请求', [J(arr.state.relations), J(arr.state.expandStatus), arr.effects], ['{}', J({ 120: 'loading' }), [{ type: 'fetch-relations', id: 120, token: 3 }]]);
    const pg = core.gotoPage(ok.state, { page: 2, totalPages: 2 });
    const sq = core.setQuery(ok.state, 'x');
    eq('R3', '翻页 / 改搜索：关系数据一并清空', [J(pg.state.relations), J(sq.state.relations)], ['{}', '{}']);
  }
  // T id 类型统一：状态里按 String(id) 存取，数字 / 字符串交叉
  {
    const a = core.toggleExpand(S0({}), { id: 22 });
    const viaStr = core.relationsArrived(a.state, { id: '22', token: 1, ok: true, data: 'D' });
    eq('T2', '展开用数字 22、响应用字符串 "22"：被接受（loaded + 数据）', [J(viaStr.state.expandStatus), J(viaStr.state.relations)], [J({ 22: 'loaded' }), J({ 22: 'D' })]);
    const b = core.toggleExpand(S0({}), { id: '22' });
    const viaNum = core.relationsArrived(b.state, { id: 22, token: 1, ok: true, data: 'D' });
    eq('T2', '展开用字符串 "22"、响应用数字 22：被接受', [J(viaNum.state.expandStatus), J(viaNum.state.relations)], [J({ 22: 'loaded' }), J({ 22: 'D' })]);
    const c1 = core.toggleExpand(a.state, { id: '22' });
    eq('T1', '数字 22 展开后用字符串 "22" 收起：expanded 空、令牌 / 状态 / 数据清空', [c1.state.expanded, J(c1.state.expandTokens), J(c1.state.expandStatus)], [[], '{}', '{}']);
    const c2 = core.toggleExpand(b.state, { id: 22 });
    eq('T1', '字符串 "22" 展开后用数字 22 收起：expanded 空', [c2.state.expanded, J(c2.state.expandTokens)], [[], '{}']);
    const lateStr = core.relationsArrived(c1.state, { id: 22, token: 1, ok: true, data: 'D' });
    eq('T5', '收起（交叉类型）后的迟到响应：丢弃', [lateStr.effects.map(x => x.type), J(lateStr.state.relations)], [['discard-relations'], '{}']);
    const s3 = S0({ page: 2, expanded: ['120', 125], expandTokens: { 120: 1, 125: 2 }, expandStatus: { 120: 'loaded', 125: 'loaded' }, relations: { 120: 'o', 125: 'o' }, seq: 2 });
    const rl = core.reloadStart(s3);
    const arr = core.listArrived(rl.state, { token: rl.state.listToken, rows: EV_ROWS });
    eq('T3', '重载：expanded 里的字符串 "120" 与数字 125 都按 String 比较保留，effect 的 id 保持原值', [arr.state.expanded, arr.effects], [['120', 125], [{ type: 'fetch-relations', id: '120', token: 4 }, { type: 'fetch-relations', id: 125, token: 5 }]]);
    const er = core.relationsArrived(core.toggleExpand(S0({}), { id: 22 }).state, { id: 22, token: 1, ok: false });
    const rt = core.retryExpand(er.state, { id: '22' });
    eq('T4', 'error 记在数字 22 上，用字符串 "22" 重试：生效', [rt.effects.length, J(rt.state.expandStatus)], [1, J({ 22: 'loading' })]);
  }
  // E1b 夹紧
  {
    const S = core.reloadStart(S0({ page: 2 })).state;
    const few = core.listArrived(S, { token: S.listToken, rows: BASE.concat(fillers(10, 101)) });
    eq('E1b', '夹紧：第 2 页重载到 ≤20 组 → page 1', few.state.page, 1);
    const zero = core.listArrived(S, { token: S.listToken, rows: [] });
    eq('E1b', '夹紧：重载到 0 行 → page 1、展开清空', [zero.state.page, zero.state.expanded], [1, []]);
    const S3 = core.reloadStart(S0({ page: 3 })).state;
    const two = core.listArrived(S3, { token: S3.listToken, rows: EV_ROWS });
    eq('E1b', '夹紧：第 3 页重载到 2 页数据 → 末页 2', two.state.page, 2);
    const S4 = core.reloadStart(S0({ page: 2, expanded: [116], expandTokens: { 116: 1 }, seq: 1 })).state;
    const r21 = core.listArrived(S4, { token: S4.listToken, rows: BASE.concat(fillers(15, 101)) });
    eq('E1b', '夹紧：第 2 页重载到「20 组 21 行」→ 夹到最后一个非空页 = 第 1 页（按行算会停在空的第 2 页）', [r21.state.page, r21.state.expanded], [1, []]);
  }
  // E2 改搜索 / 改筛选 / 翻页
  {
    const base = S0({ page: 2, expanded: [120], expandTokens: { 120: 7 }, expandStatus: { 120: 'loaded' }, seq: 7 });
    const a = core.setQuery(base, 'zzz').state;
    eq('E2a', '改搜索：page 1、query、展开与令牌清空', [a.page, a.query, a.expanded, a.expandTokens, a.expandStatus], [1, 'zzz', [], {}, {}]);
    const b = core.setFilter(base, 'layer', 'dim').state;
    eq('E2b', '改筛选：page 1、filters、展开与令牌清空', [b.page, b.filters, b.expanded, b.expandTokens, b.expandStatus], [1, { layer: 'dim' }, [], {}, {}]);
    const c = core.gotoPage(base, { page: 1, totalPages: 2 }).state;
    eq('E2c', '翻页到 1：page 1、展开与令牌清空', [c.page, c.expanded, c.expandTokens, c.expandStatus], [1, [], {}, {}]);
    const hi = core.gotoPage(base, { page: 3, totalPages: 2 });
    eq('E2c', '翻页超出末页（3）：状态原样、无 effect；page 0 不是正整数 → 抛错', [J(hi.state), hi.effects, /正整数/.test((() => { try { core.gotoPage(base, { page: 0, totalPages: 2 }); return ''; } catch (e) { return e.message; } })())], [J(base), [], true]);
    eq('E2a', 'seq 单调不回退', [a.seq, b.seq, c.seq], [7, 7, 7]);
  }
  // P36（C4c-4 4a，用户 10-09 同意）：「改」指实际变化——搜索词 trim 后与当前相同、翻到当前页，状态原样（不回第 1 页、不清展开、不作废令牌）
  {
    // 基态：第 2 页、搜索词 'abc'、展开 #120（已加载）、令牌 7；手写期望：这些字段在「条件没变」时一个都不许动
    const base = S0({ page: 2, query: 'abc', expanded: [120], expandTokens: { 120: 7 }, expandStatus: { 120: 'loaded' }, relations: { 120: { objects: [] } }, seq: 7 });
    const thr = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message); } };
    const keepAll = (r) => [r.state.page, r.state.expanded, r.state.expandTokens, r.state.expandStatus, r.state.relations, r.state.seq, r.effects];
    const KEPT = [2, [120], { 120: 7 }, { 120: 'loaded' }, { 120: { objects: [] } }, 7, []];
    const CLEARED = (page, query) => [page, query, [], {}, {}, {}, 7, []];
    const cleared = (r) => [r.state.page, r.state.query, r.state.expanded, r.state.expandTokens, r.state.expandStatus, r.state.relations, r.state.seq, r.effects];
    eq('P36:q.same', '同词 abc → page / expanded / expandTokens / expandStatus / relations / seq / effects 全部不变', keepAll(core.setQuery(base, 'abc')), KEPT);
    eq('P36:q.same.pad', '同词但首尾空格不同（"  abc "）→ 仍视为没变', keepAll(core.setQuery(base, '  abc ')), KEPT);
    eq('P36:q.same.state', '同词 → 整个状态与入参逐字段相同（含 query 原值）', J(core.setQuery(base, 'abc').state), J(base));
    const basePad = S0({ page: 2, query: ' abc  ', expanded: [120], expandTokens: { 120: 7 }, expandStatus: { 120: 'loaded' }, relations: { 120: { objects: [] } }, seq: 7 });
    eq('P36:q.same.basepad', '当前搜索词自带首尾空格（" abc  "），传 "abc" → 没变', keepAll(core.setQuery(basePad, 'abc')), KEPT);
    eq('P36:q.diff', '异词 abd → 回第 1 页、query 更新、展开 / 令牌 / 状态 / 关系数据全清', cleared(core.setQuery(base, 'abd')), CLEARED(1, 'abd'));
    eq('P36:q.case', '只差大小写（ABC）按「改搜索」处理：回第 1 页并清空（不做大小写折叠）', cleared(core.setQuery(base, 'ABC')), CLEARED(1, 'ABC'));
    eq('P36:q.inner', '只差词内空白（"a bc"）按「改搜索」处理（只 trim 首尾，不折叠内部空白）', cleared(core.setQuery(base, 'a bc')), CLEARED(1, 'a bc'));
    eq('P36:q.toempty', '清空搜索框（"abc" → ""）是改搜索', cleared(core.setQuery(base, '')), CLEARED(1, ''));
    // 空值口径：null / undefined / 纯空白都按空串比较（与 matchRow 的 String(query ?? '').trim() 一致）
    const base0 = S0({ page: 2, query: '', expanded: [120], expandTokens: { 120: 7 }, expandStatus: { 120: 'loaded' }, relations: { 120: { objects: [] } }, seq: 7 });
    for (const q of [undefined, null, '', '   ']) eq('P36:q.empty', '当前词为空时再传 ' + J(q === undefined ? 'undefined' : q) + ' → 没变', keepAll(core.setQuery(base0, q)), KEPT);
    eq('P36:q.empty.diff', '当前词为空时传 "x" → 改搜索', cleared(core.setQuery(base0, 'x')), CLEARED(1, 'x'));
    // codex 41Td-M4：上面「条件不变」用例的 keepAll 不含 query，同词分支误写 c.query = q 时首尾空格 / null / undefined 用例仍过。这里补：返回状态与入参逐字段相等（J 全串 + query 的 typeof 与字符串化，区分 null / undefined / 空串）、effects 为空
    const sig = (s) => [J(s), typeof s.query, String(s.query)];
    const noChange = (id, desc, st, q) => { const r = core.setQuery(st, q); eq(id, desc, [sig(r.state), r.effects], [sig(st), []]); };
    noChange('P36:q.same.full', '同词 abc → 返回状态与入参完全相同（含 query 原值 "abc"）、effects 为空', base, 'abc');
    noChange('P36:q.same.pad.full', '同词但首尾空格不同（"  abc "）→ 返回状态与入参完全相同，query 仍是 "abc"（不被改写成 "  abc "）、effects 为空', base, '  abc ');
    noChange('P36:q.same.basepad.full', '当前搜索词自带首尾空格（" abc  "），传 "abc" → 返回状态与入参完全相同，query 仍是 " abc  "（不被改写成 "abc"）、effects 为空', basePad, 'abc');
    for (const q of [undefined, null, '', '   ']) noChange('P36:q.empty.full', '当前词为 "" 时再传 ' + J(q === undefined ? 'undefined' : q) + ' → 返回状态与入参完全相同（query 仍是 ""）、effects 为空', base0, q);
    // 当前状态的 query 为 null / undefined（含 undefined 自有属性）：传 null / undefined / 空串 / 空白都是「没变」，query 原值（null / undefined）不被改写
    for (const [bl, mkq] of [['null', (s) => { s.query = null; }], ['undefined', (s) => { s.query = undefined; }]]) {
      const bn = S0({ page: 2, expanded: [120], expandTokens: { 120: 7 }, expandStatus: { 120: 'loaded' }, relations: { 120: { objects: [] } }, seq: 7 }); mkq(bn);
      for (const q of [undefined, null, '', '   ']) noChange('P36:q.nullbase.full', '当前词为 ' + bl + ' 时再传 ' + J(q === undefined ? 'undefined' : q) + ' → 返回状态与入参完全相同（query 仍是 ' + bl + '）、effects 为空', bn, q);
    }
    eq('P36:q.nonstr', '当前词是 "null" 字面量时传 null → 是改搜索（null 按空串，不按字面量 "null"）', cleared(core.setQuery(S0({ page: 2, query: 'null', expanded: [120], expandTokens: { 120: 7 }, expandStatus: { 120: 'loaded' }, relations: { 120: { objects: [] } }, seq: 7 }), null)), CLEARED(1, null));
    // 翻页
    eq('P36:p.same', '翻到当前页（page 2 / totalPages 3）→ 状态原样', keepAll(core.gotoPage(base, { page: 2, totalPages: 3 })), KEPT);
    eq('P36:p.same.state', '翻到当前页 → 整个状态与入参逐字段相同', J(core.gotoPage(base, { page: 2, totalPages: 3 }).state), J(base));
    eq('P36:p.diff.down', '翻到第 1 页（异页，向前）→ 展开 / 令牌 / 状态 / 关系数据全清', cleared(core.gotoPage(base, { page: 1, totalPages: 3 })), CLEARED(1, 'abc'));
    eq('P36:p.diff.up', '翻到第 3 页（异页，向后）→ 全清', cleared(core.gotoPage(base, { page: 3, totalPages: 3 })), CLEARED(3, 'abc'));
    eq('P36:p.over', '超出末页（4 / 3）仍状态原样（既有口径不变）', keepAll(core.gotoPage(base, { page: 4, totalPages: 3 })), KEPT);
    eq('P36:p.first', '第 1 页上翻到第 1 页 → 状态原样', J(core.gotoPage(S0({ expanded: [22], expandTokens: { 22: 1 }, expandStatus: { 22: 'loading' }, seq: 1 }), { page: 1, totalPages: 2 }).state), J(S0({ expanded: [22], expandTokens: { 22: 1 }, expandStatus: { 22: 'loading' }, seq: 1 })));
    eq('P36:p.throw', '同页判断不绕过参数校验：page 0 / totalPages 1.5 仍抛错', [/正整数/.test(thr(() => core.gotoPage(base, { page: 0, totalPages: 3 }))), /totalPages/.test(thr(() => core.gotoPage(base, { page: 2, totalPages: 1.5 })))], [true, true]);
    // 链：同词、同页之后，原有的「改了才清」仍成立（守卫不是一次性的）
    const afterSame = core.gotoPage(core.setQuery(base, 'abc').state, { page: 2, totalPages: 3 }).state;
    eq('P36:chain', '先同词再同页，展开仍在；再异词才清空', [afterSame.expanded, cleared(core.setQuery(afterSame, 'zzz'))], [[120], CLEARED(1, 'zzz')]);
  }
  // E3 排序
  {
    const base = S0({ page: 2, expanded: [120], expandTokens: { 120: 7 }, expandStatus: { 120: 'loaded' }, seq: 7 });
    const s1 = core.toggleSort(base, 'id').state;
    eq('E3', '排序：page 1、sortBy id desc、expanded / 令牌 / 状态原样', [s1.page, s1.sortBy, s1.sortDir, s1.expanded, s1.expandTokens, s1.expandStatus], [1, 'id', 'desc', [120], { 120: 7 }, { 120: 'loaded' }]);
    const s2 = core.toggleSort(s1, 'id').state;
    const s3 = core.toggleSort(s2, 'id').state;
    eq('E3', '排序：三击回默认', [s2.sortDir, s3.sortBy, s3.sortDir, s3.expanded], ['asc', null, 'desc', [120]]);
    // L7 读法：排序保留展开集合；翻页一律收起，翻回去也不恢复
    const keep = core.toggleSort(core.toggleExpand(S0({}), { id: 22 }).state, 'id').state;
    eq('E3b', '排序后展开集合保留（L7 读法）', keep.expanded, [22]);
    const back = core.gotoPage(core.gotoPage(keep, { page: 2, totalPages: 2 }).state, { page: 1, totalPages: 2 }).state;
    eq('E3b', '翻页后展开清空，翻回去也不恢复（L7 读法：翻页一律收起）', back.expanded, []);
  }
  // E4 ?focus
  {
    const base = S0({ page: 2, query: 'zzz', filters: { layer: 'DIM' }, expanded: [22], expandTokens: { 22: 3 }, expandStatus: { 22: 'loaded' }, seq: 3 });
    const f = core.focus(base, { id: 21, rows: EV_ROWS });
    eq('E4', '?focus 伴生 #21：query 空、filters 空、page 1', [f.state.query, f.state.filters, f.state.page], ['', {}, 1]);
    eq('E4', '?focus：effects 恰为 highlight 3000ms', f.effects, [{ type: 'highlight', id: 21, ms: 3000 }]);
    eq('E4', '?focus：不自动展开（expanded / 令牌 / 状态清空）', [f.state.expanded, f.state.expandTokens, f.state.expandStatus], [[], {}, {}]);
    const g = core.focus(base, { id: 125, rows: EV_ROWS });
    eq('E4', '?focus #125 → 第 2 页', [g.state.page, g.effects], [2, [{ type: 'highlight', id: 125, ms: 3000 }]]);
    const h = core.focus(base, { id: 115, rows: EV_ROWS });
    eq('E4', '?focus #115（第 20 组，页边界）→ 第 1 页', h.state.page, 1);
    const sorted = core.focus(Object.assign({}, base, { sortBy: 'id', sortDir: 'desc' }), { id: 10, rows: EV_ROWS });
    eq('E4', '?focus 按当前排序定位：id desc 下 #10（最小 id，最后一组）→ 第 2 页', sorted.state.page, 2);
    const nf = core.focus(base, { id: 9999, rows: EV_ROWS });
    eq('E4b', '?focus 目标不存在：page 1、effects 恰为 toast', [nf.state.page, nf.effects], [1, [{ type: 'toast', text: '模型不存在或已删除', level: 'warning' }]]);
  }
});

// ═════════ 五 搜索逐字段 ═════════
section('五 搜索', () => {
  const rows = BASE.concat([R({ id: 60, layer: 'dim', table_name: 'dimXalpha', table_comment: '无下划线' })]);
  const ids = (q) => view(rows, { query: q }).orderedIds;
  eq('S:name', '表名 dim_alpha → [10]（_ 只当字面量，dimXalpha 不命中）', ids('dim_alpha'), [10]);
  eq('S:comment', '中文短名（table_comment）阿尔法 → [10]', ids('阿尔法'), [10]);
  eq('S:note', '实现说明 第二句 → [22,21]', ids('第二句'), [22, 21]);
  eq('S:srctbl', 'source_table t_order → [30]', ids('t_order'), [30]);
  eq('S:erp', 'source_system erp（小写命中大写）→ [30]', ids('erp'), [30]);
  eq('S:up', '上游名 ods_up_one → [22,21]', ids('ods_up_one'), [22, 21]);
  eq('S:obj', '对象名 usp_gamma → [30]', ids('usp_gamma'), [30]);
  check('S:null', 'impl_obj_names 为 null 的行（#52）不抛错且仍可按表名命中', J(ids('dim_delta')) === J([52]));
  check('S:null', 'impl_obj_names 非数组（字符串）视为空、不抛错', core.matchRow(R({ id: 1, table_name: 'a', impl_obj_names: 'oops' }), 'oops') === false);
  eq('S:id52', 'D-11：#52 → [52]', ids('#52'), [52]);
  eq('S:id52', 'D-11：52 → [52]', ids('52'), [52]);
  eq('S:id0052', 'D-11：0052 → []（不做数值归一）', ids('0052'), []);
  eq('S:id22', 'D-11：#22 → [22,21]（组展开）', ids('#22'), [22, 21]);
  eq('S:id5', 'D-11：#5 → []（只做全等，#5 不命中 #52）', ids('#5'), []);
  eq('S:ws', '去空白：  BETA   → [22,21]', ids('  BETA  '), [22, 21]);
  eq('S:ws', '空串 → 全部', ids(''), [10, 22, 21, 30, 41, 52, 60]);
  eq('S:ws', '纯空白 → 全部', ids('   '), [10, 22, 21, 30, 41, 52, 60]);
  eq('S:ws', 'null / undefined 查询 → 全部', [view(rows, { query: null }).totalGroups, view(rows, { query: undefined }).totalGroups], [6, 6]);
  eq('S:wild', '通配：% 只当字面量 → []', ids('%'), []);
  eq('S:wild', '通配：_ 只当字面量 → 所有含下划线的行（不含 #60）', ids('_'), [10, 22, 21, 30, 41, 52]);
  eq('S:fold', '只折 ASCII：小写查询命中大写字段 T_ORDER；中文原样', [ids('T_ORDER'), ids('t_order')], [[30], [30]]);
  eq('S:none', '无命中 → []', ids('不存在的词xyz'), []);
  // D-11：数字 / #数字 查询在 ID 全等之外仍保留子串匹配（表名含数字串）
  const numRows = [R({ id: 60, table_name: 'ods_alpha_df' }), R({ id: 7, table_name: 'dwd_w0060_df' }), R({ id: 52, table_name: 'dim_beta' }), R({ id: 8, table_name: 'ods_x52_df' })];
  const nids = (q) => view(numRows, { query: q }).orderedIds;
  eq('S:id60', 'D-11：60 → ID 全等 #60 + 表名含 60 的 #7（子串仍保留）', nids('60'), [60, 7]);
  eq('S:id0060', 'D-11：0060 → 只有表名含 0060 的 #7（不当作 #60）', nids('0060'), [7]);
  eq('S:id#60', 'D-11：#60 → [60]（表名不含 #60）', nids('#60'), [60]);
  eq('S:id52b', 'D-11：52 → ID 全等 #52 + 表名含 52 的 #8', nids('52'), [52, 8]);
  // C-4：只折 ASCII
  const uRows = [R({ id: 70, table_name: 'ÄRGER_tab' }), R({ id: 71, table_name: 'ΑΣΒ' }), R({ id: 72, table_name: 'Dim_Alpha' })];
  const uids = (q) => view(uRows, { query: q }).orderedIds;
  eq('S:fold', '只折 ASCII：ärger 不命中 ÄRGER_tab（后端 LIKE 同样不命中）', uids('ärger'), []);
  eq('S:fold', '只折 ASCII：ÄRGER 命中 #70', uids('ÄRGER'), [70]);
  eq('S:fold', '只折 ASCII：ΑΣ 命中 ΑΣΒ（toLowerCase 会把词尾 Σ 变成 ς 而丢命中）', uids('ΑΣ'), [71]);
  eq('S:fold', '只折 ASCII：ασ 不命中 ΑΣΒ（非 ASCII 不折叠）', uids('ασ'), []);
  eq('S:fold', '只折 ASCII：ALPHA 命中 Dim_Alpha（ASCII 照折）', uids('ALPHA'), [72]);
  // 与后端 LIKE（SQLite，ASCII 大小写不敏感）逐查询对拍
  late.push(new Promise((resolve) => {
    let sqlite3;
    try { sqlite3 = require('sqlite3'); } catch (e) { check('S:like', '加载 sqlite3 失败（前端与后端 LIKE 对拍需要它）', false, e.message); return resolve(); }
    const db = new sqlite3.Database(':memory:');
    const qs = ['ärger', 'ÄRGER', 'ΑΣ', 'ασ', 'Σ', 'σ', 'ς', 'alpha', 'ALPHA', 'dim'];
    db.serialize(() => {
      db.run('CREATE TABLE t (id INTEGER, name TEXT)');
      uRows.forEach(r => db.run('INSERT INTO t VALUES (?, ?)', [r.id, r.table_name]));
      let left = qs.length;
      qs.forEach((q) => db.all("SELECT id FROM t WHERE name LIKE '%' || ? || '%' ORDER BY id", [q], (err, rowsDb) => {
        if (err) check('S:like', 'sqlite 查询失败 ' + q, false, err.message);
        else check('S:like', '前端命中 = 后端 LIKE 命中："' + q + '"', J(uids(q).slice().sort((x, y) => x - y)) === J(rowsDb.map(r => r.id)), 'front=' + J(uids(q)) + ' sqlite=' + J(rowsDb.map(r => r.id)));
        if (--left === 0) db.close(() => resolve());
      }));
    });
  }));
  // 非 ODS 行的 source_system / source_table 各自单独可搜（后端 LIKE 命中它们；ODS 行靠上游名，不能证明字段表里有它们）
  const sRows = [R({ id: 80, layer: 'dwd', table_name: 'dwd_p_df', source_system: 'ERPX', source_table: 'TBLX' }), R({ id: 81, layer: 'dwd', table_name: 'dwd_q_df' })];
  eq('S:sys', '非 ODS 行：source_system 单独命中 erpx → [80]', view(sRows, { query: 'erpx' }).orderedIds, [80]);
  eq('S:srctbl', '非 ODS 行：source_table 单独命中 tblx → [80]', view(sRows, { query: 'tblx' }).orderedIds, [80]);
});

// ═════════ 六 排序：手写期望序列（不使用被测的 sortByField 生成期望）═════════
// 夹具 H：9 个组（#2 带伴生 #9；#10 落单）。期望按 STATUS_SORT_ORDER 原义（CREATED<DEVELOPING<REVIEWING<ONLINE<OFFLINE，未知状态与空值恒排末尾，
// 未知在空值之前）、日期按时间先后（'T' 与空格分隔符混用，字符串比较会错位）、字符串按 localeCompare（本夹具只用 ASCII 小写，避开 ICU 大小写 / 拼音细节）、
// 空值（null / undefined / ''）恒末尾、并列按输入序手推。伴生 #9 的各字段故意取与其主模型 #2 不同的值，按行排序会把它甩到别处。
const HR = (o) => R(Object.assign({ biz_owner: null, tech_owner: null, update_cycle: 'df', status: 'ONLINE', archived_task_count: 0, updated_at: null, table_comment: null }, o));
const SORT_H = [
  HR({ id: 1, layer: 'ods', table_name: 'b_tbl', tech_owner: 'owner_b', status: 'ONLINE', updated_at: '2026-03-01 10:00:00', archived_task_count: 2, table_comment: 'cm_2', biz_owner: 'biz_b', update_cycle: 'df' }),
  HR({ id: 2, layer: 'dim', table_name: 'a_tbl', tech_owner: 'owner_a', status: 'CREATED', updated_at: '2026-01-15 09:00:00', archived_task_count: 0, table_comment: 'cm_1', biz_owner: 'biz_a', update_cycle: 'di' }),
  HR({ id: 9, layer: 'dwd', table_name: 'zzz_comp', config_mode: 'companion', companion_of: 2, tech_owner: 'owner_z', status: 'OFFLINE', updated_at: '2030-01-01 00:00:00', archived_task_count: 99, table_comment: 'cm_9', biz_owner: 'biz_z', update_cycle: 'zz' }),
  HR({ id: 3, layer: 'dwd', table_name: 'c_tbl', tech_owner: '', status: 'REVIEWING', updated_at: null, archived_task_count: null, table_comment: null, biz_owner: null, update_cycle: 'df' }),
  HR({ id: 4, layer: 'ods', table_name: 'd_tbl', tech_owner: 'owner_c', status: 'OFFLINE', updated_at: '2025-12-31 23:59:59', archived_task_count: 5, table_comment: 'cm_2', biz_owner: 'biz_b', update_cycle: 'mf' }),
  HR({ id: 5, layer: 'dim', table_name: 'e_tbl', tech_owner: 'owner_b', status: 'WEIRD', updated_at: '2026-03-01 10:00:00', archived_task_count: 2, table_comment: '', biz_owner: 'biz_c', update_cycle: 'di' }),
  HR({ id: 6, layer: 'dwd', table_name: 'f_tbl', tech_owner: null, status: 'DEVELOPING', updated_at: '2026-02-10T08:00:00', archived_task_count: 10, table_comment: 'cm_3', biz_owner: '', update_cycle: 'df' }),
  HR({ id: 7, layer: 'ods', table_name: 'g_tbl', tech_owner: 'owner_a', status: null, updated_at: '2026-10-05 12:00:00', archived_task_count: 3, table_comment: 'cm_1', biz_owner: 'biz_a', update_cycle: 'mf' }),
  HR({ id: 8, layer: 'ods', table_name: 'h_tbl', tech_owner: 'owner_c', status: 'ONLINE', updated_at: '2026-02-10 09:00:00', archived_task_count: 0, table_comment: 'cm_4', biz_owner: 'biz_c', update_cycle: 'di' }),
  HR({ id: 10, layer: 'ods', table_name: 'i_orphan', config_mode: 'companion', companion_of: 99, tech_owner: 'owner_b', status: 'REVIEWING', updated_at: '2026-01-01 00:00:00', archived_task_count: 1, table_comment: 'cm_5', biz_owner: 'biz_a', update_cycle: 'df' }),
];
// 夹具值只用 ASCII 小写：中文拼音序 / 大小写的 ICU 细节不是本节要钉的契约，用 ASCII 避免把环境细节固化成期望。
const SORT_EXPECT = {
  // id：'number'（SORT_FIELD_TYPES）→ 按数值；伴生 #9 随其主模型 #2，落单 #10 按自己的 id 参与排序。
  id: { asc: [1, 2, 9, 3, 4, 5, 6, 7, 8, 10], desc: [10, 8, 7, 6, 5, 4, 3, 2, 9, 1] },
  // layer：'string'（localeCompare zh-Hans-CN，与页面原函数同口径）；夹具全为小写 ASCII：dim < dwd < ods；并列按输入序（升降序都是）。
  layer: { asc: [2, 9, 5, 3, 6, 1, 4, 7, 8, 10], desc: [1, 4, 7, 8, 10, 3, 6, 2, 9, 5] },
  // table_name：'string'；a_tbl … i_orphan 字母序；伴生 #9 的 zzz_comp 不参与（排序作用于主模型）。
  table_name: { asc: [2, 9, 1, 3, 4, 5, 6, 7, 8, 10], desc: [10, 8, 7, 6, 5, 4, 3, 1, 2, 9] },
  // table_comment：'string'；cm_1 < … < cm_5；null（#3）与 ''（#5）都是空值，恒排末尾（升降序都在末尾），空值之间并列按输入序 3,5。
  table_comment: { asc: [2, 9, 7, 1, 4, 6, 8, 10, 3, 5], desc: [10, 8, 6, 1, 4, 2, 9, 7, 3, 5] },
  // tech_owner：'string'；owner_a < owner_b < owner_c（ASCII，避开 ICU 拼音 / 大小写细节）；'' 与 null 是空值恒末尾，输入序 3,6。
  tech_owner: { asc: [2, 9, 7, 1, 5, 10, 4, 8, 3, 6], desc: [4, 8, 1, 5, 10, 2, 9, 7, 3, 6] },
  // biz_owner：'string'；biz_a < biz_b < biz_c；null（#3）与 ''（#6）恒末尾，输入序 3,6。
  biz_owner: { asc: [2, 9, 7, 10, 1, 4, 5, 8, 3, 6], desc: [5, 8, 1, 4, 2, 9, 7, 10, 3, 6] },
  // update_cycle：'string'；df < di < mf；本夹具无空值。
  update_cycle: { asc: [1, 3, 6, 10, 2, 9, 5, 8, 4, 7], desc: [4, 7, 2, 9, 5, 8, 1, 3, 6, 10] },
  // status：'statusOrder'（STATUS_SORT_ORDER：CREATED0 < DEVELOPING1 < REVIEWING2 < ONLINE3 < OFFLINE4）；未知状态 WEIRD（#5）恒在已知之后、不随升降序翻转；
  //   null（#7）是空值，排在未知之后（升降序都是 5 在 7 之前）。
  status: { asc: [2, 9, 6, 3, 10, 1, 8, 4, 5, 7], desc: [4, 1, 8, 3, 10, 6, 2, 9, 5, 7] },
  // archived_task_count：'number'；0 是有效值（只有 null / undefined / '' 算空值）；null（#3）恒末尾。
  archived_task_count: { asc: [2, 9, 8, 10, 1, 5, 7, 4, 6, 3], desc: [6, 4, 7, 1, 5, 10, 2, 9, 8, 3] },
  // updated_at：'date'（parseSqliteTs，'T' 与空格分隔符都按时间解析）；#1 与 #5 同刻并列按输入序；#6（T 分隔 08:00）早于 #8（空格分隔 09:00）；null（#3）恒末尾。
  updated_at: { asc: [4, 10, 2, 9, 6, 8, 1, 5, 7, 3], desc: [7, 1, 5, 8, 6, 2, 9, 10, 4, 3] },
};
section('六 排序手写期望', () => {
  eq('P:keys', '手写期望覆盖全部 10 个排序键', Object.keys(SORT_EXPECT).sort(), Object.keys(core.SORT_FIELD_TYPES).sort());
  eq('P:default', '默认序：主模型按输入顺序、伴生紧随其后、落单伴生在输入位置', view(SORT_H).orderedIds, [1, 2, 9, 3, 4, 5, 6, 7, 8, 10]);
  eq('P:setup', '夹具里只有 #10 是落单伴生', view(SORT_H).groups.filter(g => g.orphan).map(g => g.id), [10]);
  for (const key of Object.keys(SORT_EXPECT)) {
    for (const dir of ['asc', 'desc']) {
      eq('P:' + key + '.' + dir, '排序 ' + key + ' ' + dir + '（手写期望）', view(SORT_H, { sortBy: key, sortDir: dir }).orderedIds, SORT_EXPECT[key][dir]);
    }
  }
  // 日期并列（#1 与 #5 同刻）按输入序；'T' 与空格分隔符混用时按时间而非字符串
  eq('P:updated_at.tie', '日期分隔符：#6（2026-02-10T08:00）早于 #8（2026-02-10 09:00），字符串比较会得到相反结果', [SORT_EXPECT.updated_at.asc.indexOf(6) < SORT_EXPECT.updated_at.asc.indexOf(8), view(SORT_H, { sortBy: 'updated_at', sortDir: 'asc' }).orderedIds.indexOf(6) < view(SORT_H, { sortBy: 'updated_at', sortDir: 'asc' }).orderedIds.indexOf(8)], [true, true]);
});
// ST 显式稳定次序：把核心放进一个「并列时反序」的不稳定排序引擎（选择排序，并列取后者）里，结果仍须按输入序
section('六b 显式稳定次序', () => {
  const coreSrc = fs.readFileSync(CORE_FILE, 'utf8').replace(/\r\n/g, '\n');
  const kitSrc = fs.readFileSync(KIT_FILE, 'utf8').replace(/\r\n/g, '\n');
  const ctx = vm.createContext({});
  vm.runInContext('var window = this;', ctx);
  vm.runInContext('Array.prototype.sort = function (cmp) { var a = this, n = a.length; for (var i = 0; i < n; i++) { var m = i; for (var j = i + 1; j < n; j++) { if (cmp(a[j], a[m]) <= 0) m = j; } var t = a[i]; a[i] = a[m]; a[m] = t; } return a; };', ctx);
  vm.runInContext(kitSrc, ctx);
  vm.runInContext(coreSrc, ctx);
  const uc = vm.runInContext('window.ModelCatalogCore', ctx);
  const probe = vm.runInContext('[3, 1, 2].sort(function (a, b) { return 0; }).join()', ctx);
  check('ST1', '前提：上下文里的排序引擎对并列确实不稳定（[3,1,2] 全并列被反序）', probe !== '3,1,2', probe);
  const ties = HR_TIES();
  for (const [key, dir] of [['layer', 'asc'], ['layer', 'desc'], ['update_cycle', 'asc'], ['status', 'desc'], ['archived_task_count', 'asc']]) {
    const got = uc.computeView(ties, { query: '', filters: {}, sortBy: key, sortDir: dir, page: 1, pageSize: 20 }).orderedIds;
    const want = core.computeView(ties, { query: '', filters: {}, sortBy: key, sortDir: dir, page: 1, pageSize: 20 }).orderedIds;
    eq('ST1', '不稳定排序引擎下 ' + key + ' ' + dir + ' 仍与稳定引擎结果一致（并列按输入序）', got, want);
  }
  function HR_TIES() { return Array.from({ length: 9 }, (_, i) => R({ id: 200 + i, table_name: 't' + i, layer: i % 2 ? 'ods' : 'dim', update_cycle: 'df', status: 'ONLINE', archived_task_count: 1 })); }
  eq('ST1', '并列全相同的 update_cycle asc：输入序', uc.computeView(HR_TIES(), { query: '', filters: {}, sortBy: 'update_cycle', sortDir: 'asc', page: 1, pageSize: 20 }).orderedIds, [200, 201, 202, 203, 204, 205, 206, 207, 208]);
});

// ═════════ 七 搬入件逐字 ═════════
section('七 搬入件逐字', () => {
  // 正则字面量：acorn 的 regexp token 的 value 是 {pattern, flags, value} 对象，不能 String() 化，按 pattern + flags 比较
  const tokValue = (t) => (t.type.label === 'regexp' ? '/' + t.value.pattern + '/' + t.value.flags : (t.value === undefined ? '' : String(t.value)));
  const tokensOf = (src, node) => Array.from(acorn.tokenizer(src.slice(node.start, node.end), { ecmaVersion: 2022 })).map(t => t.type.label + '\u0001' + tokValue(t));
  const declsOf = (src, name) => {
    const ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script' });
    const found = [];
    (function walk(n) {
      if (!n || typeof n.type !== 'string') return;
      if (n.type === 'FunctionDeclaration' && n.id && n.id.name === name) found.push(n);
      if (n.type === 'VariableDeclaration' && n.declarations.some(d => d.id && d.id.name === name)) found.push(n);
      for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
    })(ast);
    return found;
  };
  const coreSrc = fs.readFileSync(CORE_FILE, 'utf8').replace(/\r\n/g, '\n');
  // 对照冻结值 FROZEN_TOKENS（来源见常量注释），不依赖 git
  const crypto = require('crypto');
  for (const name of Object.keys(FROZEN_TOKENS)) {
    const a = declsOf(coreSrc, name);
    check(`V:${name}`, `${name}：核心里恰 1 个声明`, a.length === 1, `core=${a.length}`);
    if (a.length !== 1) continue;
    const ta = tokensOf(coreSrc, a[0]);
    const sha = crypto.createHash('sha256').update(ta.join('\u0002')).digest('hex');
    const fz = FROZEN_TOKENS[name];
    check(`V:${name}`, `${name}：token 数量与 sha256 等于冻结值（${fz.n} 个 token，${fz.sha256.slice(0, 12)}…）`, ta.length === fz.n && sha === fz.sha256, `实得 ${ta.length} 个 / ${sha.slice(0, 12)}…`);
  }
});

// ═════════ 九 接线（静态）═════════
section('九 接线静态', () => {
  const html = fs.readFileSync(PAGE_FILE, 'utf8').replace(/\r\n/g, '\n');
  const cat = fs.readFileSync(CAT_FILE, 'utf8').replace(/\r\n/g, '\n');
  const coreSrc = fs.readFileSync(CORE_FILE, 'utf8').replace(/\r\n/g, '\n');
  // 版本握手：页面核心标签的 ?v= 后缀 = _<核心源码里的 CORE_VERSION>（不写死）
  const ver = /var CORE_VERSION = '([^']+)'/.exec(coreSrc);
  check('W:ver', '能从核心源码读出 CORE_VERSION', !!ver);
  const tags = []; { const re = /<!--[\s\S]*?-->|<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m; while ((m = re.exec(html))) { if (m[0].startsWith('<!--')) continue; const sm = /\ssrc\s*=\s*"([^"]*)"/.exec(m[1] || ''); if (sm) tags.push(sm[1]); } }
  const coreTags = tags.filter(t => /model-catalog-core\.js/.test(t));
  check('W:ver', '目录页恰有 1 个核心 <script src>', coreTags.length === 1, J(coreTags));
  if (ver && coreTags.length === 1) {
    const q = /\?v=([^"&#]+)/.exec(coreTags[0]);
    check('W:ver', '核心标签的 ?v= 以 _' + ver[1] + ' 结尾（口径同 model-script-gen 单源守卫；与 CORE_VERSION 一致，不写死）', !!q && q[1].endsWith('_' + ver[1]), coreTags[0]);
  }
  // 代码文本（剥注释）与函数体
  const comments = []; const ast = acorn.parse(cat, { ecmaVersion: 2022, sourceType: 'script', onComment: comments });
  let code = cat; for (const c of comments.slice().reverse()) code = code.slice(0, c.start) + ' '.repeat(c.end - c.start) + code.slice(c.end);
  const decls = (name) => { const r = []; (function walk(n) { if (!n || typeof n.type !== 'string') return; if (n.type === 'FunctionDeclaration' && n.id && n.id.name === name) r.push(n); if (n.type === 'VariableDeclaration' && n.declarations.some(d => d.id && d.id.name === name)) r.push(n); for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); } })(ast); return r; };
  for (const name of ['sortByField', 'parseSqliteTs', 'SORT_FIELD_TYPES', 'STATUS_SORT_ORDER']) check('W:decl', 'model-catalog.js 不再声明 ' + name + '（已搬进核心）', decls(name).length === 0);
  const bodyOf = (name) => { const d = decls(name); return d.length === 1 ? code.slice(d[0].start, d[0].end) : null; };
  const viaCore = (b) => /ModelCatalogCore\./.test(b) || /catalogViewRaw\(/.test(b);
  for (const name of ['renderModelsPage', 'goToPage', 'highlightModel', 'getSortedModels', 'getCatalogView', 'loadModels']) {
    const b = bodyOf(name);
    check('W:core-calls', name + ' 恰有 1 个声明且函数体经 ModelCatalogCore 计算（直接调用或经 catalogViewRaw）', b !== null && viaCore(b));
  }
  { const b = bodyOf('catalogViewRaw'); check('W:core-calls', 'catalogViewRaw 的函数体调用 ModelCatalogCore.computeView', b !== null && /ModelCatalogCore\.computeView\(/.test(b)); }
  // C4c-2 收紧：renderModelsPage 自己会调 ModelCatalogCore.acceptanceView / firstSentence，「函数体出现 ModelCatalogCore.」不再能证明视图经核心计算——改为：视图只来自参数或 catalogViewRaw()
  { const b = bodyOf('renderModelsPage');
    check('W:core-calls', 'renderModelsPage：视图只来自参数或 catalogViewRaw()——函数体恰一处 catalogViewRaw(，形如 view = view || catalogViewRaw()', b !== null && (b.match(/\bcatalogViewRaw\(/g) || []).length === 1 && /\bview\s*=\s*view\s*\|\|\s*catalogViewRaw\(\)/.test(b));
    check('W:core-calls', 'renderModelsPage：函数体不直接读 allModelsData 的 slice / length / filter / map / forEach / reduce / find（不绕过核心自己切页）', b !== null && !/\ballModelsData\b/.test(b)); }
  { const b = bodyOf('loadModels'); check('W:keyword', 'loadModels 函数体不含 keyword（搜索在前端，请求不带搜索词）', b !== null && !/keyword/i.test(b)); }
  { const d = decls('pageSize'); const ok = d.length === 1 && d[0].declarations[0].init && d[0].declarations[0].init.type === 'Literal' && d[0].declarations[0].init.value === 20; check('W:pagesize', '顶层 pageSize 的声明是字面量 20（每页组数）', ok); }
  // 按行算页：model-catalog.js 代码（剥注释）里任何地方都不得出现 .length / pageSize 一类写法
  { const hits = code.match(/\.length\s*\/\s*(pageSize|PAGE_SIZE|ModelCatalogCore\.PAGE_SIZE|20)\b/g) || []; check('W:rowpage', 'model-catalog.js 代码里不出现 .length / (pageSize | PAGE_SIZE | ModelCatalogCore.PAGE_SIZE | 20) 的按行算页写法', hits.length === 0, J(hits)); }
  // ---- C4c-2 静态判据（剥注释后的代码 / AST）----
  const nodesOf = (pred) => { const r = []; (function walk(n) { if (!n || typeof n.type !== 'string') return; if (pred(n)) r.push(n); for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); } })(ast); return r; };
  const topFnOf = (pos) => { const f = ast.body.find(n => n.type === 'FunctionDeclaration' && n.start <= pos && pos < n.end); return f ? f.id.name : '(顶层)'; };
  const memberName = (m) => (m && m.type === 'MemberExpression' ? (m.computed ? (m.property.type === 'Literal' ? String(m.property.value) : null) : m.property.name) : null);
  { // innerHTML / outerHTML 赋值与 insertAdjacentHTML 调用只出现在 renderPagination（数字与固定文案）与 showDesignNotesPopover（唯一入参是已转义的文本，见 W:escape）
    const hits = nodesOf(n => (n.type === 'AssignmentExpression' && ['innerHTML', 'outerHTML'].includes(memberName(n.left))) || (n.type === 'CallExpression' && memberName(n.callee) === 'insertAdjacentHTML')).map(n => topFnOf(n.start));
    const bad = hits.filter(f => f !== 'renderPagination' && f !== 'showDesignNotesPopover');
    check('W:innerhtml', 'CAT 代码里 innerHTML / outerHTML 赋值与 insertAdjacentHTML 调用只出现在 renderPagination 与 showDesignNotesPopover（越界位置：' + J(bad) + '）', bad.length === 0);
    check('W:innerhtml', '允许清单没有空转：renderPagination 与 showDesignNotesPopover 里确有 innerHTML 赋值', hits.includes('renderPagination') && hits.includes('showDesignNotesPopover'), J(hits)); }
  { // escapeHtml( 恰一处：设计说明分发（catalogDispatchNotes）里 showDesignNotesPopover 的第 2 实参；气泡用 innerHTML，原文进不去
    const esc = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'escapeHtml');
    const shows = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'showDesignNotesPopover');
    check('W:escape', 'CAT 代码里 escapeHtml( 恰出现 1 次（列表区其余位置数据只经 textContent / el.title）', esc.length === 1, 'n=' + esc.length);
    check('W:escape', '唯一的 escapeHtml( 位于 catalogDispatchNotes，且是 showDesignNotesPopover 调用的第 2 实参', esc.length === 1 && topFnOf(esc[0].start) === 'catalogDispatchNotes' && shows.some(c => c.arguments[1] === esc[0]));
    check('W:escape', 'showDesignNotesPopover 的每个调用点的第 2 实参都是 escapeHtml(...) 调用（至少 1 个调用点）', shows.length >= 1 && shows.every(c => c.arguments[1] && c.arguments[1].type === 'CallExpression' && c.arguments[1].callee.type === 'Identifier' && c.arguments[1].callee.name === 'escapeHtml'), 'n=' + shows.length); }
  { // 内联事件属性：除 renderPagination（5 处 onclick="goToPage(…)"，只插数字）外不出现 onclick=；全文不出现 setAttribute('on…') 与 on* 属性赋值
    const rp = decls('renderPagination');
    const outside = rp.length === 1 ? code.slice(0, rp[0].start) + ' '.repeat(rp[0].end - rp[0].start) + code.slice(rp[0].end) : code;
    check('W:onclick', 'renderPagination 恰有 1 个声明；除它之外 CAT 代码里不出现 onclick=（含字符串 / 模板里的内联属性写法与 el.onclick = 赋值）', rp.length === 1 && !/onclick\s*=/i.test(outside));
    check('W:onclick', '全文不出现 setAttribute(\'on…\') / setAttribute("on…")', !/setAttribute\s*\(\s*['"`]\s*on/i.test(code));
    const onAssign = nodesOf(n => n.type === 'AssignmentExpression' && /^on[a-z]+$/.test(memberName(n.left) || '')).map(n => memberName(n.left));
    check('W:onclick', '全文不出现 el.on<事件> = … 属性赋值', onAssign.length === 0, J(onAssign)); }
  { const b = bodyOf('renderModelsPage');
    check('W:perm', 'renderModelsPage 函数体里 userCanEditModel(m) / userCanValidateModel(m) 各恰一次（权限只在这里每行算一次，结果传给构建函数）', b !== null && (b.match(/\buserCanEditModel\(m\)/g) || []).length === 1 && (b.match(/\buserCanValidateModel\(m\)/g) || []).length === 1); }
  // 2c：renderModelsPage 的调用点只能是 0 个参数，或参数恰为 catalogViewRaw() 的调用结果（不得传手拼视图）；MC 内联脚本的调用点在下面 inl 块里同口径检查
  const okRenderCall = (c) => c.arguments.length === 0 || (c.arguments.length === 1 && c.arguments[0].type === 'CallExpression' && c.arguments[0].callee.type === 'Identifier' && c.arguments[0].callee.name === 'catalogViewRaw' && c.arguments[0].arguments.length === 0);
  { const calls = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'renderModelsPage');
    check('W:render-args', 'CAT：renderModelsPage 的每个调用点都是 0 个参数，或参数恰为 catalogViewRaw() 的结果（至少 1 个调用点；实得 ' + calls.length + ' 个）', calls.length >= 1 && calls.every(okRenderCall)); }
  { // renderPagination 的 innerHTML 来源：模板插值只能是数值类表达式（页码 / 总数 / 起止序号）或在两个常量间选择；+= 与 innerHTML 的右侧只能是模板 / 字面量 / paginationHTML。
    // 威胁模型：防诚实实现把搜索词 / 表名之类文本插进 innerHTML 模板；不防「把数值名字的变量改成赋文本」这种故意绕开
    const rp = decls('renderPagination');
    const inRp = (n) => rp.length === 1 && n.start >= rp[0].start && n.end <= rp[0].end;
    const NUM_NAMES = new Set(['currentPage', 'totalPages', 'totalCount', 'startNum', 'endNum', 'startPage', 'endPage', 'i']);
    const isConst = (e) => e.type === 'Literal' && (typeof e.value === 'string' || typeof e.value === 'number');
    const okNum = (e) => {
      if (isConst(e)) return true;
      if (e.type === 'Identifier') return NUM_NAMES.has(e.name);
      if (e.type === 'MemberExpression') return !e.computed && e.object.type === 'Identifier' && e.object.name === 'view' && ['totalGroups', 'totalModels', 'totalPages'].includes(e.property.name);
      if (e.type === 'BinaryExpression') return ['+', '-', '*', '/'].includes(e.operator) && okNum(e.left) && okNum(e.right);
      if (e.type === 'ConditionalExpression') return isConst(e.consequent) && isConst(e.alternate);
      return false;
    };
    const tpls = nodesOf(n => n.type === 'TemplateLiteral' && inRp(n));
    const exprs = tpls.reduce((a, t) => a.concat(t.expressions), []);
    const badExprs = exprs.filter(e => !okNum(e)).map(e => cat.slice(e.start, e.end));
    check('W:innerhtml', 'renderPagination 的每个模板插值都是数值类表达式（页码 / 总数 / 起止序号）或两个常量间的选择（共 ' + exprs.length + ' 个插值；越界：' + J(badExprs) + '）', rp.length === 1 && exprs.length > 0 && badExprs.length === 0);
    const asg = nodesOf(n => n.type === 'AssignmentExpression' && inRp(n));
    const badAsg = asg.filter(a => {
      if (['innerHTML', 'outerHTML'].includes(memberName(a.left))) return !(a.right.type === 'TemplateLiteral' || a.right.type === 'Literal' || (a.right.type === 'Identifier' && a.right.name === 'paginationHTML'));
      if (a.left.type === 'Identifier' && a.left.name === 'paginationHTML') return !((a.operator === '=' && a.right.type === 'Literal') || (a.operator === '+=' && a.right.type === 'TemplateLiteral'));
      return false;
    }).map(a => cat.slice(a.start, a.end).slice(0, 60));
    check('W:innerhtml', 'renderPagination：innerHTML 的右侧只能是模板 / 字面量 / paginationHTML，paginationHTML 只能被字面量赋值或用模板串 +=（越界：' + J(badAsg) + '）', rp.length === 1 && badAsg.length === 0); }
  { // 契约 14：菜单 / 分发 / 渲染同步，不经 rAF / setTimeout / microtask / await
    const ASYNC = /\b(setTimeout|setInterval|requestAnimationFrame|queueMicrotask|await|Promise)\b|\.then\(/;
    for (const name of ['renderModelsPage', 'catalogEl', 'catalogActionSpecs', 'catalogMenuItem', 'catalogBuildMenu', 'catalogBuildActions', 'catalogBuildAcceptance', 'catalogAcceptanceViewOf', 'catalogBuildStatusBadge', 'catalogBuildEntry', 'catalogOpenMenus', 'catalogTriggerOf', 'catalogSetMenu', 'catalogCloseMenus', 'catalogToggleMenu', 'catalogSelectEntry', 'catalogDispatchAct', 'catalogDispatchNotes', 'catalogBindList',
      // C4c-3 3a：展开区的渲染路径与点击处理（异步的只有 catalogRequestRelations / catalogFetchRelations 两个请求函数，不在清单里）
      'catalogIsObj', 'catalogText', 'catalogValidRelations', 'catalogExpandedOnPage', 'catalogBuildExpandToggle', 'catalogModelLink', 'catalogRowByTableName', 'catalogFlowCol', 'catalogBuildUpstream', 'catalogBuildDownstream', 'catalogBuildImplBadge',
      'catalogBuildObjectTable', 'catalogBuildObjectBox', 'catalogBuildPane', 'catalogMakePane', 'catalogEntryEl', 'catalogApplyPane', 'catalogRunEffects', 'catalogToggleExpand', 'catalogRetryExpand', 'catalogCollapseAll', 'catalogOpenModel',
      // C4c-3 3b：列表失败路径 / 状态同步 / 重试 / 上游名归一化（都是同步函数；loadModels 本身是 async，不在清单里）
      'catalogFailList', 'catalogSyncListState', 'catalogRetryList', 'catalogAsciiLower',
      // C4c-4 4a：页头在册数 / 筛选单一来源写回
      'catalogUpdateTotal', 'catalogAdoptFilters',
      // C4c-4 4b：左栏（渲染 / 点击 / 清除 / 绑定都是同步函数）
      'catalogRailValue', 'catalogRailSame', 'catalogRailActiveCount', 'catalogStatusText', 'catalogRailItem', 'catalogRailList', 'catalogRailSection', 'catalogRenderRail', 'catalogRefreshRail', 'catalogRailPick', 'catalogRailClear', 'catalogToggleRail', 'catalogOnFocusIn', 'catalogBindRail',
      // C4c-4 4c：未归属对象（渲染 / 模式切换 / 点击委托 / 校验 / 表格构建 / 徽章格都是同步函数；catalogLoadUnowned 本身是 async，不在清单里）
      'catalogUnownedCountText', 'catalogValidUnowned', 'catalogOrDash', 'catalogBuildUnownedTable', 'catalogRenderUnowned', 'catalogSetUnownedMode', 'catalogToggleUnowned', 'catalogLeaveUnowned', 'catalogRetryUnowned', 'catalogBindUnowned', 'catalogObjBadgeKids',
      // C4c-4 4d：P36 路径上被改的 applyCatalogSearch（读 catalogRenderedQuery）/ focusCatalogModel（退出未归属模式），以及左栏按键就地更新的三个函数（预筛 LOW-8）
      'applyCatalogSearch', 'focusCatalogModel', 'catalogRailKey', 'catalogRailPatch', 'catalogRailReconcile']) {
      const b = bodyOf(name);
      check('W:sync', name + '：恰有 1 个声明，函数体没有 setTimeout / requestAnimationFrame / queueMicrotask / await / Promise / .then（契约 14：同步）', b !== null && !ASYNC.test(b));
    }
    const docL = nodesOf(n => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression' && memberName(n.expression.callee) === 'addEventListener' && n.expression.callee.object.type === 'Identifier' && n.expression.callee.object.name === 'document' && n.expression.arguments[0] && n.expression.arguments[0].type === 'Literal' && ['click', 'keydown'].includes(n.expression.arguments[0].value));
    check('W:sync', 'document 级监听恰两条（click 一条、capture 阶段 keydown 一条），回调体同步', docL.length === 2 && docL.every(n => !ASYNC.test(code.slice(n.start, n.end))), 'n=' + docL.length);
    const kd = docL.find(n => n.expression.arguments[0].value === 'keydown');
    check('W:sync', 'keydown 监听在 capture 阶段注册（第 3 实参为 true；Esc 关菜单时抽屉的 Esc 不同时触发）', !!kd && kd.expression.arguments[2] && kd.expression.arguments[2].type === 'Literal' && kd.expression.arguments[2].value === true); }
  // ---- C4c-3 3a：展开区静态判据（威胁模型：防诚实实现写错——不核令牌、自己改事件态、渲染不取交集、委托接错函数；不防故意绕开，例如把 catalogEventState 先赋给别名再写）----
  { const ft = bodyOf('catalogFetchRelations'), rq = bodyOf('catalogRequestRelations');
    check('W:expand-token', 'catalogFetchRelations：函数体恰一处 ModelCatalogCore.relationsArrived(，位于 await 之后；参数对象里的令牌取自本函数形参（token: token），不读事件态里的当前令牌（expandTokens）', ft !== null && (ft.match(/ModelCatalogCore\.relationsArrived\(/g) || []).length === 1 && ft.indexOf('await') >= 0 && ft.indexOf('await') < ft.indexOf('relationsArrived(') && /\btoken:\s*token\b/.test(ft) && !/expandTokens/.test(ft));
    check('W:expand-token', 'catalogRequestRelations（只发请求 / 解析 / 校验形状）不调用 relationsArrived，也不读事件态', rq !== null && !/relationsArrived/.test(rq) && !/catalogEventState/.test(rq)); }
  { const callsIn = (name) => nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && memberName(n.callee) === name && n.callee.object.type === 'Identifier' && n.callee.object.name === 'ModelCatalogCore').map(n => topFnOf(n.start)).sort();
    const got = { toggleExpand: callsIn('toggleExpand'), retryExpand: callsIn('retryExpand'), relationsArrived: callsIn('relationsArrived') };
    check('W:expand-state', 'ModelCatalogCore.toggleExpand 只在 catalogCollapseAll / catalogToggleExpand 里调用，retryExpand 只在 catalogRetryExpand，relationsArrived 只在 catalogFetchRelations（展开状态的所有权在核心）', J(got) === J({ toggleExpand: ['catalogCollapseAll', 'catalogToggleExpand'], retryExpand: ['catalogRetryExpand'], relationsArrived: ['catalogFetchRelations'] }), J(got));
    // 事件态写入：以 catalogEventState 为根、途经 expanded / expandTokens / expandStatus / relations 的赋值 / ++ / delete / 会改数组的方法调用
    const FIELDS = ['expanded', 'expandTokens', 'expandStatus', 'relations'];
    const MUTATORS = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'];
    const hit = (m) => { let cur = m; const props = []; while (cur && cur.type === 'MemberExpression') { const p = memberName(cur); if (p !== null) props.push(p); cur = cur.object; } return !!cur && cur.type === 'Identifier' && cur.name === 'catalogEventState' && props.some(p => FIELDS.includes(p)); };
    const writes = nodesOf(n => (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && hit(n.left))
      || (n.type === 'UpdateExpression' && n.argument.type === 'MemberExpression' && hit(n.argument))
      || (n.type === 'UnaryExpression' && n.operator === 'delete' && n.argument.type === 'MemberExpression' && hit(n.argument))
      || (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && MUTATORS.includes(memberName(n.callee)) && n.callee.object.type === 'MemberExpression' && hit(n.callee.object))).map(n => topFnOf(n.start));
    check('W:expand-state', 'CAT 不直接写事件态里的 expanded / expandTokens / expandStatus / relations（赋值 / delete / push 类方法一律经核心事件函数，按不可变对待）（越界位置：' + J(writes) + '）', writes.length === 0);
    // 3d（codex 40Tc-M2）：成员写入之外，整体替换 catalogEventState 也要拦——{ ...catalogEventState, relations: {} } 这类「不可变更新」写法不经过成员赋值，上面的判据看不见。
    //   白名单（现有接线的全部合法写法）：右值是 ① 核心事件结果的 `<标识符>.state`（r.state / started.state / arrived.state）② 由核心事件逐步累积的局部变量（Identifier，例：catalogCollapseAll 里的 s）③ ModelCatalogCore.createState()。
    //   对象字面量（ObjectExpression，含展开写法）、条件 / 逻辑表达式、其他调用一律不在白名单。
    const wholeAssign = nodesOf(n => n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === 'catalogEventState');
    const okRhs = (r) => (r.type === 'MemberExpression' && !r.computed && r.property.type === 'Identifier' && r.property.name === 'state' && r.object.type === 'Identifier')
      || r.type === 'Identifier'
      || (r.type === 'CallExpression' && r.callee.type === 'MemberExpression' && memberName(r.callee) === 'createState' && r.callee.object.type === 'Identifier' && r.callee.object.name === 'ModelCatalogCore');
    const badWhole = wholeAssign.filter(n => !okRhs(n.right)).map(n => topFnOf(n.start));
    check('W:expand-state', 'CAT 对 catalogEventState 的整体赋值，右值只能是核心事件结果的 <标识符>.state、局部变量（由核心事件累积）、ModelCatalogCore.createState()；对象字面量（含 { ...catalogEventState, … } 展开写法）等一律不行（共 ' + wholeAssign.length + ' 处整体赋值；越界位置：' + J(badWhole) + '）', wholeAssign.length > 0 && badWhole.length === 0);
    const assignInPlace = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && memberName(n.callee) === 'assign' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'Object' && n.arguments.length > 0 && n.arguments[0].type === 'Identifier' && n.arguments[0].name === 'catalogEventState').map(n => topFnOf(n.start));
    check('W:expand-state', 'CAT 不用 Object.assign(catalogEventState, …) 原地改事件态（Object.assign({}, catalogEventState, …) 复制一份是允许的，第一个实参不是事件态）（越界位置：' + J(assignInPlace) + '）', assignInPlace.length === 0);
    const rel = nodesOf(n => n.type === 'MemberExpression' && n.computed && n.object.type === 'MemberExpression' && memberName(n.object) === 'relations').map(n => topFnOf(n.start));
    check('W:expand-data', '关系数据（… .relations[…]）在 CAT 里只读一处，且位于 catalogMakePane', J(rel) === J(['catalogMakePane']), J(rel)); }
  { const rb = bodyOf('renderModelsPage'), ex = bodyOf('catalogExpandedOnPage');
    check('W:expand-page', 'renderModelsPage：展开集合来自 catalogExpandedOnPage(view)（展开集合 ∩ 当前页 pageIds）恰一处，面板只给它返回的 id 建（expandedHere 循环），函数体不直接读 catalogEventState', rb !== null && (rb.match(/\bcatalogExpandedOnPage\(view\)/g) || []).length === 1 && /expandedHere\.forEach\(key => entryEls\.get\(key\)\.appendChild\(catalogMakePane\(key\)\)\)/.test(rb) && !/catalogEventState/.test(rb));
    check('W:expand-page', 'catalogExpandedOnPage：用 view.pageIds 对展开集合取交集（filter）', ex !== null && /view\.pageIds/.test(ex) && /\.filter\(/.test(ex)); }
  { const bl = bodyOf('catalogBindList');
    const once = (re) => bl !== null && (bl.match(re) || []).length === 1;
    check('W:expand-delegate', 'catalogBindList：展开按钮（[data-expand-toggle]）→ catalogToggleExpand、面板重试（[data-pane-act]）→ catalogRetryExpand、面板模型链接（[data-open-model]）→ catalogOpenModel，各恰一处且接对函数', once(/\[data-expand-toggle\][\s\S]{0,200}?catalogToggleExpand\(/g) && once(/\[data-pane-act\][\s\S]{0,260}?catalogRetryExpand\(/g) && once(/\[data-open-model\][\s\S]{0,200}?catalogOpenModel\(/g) && once(/catalogToggleExpand\(/g) && once(/catalogRetryExpand\(/g) && once(/catalogOpenModel\(/g)); }
  // C4c-4 4a：筛选单一来源 catalogFilters（页面层不得再有第二份筛选状态）。威胁模型：防诚实实现写错（某处 filters 又写回 {}、第二处写 catalogFilters、focus 忘了写回），不防别名绕开。
  { const props = nodesOf(n => n.type === 'Property' && !n.computed && ((n.key.type === 'Identifier' && n.key.name === 'filters') || (n.key.type === 'Literal' && n.key.value === 'filters')));
    const bad = props.filter(p => !(p.value.type === 'Identifier' && p.value.name === 'catalogFilters')).map(p => topFnOf(p.start));
    check('W:filters', 'CAT 代码里每个 filters: 属性的值都是标识符 catalogFilters，且至少 3 处（catalogSyncState / catalogViewRaw / getSortedModels；实得 ' + props.length + ' 处；越界位置：' + J(bad) + '）', props.length >= 3 && bad.length === 0);
    const asg = nodesOf(n => n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === 'catalogFilters').map(n => topFnOf(n.start));
    check('W:filters', 'catalogFilters 只在 catalogAdoptFilters 里被赋值，恰 1 处（实得：' + J(asg) + '）', asg.length === 1 && asg[0] === 'catalogAdoptFilters');
    const dc = decls('catalogFilters');
    check('W:filters', 'catalogFilters 恰 1 个顶层声明，初值为空对象字面量', dc.length === 1 && dc[0].declarations[0].init && dc[0].declarations[0].init.type === 'ObjectExpression' && dc[0].declarations[0].init.properties.length === 0);
    const ad = bodyOf('catalogAdoptFilters');
    check('W:filters', 'catalogAdoptFilters 把核心返回状态的 filters 复制一份写回（catalogFilters = Object.assign({}, state.filters)，不共享引用）', ad !== null && /catalogFilters\s*=\s*Object\.assign\(\{\},\s*state\.filters\)/.test(ad));
    const fb = bodyOf('focusCatalogModel');
    check('W:filters', 'focusCatalogModel 把核心 focus 结果的 state 交给 catalogAdoptFilters 写回（恰 1 次，且在 catalogEventState = r.state 之后）', fb !== null && (fb.match(/catalogAdoptFilters\(r\.state\)/g) || []).length === 1 && fb.indexOf('catalogEventState = r.state') >= 0 && fb.indexOf('catalogEventState = r.state') < fb.indexOf('catalogAdoptFilters(r.state)'));
    // 4d（预筛 MED-1）：只拦整体赋值不够——成员写入（catalogFilters[key] = v / delete catalogFilters.x / catalogFilters.n++）和 Object.assign(catalogFilters, …) 同样绕过「只有 catalogAdoptFilters 写它」。
    //   照 W:expand-state 对 catalogEventState 的两条判据（codex 40Tc-M2 先例）补两条；另补 catalogAdoptFilters 的实参来源判据。威胁模型：防诚实实现写错（新入口写成 catalogFilters[key] = next; renderModelsPage();），不防别名。
    const rootIsFilters = (m) => { let cur = m; while (cur && cur.type === 'MemberExpression') cur = cur.object; return !!cur && cur.type === 'Identifier' && cur.name === 'catalogFilters'; };
    const FMUT = ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'];
    const fw = nodesOf(n => (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && rootIsFilters(n.left))
      || (n.type === 'UpdateExpression' && n.argument.type === 'MemberExpression' && rootIsFilters(n.argument))
      || (n.type === 'UnaryExpression' && n.operator === 'delete' && n.argument.type === 'MemberExpression' && rootIsFilters(n.argument))
      || (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && FMUT.includes(memberName(n.callee)) && n.callee.object.type === 'MemberExpression' && rootIsFilters(n.callee.object))).map(n => topFnOf(n.start));
    check('W:filters', 'CAT 不对 catalogFilters 做成员写入（catalogFilters[key] = v / catalogFilters.x = v / delete / ++ / push 类方法）——筛选只经 catalogAdoptFilters 整体复制写回（越界位置：' + J(fw) + '）', fw.length === 0);
    const fa = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && memberName(n.callee) === 'assign' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'Object' && n.arguments.length > 0 && n.arguments[0].type === 'Identifier' && n.arguments[0].name === 'catalogFilters').map(n => topFnOf(n.start));
    check('W:filters', 'CAT 不用 Object.assign(catalogFilters, …) 原地改筛选（Object.assign({}, state.filters) 复制一份是允许的，第一个实参不是 catalogFilters）（越界位置：' + J(fa) + '）', fa.length === 0);
    // catalogAdoptFilters( 的实参必须是本函数内 ModelCatalogCore.setFilter(…) 的返回值：r.state（r 由 setFilter 返回）或由 setFilter(…).state 累积的变量（种子只能是 catalogSyncState()）
    // 41Td-M1：「结果对象」（setFilter(…) 的返回值，形如 { state, effects }）与「状态」（setFilter(…).state）分开检查——旧判据把两者混在一个 isSF 里：
    //   采用 r.state 时 r 若是 setFilter(…).state（已经是状态，再取 .state 得 undefined）、累积变量漏写 .state（acc 成了结果对象）都能过。
    const isSFcall = (e) => !!e && e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && memberName(e.callee) === 'setFilter' && e.callee.object.type === 'Identifier' && e.callee.object.name === 'ModelCatalogCore';
    const isSFstate = (e) => !!e && e.type === 'MemberExpression' && !e.computed && e.property.type === 'Identifier' && e.property.name === 'state' && isSFcall(e.object);   // 恰好一层 .state，且对象是 setFilter(…) 调用本身
    const isSeed = (e) => !!e && e.type === 'CallExpression' && e.callee.type === 'Identifier' && e.callee.name === 'catalogSyncState';
    const adoptFromSetFilter = (fnName) => {
      const fns = decls(fnName); if (fns.length !== 1) return 'no-decl';
      const f = fns[0]; const inF = (n) => n.start >= f.start && n.end <= f.end;
      const calls = nodesOf(n => inF(n) && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'catalogAdoptFilters');
      if (calls.length !== 1 || calls[0].arguments.length !== 1) return 'adopt-calls=' + calls.length;
      const arg = calls[0].arguments[0];
      const decl = (rn) => nodesOf(n => inF(n) && n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === rn && n.init).map(n => n.init);
      const asg = (rn) => nodesOf(n => inF(n) && n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === rn).map(n => n.right);
      if (arg.type === 'MemberExpression') {   // 形如 r.state：r 必须直接来自 ModelCatalogCore.setFilter(…) 调用（结果对象），不是 setFilter(…).state
        if (!(arg.object.type === 'Identifier' && !arg.computed && arg.property.type === 'Identifier' && arg.property.name === 'state')) return 'bad-member-arg';
        const rn = arg.object.name; const ds = decl(rn), as = asg(rn);
        if (ds.length + as.length === 0) return 'no-source-of-' + rn;
        if (!ds.concat(as).every(isSFcall)) return 'result-object-not-a-direct-setFilter-call-of-' + rn;
        return 'ok';
      }
      if (arg.type === 'Identifier') {   // 累积变量：声明处的种子只能是 catalogSyncState()，其余赋值必须是 setFilter(…).state，且至少有一处这样的赋值
        const rn = arg.name; const ds = decl(rn), as = asg(rn);
        if (ds.length + as.length === 0) return 'no-source-of-' + rn;
        if (!ds.every(isSeed)) return 'seed-not-catalogSyncState-of-' + rn;
        if (!as.every(isSFstate)) return 'accumulation-not-setFilter-state-of-' + rn;
        if (as.length === 0) return 'no-setFilter-source-of-' + rn;
        return 'ok';
      }
      return 'bad-arg-type=' + arg.type;
    };
    const ap = adoptFromSetFilter('catalogRailPick'), ac = adoptFromSetFilter('catalogRailClear');
    check('W:filters', 'catalogRailPick / catalogRailClear 里 catalogAdoptFilters( 的实参都来自本函数内 ModelCatalogCore.setFilter(…) 的返回值（Pick：r.state，r 必须直接是 setFilter(…) 的返回值——不得是 setFilter(…).state；Clear：累积变量，声明处种子只能是 catalogSyncState()，其余赋值必须是 setFilter(…).state——漏写 .state 判红；41Td-M1）（Pick：' + ap + '；Clear：' + ac + '）', ap === 'ok' && ac === 'ok');
  }
  // C4c-4 4a：页头在册数——只在列表数据成功到达时更新，取 railCounts(allModelsData).total；失败 / 被取代路径不碰它
  { const ut = bodyOf('catalogUpdateTotal');
    check('W:total', 'catalogUpdateTotal：在册数 = ModelCatalogCore.railCounts(allModelsData).total 写入 #catalogTotalCount 的 textContent', ut !== null && /ModelCatalogCore\.railCounts\(allModelsData\)\.total/.test(ut) && /getElementById\('catalogTotalCount'\)/.test(ut) && /\.textContent\s*=/.test(ut));
    const lm = bodyOf('loadModels');
    const calls = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'catalogUpdateTotal').map(n => topFnOf(n.start));
    check('W:total', 'catalogUpdateTotal 恰被调用 1 次，且在 loadModels 里（失败路径 catalogFailList 与别处不调用；实得：' + J(calls) + '）', calls.length === 1 && calls[0] === 'loadModels');
    check('W:total', 'loadModels 里 catalogUpdateTotal() 在 allModelsData = rows 与 renderModelsPage() 之间，且在 return \'arrived\' 之前', lm !== null && lm.indexOf('allModelsData = rows') >= 0 && lm.indexOf('allModelsData = rows') < lm.indexOf('catalogUpdateTotal()') && lm.indexOf('catalogUpdateTotal()') < lm.indexOf('renderModelsPage()') && lm.indexOf('renderModelsPage()') < lm.indexOf("return 'arrived'"));
  }
  // C4c-4 4b：左栏。威胁模型：防诚实实现写错——点击不经核心 / 不写回单一来源、计数随筛选联动、失败路径改计数、选中态不跟 catalogFilters；不防故意绕开（别名、动态属性名）。
  { const sf = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && memberName(n.callee) === 'setFilter' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'ModelCatalogCore');
    const where = sf.map(n => topFnOf(n.start)).sort();
    check('W:rail', 'ModelCatalogCore.setFilter 在 CAT 里只在 catalogRailClear / catalogRailPick 里各调用一次（左栏点击是筛选的唯一入口；实得：' + J(where) + '）', J(where) === J(['catalogRailClear', 'catalogRailPick']));
    const ad = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'catalogAdoptFilters');
    const lacking = sf.filter(s => !ad.some(a => topFnOf(a.start) === topFnOf(s.start) && a.start > s.start)).map(s => topFnOf(s.start));
    check('W:filters', 'CAT 中每个 ModelCatalogCore.setFilter( 调用之后，同一函数里都有 catalogAdoptFilters( 写回单一来源 catalogFilters（setFilter 调用点 ' + sf.length + ' 个；缺写回的函数：' + J(lacking) + '）', sf.length >= 2 && lacking.length === 0);
    const adb = bodyOf('catalogAdoptFilters');
    check('W:rail', 'catalogAdoptFilters 写回 catalogFilters 之后重画左栏（函数体里 catalogRenderRail() 位于赋值之后；点击 / 清除 / ?focus= 都经它，选中态恒与 catalogFilters 一致）', adb !== null && adb.indexOf('catalogFilters = ') >= 0 && adb.indexOf('catalogRenderRail()') > adb.indexOf('catalogFilters = '));
    const rf = bodyOf('catalogRefreshRail');
    check('W:rail', 'catalogRefreshRail：计数 = ModelCatalogCore.railCounts(allModelsData)（全量数据，不随筛选 / 搜索联动，D-8），写入 catalogRailCounts 后才重画左栏', rf !== null && /catalogRailCounts\s*=\s*ModelCatalogCore\.railCounts\(allModelsData\)\s*;/.test(rf) && rf.indexOf('catalogRenderRail()') > rf.indexOf('catalogRailCounts ='));
    const rc = nodesOf(n => n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === 'catalogRailCounts').map(n => topFnOf(n.start));
    check('W:rail', 'catalogRailCounts 只在 catalogRefreshRail 里被赋值，恰 1 处（实得：' + J(rc) + '）', J(rc) === J(['catalogRefreshRail']));
    const rcalls = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'catalogRefreshRail').map(n => topFnOf(n.start));
    const lm2 = bodyOf('loadModels');
    check('W:rail', 'catalogRefreshRail 恰被调用 1 次且在 loadModels 里，位于 catalogUpdateTotal() 之后、renderModelsPage() 之前、return \'arrived\' 之前（失败 / 被取代的路径不更新计数；实得：' + J(rcalls) + '）', J(rcalls) === J(['loadModels']) && lm2 !== null && lm2.indexOf('catalogUpdateTotal()') < lm2.indexOf('catalogRefreshRail()') && lm2.indexOf('catalogRefreshRail()') < lm2.indexOf('renderModelsPage()') && lm2.indexOf('renderModelsPage()') < lm2.indexOf("return 'arrived'"));
    const bind = bodyOf('catalogBindRail');
    check('W:rail', 'catalogBindRail：在 #catalogRail 上注册一条 click 监听；清除按钮（rail-clear）→ catalogRailClear()，左栏项（[data-rail]）→ catalogRailPick(...)，各恰 1 处', bind !== null && /getElementById\('catalogRail'\)/.test(bind) && (bind.match(/addEventListener\('click'/g) || []).length === 1 && (bind.match(/catalogRailClear\(\)/g) || []).length === 1 && (bind.match(/catalogRailPick\(/g) || []).length === 1 && /rail-clear/.test(bind));
    const is2 = bodyOf('initListSorting');
    check('W:rail', 'initListSorting 调用 catalogBindRail() 与 catalogRenderRail()（首次渲染在数据到达前：计数显示「—」，不是 0）', is2 !== null && (is2.match(/catalogBindRail\(\)/g) || []).length === 1 && (is2.match(/catalogRenderRail\(\)/g) || []).length === 1);
    const pick = bodyOf('catalogRailPick');
    check('W:rail', 'catalogRailPick：next = 同组再点已选中项 ? 「全部」 : 点的值；next 与当前相同（该组本来就是「全部」）就返回，且这一行先于 setFilter；核心调用的实参是 (catalogSyncState(), key, next)', pick !== null && /const next = catalogRailSame\(key, cur, value\) \? '' : value;/.test(pick) && /if \(next === cur\) return;/.test(pick) && pick.indexOf('if (next === cur) return;') < pick.indexOf('ModelCatalogCore.setFilter(') && /ModelCatalogCore\.setFilter\(catalogSyncState\(\), key, next\)/.test(pick));
    const clr = bodyOf('catalogRailClear');
    check('W:rail', 'catalogRailClear：对取值非「全部」的组逐个 setFilter(acc, k, \'\')（核心没有批量接口），函数体不碰搜索词与排序（不出现 searchKeyword / setQuery / toggleSort / currentSortBy / getCatalogQuery）', clr !== null && /ModelCatalogCore\.setFilter\(acc, k, ''\)/.test(clr) && !/searchKeyword|setQuery|toggleSort|currentSortBy|getCatalogQuery/.test(clr));
    // 4d（待裁 2）：左栏重画按键就地更新，不得整栏 replaceChildren / innerHTML——mousedown 与 mouseup 之间重画会让原按钮脱离文档，click 丢失（复现见 4d 报告）。威胁模型：防诚实实现改回整栏替换 / 无谓移动节点 / patch 漏对齐。
    { const rr = bodyOf('catalogRenderRail'), rc = bodyOf('catalogRailReconcile'), rp = bodyOf('catalogRailPatch'), rk = bodyOf('catalogRailKey');
      const calls2 = (name) => nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name).map(n => topFnOf(n.start)).sort();
      const noRepl = [rr, rc, rp, rk].every(b => b !== null && !/replaceChildren|innerHTML|outerHTML|insertAdjacentHTML/.test(b));
      check('W:rail', '左栏重画函数（catalogRenderRail / catalogRailReconcile / catalogRailPatch / catalogRailKey）各恰 1 个声明，函数体里没有 replaceChildren / innerHTML / outerHTML / insertAdjacentHTML', noRepl);
      check('W:rail', 'catalogRenderRail 以 catalogRailReconcile(rail, [折叠按钮 + 六个区块]) 收尾（其后只有 41-L1 的焦点归还一行）；catalogRailReconcile 只在 catalogRenderRail / catalogRenderUnowned（codex 41：未归属面板同用）/ catalogRailPatch 里调用（实得：' + J(calls2('catalogRailReconcile')) + '）', rr !== null && /catalogRailReconcile\(rail, \[toggle, head, viewSec, layerSec, statusSec, domainSec, orphan\]\);\s*if \(focused && focused !== document\.activeElement && rail\.contains\(focused\)\) focused\.focus\(\{ preventScroll: true \}\);\s*\}\s*$/.test(rr) && J(calls2('catalogRailReconcile')) === J(['catalogRailPatch', 'catalogRenderRail', 'catalogRenderUnowned']));
      check('W:rail', 'catalogRenderRail 焦点归还（codex 41-L1）：对齐前记下 document.activeElement（const focused = …，先于 catalogRailReconcile 调用），对齐后若该元素仍在左栏内却不再是焦点就 focus({ preventScroll: true }) 还给它——reconcile 的 insertBefore 搬动有焦点的按钮会让它失焦', rr !== null && rr.indexOf('const focused = document.activeElement;') >= 0 && rr.indexOf('const focused = document.activeElement;') < rr.indexOf('catalogRailReconcile(rail,') && (rr.match(/focused\.focus\(\{ preventScroll: true \}\)/g) || []).length === 1);
      // C4d-a：≤640px 折叠按钮（折叠状态只存在页面变量里、不持久化；折叠按钮与第二行开头容器的构建只走 catalogEl，状态徽章只有 catalogBuildStatusBadge 一处写法）
      { const wr = (name) => nodesOf(n => n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === name).map(n => topFnOf(n.start));
        const tr = bodyOf('catalogToggleRail'), bindR = bodyOf('catalogBindRail'), be = bodyOf('catalogBuildEntry'), sb = bodyOf('catalogBuildStatusBadge');
        const OPEN_IDS = ['catalogRailHead', 'catalogRailSecView', 'catalogRailSecLayer', 'catalogRailSecStatus', 'catalogRailSecDomain', 'catalogRailOrphan'];
        const ctl = rr === null ? null : (/'aria-controls': '([^']*)'/.exec(rr) || [])[1];
        check('W:rail', 'C4d-a：catalogRenderRail 的折叠按钮是 catalogEl(\'button\', …)：class catalog-rail-toggle、type button、data-catalog-act rail-toggle、aria-expanded 取 catalogRailOpen；aria-controls 恰列 6 个区块 id（Head / SecView / SecLayer / SecStatus / SecDomain / Orphan），每个 id 在 catalogRenderRail 里另有一处写成区块的 id（不是悬空引用）',
          rr !== null && /const toggle = catalogEl\('button', \{\s*className: 'catalog-rail-toggle', type: 'button', 'data-catalog-act': 'rail-toggle', 'aria-expanded': catalogRailOpen \? 'true' : 'false',/.test(rr) && J(String(ctl).split(' ')) === J(OPEN_IDS) && OPEN_IDS.every(id => rr.split(id).length - 1 >= 2), 'ctl=' + ctl);
        check('W:rail', 'C4d-a：折叠状态只有页面变量 catalogRailOpen（默认 false，只在 catalogToggleRail 里被赋值，不持久化：CAT 代码里没有 localStorage / sessionStorage / indexedDB / document.cookie）；catalogToggleRail = 翻转后同步重画左栏；catalogBindRail 里 [data-catalog-act="rail-toggle"] → catalogToggleRail() 恰 1 处',
          /let catalogRailOpen = false;/.test(code) && J(wr('catalogRailOpen')) === J(['catalogToggleRail']) && !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code) && tr !== null && /^function catalogToggleRail\(\) \{\s*catalogRailOpen = !catalogRailOpen;\s*catalogRenderRail\(\);\s*\}$/.test(tr) && bindR !== null && /\[data-catalog-act="rail-toggle"\]/.test(bindR) && (bindR.match(/catalogToggleRail\(\)/g) || []).length === 1, J(wr('catalogRailOpen')));
        // codex 42Tc-L1：解析 row2Kids 数组字面量，首项必须是 catalogEl('div', { className: 'catalog-mobile-meta' }, …) 调用（用数组结构，不用源码出现顺序代替）
        const r2d = nodesOf(n => n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === 'row2Kids');
        const r2e = r2d.length === 1 && r2d[0].init && r2d[0].init.type === 'ArrayExpression' ? r2d[0].init.elements[0] : null;
        const row2first = r2d.length === 1 && topFnOf(r2d[0].start) === 'catalogBuildEntry' && !!r2e && r2e.type === 'CallExpression' && r2e.callee.type === 'Identifier' && r2e.callee.name === 'catalogEl' && !!r2e.arguments[0] && r2e.arguments[0].type === 'Literal' && r2e.arguments[0].value === 'div' && !!r2e.arguments[1] && r2e.arguments[1].type === 'ObjectExpression' && r2e.arguments[1].properties.some(p => p.type === 'Property' && ((p.key.type === 'Identifier' && p.key.name === 'className') || (p.key.type === 'Literal' && p.key.value === 'className')) && p.value.type === 'Literal' && p.value.value === 'catalog-mobile-meta');
        // fix42b MED-1：meta 容器的第 0 个子项是 span.catalog-status-m 页面包装层，其唯一子项就是 catalogBuildStatusBadge(m) 调用（窄屏长状态值的收缩约束写在包装层上，不用结构选择器去改共享层徽章）
        const r2m = row2first ? r2e.arguments[2] : null;
        const r2b = r2m && r2m.type === 'ArrayExpression' ? r2m.elements[0] : null;
        const hasCls = (o, cls) => !!o && o.type === 'ObjectExpression' && o.properties.some(p => p.type === 'Property' && ((p.key.type === 'Identifier' && p.key.name === 'className') || (p.key.type === 'Literal' && p.key.value === 'className')) && p.value.type === 'Literal' && p.value.value === cls);
        const badgeWrapped = !!r2b && r2b.type === 'CallExpression' && r2b.callee.type === 'Identifier' && r2b.callee.name === 'catalogEl' && !!r2b.arguments[0] && r2b.arguments[0].type === 'Literal' && r2b.arguments[0].value === 'span' && hasCls(r2b.arguments[1], 'catalog-status-m') && !!r2b.arguments[2] && r2b.arguments[2].type === 'ArrayExpression' && r2b.arguments[2].elements.length === 1 && !!r2b.arguments[2].elements[0] && r2b.arguments[2].elements[0].type === 'CallExpression' && r2b.arguments[2].elements[0].callee.type === 'Identifier' && r2b.arguments[2].elements[0].callee.name === 'catalogBuildStatusBadge' && r2b.arguments[2].elements[0].arguments.length === 1 && r2b.arguments[2].elements[0].arguments[0].type === 'Identifier' && r2b.arguments[2].elements[0].arguments[0].name === 'm';
        check('W:rail', 'C4d-a：第二行开头容器 div.catalog-mobile-meta 由 catalogEl 构建，是 row2Kids 数组字面量的首项（解析数组结构：row2Kids 恰 1 个声明且声明在 catalogBuildEntry 顶层函数里、数组第 0 项是 catalogEl(\'div\', { className: \'catalog-mobile-meta\' }, …) 调用）；容器的第 0 个子项是 span.catalog-status-m 页面包装层，唯一子项是 catalogBuildStatusBadge(m) 调用（fix42b MED-1）；里面的状态徽章 / 最近验收与首行走同一批构建函数（catalogBuildEntry 里 catalogBuildStatusBadge(m) 与 catalogBuildAcceptance(accView 各恰 2 次，验收摘要 catalogAcceptanceViewOf(m) 只在 catalogBuildEntry 里算 1 次、核心的 ModelCatalogCore.acceptanceView( 全文只在 catalogAcceptanceViewOf 里调 1 次）；u-status-badge 字面量全文恰 1 处且在 catalogBuildStatusBadge 里（不另写一份徽章渲染）',
          be !== null && sb !== null && row2first && badgeWrapped && (be.match(/catalogBuildStatusBadge\(m\)/g) || []).length === 2 && (be.match(/catalogBuildAcceptance\(accView/g) || []).length === 2 && (be.match(/catalogAcceptanceViewOf\(m\)/g) || []).length === 1 && (code.match(/ModelCatalogCore\.acceptanceView\(/g) || []).length === 1 && (code.match(/u-status-badge/g) || []).length === 1 && sb.indexOf('u-status-badge') >= 0, 'n=' + (code.match(/u-status-badge/g) || []).length);
        const av = bodyOf('catalogAcceptanceViewOf'), ba = bodyOf('catalogBuildAcceptance'), lv = bodyOf('catalogLeaveUnowned');
        check('W:rail', 'C4d 预筛修复 LOW-5：最近验收摘要「算结果」与「按结果建节点」分开——catalogAcceptanceViewOf(m) 里调核心 acceptanceView(m.acceptance) 并在识别不了时记 warn；catalogBuildAcceptance(v, rootClass) 只按传入的结果建节点（不调核心、不 try、不 warn），所以一个条目首行与第二行容器共用一份结果、一次渲染最多一条 warn',
          av !== null && ba !== null && /ModelCatalogCore\.acceptanceView\(m\.acceptance\)/.test(av) && /console\.warn\('\[模型目录\] 验收摘要无法识别/.test(av) && !/ModelCatalogCore|console\.warn|\btry\b/.test(ba) && (code.match(/验收摘要无法识别（模型/g) || []).length === 1);
        check('W:rail', 'C4d 预筛修复 LOW-3：状态格与负责人格补 title——状态徽章 title = 显示文字（catalogBuildStatusBadge 里 title: statusText，映射外原值原样），首行 .catalog-status 格 title 取徽章的 title；负责人 title = 全名（ownerTitle，占位「-」不加），首行 .catalog-owner 与第二行 .catalog-owner-m 各一处；title 都经 catalogEl 写入',
          sb !== null && be !== null && /title: statusText, text: statusText/.test(sb) && /className: 'catalog-cell catalog-status', title: statusBadge\.title \}/.test(be) && /const ownerTitle = m\.tech_owner \? String\(m\.tech_owner\) : null;/.test(be) && /className: 'catalog-cell catalog-owner', title: ownerTitle, text: ownerText \}/.test(be) && /className: 'catalog-owner-m', title: ownerTitle, text: ownerText \}/.test(be) && (be.match(/title: ownerTitle/g) || []).length === 2);
        check('W:unowned', 'C4d 预筛修复 LOW-4：catalogLeaveUnowned 先退出模式；左栏入口 #catalogRailUnowned 有盒子（getClientRects().length > 0）才聚焦它，否则回退聚焦折叠按钮 #catalogRail .catalog-rail-toggle（同样先判有盒子）——≤640 左栏收起时入口在 display:none 祖先下，focus() 会静默失败',
          lv !== null && /catalogSetUnownedMode\(false\);/.test(lv) && /const shown = \(el\) => !!el && el\.getClientRects\(\)\.length > 0;/.test(lv) && /if \(shown\(un\)\) \{ un\.focus\(\{ preventScroll: true \}\); return; \}/.test(lv) && /document\.querySelector\('#catalogRail \.catalog-rail-toggle'\)/.test(lv) && /if \(shown\(tg\)\) tg\.focus\(\{ preventScroll: true \}\);/.test(lv)); }
      // C4d-b：可访问性（D-26）与 LOW-9——列表 / 列头角色、焦点框规则、焦点移出菜单关闭、P40、highlightModel 退出未归属模式
      { const rbA = bodyOf('renderModelsPage'), fi = bodyOf('catalogOnFocusIn'), hm = bodyOf('highlightModel'), cl = bodyOf('catalogRailClear');
        const fiL = nodesOf(n => n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression' && memberName(n.expression.callee) === 'addEventListener' && n.expression.callee.object.type === 'Identifier' && n.expression.callee.object.name === 'document' && n.expression.arguments[0] && n.expression.arguments[0].type === 'Literal' && n.expression.arguments[0].value === 'focusin');
        check('W:a11y', 'C4d-b：renderModelsPage 里列表的每个直接子元素都带 role: \'listitem\'——组包装 catalog-group 与空态 catalog-empty（#modelListBody 是 role="list"）', rbA !== null && /className: 'catalog-group', role: 'listitem', 'data-group': g\.id/.test(rbA) && /className: 'catalog-empty', role: 'listitem', text: '暂无模型数据'/.test(rbA));
        check('W:a11y', 'C4d-b：MC 静态 HTML——列头 div.catalog-head 没有 role="row"、各格没有 role="columnheader"（全文不出现这两个角色），#modelListOpHeader 仍在，#modelListBody 仍是 div[role="list"]（C40 契约 1）', !/role="row"|role="columnheader"/.test(html) && /id="modelListOpHeader"/.test(html) && /<div id="modelListBody" role="list">/.test(html));
        check('W:a11y', 'C4d-b：MC 焦点框规则——一条 :focus-visible 规则覆盖 页头 / 工具条 / 左栏 / 列头 / 列表失败提示 / 列表条目 / 未归属面板 / 分页 八个容器，outline: 2px solid var(--catalog-focus, #d97706)；不出现全局 button:focus 规则', /\.catalog-pagehead :focus-visible, \.catalog-toolbar :focus-visible, #catalogRail :focus-visible, \.catalog-head :focus-visible, #catalogListNotice :focus-visible, #modelListBody :focus-visible, #catalogUnownedPanel :focus-visible, #paginationContainer :focus-visible \{ outline: 2px solid var\(--catalog-focus, #d97706\); outline-offset: 2px; \}/.test(html) && !/(^|\n)\s*button:focus\b/.test(html));
        check('W:a11y', 'C4d-b：catalogOnFocusIn 恰 1 个声明且是 document 的 focusin 监听回调（恰 1 条）；函数体：有菜单打开才处理，新焦点既不在菜单内也不在其触发按钮内才 catalogCloseMenus()，不调 .focus( / preventDefault（不抢焦点）', fi !== null && fiL.length === 1 && fiL[0].expression.arguments[1].type === 'Identifier' && fiL[0].expression.arguments[1].name === 'catalogOnFocusIn' && /const inside = open\.some\(menu => menu\.contains\(t\) \|\| \(catalogTriggerOf\(menu\) \|\| menu\)\.contains\(t\)\);\s*if \(!inside\) catalogCloseMenus\(\);/.test(fi) && !/\.focus\(|preventDefault/.test(fi), 'n=' + fiL.length);
        check('W:unowned', 'C4d-b ⑤：highlightModel 的 catalogSetUnownedMode(false) 恰 1 次，且先于 ModelCatalogCore.locate(（?id=X / dev=1 的高亮定位先退出未归属模式）', hm !== null && (hm.match(/catalogSetUnownedMode\(false\)/g) || []).length === 1 && hm.indexOf('catalogSetUnownedMode(false)') >= 0 && hm.indexOf('catalogSetUnownedMode(false)') < hm.indexOf('ModelCatalogCore.locate('));
        check('W:rail', 'C4d-b P40：catalogRailClear 在 renderModelsPage() 之后把焦点移到左栏「全部模型」（#catalogRail [data-rail="view:"]，preventScroll）', cl !== null && /renderModelsPage\(\);\s*const allView = document\.querySelector\('#catalogRail \[data-rail="view:"\]'\);[^]*?if \(allView\) allView\.focus\(\{ preventScroll: true \}\);/.test(cl)); }
      check('W:rail', 'catalogRailReconcile：旧节点按键入池、配上的复用并就地 patch（catalogRailPatch(o, f)）、没配上的删除（el.remove()）、新节点插入；只在位置不对时才 insertBefore（parent.children[i] !== el），不对所有节点重新追加', rc !== null && /catalogRailPatch\(o, f\)/.test(rc) && /el\.remove\(\)/.test(rc) && /if \(parent\.children\[i\] !== el\) parent\.insertBefore\(el, parent\.children\[i\] \|\| null\);/.test(rc) && !/appendChild/.test(rc));
      check('W:rail', 'catalogRailPatch：属性逐个对齐（setAttribute / removeAttribute）、叶子元素对齐文字（textContent = freshEl.textContent）、有子元素的递归 catalogRailReconcile', rp !== null && /oldEl\.removeAttribute\(a\.name\)/.test(rp) && /oldEl\.setAttribute\(a\.name, a\.value\)/.test(rp) && /oldEl\.textContent = freshEl\.textContent/.test(rp) && /catalogRailReconcile\(oldEl, Array\.from\(freshEl\.children\)\)/.test(rp));
      check('W:rail', 'catalogRailPatch 的执行条件（codex 41Td-M2）：属性对齐分支的条件恰为 oldEl.getAttribute(a.name) !== a.value；叶子文字分支的条件为 oldEl.children.length > 0 || oldEl.textContent !== freshEl.textContent——运算符 !== 与两个操作数都核（写成 === 时更新语句还在，却永不在需要时执行）；纯文字叶子换成有子元素时先清旧文字', rp !== null && /if \(oldEl\.getAttribute\(a\.name\) !== a\.value\) oldEl\.setAttribute\(a\.name, a\.value\);/.test(rp) && /if \(oldEl\.children\.length > 0 \|\| oldEl\.textContent !== freshEl\.textContent\) oldEl\.textContent = freshEl\.textContent;/.test(rp) && /if \(oldEl\.children\.length === 0 && oldEl\.textContent !== ''\) oldEl\.textContent = '';/.test(rp));
      check('W:rail', 'catalogRailKey：左栏项取 data-rail，有 id 的取 id，清除按钮取 data-catalog-act，其余按「标签 + 首个 class」配对', rk !== null && /getAttribute\('data-rail'\)/.test(rk) && /el\.id/.test(rk) && /getAttribute\('data-catalog-act'\)/.test(rk) && /el\.tagName/.test(rk)); }
    const asideAt = html.indexOf('<aside id="catalogRail"'), secAt = html.indexOf('id="modelListSection"');
    check('W:rail', 'MC 静态 HTML：<aside id="catalogRail" class="catalog-rail" aria-label="筛选与分组"> 恰 1 个，位于 #modelListSection 之前；列表区没有 .section-title 小标题「核心模型目录」', asideAt > 0 && html.indexOf('<aside id="catalogRail"', asideAt + 1) < 0 && asideAt < secAt && /<aside id="catalogRail" class="catalog-rail" aria-label="筛选与分组">/.test(html) && !/核心模型目录/.test(html.replace(/<!--[\s\S]*?-->/g, '')));
  }
  // C4c-4 4a（P36）：applyCatalogSearch 的「旧词」必须是 renderModelsPage 记下的 catalogRenderedQuery（catalogSyncState().query 已经是输入框的新词，拿它当旧词则任何输入都被判成没变）
  { const ap = bodyOf('applyCatalogSearch');
    check('W:p36', 'applyCatalogSearch：setQuery 的状态实参显式换上 query: catalogRenderedQuery，新词取 getCatalogQuery()', ap !== null && /ModelCatalogCore\.setQuery\(Object\.assign\(\{\},\s*catalogSyncState\(\),\s*\{\s*query:\s*catalogRenderedQuery\s*\}\),\s*getCatalogQuery\(\)\)/.test(ap));
    const asg = nodesOf(n => n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === 'catalogRenderedQuery').map(n => topFnOf(n.start));
    check('W:p36', 'catalogRenderedQuery 只在 renderModelsPage 里被赋值，恰 1 处（实得：' + J(asg) + '）', asg.length === 1 && asg[0] === 'renderModelsPage');
    const rb = bodyOf('renderModelsPage');
    check('W:p36', 'renderModelsPage 里 catalogRenderedQuery = getCatalogQuery() 在 view 算出之后、列表替换之前', rb !== null && rb.indexOf('catalogRenderedQuery = getCatalogQuery()') > rb.indexOf('catalogViewRaw()') && rb.indexOf('catalogRenderedQuery = getCatalogQuery()') < rb.indexOf('list.replaceChildren'));
    // 4d（预筛 LOW-1）：组字期间发生的渲染不得把组字文本记成「当前画面所用的词」——标记 catalogComposing（compositionstart 置位 / compositionend 清位，清位监听先于 applyCatalogSearch 注册），renderModelsPage 的记录包在 if (!catalogComposing) 里。
    const cdecl = decls('catalogComposing');
    check('W:p36', 'catalogComposing 恰 1 个顶层声明，初值为字面量 false', cdecl.length === 1 && cdecl[0].declarations[0].init && cdecl[0].declarations[0].init.type === 'Literal' && cdecl[0].declarations[0].init.value === false);
    const cw = nodesOf(n => n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === 'catalogComposing').map(n => topFnOf(n.start) + '=' + (n.right.type === 'Literal' ? String(n.right.value) : '?'));
    check('W:p36', 'catalogComposing 只在 initCatalogSearch 里被赋值，恰两处：= true、= false（实得：' + J(cw) + '）', J(cw.slice().sort()) === J(['initCatalogSearch=false', 'initCatalogSearch=true']));
    const ic = bodyOf('initCatalogSearch');
    const cs = "el.addEventListener('compositionstart', () => { catalogComposing = true; });", ce = "el.addEventListener('compositionend', () => { catalogComposing = false; });", ca = "el.addEventListener('compositionend', applyCatalogSearch);";
    const once = (s) => ic !== null && ic.split(s).length - 1 === 1;
    check('W:p36', 'initCatalogSearch：compositionstart 置位、compositionend 清位、compositionend → applyCatalogSearch 各恰 1 处，且清位监听先于 applyCatalogSearch 注册（同一事件的监听按注册顺序执行，应用搜索时标记已清）', once(cs) && once(ce) && once(ca) && ic.indexOf(ce) < ic.indexOf(ca));
    const raAsg = nodesOf(n => n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === 'catalogRenderedQuery');
    const guards = nodesOf(n => n.type === 'IfStatement' && !n.alternate && n.test.type === 'UnaryExpression' && n.test.operator === '!' && n.test.argument.type === 'Identifier' && n.test.argument.name === 'catalogComposing');
    check('W:p36', 'renderModelsPage 里对 catalogRenderedQuery 的赋值整个包在 if (!catalogComposing) { … } 里（组字期间不记）', raAsg.length === 1 && guards.some(g => raAsg[0].start >= g.consequent.start && raAsg[0].end <= g.consequent.end && topFnOf(g.start) === 'renderModelsPage'));
  }
  // C4c-4 4c：未归属对象。威胁模型：防诚实实现写错——模型列表重载时重取 / 退出模式、迟到响应不丢弃、在途时可重复发请求、点筛选不先退出模式、入口带了 data-rail / data-act / data-entry、徽章不走展开区同一个构建函数、失败弹 toast、MC 面板 / 隐藏规则缺失；不防别名绕开。
  { const calls = (name) => nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name).map(n => topFnOf(n.start)).sort();
    const writes = (name) => nodesOf(n => n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === name).map(n => topFnOf(n.start));
    const lu = bodyOf('catalogLoadUnowned'), lm3 = bodyOf('loadModels'), rm3 = bodyOf('renderModelsPage'), rt = bodyOf('catalogRetryUnowned'), ru = bodyOf('catalogRenderUnowned');
    check('W:unowned', 'catalogLoadUnowned 只在 initListSorting（初始化）与 catalogRetryUnowned（用户点重试）里调用（实得：' + J(calls('catalogLoadUnowned')) + '）', J(calls('catalogLoadUnowned')) === J(['catalogRetryUnowned', 'initListSorting']));
    const urlLits = nodesOf(n => n.type === 'Literal' && typeof n.value === 'string' && n.value.indexOf('/api/model-impl-objects') >= 0).map(n => topFnOf(n.start) + ':' + n.value);
    check('W:unowned', "CAT 代码里 '/api/model-impl-objects' 字面量恰 1 处，位于 catalogLoadUnowned，值恰为 '/api/model-impl-objects?unowned=1'（实得：" + J(urlLits) + '）', J(urlLits) === J(['catalogLoadUnowned:/api/model-impl-objects?unowned=1']));
    const DISC = "if (seq !== catalogUnownedSeq) return 'discarded';";
    const p1 = lu === null ? -1 : lu.indexOf(DISC), p2 = lu === null ? -1 : lu.indexOf(DISC, p1 + 1), p3 = lu === null ? -1 : lu.indexOf(DISC, p2 + 1);
    check('W:unowned', "catalogLoadUnowned：请求序号 const seq = ++catalogUnownedSeq；三处「" + DISC + "」依次位于 await authFetch 之后、await res.json() 之后、catch 开头；对 catalogUnownedRows / catalogUnownedStatus 的写入都在最后一处检查之后（迟到的旧响应整个丢弃）",
      lu !== null && /const seq = \+\+catalogUnownedSeq;/.test(lu) && (lu.split(DISC).length - 1) === 3 && lu.indexOf('await authFetch(') < p1 && p1 < lu.indexOf('await res.json()') && lu.indexOf('await res.json()') < p2 && p2 < lu.indexOf('} catch') && lu.indexOf('} catch') < p3 && p3 < lu.indexOf('catalogUnownedRows = rows') && p3 < lu.indexOf('catalogUnownedStatus ='), { p1, p2, p3 });
    check('W:unowned', 'catalogLoadUnowned：只有 res.ok 才解析 JSON，且解析结果必须过 catalogValidUnowned(data) 才算成功（不静默丢掉坏元素）；失败不调 showToast', lu !== null && /if \(res && res\.ok\)/.test(lu) && /if \(catalogValidUnowned\(data\)\) rows = data;/.test(lu) && !/showToast/.test(lu));
    check('W:unowned', 'catalogUnownedMode 只在 catalogSetUnownedMode 里被赋值；catalogUnownedRows / catalogUnownedStatus 只在 catalogLoadUnowned 里被赋值（实得：' + J({ m: writes('catalogUnownedMode'), r: writes('catalogUnownedRows'), s: writes('catalogUnownedStatus') }) + '）', J(writes('catalogUnownedMode')) === J(['catalogSetUnownedMode']) && J(writes('catalogUnownedRows')) === J(['catalogLoadUnowned']) && J(writes('catalogUnownedStatus')) === J(['catalogLoadUnowned']));
    check('W:unowned', "catalogRetryUnowned：「if (catalogUnownedBusy) return;」先于 catalogLoadUnowned( 调用（在途时不重复请求）；catalogRenderUnowned 的重试按钮带 disabled: catalogUnownedBusy（在途置灰）", rt !== null && ru !== null && rt.indexOf('if (catalogUnownedBusy) return;') >= 0 && rt.indexOf('if (catalogUnownedBusy) return;') < rt.indexOf('catalogLoadUnowned(') && /disabled:\s*catalogUnownedBusy/.test(ru));
    check('W:unowned', "loadModels / renderModelsPage 的函数体不出现 catalogLoadUnowned / catalogSetUnownedMode / catalogUnowned（模型列表重载不重取未归属清单、不退出未归属模式、渲染不因模式跳过）", lm3 !== null && rm3 !== null && !/catalogLoadUnowned|catalogSetUnownedMode|catalogUnowned/.test(lm3) && !/catalogLoadUnowned|catalogSetUnownedMode|catalogUnowned/.test(rm3));
    check('W:unowned', 'catalogSetUnownedMode 只在 catalogLeaveUnowned / catalogRailClear / catalogRailPick / catalogToggleUnowned / focusCatalogModel / highlightModel 里调用（4d 加 focusCatalogModel：?focus= 先退出未归属模式；C4d-b 加 highlightModel：?id=X / dev=1 的高亮定位也先退出）（实得：' + J(calls('catalogSetUnownedMode')) + '）', J(calls('catalogSetUnownedMode')) === J(['catalogLeaveUnowned', 'catalogRailClear', 'catalogRailPick', 'catalogToggleUnowned', 'focusCatalogModel', 'highlightModel']));
    { const fcm = bodyOf('focusCatalogModel');
      check('W:unowned', 'focusCatalogModel：catalogSetUnownedMode(false) 恰 1 次，且先于函数体里第一处 ModelCatalogCore.（核心 focus 事件等；先退出未归属模式，再清搜索 / 跳页 / 高亮）', fcm !== null && (fcm.match(/catalogSetUnownedMode\(false\)/g) || []).length === 1 && fcm.indexOf('ModelCatalogCore.') > fcm.indexOf('catalogSetUnownedMode(false)')); }
    const pk = bodyOf('catalogRailPick'), cl = bodyOf('catalogRailClear');
    check('W:unowned', 'catalogRailPick：catalogSetUnownedMode(false) 先于 if (next === cur) return; 与 ModelCatalogCore.setFilter(（该组本来就是「全部」时也要先退出）；catalogRailClear：catalogSetUnownedMode(false) 先于 const keys 与 setFilter（点「清除 N 项」先退出）',
      pk !== null && cl !== null && pk.indexOf('catalogSetUnownedMode(false)') >= 0 && pk.indexOf('catalogSetUnownedMode(false)') < pk.indexOf('if (next === cur) return;') && pk.indexOf('catalogSetUnownedMode(false)') < pk.indexOf('ModelCatalogCore.setFilter(') && cl.indexOf('catalogSetUnownedMode(false)') >= 0 && cl.indexOf('catalogSetUnownedMode(false)') < cl.indexOf('const keys') && cl.indexOf('catalogSetUnownedMode(false)') < cl.indexOf('ModelCatalogCore.setFilter('));
    const bind2 = bodyOf('catalogBindRail'), bu = bodyOf('catalogBindUnowned'), is3 = bodyOf('initListSorting'), leave = bodyOf('catalogLeaveUnowned'), tog = bodyOf('catalogToggleUnowned');
    check('W:unowned', 'catalogBindRail：入口 [data-catalog-act="unowned"] → catalogToggleUnowned()，恰 1 处（与 rail-clear / data-rail 同一条 click 监听，不另开监听）；catalogToggleUnowned = catalogSetUnownedMode(!catalogUnownedMode)（再点入口等同返回）', bind2 !== null && tog !== null && (bind2.match(/catalogToggleUnowned\(\)/g) || []).length === 1 && /\[data-catalog-act="unowned"\]/.test(bind2) && (bind2.match(/addEventListener\('click'/g) || []).length === 1 && /catalogSetUnownedMode\(!catalogUnownedMode\)/.test(tog));
    check('W:unowned', 'catalogBindUnowned：#catalogUnownedPanel 上恰一条 click 监听；返回 [data-catalog-act="unowned-back"] → catalogLeaveUnowned()、重试 [data-catalog-act="retry-unowned"] → catalogRetryUnowned()，各恰 1 处；catalogLeaveUnowned 先 catalogSetUnownedMode(false)', bu !== null && leave !== null && /getElementById\('catalogUnownedPanel'\)/.test(bu) && (bu.match(/addEventListener\('click'/g) || []).length === 1 && (bu.match(/catalogLeaveUnowned\(\)/g) || []).length === 1 && (bu.match(/catalogRetryUnowned\(\)/g) || []).length === 2 && /unowned-back/.test(bu) && /retry-unowned/.test(bu) && /refresh-unowned/.test(bu) && /catalogSetUnownedMode\(false\)/.test(leave));
    { // 4d（待裁 1）：ok 态面板右上的「刷新」按钮——与「重试」同走 catalogRetryUnowned（在途守卫 + 置灰），只在 ok 态出现
      const rObj = nodesOf(n => n.type === 'ObjectExpression' && n.properties.some(p => p.type === 'Property' && p.key.type === 'Literal' && p.key.value === 'data-catalog-act' && p.value.type === 'Literal' && p.value.value === 'refresh-unowned'));
      const rkeys = rObj.length === 1 ? rObj[0].properties.map(p => (p.key.type === 'Literal' ? String(p.key.value) : p.key.name || '')) : [];
      check('W:unowned', '刷新按钮：恰 1 个带 data-catalog-act: refresh-unowned 的 catalogEl 选项对象，位于 catalogRenderUnowned；选项有 type 与 disabled，没有 data-act / data-rail / data-entry 键', rObj.length === 1 && topFnOf(rObj[0].start) === 'catalogRenderUnowned' && rkeys.includes('type') && rkeys.includes('disabled') && !rkeys.some(k => ['data-act', 'data-rail', 'data-entry'].includes(k)), J(rkeys));
      const cond = rObj.length === 1 ? nodesOf(n => n.type === 'ConditionalExpression' && n.consequent.type === 'CallExpression' && n.consequent.arguments.includes(rObj[0]))[0] : null;
      check('W:unowned', '刷新按钮只在 ok 态出现：它所在的条件表达式形如 catalogUnownedStatus === \'ok\' ? catalogEl(…) : null', !!cond && cond.test.type === 'BinaryExpression' && cond.test.operator === '===' && cond.test.left.type === 'Identifier' && cond.test.left.name === 'catalogUnownedStatus' && cond.test.right.type === 'Literal' && cond.test.right.value === 'ok' && cond.alternate.type === 'Literal' && cond.alternate.value === null);
      check('W:unowned', 'catalogRenderUnowned：disabled: catalogUnownedBusy 恰 2 处（重试按钮与刷新按钮，在途都置灰）', ru !== null && (ru.match(/disabled:\s*catalogUnownedBusy/g) || []).length === 2);
      const refreshLine = bu === null ? '' : (/const refresh = t\.closest\('\[data-catalog-act="refresh-unowned"\]'\);\s*if \(refresh && panel\.contains\(refresh\)\) \{ if \(!refresh\.disabled\) catalogRetryUnowned\(\); \}/.exec(bu) || [''])[0];
      check('W:unowned', 'catalogBindUnowned：刷新按钮（refresh-unowned）→ 未置灰才调 catalogRetryUnowned()（与重试同一条路径，不直接调 catalogLoadUnowned）', refreshLine !== '' && !/catalogLoadUnowned/.test(bu)); }
    check('W:unowned', 'initListSorting 调用 catalogBindUnowned() 与 catalogLoadUnowned() 各恰 1 次（初始化时与列表请求并行取一次）', is3 !== null && (is3.match(/catalogBindUnowned\(\)/g) || []).length === 1 && (is3.match(/catalogLoadUnowned\(\)/g) || []).length === 1);
    const entryObj = nodesOf(n => n.type === 'ObjectExpression' && n.properties.some(p => p.type === 'Property' && p.key.type === 'Literal' && p.key.value === 'data-catalog-act' && p.value.type === 'Literal' && p.value.value === 'unowned'));
    const ekeys = entryObj.length === 1 ? entryObj[0].properties.map(p => (p.key.type === 'Literal' ? String(p.key.value) : p.key.name || '')) : [];
    check('W:unowned', '入口按钮：恰 1 个带 data-catalog-act: unowned 的 catalogEl 选项对象，位于 catalogRenderRail；选项里有 id 与 aria-pressed，没有 data-rail / data-act / data-entry 键（C40 只认 data-act / data-entry，左栏只认 data-rail）', entryObj.length === 1 && topFnOf(entryObj[0].start) === 'catalogRenderRail' && ekeys.includes('id') && ekeys.includes('aria-pressed') && !ekeys.some(k => ['data-rail', 'data-act', 'data-entry'].includes(k)), J(ekeys));
    const okc = calls('catalogObjBadgeKids'), ibc = calls('catalogBuildImplBadge');
    check('W:unowned', '徽章格只有一个构建函数 catalogObjBadgeKids：展开区实现对象表（catalogBuildObjectTable）与未归属表（catalogBuildUnownedTable）各调用一次；两个表函数都不直接调用 catalogBuildImplBadge（文案 / 色调 / 未知 code 规则只在 catalogBuildImplBadge 一份，实得 catalogBuildImplBadge 的调用方：' + J(Array.from(new Set(ibc))) + '）', J(okc) === J(['catalogBuildObjectTable', 'catalogBuildUnownedTable']) && ibc.length > 0 && ibc.every(f => f === 'catalogObjBadgeKids'));
    check('W:unowned', 'catalogRenderUnowned：切换 #modelListSection 的 is-unowned 类（classList.toggle(\'is-unowned\', catalogUnownedMode)）与面板 hidden（panel.hidden = !catalogUnownedMode）；未归属相关函数里不出现 showToast（失败不弹 toast）', ru !== null && /classList\.toggle\('is-unowned',\s*catalogUnownedMode\)/.test(ru) && /panel\.hidden\s*=\s*!catalogUnownedMode;/.test(ru) && !['catalogLoadUnowned', 'catalogRenderUnowned', 'catalogRetryUnowned', 'catalogSetUnownedMode', 'catalogLeaveUnowned', 'catalogBindUnowned', 'catalogBuildUnownedTable'].some(f => /showToast/.test(bodyOf(f) || '')));
    { // codex 41-M1：catalogRenderUnowned 在请求开始 / 完成时都会被调用——整面板 replaceChildren 会让 mousedown 与 mouseup 之间的「返回模型列表」按钮脱离文档、click 丢失（焦点也丢）。就地更新（catalogRailReconcile）。
      const rdn = bodyOf('catalogRenderUnowned');
      check('W:unowned', 'catalogRenderUnowned（codex 41-M1 就地更新）：函数体里没有 replaceChildren / innerHTML / outerHTML / insertAdjacentHTML / panel.textContent =；以 catalogRailReconcile(panel, [头部, body]) 收尾（面板节点对齐，返回 / 刷新 / 重试按钮保持同一个节点）', rdn !== null && !/replaceChildren|innerHTML|outerHTML|insertAdjacentHTML|panel\.textContent\s*=/.test(rdn) && /catalogRailReconcile\(panel, \[\s*catalogEl\('div', \{ className: 'catalog-unowned-head' \}/.test(rdn) && /\n\s*body\s*\]\);\s*\}\s*$/.test(rdn));
      const but = bodyOf('catalogBuildUnownedTable');
      check('W:unowned', 'catalogBuildUnownedTable 的类型列走 catalogOrDash(o.obj_type)（codex 41-L2：空串 / 纯空白 / null / 缺失显示「—」，与摘要、核验时间同一占位规则）', but !== null && /className: 'catalog-obj-type', text: catalogOrDash\(o\.obj_type\)/.test(but) && !/catalogText\(o\.obj_type\)/.test(but)); }
    const panelTag = /<div id="catalogUnownedPanel"[^>]*\shidden[^>]*><\/div>/.exec(html);
    const pAt = html.indexOf('id="catalogUnownedPanel"'), sAt = html.indexOf('id="modelListSection"'), gAt = html.indexOf('id="paginationContainer"');
    check('W:unowned', 'MC 静态 HTML：div#catalogUnownedPanel 恰 1 个、带 hidden、位于 #modelListSection 内且在分页容器之前；CSS 有 #modelListSection.is-unowned > .catalog-wrap 与 > #paginationContainer 的 display: none !important', !!panelTag && html.indexOf('id="catalogUnownedPanel"', pAt + 1) < 0 && sAt > 0 && sAt < pAt && pAt < gAt && /#modelListSection\.is-unowned > \.catalog-wrap, #modelListSection\.is-unowned > #paginationContainer \{ display: none !important; \}/.test(html));
  }
  // T3 / A3：focusCatalogModel 恰调用一次 ModelCatalogCore.focus(，结果的 state 写回 catalogEventState，输入框值取自 state.query（不直接清输入框）
  { const b = bodyOf('focusCatalogModel');
    check('W:focus', 'focusCatalogModel 函数体恰调用一次 ModelCatalogCore.focus(', b !== null && (b.match(/ModelCatalogCore\.focus\(/g) || []).length === 1);
    check('W:focus', 'focusCatalogModel 把核心 focus 结果的 state 写回 catalogEventState', b !== null && /catalogEventState\s*=\s*r\.state/.test(b));
    check('W:focus', 'focusCatalogModel 的输入框值取自 r.state.query，且不直接把输入框置空串', b !== null && /\.value\s*=\s*r\.state\.query/.test(b) && !/\.value\s*=\s*''/.test(b));
  }
  // L5：运行时版本握手里的字面量 = 核心源码读出的 CORE_VERSION（不写死版本号）
  if (ver) {
    const b = bodyOf('catalogCheckCoreVersion');
    const cmp = b && /CORE_VERSION\s*!==\s*'([^']+)'/.exec(b), msg = b && /期望 ([^\s，,]+)/.exec(b);
    check('W:corever', 'catalogCheckCoreVersion 比较的字面量 = 核心 CORE_VERSION（' + ver[1] + '）', !!cmp && cmp[1] === ver[1], cmp ? cmp[1] : '(找不到比较)');
    check('W:corever', 'catalogCheckCoreVersion 报错文案里的「期望 …」= 核心 CORE_VERSION（' + ver[1] + '）', !!msg && msg[1] === ver[1], msg ? msg[1] : '(找不到文案)');
  }
  // D-7「代次推导」骨架（codex 36-R2）：过期 ⇔ catalogListSeen < catalogWritesDone；没有可变的陈旧标记
  { const b = bodyOf('catalogTrackWrite'); check('W:track', 'catalogTrackWrite：在途 +1；finally 里依次 在途 −1、已结束数 +1、调用 reloadCatalogIfStale()', b !== null && /catalogWritesInFlight\+\+/.test(b) && /\.finally\(/.test(b) && /catalogWritesInFlight--;\s*catalogWritesDone\+\+;\s*reloadCatalogIfStale\(\);/.test(b)); }
  { const b = bodyOf('catalogIsStale'); check('W:track', 'catalogIsStale：catalogListSeen < catalogWritesDone', b !== null && /catalogListSeen\s*<\s*catalogWritesDone/.test(b)); }
  { const b = bodyOf('reloadCatalogIfStale'); check('W:track', 'reloadCatalogIfStale：四个判断（在途写 / 带钩子弹窗开着 / 未过期 / 已有覆盖全部写入的请求在途）都在，满足任一即不发请求', b !== null && /catalogWritesInFlight\s*>\s*0/.test(b) && /catalogHookModalOpen\(\)/.test(b) && /catalogListSeen\s*>=\s*catalogWritesDone/.test(b) && /catalogListReqSeen\s*===\s*catalogWritesDone/.test(b) && /loadModels\(\)/.test(b)); }
  { const b = bodyOf('loadModels');
    const fin = b && /finally\s*\{([\s\S]*?)\}\s*\}\s*$/.exec(b);
    check('W:track', 'loadModels：发出前记 seen = catalogWritesDone、reqId = ++catalogListReqSeq、catalogListReqSeen = seen', b !== null && /const seen = catalogWritesDone/.test(b) && /const reqId = \+\+catalogListReqSeq/.test(b) && /catalogListReqSeen = seen/.test(b));
    check('W:track', "loadModels：返回值三态——两次令牌核对后各 return 'discarded'、成功 return 'arrived' 恰 1 处，没有 return true / return false / 裸 return;", b !== null && (b.match(/if \(catalogEventState\.listToken !== token\) return 'discarded';/g) || []).length === 2 && (b.match(/return 'arrived';/g) || []).length === 1 && !/return\s+(true|false)\b/.test(b) && !/return\s*;/.test(b));
    check('W:track', 'loadModels：catalogListSeen 只在成功应用后推进（恰一处 Math.max(catalogListSeen, seen)，位于 return true 之前、不在 finally 里）', b !== null && (b.match(/catalogListSeen\s*=\s*Math\.max\(catalogListSeen,\s*seen\)/g) || []).length === 1 && b.indexOf('catalogListSeen = Math.max') < b.indexOf("return 'arrived';") && !!fin && !/catalogListSeen/.test(fin[1]));
    check('W:track', 'loadModels：finally 里仅当 catalogListReqSeq === reqId（仍是最新请求）才清 catalogListReqSeen = -1', !!fin && /if \(catalogListReqSeq === reqId\) catalogListReqSeen = -1/.test(fin[1]));
  }
  check('W:track', '已删除可变陈旧标记与旧编排（catalogStale / markCatalogStale / catalogReload / catalogOnWriteSettled / catalogReloadPending）', !/catalogStale|markCatalogStale|catalogReload\b|catalogOnWriteSettled|catalogReloadPending/.test(code));
  // ---- C4c-3 3b：列表失败（P28）/ ready 口径 / 上游名归一化 / 初始化门 / 重试接线（威胁模型：防诚实实现写错——失败不调核心、失败弹 toast、ready 提前、归一化口径漂移；不防故意绕开）----
  { const lm = bodyOf('loadModels'), ff = bodyOf('catalogFailList'), sl = bodyOf('catalogSyncListState');
    const nodeListFailed = nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && memberName(n.callee) === 'listFailed' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'ModelCatalogCore').map(n => topFnOf(n.start));
    check('W:list-fail', 'ModelCatalogCore.listFailed 在 CAT 里恰一处调用，位于 catalogFailList（失败路径只经这一个函数通知核心）', J(nodeListFailed) === J(['catalogFailList']), J(nodeListFailed));
    check('W:list-fail', "loadModels：两条非成功分支（!res || !res.ok、响应不是数组）各 return catalogFailList(token)；catch 里仅当本请求仍是最新（myToken !== 0 且 listToken === myToken）才先 console.warn('[模型目录] 列表加载失败：', e && e.message) 再 return catalogFailList(myToken)，否则 throw e（异常不被静默吞掉）", lm !== null && (lm.match(/return catalogFailList\(token\);/g) || []).length === 2 && (lm.match(/return catalogFailList\(myToken\);/g) || []).length === 1 && /if \(!res \|\| !res\.ok\) return catalogFailList\(token\);/.test(lm) && /if \(!Array\.isArray\(rows\)\) return catalogFailList\(token\);/.test(lm) && /catch \(e\) \{\s*if \(myToken !== 0 && catalogEventState\.listToken === myToken\) \{ console\.warn\('\[模型目录\] 列表加载失败：', e && e\.message\); return catalogFailList\(myToken\); \}\s*throw e;\s*\}/.test(lm));
    check('W:list-fail', 'catalogFailList：listFailed 的入参令牌是形参 token；令牌不符（discard-list）先于写事件态直接返回 discarded；随后依次 写 catalogEventState、置 catalogListError = true、catalogSyncListState()、return failed', ff !== null && /ModelCatalogCore\.listFailed\(catalogSyncState\(\), \{ token: token \}\)/.test(ff) && ff.indexOf("'discard-list'") > 0 && ff.indexOf("'discard-list'") < ff.indexOf('catalogEventState = r.state') && ff.indexOf('catalogEventState = r.state') < ff.indexOf('catalogListError = true;') && ff.indexOf('catalogListError = true;') < ff.indexOf('catalogSyncListState();') && /return 'failed';\s*\}$/.test(ff) && /return 'discarded';/.test(ff));
    check('W:list-fail', '列表失败路径全程不弹 toast：loadModels / catalogFailList / catalogSyncListState / catalogRetryList 的函数体都不出现 showToast（P28 / Q15）', ['loadModels', 'catalogFailList', 'catalogSyncListState', 'catalogRetryList'].every(n => { const x = bodyOf(n); return x !== null && !/showToast/.test(x); }));
    check('W:list-fail', 'catalogListError = true 只在 catalogFailList 里置位；= false 只在声明与 loadModels 成功套用处（与 catalogListApplied = true 同一语句行）共两处', ff !== null && (code.match(/catalogListError\s*=\s*true/g) || []).length === 1 && /catalogListError = true/.test(ff) && (code.match(/catalogListError\s*=\s*false/g) || []).length === 2 && lm !== null && /catalogListApplied = true; catalogListError = false;/.test(lm));
    const iApplied = lm ? lm.indexOf('catalogListApplied = true; catalogListError = false;') : -1;
    check('W:list-ready', 'catalogListApplied = true 全文恰一处，位于 loadModels 里 allModelsData = rows 之后、renderModelsPage() 之前（数据套用后才置位；失败路径与 finally 里没有）', (code.match(/catalogListApplied\s*=\s*true/g) || []).length === 1 && iApplied > 0 && lm.indexOf('allModelsData = rows') >= 0 && lm.indexOf('allModelsData = rows') < iApplied && iApplied < lm.indexOf('renderModelsPage();') && iApplied < lm.indexOf("return 'arrived';") && !/catalogListApplied/.test((/finally\s*\{[\s\S]*$/.exec(lm) || [''])[0]));
    check('W:list-ready', "data-catalog-state 的写入只在 catalogSyncListState：setAttribute('data-catalog-state', …) 全文恰一处且值取自 state；state = 失败 ? error : (已套用过 ? ready : 空串)；字面量 'ready' 全文只出现一次", sl !== null && (code.match(/setAttribute\(\s*'data-catalog-state'/g) || []).length === 1 && /list\.setAttribute\('data-catalog-state', state\)/.test(sl) && /const state = catalogListError \? 'error' : \(catalogListApplied \? 'ready' : ''\);/.test(sl) && (code.match(/['"]ready['"]/g) || []).length === 1);
    { const rb = bodyOf('renderModelsPage');
      check('W:list-ready', 'renderModelsPage：函数体恰一处 catalogSyncListState()，自己不写 data-catalog-state（ready 之后每次重渲染都不清，也不会在数据到达前设）', rb !== null && (rb.match(/catalogSyncListState\(\)/g) || []).length === 1 && !/data-catalog-state/.test(rb));
      check('W:list-ready', "renderModelsPage：空态「暂无模型数据」只在 totalModels === 0 且 catalogListApplied 为真（数据至少成功套用过一次）时追加——从未成功 / 数据没到时留空，不与「列表加载失败」提示矛盾；全文该文案只出现一处", rb !== null && /if \(view\.totalModels === 0 && catalogListApplied\) frag\.appendChild\(catalogEl\('div', \{ className: 'catalog-empty', role: 'listitem', text: '暂无模型数据' \}\)\);/.test(rb) && (code.match(/text: '暂无模型数据'/g) || []).length === 1); } }
  { // 上游名归一化：与后端下游候选匹配所用的 asciiLower 行为比对（读后端源码里的那一行，不写死样本答案）
    const beSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'model-center', 'model-relations.js'), 'utf8').replace(/\r\n/g, '\n');
    const bm = /^const asciiLower = (\(s\) => [^\n]*);$/m.exec(beSrc);
    const fnSrc = bodyOf('catalogAsciiLower'); const rb = bodyOf('catalogRowByTableName');
    let ok = false, detail = '';
    if (bm && fnSrc) {
      try {
        const be = new Function('return ' + bm[1])(); const ca = new Function('return ' + fnSrc.replace(/^function catalogAsciiLower/, 'function'))();
        const SAMPLES = ['ODS_W0001_DF', 'Abc_Def', 'İSTANBUL_X', 'ÀÉÎ_ΣΩ', 'dwd_x_df', '', 'ǅ_Mixed', 'ß_STRASSE'];
        const bad = SAMPLES.filter(s => be(s) !== ca(s));
        ok = bad.length === 0; detail = J(bad);
      } catch (e) { detail = String(e && e.message); }
    } else detail = '找不到后端 asciiLower 或 catalogAsciiLower';
    check('W:ascii-lower', 'catalogAsciiLower 与后端 routes/model-center/model-relations.js 的 asciiLower 在 8 个样本（含非 ASCII 的 İ / Σ / ǅ / ß）上输出逐个相等', ok, detail);
    check('W:ascii-lower', 'catalogRowByTableName：两侧都经 catalogAsciiLower 归一化（恰 2 处调用），命中恰一行才返回（hits.length === 1），否则 null（多行同名不做链接）', rb !== null && (rb.match(/catalogAsciiLower\(/g) || []).length === 2 && /hits\.length === 1 \? hits\[0\] : null/.test(rb)); }
  { const noticeAt = html.indexOf('id="catalogListNotice"'), listAt = html.indexOf('id="modelListBody"');
    check('W:list-retry', '页面有静态提示节点 #catalogListNotice（role=status、默认 hidden），位于 #modelListBody 之前（在列表容器之外，渲染列表不会冲掉它）', noticeAt > 0 && html.indexOf('id="catalogListNotice"', noticeAt + 1) < 0 && noticeAt < listAt && /<div id="catalogListNotice"[^>]*role="status"[^>]*hidden/.test(html));
    const rr = bodyOf('catalogRetryList'), is = bodyOf('initListSorting');
    check('W:list-retry', "重试：catalogRetryList 直接 loadModels()（不经 reloadCatalogIfStale 的去重）；initListSorting 把 #catalogListNotice 上 [data-catalog-act=\"retry-list\"] 的点击接到 catalogRetryList()", rr !== null && /loadModels\(\)/.test(rr) && !/reloadCatalogIfStale/.test(rr) && is !== null && /getElementById\('catalogListNotice'\)/.test(is) && /\[data-catalog-act="retry-list"\][\s\S]{0,80}catalogRetryList\(\)/.test(is) && (code.match(/catalogRetryList\(\)/g) || []).length === 2);
    check('W:list-init', "Model_Center.html 初始化：loadModels().then(async (loadResult) => { 先 if (loadResult !== 'arrived') return;，之后才是 ?focus / ?id 分支（失败 / 被取代时不跳转、不打开弹窗）", /loadModels\(\)\.then\(async \(loadResult\) => \{\s*if \(loadResult !== 'arrived'\) return;[^\n]*\n\s*if \(focusParam\) \{/.test(html)); }
  // M2：D-7 / D-14 静态判据（页面 Model_Center.html）：九个写入点里每个非 GET 的 authFetch / fetch 都被 catalogTrackWrite 包住；五个关闭钩子的最后一条语句是 reloadCatalogIfStale()
  {
    const inl = []; { const re = /<!--[\s\S]*?-->|<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m; while ((m = re.exec(html))) { if (m[0].startsWith('<!--')) continue; if (!/\ssrc\s*=/.test(m[1] || '')) inl.push(m[2]); } }
    const fnNodes = new Map();
    for (const body of inl) { let a; try { a = acorn.parse(body, { ecmaVersion: 2022, allowAwaitOutsideFunction: true }); } catch (e) { continue; } for (const n of a.body) if (n.type === 'FunctionDeclaration') fnNodes.set(n.id.name, n); }
    const walkP = (node, fn, parent) => { fn(node, parent || null); for (const k of Object.keys(node)) { const v = node[k]; if (Array.isArray(v)) v.forEach(c => { if (c && typeof c.type === 'string') walkP(c, fn, node); }); else if (v && typeof v.type === 'string') walkP(v, fn, node); } };
    const WRITE_EXPECT = { saveCustomDDL: 1, saveAllCustomETL: 3, saveEtlEdits: 2, saveAllDwdEtl: 3, silentSaveScripts: 1, runValidation: 1, autoSaveOdsScripts: 1, selfArchiveFromValidation: 1, confirmSemanticReview: 1 };
    for (const [name, expectN] of Object.entries(WRITE_EXPECT)) {
      const f = fnNodes.get(name);
      check('W:write', name + ' 在页面内联脚本里恰有 1 个顶层声明', !!f);
      if (!f) continue;
      let writes = 0, wrapped = 0, undetermined = 0;
      walkP(f, (n, parent) => {
        if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || (n.callee.name !== 'authFetch' && n.callee.name !== 'fetch')) return;
        const opt = n.arguments[1];
        if (!opt) return;   // 无第二参数 = GET
        // fail-closed（T5）：第二参数不是对象字面量、含展开、或 method 不是字面量 → 无法判定请求方法，一律判红（不靠猜）
        if (opt.type !== 'ObjectExpression' || opt.properties.some(pr => pr.type !== 'Property')) { undetermined++; return; }
        const m = opt.properties.find(pr => pr.key && (pr.key.name === 'method' || pr.key.value === 'method'));
        if (!m) return;   // 对象字面量且无 method = GET
        if (!(m.value && m.value.type === 'Literal')) { undetermined++; return; }
        const v = String(m.value.value).toUpperCase();
        if (v === 'GET') return;
        writes++;
        if (parent && parent.type === 'CallExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'catalogTrackWrite' && parent.arguments[0] === n) wrapped++;
      });
      check('W:write', name + '：没有无法判定请求方法的 fetch / authFetch 调用（第二参数须是对象字面量且 method 为字面量，或无 method = GET；否则请改为字面量或登记）（实得 ' + undetermined + ' 个）', undetermined === 0);
      check('W:write', name + '：非 GET 的写请求恰 ' + expectN + ' 个，且全部被 catalogTrackWrite(...) 包住（实得 ' + writes + ' 个 / 包住 ' + wrapped + ' 个）', writes === expectN && wrapped === writes);
    }
    for (const name of ['closeValidationModal', 'closeDimDdlPreviewModal', 'closeDimEtlPreviewModal', 'closeDwdDdlModal', 'closeDwdEtlPreviewModal']) {
      const f = fnNodes.get(name);
      const st = f ? f.body.body : [];
      const last = st[st.length - 1];
      check('W:hook', name + '：函数体最后一条语句是 reloadCatalogIfStale()', !!last && last.type === 'ExpressionStatement' && last.expression.type === 'CallExpression' && last.expression.callee.type === 'Identifier' && last.expression.callee.name === 'reloadCatalogIfStale' && last.expression.arguments.length === 0);
    }
    // 2c：MC 内联脚本里的三类调用 —— renderModelsPage（口径同 CAT）、showDesignNotesPopover（第 2 实参须是 escapeHtml(...)，气泡用 innerHTML）；逐个内联脚本解析（剥注释后数文本出现次数，防字符串里藏调用）
    { let mcRender = 0, mcRenderBad = 0, mcShows = 0, mcShowsBad = 0, mcShowsText = 0, mcUnparsed = 0, mcUnparsedBad = 0;
      for (const body of inl) {
        const cm = []; let a; try { a = acorn.parse(body, { ecmaVersion: 2022, allowAwaitOutsideFunction: true, onComment: cm }); } catch (e) { mcUnparsed++; if (/showDesignNotesPopover|renderModelsPage/.test(body)) mcUnparsedBad++; continue; }   // 2e：解析失败的块不能静默跳过——里面出现这两个名字就无法核对调用点，判红
        let bcode = body; for (const c of cm.slice().reverse()) bcode = bcode.slice(0, c.start) + ' '.repeat(c.end - c.start) + bcode.slice(c.end);
        mcShowsText += (bcode.match(/showDesignNotesPopover/g) || []).length;
        walkP(a, (n) => {
          if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier') return;
          if (n.callee.name === 'renderModelsPage') { mcRender++; if (!okRenderCall(n)) mcRenderBad++; }
          if (n.callee.name === 'showDesignNotesPopover') { mcShows++; if (!(n.arguments[1] && n.arguments[1].type === 'CallExpression' && n.arguments[1].callee.type === 'Identifier' && n.arguments[1].callee.name === 'escapeHtml')) mcShowsBad++; }
        });
      }
      const htmlStatic = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/gi, '');
      check('W:escape', 'MC 内联脚本：解析失败的块（共 ' + mcUnparsed + ' 个）里没有 showDesignNotesPopover / renderModelsPage 字样（无法解析 = 无法核对调用点，出现这两个名字即判红）', mcUnparsedBad === 0, { unparsed: mcUnparsed, withNames: mcUnparsedBad });
      check('W:render-args', 'MC 内联脚本：renderModelsPage 的每个调用点（共 ' + mcRender + ' 个）都是 0 个参数或恰为 catalogViewRaw() 的结果', mcRenderBad === 0);
      check('W:escape', 'MC 内联脚本：showDesignNotesPopover 的每个调用点（共 ' + mcShows + ' 个）第 2 实参都是 escapeHtml(...)', mcShowsBad === 0);
      check('W:escape', 'MC：showDesignNotesPopover 在内联脚本代码里的文本出现次数 = AST 调用点数（没有字符串 / 模板里藏的调用），静态 HTML（含内联属性）里一次都没有', mcShowsText === mcShows && !/showDesignNotesPopover/.test(htmlStatic), { text: mcShowsText, calls: mcShows, staticHtml: /showDesignNotesPopover/.test(htmlStatic) }); }
    // 2c：catalogCall(name, …) 经 window[name] 调用，处理函数必须是 MC 内联脚本里的 function 声明（顶层 const / let 不挂 window，调用时才会取不到）
    { const used = new Set(nodesOf(n => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'catalogCall' && n.arguments[0] && n.arguments[0].type === 'Literal').map(n => n.arguments[0].value));
      check('W:handlers', 'CAT 里 catalogCall 的处理函数名恰为 12 个（DOM 契约 8 的分发表）（实得 ' + used.size + ' 个）', used.size === 12, J(Array.from(used)));
      const missing = Array.from(used).filter(nm => !fnNodes.has(nm));
      check('W:handlers', 'catalogCall 的每个处理函数在 MC 内联脚本里都是 function 声明（不是 const / let 赋值；缺失：' + J(missing) + '）', used.size > 0 && missing.length === 0); }
  }
});

// ═════════ 八 不修改入参 ═════════
section('八 不修改入参', () => {
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(k => deepFreeze(o[k])); } return o; };
  const rows = deepFreeze(JSON.parse(J(EV_ROWS)));
  const st = deepFreeze(S0({ page: 2, expanded: [120, 22], expandTokens: { 120: 1, 22: 2 }, expandStatus: { 120: 'loaded', 22: 'error' }, relations: { 120: { a: 1 } }, seq: 2, filters: { layer: 'dwd' }, listToken: 9 }));
  const run = (name, fn) => { try { fn(); check('I1', `${name}：对深冻结入参不抛（未修改入参）`, true); } catch (e) { check('I1', `${name}：修改了入参`, false, e.message); } };
  run('computeView', () => core.computeView(rows, P20({ sortBy: 'id', sortDir: 'asc', query: 'f' })));
  run('buildGroups', () => core.buildGroups(rows));
  run('matchRow', () => core.matchRow(rows[0], 'x'));
  run('reloadStart', () => core.reloadStart(st));
  run('listArrived', () => core.listArrived(st, { token: 9, rows }));
  run('listArrived(丢弃)', () => core.listArrived(st, { token: 8, rows }));
  run('setQuery', () => core.setQuery(st, 'q'));
  run('setFilter', () => core.setFilter(st, 'layer', 'dim'));
  run('gotoPage', () => core.gotoPage(st, { page: 1, totalPages: 2 }));
  run('toggleSort', () => core.toggleSort(st, 'id'));
  run('focus', () => core.focus(st, { id: 21, rows }));
  run('toggleExpand(收起)', () => core.toggleExpand(st, { id: 22 }));
  run('toggleExpand(展开)', () => core.toggleExpand(st, { id: 30 }));
  run('relationsArrived', () => core.relationsArrived(st, { id: 22, token: 2, ok: true, data: { x: 1 } }));
  run('relationsArrived(迟到)', () => core.relationsArrived(st, { id: 22, token: 99, ok: true, data: { x: 1 } }));
  run('retryExpand', () => core.retryExpand(st, { id: 22 }));
  const rowsObj = deepFreeze(rows.concat([R({ id: 500, layer: 'dwd', table_name: 'dwd_obj_df', dim_config: { sourceTables: [{ name: 'ods_o' }] } })]));
  run('upstreamNames（对象形 dim_config）', () => { if (J(core.upstreamNames(rowsObj[rowsObj.length - 1])) !== J(['ods_o'])) throw new Error('结果不对'); });
  run('matchRow（对象形 dim_config，命中上游名）', () => { if (!core.matchRow(rowsObj[rowsObj.length - 1], 'ods_o')) throw new Error('应命中'); });
  run('computeView（含对象形 dim_config）', () => core.computeView(rowsObj, P20({ query: 'ods_o' })));
  const frozenView = deepFreeze(core.computeView(rows, P20()));
  run('locate', () => core.locate(frozenView, 21));
  run('clampPage', () => core.clampPage(3, 2));
  run('nextSort', () => core.nextSort('id', 'desc', 'id'));
  // Z1：导出表冻结（页面代码改不了核心内部使用的同一份对象）
  for (const n of ['SORT_FIELD_TYPES', 'STATUS_SORT_ORDER', 'FILTER_PREDICATES']) check('Z1', n + ' 导出表已冻结', Object.isFrozen(core[n]));
  let regOk = false;
  try { core.FILTER_PREDICATES.__probe__ = () => true; regOk = true; } catch (e) { /* 严格模式下冻结对象写入抛错 */ }
  check('Z1', '页面不能往 FILTER_PREDICATES 里注册新键', !regOk && !('__probe__' in core.FILTER_PREDICATES));
});

Promise.all(late).then(() => {
  console.log(`通过 ${pass}，失败 ${fail}`);
  console.log('各节断言数：' + Object.keys(perSection).map(k => `${k} ${perSection[k]}`).join('；'));
  process.exit(fail ? 1 : 0);
});
