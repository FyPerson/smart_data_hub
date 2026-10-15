/**
 * 模型中心目录列表代码（#77 C4a 抽出、C4b 改为调用 ModelCatalogCore、C4c-2 行结构改为 DOM 构建 + 事件委托）。
 *
 * 来源（C4a）：2026-10-07 自 Model_Center.html 逐字抽出（HEAD 4c15838b 行号区间 3351–3496、4637–5040、5228–5237、6201–6220，共 4 段，
 *   对应派单 5 个块：B1+B2 连续合并为 3351–3496）。C4c-2 起 renderModelsPage 及其行内 HTML 模板、旧下拉菜单函数已整体改写，不再是逐字搬迁件。
 *
 * 经典脚本：顶层 let / const / function 与页面内联、app.js 共享同一个全局环境。
 *   - 页面内联与 app.js 不得再声明本文件的任何顶层名（verify-model-page-shared-functions.js ⑦ 守：本文件顶层名与「目录页内联顶层名（同一取名口径，含解构名与 class 名）∪ app.js 顶层名」不得有交集；重复 let / const 会让后执行的脚本整段 SyntaxError）；
 *   - 禁止包 IIFE、禁止 'use strict'、禁止在顶层调用外部全局（求值时只做声明与 document 级监听：一条 click、一条 capture 阶段 keydown、一条 focusin（C4d-b））；
 *   - 只能由 Model_Center.html 引用（配置台页上 typeof currentPage 必须为 undefined，见 C3a-0 AC-13），Model_Workbench.html 不得引用。
 *
 * C4b：分组 / 命中 / 排序 / 分页 / 事件顺序全部由 ModelCatalogCore（assets/js/model-catalog-core.js）计算，本文件只做取数、渲染与接线：
 *   · 每页 20 组（pageSize 仍是 const pageSize = 20，含义 = 每页组数）；伴生紧跟主模型；排序作用于主模型；搜索词的唯一来源 = #searchKeyword 当前值；
 *   · allModelsData 仍是全量（后端返回的全部行，不是过滤结果）；currentPage 是「组页」；currentSortBy / currentSortDir 与 currentPage 是页码与排序的唯一状态源；
 *   · 总页数的唯一来源 = computeView().totalPages（goToPage / renderPagination / 数据重载夹紧都用它，禁止 .length / pageSize 的按行算页）；
 *   · 新增全局名：getCatalogView（只读稳定接口，纯 JSON）、applyCatalogSearch、catalogTrackWrite、catalogIsStale、reloadCatalogIfStale、catalogCheckCoreVersion、initCatalogSearch、
 *     focusCatalogModel，以及内部的 catalogEventState / catalogWritesInFlight / catalogWritesDone / catalogListSeen / catalogListReqSeen / catalogListReqSeq / catalogCoreVersionWarned / catalogViewRaw / catalogSyncState / getCatalogQuery。
 *
 * C4c-2：
 *   · 行 DOM 契约（data-id / data-group / data-act / data-entry / data-menu、菜单与置灰规则、分发表、同步要求等）冻结在 scripts/test-model-catalog-baseline-playwright.js 头部「C4c DOM 契约」，改它须同步改那里与 W 套件；
 *   · 行用 catalogEl 白名单构建函数建 DOM：文本类数据只经 textContent / el.title 写入；data-* 属性只放行白名单键（id / group / entry / model-id / act / menu / sort-by / catalog-state / focus-highlight / domain-code，C4c-3 起另有 expand-toggle / pane-act / catalog-act / open-model），
 *     其值是模型 id、组 id、动作词或业务域代码，经 setAttribute 写入（不经 HTML 解析）；domain-code 是比派单白名单多出的一项：映射到达后就地改文字时要找回该条目的原始业务域代码；
 *     本文件列表区不使用 innerHTML 拼数据（renderPagination 只插数字与固定文案，showDesignNotesPopover 只接收已转义的文本）；
 *   · 列表容器上一个 click 委托（catalogBindList，由 initListSorting 绑定）按 data-act / data-entry 分发，处理函数调用时经全局名取，不缓存引用；open-drawer 只由 Model_Center.html 的 C7 委托处理；
 *   · 菜单管理器（catalogToggleMenu / catalogCloseMenus 与 document 级 click、capture 阶段 keydown 监听）全部同步执行；任何一次 renderModelsPage 都关闭全部菜单；
 *   · 权限：每行只在 renderModelsPage 内经页内同源函数算一次，结果作为参数传给构建函数（verify-model-permission-id-types.js 守）；
 *   · 新增全局名一律 catalog 前缀（同源守卫 ⑦）。
 *
 * C4c-3（子批 3a，展开区）：
 *   · 每个条目首行最前面一个 button[data-expand-toggle][aria-expanded][aria-controls="pane-<id>"]（伴生与 viewer 也有，不带 data-act / data-entry）；点击在列表委托里同步处理：
 *     ModelCatalogCore.toggleExpand → 按 effect 发 GET /api/models/<id>/relations → 响应经 ModelCatalogCore.relationsArrived 核令牌（迟到丢弃）；展开状态与关系数据的所有权在核心，
 *     本文件只读 catalogEventState.expanded / expandStatus / relations（按不可变对待，不直接写）；
 *   · 展开区 div.pane#pane-<id> 建在条目内第二行之后，三态 loading / error（带 button[data-pane-act="retry"]，不弹 toast）/ loaded；数据只经 textContent / el.title 写入；
 *     面板里指向其他模型的链接是 button[data-open-model="<id>"]（不用 .model-open-btn，不带 data-entry），点击打开该模型的抽屉；
 *   · renderModelsPage 只给「展开集合 ∩ 当前页 pageIds」建面板（驱动与用例会直接写 currentPage，状态里的展开集合不一定都在当前页）；单个面板的更新走 catalogApplyPane（只换面板与展开按钮，不重渲染列表，免得关掉用户打开的菜单）；
 *   · 「全部收起」button[data-catalog-act="collapse-all"] 在工具条里（C4c-4 起；C4c-3 时在排序条），逐个走核心 toggleExpand 收起；
 *   · 数据重载（loadModels）成功后，listArrived 带来的 fetch-relations effect 逐个发出（旧展开内容已被核心置为加载态）。
 *
 * C4c-3（子批 3b，列表失败与 ready）：
 *   · loadModels 返回 'arrived' | 'discarded' | 'failed'；失败（非 2xx / 响应不是数组 / 网络错误 / 非 JSON，以及核心事件抛出的程序错误——后三类走 catch，一律按失败处理并在控制台记一条 warn）时经 catalogFailList 调核心 listFailed（令牌核对；在途展开里令牌已作废的 loading 变 error 可重试，旧数据保留），
 *     不弹 toast、不自动重试（P28）；失败后在列表区上方显示 #catalogListNotice：已成功过 →「列表刷新失败，显示的是上次数据」，从未成功 →「列表加载失败」，都带 button[data-catalog-act="retry-list"]，点击直接发一次列表请求；
 *   · #modelListBody[data-catalog-state]：只在「列表数据至少成功套用过一次」之后的渲染里是 "ready"；列表请求失败（直到下一次成功套用）是 "error"（旧数据仍显示）；数据到达前不设（catalogSyncListState 由 renderModelsPage 与失败路径调用）；列表区的「暂无模型数据」同样只在数据至少成功套用过一次之后显示（从未成功 / 数据还没到时留空，失败由提示说明）；
 *   · 上游名 → 列表里的模型：与后端下游候选匹配同口径（仅 ASCII 字母不区分大小写，routes/model-center/model-relations.js 的 asciiLower），归一化后命中恰一行才做链接，命中多行或命中自身一律纯文本。
 *
 * C4c-4（子批 4a，页头 + 工具条 + 筛选单一来源）：
 *   · 页头 h1「模型中心」下的在册数 #catalogTotalCount = ModelCatalogCore.railCounts(allModelsData).total（含伴生），只在列表数据成功到达时更新（catalogUpdateTotal，loadModels 套用数据后调用）；
 *     数据到达前显示「—」，失败 / 被取代都不改；注册新模型 #registerNewModelBtn 与批量导入在页头右上，工具条（div.catalog-toolbar）里是 #searchKeyword、搜索按钮、三个排序键（updated_at / domain / id）与「全部收起」；
 *   · 筛选的单一来源是模块级 catalogFilters：catalogSyncState / catalogViewRaw / getSortedModels 的 filters 一律取它，只有 catalogAdoptFilters 写它（核心返回新状态、且该事件可能改筛选时——focus、setFilter——由调用方交给它写回）；
 *   · 版本握手 mcc3（改核心 P36：搜索词 trim 后不变 / 翻到当前页 = 条件没变，不收起展开）。
 *
 * C4c-4（子批 4b，左栏）：
 *   · 左栏 aside#catalogRail（Model_Center.html 里是空壳，本文件渲染）：视图（全部模型 / 需复验 / 未接入登记 / 自定义脚本，四项恒显示）、分层（大写归一）、状态（文案同列表状态徽章）、业务域（经 /api/domains 转名称，查不到显示代码，DOMAIN_NONE 显示「未设置」）、
 *     未归属对象（4b 时为占位，4c 起见下段）；每项 button[data-rail="<组>:<值>"][aria-pressed]，各组「全部」项的值为空（data-rail="layer:"）；
 *   · 计数 = ModelCatalogCore.railCounts(allModelsData)，只在列表数据成功到达时重算（catalogRefreshRail，紧跟 catalogUpdateTotal），失败 / 被取代保留上次计数；数据从未到达过时计数显示「—」（不显示 0），分层 / 状态 / 业务域三组只有「全部」项；
 *   · 点击：同组单选，再点已选中项回到该组「全部」；经 ModelCatalogCore.setFilter → catalogAdoptFilters 写回 catalogFilters → renderModelsPage（回第 1 页、收起展开由核心负责）；该组本来就是「全部」时再点「全部」不算改筛选（不调核心）；
 *     「清除 N 项」= 对取值非「全部」的组逐个 setFilter(组, '')，最后一次写回、一次渲染（只清筛选，不清搜索词，不改排序）；
 *   · catalogAdoptFilters 每次写回后重画左栏（?focus= 深链、点击、清除都走它），所以左栏选中态与 catalogFilters 恒一致；当前选中的值不在计数里（数据重载后该值已无）时仍列出，计数 0，保证能取消。
 *
 * C4c-4（子批 4c，未归属对象）：
 *   · 左栏底部的 button#catalogRailUnowned[data-catalog-act="unowned"][aria-pressed]（内含 span#catalogRailUnownedCount）；不带 data-rail / data-act / data-entry；点击在 catalogBindRail 的委托里处理；
 *   · 数据：GET /api/model-impl-objects?unowned=1（routes/model-center/impl-objects.js 的列表路由，返回对象行 + badges，badges 形状见 routes/model-center/impl-verify.js 的 computeBadges）；
 *     只在初始化（initListSorting 末尾）与用户点「重试」「刷新」时请求，模型列表重载不重取；请求序号 catalogUnownedSeq 丢弃迟到的旧响应；成功：计数 = 数组长度；失败（非 2xx / 网络错误 / 非 JSON / 不是数组 / 元素形状不对）：计数「—」；
 *   · 未归属模式（catalogUnownedMode）：#modelListSection 加 is-unowned 类（CSS 把 .catalog-wrap 与分页隐藏，列表 DOM 与全部页面状态原样保留），#catalogUnownedPanel 显示只读对象区（标题 + 说明 + 返回按钮 + 表格 / 加载中 / 失败 + 重试 / 空态）；
 *     返回、再点入口、左栏任一筛选项或「清除 N 项」都先退出该模式（catalogSetUnownedMode(false)）；模型列表重载不退出该模式，返回时看到的是新数据；
 *   · 表格五列 类型 / 名称（schema.obj）/ 摘要 / 徽章 / 核验时间，全部经 catalogEl 的 textContent 写入；徽章格与展开区实现对象表同一个构建函数 catalogObjBadgeKids（文案 IMPL_BADGE_LABELS、色调 IMPL_BADGE_TONE、未知 code 规则都在 catalogBuildImplBadge）。
 *
 * C4c-4（子批 4d，预筛修复）：
 *   · 组字标记 catalogComposing：compositionstart 置位、compositionend 清位（清位监听先于 applyCatalogSearch 注册，所以应用搜索时标记已清）；组字期间 renderModelsPage 不更新 catalogRenderedQuery
 *     （列表照常按输入框当前值渲染，只是「当前画面所用的词」仍是组字前的词），否则组字中到达的重载会把组字文本记成旧词，提交同样文字时被判成「没改」而不收起展开；
 *   · focusCatalogModel 开头先退出未归属模式（?focus= 是明确的定位意图；不退出则清搜索 / 跳页 / 高亮都落在被隐藏的列表上）；?id= 打开编辑弹窗不依赖列表，不改；
 *   · 未归属面板在 ok 态右上有「刷新」按钮 button[data-catalog-act="refresh-unowned"]，与「重试」走同一条路径 catalogRetryUnowned（在途置灰、不可重复、迟到丢弃）；刷新失败转「加载失败」+ 重试，计数随之变「—」；
 *   · 左栏重画改为按键就地更新（catalogRailReconcile / catalogRailPatch）：键 = data-rail / id / data-catalog-act，其余按「标签 + 首个 class」配对；已存在的节点复用并对齐属性与文字，只增删变化的项。
 *     原因：旧写法每次 replaceChildren，mousedown 与 mouseup 之间发生重画（列表到达、业务域映射到达、未归属完成）时，原按钮脱离文档，浏览器不再派发 click，点击丢失。
 *
 * C4c-4（codex 41 收口，缓存串 mcat12 → mcat13；C4c-4 已提交为 12f093e1，提交后再改 CAT 必须 bump）：
 *   · 未归属面板（catalogRenderUnowned）改为就地更新：用 catalogRailReconcile 把「标题 + 说明 + 操作区（刷新 / 返回）+ 状态块或表格」对齐到现有面板，而不是每次 panel.replaceChildren——
 *     请求开始 / 完成都会调用它，整面板重建会让 mousedown 与 mouseup 之间的「返回模型列表」脱离文档、click 丢失，键盘焦点也随之丢；现在返回按钮是同一个节点，刷新 / 重试按钮只就地更新 disabled；
 *   · catalogRailPatch 补一条：旧节点是纯文字叶子、新节点有子元素时先清掉旧文字（「加载中…」→「加载失败」+ 重试按钮），否则旧文字会残留在新子元素前面；
 *   · catalogRenderRail 对齐前记下 document.activeElement，对齐后若该元素仍在左栏内却不再是焦点（选中值消失又恢复到排序位置时，reconcile 会把它 insertBefore 搬动，搬动即失焦），focus({ preventScroll: true }) 还给它；
 *   · 未归属表类型列走 catalogOrDash（空串 / 纯空白 / null / 缺失显示「—」）；展开区实现对象表的类型列不改：服务端 obj_type 恒非空（server.js model_impl_objects.obj_type TEXT NOT NULL；impl-objects.js validateObjectFields 要求 OBJ_TYPES 之一）。
 *
 * C4d-a（窄屏两档断点，缓存串 mcat13 → mcat14；整个 C4d 只 bump 这一次）：
 *   · 左栏新增折叠按钮 button.catalog-rail-toggle[data-catalog-act="rail-toggle"][aria-expanded][aria-controls]（左栏第一个子元素；文字「筛选 ▾ / ▴」+ 右侧「N 项」或「全部」，类名用 catalog-rail-toggle-lbl / -n，
 *     不用 catalog-rail-lbl / -n，免得被「左栏计数」读法算进去）；只在 ≤640px 显示（CSS 控制，>640 是 display:none，不进 Tab 序列），默认收起，状态只存在页面变量 catalogRailOpen，不持久化；
 *     catalogRenderRail 每次重画都按变量对齐按钮与 rail 的 is-open 类；aria-controls 指向左栏各分区的 id（catalogRailHead / catalogRailSecView / -Layer / -Status / -Domain / catalogRailOrphan）；
 *   · 首行状态格加类 catalog-status（与既有 catalog-acc / catalog-owner 一起供窄屏 CSS 隐藏）；第二行最前新增 div.catalog-mobile-meta（宽屏 display:none，≤640 显示）：状态徽章与最近验收格走和首行同一份构建函数
 *     （catalogBuildStatusBadge、catalogBuildAcceptance 的 rootClass 参数），负责人是 span.catalog-owner-m；不另写一套渲染逻辑。
 *
 * C4d 预筛修复批（缓存串仍 mcat14，不再 bump）：
 *   · 状态格（首行 .catalog-status 与状态徽章本身，同一个 title）与负责人格（首行 .catalog-owner 与第二行 .catalog-owner-m）补 title = 完整文字（状态显示文字、映射外原值原样；负责人全名），截断后悬停可看全文；
 *   · 最近验收摘要每个条目只算一次：catalogAcceptanceViewOf(m)（算结果，识别不了时记一条 warn）与 catalogBuildAcceptance(v, rootClass)（按结果建节点）分开，catalogBuildEntry 算一次、首行与 catalog-mobile-meta 共用；
 *   · catalogLeaveUnowned：左栏入口 #catalogRailUnowned 不可见（≤640 左栏收起时它在 display:none 的祖先下）时，焦点改放折叠按钮 .catalog-rail-toggle，两者都不可见才放弃（否则 focus() 静默失败、焦点落回 body）。
 *
 * C4d-b（可访问性七条 D-26 + LOW-9 + 带入项 ③⑤；缓存串仍 mcat14，不再 bump）：
 *   · 列表容器 #modelListBody[role="list"] 的每个直接子元素都是 role="listitem"：每个组包装 [data-group]，以及「暂无模型数据」空态；列头 div.catalog-head 去掉 role="row"、各格去掉 role="columnheader"（它们不是表格结构，这两个角色在此无效）；aria-sort 留在排序按钮上（P39）；
 *   · 焦点移出菜单关闭（LOW-9）：document 级 focusin 监听 catalogOnFocusIn——有菜单打开、新获得焦点的元素既不在该菜单内也不在它的触发按钮内（Tab / Shift+Tab 走出去）→ 关闭全部菜单，不抢焦点；菜单项之间、触发按钮 ↔ 菜单项移动不关。至此 document 级监听共三条（click、capture 阶段 keydown、focusin），回调都同步；
 *   · P40：点「清除 N 项」（catalogRailClear）之后焦点移到左栏「全部模型」（[data-rail="view:"]）——清除按钮随筛选清空被「全部」字样替换，焦点否则落回 body；
 *   · 带入项 ⑤：highlightModel 开头先退出未归属模式（MC 初始化里 ?id=X（无 edit / validate）与 dev=1 的 ODS / ADS 两条路径直接调它，未归属模式下列表被隐藏，高亮会落在看不见的列表上）。
 *
 * C4d fix42b（复看收口，缓存串 mcat14 → mcat15；mcat14 已随 9a34ad40 提交，提交后再改 CAT 必须 bump）：
 *   · catalog-mobile-meta 里的状态徽章包进 span.catalog-status-m（徽章仍只由 catalogBuildStatusBadge 构建一处）：窄屏长状态值的收缩约束写在页面自己的包装层上，不再用结构选择器去改共享层徽章的盒模型；
 *   · 业务域 span.catalog-domain 补 title = 完整显示文字（代码或映射名称；空值「未设置」不加 title）：首次渲染（catalogBuildEntry）与映射到达后就地改写（catalogApplyDomainNames）两处同口径，都取 catalogDomainTitle。
 *
 * C4e-a（配色 E，缓存串 mcat15 → mcat16；mcat15 已随 465f7d18 提交，提交后再改 CAT 必须 bump，整个 C4e 只 bump 这一次）：
 *   · renderPagination 的当前页按钮底色 / 边框由行内字面量 #d97706 改为 var(--color-accent)——#paginationControls 在 main.workbench-container 内，取 Model_Center.html 作用域 token 的 accent（#4f46e5）；
 *     其余分页按钮的灰系中性色、showDesignNotesPopover 的 #6366f1 标题色不变（气泡根 #designNotesPopover 在 Model_Center.html 的作用域列表内；气泡标题 #6366f1 不是琥珀、不在事实表范围内，C4e 保留不改）。
 *
 * C5 修复批 2（缓存串 mcat16 → mcat17；mcat16 已随 2330460d 提交，提交后再改 CAT 必须 bump）：
 *   · 对外事件：catalogTrackWrite 的 finally 里，在 catalogWritesDone++ 与 reloadCatalogIfStale() 之后向 document 派发 'modelcatalog:write-settled'——每个写请求结束（成败都算）派发一次；
 *     Model_Center.html 的抽屉监听它：在「写结束」这个因果时点判定要不要重载已打开的抽屉（与弹窗关闭时点互补）。CAT 其他任何地方零改动。
 *
 * 依赖（调用时才读）：
 *   app.js：currentUser、authFetch、escapeHtml、formatDateTimeUnified、showToast；
 *   model-catalog-core.js：ModelCatalogCore（须在本文件之前加载）；
 *   页面内联：MODEL_STATUS_MAP、mdcStatusClass、userCanEditModel、userCanValidateModel，以及分发时按全局名取的目标函数
 *     （openValidationModal / openDimETLModal / openDwdScriptModal / openDDLModal / openDimDDLModal / openDwdDDLModal / openDimConfigViewModal /
 *      openDwdConfigViewModal / openWorkbench / openEditModal / viewModelChangeLogs / deleteModel）。
 *
 * 改本文件须同时改 Model_Center.html 引用处的 ?v= 与 scripts/verify-shared-css-cache-bust.js 里的登记（指纹 + 版本 + log）。
 */

        // ==================== 分页相关变量 ====================
        let allModelsData = []; // 存储所有模型数据

        let currentPage = 1;

        const pageSize = 20; // 每页显示条数

        // ==================== v1.105.x 列表客户端排序（移植自 Data_Collab.html v1.72.1 范式）====================
        // currentSortBy = null 表示未排序，保持 allModelsData 原始顺序（不改变现有默认行为）；第三次点同列清排序回默认
        let currentSortBy = null;

        let currentSortDir = 'desc';

        // 字段类型表、状态优先级、parseSqliteTs、sortByField 已搬进 ModelCatalogCore（C4b）；目录排序一律经 ModelCatalogCore.computeView / toggleSort。

        // 事件态（C4b 只用到列表令牌与序号；展开集合与令牌留给 C4c）；页面全局（currentPage / currentSortBy / currentSortDir / 输入框）是页码、排序、搜索的唯一状态源
        let catalogEventState = null;

        // C4c-4（4a）：筛选的单一来源。catalogSyncState / catalogViewRaw / getSortedModels 的 filters 一律取它；它只在 catalogAdoptFilters 一处被写
        // （核心返回新状态、且该事件可能改筛选时——focus、setFilter——由调用方把 state.filters 交给同一个函数写回；其余事件不改 filters）。按不可变对待（核心复制后再改）。
        let catalogFilters = {};

        // C4c-4（4a，P36）：当前画面所用的搜索词（renderModelsPage 每次渲染时记下输入框当时的值）；applyCatalogSearch 用它当「旧词」与新词比较，相同则条件没变。
        let catalogRenderedQuery = '';

        // C4c-4（4d）：输入法组字中（compositionstart 置位、compositionend 清位）。组字期间 renderModelsPage 不更新 catalogRenderedQuery（见 renderModelsPage / initCatalogSearch）。
        let catalogComposing = false;

        // D-7 / D-14：列表「过期」由计数推导，没有可变的陈旧标记（避免乐观清除 / 失败恢复被多条异步路径改写）。
        //   catalogWritesInFlight：在途写请求数；catalogWritesDone：已结束（成功或失败）的写请求累计数；
        //   catalogListSeen：所有成功到达（令牌通过、listArrived 已应用）的列表请求里，「请求发出时的 catalogWritesDone」的最大值；
        //   catalogListReqSeen：最新一次在途列表请求发出时的 catalogWritesDone（没有在途请求为 -1）；catalogListReqSeq：列表请求序号，只用来判断「这次请求是否仍是最新的」。
        //   过期 ⇔ catalogListSeen < catalogWritesDone（catalogIsStale()）。重载只在「无在途写请求、没有带钩子的弹窗开着、列表过期、且没有已覆盖全部写入的列表请求在途」时发出；
        //   关闭钩子（五个关闭函数的最后一条语句）与每个写请求结束时都调用同一个 reloadCatalogIfStale()。任何路径的 loadModels()（删除 / 注册 / 批量导入 / 回退 / 本函数）成功都会推进 catalogListSeen；
        //   失败或被取代什么都不改变（仍过期，下一次关闭钩子 / 写请求结束再试），所以旧请求的失败不会污染新请求的结果。
        //   例外的入口：列表失败提示里的「重试」按钮（catalogRetryList）直接调 loadModels()，不经 reloadCatalogIfStale，因此不受上面的去重条件限制——钩子重载在途时点重试会多发一次请求，
        //   由列表序号取代（先发的那次返回 'discarded'），最终结果仍由最后一次请求决定，正确；这次多出来的请求是已知且接受的（失败后不自动重试，重试只由用户点击触发）。
        let catalogWritesInFlight = 0;
        let catalogWritesDone = 0;
        let catalogListSeen = 0;
        let catalogListReqSeen = -1;
        let catalogListReqSeq = 0;

        let catalogCoreVersionWarned = false;

        // C4c-3（3b）：列表加载结果（P28 / ready 口径）。catalogListApplied：列表数据至少成功套用过一次；catalogListError：最近一次未被取代的列表请求失败（下一次成功套用清除）。
        let catalogListApplied = false;
        let catalogListError = false;

        /** 筛选的唯一写入点：核心事件（focus / 4b 起的 setFilter）返回的新状态里的 filters 写回 catalogFilters（复制一份，不与核心状态共享引用） */
        function catalogAdoptFilters(state) {
            catalogFilters = Object.assign({}, state.filters);
            catalogRenderRail();   // 4b：左栏选中态永远跟着 catalogFilters 走
        }

        /** 页头在册数：列表数据成功到达时更新为 railCounts(allModelsData).total（含伴生）；元素不存在（别的页面 / 驱动改过 DOM）时静默跳过 */
        function catalogUpdateTotal() {
            const el = document.getElementById('catalogTotalCount');
            if (el) el.textContent = String(ModelCatalogCore.railCounts(allModelsData).total);
        }

        /** 搜索词的唯一来源：输入框当前值 */
        function getCatalogQuery() {
            const el = document.getElementById('searchKeyword');
            return el ? el.value : '';
        }

        /** 由页面全局构造事件态（令牌与序号沿用 catalogEventState） */
        function catalogSyncState() {
            if (!catalogEventState) catalogEventState = ModelCatalogCore.createState();
            return Object.assign({}, catalogEventState, {
                page: currentPage, sortBy: currentSortBy, sortDir: currentSortDir, query: getCatalogQuery(), filters: catalogFilters,
            });
        }

        /** 当前条件下的核心视图（原始返回值，含 groups[].members；locate 须用它） */
        function catalogViewRaw(page) {
            return ModelCatalogCore.computeView(allModelsData, {
                query: getCatalogQuery(), filters: catalogFilters, sortBy: currentSortBy, sortDir: currentSortDir,
                page: page === undefined ? currentPage : page, pageSize: pageSize,
            });
        }

        /** 全量视图（page 固定 1，只用 groups / orderedIds 的「全部页」部分）：locate 与「目标在哪一页」一类问题统一从它推导，不依赖当前页码 */
        function catalogFullView() {
            return catalogViewRaw(1);
        }

        /**
         * 只读稳定接口（纯 JSON，供驱动与测试读取，不含 DOM 形状）。字段语义（冻结）：
         *   page / pageGroups —— 「当前页」：currentPage 与该页的分组（[[主 id, 伴生 id…]…]，伴生紧跟主模型，只含当前页的组）；
         *   orderedIds / totalGroups / totalModels / totalPages —— 「全量」：当前搜索 / 排序条件下所有页的可见 id（按组展平）与总数，与当前页无关；
         *   query / sortBy / sortDir —— 视图依据的条件（query 读输入框当前值）；pageSize 固定 20。
         * 要「目标 id 在哪一页」用 catalogFullView() + ModelCatalogCore.locate，不要从 pageGroups 推。
         * { page, pageSize, totalPages, totalGroups, totalModels, pageGroups, orderedIds, query, sortBy, sortDir }
         */
        function getCatalogView() {
            const v = catalogViewRaw();
            return {
                page: v.page, pageSize: v.pageSize, totalPages: v.totalPages, totalGroups: v.totalGroups, totalModels: v.totalModels,
                pageGroups: v.pageGroups.map(g => g.members.map(m => m.id)), orderedIds: v.orderedIds,
                query: getCatalogQuery(), sortBy: currentSortBy, sortDir: currentSortDir,
            };
        }

        /**
         * 当前条件下可见的行，按组展平的全部页（伴生紧跟主模型）
         */
        function getSortedModels() {
            return ModelCatalogCore.computeView(allModelsData, {
                query: getCatalogQuery(), filters: catalogFilters, sortBy: currentSortBy, sortDir: currentSortDir, page: 1, pageSize: pageSize,
            }).groups.reduce((rows, g) => rows.concat(g.members), []);
        }

        /**
         * 改搜索：回第 1 页并渲染（输入即过滤，不发请求；回车与按钮幂等调用同一函数）。
         * P36（核心 mcc3）：搜索词 trim 后与「上一次渲染所用的搜索词」相同 = 条件没变，核心原样返回（不回第 1 页、不收起展开、不作废令牌）。
         * 注意 catalogSyncState().query 取的是输入框当前值（已经是新词），不能当「旧词」传给核心——这里显式换成 catalogRenderedQuery（renderModelsPage 记录的、当前画面所用的词）。
         */
        function applyCatalogSearch() {
            const r = ModelCatalogCore.setQuery(Object.assign({}, catalogSyncState(), { query: catalogRenderedQuery }), getCatalogQuery());
            catalogEventState = r.state;
            currentPage = r.state.page;
            renderModelsPage();
        }

        /**
         * 输入法组字结束时再应用一次（组字期间 oninput 的 isComposing 为真，被跳过）；compositionend 没有对应的 on* 内联属性，必须用 addEventListener。
         * 4d：另绑 compositionstart / compositionend 维护 catalogComposing；清位监听必须先于 applyCatalogSearch 注册（同一事件的监听按注册顺序执行），否则应用搜索时标记还是真，渲染不会记下提交后的词。
         */
        function initCatalogSearch() {
            const el = document.getElementById('searchKeyword');
            if (!el) return;
            el.addEventListener('compositionstart', () => { catalogComposing = true; });
            el.addEventListener('compositionend', () => { catalogComposing = false; });
            el.addEventListener('compositionend', applyCatalogSearch);
        }

        /** 带钩子的弹窗此刻是否开着：验收弹窗（静态元素，display 切换）与四个 DDL / ETL 注入式弹窗（存在即开） */
        function catalogHookModalOpen() {
            const v = document.getElementById('validationModal');
            if (v && v.style.display !== 'none' && v.style.display !== '') return true;
            return ['dimDdlPreviewModal', 'dimEtlPreviewModal', 'dwdDdlModal', 'dwdEtlPreviewModal'].some(id => !!document.getElementById(id));
        }

        /** 列表是否过期：已结束的写请求里，还有没被任何成功到达的列表请求覆盖的 */
        function catalogIsStale() {
            return catalogListSeen < catalogWritesDone;
        }

        /**
         * 写入点包装：catalogTrackWrite(authFetch(...)) / catalogTrackWrite(fetch(...))。请求在参数表达式里发出，本函数同步在途计数 +1，
         * 请求结束（成功或失败）时 −1、已结束数 +1、再调用 reloadCatalogIfStale()；返回值与原 promise 等价（失败照常抛给调用方）。
         */
        function catalogTrackWrite(promise) {
            catalogWritesInFlight++;
            return Promise.resolve(promise).finally(() => {
                catalogWritesInFlight--;
                catalogWritesDone++;
                reloadCatalogIfStale();
                document.dispatchEvent(new CustomEvent('modelcatalog:write-settled'));   // 对外事件（修复批 2）：每个写请求结束（成败都算）派发一次；此刻在途数已 −1、已结束数已 +1，监听方（Model_Center.html 的抽屉重载）读到的是结束之后的计数
            });
        }

        /** 弹窗关闭时与每个写请求结束时都调用：无在途写、没有带钩子的弹窗开着、列表未反映全部已结束的写入，且没有「已覆盖全部写入」的列表请求在途，才发一次列表请求 */
        function reloadCatalogIfStale() {
            if (catalogWritesInFlight > 0 || catalogHookModalOpen()) return;
            if (catalogListSeen >= catalogWritesDone) return;
            if (catalogListReqSeen === catalogWritesDone) return;   // 已有覆盖全部写入的请求在途；它若失败，下一次关闭钩子 / 写请求结束时再试（提示里的「重试」按钮不经本函数，直接 loadModels()，不受这条去重限制：钩子重载在途时点重试会多发一次请求，由序号取代，结果正确）
            loadModels().catch(e => console.warn('[模型目录] 数据重载失败：', e && e.message));
        }

        /** 核心与本文件分开缓存：版本不一致（多半是缓存了旧版 JS）时报一次错，口径同 mdcCheckKitVersion */
        function catalogCheckCoreVersion() {
            if (catalogCoreVersionWarned) return;
            const core = typeof ModelCatalogCore !== 'undefined' ? ModelCatalogCore : null;
            if (!core) { catalogCoreVersionWarned = true; console.error('[模型目录] model-catalog-core.js 未加载'); return; }
            if (core.CORE_VERSION !== 'mcc3') {
                catalogCoreVersionWarned = true;
                console.error('[模型目录] model-catalog-core.js 版本不匹配：期望 mcc3，实际 ' + core.CORE_VERSION +
                    '。多半是浏览器缓存了旧版 JS —— 请硬刷新（Ctrl+F5）；若是开发期，检查 Model_Center.html 里 model-catalog-core.js 的 ?v= 缓存串是否已 bump。');
            }
        }

        /**
         * ?focus：清空搜索与筛选、跳到目标所在组页、高亮 3 秒（不自动展开）；目标不存在 → 提示
         */
        function focusCatalogModel(modelId) {
            catalogSetUnownedMode(false);   // 4d：?focus= 是明确的定位意图——此刻若在未归属模式（列表被隐藏）先退出，否则下面的清搜索 / 跳页 / 高亮都落在看不见的列表上
            // 显式经核心 focus 事件：事件结果里 query = ''、filters = {}、展开集合 / 令牌 / 关系数据清空（筛选的单一来源是 catalogFilters，focus 结果经 catalogAdoptFilters 写回）；输入框的值取自事件结果
            const r = ModelCatalogCore.focus(catalogSyncState(), { id: modelId, rows: allModelsData });
            const el = document.getElementById('searchKeyword');
            if (el) el.value = r.state.query;
            catalogEventState = r.state;
            catalogAdoptFilters(r.state);   // focus 清空筛选：回写单一来源，不让页面层残留旧筛选
            currentPage = r.state.page;
            renderModelsPage();
            r.effects.forEach(e => {
                if (e.type === 'highlight') highlightModel(e.id);
                else if (e.type === 'toast') showToast(e.text, e.level);
            });
        }

        /**
         * 排序按钮点击处理（button[data-sort-by]，共 8 个键：列头 layer / table_name / status / acceptance_at / tech_owner，工具条 updated_at / domain / id）：
         * 第 1 次点 desc → 第 2 次 asc → 第 3 次清排序（回默认原始顺序）；三态由 ModelCatalogCore.toggleSort 给出
         * 排序切换后重置到第 1 页，避免停在超出新排序范围的旧页码。同时绑定列表的 click 委托（见 catalogBindList）。
         */
        function initListSorting() {
            const btns = document.querySelectorAll('button[data-sort-by]');
            btns.forEach(btn => {
                btn.addEventListener('click', () => {
                    const field = btn.dataset.sortBy;
                    const r = ModelCatalogCore.toggleSort(catalogSyncState(), field);
                    catalogEventState = r.state;
                    currentSortBy = r.state.sortBy;
                    currentSortDir = r.state.sortDir;
                    currentPage = r.state.page;
                    renderModelsPage();
                });
            });
            document.querySelectorAll('[data-catalog-act="collapse-all"]').forEach(btn => btn.addEventListener('click', catalogCollapseAll));   // C4c-3：全部收起（D-22）
            const noticeBox = document.getElementById('catalogListNotice');   // C4c-3（3b）：列表失败提示里的重试按钮（提示在列表容器外，点击直接发一次列表请求）
            if (noticeBox) noticeBox.addEventListener('click', e => { if (e.target && e.target.closest && e.target.closest('[data-catalog-act="retry-list"]')) catalogRetryList(); });
            catalogBindList();
            catalogBindRail();   // C4c-4（4b）：左栏点击委托 + 首次渲染（数据到达前计数显示「—」）
            catalogRenderRail();
            catalogBindUnowned();   // C4c-4（4c）：未归属面板的返回 / 重试委托，并与列表请求并行发一次未归属清单请求（计数与清单数据）
            catalogLoadUnowned().catch((e) => console.warn('[模型目录] 未归属对象加载异常：', e && e.message));
        }

        /**
         * 同步排序按钮的图标 + active class + aria-sort（只在激活键上有 aria-sort）
         */
        function updateSortIcons() {
            const btns = document.querySelectorAll('button[data-sort-by]');
            btns.forEach(btn => {
                const field = btn.dataset.sortBy;
                const icon = btn.querySelector('.sort-icon');
                if (currentSortBy === field) {
                    btn.classList.add('active');
                    btn.setAttribute('aria-sort', currentSortDir === 'asc' ? 'ascending' : 'descending');
                    if (icon) icon.textContent = currentSortDir === 'asc' ? '↑' : '↓';
                } else {
                    btn.classList.remove('active');
                    btn.removeAttribute('aria-sort');
                    if (icon) icon.textContent = '⇅';
                }
            });
        }

        /**
         * 数据重载（D-7 / D-13）：reloadStart 发列表令牌 → 取全量（不带 keyword，搜索在前端）→ 每个 await 之后核令牌（过期静默返回）
         * → listArrived（保留当前页并夹到最后一个非空页）→ 写回 allModelsData / currentPage → 渲染。
         * 失败（!res || !res.ok、响应不是数组、网络错误 / 非 JSON）保留旧数据与旧页码，不调 listArrived，经 catalogFailList 调核心 listFailed（C4c-3 3b）并返回 'failed'；
         * 成功渲染返回 'arrived'；被更新的请求取代返回 'discarded'（由取代它的那次请求负责结果）。网络错误 / 非 JSON / 核心事件（如 listArrived）抛出的程序错误都走 catch：只在本请求仍是最新请求（listToken 仍是自己的）时按失败处理（转失败前在控制台记一条 warn，异常不被静默吞掉），否则照旧抛出。
         * 成功应用才推进 catalogListSeen（见 catalogIsStale）。
         */
        async function loadModels() {
            const seen = catalogWritesDone;   // 本次请求发出时已结束的写请求数：成功应用后据此推进 catalogListSeen
            const reqId = ++catalogListReqSeq;
            catalogListReqSeen = seen;
            let myToken = 0;   // C4c-3（3b）：本次请求的列表令牌（网络错误 / 非 JSON 抛出时据此判断本请求是否仍是最新）
            try {
                const started = ModelCatalogCore.reloadStart(catalogSyncState());
                catalogEventState = started.state;
                const token = started.effects[0].token;
                myToken = token;
                const res = await authFetch('/api/models');
                if (catalogEventState.listToken !== token) return 'discarded';   // 被更新的请求取代：由取代它的那次请求负责结果
                if (!res || !res.ok) return catalogFailList(token);
                const rows = await res.json(); // 全量数据
                if (catalogEventState.listToken !== token) return 'discarded';
                if (!Array.isArray(rows)) return catalogFailList(token);
                const arrived = ModelCatalogCore.listArrived(catalogSyncState(), { token, rows });
                catalogEventState = arrived.state;
                allModelsData = rows; // 仍是全量，不是过滤结果
                currentPage = arrived.state.page; // 保留当前页，越界夹到最后一个非空页（D-13）
                catalogListApplied = true; catalogListError = false;   // C4c-3（3b）：数据已套用，渲染前置位（ready 口径 / 清掉失败提示）
                catalogUpdateTotal();   // C4c-4（4a）：页头在册数随数据到达更新
                catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）
                renderModelsPage(); // 渲染当前页
                catalogRunEffects(arrived.effects);   // C4c-3：保留下来的展开项重新请求关系（旧内容已被核心置为加载态，renderModelsPage 刚按它渲染）
                catalogListSeen = Math.max(catalogListSeen, seen);   // 只有成功应用才推进；失败 / 被取代不改变
                return 'arrived';
            } catch (e) {
                if (myToken !== 0 && catalogEventState.listToken === myToken) { console.warn('[模型目录] 列表加载失败：', e && e.message); return catalogFailList(myToken); }   // C4c-3（3b）：网络错误 / 非 JSON / 核心事件抛出的程序错误，且本请求仍是最新请求：记 warn 后按失败处理
                throw e;
            } finally {
                if (catalogListReqSeq === reqId) catalogListReqSeen = -1;   // 只有仍是最新请求时才清在途记录
            }
        }

        /**
         * 列表请求失败（P28，C4c-3 3b）：核心 listFailed（令牌不符 → 'discarded'；否则在途展开里令牌已作废的 loading 变 error、已 loaded 的保留、旧数据与页码不动）→ 标记失败 → 同步 ready / error 属性与提示
         * → 状态变了的展开面板就地更新（不重渲染列表）。不弹 toast，不自动重试。
         */
        function catalogFailList(token) {
            const before = catalogEventState.expandStatus;
            const r = ModelCatalogCore.listFailed(catalogSyncState(), { token: token });
            if (r.effects.some(e => e.type === 'discard-list')) return 'discarded';
            catalogEventState = r.state;
            catalogListError = true;
            catalogSyncListState();
            catalogEventState.expanded.forEach(id => { if (before[String(id)] !== catalogEventState.expandStatus[String(id)]) catalogApplyPane(id); });
            return 'failed';
        }

        /** #modelListBody[data-catalog-state] 与列表失败提示 #catalogListNotice 的同步（renderModelsPage 与失败路径调用）：失败 → error；否则成功套用过 → ready；否则（数据未到达）不设 */
        function catalogSyncListState() {
            const list = document.getElementById('modelListBody');
            const state = catalogListError ? 'error' : (catalogListApplied ? 'ready' : '');
            if (list) {
                if (state === '') list.removeAttribute('data-catalog-state');
                else list.setAttribute('data-catalog-state', state);   // 契约 11
            }
            const box = document.getElementById('catalogListNotice');
            if (!box) return;
            if (!catalogListError) { box.replaceChildren(); box.hidden = true; return; }
            const msg = catalogListApplied ? '列表刷新失败，显示的是上次数据' : '列表加载失败';
            if (!box.firstChild || box.firstChild.textContent !== msg) {
                box.replaceChildren(
                    catalogEl('span', { className: 'catalog-list-notice-msg', text: msg }),
                    catalogEl('button', { className: 'catalog-list-notice-retry', type: 'button', 'data-catalog-act': 'retry-list', text: '重试' })
                );
            }
            box.hidden = false;
        }

        /** 点提示里的「重试」：直接发一次列表请求（不经 reloadCatalogIfStale 的去重条件） */
        function catalogRetryList() {
            loadModels().catch(e => console.warn('[模型目录] 列表重试失败：', e && e.message));
        }

        // 高亮并滚动到指定模型
        function highlightModel(modelId) {
            catalogSetUnownedMode(false);   // C4d-b ⑤：?id=X / dev=1 的高亮定位也是明确的定位意图——未归属模式下列表被隐藏，先退出，否则高亮落在看不见的列表上（已处于列表模式时什么都不做）
            // 用当前条件下的核心视图算目标所在组页（与 renderModelsPage 的渲染顺序一致；id 按 String 比较）
            const loc = ModelCatalogCore.locate(catalogFullView(), modelId);   // 全量视图（与当前页无关）：跨页、过滤后、落单伴生都由核心按组定位
            if (!loc) return;

            // 目标所在的页码
            const targetPage = loc.page;
            if (targetPage !== currentPage) {
                currentPage = targetPage;
                renderModelsPage();
            }

            // 延迟执行高亮，确保 DOM 已更新（高亮 = 条目上的 data-focus-highlight 属性，底色写在页面 CSS；目标按 id 字符串比较，不拼选择器）
            setTimeout(() => {
                const key = String(modelId);
                const row = Array.from(document.querySelectorAll('#modelListBody [data-id]')).find(e => e.getAttribute('data-id') === key);
                if (row) {
                    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    row.setAttribute('data-focus-highlight', '');
                    setTimeout(() => {
                        row.removeAttribute('data-focus-highlight');
                    }, 3000);
                }
            }, 100);
        }

        // ==================== C4c-2：行 DOM 构建（数据只经 textContent / el.title 写入；DOM 契约见 scripts/test-model-catalog-baseline-playwright.js 头部）====================
        // 属性白名单：构建函数不提供 on* / href / src / style 的数据通道；data-* 键名只放行下面列出的几个（值经 setAttribute 写入：模型 id / 组 id / 动作词 / 业务域代码，不经 HTML 解析）
        const catalogAttrKeys = ['type', 'role', 'id', 'disabled', 'hidden'];
        const catalogDataKeys = ['id', 'group', 'entry', 'model-id', 'act', 'menu', 'sort-by', 'catalog-state', 'focus-highlight', 'domain-code', 'expand-toggle', 'pane-act', 'catalog-act', 'open-model', 'rail'];

        /** 白名单元素构建：opts 的键只能是 className / text / title / type / role / id / disabled / hidden / aria-* / data-<白名单>；值为 undefined / null / false 的键跳过 */
        function catalogEl(tag, opts, children) {
            const el = document.createElement(tag);
            const o = opts || {};
            Object.keys(o).forEach(k => {
                const v = o[k];
                if (v === undefined || v === null || v === false) return;
                if (k === 'className') el.className = String(v);
                else if (k === 'text') el.textContent = String(v);
                else if (k === 'title') { if (v !== '') el.title = String(v); }
                else if (catalogAttrKeys.indexOf(k) >= 0) el.setAttribute(k, v === true ? '' : String(v));
                else if (k.indexOf('aria-') === 0) el.setAttribute(k, String(v));
                else if (k.indexOf('data-') === 0 && catalogDataKeys.indexOf(k.slice(5)) >= 0) el.setAttribute(k, v === true ? '' : String(v));
                else throw new Error('catalogEl：不允许的属性 ' + k);
            });
            (children || []).forEach(c => { if (c) el.appendChild(c); });
            return el;
        }

        // 分层徽章 class（静态白名单；颜色沿用改前的五色，C4e 再改配色）
        const catalogLayerClass = { ODS: 'catalog-layer-ods', DIM: 'catalog-layer-dim', DWD: 'catalog-layer-dwd', DWS: 'catalog-layer-dws', ADS: 'catalog-layer-ads' };

        // 菜单项文案（动作词 → 可见标签）
        const catalogActLabel = {
            'etl': 'ETL 脚本', 'ddl': 'DDL', 'edit-config': '编辑配置', 'view-config': '配置（只读）', 'edit-info': '编辑信息', 'history': '变更历史', 'delete': '删除',
            'validate-structure': '结构验收', 'validate-data': '数据验收', 'validate-semantic': '语义验收', 'validate': '验收',
        };

        // 业务域：code → name 映射（GET /api/domains；到达前或失败时 null，显示代码）
        let catalogDomainNames = null;
        let catalogDomainsRequested = false;

        function catalogDomainText(code) {
            if (code === null || code === undefined || String(code).trim() === '') return '未设置';
            const key = String(code);
            if (catalogDomainNames && catalogDomainNames.has(key) && catalogDomainNames.get(key)) return catalogDomainNames.get(key);
            return key;
        }

        /** 业务域格的 title：与显示文字同口径（代码或映射名称）；空值「未设置」不加 title（返回 null） */
        function catalogDomainTitle(code) {
            if (code === null || code === undefined || String(code).trim() === '') return null;
            return catalogDomainText(code);
        }

        /** 映射到达后只就地更新各条目的业务域文字与 title，不重渲染（任何一次渲染都会关闭已打开的菜单） */
        function catalogApplyDomainNames() {
            document.querySelectorAll('#modelListBody .catalog-domain').forEach(el => {
                const code = el.getAttribute('data-domain-code');
                el.textContent = catalogDomainText(code);
                const t = catalogDomainTitle(code);
                if (t === null) el.removeAttribute('title'); else el.title = t;
            });
            catalogRenderRail();   // 4b：左栏业务域项的名称随映射到达更新
        }

        /** 首次渲染时发一次业务域映射请求。/api/domains 只返回启用域（server.js 的 status = 'active' 过滤）：停用域在映射里查不到，显示代码（已知行为，P31）；失败只 console.warn，保持显示代码 */
        function catalogLoadDomains() {
            if (catalogDomainsRequested) return;
            catalogDomainsRequested = true;
            authFetch('/api/domains').then(res => {
                if (!res || !res.ok) return null;
                return res.json();
            }).then(rows => {
                if (!Array.isArray(rows)) return;
                const map = new Map();
                rows.forEach(d => { if (d && d.code !== null && d.code !== undefined) map.set(String(d.code), d.name === null || d.name === undefined ? '' : String(d.name)); });
                catalogDomainNames = map;
                catalogApplyDomainNames();
            }).catch(e => console.warn('[模型目录] 业务域映射加载失败，显示业务域代码：', e && e.message));
        }

        // ==================== C4c-4（4b）：左栏（数据只经 textContent / data-rail 属性写入，不经 HTML 解析）====================
        const catalogRailKeys = ['view', 'layer', 'status', 'domain'];   // 左栏四组筛选，键与核心 FILTER_PREDICATES 一致
        const catalogRailLayerDot = { ODS: 'dot-ods', DIM: 'dot-dim', DWD: 'dot-dwd', DWS: 'dot-dws', ADS: 'dot-ads' };   // 圆点色块的 class 只来自静态表，不拼数据
        const catalogRailStatusDot = { CREATED: 'dot-created', DEVELOPING: 'dot-developing', REVIEWING: 'dot-reviewing', ONLINE: 'dot-online', OFFLINE: 'dot-offline' };
        let catalogRailCounts = null;   // 最近一次成功到达的列表数据算出的 railCounts(allModelsData)；null = 数据还没到达过
        let catalogRailBound = false;
        // C4c-4（4c）：未归属对象。catalogUnownedStatus：loading（首次请求在途 / 尚未发出）| ok | error；catalogUnownedBusy：有请求在途；catalogUnownedSeq：请求序号（只认最新一次）
        let catalogUnownedMode = false;
        let catalogUnownedStatus = 'loading';
        let catalogUnownedRows = null;
        let catalogUnownedBusy = false;
        let catalogUnownedSeq = 0;
        let catalogUnownedBound = false;
        // C4d-a：≤640px 的左栏折叠状态（默认收起；只存在页面变量里，不持久化；>640 时按钮不显示，此变量无可见效果）
        let catalogRailOpen = false;

        /** 一组筛选的当前取值：'' = 该组「全部」（视图的 'all' 也算「全部」） */
        function catalogRailValue(key) {
            const v = catalogFilters[key];
            if (v === null || v === undefined || v === '') return '';
            if (key === 'view' && v === 'all') return '';
            return String(v);
        }

        /** 取值相同（分层不分大小写，与核心 FILTER_PREDICATES.layer 同口径） */
        function catalogRailSame(key, a, b) {
            return key === 'layer' ? String(a).toUpperCase() === String(b).toUpperCase() : String(a) === String(b);
        }

        function catalogRailActiveCount() {
            return catalogRailKeys.filter(k => catalogRailValue(k) !== '').length;
        }

        /** 状态项文案：与列表状态徽章同一映射（MODEL_STATUS_MAP），映射里没有的状态显示原值 */
        function catalogStatusText(status) {
            return Object.prototype.hasOwnProperty.call(MODEL_STATUS_MAP, status) ? MODEL_STATUS_MAP[status] : String(status);
        }

        /** 一个左栏项：value 为空 = 该组「全部」；count 为 null 显示「—」 */
        function catalogRailItem(key, value, label, count, dot, warn) {
            const on = catalogRailSame(key, catalogRailValue(key), value);
            const cls = ['catalog-rail-item'];
            if (on) cls.push('is-on');
            if (value === '') cls.push('is-def');
            if (warn) cls.push('is-warn');
            const kids = [];
            if (dot) kids.push(catalogEl('span', { className: 'catalog-rail-dot ' + dot, 'aria-hidden': 'true' }));
            kids.push(catalogEl('span', { className: 'catalog-rail-lbl', text: label }));
            kids.push(catalogEl('span', { className: 'catalog-rail-n', text: count === null ? '—' : String(count) }));
            return catalogEl('button', { className: cls.join(' '), type: 'button', 'data-rail': key + ':' + value, 'aria-pressed': on ? 'true' : 'false' }, kids);
        }

        /** 一组的取值列表：计数里出现过的值；当前选中的值不在其中（数据重载后已无）时补一项计数 0，保证选中态可见、能取消 */
        function catalogRailList(key, list) {
            const rows = list.slice();
            const sel = catalogRailValue(key);
            if (sel !== '' && !rows.some(r => catalogRailSame(key, r.value, sel))) rows.push({ value: sel, count: 0 });
            return rows;
        }

        function catalogRailSection(title, items, id) {
            return catalogEl('div', { className: 'catalog-rail-sec', id: id }, [catalogEl('h5', { text: title })].concat(items));
        }

        /** 就地更新用的键（左栏；codex 41 起未归属面板同用）：左栏项取 data-rail，有 id 的取 id，清除按钮取 data-catalog-act；都没有的按「标签 + 首个 class」配对（同键多个时按出现顺序一一配对） */
        function catalogRailKey(el) {
            const r = el.getAttribute('data-rail');
            if (r !== null) return 'r:' + r;
            if (el.id) return 'i:' + el.id;
            const a = el.getAttribute('data-catalog-act');
            if (a !== null) return 'a:' + a;
            return 't:' + el.tagName + '.' + String(el.className).split(' ')[0];
        }

        /** 把 oldEl 就地改成 freshEl 的样子：属性逐个对齐；叶子元素（没有子元素）对齐文字；有子元素的递归对齐子节点 */
        function catalogRailPatch(oldEl, freshEl) {
            Array.from(oldEl.attributes).forEach(a => { if (!freshEl.hasAttribute(a.name)) oldEl.removeAttribute(a.name); });
            Array.from(freshEl.attributes).forEach(a => { if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value); });
            if (freshEl.children.length === 0) {
                if (oldEl.children.length > 0 || oldEl.textContent !== freshEl.textContent) oldEl.textContent = freshEl.textContent;
                return;
            }
            if (oldEl.children.length === 0 && oldEl.textContent !== '') oldEl.textContent = '';   // codex 41：旧节点是纯文字叶子、新节点有子元素（「加载中…」→「加载失败」+ 重试）：先清掉旧文字，否则它残留在新子元素之前
            catalogRailReconcile(oldEl, Array.from(freshEl.children));
        }

        /** 让 parent 的子元素序列等于 fresh：键相同的旧节点复用（就地对齐），旧节点里没配上的删除，新键的插入；顺序已对的节点不移动 */
        function catalogRailReconcile(parent, fresh) {
            const pool = new Map();
            Array.from(parent.children).forEach(el => { const k = catalogRailKey(el); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(el); });
            const keep = fresh.map(f => {
                const q = pool.get(catalogRailKey(f));
                if (q && q.length > 0) { const o = q.shift(); catalogRailPatch(o, f); return o; }
                return f;
            });
            pool.forEach(q => q.forEach(el => el.remove()));
            keep.forEach((el, i) => { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });
        }

        /** 重画左栏（同步）：计数取 catalogRailCounts，选中态取 catalogFilters；按键就地更新（已存在的按钮复用，焦点与进行中的点击都不受影响） */
        function catalogRenderRail() {
            const rail = document.getElementById('catalogRail');
            if (!rail) return;
            const focused = document.activeElement;   // codex 41-L1：reconcile 可能把有焦点的按钮 insertBefore 搬动（搬动即失焦），对齐后归还
            const c = catalogRailCounts;
            const total = c ? c.total : null;
            const n = catalogRailActiveCount();
            // C4d-a：≤640px 的折叠按钮（左栏第一个子元素）；aria-controls 列出被它显示 / 隐藏的各区块 id；文字与「N 项」随筛选与折叠状态对齐
            const toggle = catalogEl('button', {
                className: 'catalog-rail-toggle', type: 'button', 'data-catalog-act': 'rail-toggle', 'aria-expanded': catalogRailOpen ? 'true' : 'false',
                'aria-controls': 'catalogRailHead catalogRailSecView catalogRailSecLayer catalogRailSecStatus catalogRailSecDomain catalogRailOrphan',
            }, [
                catalogEl('span', { className: 'catalog-rail-toggle-lbl', text: '筛选 ' + (catalogRailOpen ? '▴' : '▾') }),
                catalogEl('span', { className: 'catalog-rail-toggle-n', text: n > 0 ? n + ' 项' : '全部' }),
            ]);
            rail.classList.toggle('is-open', catalogRailOpen);
            const head = catalogEl('div', { className: 'catalog-rail-head', id: 'catalogRailHead' }, [
                catalogEl('b', { text: '筛选' }),
                n > 0 ? catalogEl('button', { className: 'catalog-rail-clear', type: 'button', 'data-catalog-act': 'rail-clear', text: '清除 ' + n + ' 项' }) : catalogEl('span', { className: 'catalog-rail-all', text: '全部' }),
            ]);
            const viewSec = catalogRailSection('视图', [
                catalogRailItem('view', '', '全部模型', c ? c.view.all : null, 'dot-all', false),
                catalogRailItem('view', 'stale', '需复验', c ? c.view.stale : null, 'dot-stale', true),
                catalogRailItem('view', 'pending', '未接入登记', c ? c.view.pending : null, 'dot-pending', false),
                catalogRailItem('view', 'custom', '自定义脚本', c ? c.view.custom : null, 'dot-custom', false),
            ], 'catalogRailSecView');
            const layerSec = catalogRailSection('分层', [catalogRailItem('layer', '', '全部', total, 'dot-all', false)].concat(
                catalogRailList('layer', c ? c.layer : []).map(r => catalogRailItem('layer', r.value, r.value, r.count, catalogRailLayerDot[r.value] || '', false))), 'catalogRailSecLayer');
            const statusSec = catalogRailSection('状态', [catalogRailItem('status', '', '全部', total, 'dot-all', false)].concat(
                catalogRailList('status', c ? c.status : []).map(r => catalogRailItem('status', r.value, catalogStatusText(r.value), r.count, Object.prototype.hasOwnProperty.call(catalogRailStatusDot, r.value) ? catalogRailStatusDot[r.value] : '', false))), 'catalogRailSecStatus');
            const domainSec = catalogRailSection('业务域', [catalogRailItem('domain', '', '全部', total, 'dot-all', false)].concat(
                catalogRailList('domain', c ? c.domain : []).map(r => catalogRailItem('domain', r.value, r.value === ModelCatalogCore.DOMAIN_NONE ? '未设置' : catalogDomainText(r.value), r.count, '', false))), 'catalogRailSecDomain');
            const orphan = catalogEl('div', { className: 'catalog-rail-orphan', id: 'catalogRailOrphan' }, [
                catalogEl('h5', { text: '未归属对象' }),
                catalogEl('button', { className: 'catalog-rail-item catalog-rail-orphan-btn' + (catalogUnownedMode ? ' is-on' : ''), type: 'button', id: 'catalogRailUnowned', 'data-catalog-act': 'unowned', 'aria-pressed': catalogUnownedMode ? 'true' : 'false' }, [
                    catalogEl('span', { className: 'catalog-rail-lbl', text: '对象清单' }),
                    catalogEl('span', { className: 'catalog-rail-n', id: 'catalogRailUnownedCount', text: catalogUnownedCountText() }),
                ]),
                catalogEl('div', { className: 'catalog-rail-fine', text: '登记了但没挂到任何模型的运维对象' }),
            ]);
            catalogRailReconcile(rail, [toggle, head, viewSec, layerSec, statusSec, domainSec, orphan]);
            if (focused && focused !== document.activeElement && rail.contains(focused)) focused.focus({ preventScroll: true });   // codex 41-L1
        }

        /** 列表数据成功到达时调用（紧跟 catalogUpdateTotal）：重算计数并重画左栏；失败 / 被取代的路径不调用，保留上次计数 */
        function catalogRefreshRail() {
            catalogRailCounts = ModelCatalogCore.railCounts(allModelsData);
            catalogRenderRail();
        }

        /** 点左栏某项（spec = "<组>:<值>"）：同组单选；再点已选中项回到该组「全部」；该组本来就是「全部」时再点「全部」什么都不做 */
        function catalogRailPick(spec) {
            const text = String(spec);
            const at = text.indexOf(':');
            if (at < 0) return;
            const key = text.slice(0, at);
            const value = text.slice(at + 1);
            if (catalogRailKeys.indexOf(key) < 0) return;
            catalogSetUnownedMode(false);   // 4c：未归属模式下点任一筛选项——先退出（同「返回」），再按 4b 现行为执行
            const cur = catalogRailValue(key);
            const next = catalogRailSame(key, cur, value) ? '' : value;
            if (next === cur) return;
            const r = ModelCatalogCore.setFilter(catalogSyncState(), key, next);
            catalogEventState = r.state;
            catalogAdoptFilters(r.state);
            currentPage = r.state.page;
            renderModelsPage();
        }

        /** 「清除 N 项」：对取值非「全部」的组逐个交给核心 setFilter(组, '')（核心没有批量接口），最后一次写回、一次渲染；只清筛选，搜索词与排序不动 */
        function catalogRailClear() {
            catalogSetUnownedMode(false);   // 4c：未归属模式下点「清除 N 项」——先退出，再清筛选
            const keys = catalogRailKeys.filter(k => catalogRailValue(k) !== '');
            if (keys.length === 0) return;
            let acc = catalogSyncState();
            keys.forEach(k => { acc = ModelCatalogCore.setFilter(acc, k, '').state; });
            catalogEventState = acc;
            catalogAdoptFilters(acc);
            currentPage = acc.page;
            renderModelsPage();
            const allView = document.querySelector('#catalogRail [data-rail="view:"]');   // C4d-b P40：清除按钮随筛选清空消失，焦点移到左栏「全部模型」（否则落回 body）
            if (allView) allView.focus({ preventScroll: true });
        }

        /** C4d-a：≤640px 折叠按钮——翻转页面变量并重画左栏（按钮就地更新，焦点留在按钮上） */
        function catalogToggleRail() {
            catalogRailOpen = !catalogRailOpen;
            catalogRenderRail();
        }

        /** 左栏的 click 委托（绑在 #catalogRail 上；重画只替换子节点，监听不丢） */
        function catalogBindRail() {
            const rail = document.getElementById('catalogRail');
            if (!rail || catalogRailBound) return;
            catalogRailBound = true;
            rail.addEventListener('click', e => {
                const t = e.target;
                if (!t || !t.closest) return;
                const tg = t.closest('[data-catalog-act="rail-toggle"]');
                if (tg && rail.contains(tg)) { catalogToggleRail(); return; }
                const un = t.closest('[data-catalog-act="unowned"]');
                if (un && rail.contains(un)) { catalogToggleUnowned(); return; }
                const clr = t.closest('[data-catalog-act="rail-clear"]');
                if (clr && rail.contains(clr)) { catalogRailClear(); return; }
                const item = t.closest('[data-rail]');
                if (item && rail.contains(item)) catalogRailPick(item.getAttribute('data-rail'));
            });
        }

        // ==================== C4c-4（4c）：未归属对象（只读清单，在列表区就地替换；数据只经 textContent 写入）====================
        /** 左栏入口上的计数：请求成功 = 数组长度；加载中 / 失败 =「—」 */
        function catalogUnownedCountText() {
            return catalogUnownedStatus === 'ok' && Array.isArray(catalogUnownedRows) ? String(catalogUnownedRows.length) : '—';
        }

        /**
         * 未归属响应的形状校验：必须是数组，每个元素是对象，obj_name 非空字符串，obj_type / schema_name / summary / verified_at 为字符串或空，badges 为对象或空（doc / reg 字符串或空；failure 为对象，at / error 字符串或空）。
         * 不符合一律按加载失败处理（不渲染半截数据，也不静默丢掉坏元素）。字段取自 routes/model-center/impl-objects.js 的列表路由（OBJECT_COLS + badges）。
         */
        function catalogValidUnowned(rows) {
            if (!Array.isArray(rows)) return false;
            const strOrNull = (v) => v === undefined || v === null || typeof v === 'string';
            const failOk = (f) => f === undefined || f === null || (catalogIsObj(f) && strOrNull(f.at) && strOrNull(f.error));
            const badgesOk = (b) => b === undefined || b === null || (catalogIsObj(b) && strOrNull(b.doc) && strOrNull(b.reg) && failOk(b.failure));
            return rows.every((o) => catalogIsObj(o) && typeof o.obj_name === 'string' && o.obj_name !== '' && strOrNull(o.obj_type) && strOrNull(o.schema_name) && strOrNull(o.summary) && strOrNull(o.verified_at) && badgesOk(o.badges));
        }

        /** 空字符串 / 纯空白 → 「—」，其余原样（textContent 写入） */
        function catalogOrDash(v) {
            const s = catalogText(v);
            return s.trim() === '' ? '—' : s;
        }

        /** 表格：类型 / 名称（schema 为空只显示 obj_name）/ 摘要 / 徽章（与展开区同一个 catalogObjBadgeKids）/ 核验时间 */
        function catalogBuildUnownedTable(rows) {
            const head = catalogEl('tr', {}, ['类型', '名称', '摘要', '徽章', '核验时间'].map((t) => catalogEl('th', { text: t })));
            const trs = rows.map((o) => catalogEl('tr', {}, [
                catalogEl('td', { className: 'catalog-obj-type', text: catalogOrDash(o.obj_type) }),
                catalogEl('td', { className: 'catalog-obj-name', text: (o.schema_name ? String(o.schema_name) + '.' : '') + catalogText(o.obj_name) }),
                catalogEl('td', { className: 'catalog-obj-summary', text: catalogOrDash(o.summary) }),
                catalogEl('td', { className: 'catalog-obj-badges' }, catalogObjBadgeKids(o)),
                catalogEl('td', { className: 'catalog-obj-time', text: catalogOrDash(o.verified_at) }),
            ]));
            return catalogEl('table', { className: 'catalog-objtable catalog-unowned-table' }, [catalogEl('thead', {}, [head]), catalogEl('tbody', {}, trs)]);
        }

        /** 重画未归属区（同步）：切换 #modelListSection 的 is-unowned 类与面板的 hidden；模式开着时按状态就地更新面板内容（加载中 / 失败 + 重试 / 空态 / 表格；codex 41：不整面板重建，返回按钮等节点保持同一个，焦点与进行中的点击不受请求开始 / 完成时的重画影响） */
        function catalogRenderUnowned() {
            const section = document.getElementById('modelListSection');
            if (section) section.classList.toggle('is-unowned', catalogUnownedMode);
            const panel = document.getElementById('catalogUnownedPanel');
            if (!panel) return;
            panel.hidden = !catalogUnownedMode;
            if (!catalogUnownedMode) return;
            let body;
            if (catalogUnownedStatus === 'ok') {
                body = catalogUnownedRows.length === 0
                    ? catalogEl('div', { className: 'catalog-unowned-state', text: '没有未归属对象' })
                    : catalogBuildUnownedTable(catalogUnownedRows);
            } else if (catalogUnownedStatus === 'error') {
                body = catalogEl('div', { className: 'catalog-unowned-state is-error' }, [
                    catalogEl('span', { className: 'catalog-unowned-msg', text: '加载失败' }),
                    catalogEl('button', { className: 'catalog-unowned-retry', type: 'button', 'data-catalog-act': 'retry-unowned', disabled: catalogUnownedBusy, text: '重试' }),
                ]);
            } else {
                body = catalogEl('div', { className: 'catalog-unowned-state', text: '加载中…' });
            }
            const actions = [
                catalogUnownedStatus === 'ok' ? catalogEl('button', { className: 'catalog-unowned-refresh', type: 'button', 'data-catalog-act': 'refresh-unowned', disabled: catalogUnownedBusy, text: '刷新' }) : null,
                catalogEl('button', { className: 'catalog-unowned-back', type: 'button', 'data-catalog-act': 'unowned-back', text: '返回模型列表' }),
            ];
            catalogRailReconcile(panel, [
                catalogEl('div', { className: 'catalog-unowned-head' }, [
                    catalogEl('div', {}, [
                        catalogEl('h3', { className: 'catalog-unowned-title', text: '未归属对象' }),
                        catalogEl('p', { className: 'catalog-unowned-desc', text: '登记了但没挂到任何模型的运维对象（零条有效关系的未删除对象），只读清单。' }),
                    ]),
                    catalogEl('div', { className: 'catalog-unowned-actions' }, actions),
                ]),
                body
            ]);
        }

        /** 进入 / 退出未归属模式（已处于目标模式什么都不做）。进入时关掉列表里打开的菜单；列表 DOM 与页码 / 排序 / 搜索 / 筛选 / 展开状态都不动，所以返回即恢复原样 */
        function catalogSetUnownedMode(on) {
            if (catalogUnownedMode === on) return;
            catalogUnownedMode = on;
            if (on) catalogCloseMenus();
            catalogRenderUnowned();
            catalogRenderRail();
        }

        function catalogToggleUnowned() {
            catalogSetUnownedMode(!catalogUnownedMode);
        }

        /** 点「返回模型列表」：退出模式，焦点放回左栏入口（原按钮随面板隐藏） */
        function catalogLeaveUnowned() {
            catalogSetUnownedMode(false);
            const shown = (el) => !!el && el.getClientRects().length > 0;   // display:none 的元素（含 display:none 祖先下的）没有盒子，focus() 会静默失败
            const un = document.getElementById('catalogRailUnowned');
            if (shown(un)) { un.focus({ preventScroll: true }); return; }
            const tg = document.querySelector('#catalogRail .catalog-rail-toggle');   // ≤640 左栏收起：入口不可见，焦点改放折叠按钮
            if (shown(tg)) tg.focus({ preventScroll: true });
        }

        /** 点「重试」或 ok 态的「刷新」（同一条路径）：有请求在途时什么都不做（按钮此时也是置灰的） */
        function catalogRetryUnowned() {
            if (catalogUnownedBusy) return;
            catalogLoadUnowned().catch((e) => console.warn('[模型目录] 未归属对象重试失败：', e && e.message));
        }

        /** 未归属面板上的 click 委托（返回 / 重试 / 刷新；面板就地更新，监听与按钮节点都不丢） */
        function catalogBindUnowned() {
            const panel = document.getElementById('catalogUnownedPanel');
            if (!panel || catalogUnownedBound) return;
            catalogUnownedBound = true;
            panel.addEventListener('click', (e) => {
                const t = e.target;
                if (!t || !t.closest) return;
                const back = t.closest('[data-catalog-act="unowned-back"]');
                if (back && panel.contains(back)) { catalogLeaveUnowned(); return; }
                const retry = t.closest('[data-catalog-act="retry-unowned"]');
                if (retry && panel.contains(retry)) { if (!retry.disabled) catalogRetryUnowned(); return; }
                const refresh = t.closest('[data-catalog-act="refresh-unowned"]');
                if (refresh && panel.contains(refresh)) { if (!refresh.disabled) catalogRetryUnowned(); }
            });
        }

        /**
         * 取一次未归属清单：只在初始化与用户点重试 / 刷新时调用（模型列表重载不重取）。每次调用取新序号，迟到的旧响应（序号不是最新）整个丢弃，不动状态、不重画。
         * 成功 → ok + 行；失败（非 2xx / 网络错误 / 非 JSON / 形状不对）→ error，不弹 toast。返回 'ok' | 'failed' | 'discarded'。
         */
        async function catalogLoadUnowned() {
            const seq = ++catalogUnownedSeq;
            catalogUnownedBusy = true;
            catalogRenderUnowned();
            let rows = null;
            try {
                const res = await authFetch('/api/model-impl-objects?unowned=1');
                if (seq !== catalogUnownedSeq) return 'discarded';
                if (res && res.ok) {
                    const data = await res.json();
                    if (seq !== catalogUnownedSeq) return 'discarded';
                    if (catalogValidUnowned(data)) rows = data;
                }
            } catch (e) {
                if (seq !== catalogUnownedSeq) return 'discarded';
                console.warn('[模型目录] 未归属对象加载失败：', e && e.message);
            }
            catalogUnownedBusy = false;
            catalogUnownedRows = rows;
            catalogUnownedStatus = rows === null ? 'error' : 'ok';
            catalogRenderRail();
            catalogRenderUnowned();
            return rows === null ? 'failed' : 'ok';
        }

        /** 一行的操作规格（手写规则，对应改前 6 按钮布局 + P-U1 / D-18 / D-19）：{ validate: { kind: direct|menu|disabled, item | items }, more: [项…] }；项 = { act, enabled, reason } */
        function catalogActionSpecs(m, layer, canEdit, canValidate) {
            const isCompanion = !!m.companion_of;
            const isODS = layer === 'ODS';
            const isDIM = layer === 'DIM';
            const isDWD = layer === 'DWD';
            const it = (act, enabled, reason) => ({ act: act, enabled: enabled, reason: reason || '' });
            let validate;
            if (isCompanion) validate = { kind: 'disabled', item: it('validate', false, '伴生表无需独立验收') };
            else if (canValidate) {
                if (isODS) validate = { kind: 'direct', item: it('validate', true) };
                else if (isDIM) validate = { kind: 'menu', items: [it('validate-structure', true), it('validate-data', true), it('validate-semantic', true)] };
                else validate = { kind: 'menu', items: [it('validate-structure', true), it('validate-data', true)] };
            } else validate = { kind: 'disabled', item: it('validate', false, '无验收权限') };
            const more = [];
            if (isCompanion) more.push(it('etl', false, '伴生表写入逻辑在主表增量 ETL 的 Step 3 中'));
            else if (isODS) more.push(it('etl', false, 'ODS 同步由 FDL 工具管理'));
            else if (isDIM || isDWD) more.push(it('etl', true));
            else more.push(it('etl', false, '暂不支持'));
            if (isCompanion) more.push(it('ddl', false, '请在主表 DDL 弹窗中切换「伴生表 DDL」标签页查看'));
            else if (isODS || isDIM || isDWD) more.push(it('ddl', true));
            else more.push(it('ddl', false, '暂不支持'));
            if (isCompanion) {
                more.push(it('view-config', true, '伴生表配置由主表自动管理（只读）'));
                more.push(canEdit ? it('edit-info', true) : it('edit-info', false, '无编辑权限'));   // P-U1 / Q7：伴生行开放「编辑信息」，按编辑权限
            } else if ((isDIM || isDWD) && canEdit) {
                more.push(it('edit-config', true));
                more.push(it('edit-info', true));
            } else if (isDIM || isDWD) {
                more.push(it('view-config', true, isDIM ? '查看 DIM 配置（只读）' : '查看 DWD 配置（只读）'));
            } else {
                if (isODS) more.push(it('edit-config', false, 'ODS 无平台配置，请用编辑信息'));   // D-18
                more.push(canEdit ? it('edit-info', true) : it('edit-info', false, '无编辑权限'));
            }
            more.push(it('history', true, '查看变更历史'));
            if (isCompanion) more.push(it('delete', false, '伴生表随主模型的变更追踪开关增删'));   // P-U1：伴生行删除一律置灰，原因优先于权限文案
            else more.push(canEdit ? it('delete', true) : it('delete', false, '无删除权限'));
            return { validate: validate, more: more };
        }

        /** 菜单项：button[role=menuitem][data-act]；置灰项 = disabled + aria-disabled，原因同时写在 title 与可见的 .model-menu-reason 里（文本逐字相同） */
        function catalogMenuItem(spec) {
            const kids = [catalogEl('span', { className: 'catalog-menu-label', text: catalogActLabel[spec.act] })];
            if (!spec.enabled && spec.reason) kids.push(catalogEl('span', { className: 'model-menu-reason', text: spec.reason }));
            return catalogEl('button', {
                className: 'catalog-menu-item', type: 'button', role: 'menuitem', 'data-act': spec.act,
                title: spec.reason, disabled: !spec.enabled, 'aria-disabled': spec.enabled ? null : 'true',
            }, kids);
        }

        /** 触发按钮 + 同条目内部渲染时建好的菜单（关闭带 hidden）；菜单 id 用模型 id 拼出，全页唯一 */
        function catalogBuildMenu(kind, modelId, triggerText, ariaLabel, items) {
            const menuId = 'catalog-menu-' + kind + '-' + modelId;
            const trigger = catalogEl('button', {
                className: 'catalog-menu-trigger', type: 'button', 'data-menu': kind, 'aria-haspopup': 'menu',
                'aria-expanded': 'false', 'aria-controls': menuId, 'aria-label': ariaLabel, text: triggerText,
            });
            const menu = catalogEl('div', { className: 'catalog-menu', id: menuId, role: 'menu', hidden: true }, items.map(catalogMenuItem));
            return catalogEl('span', { className: 'catalog-menu-wrap' }, [trigger, menu]);
        }

        /** 操作区（viewer 不建）：验收（直接按钮 | 阶段菜单 | 置灰按钮）+ ⋯ 菜单 */
        function catalogBuildActions(m, specs) {
            const modelId = String(m.id);
            const v = specs.validate;
            const first = v.kind === 'menu'
                ? catalogBuildMenu('validate', modelId, '验收 ▾', '验收', v.items)
                : catalogEl('button', {
                    className: 'catalog-act-btn', type: 'button', 'data-act': v.item.act, title: v.item.reason,
                    disabled: !v.item.enabled, 'aria-disabled': v.item.enabled ? null : 'true', text: '验收',
                });
            return catalogEl('div', { className: 'model-row-actions' }, [first, catalogBuildMenu('more', modelId, '⋯', '更多操作', specs.more)]);
        }

        /** 最近验收格：文本来自 ModelCatalogCore.acceptanceView（text 已含符号，页面不再拼）；有日期追加 MM-DD，陈旧追加「需复验」；unknown 带 title */
        function catalogAcceptanceViewOf(m) {
            let v;
            try {
                v = ModelCatalogCore.acceptanceView(m.acceptance);
            } catch (e) {
                console.warn('[模型目录] 验收摘要无法识别（模型 ' + m.id + '）：', e && e.message);
                v = { kind: 'unknown', text: '—', date: '', staleBadge: false, title: '验收摘要无法识别' };
            }
            return v;
        }

        /** 按 catalogAcceptanceViewOf 的结果建最近验收格（首行与 ≤640 第二行共用同一份结果，一个条目只算一次） */
        function catalogBuildAcceptance(v, rootClass) {
            const kids = [catalogEl('span', { className: 'catalog-acc-text catalog-acc-' + v.kind, text: v.text })];
            if (v.date) kids.push(catalogEl('span', { className: 'catalog-acc-date', text: v.date }));
            if (v.staleBadge) kids.push(catalogEl('span', { className: 'catalog-acc-recheck', text: '需复验' }));
            return catalogEl('div', { className: rootClass || 'catalog-cell catalog-acc', title: v.title }, kids);
        }

        function catalogCount(n) {
            const x = Number(n);
            return Number.isFinite(x) ? x : 0;
        }

        // ==================== C4c-3（3a）：展开区（数据只经 textContent / el.title 写入；关系数据只读 catalogEventState.relations，按不可变对待）====================
        const catalogBadgeHint = { doc: '文档 ↔ 生产：不一致 = 有人绕过审查改了生产（事故级）', reg: '模型中心登记 ↔ 生产：不一致 = 登记过期（卫生级）' };
        const catalogBadgePrefix = { doc: '文档 ', reg: '登记 ' };
        const catalogObjStates = ['listed', 'companion', 'standard', 'pending'];

        function catalogIsObj(x) {
            return !!x && typeof x === 'object' && !Array.isArray(x);
        }

        function catalogText(v) {
            return v === null || v === undefined ? '' : String(v);
        }

        /**
         * /relations 响应的形状校验：不符合一律按加载失败处理（展开区显示重试），不渲染半截数据，也不用 filter 静默丢掉坏元素（codex 40 M1）。
         * 形状取自服务端真实返回（routes/model-center/model-relations.js、impl-objects.js 的 listModelObjects）：只校验展示用到的字段，类型为 string | null（缺省视同 null）；数字 id 必须是正整数。
         *   · upstream 每项：对象；name（DIM / DWD，model-detail-normalize.js 的 extractSources 元素）、source_system / source_table（ODS）为字符串或空；
         *   · downstream 每项（DOWNSTREAM_FIELDS）：对象；id 正整数、table_name 非空字符串、table_comment 字符串或空；
         *   · objects 每项：对象；obj_name 非空字符串（必填）、obj_type / schema_name / summary / role / verified_at 字符串或空、badges 为对象（doc / reg 字符串或空；failure 为对象，at / error 字符串或空）。
         */
        function catalogValidRelations(d) {
            if (!(catalogIsObj(d) && Array.isArray(d.upstream) && Array.isArray(d.downstream) && Array.isArray(d.objects) && catalogObjStates.indexOf(d.objectState) >= 0)) return false;
            const strOrNull = (v) => v === undefined || v === null || typeof v === 'string';
            const upOk = (u) => catalogIsObj(u) && strOrNull(u.name) && strOrNull(u.source_system) && strOrNull(u.source_table);
            const downOk = (x) => catalogIsObj(x) && typeof x.id === 'number' && Number.isInteger(x.id) && x.id > 0 && typeof x.table_name === 'string' && x.table_name !== '' && strOrNull(x.table_comment);
            const failOk = (f) => f === undefined || f === null || (catalogIsObj(f) && strOrNull(f.at) && strOrNull(f.error));
            const badgesOk = (b) => b === undefined || b === null || (catalogIsObj(b) && strOrNull(b.doc) && strOrNull(b.reg) && failOk(b.failure));
            const objOk = (o) => catalogIsObj(o) && typeof o.obj_name === 'string' && o.obj_name !== '' && strOrNull(o.obj_type) && strOrNull(o.schema_name) && strOrNull(o.summary) && strOrNull(o.role) && strOrNull(o.verified_at) && badgesOk(o.badges);
            return d.upstream.every(upOk) && d.downstream.every(downOk) && d.objects.every(objOk);
        }

        /** 展开集合 ∩ 当前页：只返回当前页上的展开 id（String，顺序随展开集合）；驱动与用例会直接写 currentPage，状态里的展开集合不一定都在当前页 */
        function catalogExpandedOnPage(view) {
            const onPage = new Set(view.pageIds.map(String));
            const expanded = catalogEventState ? catalogEventState.expanded : [];
            return expanded.map(String).filter(id => onPage.has(id));
        }

        function catalogBuildExpandToggle(m, expanded) {
            return catalogEl('button', {
                className: 'catalog-expand-btn', type: 'button', 'data-expand-toggle': true,
                'aria-expanded': expanded ? 'true' : 'false', 'aria-controls': 'pane-' + String(m.id),
                'aria-label': '展开 ' + String(m.table_name) + ' 的关系', text: '▶',
            });
        }

        /** 指向其他模型的链接：button[data-open-model="<id>"]（不用 .model-open-btn，不带 data-entry / data-act；DOM 契约 2） */
        function catalogModelLink(modelId, text) {
            return catalogEl('button', { className: 'catalog-model-link', type: 'button', 'data-open-model': String(modelId), text: text });
        }

        /** 仅 ASCII 字母转小写——与后端下游候选匹配的名字归一化逐字同口径（routes/model-center/model-relations.js:29-30 的 asciiLower；model-catalog-core.js:173 另有同源副本但未导出）；不用 toLowerCase，它会改动非 ASCII 字符 */
        function catalogAsciiLower(s) {
            return String(s).replace(/[A-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 32); });
        }

        /** 上游名 → 列表里的模型行：按 catalogAsciiLower 归一化后相等，且恰命中一行才返回该行；0 行或多于 1 行（归一化后同名）返回 null */
        function catalogRowByTableName(name) {
            const key = catalogAsciiLower(name);
            const hits = allModelsData.filter(r => catalogAsciiLower(r.table_name === null || r.table_name === undefined ? '' : r.table_name) === key);
            return hits.length === 1 ? hits[0] : null;
        }

        function catalogFlowCol(title, count, bodyKids) {
            const head = catalogEl('h4', { className: 'catalog-flow-title' }, [catalogEl('span', { text: title }), count === null ? null : catalogEl('span', { className: 'catalog-flow-count', text: String(count) })]);
            return catalogEl('div', { className: 'catalog-flow-col' }, [head].concat(bodyKids));
        }

        /** 上游：伴生 → 「随主模型 #<companion_of> 生成」（D-34）；ODS → 「源系统 · 源表」；其余 → 名称（等于列表里某个表名的做成链接，其余纯文本） */
        function catalogBuildUpstream(m, rel) {
            const layer = String(m.layer === null || m.layer === undefined ? '' : m.layer).toUpperCase();
            if (m.companion_of) {
                return catalogFlowCol('上游', null, [catalogEl('div', { className: 'catalog-flow-item catalog-flow-companion' }, [
                    catalogEl('span', { text: '随主模型 ' }), catalogModelLink(m.companion_of, '#' + m.companion_of), catalogEl('span', { text: ' 生成' }),
                ])]);
            }
            const up = rel.upstream;   // 逐项形状已在 catalogValidRelations 校验（坏元素整体判失败，不静默丢弃）
            const kids = up.map(u => {
                if (layer === 'ODS') {
                    const parts = [u.source_system, u.source_table].filter(x => x !== null && x !== undefined && String(x) !== '').map(String);
                    return catalogEl('div', { className: 'catalog-flow-item' }, [catalogEl('span', { className: 'catalog-plain', text: parts.join(' · ') })]);
                }
                const name = catalogText(u.name);
                const hit = name === '' ? null : catalogRowByTableName(name);
                return catalogEl('div', { className: 'catalog-flow-item' }, [hit && String(hit.id) !== String(m.id) ? catalogModelLink(hit.id, name) : catalogEl('span', { className: 'catalog-plain', text: name })]);
            });
            if (kids.length === 0) kids.push(catalogEl('div', { className: 'catalog-flow-empty', text: '无' }));
            return catalogFlowCol('上游', up.length, kids);
        }

        /** 下游：链接 + 中文短名，附提示「按平台配置候选匹配」；为空显示「未发现下游引用」 */
        function catalogBuildDownstream(rel) {
            const down = rel.downstream;
            const kids = [];
            if (down.length === 0) {
                kids.push(catalogEl('div', { className: 'catalog-flow-empty', text: '未发现下游引用' }));
            } else {
                down.forEach(d => kids.push(catalogEl('div', { className: 'catalog-flow-item' }, [
                    catalogModelLink(d.id, catalogText(d.table_name)),
                    d.table_comment ? catalogEl('span', { className: 'catalog-flow-desc', text: String(d.table_comment) }) : null,
                ])));
                kids.push(catalogEl('div', { className: 'catalog-flow-hint', text: '按平台配置候选匹配' }));
            }
            return catalogFlowCol('下游引用', down.length, kids);
        }

        /** 一枚一致性徽章：文案取 ModelCatalogCore.IMPL_BADGE_LABELS，色调取 IMPL_BADGE_TONE（D-35）；null 显示「—」；verify_failed 的悬停写失败时间与错误 */
        function catalogBuildImplBadge(kind, code, failure) {
            if (code === null || code === undefined) return catalogEl('span', { className: 'catalog-cons-none', text: '—' });
            const labels = ModelCatalogCore.IMPL_BADGE_LABELS;
            const known = Object.prototype.hasOwnProperty.call(labels, code);
            const tone = known ? ModelCatalogCore.IMPL_BADGE_TONE[code] : 'muted';
            let hint = catalogBadgeHint[kind];
            if (code === 'verify_failed' && catalogIsObj(failure)) hint = '核验失败于 ' + (failure.at ? String(failure.at) : '（时间未知）') + '：' + (failure.error ? String(failure.error) : '（无错误信息）');
            return catalogEl('span', { className: 'catalog-cons-badge catalog-cons-' + tone, title: hint, text: catalogBadgePrefix[kind] + (known ? labels[code] : String(code)) });
        }

        /** 一个实现对象的徽章格内容（展开区实现对象表与 4c 未归属表共用）：doc / reg 都为空（FDL_TASK / TABLE 两类）→ 单个「—」；否则「文档 …」「登记 …」两枚 */
        function catalogObjBadgeKids(o) {
            const b = catalogIsObj(o.badges) ? o.badges : {};
            const doc = b.doc === undefined ? null : b.doc;
            const reg = b.reg === undefined ? null : b.reg;
            return (doc === null && reg === null)
                ? [catalogBuildImplBadge('doc', null)]
                : [catalogBuildImplBadge('doc', doc, b.failure), catalogBuildImplBadge('reg', reg, b.failure)];
        }

        function catalogBuildObjectTable(objs) {
            const head = catalogEl('tr', {}, ['类型', '对象', '职责', '三端一致性', '核验'].map(t => catalogEl('th', { text: t })));
            const rows = objs.map(o => {
                const badgeKids = catalogObjBadgeKids(o);
                return catalogEl('tr', {}, [
                    catalogEl('td', { className: 'catalog-obj-type', text: catalogText(o.obj_type) }),
                    catalogEl('td', { className: 'catalog-obj-name', title: catalogText(o.summary), text: (o.schema_name ? String(o.schema_name) + '.' : '') + catalogText(o.obj_name) }),
                    catalogEl('td', { className: 'catalog-obj-role', text: o.role ? String(o.role) : '—' }),
                    catalogEl('td', { className: 'catalog-obj-badges' }, badgeKids),
                    catalogEl('td', { className: 'catalog-obj-time', text: o.verified_at ? String(o.verified_at) : '—' }),
                ]);
            });
            return catalogEl('table', { className: 'catalog-objtable' }, [catalogEl('thead', {}, [head]), catalogEl('tbody', {}, rows)]);
        }

        /** 实现对象：listed → 表格 + 提示；companion / standard / pending → 三种空态（文案照 demo v0.4） */
        function catalogBuildObjectBox(m, rel) {
            const st = rel.objectState;
            const objs = rel.objects;
            let body;
            if (st === 'listed') {
                body = [catalogBuildObjectTable(objs), catalogEl('div', { className: 'catalog-flow-hint', text: '核验超过 7 天自动降为「待重核」' })];
            } else if (st === 'companion') {
                body = [catalogEl('div', { className: 'catalog-objstate catalog-objstate-companion' }, [
                    catalogEl('span', { text: '↳ 伴生表：随主模型 ' }), m.companion_of ? catalogModelLink(m.companion_of, '#' + m.companion_of) : catalogEl('span', { text: '—' }), catalogEl('span', { text: ' 生成，实现对象登记在主模型下' }),
                ])];
            } else if (st === 'standard') {
                body = [catalogEl('div', { className: 'catalog-objstate catalog-objstate-standard' }, [
                    catalogEl('span', { text: '▢ 标准配置模型：由平台生成，实现对象只有目标表本身 ' }), catalogEl('span', { className: 'catalog-mono', text: String(m.table_name) }),
                ])];
            } else {
                body = [catalogEl('div', { className: 'catalog-objstate catalog-objstate-pending', text: '◌ 未接入登记：这是自定义脚本模型，过程 / 视图 / 任务还没登记进来（数仓 #18）' })];
            }
            const head = catalogEl('h4', { className: 'catalog-flow-title' }, [catalogEl('span', { text: '实现对象' }), st === 'listed' ? catalogEl('span', { className: 'catalog-flow-count', text: objs.length + ' 个' }) : null]);
            return catalogEl('div', { className: 'catalog-objbox' }, [head].concat(body));
        }

        /** 展开区 div.pane#pane-<id>：loading「加载中…」/ error「关系加载失败」+ 重试 / loaded 上游 → 本模型 → 下游 + 实现对象；不带 data-id / data-entry / data-act */
        function catalogBuildPane(m, status, rel) {
            const key = String(m.id);
            const paneOpts = (state) => ({ className: 'pane catalog-pane catalog-pane-' + state, id: 'pane-' + key });
            if (status === 'error' || (status === 'loaded' && !catalogIsObj(rel))) {
                return catalogEl('div', paneOpts('error'), [
                    catalogEl('span', { className: 'catalog-pane-msg', text: '关系加载失败' }),
                    catalogEl('button', { className: 'catalog-pane-retry', type: 'button', 'data-pane-act': 'retry', text: '重试' }),
                ]);
            }
            if (status === 'loaded') {
                const arrow = () => catalogEl('div', { className: 'catalog-flow-arrow', 'aria-hidden': 'true', text: '→' });
                const flow = catalogEl('div', { className: 'catalog-flow' }, [
                    catalogBuildUpstream(m, rel), arrow(),
                    catalogEl('div', { className: 'catalog-flow-me' }, [catalogEl('span', { className: 'catalog-flow-melabel', text: '本模型' }), catalogEl('span', { className: 'catalog-flow-metable', text: String(m.table_name) })]),
                    arrow(), catalogBuildDownstream(rel),
                ]);
                return catalogEl('div', paneOpts('loaded'), [flow, catalogBuildObjectBox(m, rel)]);
            }
            return catalogEl('div', paneOpts('loading'), [catalogEl('span', { className: 'catalog-pane-msg', text: '加载中…' })]);
        }

        /** 按事件态建某个条目的面板（关系数据只读 catalogEventState.relations[<id>]） */
        function catalogMakePane(key) {
            const st = catalogEventState;
            const m = catalogRowOf(key);
            if (!st || !m) return null;
            return catalogBuildPane(m, st.expandStatus[key], st.relations[key]);
        }

        function catalogEntryEl(key) {
            return Array.from(document.querySelectorAll('#modelListBody [data-id]')).find(e => e.getAttribute('data-id') === key) || null;
        }

        /** 按事件态更新单个条目的展开区：同步展开按钮的 aria-expanded、替换 / 新建 / 撤掉面板；条目不在当前页什么都不做。不重渲染列表（重渲染会关掉用户打开的菜单） */
        function catalogApplyPane(id) {
            const key = String(id);
            const entry = catalogEntryEl(key);
            if (!entry) return;
            const open = !!catalogEventState && catalogEventState.expanded.some(x => String(x) === key);
            const toggle = entry.querySelector('[data-expand-toggle]');
            if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            const old = Array.from(entry.children).find(c => c.classList.contains('pane')) || null;
            const pane = open ? catalogMakePane(key) : null;
            if (old && pane) old.replaceWith(pane);
            else if (old) old.remove();
            else if (pane) entry.appendChild(pane);
        }

        /** 核心事件给出的 fetch-relations effect 逐个发出（请求本身是异步的，失败都落成 error 态，不抛） */
        function catalogRunEffects(effects) {
            (effects || []).forEach(e => { if (e && e.type === 'fetch-relations') catalogFetchRelations(e.id, e.token).catch(err => console.warn('[模型目录] 关系响应处理失败（模型 ' + e.id + '）：', err && err.message)); });   // 处理阶段（核心事件 / 面板替换）的异常也不留未处理的拒绝
        }

        /** 点展开按钮：核心 toggleExpand（展开 → loading + fetch-relations；收起 → 清令牌与关系数据） */
        function catalogToggleExpand(id) {
            const r = ModelCatalogCore.toggleExpand(catalogSyncState(), { id: id });
            catalogEventState = r.state;
            catalogApplyPane(id);
            catalogRunEffects(r.effects);
        }

        /** 点面板里的「重试」：核心 retryExpand（仅 error 态会重发） */
        function catalogRetryExpand(id) {
            const r = ModelCatalogCore.retryExpand(catalogSyncState(), { id: id });
            catalogEventState = r.state;
            catalogApplyPane(id);
            catalogRunEffects(r.effects);
        }

        /** 全部收起：对展开集合里的每个 id 走核心 toggleExpand（已展开 → 收起），再把当前页的面板撤掉 */
        function catalogCollapseAll() {
            let s = catalogSyncState();
            const ids = s.expanded.slice();
            ids.forEach(id => { s = ModelCatalogCore.toggleExpand(s, { id: id }).state; });
            catalogEventState = s;
            ids.forEach(id => catalogApplyPane(id));
        }

        /** 面板里的模型链接：打开该模型的抽屉（openModelDrawer 调用时经全局名取；链接节点作 opener） */
        function catalogOpenModel(btn) {
            const id = Number(btn.getAttribute('data-open-model'));
            if (!Number.isInteger(id) || id <= 0) return;
            if (typeof openModelDrawer !== 'function') { console.error('[catalog] 处理函数不存在：openModelDrawer'); return; }
            openModelDrawer(id, btn);
        }

        async function catalogRequestRelations(id) {
            try {
                const res = await authFetch('/api/models/' + encodeURIComponent(String(id)) + '/relations');
                if (!res || !res.ok) return { ok: false };
                const data = await res.json();
                return catalogValidRelations(data) ? { ok: true, data: data } : { ok: false };
            } catch (e) {
                console.warn('[模型目录] 关系加载失败（模型 ' + id + '）：', e && e.message);
                return { ok: false };
            }
        }

        /** 一次关系请求：唯一的 await 之后立刻经核心 relationsArrived 核令牌（已收起 / 已翻页 / 已重载 / 被新请求取代 → discard-relations，不动状态与 DOM） */
        async function catalogFetchRelations(id, token) {
            const got = await catalogRequestRelations(id);
            const r = ModelCatalogCore.relationsArrived(catalogSyncState(), { id: id, token: token, ok: got.ok, data: got.data });
            if (r.effects.some(e => e.type === 'discard-relations')) return;
            catalogEventState = r.state;
            catalogApplyPane(id);
        }

        /** 状态徽章（D-33，唯一的徽章 class 写法，verify-badge-alias.js 的 gate 形态）：首行状态格与 ≤640 的第二行开头容器共用这一个构建函数 */
        function catalogBuildStatusBadge(m) {
            const statusText = Object.prototype.hasOwnProperty.call(MODEL_STATUS_MAP, m.status) ? MODEL_STATUS_MAP[m.status] : m.status;
            return catalogEl('span', { className: 'u-status-badge ' + mdcStatusClass(m.status), title: statusText, text: statusText });
        }

        /** 一个模型条目（主模型与伴生都是 [data-id]）：首行 = 展开按钮 / 分层 / 表名+中文短名+标签 / 状态 / 最近验收 / 负责人 / 操作；第二行 = #id / 实现说明首句 / 业务域 / 更新时间 / 关系计数；展开区（pane）由 renderModelsPage / catalogApplyPane 追加 */
        function catalogBuildEntry(m, canEdit, canValidate, isViewer, expanded) {
            const layer = String(m.layer === null || m.layer === undefined ? '' : m.layer).toUpperCase();
            const isCompanion = !!m.companion_of;
            const isCustom = m.config_mode === 'custom';
            const modelId = String(m.id);
            const ownerText = m.tech_owner ? m.tech_owner : '-';

            const openBtn = catalogEl('button', {
                className: 'model-open-btn', type: 'button', 'data-entry': 'open-drawer', 'data-model-id': modelId,
                title: String(m.table_name) + (isCompanion ? ' [变更追踪伴生表]' : '') + (isCustom ? ' [手工模式]' : '') + '（点击查看详情）',
                text: m.table_name,
            });
            const mainKids = [openBtn];
            if (m.table_comment) mainKids.push(catalogEl('span', { className: 'catalog-comment', text: m.table_comment }));
            if (m.category === 'core') mainKids.push(catalogEl('span', { className: 'catalog-tag catalog-tag-core', text: '核心' }));
            if (isCustom) mainKids.push(catalogEl('span', { className: 'catalog-tag catalog-tag-custom', text: '自定义脚本' }));
            if (isCompanion) mainKids.push(catalogEl('span', { className: 'catalog-tag catalog-tag-companion', text: '伴生' }));
            if (m.design_notes) {
                mainKids.push(catalogEl('button', { className: 'catalog-notes-btn', type: 'button', 'data-entry': 'design-notes', title: '查看设计说明', 'aria-label': '查看设计说明', text: 'ⓘ' }));
            }

            const statusBadge = catalogBuildStatusBadge(m);   // 状态徽章（D-33）：构建函数见 catalogBuildStatusBadge
            const accView = catalogAcceptanceViewOf(m);   // 最近验收摘要：一个条目只算一次，首行与第二行容器共用
            const ownerTitle = m.tech_owner ? String(m.tech_owner) : null;   // 负责人全名（占位「-」不加 title）
            const row1Kids = [
                catalogBuildExpandToggle(m, expanded),
                catalogEl('span', { className: 'catalog-layer ' + (catalogLayerClass[layer] || 'catalog-layer-other'), text: layer }),
                catalogEl('div', { className: 'catalog-main' }, mainKids),
                catalogEl('div', { className: 'catalog-cell catalog-status', title: statusBadge.title }, [statusBadge]),
                catalogBuildAcceptance(accView),
                catalogEl('div', { className: 'catalog-cell catalog-owner', title: ownerTitle, text: ownerText }),
            ];
            if (!isViewer) row1Kids.push(catalogBuildActions(m, catalogActionSpecs(m, layer, canEdit, canValidate)));

            const impl = ModelCatalogCore.firstSentence(m.impl_note);
            const rel = m.rel === null || m.rel === undefined ? null : m.rel;
            const row2Kids = [
                // C4d-a：≤640px 才显示（宽屏 display:none）的容器——状态与最近验收（以及负责人）挪到第二行最前；与首行同一份数据、同一批构建函数
                catalogEl('div', { className: 'catalog-mobile-meta' }, [
                    // fix42b：状态徽章的页面包装层——窄屏长状态值的收缩约束写在它上面（Model_Center.html 的 .catalog-status-m），不用结构选择器去改共享层徽章
                    catalogEl('span', { className: 'catalog-status-m' }, [catalogBuildStatusBadge(m)]),
                    catalogBuildAcceptance(accView, 'catalog-cell catalog-acc-m'),
                    catalogEl('span', { className: 'catalog-owner-m', title: ownerTitle, text: ownerText }),
                ]),
                catalogEl('span', { className: 'catalog-id', text: '#' + modelId }),
                catalogEl('span', { className: 'catalog-impl' + (impl === '' ? ' catalog-impl-empty' : ''), title: impl === '' ? '' : String(m.impl_note).trim(), text: impl === '' ? '（未填写实现说明）' : impl }),
                catalogEl('span', { className: 'catalog-domain', title: catalogDomainTitle(m.domain), 'data-domain-code': m.domain === null || m.domain === undefined ? '' : String(m.domain), text: catalogDomainText(m.domain) }),
                catalogEl('span', { className: 'catalog-updated', text: formatDateTimeUnified(m.updated_at) }),
                catalogEl('span', { className: 'catalog-rel', text: rel === null ? '—' : '对象 ' + catalogCount(rel.obj) + ' · 上游 ' + catalogCount(rel.up) + ' · 下游 ' + catalogCount(rel.down) }),
            ];

            return catalogEl('div', { className: 'catalog-entry' + (isCompanion ? ' is-companion' : ''), 'data-id': modelId }, [
                catalogEl('div', { className: 'catalog-row1' }, row1Kids),
                catalogEl('div', { className: 'catalog-row2' }, row2Kids),
            ]);
        }

        // 渲染当前页的模型列表。view 可选：事件处理函数算好一份视图后传入（一次事件一份视图）；不传则自己经 catalogViewRaw() 算一次（驱动直接写 currentPage = p; renderModelsPage()）
        function renderModelsPage(view) {
            view = view || catalogViewRaw(); // C4b：经核心按组分页（不在渲染里夹紧页码）
            if (!catalogComposing) { catalogRenderedQuery = getCatalogQuery(); }   // C4c-4（4a，P36）：记下这次画面所用的搜索词；4d：组字期间不记（列表照常渲染，但旧词仍是组字前的词）

            // 角色说明：viewer=只读, user=数据开发, publisher=发布者, admin=管理员
            const isViewer = !!(currentUser && currentUser.role === 'viewer');
            const list = document.getElementById('modelListBody');

            // 列头「操作」格：viewer 隐藏但节点保留
            const opHeader = document.getElementById('modelListOpHeader');
            if (opHeader) opHeader.style.display = isViewer ? 'none' : '';

            catalogCloseMenus();   // 任何一次渲染都关闭全部菜单

            const expandedHere = catalogExpandedOnPage(view);   // C4c-3：展开集合 ∩ 当前页 pageIds（驱动会直接写 currentPage，状态里的展开集合不一定都在当前页）
            const expandedSet = new Set(expandedHere);
            const entryEls = new Map();
            const frag = document.createDocumentFragment();
            // 「暂无模型数据」只在数据至少成功套用过一次之后显示：从未成功（首次加载失败 / 数据还没到）时列表区留空，失败由 #catalogListNotice 说明，不矛盾（C4c-3 3c）
            if (view.totalModels === 0 && catalogListApplied) frag.appendChild(catalogEl('div', { className: 'catalog-empty', role: 'listitem', text: '暂无模型数据' }));
            view.pageGroups.forEach(g => {
                const kids = [];
                if (g.orphan) kids.push(catalogEl('div', { className: 'catalog-group-head', text: '主模型不在列表中' }));   // D-15：落单伴生组头
                g.members.forEach(m => {
                    // 权限判断（#77 P22）：页内内联的同源函数，经全局名调用，每行只算一次；ID 一律 String() 比较
                    const canEditThisModel = userCanEditModel(m);
                    const canValidateThisModel = userCanValidateModel(m);
                    const entryEl = catalogBuildEntry(m, canEditThisModel, canValidateThisModel, isViewer, expandedSet.has(String(m.id)));
                    entryEls.set(String(m.id), entryEl);
                    kids.push(entryEl);
                });
                frag.appendChild(catalogEl('div', { className: 'catalog-group', role: 'listitem', 'data-group': g.id }, kids));
            });
            expandedHere.forEach(key => entryEls.get(key).appendChild(catalogMakePane(key)));   // 展开区：只给「展开集合 ∩ 当前页」的条目建，loading / error / loaded 由事件态决定
            list.replaceChildren(frag);

            // 同步列头 / 排序条的图标 + active + aria-sort
            updateSortIcons();

            // 渲染分页控件
            renderPagination(view);

            catalogSyncListState();   // 契约 11：数据至少成功套用过一次后才是 "ready"（失败 "error"，数据到达前不设）；之后每次重渲染都不清
            catalogLoadDomains();   // 业务域映射：首次渲染时发一次请求
        }

        // 渲染分页控件
        function renderPagination(view) {
            const totalCount = view.totalModels;
            const totalPages = view.totalPages;
            const infoEl = document.getElementById('paginationInfo');
            const controlsEl = document.getElementById('paginationControls');

            // 如果总数为0或只有一页，隐藏分页
            if (totalCount === 0) {
                infoEl.innerHTML = '';
                controlsEl.innerHTML = '';
                return;
            }

            // 显示统计信息
            const startNum = (currentPage - 1) * pageSize + 1;
            const endNum = Math.min(currentPage * pageSize, view.totalGroups);
            infoEl.innerHTML = `共 <strong>${view.totalGroups}</strong> 组（${totalCount} 个模型），显示第 ${startNum}-${endNum} 组`;

            // 如果只有一页，不显示分页按钮
            if (totalPages <= 1) {
                controlsEl.innerHTML = '';
                return;
            }

            // 生成分页按钮
            let paginationHTML = '';

            // 上一页按钮
            const prevDisabled = currentPage === 1;
            paginationHTML += `<button onclick="goToPage(${currentPage - 1})"
                style="padding:6px 12px; border:1px solid ${prevDisabled ? '#e2e8f0' : '#cbd5e0'}; background:${prevDisabled ? '#f8fafc' : 'white'};
                border-radius:4px; cursor:${prevDisabled ? 'not-allowed' : 'pointer'}; color:${prevDisabled ? '#a0aec0' : '#4a5568'}; font-size:0.85em;"
                ${prevDisabled ? 'disabled' : ''}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polyline points="15 18 9 12 15 6"/></svg>
                上一页
            </button>`;

            // 页码按钮（最多显示5个页码）
            const maxVisiblePages = 5;
            let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
            let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
            if (endPage - startPage + 1 < maxVisiblePages) {
                startPage = Math.max(1, endPage - maxVisiblePages + 1);
            }

            // 第一页 + 省略号
            if (startPage > 1) {
                paginationHTML += `<button onclick="goToPage(1)" style="padding:6px 10px; border:1px solid #cbd5e0; background:white; border-radius:4px; cursor:pointer; color:#4a5568; font-size:0.85em; min-width:32px;">1</button>`;
                if (startPage > 2) {
                    paginationHTML += `<span style="padding:0 5px; color:#a0aec0;">...</span>`;
                }
            }

            // 中间页码
            for (let i = startPage; i <= endPage; i++) {
                const isActive = i === currentPage;
                paginationHTML += `<button onclick="goToPage(${i})"
                    style="padding:6px 10px; border:1px solid ${isActive ? 'var(--color-accent)' : '#cbd5e0'};
                    background:${isActive ? 'var(--color-accent)' : 'white'}; color:${isActive ? 'white' : '#4a5568'};
                    border-radius:4px; cursor:pointer; font-size:0.85em; min-width:32px; font-weight:${isActive ? '600' : 'normal'};">${i}</button>`;
            }

            // 省略号 + 最后一页
            if (endPage < totalPages) {
                if (endPage < totalPages - 1) {
                    paginationHTML += `<span style="padding:0 5px; color:#a0aec0;">...</span>`;
                }
                paginationHTML += `<button onclick="goToPage(${totalPages})" style="padding:6px 10px; border:1px solid #cbd5e0; background:white; border-radius:4px; cursor:pointer; color:#4a5568; font-size:0.85em; min-width:32px;">${totalPages}</button>`;
            }

            // 下一页按钮
            const nextDisabled = currentPage === totalPages;
            paginationHTML += `<button onclick="goToPage(${currentPage + 1})"
                style="padding:6px 12px; border:1px solid ${nextDisabled ? '#e2e8f0' : '#cbd5e0'}; background:${nextDisabled ? '#f8fafc' : 'white'};
                border-radius:4px; cursor:${nextDisabled ? 'not-allowed' : 'pointer'}; color:${nextDisabled ? '#a0aec0' : '#4a5568'}; font-size:0.85em;"
                ${nextDisabled ? 'disabled' : ''}>
                下一页
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle;"><polyline points="9 18 15 12 9 6"/></svg>
            </button>`;

            controlsEl.innerHTML = paginationHTML;
        }

        // 跳转到指定页
        function goToPage(page) {
            const totalPages = getCatalogView().totalPages; // 总页数唯一来源：核心视图（按组算）
            const p = Number(page);
            if (!Number.isInteger(p) || p < 1 || p > totalPages) return;
            const r = ModelCatalogCore.gotoPage(catalogSyncState(), { page: p, totalPages });
            catalogEventState = r.state;
            currentPage = r.state.page;
            renderModelsPage();
            // 滚动到表格顶部
            document.getElementById('modelListSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); // #77 C3b：命名助手卡已迁出，滚动目标改为列表区块
        }

        // 设计备注气泡卡片
        function showDesignNotesPopover(iconEl, htmlContent) {
            // 关闭已有的 popover
            closeDesignNotesPopover();
            const rect = iconEl.getBoundingClientRect();
            const pop = document.createElement('div');
            pop.id = 'designNotesPopover';
            pop.style.cssText = 'position:fixed; z-index:9999; background:white; border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 8px 30px rgba(0,0,0,0.15); padding:16px 18px; max-width:420px; min-width:240px; font-size:0.88em; line-height:1.7; color:#334155; word-break:break-word; white-space:pre-wrap;';
            // 标题行
            pop.innerHTML = '<div style="font-weight:600; color:#6366f1; margin-bottom:8px; font-size:0.85em; display:flex; align-items:center; gap:5px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>设计说明</div><div style="color:#475569;">' + htmlContent + '</div>';
            document.body.appendChild(pop);
            // 定位：图标下方居中，超出屏幕则调整
            let left = rect.left + rect.width / 2 - pop.offsetWidth / 2;
            let top = rect.bottom + 8;
            if (left < 10) left = 10;
            if (left + pop.offsetWidth > window.innerWidth - 10) left = window.innerWidth - pop.offsetWidth - 10;
            if (top + pop.offsetHeight > window.innerHeight - 10) top = rect.top - pop.offsetHeight - 8;
            pop.style.left = left + 'px';
            pop.style.top = top + 'px';
            // 点击其他地方关闭
            setTimeout(() => document.addEventListener('click', closeDesignNotesPopover, { once: true }), 0);
        }

        function closeDesignNotesPopover() {
            const old = document.getElementById('designNotesPopover');
            if (old) old.remove();
        }

        // ==================== C4c-2：菜单管理器 + 列表委托（全部同步执行：不经 rAF / setTimeout / await / microtask，DOM 契约 14）====================
        function catalogOpenMenus() {
            return Array.from(document.querySelectorAll('#modelListBody [role="menu"]')).filter(menu => !menu.hasAttribute('hidden'));
        }

        /** 菜单对应的触发按钮：同一条目内 aria-controls 指向该菜单 id 的 [data-menu]（按属性值比较，不拼选择器） */
        function catalogTriggerOf(menu) {
            const entry = menu.closest('[data-id]');
            if (!entry) return null;
            return Array.from(entry.querySelectorAll('[data-menu]')).find(t => t.getAttribute('aria-controls') === menu.id) || null;
        }

        function catalogSetMenu(trigger, menu, open) {
            if (open) menu.removeAttribute('hidden'); else menu.setAttribute('hidden', '');
            trigger.setAttribute('aria-expanded', open ? 'true' : 'false');   // aria-expanded 始终与菜单可见性一致
        }

        function catalogCloseMenus() {
            document.querySelectorAll('#modelListBody [data-menu]').forEach(trigger => {
                const menu = document.getElementById(trigger.getAttribute('aria-controls'));
                if (menu) catalogSetMenu(trigger, menu, false);
            });
        }

        /** 点 ⋯ / 验收触发按钮：切换本菜单，同时关闭其他已打开的菜单 */
        function catalogToggleMenu(trigger) {
            const menu = document.getElementById(trigger.getAttribute('aria-controls'));
            if (!menu) return;
            const wasOpen = !menu.hasAttribute('hidden');
            catalogCloseMenus();
            if (!wasOpen) catalogSetMenu(trigger, menu, true);
        }

        /** 条目选中（HEAD 语义：清掉其他再选中，重复点击保持选中）；P30：条目内任意点击都选中（含 ⋯、菜单项、设计说明） */
        function catalogSelectEntry(entry) {
            const list = document.getElementById('modelListBody');
            if (!list) return;
            list.querySelectorAll('.selected-row').forEach(e => e.classList.remove('selected-row'));
            entry.classList.add('selected-row');
        }

        function catalogRowOf(modelId) {
            const key = String(modelId);
            return allModelsData.find(r => String(r.id) === key) || null;
        }

        /** 行副本：点击时现取 JSON.parse(JSON.stringify(该行))，处理函数拿到的是独立副本（与改前的 JSON 字面量语义相同） */
        function catalogRowCopy(row) {
            return JSON.parse(JSON.stringify(row));
        }

        /** 处理函数一律在调用时经全局名取（不缓存引用）；MC 里与 app.js 同名的 openEditModal 以后声明者为准。全局名不是函数时只记 console.error 并返回 undefined（不抛 TypeError，菜单已由调用方关闭） */
        function catalogCall(name, args) {
            if (typeof window[name] !== 'function') {
                console.error('[catalog] 处理函数不存在：' + name);
                return undefined;
            }
            return window[name].apply(window, args);
        }

        /** data-act 分发（参数个数与改前逐字段相同）：id 取 m.id（数字）；layer 分支一律 String(...).toUpperCase() */
        function catalogDispatchAct(el) {
            const entry = el.closest('[data-id]');
            if (!entry) return;
            const m = catalogRowOf(entry.getAttribute('data-id'));
            if (!m) return;
            const layer = String(m.layer === null || m.layer === undefined ? '' : m.layer).toUpperCase();
            const isODS = layer === 'ODS';
            const isDIM = layer === 'DIM';
            const isDWD = layer === 'DWD';
            // ddl / etl / view-config 按层级闭合：只有明确的层级才调用对应处理函数，未知层级不落到 DWD 兜底（动作规格对未知层级本来就生成禁用项，正常路径行为不变；39 号 L2）
            switch (el.getAttribute('data-act')) {
                case 'ddl':
                    if (isODS) catalogCall('openDDLModal', [catalogRowCopy(m)]);
                    else if (isDIM) catalogCall('openDimDDLModal', [m.id]);
                    else if (isDWD) catalogCall('openDwdDDLModal', [m.id]);
                    break;
                case 'etl':
                    if (isDIM) catalogCall('openDimETLModal', [m.id]);
                    else if (isDWD) catalogCall('openDwdScriptModal', [m.id]);
                    break;
                case 'edit-config': catalogCall('openWorkbench', [m.id, 'edit']); break;
                case 'view-config':
                    if (m.companion_of) catalogCall('openDwdConfigViewModal', [m.id]);   // 伴生（含 DIM 伴生）一律走 DWD 只读配置
                    else if (isDIM) catalogCall('openDimConfigViewModal', [m.id]);
                    else if (isDWD) catalogCall('openDwdConfigViewModal', [m.id]);
                    break;
                case 'edit-info': catalogCall('openEditModal', [catalogRowCopy(m)]); break;
                case 'history': catalogCall('viewModelChangeLogs', [m.id]); break;
                case 'delete': catalogCall('deleteModel', [m.id]); break;
                case 'validate-structure': catalogCall('openValidationModal', [m.id, m.table_name, m.status, isDIM ? 'DIM' : 'DWD', 'structure']); break;
                case 'validate-data': catalogCall('openValidationModal', [m.id, m.table_name, m.status, isDIM ? 'DIM' : 'DWD', 'data']); break;
                case 'validate-semantic': catalogCall('openValidationModal', [m.id, m.table_name, m.status, isDIM ? 'DIM' : 'DWD', 'semantic']); break;
                case 'validate': catalogCall('openValidationModal', [m.id, m.table_name, m.status, 'ODS']); break;
                default: break;
            }
        }

        /** 设计说明入口：气泡内容是转义后的文本（唯一的 escapeHtml 调用点；showDesignNotesPopover 用 innerHTML 拼它，所以必须在这里转义） */
        function catalogDispatchNotes(btn) {
            const entry = btn.closest('[data-id]');
            if (!entry) return;
            const m = catalogRowOf(entry.getAttribute('data-id'));
            if (!m) return;
            // 先撤掉上一个气泡留下的「点别处关闭」once 监听：本次点击还会冒泡到 document，不撤的话它会把刚建出的新气泡立刻删掉（二次打开回归，2c 预筛 MED-1）
            document.removeEventListener('click', closeDesignNotesPopover);
            showDesignNotesPopover(btn, escapeHtml(m.design_notes));
        }

        let catalogListBound = false;

        /** 列表容器上的 click 委托（一个监听）：选中 → 打开按钮交给 MC 的 C7 委托 → 菜单切换 → data-act 分发 → 设计说明；不 stopPropagation */
        function catalogBindList() {
            const list = document.getElementById('modelListBody');
            if (!list || catalogListBound) return;
            catalogListBound = true;
            list.addEventListener('click', function (ev) {
                const t = ev.target;
                if (!(t instanceof Element)) return;
                const entry = t.closest('[data-id]');
                if (entry && list.contains(entry)) catalogSelectEntry(entry);
                if (t.closest('.model-open-btn')) return;   // open-drawer 只由 MC 的 C7 委托处理（这里再处理会一次点击开两次抽屉）
                const expandBtn = t.closest('[data-expand-toggle]');   // C4c-3：展开按钮 / 面板重试 / 面板里的模型链接（均不带 data-act，不进 C4-0 矩阵）
                if (expandBtn && list.contains(expandBtn)) { if (entry) catalogToggleExpand(entry.getAttribute('data-id')); return; }
                const paneAct = t.closest('[data-pane-act]');
                if (paneAct && list.contains(paneAct)) { if (entry && paneAct.getAttribute('data-pane-act') === 'retry') catalogRetryExpand(entry.getAttribute('data-id')); return; }
                const openLink = t.closest('[data-open-model]');
                if (openLink && list.contains(openLink)) { catalogOpenModel(openLink); return; }
                const trigger = t.closest('[data-menu]');
                if (trigger && list.contains(trigger)) { catalogToggleMenu(trigger); return; }
                const actEl = t.closest('[data-act]');
                if (actEl && list.contains(actEl)) {
                    if (actEl.disabled || actEl.getAttribute('aria-disabled') === 'true') return;   // 置灰：什么都不调用，菜单保持打开
                    if (actEl.closest('[role="menu"]')) catalogCloseMenus();
                    catalogDispatchAct(actEl);
                    return;
                }
                const notes = t.closest('[data-entry="design-notes"]');
                if (notes && list.contains(notes)) catalogDispatchNotes(notes);
            });
        }

        // 点菜单和触发按钮以外的任何地方：关闭全部菜单
        document.addEventListener('click', function (e) {
            const t = e.target;
            if (t instanceof Element && t.closest('[role="menu"], [data-menu]')) return;
            catalogCloseMenus();
        });

        // Esc：有菜单打开才处理——关闭、焦点回到触发按钮；capture 阶段 stopPropagation，抽屉的 Esc 不会同时触发
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            const open = catalogOpenMenus();
            if (!open.length) return;
            const trigger = catalogTriggerOf(open[0]);
            catalogCloseMenus();
            if (trigger) trigger.focus();
            e.stopPropagation();
        }, true);

        // C4d-b（LOW-9）：焦点移出菜单关闭——Tab / Shift+Tab 把焦点移到菜单与它的触发按钮之外时关闭全部菜单；不抢焦点（不调 focus）；菜单项之间、触发按钮 ↔ 菜单项移动不关。回调同步
        function catalogOnFocusIn(e) {
            const t = e.target;
            if (!(t instanceof Element)) return;
            const open = catalogOpenMenus();
            if (!open.length) return;
            const inside = open.some(menu => menu.contains(t) || (catalogTriggerOf(menu) || menu).contains(t));
            if (!inside) catalogCloseMenus();
        }
        document.addEventListener('focusin', catalogOnFocusIn);
