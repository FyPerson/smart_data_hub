#!/usr/bin/env node
/**
 * #77 C4-0：模型中心「目录页」语义基线（Playwright）。
 *
 * 来源与复制日期：基础设施（隔离实例 / 库副本 / 种子 / 冻结时钟 / settle / track / 比较机制 / 录制守卫）
 *   原样复制并裁剪自 scripts/test-model-workbench-baseline-playwright.js（C3a-0，复制日期 2026-10-07）；
 *   模型夹具直接读 C3a-0 的 fixtures/model-workbench-baseline/models.json（不复制、不改）。
 *
 * 目的：C4 会把目录页 DOM 形状整个换掉。本基线在改造前（HEAD 4c15838b）录下「与 DOM 形状无关的语义」：
 *   1. matrix.<role>.<modelId>.<act> = { present, enabled, reason, call | inert }   权限语义矩阵；
 *        call = { fn, args }：该格元素真实被点击时页面调用了哪个全局处理函数、带什么（归一化）参数、几个参数；
 *        inert = true：置灰格，点击后没有任何调用。rowExtras 同理（open-drawer / iteration-badge / design-notes）。
 *   2. sort.<key>.<desc|asc|cleared> = 主列表 id 数组（getSortedModels 全量） + sort.default
 *      sortRendered.<同上>           = 每个排序态下翻遍所有页、按文档顺序收集到的实际渲染 id 序列（不重不漏已断言）
 *   3. deepLinks.<case>              = 深链最终落点 / 弹窗 / 目标 id / 是否出提示
 *   4. keyword.<k>                   = GET /api/models?keyword=<k> 的 id 升序数组
 *   5. nav.<page>.*                  = Model_Center.html / Task_Pool.html 导航计算样式（含 accent / border / divider / 头像 / 悬停态）
 *   后续子提交（C4a–C4e）只在本文件 ALLOWED_CHANGES 里登记精确差异值（只允许 eq / absent，pathRe 整串匹配），不重录。baseline.json 受 MANIFEST.json 哈希保护（不得手改）。
 *
 * ===== C4c 读法契约（H1，必读）=====
 *   基线里每个 present 格的 call / inert 是在 HEAD 上「把全局处理函数换成记录型替身 → el.click() → 收集替身收到的调用」得到的
 *   （见 DESCRIBE_AND_PROBE_FN；disabled 按钮不派发 click，所以置灰格 0 次调用）。
 *   C4c 把行渲染改成 DOM 构建 + 事件委托（data-act）之后，读法必须走「先点 ⋯ 触发按钮、再点 [data-act] 项」的真实路径，
 *   用同一套替身（同一份 PROBE_NAMES）记录调用，并与基线 call 逐字段比较（fn / 参数个数 / 每个参数）；置灰项点击后必须 0 调用。
 *   处理函数必须经全局名调用：委托分发若缓存了函数引用，替身拦不到 = 记不到调用 = 判红（fail-closed，这是契约不是缺陷）。
 *   data-act / data-entry 只是元素自己的声明，不能代替「点了真的调用」。读法本身留给 C4c 实现（readMatrixFromDataAct 目前只读声明，不含 call）。
 *
 * ===== 矩阵契约的范围（H3，codex 32）=====
 *   矩阵的 enabled / call / inert 证明的是：「元素是否可点（含下拉菜单经触发按钮真实可达）+ 点了调用哪个处理函数、带什么参数」。
 *   不覆盖处理函数内部的守卫与副作用（状态检查、资源存在性、权限、提前 return）——探针把处理函数换成了记录型替身。
 *   这 12 个处理函数（HANDLER_TO_ACT 的键）不在 C4 的改动范围内：C4a 的反向还原证明它们逐字未动；C4b–C4e 派单约束要求不得改动其函数体，
 *   确需改动须在派单里登记并补行为用例（本基线不会替它们兜底）。
 *
 * ===== 读法对页面的依赖清单与 C4b / C4c 的改写义务（H1，codex 32）=====
 *   本驱动的读法绑定旧结构：#modelListBody 与其 tr[data-id]、.model-row-actions（及 .dim-edit-menu / .dim-validate-menu 的菜单项、
 *   .dim-edit-dropdown / .dim-validate-dropdown 里的触发按钮）、#modelListTable th.sortable、.model-open-btn，
 *   以及全局 renderModelsPage / getSortedModels / allModelsData / pageSize / currentPage。assertLegacyStructure 在读取前逐项检查，
 *   缺任何一个立即失败（文本：「目录页结构或全局已改，按 C4b / C4c 派单约束改写本驱动读法后再比较」），不等待超时。
 *   改写义务：C4b 若封装 / 替换分页与排序全局，必须在派单里给出稳定的读取接口并改写 readSort / readRenderedOrder / readRowsFromHandlers；
 *   C4c 必须按上面「C4c 读法契约」实现 data-act / data-entry 的真实点击读法（先点 ⋯ 触发按钮、再点菜单项）。本批不实现新读法（新 DOM 尚不存在，无法实测）。
 *
 *
 * ===== C4c DOM 契约（C4c-1 冻结，C4c-2 实现；之后的子提交不得破坏。原文 = E:/tmp/mc77-specs/C4c_spec_draft.md §B.3，逐条照抄，仅去掉 markdown 粗体标记）=====
 *   1. 条目：`#modelListBody` 是容器（`div[role="list"]`）。每个模型条目（主模型和伴生都算）是 `[data-id="<id>"]`。条目之间不嵌套；组的包装元素用 `data-group="<主 id>"`，不得带 `data-id`；菜单、展开面板等任何后代都不得再带 `data-id`。伴生条目和主条目是兄弟关系，带 `is-companion` 类。落单伴生组的组头写「主模型不在列表中」（D-15）。
 *   2. 打开按钮：每个条目至少一个 `button.model-open-btn[data-entry="open-drawer"][data-model-id="<id>"]`（表名）。行内设计说明是 `button[data-entry="design-notes"]`（Q8）。展开区里指向其他模型的链接不得用 `.model-open-btn`，也不得带 `data-entry`，改用 `data-open-model="<id>"`（C4c-3）。
 *   3. 动作：`data-act` 只能取 11 个词（`ddl | etl | edit-config | view-config | edit-info | history | delete | validate-structure | validate-data | validate-semantic | validate`），只有矩阵动作元素可以带。其他控件用别的属性：`data-sort-by`、`data-expand-toggle`、`data-pane-act`、`data-catalog-act`、`data-rail`、`data-menu`。
 *   4. 菜单：触发按钮是 `button[data-menu="more"|"validate"][aria-haspopup="menu"][aria-expanded][aria-controls="<菜单 id>"]`，放在条目的 `.model-row-actions` 里（保留这个类名，c7 和委托排除要用）。菜单是 `[role="menu"][id]`，在同一条目内部、渲染时建好，关闭时带 `hidden` 属性（Q9）。菜单项是 `button[role="menuitem"][data-act]`。⋯ 菜单的顺序按方案 §3.5：ETL 脚本 / DDL / 编辑配置或配置（只读）/ 编辑信息 / 变更历史 / 删除；不放验收。
 *   5. 验收主按钮：ODS 有权限时是直接按钮 `button[data-act="validate"]`；DIM / DWD 有权限时是 `button[data-menu="validate"]` 加菜单（结构 / 数据 / 语义，DWD 只有前两项，都带 data-act）。无验收权限或伴生表时只有一个置灰的 `button[data-act="validate"]`（notes 5）。viewer 没有 `.model-row-actions`，也没有任何 `data-act`。
 *   6. 置灰：用 `disabled` 属性（必要时再加 `aria-disabled="true"`）。委托处理器同时检查 `disabled` 和 `aria-disabled`，命中就什么都不调用（notes 4）。置灰原因同时写在 `title` 属性和菜单内的可见文字里，两者逐字相同。
 *   7. 原因文案（`title`）必须与 HEAD 逐字相同，C4-0 才能 0 差异。可用项中只有这几个带 title：history「查看变更历史」；view-config「查看 DIM 配置（只读）」「查看 DWD 配置（只读）」，伴生表为「伴生表配置由主表自动管理（只读）」；其余可用项不带 title。置灰项的 title：validate「伴生表无需独立验收」「无验收权限」；etl「伴生表写入逻辑在主表增量 ETL 的 Step 3 中」「ODS 同步由 FDL 工具管理」「暂不支持」；ddl「请在主表 DDL 弹窗中切换「伴生表 DDL」标签页查看」「暂不支持」；edit-info「无编辑权限」；delete「无删除权限」。新增的只有三个：伴生 delete「伴生表随主模型的变更追踪开关增删」（P-U1）；伴生 edit-info 置灰时的「无编辑权限」；ODS edit-config「ODS 无平台配置，请用编辑信息」（D-18）。
 *   8. 分发表（处理函数经全局名在调用时取，不缓存引用；参数个数与 HEAD 逐字段相同，notes 2 / 3）：
 *      - `ddl`：ODS → `openDDLModal(行副本)`；DIM → `openDimDDLModal(id)`；DWD → `openDwdDDLModal(id)`
 *      - `etl`：DIM → `openDimETLModal(id)`；DWD → `openDwdScriptModal(id)`（只传 1 个参数）
 *      - `edit-config` → `openWorkbench(id, 'edit')`
 *      - `view-config`：伴生 → `openDwdConfigViewModal(id)`；DIM → `openDimConfigViewModal(id)`；DWD → `openDwdConfigViewModal(id)`
 *      - `edit-info` → `openEditModal(行副本)`
 *      - `history` → `viewModelChangeLogs(id)`（不传 opts，否则 readOnly 会隐藏回退按钮）
 *      - `delete` → `deleteModel(id)`（不得传第 2 个参数：`force` 为真时跳过确认直接强删）
 *      - `validate-*` → `openValidationModal(id, table_name, status, 'DIM'|'DWD', 'structure'|'data'|'semantic')`（5 个参数；layer 用大写字面量，不传 `m.layer`）
 *      - `validate` → `openValidationModal(id, table_name, status, 'ODS')`（4 个参数）
 *      - `design-notes` → `showDesignNotesPopover(btn, escapeHtml(design_notes))`
 *      - `open-drawer`：仍由 MC 的 C7 委托处理，即 `openModelDrawer(id, btn)`
 *      - 「行副本」= `JSON.parse(JSON.stringify(allModelsData 里该 id 的行))`，与 HEAD 的 JSON 字面量 / `JSON.parse` 语义相同：处理函数拿到的是独立副本。分支一律用 `String(layer).toUpperCase()` 判断（notes 6）。
 *   9. 菜单关闭契约（notes 12①）：点 ⋯ 切换本菜单，同时关闭其他已打开的菜单。点可用项：调用处理函数并关闭菜单（焦点不强制移动）。点置灰项：不调用，菜单保持打开。点菜单和触发按钮以外的任何地方：关闭。按 Esc：关闭，焦点回到触发按钮；此时在 capture 阶段 `stopPropagation`，抽屉的 Esc 不会同时触发。任何一次 `renderModelsPage` 都关闭全部菜单。触发按钮的 `aria-expanded` 始终和菜单可见性一致。
 *   10. 可见性（notes 12②）：菜单「打开」的判据是菜单及其祖先都没有 `hidden`、计算样式 `display ≠ none`、`visibility = visible`、`pointer-events ≠ none`、`aria-hidden ≠ "true"`。菜单项除此之外还要有尺寸，并且 `elementFromPoint(项中心)` 落在该项自身或其后代上（防止被卡片 `overflow` 裁掉或被遮挡）。
 *   11. 初始化信号（notes 12③）：首次成功渲染后设 `#modelListBody[data-catalog-state="ready"]`；列表请求失败时设 `"error"`（C4c-3）。读法先查静态节点（容器、`#searchKeyword`、`[data-sort-by]`、全局函数），马上查；再等 ready（超时报「初始化超时」）；然后查条目结构（缺了报「结构缺失」）。两种失败文本不同。
 *   12. 排序控件：`button[data-sort-by]` 恰为 8 个键：`layer, table_name, status, acceptance_at, tech_owner, updated_at, domain, id`。激活态带 `aria-sort`（C4d 断言）。
 *   13. 全局名保留：`allModelsData`（全量）、`currentPage`（组页）、`pageSize`、`currentSortBy` / `currentSortDir`、`getSortedModels`、`renderModelsPage()`（不带参数也能用：驱动会直接写 `currentPage = p; renderModelsPage()`）、`goToPage`、`highlightModel`、`loadModels`、`getCatalogView`、`openModelDrawer`。
 *   14. 同步（预筛 M5，主会话裁定新增；codex 37 H3 补充）：菜单开关、委托分发、renderModelsPage 均须同步完成（不得经 requestAnimationFrame / setTimeout / await / microtask 延迟）；Esc 关闭菜单与焦点回到触发按钮都须同步完成；读法在点击后立即读状态（不把读法改成异步等待）。读法在点击后菜单未打开 / 未关闭 / 焦点未回收时，报错文本带「契约 14：须同步」。
 *   6a. 置灰原因的可见文字（codex 37 M4 / 37T M4，主会话裁定新增）：置灰菜单项内的原因文字放在 `.model-menu-reason` 元素里，文本与该项 `title` 逐字相同（读法对每个置灰菜单项比较二者；title 为空的置灰项不要求该元素）。
 *   前置条件（codex 37T M1 / L2）：合成页等价性只是替代证明，不是对真实 HEAD 的证明。C4c-2 真页面 `--reading=dataact --allow-changes` 不允许差异 0、全部登记至少命中一次是硬门；没有这一步，C4c-1 的自证不构成放行依据。
 *   —— 预筛补充条款（主会话裁定，并入对应条款；上面 1–13 条是草稿 §B.3 的逐字照抄，补充只在这里加）：
 *   1a. 条目序列（文档顺序的 [data-id]）必须等于 getCatalogView().pageGroups 展平；#modelListBody 必须是 div[role="list"]；伴生条目带 is-companion；落单伴生条目所在组头文字含「主模型不在列表中」。
 *   2a. 行内入口词表 data-entry ∈ open-drawer | design-notes | iteration-badge（别名 iteration-history 同义，读法两种都收；C4c-2 会删掉行内迭代入口，则不出现）；设计说明入口必须是 button[data-entry="design-notes"]。
 *   8a. 「行副本」必须是普通对象（不是 JSON 串、不是 dataset 字符串），且不是 allModelsData 里的原引用；showDesignNotesPopover / openModelDrawer 的元素参数必须就是被点击的那个 data-entry 元素。
 *   9a. 点空白处的判据：点 body、列表外的真实元素（标题）、另一个条目的根元素，菜单都必须关；Esc 在焦点位于菜单项、位于触发按钮时都必须关闭并让焦点落在触发按钮；再点一次 ⋯ 收起；真实点击可能落在按钮内的子元素（图标 / span）上，分发须用 closest。
 *   4a. 位置：validate 只能是 .model-row-actions 里菜单外的直接按钮；validate-* 只在 data-menu="validate" 的菜单；其余 7 个动作只在 data-menu="more" 的菜单；⋯ 菜单内顺序是契约 4 顺序的子序列。
 *   10a. 读法对每个元素先 scrollIntoView({block:'center'}) 再做 elementFromPoint 命中测试（站点的固定 64px 导航栏不得被读法误判成遮挡）；触发按钮本身也做可见性判定。
 *   11a. 契约 11 的 ready 是「列表数据到达并首次成功渲染后」才设；之后的每次重渲染不得清掉它（读法每页读前都会重新等 ready）。
 *   13a. 页面还必须保留全局：viewIterationHistory、getSortedModels、goToPage、highlightModel、loadModels、openModelDrawer、showDesignNotesPopover 与对应表的 12 个处理函数；currentPage / currentSortBy / currentSortDir 必须已声明且可写（读法直接赋值；缺了静态检查报「目录页结构或全局已改」）。
 *   —— 合成页面说明（预筛 L7）：下方「自证段 S」的 HEAD 形态是对真实 model-catalog.js 模板的手写近似，「新旧读法同结果」只在合成页上证明；对真实 HEAD 的闭环要到 C4c-2 在真页面上跑基线（登记命中 + 不允许差异 0）。
 *   —— 读法实现位置：下方「C4c-1 新读法」目录。契约第 6 条后半（置灰原因的可见文字）已在 C4c-2 由契约 6a 补上选择器 .model-menu-reason，读法（checkReasons）断言其文本与 title 逐字相同；契约 1「落单伴生组头文字」只有检查代码、没有变异证明（合成夹具没有落单伴生）；12「aria-sort」归 C4d，不在本读法证明范围。
 *   —— 失败文本三种互不相同：「目录页结构或全局已改」（静态节点 / 全局缺失，马上报）/「初始化超时」（等不到 data-catalog-state="ready"）/「结构缺失」（ready 之后条目结构不符）；ready 之后的结构检查另含「初始化失败」（state=error）。
 *
 * ===== C4c-1 新读法目录（--reading=dataact；C4c-2 起它是默认读法，view / legacy 只用于在 HEAD 检出上复现基线）=====
 *   [读法段 R]（紧接 readSort 之后，MODAL_PROBE_FN 之前）：R.1 DATAACT_SORT_KEYS / PROBE_NAMES_DATAACT / assertCatalogStructure（static / ready）；
 *     R.2 DESCRIBE_AND_CLICK_FN（页内同步点击读法：菜外按钮 / 菜单项 / 空白处 / Esc / 相邻菜单 / 渲染后关闭 / data-entry）；
 *     R.3 buildRowMatrixFromDataAct / buildRowExtrasFromDataEntry（复用 cellFromProbe 与 actOfCall，比较口径不变）；
 *     R.4 readRowsFromDataAct（翻页、条目序列 = getCatalogView().pageGroups 展平、跨页不重复）；R.5 readSortDataAct（8 键 + 6 个基线键三态 + 程序方式同页证明）。
 *   [自证段 S]（紧接 selfTestMapping 之后，「主流程」之前）：--self-test-dataact 的合成页面（S.1 手写行数据与期望 / S.2 HEAD 形态 / S.3 data-act 形态 / S.4 页面脚本与变异开关 / S.5 用例）。
 *   旧读法（readRowsFromHandlers / readSort / assertLegacyStructure / readMatrixFromDataAct 声明读法）原样保留，不删。
 *   node scripts/test-model-catalog-baseline-playwright.js --reading=dataact      新读法（对 C4c-2 之前的页面必然以「目录页结构或全局已改」失败：fail-closed；C4c-2 起它是默认读法；不能与 --record 同用）
 *   node scripts/test-model-catalog-baseline-playwright.js --self-test-dataact    新读法自证（不起服务，起一次浏览器）：等价性 + 手写锚点 + 5 个对照组 + 变异逐个判红
 * ===== 覆盖边界（L2）=====
 *   本基线里所有模型 id、created_by_id 都是数字；P22（ID 类型混用：字符串 / 数字创建者 id）不在覆盖内，由 C4a 的双向用例覆盖。
 *   C4-0 的「0 差异」不能证明 P22 行为没变。
 *
 * 跑法（均在 wbs-server 目录下；不需要先启动任何服务——自己起隔离实例（默认 3377，可 --port=<n>），不碰 3000）：
 *   node scripts/test-model-catalog-baseline-playwright.js                    比较模式（默认，C4c-2 起默认读法 = dataact）：重放 → 与 baseline.json 比较（不加 --allow-changes 时登记的差异也判红）
 *   node scripts/test-model-catalog-baseline-playwright.js --allow-changes    登记键允许与基线不同但必须满足期望新值；每条登记规则必须至少命中一次（C4c-2：6 族共 143 条）
 *   node scripts/test-model-catalog-baseline-playwright.js --record --reading=view|legacy   录制（只在 HEAD 上用；C4c-2 起必须显式写旧读法，默认的 dataact 读法不能录制）；录制守卫见 checkRecordGuard
 *   node scripts/test-model-catalog-baseline-playwright.js --record --reading=view|legacy --out-dir=<dir>   录到临时目录（确定性校验用，守卫照常）
 *   [#106 S4b2] 隔离实例由 scripts/lib/test-env.js 的 ready() 提供（本检出库快照 + 隔离模式 server.js，端口随机，数据根在系统临时目录，teardown 时整体删除）；
 *     `--port=<n>` 与 MC_CATALOG_WORKDIR 随自起服务删除；各模式（含 --self-test-*）都先起实例（裁定 D5）；ready() 之后在实例库里清洗并按夹具造数（原来在库副本上做，终态相同）。
 *   node scripts/test-model-catalog-baseline-playwright.js --reading=legacy|view|dataact   读法（C4c-2 起默认 dataact；legacy / view 在新页面上必然 fail-closed，只用于在 HEAD 检出上复现基线）：legacy = 5883e906 的算式（总页数 = ceil(allModelsData.length / pageSize)、全集 = getSortedModels()）；
 *                                                  view = 经 getCatalogView()（totalPages / orderedIds）。两种读法在同一页面上必须给出逐字节相同的 MC_DUMP（C4b 新旧读法同结果证明）
 *   node scripts/test-model-catalog-baseline-playwright.js --self-test-compare   比较机制自证（不起服务）
 *   node scripts/test-model-catalog-baseline-playwright.js --self-test-mapping   对应表 / 点击探针自证（不起服务，起一次浏览器）
 *   node scripts/test-model-catalog-baseline-playwright.js --self-test-probe     点击探针自证（H2，起隔离实例，dataact 读法）：菜单没打开 / 结构缺失 / 菜单项不可见 / 菜单未关闭 / Esc 未关闭必须判红
 *   node scripts/test-model-catalog-baseline-playwright.js --design-notes-xss-probe   设计说明点击型存储 XSS 实证（单独库副本，只打印；data-entry 形态页面「执行：是」则退出码 1，HEAD 形态只打印）
 *   node scripts/test-model-catalog-baseline-playwright.js --self-test-settle    settle 硬门自证（不起服务，只起浏览器）
 *   node scripts/test-model-catalog-baseline-playwright.js --escape-probe        escapeHtml 引号注入实证（单独库副本，只打印，不进 baseline）
 *
 * ===== C4b 追加（2026-10-07）=====
 *   读法（view）：readRowsFromHandlers / readRenderedOrder 的总页数取 getCatalogView().totalPages（按组算），readSort / readRenderedOrder 的全集取 getCatalogView().orderedIds；
 *   逐页仍用 currentPage = p; renderModelsPage()。比较口径（sort / sortRendered 数组、矩阵 call / inert / dead）一概不改。
 *   ALLOWED_CHANGES C4B-SORT：伴生紧跟主模型、排序作用于主模型 ⇒ 58 条 sort / sortRendered 序列变化，由 buildAllowedChanges 按规则从 baseline.json 推出（不取自运行结果）；
 *   运行时（view）硬断言页面里「伴生 → 主」映射 = COMPANION_OF。另有「前端搜索读法」（不进基线，只硬断言与打印）与「组页边界自检」。
 *
 * 不进 FAMILY：与 C3a-0 一致（Playwright 驱动需要浏览器与长耗时）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const testEnv = require('./lib/test-env');

// [#106 S4b2] 顶层只有纯声明：路径 / 命令行参数 / 派生常量在入口函数里 `await testEnv.ready()` 之后由 initRuntime() / initDerived() 赋值。
let ROOT = null;
let MODELS_FILE = null;   // C3a-0 夹具，只读
let FIX_DIR = null;
let BASELINE_FILE = null;
let MANIFEST_FILE = null;
let MC_HTML = null;
let MC_CATALOG_JS = null;   // C4a 起列表代码逐字搬到这里（存在才读）
let BASE = null;            // testEnv.env().baseUrl
/**
 * 「页面源码」= Model_Center.html + model-catalog.js（存在才读）按此顺序拼接的文本。所有「函数名 / 结构要出现在页面源码里」的静态检查
 * （HANDLER_TO_ACT、EXTRA_HANDLER、TRIGGER_CALLS、PROBE_NAMES 的防陈旧检查）都读它：C4a 把列表代码搬进 catalog 之后，函数名不在 html 里但仍在页面里。
 * 录制守卫的哈希（modelCenterSha256Lf）仍只算 Model_Center.html，不受影响。
 */
const readPageSource = () => fs.readFileSync(MC_HTML, 'utf8') + (fs.existsSync(MC_CATALOG_JS) ? '\n' + fs.readFileSync(MC_CATALOG_JS, 'utf8') : '');
const SETTLE_LIMIT_MS = 10000;
const FIXED_ISO = '2026-01-15T04:05:06.000Z';
const TIMEZONE = 'Asia/Shanghai';
// [#106 S4b2] 命令行参数（--port / MC_CATALOG_WORKDIR 及其工作目录防误删机制随自起服务删除）：入口函数 ready() 之后由 initRuntime() 解析。
let ARGS = [];
let RECORD = false;
let READING = 'dataact';   // C4c-2 起默认读法 = dataact（view / legacy 在新页面上必然 fail-closed，只用于在 HEAD 检出上复现基线）
/** view / dataact 读法都经稳定接口 getCatalogView()（总页数按组、全集 = orderedIds）；legacy 用 5883e906 的按行算式 */
let USE_VIEW = true;
let ALLOW_CHANGES = false;
let FORCE_RECORD = false;
let OUT_DIR_ARG = '';
function initRuntime() {
  ROOT = path.resolve(__dirname, '..');
  MODELS_FILE = path.join(__dirname, 'fixtures', 'model-workbench-baseline', 'models.json');
  FIX_DIR = path.join(__dirname, 'fixtures', 'model-catalog-baseline');
  BASELINE_FILE = path.join(FIX_DIR, 'baseline.json');
  MANIFEST_FILE = path.join(FIX_DIR, 'MANIFEST.json');
  MC_HTML = path.join(ROOT, 'public', 'Model_Center.html');
  MC_CATALOG_JS = path.join(ROOT, 'public', 'assets', 'js', 'model-catalog.js');
  BASE = testEnv.env().baseUrl;
  ARGS = process.argv.slice(2);
  RECORD = ARGS.includes('--record');
  const READING_ARG = (ARGS.find(a => a.startsWith('--reading=')) || '').slice('--reading='.length);
  READING = READING_ARG || 'dataact';
  if (!['legacy', 'view', 'dataact'].includes(READING)) { console.error('--reading 必须是 legacy、view 或 dataact：' + READING); process.exit(2); }
  if (READING === 'dataact' && ARGS.includes('--record')) { console.error('--record 不能用 dataact 读法（默认读法就是 dataact）：基线只在 HEAD 上用旧读法录制，请显式写 --reading=view 或 --reading=legacy'); process.exit(2); }
  USE_VIEW = READING !== 'legacy';
  ALLOW_CHANGES = ARGS.includes('--allow-changes');
  FORCE_RECORD = ARGS.includes('--force-record');
  OUT_DIR_ARG = (ARGS.find(a => a.startsWith('--out-dir=')) || '').slice('--out-dir='.length);
}

const h = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** LF 规范化后的 sha256（工作区可能是 CRLF，git 里是 LF） */
const sha256Lf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

// ---------------------------------------------------------------------------------------------
// 动作词表与对应表
// ---------------------------------------------------------------------------------------------
const ROLES = ['admin', 'viewer', 'owner', 'nonowner', 'taskowner', 'creator', 'publisher', 'owner_b'];
const ACTS = ['ddl', 'etl', 'edit-config', 'view-config', 'edit-info', 'history', 'delete', 'validate-structure', 'validate-data', 'validate-semantic', 'validate'];
// 201 / 202 = 创建者夹具（CREATOR_MODELS）；203-209 = 大写分层 / 权限分支夹具（UPPER_AND_OWNER_MODELS）；都只进本驱动的库副本
const MODEL_IDS = [6, 8, 50, 52, 53, 55, 58, 59, 60, 62, 65, 201, 202, 203, 204, 205, 206, 207, 208, 209];

/**
 * 处理函数名 → 动作词表。每条注释写清「为什么这个函数名对应这个动作」。解析出表外函数名 → classifyElement 抛错（不得静默归类）。
 * 注意：不同函数名可以合并成同一个动作（openDimETLModal / openDwdScriptModal → etl；三个 DDL 函数 → ddl；三种查看配置入口 → view-config），
 *   动作词表本身不区分它们——靠每格的 call.fn 区分（点击探针记下的真实函数名），C4c 若把 DWD 的 ddl 接成 DIM 的函数，call.fn 变了就判红。
 * 契约范围（H3）：这里的每个处理函数在探针里都是被换掉的记录型替身——矩阵只证明「点到了它、参数是什么」，不证明函数内部的守卫 / 副作用；
 *   这 12 个函数不在 C4 改动范围内，改动函数体须在派单里登记并补行为用例。
 */
const HANDLER_TO_ACT = {
  // renderModelsPage：DIM 行「ETL」按钮 onclick='openDimETLModal(id)' → 打开 DIM ETL 预览弹窗 = etl
  openDimETLModal: 'etl',
  // renderModelsPage：DWD 行「ETL」按钮 onclick='openDwdScriptModal(id)'（DWD 的 ETL 脚本弹窗，按钮文字就是 ETL）= etl
  openDwdScriptModal: 'etl',
  // renderModelsPage：ODS 行「DDL」按钮 openDDLModal(模型JSON)（ODS DDL / 同步脚本弹窗）= ddl
  openDDLModal: 'ddl',
  // DIM 行「DDL」按钮 = ddl
  openDimDDLModal: 'ddl',
  // DWD 行「DDL」按钮 = ddl
  openDwdDDLModal: 'ddl',
  // 编辑 ▾ 菜单「编辑配置」onclick=…openWorkbench(id,'edit')（C3b 起跳转配置台）= edit-config；第二参数决定 edit / view，见 WORKBENCH_MODE_TO_ACT
  openWorkbench: 'edit-config',
  // 菜单「编辑信息」openEditModal(模型JSON)，以及 ODS 行「编辑」按钮 openEditModal(…)，都是改基本信息（编辑弹窗）= edit-info
  openEditModal: 'edit-info',
  // DIM 无编辑权限行「配置」按钮 openDimConfigViewModal(id) → 只读查看配置 = view-config
  openDimConfigViewModal: 'view-config',
  // DWD 无编辑权限行 / 伴生表行「配置」按钮 openDwdConfigViewModal(id) → 只读查看配置 = view-config
  openDwdConfigViewModal: 'view-config',
  // 「历史」按钮 viewModelChangeLogs(id) = history
  viewModelChangeLogs: 'history',
  // 「删除」按钮 deleteModel(id) = delete
  deleteModel: 'delete',
  // 验收入口：ODS 直接 openValidationModal(…,"ODS")，DIM / DWD 在下拉菜单项里带第 5 参数 structure|data|semantic；具体词由 VALIDATE_PHASE_TO_ACT 细分
  openValidationModal: 'validate',
};
/** openValidationModal 第 5 参数 → 动作（缺省 = 无阶段的整体验收 = validate） */
const VALIDATE_PHASE_TO_ACT = { structure: 'validate-structure', data: 'validate-data', semantic: 'validate-semantic' };
/** openWorkbench 第 2 参数 → 动作 */
const WORKBENCH_MODE_TO_ACT = { edit: 'edit-config', view: 'view-config' };
/** 菜单开关 / 事件修饰 / 内置函数：出现在 onclick 里但不是动作本身（显式列出，不是「其它一律放行」） */
// 【C4c-2 注】IGNORED_CALLS / TRIGGER_CALLS / LABEL_TO_ACT / PROBE_NAMES / classifyElement / DESCRIBE_AND_PROBE_FN 及其配套的旧读法（readRowsFromHandlers / readSort / assertLegacyStructure）
//   只对 HEAD（C4c-2 之前的页面，onclick 字符串 + .dim-*-dropdown 旧下拉）有效：toggleDim* / closeDim* 四个函数已从页面删除，用于在 HEAD 检出上复现基线；
//   新读法（默认 --reading=dataact）用 PROBE_NAMES_DATAACT 与 DESCRIBE_AND_CLICK_FN，不依赖这些常量。
const IGNORED_CALLS = new Set(['event.stopPropagation', 'stopPropagation', 'closeDimEditMenus', 'closeDimValidateDropdowns', 'toggleDimEditMenu', 'toggleDimValidateDropdown', 'JSON.parse', 'this.closest']);
/** 只有它们出现时，该元素是「下拉触发按钮」（不是动作，矩阵里不记） */
const TRIGGER_CALLS = new Set(['toggleDimEditMenu', 'toggleDimValidateDropdown']);
/**
 * 没有 onclick 的元素（现行代码里 = 置灰的 disabled 按钮）靠按钮文字归类（显式表，表外文字抛错）：
 *   验收 / ETL / DDL 同名；「编辑」= ODS 无编辑权限的置灰按钮（其可用态 onclick 是 openEditModal = edit-info）；「配置」= 只读查看。
 */
const LABEL_TO_ACT = { '验收': 'validate', 'ETL': 'etl', 'DDL': 'ddl', '编辑': 'edit-info', '配置': 'view-config', '历史': 'history', '删除': 'delete' };

/**
 * 行上操作区之外的可点入口（rowExtras，不并进 11 个动作的主矩阵）。条目名 → 规范 handler 名：
 *   open-drawer    ：行内表名 / 中文描述按钮 `.model-open-btn`（无 onclick，由抽屉委托处理）→ handler 'open-drawer'
 *   iteration-badge：迭代徽章 onclick=viewIterationHistory(id) → 现行处理函数是查看迭代历史，规范名 'iteration-history'（L4：与主矩阵里的动作 history = 变更历史是两个功能，不同名）
 *   design-notes   ：设计说明气泡 onclick=showDesignNotesPopover(this, …) → 'design-notes'
 */
const EXTRA_ENTRIES = ['open-drawer', 'iteration-badge', 'design-notes'];
const EXTRA_HANDLER = { viewIterationHistory: { entry: 'iteration-badge', handler: 'iteration-history' }, showDesignNotesPopover: { entry: 'design-notes', handler: 'design-notes' } };
const EXTRA_IGNORED_CALLS = new Set(['event.stopPropagation', 'stopPropagation', 'JSON.stringify', 'escapeHtml', 'this.closest']);
/** 一个行内入口元素描述 {drawer,onclick,disabled} → {entry,handler,enabled}；表外处理函数 / 无法识别的按钮抛错 */
function classifyExtra(el) {
  if (el.drawer) return { entry: 'open-drawer', handler: 'open-drawer', enabled: !el.disabled };
  const calls = parseCalls(el.onclick || '').filter(c => !EXTRA_IGNORED_CALLS.has(c.name));
  if (calls.length !== 1) throw new Error('行内入口 onclick 里动作函数数量 ' + calls.length + '（应为 1）：' + (el.onclick || '(无 onclick)').slice(0, 120));
  const d = EXTRA_HANDLER[calls[0].name];
  if (!d || !Object.prototype.hasOwnProperty.call(EXTRA_HANDLER, calls[0].name)) throw new Error('行内入口处理函数 ' + calls[0].name + ' 不在 EXTRA_HANDLER 对应表里（先报告再定名）');
  return { entry: d.entry, handler: d.handler, enabled: !el.disabled };
}
/**
 * HEAD 上「看着可用、点了无效」的已知缺陷（点击探针实证）：ODS 行 DDL 按钮的 onclick 是单引号属性 onclick='openDDLModal(整份模型JSON)'，
 * JSON.stringify 之后没有转义单引号；夹具 #6 的 dim_config 里有 changeTableName="x'; DROP TABLE …"（脱敏的恶意串夹具），
 * 属性在第一个单引号处被截断 → 处理函数无法编译 → 点击没有任何效果。键 = `${模型id}:${动作}`；基线里这些格记 dead（不是 call / inert）。
 * 这是 C3a-0 / C4-0 的「声明」读法读不到的缺陷；C4c 改成 data-act 委托之后这些格会变成可点（call），差异按精确值登记即可。登记陈旧（现在能编译）= 录制失败。
 * 修复该缺陷不在 C4-0 范围（页面只读），登记 PROJECT_STATUS 由主会话决定。
 */
const KNOWN_DEAD_CLICKS = { '6:ddl': { id: 'onclick-attr-truncated-by-single-quote' } };
/**
 * 点击探针结果 → 单元格附加字段（H1）。calls = 点击这个元素期间替身收到的调用 [{fn,args,bad?}]；
 *   可用格必须恰好 1 次调用、函数名经对应表得到的动作与格子的动作一致、第 1 个参数指向本行模型；置灰格必须 0 次调用。
 *   不符 → 抛错（录制失败）。返回 { call:{fn,args} } 或 { inert:true }。
 * check(c) 由调用方提供「这次调用是否符合该格语义」，返回错误文本或 null。
 */
function cellFromProbe(label, enabled, calls, rowId, check, dead, noTarget) {
  const cs = (calls || []).filter(c => !TRIGGER_CALLS.has(c.fn));
  for (const c of cs) if (c.bad) throw new Error(label + '：参数无法归一化（' + c.fn + '：' + c.bad + '）');
  if (!enabled) {
    if (cs.length) throw new Error(label + '：置灰格被点击后仍收到调用 ' + cs.map(c => c.fn).join(','));
    return { inert: true };
  }
  if (dead && dead.key in KNOWN_DEAD_CLICKS && !dead.syntaxError) throw new Error(label + '：KNOWN_DEAD_CLICKS 登记了 ' + dead.key + '，但它的 onclick 现在能编译（登记已陈旧，删掉并重录）');
  if (dead && dead.syntaxError) {
    if (!(dead.key in KNOWN_DEAD_CLICKS)) throw new Error(label + '：onclick 属性文本无法编译（点击必然无效），且未在 KNOWN_DEAD_CLICKS 登记：' + dead.key);
    if (cs.length) throw new Error(label + '：登记为点击无效，却收到了调用');
    return { dead: KNOWN_DEAD_CLICKS[dead.key].id };
  }
  if (cs.length !== 1) throw new Error(label + '：可用格点击后应恰好收到 1 次调用，实得 ' + cs.length + '（' + cs.map(c => c.fn).join(',') + '）');
  const c = cs[0];
  const err = check(c);
  if (err) throw new Error(label + '：' + err);
  // noTarget：入口的参数里没有模型 id（设计说明气泡 showDesignNotesPopover(this, 文本)）；文本参数照实记进 call.args，同样会被逐字段比较
  if (!noTarget && targetIdOf(c.args[0]) !== Number(rowId)) throw new Error(label + '：调用 ' + c.fn + ' 的目标 id ' + JSON.stringify(c.args[0]) + ' 与所在行 ' + rowId + ' 不一致（操作落到别的模型上）');
  return { call: { fn: c.fn, args: c.args } };
}
/** 第 1 个参数 → 目标模型 id：数字 / 数字串 / {$model:n}；其它 NaN */
function targetIdOf(a) { if (a && typeof a === 'object' && '$model' in a) return Number(a.$model); if (typeof a === 'number') return a; if (typeof a === 'string' && /^\d+$/.test(a)) return Number(a); return NaN; }
/**
 * 参数归一化（纯函数，被序列化进页面里执行，必须自包含）：模型对象（含 id 的普通对象，或能 JSON.parse 成这种对象的字符串）→ {$model:id}；
 * DOM 元素 → '$element'；Event → '$event'；undefined → '$undefined'；其余原始值（数字 / 字符串 / 布尔 / null）原样；其它（数组 / 无 id 对象 / 函数等）抛错。
 */
function normArg(v) {
  if (v === undefined) return '$undefined';
  if (v === null) return null;
  if (typeof Event !== 'undefined' && v instanceof Event) return '$event';
  if (typeof Element !== 'undefined' && v instanceof Element) return '$element';
  const t = typeof v;
  if (t === 'string') {
    const s = v.trim();
    if (s.charAt(0) === '{') { let o = null; try { o = JSON.parse(s); } catch (_) { o = null; } if (o && typeof o === 'object' && !Array.isArray(o) && 'id' in o) return { $model: o.id }; }
    return v;
  }
  if (t === 'number' || t === 'boolean') return v;
  if (t === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype && 'id' in v) return { $model: v.id };
  throw new Error('无法归一化的参数类型 ' + (Array.isArray(v) ? 'array' : t));
}
/** 一行的入口描述列表 → { entry: {present,handler,enabled,call|inert} }（全量；抽屉入口允许多个元素，其它重复抛错）；fromDataEntry 为 C4c 预留读法（{entry,handler,disabled}，不含探针）；rowId 仅点击探针路径用 */
function buildRowExtras(descs, fromDataEntry, rowId) {
  const row = {};
  for (const e of EXTRA_ENTRIES) row[e] = { present: false, handler: '', enabled: false };
  for (const d of descs) {
    let c;
    if (fromDataEntry) { if (!EXTRA_ENTRIES.includes(d.entry)) throw new Error('data-entry 值 ' + JSON.stringify(d.entry) + ' 不在入口表里'); c = { entry: d.entry, handler: d.handler || '', enabled: !d.disabled }; } else c = classifyExtra(d);
    let cell = { present: true, handler: c.handler, enabled: c.enabled };
    if (!fromDataEntry && d.calls !== undefined) {
      Object.assign(cell, cellFromProbe('行内入口 ' + c.entry + '（行 ' + rowId + '）', c.enabled, d.calls, rowId, (call) => {
        if (c.entry === 'open-drawer') return call.fn === 'openModelDrawer' ? null : '抽屉入口应调用 openModelDrawer，实得 ' + call.fn;
        const exp = Object.keys(EXTRA_HANDLER).find(k => EXTRA_HANDLER[k].entry === c.entry);
        return call.fn === exp ? null : c.entry + ' 应调用 ' + exp + '，实得 ' + call.fn;
      }, { syntaxError: !!d.syntaxError, key: rowId + ':' + c.entry }, c.entry === 'design-notes'));
    }
    if (row[c.entry].present && c.entry !== 'open-drawer') throw new Error('同一行内入口 ' + c.entry + ' 出现了两次');
    if (row[c.entry].present && JSON.stringify(row[c.entry]) !== JSON.stringify(cell)) throw new Error('同一行内多个抽屉入口的状态不一致');
    row[c.entry] = cell;
  }
  return row;
}
/** 从 onclick 文本取出调用序列 [{name,args}]（args 为原始参数串，引号 / 括号感知）；引号内的 word( 不算调用（L3） */
function parseCalls(oc) {
  const calls = [];
  const inQuote = new Array(oc.length).fill(false);
  { let q = null; for (let i = 0; i < oc.length; i++) { const c = oc[i]; if (q) { inQuote[i] = true; if (c === '\\') { i++; if (i < oc.length) inQuote[i] = true; } else if (c === q) q = null; } else if (c === '"' || c === "'") { q = c; inQuote[i] = true; } } }
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
  let m;
  while ((m = re.exec(oc))) {
    if (inQuote[m.index]) continue;
    let depth = 1, i = re.lastIndex, q = null;
    for (; i < oc.length && depth > 0; i++) {
      const c = oc[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '(') depth++; else if (c === ')') depth--;
    }
    calls.push({ name: m[1], args: oc.slice(re.lastIndex, depth === 0 ? i - 1 : i) });
  }
  return calls;
}
const splitArgs = (s) => { const out = []; let cur = '', q = null, d = 0; for (const c of s) { if (q) { cur += c; if (c === q) q = null; } else if (c === '"' || c === "'") { q = c; cur += c; } else if (c === '(' || c === '[' || c === '{') { d++; cur += c; } else if (c === ')' || c === ']' || c === '}') { d--; cur += c; } else if (c === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += c; } if (cur.trim() || out.length) out.push(cur.trim()); return out; };
const unq = (s) => (s === undefined ? undefined : s.replace(/^["']|["']$/g, ''));

/** 处理函数名 + 参数（字符串或已归一化的值）→ 动作；阶段 / 模式参数细分在这里统一做，onclick 文本解析与点击探针共用 */
function actOfCall(fn, args) {
  if (!Object.prototype.hasOwnProperty.call(HANDLER_TO_ACT, fn)) throw new Error('处理函数 ' + fn + ' 不在 HANDLER_TO_ACT 对应表里（先报告再定名，不得静默归类）');
  if (fn === 'openValidationModal') {
    const phase = args[4];
    if (phase === undefined || phase === '' || phase === 'undefined' || phase === '$undefined') return 'validate';
    if (Object.prototype.hasOwnProperty.call(VALIDATE_PHASE_TO_ACT, phase)) return VALIDATE_PHASE_TO_ACT[phase];
    throw new Error('openValidationModal 的阶段参数 ' + JSON.stringify(phase) + ' 不在 VALIDATE_PHASE_TO_ACT 里');
  }
  if (fn === 'openWorkbench') {
    const mode = args[1];
    if (!Object.prototype.hasOwnProperty.call(WORKBENCH_MODE_TO_ACT, mode)) throw new Error('openWorkbench 的模式参数 ' + JSON.stringify(mode) + ' 不在 WORKBENCH_MODE_TO_ACT 里');
    return WORKBENCH_MODE_TO_ACT[mode];
  }
  return HANDLER_TO_ACT[fn];
}
/**
 * 把一个元素描述 {onclick,text,disabled,notAllowed,title} 归类成 {act,enabled,reason}；下拉触发按钮返回 null；任何表外情形抛错。
 * 置灰判断：现行代码同时写 disabled 属性与 cursor:not-allowed 样式，两者必须一致，否则抛错（防读错置灰方式）。
 */
function classifyElement(el) {
  const oc = (el.onclick || '').trim();
  let act;
  if (oc) {
    const calls = parseCalls(oc).filter(c => !IGNORED_CALLS.has(c.name));
    if (calls.length === 0) {
      if (parseCalls(oc).some(c => TRIGGER_CALLS.has(c.name))) return null;
      throw new Error('onclick 里没有可识别的动作函数（也不是下拉触发按钮）：' + oc.slice(0, 120));
    }
    if (calls.length > 1) throw new Error('onclick 里出现多个动作函数：' + calls.map(c => c.name).join(',') + ' ← ' + oc.slice(0, 120));
    const fn = calls[0].name;
    if (!Object.prototype.hasOwnProperty.call(HANDLER_TO_ACT, fn)) throw new Error('处理函数 ' + fn + ' 不在 HANDLER_TO_ACT 对应表里（先报告再定名，不得静默归类）：' + oc.slice(0, 120));
    act = actOfCall(fn, splitArgs(calls[0].args).map(unq));
  } else {
    const label = (el.text || '').trim().replace(/\s+/g, ' ');
    if (!Object.prototype.hasOwnProperty.call(LABEL_TO_ACT, label)) throw new Error('无 onclick 的元素按钮文字 ' + JSON.stringify(label) + ' 不在 LABEL_TO_ACT 里');
    act = LABEL_TO_ACT[label];
  }
  if (!ACTS.includes(act)) throw new Error('动作 ' + act + ' 不在词表里');
  if (!!el.disabled !== !!el.notAllowed) throw new Error('置灰方式不一致（disabled 属性 ' + !!el.disabled + ' / not-allowed 样式 ' + !!el.notAllowed + '）：' + (el.text || '').trim());
  return { act, enabled: !el.disabled, reason: el.title || '' };
}
/** 一行的元素描述列表 → { act: {present,enabled,reason} }（词表全量，缺席的动作 present=false）；同一动作出现两次抛错 */
function buildRowMatrix(descs, fromDataAct, rowId) {
  const row = {};
  for (const a of ACTS) row[a] = { present: false, enabled: false, reason: '' };
  for (const d of descs) {
    let c;
    if (fromDataAct) {
      if (!ACTS.includes(d.act)) throw new Error('data-act 值 ' + JSON.stringify(d.act) + ' 不在词表里');
      c = { act: d.act, enabled: !d.disabled, reason: d.title || '' };
    } else c = classifyElement(d);
    if (!c) continue;
    if (row[c.act].present) throw new Error('同一行内动作 ' + c.act + ' 出现了两次');
    const cell = { present: true, enabled: c.enabled, reason: c.reason };
    // H1：点击探针结果（HEAD 读法才有；data-act 读法目前只读声明，C4c 补点击）
    if (!fromDataAct && d.calls !== undefined) Object.assign(cell, cellFromProbe('动作 ' + c.act + '（行 ' + rowId + '）', c.enabled, d.calls, rowId, (call) => {
      if (!Object.prototype.hasOwnProperty.call(HANDLER_TO_ACT, call.fn)) return '点击调用了非动作处理函数 ' + call.fn;
      const a = actOfCall(call.fn, call.args);
      return a === c.act ? null : '点击实际调用 ' + call.fn + '（= ' + a + '），与格子动作 ' + c.act + ' 不一致';
    }, { syntaxError: !!d.syntaxError, key: rowId + ':' + c.act }));
    row[c.act] = cell;
  }
  return row;
}

// ---------------------------------------------------------------------------------------------
// 夹具与隔离库
// ---------------------------------------------------------------------------------------------
const FIXTURE_IDS = { deletedDim: 66 };
const FILLER_COUNT = 25;
const USERS = [
  { id: 1, username: 'admin', display_name: '管理员', role: 'admin' },
  { id: 2, username: 'viewer_user', display_name: '测试查看者', role: 'viewer' },
  { id: 3, username: 'owner_user', display_name: '测试负责人', role: 'user' },
  { id: 4, username: 'nonowner_user', display_name: '测试非负责人', role: 'user' },
  { id: 5, username: 'taskowner_user', display_name: '测试任务负责人', role: 'user' },
  { id: 7, username: 'publisher_user', display_name: '测试发布者', role: 'publisher' },   // C4-0 追加：publisher 角色（canValidate 的 admin/publisher 分支）；不是任何模型的负责人 / 创建者 / 任务 owner
  { id: 6, username: 'creator_user', display_name: '测试创建者', role: 'user' },   // C4-0 追加：非管理员创建者（created_by_id=6），既非技术负责人也非任务 owner
  // 修复批追加：ASCII 显示名的普通用户，用来覆盖负责人比较的去空白 + 大小写归一化（模型 #209 的 tech_owner = ' owner_b '）
  { id: 8, username: 'owner_b_user', display_name: 'Owner_B', role: 'user' },
];
// taskowner（id 5）：关联任务 owner、非模型负责人 / 非创建者（任务种子见 TASK_SEEDS）
const USER_OF_ROLE = { admin: USERS[0], viewer: USERS[1], owner: USERS[2], nonowner: USERS[3], taskowner: USERS[4], creator: USERS[6], publisher: USERS[5], owner_b: USERS[7] };
/**
 * 本驱动自己的任务种子（不改共享夹具）：
 *   - 3 条进行中任务（CLAIMED，owner_id=5）挂在 ODS#8 / DWD#59 / DIM#60 → latest_active_task_owner_id=5，taskowner 获得验收权限；#65 不挂（对照：同为 DIM 但无权限）
 *   - 归档任务（ARCHIVED，owner_id=1）：#55×2 / #62×1 / #6×1 → archived_task_count 有 0/1/2 三档，让「迭代」列排序有区分度
 */
const TASK_SEEDS = [
  { id: 9001, model: 8, status: 'CLAIMED', owner: '测试任务负责人', owner_id: 5, at: '2026-01-10 09:00:00' },
  { id: 9002, model: 59, status: 'CLAIMED', owner: '测试任务负责人', owner_id: 5, at: '2026-01-10 09:00:01' },
  { id: 9003, model: 60, status: 'CLAIMED', owner: '测试任务负责人', owner_id: 5, at: '2026-01-10 09:00:02' },
  { id: 9011, model: 55, status: 'ARCHIVED', owner: '管理员', owner_id: 1, at: '2026-01-05 09:00:00' },
  { id: 9012, model: 55, status: 'ARCHIVED', owner: '管理员', owner_id: 1, at: '2026-01-06 09:00:00' },
  { id: 9013, model: 62, status: 'ARCHIVED', owner: '管理员', owner_id: 1, at: '2026-01-05 09:00:00' },
  { id: 9014, model: 6, status: 'ARCHIVED', owner: '管理员', owner_id: 1, at: '2026-01-05 09:00:00' },
];
/** 创建者夹具（共享夹具里所有模型 created_by_id=1=admin，admin 短路了「非管理员创建者」分支；这里追加由普通 user#6 创建、技术负责人为他人的 DIM / DWD，脱敏假名） */
// [#106 S4b2] 顶层不再调用 .map：原始行在 *_RAW 里，补默认值的 .map 挪进 initDerived()（入口函数 ready() 之后调用）。
const CREATOR_MODELS_RAW = [
  { id: 201, layer: 'dim', table_name: 'dim_w9001_creator', table_comment: '字段说明901', update_cycle: 'di', design_notes: '设计说明901' },
  { id: 202, layer: 'dwd', table_name: 'dwd_w9002_creator_df', table_comment: '字段说明902', update_cycle: 'df' },
];
let CREATOR_MODELS = null;
/**
 * 大写分层 / 权限分支夹具（H2 + M4；生产 39/145 个模型的 layer 是大写，HEAD 渲染按 layer.toUpperCase() 分支，目录代码必须大小写不敏感）。
 * 覆盖项 → 模型 id：
 *   203  大写 ODS（带 source_system / source_table）+ 技术负责人=owner（测试负责人）  → 非 admin 的 ODS 编辑者（owner）、大写 ODS
 *   204  大写 DWD（standard）                                                     → 大写 DWD
 *   205  大写 DWD 的伴生行（companion_of=204）                                     → 大写伴生行
 *   206  小写 ODS，created_by_id=6（creator 账号），技术负责人=管理员              → 创建者在 ODS 分支的编辑权
 *   207  小写 DWD standard，技术负责人=owner                                      → owner 负责的主表
 *   208  小写 DWD 伴生行，companion_of=207，技术负责人=owner                        → 伴生行的负责人分支（伴生表删除对有编辑权的人可用）
 *   209  小写 DIM，tech_owner=' owner_b '（前后空格 + 小写）                        → 负责人比较的去空白 + 大小写（用户 Owner_B）
 */
const UPPER_AND_OWNER_MODELS_RAW = [
  { id: 203, layer: 'ODS', table_name: 'ods_w9003_upper_df', table_comment: '字段说明903', update_cycle: 'df', tech_owner: '测试负责人', source_system: 'W0003', source_table: 'w9003_src', status: 'ONLINE' },
  { id: 204, layer: 'DWD', table_name: 'dwd_w9004_upper_df', table_comment: '字段说明904', update_cycle: 'df' },
  { id: 205, layer: 'DWD', table_name: 'dwd_w9004_upper_change_di', table_comment: '字段说明905', update_cycle: 'di', config_mode: 'companion', companion_of: 204 },
  { id: 206, layer: 'ods', table_name: 'ods_w9006_creator_df', table_comment: '字段说明906', update_cycle: 'df', source_system: 'W0003', source_table: 'w9006_src', status: 'ONLINE', created_by_id: 6 },
  { id: 207, layer: 'dwd', table_name: 'dwd_w9007_owner_df', table_comment: '字段说明907', update_cycle: 'df', tech_owner: '测试负责人' },
  { id: 208, layer: 'dwd', table_name: 'dwd_w9007_owner_change_di', table_comment: '字段说明908', update_cycle: 'di', config_mode: 'companion', companion_of: 207, tech_owner: '测试负责人' },
  { id: 209, layer: 'dim', table_name: 'dim_w9009_ownerb', table_comment: '字段说明909', update_cycle: 'di', tech_owner: ' owner_b ' },
];
let UPPER_AND_OWNER_MODELS = null;
const loadModelRows = () => JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')).rows;

function dbRun(db, sql, params = []) { return new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); })); }
function dbClose(db) { return new Promise((res, rej) => db.close(e => e ? rej(e) : res())); }
// [#106 S4b2] 原工作目录防误删机制（workdirProblem / ensureWorkdir / removeDbFiles / MC_CATALOG_WORKDIR）随自起服务和库副本删除：实例数据根由 test-env 创建和删除。

/** opts.mutateComment：{ id, comment } → 把某夹具模型的 table_comment 改掉（escapeHtml 实证用）；[#106 S4b2] 现在对 ready() 已建好的实例库清洗并造数（一个进程一个实例，各模式互斥）；关库等回调完成。
 *  整表清场：批跑只能登记为 exclusive:true 或 needsService:false，不能做共享实例成员（会抹掉同一实例上其他成员的数据）。 */
async function prepareDb(dbPath, opts = {}) {
  const sqlite3 = require('sqlite3');
  const db = await new Promise((res, rej) => { const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, e => { if (e) return rej(e); d.configure('busyTimeout', 8000); res(d); }); });
  for (const t of ['system_configs', 'db_connections', 'periodic_tasks', 'model_change_logs', 'model_test_records', 'task_pool', 'data_models', 'users', 'sys_domains', 'sys_source_systems']) {
    await dbRun(db, `DELETE FROM ${t}`);
  }
  // C4b（§C-19）：本机库将来若有实现对象登记，对象名会漏进前端搜索命中；表存在才清
  for (const t of ['model_impl_links', 'model_impl_objects']) { const ex = await new Promise((res, rej) => db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t], (e, r) => e ? rej(e) : res(r))); if (ex) await dbRun(db, `DELETE FROM ${t}`); }
  for (const u of USERS) await dbRun(db, 'INSERT INTO users (id, username, password, display_name, role, status) VALUES (?, ?, ?, ?, ?, ?)', [u.id, u.username, 'not-used-jwt-only', u.display_name, u.role, 'active']);
  for (const [code, name] of [['dom_a', '域甲'], ['dom_b', '域乙'], ['dom_c', '域丙']]) await dbRun(db, "INSERT INTO sys_domains (code, name, description, status) VALUES (?, ?, '', 'active')", [code, name]);
  for (const [code, name] of [['SYS_A', '来源系统甲'], ['SYS_B', '来源系统乙']]) await dbRun(db, "INSERT INTO sys_source_systems (code, name, description) VALUES (?, ?, '')", [code, name]);
  const COLS = ['id', 'layer', 'domain', 'table_name', 'table_comment', 'tech_owner', 'biz_owner', 'update_cycle', 'status', 'created_at', 'updated_at', 'source_table', 'source_system', 'model_type', 'created_by_id', 'category', 'dim_config', 'is_deleted', 'config_mode', 'design_notes', 'companion_of'];
  const ins = (row) => dbRun(db, `INSERT INTO data_models (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map(c => (c === 'dim_config' ? (row.dim_config == null ? null : JSON.stringify(row.dim_config)) : (row[c] === undefined ? null : row[c]))));
  const rows = loadModelRows();
  for (const r of rows) await ins({ ...r, ...(opts.mutateComment && r.id === opts.mutateComment.id ? { table_comment: opts.mutateComment.comment } : {}), ...((opts.mutateRows && opts.mutateRows[r.id]) || {}) });   // mutateRows：{ id: 部分字段 } → 覆盖夹具行的字段（设计说明 XSS 实证用的单独库副本）
  const r62 = rows.find(r => r.id === 62);
  await ins({ ...r62, id: FIXTURE_IDS.deletedDim, table_name: r62.table_name + '_gone', is_deleted: 1 });   // 软删除夹具（?validate=1 深链对照）
  for (let i = 1; i <= FILLER_COUNT; i++) {
    const nn = String(i).padStart(2, '0');
    await ins({ id: 100 + i, layer: 'ods', domain: '', table_name: `ods_filler_${nn}_df`, table_comment: '填充', tech_owner: '管理员', biz_owner: '', update_cycle: 'df', status: 'ONLINE', created_at: '2026-01-01 08:00:00', updated_at: '2026-01-02 08:00:00', source_table: `filler_${nn}`, source_system: 'SYS_A', model_type: 'TABLE', created_by_id: 1, category: 'general', dim_config: null, is_deleted: 0, config_mode: 'standard', design_notes: null, companion_of: null });
  }
  for (const m of CREATOR_MODELS) await ins(m);
  for (const m of UPPER_AND_OWNER_MODELS) await ins(m);
  for (const t of TASK_SEEDS) {
    const m = rows.find(r => r.id === t.model);
    await dbRun(db, "INSERT INTO task_pool (id, title, status, owner, owner_id, created_by, category, linked_model_id, linked_model_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [t.id, '种子任务' + t.id, t.status, t.owner, t.owner_id, '管理员', 'DWD_DEV', t.model, m.table_name, t.at]);
  }
  await dbClose(db);
}

// [#106 S4b2] 原 portBusy / killServer / stopServerAndCleanup / startServer（写死 3377、按 pid 杀 wrapper 进程、等日志就绪、删库副本）整段删除：实例由 test-env 起停。
//   「服务就绪」的判定：原来靠日志 "Task Pool Server running"；改为一次真实请求——未带 token 访问 /api/models 必须 401（assertServing）。
async function assertServing() {
  const probe = await fetch(`${BASE}/api/models`);
  if (probe.status !== 401) throw new Error(`[就绪核对] 未带 token 访问 /api/models 应 401，实得 ${probe.status}（服务没有在应答本脚本要测的路由）`);
}

// ---------------------------------------------------------------------------------------------
// 页面取样基础设施（复制自 C3a-0，裁掉配置台命名区快照）
// ---------------------------------------------------------------------------------------------
const INIT_SCRIPT = () => {
  const st = window.setTimeout, ct = window.clearTimeout, si = window.setInterval, ci = window.clearInterval;
  const live = new Map();
  window.__mcShortTimers = 0;
  const longLive = new Map();
  const where = () => String(new Error().stack || '').split('\n').slice(2, 5).map(x => x.trim()).join(' <- ');
  window.__mcLongLive = () => Array.from(longLive.values());
  window.setTimeout = function (fn, d, ...args) {
    const short = (Number(d) || 0) <= 5000;
    let id;
    const wrapped = function (...a) {
      if (live.has(id)) { if (live.get(id)) window.__mcShortTimers--; live.delete(id); }
      longLive.delete('t' + id);
      return typeof fn === 'function' ? fn.apply(this, a) : (0, eval)(fn);
    };
    id = st.call(window, wrapped, d, ...args);
    live.set(id, short); if (short) window.__mcShortTimers++;
    if (!short) longLive.set('t' + id, { kind: 'setTimeout', delay: Number(d) || 0, where: where() });
    return id;
  };
  window.clearTimeout = function (id) { if (live.has(id)) { if (live.get(id)) window.__mcShortTimers--; live.delete(id); } longLive.delete('t' + id); return ct.call(window, id); };
  window.setInterval = function (fn, d, ...args) {
    const id = si.call(window, fn, d, ...args);
    longLive.set('i' + id, { kind: 'setInterval', delay: Number(d) || 0, where: where() });
    return id;
  };
  window.clearInterval = function (id) { longLive.delete('i' + id); return ci.call(window, id); };
  window.__mcToasts = 0;
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && n.parentElement && n.parentElement.id === 'toast-container') { if (/217, 119, 6|220, 38, 38/.test(n.style.background)) window.__mcToasts++; }
    }).observe(document.body, { childList: true, subtree: true });
  });
};

const NAV_ABORT_WINDOW_MS = 2000;
function track(page) {
  const tr = { inflight: 0, total: 0, hardErrors: 0, windowFetchErrs: 0, abortCredits: 0, pageErrors: 0, dialogs: 0, lastNavAt: -Infinity };
  page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) tr.lastNavAt = Date.now(); });
  Object.defineProperty(tr, 'errors', { get() { return tr.hardErrors + Math.max(0, tr.windowFetchErrs - tr.abortCredits); }, enumerable: true });
  page.on('request', () => { tr.inflight++; tr.total++; });
  page.on('requestfinished', () => { tr.inflight--; });
  page.on('requestfailed', (r) => { tr.inflight--; const f = r.failure(); if (f && /ERR_ABORTED/.test(f.errorText || '') && Date.now() - tr.lastNavAt <= NAV_ABORT_WINDOW_MS) tr.abortCredits++; });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/TypeError: Failed to fetch/.test(m.text()) && Date.now() - tr.lastNavAt <= NAV_ABORT_WINDOW_MS) tr.windowFetchErrs++; else tr.hardErrors++;
    if (process.env.MC_DEBUG) console.log('[console.error]', m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => { tr.pageErrors++; if (process.env.MC_DEBUG) console.log('[pageerror]', String(e).slice(0, 300)); });
  page.on('dialog', (d) => { tr.dialogs++; d.dismiss().catch(() => {}); });
  return tr;
}
const SETTLE_CONFIRM_MS = 300;
async function assertNoLongTimers(page, what) {
  const longs = await page.evaluate(() => (window.__mcLongLive ? window.__mcLongLive() : []));
  if (longs.length) throw new Error('页面存在长期 / 周期定时器：' + longs.map(l => l.kind + ' 延迟 ' + l.delay + 'ms，创建于 ' + (l.where || '(未知位置)')).join('；') + '，需在基线里登记或改写取样（' + what + '）');
}
const isNavError = (e) => /Execution context was destroyed|Target closed|Navigation|navigat/i.test(String(e && e.message));
async function settle(page, tr, snapFn, what) {
  const t0 = Date.now(); let prev = null;
  const overLimit = () => Date.now() - t0 > SETTLE_LIMIT_MS;
  const read = async () => ({ inflight: tr.inflight, total: tr.total, timers: await page.evaluate(() => window.__mcShortTimers) });
  for (;;) {
    if (overLimit()) throw new Error('取样超时（' + SETTLE_LIMIT_MS + 'ms 内未稳定）：' + what);
    try {
      const idle = tr.inflight === 0 && await page.evaluate(() => window.__mcShortTimers === 0);
      const cur = idle ? String(await snapFn()) : null;
      if (cur !== null && prev !== null && cur === prev) {
        const r0 = await read();
        await sleep(SETTLE_CONFIRM_MS);
        if (overLimit()) throw new Error('取样超时（确认等待计入 ' + SETTLE_LIMIT_MS + 'ms 总时限）：' + what);
        const r1 = await read();
        const snap = String(await snapFn());
        const r2 = await read();
        const same = (x, y) => x.inflight === y.inflight && x.total === y.total && x.timers === y.timers;
        if (r0.inflight === 0 && r0.timers === 0 && same(r0, r1) && same(r1, r2) && snap === cur) {
          await assertNoLongTimers(page, what);
          return;
        }
        prev = null; continue;
      }
      prev = cur;
    } catch (e) {
      if (!isNavError(e)) throw e;
      prev = null;
    }
    await sleep(200);
  }
}
async function frozenClockCheck(page) {
  for (let i = 0; ; i++) {
    try {
      const iso = await page.evaluate(() => new Date().toISOString());
      if (iso !== FIXED_ISO) throw new Error(`浏览器时钟未冻结：页面 new Date() = ${iso}，期望 ${FIXED_ISO}`);
      return;
    } catch (e) { if (!isNavError(e) || i > 20) throw e; await sleep(100); }
  }
}
const finalLoc = (page) => page.evaluate(() => ({ finalPath: location.pathname.replace(/^\//, ''), finalSearch: location.search }));
/** 新开目录页：加载、校验冻结时钟、等列表稳定；noSettle 用于深链（调用方自己等） */
async function openPage(ctx, query = '', opts = {}) {
  const page = await ctx.newPage();
  const tr = track(page);
  try { await page.goto(`${BASE}/Model_Center.html${query}`, { waitUntil: 'load' }); } catch (e) { if (!isNavError(e)) throw e; }
  if (READING === 'dataact') {   // C4c-1：新读法的打开顺序——静态节点立即查 → 等 ready（超时 = 初始化超时）→ 条目结构（缺了 = 结构缺失）→ settle；深链用例只等条目出现
    if (!opts.noSettle) { await assertCatalogStructure(page, { ...opts, phase: 'static' }); await assertCatalogStructure(page, { ...opts, phase: 'ready' }); } else await page.waitForFunction(() => !!document.querySelector('#modelListBody [data-id]') || !/Model_Center\.html$/.test(location.pathname), null, { timeout: SETTLE_LIMIT_MS });
    await frozenClockCheck(page);
    if (!opts.noSettle) await settle(page, tr, () => page.evaluate(() => document.getElementById('modelListBody').innerHTML.length), `目录页加载 ${query}`);
    return { page, tr };
  }
  if (!opts.noSettle) await assertLegacyStructure(page, { ...opts, phase: 'static' });   // H1：读法依赖的结构 / 全局缺了就立刻失败，不等超时
  await page.waitForFunction(() => !!document.querySelector('#modelListBody tr') || !/Model_Center\.html$/.test(location.pathname), null, { timeout: SETTLE_LIMIT_MS });
  await frozenClockCheck(page);
  if (!opts.noSettle) { await settle(page, tr, () => page.evaluate(() => document.getElementById('modelListBody').innerHTML.length), `目录页加载 ${query}`); await assertLegacyStructure(page, { ...opts, phase: 'rows' }); }
  return { page, tr };
}
/**
 * H1：读法对旧页面结构 / 全局的依赖清单（见头部「读法依赖清单」）。缺任何一个立即失败，文本指向 C4b / C4c 的改写义务。
 * phase=static：页面载入后即应存在的东西；phase=rows：列表渲染出来后才有的东西（非 viewer 才有 .model-row-actions）。
 */
async function assertLegacyStructure(page, opts = {}) {
  const miss = await page.evaluate(({ phase, viewer, view }) => {
    const m = [];
    const g = (name, f) => { try { if (!f()) m.push(name); } catch (_) { m.push(name); } };
    if (phase === 'static') {
      g('#modelListBody', () => document.getElementById('modelListBody'));
      g('#modelListTable th.sortable', () => document.querySelector('#modelListTable th.sortable'));
      g('函数 renderModelsPage', () => typeof renderModelsPage === 'function');
      g('函数 getSortedModels', () => typeof getSortedModels === 'function');
      g('全局数组 allModelsData', () => Array.isArray(allModelsData));
      g('全局数字 pageSize', () => typeof pageSize === 'number');
      g('全局数字 currentPage', () => typeof currentPage === 'number');
      if (view) g('函数 getCatalogView', () => typeof getCatalogView === 'function');   // C4b：view 读法的稳定接口
    } else {
      g('#modelListBody tr[data-id]', () => document.querySelector('#modelListBody tr[data-id]'));
      if (!viewer) g('.model-row-actions', () => document.querySelector('#modelListBody .model-row-actions'));
    }
    return m;
  }, { phase: opts.phase, viewer: !!opts.viewer, view: READING === 'view' });
  if (miss.length) throw new Error('目录页结构或全局已改，按 C4b / C4c 派单约束改写本驱动读法后再比较：缺 ' + miss.join('、'));
}
const listHash = (page) => page.evaluate(() => document.getElementById('modelListBody').innerHTML.length + ':' + (typeof currentPage !== 'undefined' ? currentPage : ''));

// ---------------------------------------------------------------------------------------------
// 读数：矩阵 / 排序 / 深链 / 关键词 / 导航
// ---------------------------------------------------------------------------------------------
/**
 * 点击探针要换成记录型替身的全局函数：对应表全部键 + 行内入口函数 + 抽屉 + 下拉触发（触发按钮的调用在 node 侧按 TRIGGER_CALLS 过滤，
 * 换掉它们只是为了点触发按钮时不真的去开关菜单）。页面上缺任何一个全局函数 → 探针抛错（防对应表 / 页面漂移）。
 */
// 只对 HEAD 有效（含旧下拉触发函数 TRIGGER_CALLS）；新读法见 PROBE_NAMES_DATAACT
let PROBE_NAMES = null;   // [#106 S4b2] 值 [...Object.keys(HANDLER_TO_ACT), ...Object.keys(EXTRA_HANDLER), 'openModelDrawer', ...TRIGGER_CALLS] 在 initDerived() 里赋（顶层不调用 Object.keys）
/**
 * HEAD 读法（H1）：对当前页每一行，读操作区每个可交互元素的原始描述（onclick / 文字 / disabled / 置灰样式 / title），
 * 并把 PROBE_NAMES 里的全局函数临时换成记录型替身后对该元素 el.click()，把点击期间收到的调用（函数名 + 归一化参数）一并返回；
 * 行内入口（操作区之外的按钮：`.model-open-btn` 记为 drawer，其余取 onclick）同样处理。隐藏菜单项照样触发 onclick；disabled 按钮不派发 click。
 * 取完在 finally 里恢复原函数。dupRows = 同一页里出现多次的 tr[data-id]（M1：重复渲染不得被静默覆盖）。
 * 描述由 node 侧 classifyElement / classifyExtra 归类；调用由 node 侧 cellFromProbe 校验。
 */
const DESCRIBE_AND_PROBE_FN = ({ names, normSrc, triggers }) => {
  const norm = new Function('return ' + normSrc)();
  // 行内 onclick 属性文本能否编译：编译失败的处理函数点击后不会有任何效果（也不能去点——会报 pageerror），按「点了无效」处理
  const cannotCompile = (t) => { if (!t) return false; try { new Function('event', t); return false; } catch (e) { return e instanceof SyntaxError; } };
  const isTrigger = (t) => triggers.some(n => String(t || '').indexOf(n) >= 0);
  const calls = [];
  const saved = {};
  const out = { rows: {}, extras: {}, dupRows: [] };
  for (const n of names) if (typeof window[n] !== 'function') throw new Error('点击探针：页面上没有全局函数 ' + n);
  for (const n of names) {
    saved[n] = window[n];
    window[n] = function () {
      const rec = { fn: n, args: [] };
      try { rec.args = Array.prototype.slice.call(arguments).map(norm); } catch (e) { rec.bad = String(e && e.message); rec.args = ['$bad']; }
      calls.push(rec);
      // 触发函数：记录之后调用原函数（H2：菜单要真的被页面自己的开关打开）；其余处理函数只记录不执行
      if (triggers.indexOf(n) >= 0) return saved[n].apply(this, arguments);
    };
  }
  // H2：菜单项走真实可达路径：真实点触发按钮 → 断言菜单可见且菜单项有尺寸 → 点菜单项 → 点空白处关闭 → 断言菜单已关闭
  const clickMenuItem = (el, menu, id) => {
    const label = '行 ' + id + ' 的菜单项「' + String(el.textContent || '').trim().replace(/\s+/g, ' ') + '」';
    const dd = menu.closest('.dim-edit-dropdown, .dim-validate-dropdown');
    const trg = dd && Array.prototype.find.call(dd.children, (c) => c.tagName === 'BUTTON' && isTrigger(c.getAttribute('onclick')));
    if (!trg) throw new Error('点击探针：触发按钮缺失——' + label + '所在下拉里没有 onclick 带 ' + triggers.join(' / ') + ' 的按钮');
    trg.click();
    if (getComputedStyle(menu).display === 'none') throw new Error('点击探针：菜单没打开——' + label + '：点了触发按钮后菜单仍是 display:none');
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) throw new Error('点击探针：菜单项不可见——' + label + '：菜单已打开但菜单项没有尺寸（' + r.width + 'x' + r.height + '）');
    calls.length = 0;   // 触发按钮自己的调用不计入菜单项的调用
    el.click();
    const got = calls.slice();
    document.body.click();   // 页面自己的关闭方式：点空白处
    if (getComputedStyle(menu).display !== 'none') throw new Error('点击探针：菜单未关闭——' + label + '：点菜单项并点空白处之后菜单仍可见');
    return got;
  };
  try {
    document.querySelectorAll('#modelListBody tr[data-id]').forEach((tr) => {
      const id = tr.dataset.id;
      if (id in out.rows) out.dupRows.push(id);
      const els = [];
      tr.querySelectorAll('.model-row-actions button, .model-row-actions .dim-edit-menu > div, .model-row-actions .dim-validate-menu > div').forEach((el) => {
        const d = { onclick: el.getAttribute('onclick') || '', text: el.textContent || '', disabled: !!el.disabled || el.hasAttribute('disabled'), notAllowed: /cursor:\s*not-allowed/.test(el.getAttribute('style') || ''), title: el.getAttribute('title') || '' };
        d.syntaxError = cannotCompile(d.onclick);
        calls.length = 0;
        const menu = el.parentElement && el.parentElement.matches('.dim-edit-menu, .dim-validate-menu') ? el.parentElement : null;
        if (isTrigger(d.onclick)) { /* 触发按钮不在这里单独点：由它所属菜单的每个菜单项走真实路径时点击 */ } else if (!d.syntaxError) {
          if (menu) d.calls = clickMenuItem(el, menu, id); else el.click();
        }
        if (!d.calls) d.calls = calls.slice();
        els.push(d);
      });
      out.rows[id] = els;
      const xs = [];
      tr.querySelectorAll('button').forEach((b) => {
        if (b.closest('.model-row-actions')) return;
        const d = { drawer: b.classList.contains('model-open-btn'), onclick: b.getAttribute('onclick') || '', disabled: !!b.disabled || b.hasAttribute('disabled') };
        d.syntaxError = cannotCompile(d.onclick);
        calls.length = 0; if (!d.syntaxError) b.click(); d.calls = calls.slice();
        xs.push(d);
      });
      out.extras[id] = xs;
    });
  } finally { for (const n of names) window[n] = saved[n]; }
  return out;
};
let PROBE_ARG = null;   // [#106 S4b2] 值 { names: PROBE_NAMES, normSrc: normArg.toString(), triggers: [...TRIGGER_CALLS] } 在 initDerived() 里赋
/** C4c 预留读法：读 [data-entry]（可选 data-handler）；当前页面没有，不调用 */
const READ_DATA_ENTRY_FN = () => {
  const res = {};
  document.querySelectorAll('[data-id], [data-model-id]').forEach((row) => {
    const id = row.dataset.id || row.dataset.modelId;
    const els = [];
    row.querySelectorAll('[data-entry]').forEach((el) => { els.push({ entry: el.dataset.entry, handler: el.dataset.handler || '', disabled: !!el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' }); });
    if (els.length || res[id] === undefined) res[id] = (res[id] || []).concat(els);
  });
  return res;
};
async function readExtrasFromDataEntry(page, ids = MODEL_IDS) {
  const raw = await page.evaluate(READ_DATA_ENTRY_FN);
  const out = {};
  for (const id of ids) { if (!(String(id) in raw)) throw new Error('data-entry 读法：页面上找不到模型 ' + id + ' 的行'); out[id] = buildRowExtras(raw[id], true); }
  return out;
}
/** C4c 预留读法：读 [data-act]；当前页面没有 data-act，不调用。返回与 HEAD 读法同一词表结构 */
const READ_DATA_ACT_FN = () => {
  const res = {};
  document.querySelectorAll('[data-id], [data-model-id]').forEach((row) => {
    const id = row.dataset.id || row.dataset.modelId;
    const els = [];
    row.querySelectorAll('[data-act]').forEach((el) => { els.push({ act: el.dataset.act, disabled: !!el.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true', title: el.getAttribute('title') || '' }); });
    if (els.length || res[id] === undefined) res[id] = (res[id] || []).concat(els);
  });
  return res;
};
async function readMatrixFromDataAct(page, ids = MODEL_IDS) {
  const raw = await page.evaluate(READ_DATA_ACT_FN);
  const out = {};
  for (const id of ids) { if (!(String(id) in raw)) throw new Error('data-act 读法：页面上找不到模型 ' + id + ' 的行'); out[id] = buildRowMatrix(raw[id], true); }
  return out;
}
/** HEAD 读法：翻遍全部页（renderModelsPage 分页），合并各页行描述，再归类成矩阵 */
async function readMatrixFromHandlers(page, tr, ids = MODEL_IDS) { return (await readRowsFromHandlers(page, tr, ids)).matrix; }
async function readRowsFromHandlers(page, tr, ids = MODEL_IDS) {
  const totalPages = await page.evaluate((view) => (view ? getCatalogView().totalPages : Math.ceil(allModelsData.length / pageSize)), USE_VIEW);   // C4b：legacy = 5883e906 算式（按行）；view = 核心视图（按组）
  const raw = {}, rawX = {};
  for (let p = 1; p <= totalPages; p++) {
    await page.evaluate((p) => { currentPage = p; renderModelsPage(); }, p);
    await settle(page, tr, () => listHash(page), `矩阵翻到第 ${p} 页`);
    const r = await page.evaluate(DESCRIBE_AND_PROBE_FN, PROBE_ARG);
    if (r.dupRows.length) throw new Error('矩阵读法：第 ' + p + ' 页内同一模型渲染了多次：' + r.dupRows.join(','));
    for (const id of Object.keys(r.rows)) {
      if (id in raw) throw new Error('矩阵读法：模型 ' + id + ' 在多页重复渲染（第 ' + p + ' 页再次出现），不得静默覆盖');
      raw[id] = r.rows[id]; rawX[id] = r.extras[id];
    }
  }
  // 点击后恢复到第 1 页，不把「某一页」的状态泄漏给后续取样
  await page.evaluate(() => { currentPage = 1; renderModelsPage(); });
  await settle(page, tr, () => listHash(page), '矩阵取样后回到第 1 页');
  const out = {}, extras = {};
  for (const id of ids) { if (!(String(id) in raw)) throw new Error('矩阵读法：翻遍 ' + totalPages + ' 页仍找不到模型 ' + id + ' 的行'); out[id] = buildRowMatrix(raw[id], false, id); extras[id] = buildRowExtras(rawX[id], false, id); }
  return { matrix: out, extras };
}

const SORT_KEYS = ['id', 'layer', 'table_name', 'table_comment', 'tech_owner', 'biz_owner', 'update_cycle', 'status', 'archived_task_count', 'updated_at'];   // = 表头 th.sortable 的 data-sort-by 全集（main 里与页面实际表头核对）
const DEEP_CASES = (rowOf) => [   // 沿用 C3a-0 p6 的 16 例
  ['dim50_dev', '?id=50&dev=1'], ['dwd52_dev', '?id=52&dev=1'], ['ods6_dev', '?id=6&dev=1'], ['dim58custom_dev', '?id=58&dev=1'], ['dwd53companion_dev', '?id=53&dev=1'],
  ['ods6_edit', '?id=6&edit=1'], ['dim55_plainId', '?id=55'], ['ods8_plainId', '?id=8'],
  ['dim65_validate', '?id=65&validate=1'], ['dim50_validate', '?id=50&validate=1'], ['dim62_validate_created', '?id=62&validate=1'], ['dwd52_validate_created', '?id=52&validate=1'], ['dim66_validate_softdeleted', `?id=${FIXTURE_IDS.deletedDim}&validate=1`],
  ['missing_dev', '?id=9999&dev=1'], ['missing_plain', '?id=9999'], ['search', '?search=' + encodeURIComponent(rowOf(55).table_name)],
];
/** 关键词集（≥15）：每个注释它覆盖哪个字段。结果 = GET /api/models?keyword=<k> 的 id 升序数组 */
const KEYWORDS = [
  ['dim_', 'table_name 前缀（DIM 层表名）'],
  ['w0007', 'table_name 片段（#8 表名 ods_w0006_w0007_w0008_df 与 #50 表名 dim_w0007_w0008 都含 w0007；#8 的 source_table 也含它，但表名已能命中，所以本词不单独证明 source_table 字段——source_table 的独立覆盖靠 w0002）'],
  ['0060', 'table_name 数字片段（#52 / #53 DWD 主表与伴生表）'],
  ['change', 'table_name 片段（#53 伴生表名中的 change）'],
  ['_df', 'table_name 后缀（下划线在 LIKE 里是单字符通配，另覆盖通配语义）'],
  ['字段说明', 'table_comment 中文片段（全部夹具）'],
  ['说明1', 'table_comment 中文片段 + 数字（#6 / #52 / #53 及其它含「说明1…」者）'],
  ['填充', 'table_comment 中文片段（25 条填充 ODS）'],
  ['w0002', 'source_table 片段（仅 #6 的源表 w0002_w0001）'],
  ['filler_07', 'source_table 片段 + table_name 片段（填充 ODS #107）'],
  ['W0003', 'source_system（夹具 ODS 的来源系统码，大写）'],
  ['w0003', 'source_system 小写变体（SQLite LIKE 对 ASCII 不分大小写）'],
  ['SYS_A', 'source_system（填充 ODS 的来源系统码）'],
  ['来源系统甲', 'source_system 的「名」而非码（后端只搜码，期望命不中）'],
  ['52', '纯数字（不搜 id；只命中名字 / 注释里含 52 的行）'],
  ['DIM_W0037', '大小写变体（表名小写，LIKE 不分大小写 → #55）'],
  [' dim', '前导空格（不 trim，期望命不中）'],
  ['dim ', '尾随空格（不 trim，期望命不中）'],
  ['%', 'LIKE 通配符本身（原样进 LIKE，命中全部）'],
  ['不存在的词xyz', '命不中的词'],
];
/**
 * M1：后端 GET /api/models 的 `if (keyword)` 段里 `dm.<字段> LIKE ?` 的字段集合必须恰好是下面四个，且各出现一次。
 * 后端多 / 少 / 换字段 → 失败并提示补关键词（KEYWORDS 要给新字段至少一个唯一夹具值的关键词，再改这里的期望）。
 */
const BACKEND_SEARCH_FIELDS = ['source_system', 'source_table', 'table_comment', 'table_name'];
function checkBackendSearchFields(src) {
  const start = src.indexOf("app.get('/api/models',");
  if (start < 0) throw new Error("后端搜索字段检查：server.js 里找不到 app.get('/api/models', 处理器");
  const next = src.indexOf('app.get(', start + 10);
  const k = src.indexOf('if (keyword)', start);
  if (k < 0 || (next >= 0 && k > next)) throw new Error('后端搜索字段检查：GET /api/models 处理器里找不到 if (keyword) 段');
  const end = src.indexOf('params.push', k);
  const seg = src.slice(k, end < 0 ? k + 1500 : end);
  const fields = Array.from(seg.matchAll(/\bdm\.(\w+)\s+LIKE\s+\?/g)).map(m => m[1]).sort();
  if (JSON.stringify(fields) !== JSON.stringify(BACKEND_SEARCH_FIELDS)) throw new Error('后端搜索字段变了，补关键词：期望 ' + JSON.stringify(BACKEND_SEARCH_FIELDS) + '，实得 ' + JSON.stringify(fields));
}
/**
 * 走后端 LIKE 通配语义的关键词（L6）：`%` 匹配任意串、`_` 匹配单个任意字符，所以「_df」其实是「任意字符 + df」，
 * 前端的普通子串匹配不可能是它们的超集 / 同集。这两个词**不参与 C4b 的「前端命中集 ⊇ 后端命中集」对拍**（不得去前端模拟 LIKE 通配，那等于改了行为）；
 * 它们仍然作为后端命中 id 的基线被记录（后端行为不变）。
 */
const KEYWORD_WILDCARD_EXCEPTIONS_NOTE = `取舍理由（C4b）：前端把 % 与 _ 当字面量（D-11 只要求大小写不敏感与 #id 规则，不模拟 LIKE 通配）；后端 LIKE 把 % 当任意串、_ 当单字符通配，
 * 所以含这两个字符的关键词，后端命中集 ⊇ 前端字面量命中集并不恒成立（也不恒不成立：_df 在本夹具上碰巧前端命中更多）。这两个词不参与「前端 ⊇ 后端」断言，
 * 但仍各自对拍手写的前端期望；0060 与 52 两个词必须保留——0060 靠表名片段子串命中（#52 / #53），52 靠 ID 精确匹配（#52），能分别兜住「数字查询只做 ID 全等」「丢掉 ID 规则」两类回归。`;
const KEYWORD_WILDCARD_EXCEPTIONS = { '%': 'LIKE 通配符：命中全部', '_df': '下划线是 LIKE 单字符通配，不是字面量下划线' };

/**
 * 伴生 → 主模型映射（夹具事实，手写）：#53→#52 来自 models.json（DWD 主表 #52 的变更追踪伴生）；#205→#204、#208→#207 来自本文件 UPPER_AND_OWNER_MODELS。
 * 运行时（view）硬断言页面 allModelsData 里的映射与它完全相等：夹具漂移（新增 / 改动伴生）即失败，不让登记值悄悄过期。
 */
const COMPANION_OF = { 53: 52, 205: 204, 208: 207 };
/** 夹具里分层为 ODS 的模型 id（手写；#6 / #8 来自 models.json，#203 大写 ODS、#206 小写 ODS 来自 UPPER_AND_OWNER_MODELS）。buildAllowedChanges 对夹具硬断言它与夹具推导全等 */
const ODS_IDS_HAND = [6, 8, 203, 206];

/**
 * C4B-SORT（C4b 登记）：伴生紧跟主模型、排序作用于主模型。规则（与实现无关）：新序列 = 旧序列只保留主模型，每个主模型后面紧跟它的伴生表（伴生间按 sort.default 里的相对次序）。
 * 依据：旧序列是对全部行做的稳定排序，限制到主模型子集 = 对主模型子集做同一比较器的稳定排序，即「排序作用于主模型」；cleared = 默认序。
 * 由 baseline.json 推出（不取自运行结果）；推出后硬断言：登记条数 = 58（sort 29 + sortRendered 29），不变的恰为 sort.id.asc / sort.table_name.desc / sortRendered.id.asc / sortRendered.table_name.desc（这两个排序态下伴生本来就紧跟主模型）。
 */
const C4B_SORT_UNCHANGED = ['sort.id.asc', 'sort.table_name.desc', 'sortRendered.id.asc', 'sortRendered.table_name.desc'];
function buildAllowedChanges() {
  if (!fs.existsSync(BASELINE_FILE)) return [];   // 首次录制时还没有基线
  const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const defaultSeq = base.sort.default;
  const pos = new Map(defaultSeq.map((id, i) => [id, i]));
  const compsOf = (p) => Object.keys(COMPANION_OF).map(Number).filter(c => COMPANION_OF[c] === p).sort((a, b) => pos.get(a) - pos.get(b));
  const expand = (oldSeq, what) => {
    const out = [];
    for (const id of oldSeq.filter(x => !(x in COMPANION_OF))) { out.push(id); out.push(...compsOf(id)); }
    if (out.length !== oldSeq.length || !oldSeq.every(x => out.includes(x))) throw new Error('C4B-SORT 推出失败（行不守恒）：' + what);
    return out;
  };
  const rules = [], unchanged = [];
  const add = (p, oldSeq) => { const nw = expand(oldSeq, p); if (JSON.stringify(nw) === JSON.stringify(oldSeq)) unchanged.push(p); else rules.push({ pathRe: '^' + p.split('.').join('\\.') + '$', expect: { eq: nw } }); };
  for (const sec of ['sort', 'sortRendered']) {
    add(sec + '.default', base[sec].default);
    for (const k of DATAACT_BASELINE_SORT_KEYS) for (const d of ['desc', 'asc', 'cleared']) add(sec + '.' + k + '.' + d, base[sec][k][d]);   // C4c-2：只保留仍有排序按钮的 6 个键，其余 4 个键整段下线（C4C-SORT-RM）
  }
  if (rules.length !== 34) throw new Error('C4B-SORT（收窄后）应推出 34 条登记，实得 ' + rules.length);
  if (JSON.stringify(unchanged.slice().sort()) !== JSON.stringify(C4B_SORT_UNCHANGED.slice().sort())) throw new Error('C4B-SORT 不变的序列应恰为 ' + C4B_SORT_UNCHANGED.join('、') + '，实得 ' + unchanged.join('、'));
  const fams = [{ id: 'C4B-SORT', source: 'C4b：伴生紧跟主模型、排序作用于主模型（方案 §3.4；按规则由 baseline.json 推出，COMPANION_OF 手写）；C4c-2 收窄到仍有排序按钮的 6 个键', title: 'sort / sortRendered 序列按组展开', rules }];

  // ---- C4c-2 登记（Q5 / A.4）：每族由规则从 baseline.json 推出，条数硬断言；不取运行结果 ----
  const pre = (p) => '^' + p.split('.').join('\\.') + '$';
  const NONVIEWER = ROLES.filter(r => r !== 'viewer');
  if (NONVIEWER.length !== 7) throw new Error('非 viewer 角色应为 7 个，实得 ' + NONVIEWER.length);
  const cellAt = (sec, role, id, k) => { const c = base[sec] && base[sec][role] && base[sec][role][id] && base[sec][role][id][k]; if (!c) throw new Error('基线缺格 ' + [sec, role, id, k].join('.')); return c; };
  // call 的归一化写法从基线读（不手写猜）：取基线里同类格——ODS #6 admin 的 edit-info（行副本参数）——的 args 形态，把 $model 换成目标 id
  const tplCell = cellAt('matrix', 'admin', 6, 'edit-info');
  if (!tplCell.call || tplCell.call.fn !== 'openEditModal' || tplCell.call.args.length !== 1 || !(tplCell.call.args[0] && typeof tplCell.call.args[0] === 'object' && '$model' in tplCell.call.args[0])) throw new Error('基线里 matrix.admin.6.edit-info 的 call 形态不是 openEditModal(行副本)，无法作为登记模板');
  const rowCopyCall = (id, fn) => ({ fn, args: tplCell.call.args.map(a => (a && typeof a === 'object' && '$model' in a ? { $model: id } : a)) });
  // C4C-PU1（方案 P-U1 / Q6 / Q7）：伴生行 delete 一律置灰「伴生表随主模型的变更追踪开关增删」；伴生行 edit-info 开放，按基线同格 delete.enabled（HEAD 的删除可用 = 有编辑权）决定可用或「无编辑权限」
  const pu1 = [];
  for (const id of Object.keys(COMPANION_OF).map(Number)) for (const role of NONVIEWER) {
    pu1.push({ pathRe: pre('matrix.' + role + '.' + id + '.delete'), expect: { eq: { present: true, enabled: false, reason: '伴生表随主模型的变更追踪开关增删', inert: true } } });
    const canEdit = cellAt('matrix', role, id, 'delete').enabled === true;
    pu1.push({ pathRe: pre('matrix.' + role + '.' + id + '.edit-info'), expect: { eq: canEdit ? { present: true, enabled: true, reason: '', call: rowCopyCall(id, 'openEditModal') } : { present: true, enabled: false, reason: '无编辑权限', inert: true } } });
  }
  if (pu1.length !== 42) throw new Error('C4C-PU1 应推出 42 条登记，实得 ' + pu1.length);
  // C4C-D18（方案 D-18）：ODS 行 edit-config（HEAD 里不存在）以置灰项出现，「ODS 无平台配置，请用编辑信息」；ODS id 取自夹具（手写常量 ODS_IDS_HAND + 夹具硬断言）
  const fixtureRows = [...loadModelRows(), ...CREATOR_MODELS, ...UPPER_AND_OWNER_MODELS];
  const odsFromFixture = MODEL_IDS.filter(id => { const r = fixtureRows.find(x => x.id === id); return r && String(r.layer).toUpperCase() === 'ODS'; });
  if (JSON.stringify(odsFromFixture) !== JSON.stringify(ODS_IDS_HAND)) throw new Error('夹具里的 ODS 模型应恰为 ' + ODS_IDS_HAND.join(',') + '，实得 ' + odsFromFixture.join(','));
  const d18 = [];
  for (const id of ODS_IDS_HAND) for (const role of NONVIEWER) {
    if (cellAt('matrix', role, id, 'edit-config').present) throw new Error('基线里 ODS #' + id + ' 的 edit-config 应不存在（D-18 登记前提）');
    d18.push({ pathRe: pre('matrix.' + role + '.' + id + '.edit-config'), expect: { eq: { present: true, enabled: false, reason: 'ODS 无平台配置，请用编辑信息', inert: true } } });
  }
  if (d18.length !== 28) throw new Error('C4C-D18 应推出 28 条登记，实得 ' + d18.length);
  // C4C-DEAD（方案 D-16）：HEAD 上 onclick 被单引号截断的格（KNOWN_DEAD_CLICKS）在 DOM 构建 + 委托后变成可点，call 与同行 edit-info 同形
  const dead = [];
  for (const key of Object.keys(KNOWN_DEAD_CLICKS)) {
    const [idS, act] = key.split(':'); const id = Number(idS);
    for (const role of ROLES) { const c = cellAt('matrix', role, id, act); if (c.dead) dead.push({ pathRe: pre('matrix.' + role + '.' + id + '.' + act), expect: { eq: { present: true, enabled: true, reason: '', call: rowCopyCall(id, 'openDDLModal') } } }); }
  }
  if (dead.length !== 7) throw new Error('C4C-DEAD 应推出 7 条登记，实得 ' + dead.length);
  // C4C-ITER（方案 §3.1：迭代入口挪进抽屉）：基线里 rowExtras 迭代徽章 present 的格全部消失
  const iter = [];
  for (const role of ROLES) for (const id of MODEL_IDS) if (cellAt('rowExtras', role, id, 'iteration-badge').present) iter.push({ pathRe: pre('rowExtras.' + role + '.' + id + '.iteration-badge'), expect: { eq: { present: false, handler: '', enabled: false } } });
  if (iter.length !== 24) throw new Error('C4C-ITER 应推出 24 条登记，实得 ' + iter.length);
  // C4C-SORT-RM（方案 §3.4 可排序清单）：四个键不再提供排序入口，sort.<k> / sortRendered.<k> 整段下线
  const removedKeys = SORT_KEYS.filter(k => !DATAACT_SORT_KEYS.includes(k));
  if (JSON.stringify(removedKeys) !== JSON.stringify(['table_comment', 'biz_owner', 'update_cycle', 'archived_task_count'])) throw new Error('下线的排序键应恰为 table_comment / biz_owner / update_cycle / archived_task_count，实得 ' + removedKeys.join(','));
  const sortRm = [];
  for (const sec of ['sort', 'sortRendered']) for (const k of removedKeys) { if (!base[sec][k]) throw new Error('基线缺 ' + sec + '.' + k); sortRm.push({ pathRe: pre(sec + '.' + k), expect: { absent: true } }); }
  if (sortRm.length !== 8) throw new Error('C4C-SORT-RM 应推出 8 条登记，实得 ' + sortRm.length);
  fams.push(
    { id: 'C4C-PU1', source: 'C4c-2：方案 P-U1（伴生行删除一律置灰、伴生行开放编辑信息）/ Q6 / Q7；由基线同格 delete.enabled 推出', title: '伴生行 delete 置灰 + edit-info 开放', rules: pu1 },
    { id: 'C4C-D18', source: 'C4c-2：方案 D-18（ODS 无平台配置，edit-config 置灰项）', title: 'ODS 行 edit-config 置灰项', rules: d18 },
    { id: 'C4C-DEAD', source: 'C4c-2：方案 D-16（KNOWN_DEAD_CLICKS 的 onclick 单引号截断，DOM 构建 + 委托后消除）', title: '#6 ODS 行 DDL 由 dead 变可点', rules: dead },
    { id: 'C4C-ITER', source: 'C4c-2：方案 §3.1 / 前提更正②（行内迭代入口删除，挪进抽屉足迹区）', title: '行内迭代徽章消失', rules: iter },
    { id: 'C4C-SORT-RM', source: 'C4c-2：方案 §3.4 可排序清单（table_comment / biz_owner / update_cycle / archived_task_count 不再提供排序入口）', title: '四个排序键整段下线', rules: sortRm },
  );
  const FAMILY_COUNTS = { 'C4B-SORT': 34, 'C4C-PU1': 42, 'C4C-D18': 28, 'C4C-DEAD': 7, 'C4C-ITER': 24, 'C4C-SORT-RM': 8 };
  for (const f of fams) if (f.rules.length !== FAMILY_COUNTS[f.id]) throw new Error('登记族 ' + f.id + ' 条数应为 ' + FAMILY_COUNTS[f.id] + '，实得 ' + f.rules.length);
  const total = fams.reduce((n, f) => n + f.rules.length, 0);
  if (total !== 143) throw new Error('C4c-2 登记总数应为 143，实得 ' + total);
  return fams;
}

/**
 * 前端搜索期望（手写常量，A.8 ④ 由执行方独立复核后写入）：direct = 本行自己的字段命中（按 id 升序）。
 * 可见序列（按组展开、默认序）不再手写成数组：由 visibleOf(direct) 从 direct 与手写的 COMPANION_OF / DEFAULT_ORDER_HAND 推出（规则：命中任一成员的组整组显示，按默认序，伴生紧跟主模型）；
 * 推导不调用被测的 getCatalogView / 核心。
 * 夹具：45 行 / 42 组；上游名非空的只有 #50 / #52 / #55（DIM / DWD 且 sourceTables 非空）；夹具无 impl_note、无实现对象。
 */
const RNG = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const R101_125 = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125];   // [#106 S4b2] = RNG(101, 125) 的字面量（顶层不调用函数）
const FRONT_KEYWORD_EXPECT = {
  'dim_': { direct: [50, 55, 58, 60, 62, 65, 201, 209] },
  'w0007': { direct: [8, 50, 52] },                       // #52 靠上游名 ods_w0006_w0007_w0008_df（后端只命中 #8 / #50）
  '0060': { direct: [52, 53] },                                  // 表名片段；不当作 #60（C-6）
  'change': { direct: [50, 53, 205, 208] },   // #50 靠上游名 …_change_df；#52 / #204 / #207 随伴生进组
  '_df': { direct: [6, 8, 50, 52, 55, 59, ...R101_125, 202, 203, 204, 206, 207] },   // 通配例外：前端当字面量，#50 / #55 靠上游名多出
  '字段说明': { direct: [6, 8, 50, 52, 53, 55, 59, 60, 62, 65, 201, 202, 203, 204, 205, 206, 207, 208, 209] },
  '说明1': { direct: [6, 52, 53] },
  '填充': { direct: R101_125 },
  'w0002': { direct: [6] },
  'filler_07': { direct: [107] },
  'W0003': { direct: [6, 8, 203, 206] },
  'w0003': { direct: [6, 8, 203, 206] },
  'SYS_A': { direct: R101_125 },
  '来源系统甲': { direct: [] },
  '52': { direct: [52] },                                        // ID 精确匹配（后端不搜 id，命中 0 行）
  'DIM_W0037': { direct: [55] },
  ' dim': { direct: [50, 55, 58, 60, 62, 65, 201, 209] },   // 前端去首尾空白（后端不去，命中 0 行）
  'dim ': { direct: [50, 55, 58, 60, 62, 65, 201, 209] },
  '%': { direct: [] },                                                 // 前端把 % 当字面量，没有字段含 %（后端 LIKE 通配命中全部）
  '不存在的词xyz': { direct: [] },
};
/** 默认序（C4-0 夹具 45 行 / 42 组，A.8 ①，手写）：按 table_name 升序，伴生紧跟主模型（#53→#52、#205→#204、#208→#207）；运行时硬断言页面 orderedIds 与它全等 */
const DEFAULT_ORDER_HAND = [60, 50, 55, 58, 62, 65, 201, 209, 52, 53, 59, 202, 204, 205, 207, 208, ...R101_125, 6, 8, 203, 206];
/** 可见序列的独立推导：命中任一成员（主或伴生）的组整组显示，按默认序 */
const visibleOf = (direct) => { const prim = (id) => (id in COMPANION_OF ? COMPANION_OF[id] : id); const hit = new Set(direct.map(prim)); return DEFAULT_ORDER_HAND.filter(id => hit.has(prim(id))); };
const GROUP_PAGES_EXPECT = { totalModels: 45, totalGroups: 42, totalPages: 3, page1Ids: 23, page2Ids: 20, page3: [203, 206], locate6: { page: 2, index: 19 }, locate8: { page: 2, index: 20 } };

/**
 * M1：当前排序态下翻遍所有页，按文档顺序收集 `#modelListBody [data-id]`；断言无重复、并集 = getSortedModels() 的全集；收集完回到第 1 页。
 * 记的是「页面实际渲染出来的顺序」，不是排序函数的返回值。
 */
async function readRenderedOrder(page, tr, what, settleFn = settle) {
  const totalPages = await page.evaluate((view) => (view ? getCatalogView().totalPages : Math.ceil(getSortedModels().length / pageSize)), USE_VIEW);
  const seq = [];
  for (let p = 1; p <= totalPages; p++) {
    await page.evaluate((p) => { currentPage = p; renderModelsPage(); }, p);
    await settleFn(page, tr, () => listHash(page), `${what} 渲染序列第 ${p} 页`);
    seq.push(...await page.evaluate(() => Array.from(document.querySelectorAll('#modelListBody [data-id]')).map(e => Number(e.dataset.id))));
  }
  const all = await page.evaluate((view) => (view ? getCatalogView().orderedIds : getSortedModels().map(m => m.id)), USE_VIEW);
  if (new Set(seq).size !== seq.length) throw new Error(what + '：渲染序列里有重复 id：' + seq.filter((x, i) => seq.indexOf(x) !== i).join(','));
  if (seq.length !== all.length || !all.every(id => seq.includes(id))) throw new Error(what + '：渲染序列并集 ≠ 列表全集（渲染 ' + seq.length + ' 个 / 全集 ' + all.length + ' 个）');
  await page.evaluate(() => { currentPage = 1; renderModelsPage(); });
  await settleFn(page, tr, () => listHash(page), `${what} 回到第 1 页`);
  return seq;
}
/** C4b：页面里「伴生 → 主」映射 = COMPANION_OF；组页边界（45 行 / 42 组 / 3 页，#6 / #8 的组页位置） */
async function readGroupPagesAndMapping(page, tr) {
  const map = await page.evaluate(() => Object.fromEntries(allModelsData.filter(m => m.companion_of != null).map(m => [m.id, m.companion_of])));
  if (JSON.stringify(Object.keys(map).sort()) !== JSON.stringify(Object.keys(COMPANION_OF).sort()) || Object.keys(map).some(k => Number(map[k]) !== COMPANION_OF[k])) throw new Error('夹具漂移：页面里的伴生映射 ' + JSON.stringify(map) + ' ≠ 驱动手写的 COMPANION_OF ' + JSON.stringify(COMPANION_OF) + '（C4B-SORT 登记值不再对应当前夹具）');
  const E = GROUP_PAGES_EXPECT;
  const v = await page.evaluate(() => getCatalogView());
  const fail = (m) => { throw new Error('组页边界自检失败：' + m); };
  if (v.totalModels !== E.totalModels || v.totalGroups !== E.totalGroups || v.totalPages !== E.totalPages) fail('totalModels / totalGroups / totalPages 应为 ' + [E.totalModels, E.totalGroups, E.totalPages].join(' / ') + '，实得 ' + [v.totalModels, v.totalGroups, v.totalPages].join(' / '));
  const pages = [];
  for (let p = 1; p <= v.totalPages; p++) {
    await page.evaluate((p) => { currentPage = p; renderModelsPage(); }, p);
    await settle(page, tr, () => listHash(page), '组页边界第 ' + p + ' 页');
    pages.push(await page.evaluate(() => getCatalogView().pageGroups.flat()));
  }
  if (pages[0].length !== E.page1Ids || pages[1].length !== E.page2Ids || JSON.stringify(pages[2]) !== JSON.stringify(E.page3)) fail('第 1 / 2 / 3 页 pageIds 应为 ' + [E.page1Ids, E.page2Ids, JSON.stringify(E.page3)].join(' / ') + '，实得 ' + [pages[0].length, pages[1].length, JSON.stringify(pages[2])].join(' / '));
  const loc = await page.evaluate(() => ({ l6: ModelCatalogCore.locate(catalogViewRaw(1), 6), l8: ModelCatalogCore.locate(catalogViewRaw(1), 8) }));
  if (JSON.stringify(loc.l6) !== JSON.stringify(E.locate6) || JSON.stringify(loc.l8) !== JSON.stringify(E.locate8)) fail('locate #6 / #8 应为 ' + JSON.stringify([E.locate6, E.locate8]) + '，实得 ' + JSON.stringify([loc.l6, loc.l8]));
  await page.evaluate(() => { currentPage = 1; renderModelsPage(); });
  await settle(page, tr, () => listHash(page), '组页边界回到第 1 页');
  console.log('[组页边界] 45 行 / 42 组 / 3 页；第 1 页 ' + pages[0].length + ' 个、第 2 页 ' + pages[1].length + ' 个、第 3 页 ' + JSON.stringify(pages[2]) + '；#6 = 第 ' + loc.l6.page + ' 页第 ' + loc.l6.index + ' 组，#8 = 第 ' + loc.l8.page + ' 页第 ' + loc.l8.index + ' 组');
}
/**
 * C4b 前端搜索读法（真实输入框 + input 事件）：对 KEYWORDS 每个词读 ① 直接命中 ② 可见（按组展开）；
 * 断言：非通配例外的词 ① ⊇ 后端命中（base.keyword）；① 与 ② 分别全等 FRONT_KEYWORD_EXPECT；② = ① 按组展开（默认序，由 COMPANION_OF 推）；整段 GET /api/models 请求数 = 0；结束后清空输入框回到 45 行。
 */
async function readFrontendSearch(page, tr) {
  const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const reqs = [];
  page.on('request', (r) => { try { const u = new URL(r.url()); if (u.pathname === '/api/models' && r.method() === 'GET') reqs.push(u.search); } catch (_) { /* ignore */ } });
  const pageDefault = await page.evaluate(() => getCatalogView().orderedIds);
  if (JSON.stringify(pageDefault) !== JSON.stringify(DEFAULT_ORDER_HAND)) throw new Error('前端搜索：页面默认序 ' + JSON.stringify(pageDefault) + ' ≠ 手写 DEFAULT_ORDER_HAND ' + JSON.stringify(DEFAULT_ORDER_HAND));
  const rowsOut = [];
  for (const [k] of KEYWORDS) {
    const exp = FRONT_KEYWORD_EXPECT[k];
    if (!exp) throw new Error('前端搜索：关键词 ' + JSON.stringify(k) + ' 缺手写期望（FRONT_KEYWORD_EXPECT）');
    await page.fill('#searchKeyword', k);
    await settle(page, tr, () => listHash(page), '前端搜索 ' + k);
    const r = await page.evaluate((kw) => ({ direct: allModelsData.filter(m => ModelCatalogCore.matchRow(m, kw)).map(m => m.id).sort((a, b) => a - b), visible: getCatalogView().orderedIds }), k);
    const back = (base.keyword[k] || []).slice().sort((a, b) => a - b);
    const bad = (m) => { throw new Error('前端搜索 ' + JSON.stringify(k) + '：' + m); };
    if (JSON.stringify(r.direct) !== JSON.stringify(exp.direct)) bad('直接命中应为 ' + JSON.stringify(exp.direct) + '，实得 ' + JSON.stringify(r.direct));
    const expVisible = visibleOf(exp.direct);   // 独立推导：手写 direct + 手写组映射 + 手写默认序
    if (JSON.stringify(r.visible) !== JSON.stringify(expVisible)) bad('可见序列应 = 直接命中按组展开（默认序）' + JSON.stringify(expVisible) + '，实得 ' + JSON.stringify(r.visible));
    const wild = Object.prototype.hasOwnProperty.call(KEYWORD_WILDCARD_EXCEPTIONS, k);
    if (!wild && !back.every(id => r.direct.includes(id))) bad('前端直接命中应 ⊇ 后端命中 ' + JSON.stringify(back) + '，实得 ' + JSON.stringify(r.direct));
    if (['w0007', 'change', '字段说明'].includes(k)) console.log('[三栏] ' + JSON.stringify(k) + ' 手写 direct=' + JSON.stringify(exp.direct) + ' → 手推可见=' + JSON.stringify(expVisible) + ' → 实测可见=' + JSON.stringify(r.visible));   // 含伴生（#52+#53 / #204+#205 / #207+#208）与大写分层（#203 ODS、#204 #205 DWD）；本夹具没有落单伴生
    rowsOut.push([k, wild ? '后端 ' + back.length + '（通配例外）' : '后端 ' + back.length, '前端直接 ' + r.direct.length, '前端可见 ' + r.visible.length, wild ? '例外' : '⊇ 成立']);
  }
  await page.fill('#searchKeyword', '');
  await settle(page, tr, () => listHash(page), '前端搜索清空');
  const total = await page.evaluate(() => getCatalogView().totalModels);
  if (total !== 45) throw new Error('前端搜索：清空输入框后应回到 45 行，实得 ' + total);
  if (reqs.length) throw new Error('前端搜索：输入即过滤不得发 GET /api/models 请求，实得 ' + reqs.length + ' 次：' + reqs.join(' '));
  console.log('[前端搜索] 词 / 后端 / 前端直接 / 前端可见 / ⊇');
  for (const r of rowsOut) console.log('  ' + JSON.stringify(r[0]).padEnd(14) + ' ' + r.slice(1).join(' | '));
  console.log('[前端搜索] 全程 GET /api/models 请求 0 次；清空后回到 45 行');
}
async function readSort(page, tr) {
  const out = {}, rendered = {};
  const headKeys = await page.evaluate(() => Array.from(document.querySelectorAll('#modelListTable th.sortable')).map(th => th.dataset.sortBy));
  if (JSON.stringify(headKeys) !== JSON.stringify(SORT_KEYS)) throw new Error('可排序列与驱动里的 SORT_KEYS 不一致：页面 ' + JSON.stringify(headKeys));
  const ids = () => page.evaluate((view) => (view ? getCatalogView().orderedIds : getSortedModels().map(m => m.id)), USE_VIEW);
  out.default = await ids();
  rendered.default = await readRenderedOrder(page, tr, '排序 default');
  for (const k of SORT_KEYS) {
    const th = page.locator(`#modelListTable th.sortable[data-sort-by="${k}"]`);
    out[k] = {}; rendered[k] = {};
    await th.click(); await settle(page, tr, () => listHash(page), `排序 ${k} desc`); out[k].desc = await ids(); rendered[k].desc = await readRenderedOrder(page, tr, `排序 ${k} desc`);      // 第 1 次点 = desc
    await th.click(); await settle(page, tr, () => listHash(page), `排序 ${k} asc`); out[k].asc = await ids(); rendered[k].asc = await readRenderedOrder(page, tr, `排序 ${k} asc`);         // 第 2 次点 = asc
    await th.click(); await settle(page, tr, () => listHash(page), `排序 ${k} cleared`); out[k].cleared = await ids(); rendered[k].cleared = await readRenderedOrder(page, tr, `排序 ${k} cleared`); // 第 3 次点 = 清排序（回默认）
    if (JSON.stringify(out[k].cleared) !== JSON.stringify(out.default)) throw new Error('第三次点击后没有回到默认顺序：' + k);
    if (JSON.stringify(rendered[k].cleared) !== JSON.stringify(rendered.default)) throw new Error('第三次点击后渲染序列没有回到默认序列：' + k);
  }
  return { sort: out, sortRendered: rendered };
}

// =============================================================================================
// [C4c-1 读法段 R] data-act 新读法（--reading=dataact）。契约见头部「C4c DOM 契约」；合成页面与变异在文件后部「[C4c-1 自证段 S]」。
//   R.1 常量与结构检查  R.2 页内点击读法 DESCRIBE_AND_CLICK_FN  R.3 node 侧建格  R.4 分页读取  R.5 排序读法
// =============================================================================================
/** 契约 12：排序按钮的 8 个键（与顺序无关）。基线只有其中 6 个（其余 4 个基线键下线、domain / acceptance_at 基线里没有，由 C4c-2 登记） */
const DATAACT_SORT_KEYS = ['layer', 'table_name', 'status', 'acceptance_at', 'tech_owner', 'updated_at', 'domain', 'id'];
let DATAACT_BASELINE_SORT_KEYS = [];   // [#106 S4b2] 值 SORT_KEYS.filter(k => DATAACT_SORT_KEYS.includes(k)) 在 initDerived() 里赋；= id / layer / table_name / tech_owner / status / updated_at（6 个，自证里硬断言）
/** 点击读法要换成记录型替身的全局函数：对应表全部键 + 行内入口函数 + 抽屉（不含旧触发函数 toggleDim*）。页面缺任何一个 → 抛错 */
let PROBE_NAMES_DATAACT = [];   // [#106 S4b2] 值 [...Object.keys(HANDLER_TO_ACT), ...Object.keys(EXTRA_HANDLER), 'openModelDrawer'] 在 initDerived() 里赋
/** data-entry 值 → 基线入口名（iteration-history 是派单里的叫法，基线入口名是 iteration-badge，两者都接受） */
const ENTRY_ALIAS = { 'iteration-history': 'iteration-badge' };
const ENTRY_EXPECT_FN = { 'open-drawer': 'openModelDrawer', 'design-notes': 'showDesignNotesPopover', 'iteration-badge': 'viewIterationHistory' };
const ENTRY_HANDLER = { 'open-drawer': 'open-drawer', 'design-notes': 'design-notes', 'iteration-badge': 'iteration-history' };

/**
 * 结构检查（契约 11）。phase=static：页面载入后立即查静态节点与全局，缺任何一个以「目录页结构或全局已改」失败（不等超时）；
 *   phase=ready：等 #modelListBody[data-catalog-state="ready"]（超时 =「初始化超时」，state=error =「初始化失败」），再查条目结构，缺了 / 不符以「结构缺失」失败。
 * 三种失败文本互不相同，自证里分别判红。opts = { phase, viewer, timeout }。
 */
async function assertCatalogStructure(page, opts = {}) {
  if (opts.phase === 'static') {
    const miss = await page.evaluate(({ keys }) => {
      const m = [];
      const g = (name, f) => { try { if (!f()) m.push(name); } catch (_) { m.push(name); } };
      const sortKeys = () => Array.from(document.querySelectorAll('button[data-sort-by]')).map(b => b.dataset.sortBy);
      g('#modelListBody', () => document.getElementById('modelListBody'));
      g('#searchKeyword', () => document.getElementById('searchKeyword'));
      g('button[data-sort-by] 恰为 8 个键（页面 ' + JSON.stringify(sortKeys()) + '）', () => { const ks = sortKeys(); return ks.length === keys.length && keys.every(k => ks.filter(x => x === k).length === 1); });
      g('函数 renderModelsPage', () => typeof renderModelsPage === 'function');
      g('函数 getCatalogView', () => typeof getCatalogView === 'function');
      g('全局数组 allModelsData', () => Array.isArray(allModelsData));
      g('全局数字 currentPage', () => typeof currentPage === 'number');
      g('全局数字 pageSize', () => typeof pageSize === 'number');
      for (const fn of ['getSortedModels', 'goToPage', 'highlightModel', 'loadModels']) g('函数 ' + fn, () => typeof window[fn] === 'function');
      // 可写性：写哨兵值 → 回读相等 → 恢复原值（getter / 只读 / 私有状态替代都过不了）
      for (const [nm, get, set, sen] of [['currentSortBy', () => currentSortBy, (v) => { currentSortBy = v; }, '__sentinel__'], ['currentSortDir', () => currentSortDir, (v) => { currentSortDir = v; }, '__sentinel__'], ['currentPage', () => currentPage, (v) => { currentPage = v; }, 987654]]) {   // 可写性：写哨兵 → 回读相等 → 恢复原值 → 再回读等于原值
        try { const o = get(); set(sen); const ok = get() === sen; set(o); const back = get(); if (!ok) m.push('全局 ' + nm + '（须可写：写哨兵值后回读必须相等；缺了或只读，读法的程序方式赋值会悄悄失效）'); else if (back !== o) m.push('全局 ' + nm + ' 恢复后回读不等（原值 ' + JSON.stringify(o) + '，恢复后 ' + JSON.stringify(back) + '）'); } catch (_) { m.push('全局 ' + nm + '（须已声明且可写）'); }
      }


      return m;
    }, { keys: DATAACT_SORT_KEYS });
    if (miss.length) throw new Error('目录页结构或全局已改，按 C4c DOM 契约（驱动头部）核对页面后再比较：缺 ' + miss.join('、'));
    return;
  }
  const timeout = opts.timeout || SETTLE_LIMIT_MS;
  try {
    await page.waitForFunction(() => { const b = document.getElementById('modelListBody'); const s = b && b.getAttribute('data-catalog-state'); return s === 'ready' || s === 'error'; }, null, { timeout });
  } catch (_) { throw new Error('初始化超时：' + timeout + 'ms 内 #modelListBody 没有出现 data-catalog-state="ready"'); }
  if ((await page.evaluate(() => document.getElementById('modelListBody').getAttribute('data-catalog-state'))) === 'error') throw new Error('初始化失败：#modelListBody[data-catalog-state="error"]（列表请求失败）');
  const probs = await page.evaluate(({ viewer, acts }) => {
    const P = [];
    const list = document.getElementById('modelListBody');
    const entries = Array.from(list.querySelectorAll('[data-id]'));
    if (list.tagName !== 'DIV' || list.getAttribute('role') !== 'list') P.push('#modelListBody 必须是 div[role="list"]（实得 ' + list.tagName.toLowerCase() + ' role=' + JSON.stringify(list.getAttribute('role')) + '）');
    if (!entries.length) P.push('#modelListBody 里没有任何 [data-id] 条目（契约 11：列表数据到达并成功渲染后才设 ready）');
    const rowOfId = (id) => (Array.isArray(allModelsData) ? allModelsData.find(m => String(m.id) === String(id)) : null);
    for (const en of entries) {
      const m = rowOfId(en.dataset.id);
      if (!m || !m.companion_of) continue;
      if (!en.classList.contains('is-companion')) P.push('伴生条目 ' + en.dataset.id + ' 缺 is-companion 类');
      if (!entries.some(x => String(x.dataset.id) === String(m.companion_of))) { const gw = en.closest('[data-group]'); if (!gw || !/主模型不在列表中/.test(gw.textContent || '')) P.push('落单伴生条目 ' + en.dataset.id + ' 所在组头缺文字「主模型不在列表中」（D-15）'); }
    }
    list.querySelectorAll('[data-entry="design-notes"]').forEach(e => { if (e.tagName !== 'BUTTON') P.push('设计说明入口必须是 button[data-entry="design-notes"]'); });
    for (const e of entries) { const outer = e.parentElement && e.parentElement.closest('[data-id]'); if (outer && list.contains(outer)) P.push('嵌套条目：[data-id="' + e.dataset.id + '"] 在 [data-id="' + outer.dataset.id + '"] 里面（条目之间不得嵌套，菜单 / 展开面板等后代不得再带 data-id）'); }
    list.querySelectorAll('[data-group][data-id]').forEach(e => P.push('组包装元素 [data-group="' + e.dataset.group + '"] 带了 data-id（只有条目带 data-id）'));
    list.querySelectorAll('[data-act]').forEach(e => { if (!acts.includes(e.dataset.act)) P.push('data-act 值 ' + JSON.stringify(e.dataset.act) + ' 不在词表里'); });
    list.querySelectorAll('[data-entry]').forEach(e => { if (!['open-drawer', 'design-notes', 'iteration-badge', 'iteration-history'].includes(e.dataset.entry)) P.push('data-entry 值 ' + JSON.stringify(e.dataset.entry) + ' 不在入口表里'); });
    list.querySelectorAll('.model-open-btn, [data-entry="open-drawer"]').forEach(b => {
      const en = b.closest('[data-id]');
      if (!(b.tagName === 'BUTTON' && b.classList.contains('model-open-btn') && b.dataset.entry === 'open-drawer')) P.push('打开按钮必须同时是 button.model-open-btn 与 [data-entry="open-drawer"]（展开区里指向其他模型的链接不得用 .model-open-btn，改用 data-open-model）');
      else if (!en || b.dataset.modelId !== en.dataset.id) P.push('打开按钮的 data-model-id=' + JSON.stringify(b.dataset.modelId) + ' 与所在条目 ' + (en ? en.dataset.id : '(无)') + ' 不一致');
    });
    for (const en of entries) if (!en.querySelector('button.model-open-btn[data-entry="open-drawer"][data-model-id]')) P.push('条目 ' + en.dataset.id + ' 没有打开按钮 button.model-open-btn[data-entry="open-drawer"][data-model-id]');
    list.querySelectorAll('[data-menu]').forEach(T => {
      const en = T.closest('[data-id]');
      const w = '条目 ' + (en ? en.dataset.id : '(无)') + ' 的触发按钮 [data-menu="' + T.dataset.menu + '"]';
      if (T.tagName !== 'BUTTON') P.push(w + ' 不是 button');
      if (!['more', 'validate'].includes(T.dataset.menu)) P.push(w + ' 的取值不是 more / validate');
      if (T.getAttribute('aria-haspopup') !== 'menu') P.push(w + ' 缺 aria-haspopup="menu"');
      if (T.getAttribute('aria-expanded') === null) P.push(w + ' 缺 aria-expanded');
      if (!T.closest('.model-row-actions')) P.push(w + ' 不在 .model-row-actions 里');
      const cid = T.getAttribute('aria-controls');
      const M = cid ? document.getElementById(cid) : null;
      if (!M) { P.push(w + ' 的 aria-controls 没有指向存在的元素'); return; }
      if (M.getAttribute('role') !== 'menu') P.push(w + ' 指向的元素缺 role="menu"');
      if (!en || !en.contains(M)) P.push(w + ' 指向的菜单不在同一条目内部（菜单必须渲染时建在条目里）');
      if (T.getAttribute('aria-expanded') === 'false' && !M.hasAttribute('hidden')) P.push(w + ' 关闭态的菜单缺 hidden 属性');
      M.querySelectorAll('[data-act]').forEach(it => { if (!(it.tagName === 'BUTTON' && it.getAttribute('role') === 'menuitem')) P.push(w + ' 的菜单里的 data-act 元素必须是 button[role="menuitem"]'); });
    });
    for (const en of entries) {
      if (viewer) { if (en.querySelector('.model-row-actions, [data-menu], [data-act]')) P.push('viewer 的条目 ' + en.dataset.id + ' 带了 .model-row-actions / data-menu / data-act（viewer 没有操作区）'); }
      else if (!en.querySelector('.model-row-actions [data-menu="more"]')) P.push('条目 ' + en.dataset.id + ' 缺 ⋯ 触发按钮（.model-row-actions 里的 button[data-menu="more"]）');
    }
    document.querySelectorAll('[data-act], [data-entry]').forEach(e => { const en = e.closest('[data-id]'); if (!list.contains(e) || !en || !list.contains(en) || (e.dataset.act !== undefined && !(e.closest('[role="menu"]') ? en.contains(e.closest('[role="menu"]')) : !!(e.closest('.model-row-actions') && en.contains(e.closest('.model-row-actions'))))) || (e.dataset.entry !== undefined && !['open-drawer', 'design-notes', 'iteration-badge', 'iteration-history'].includes(e.dataset.entry))) P.push('列表外、不在任何条目里或位置不合法的控件（data-act 只能在条目的 .model-row-actions 直接按钮或条目内 [role=menu] 菜单项上；data-entry 只取契约 2 / 2a 的值）：' + e.tagName.toLowerCase() + (e.dataset.act ? '[data-act="' + e.dataset.act + '"]' : '[data-entry="' + e.dataset.entry + '"]') + '（data-act / data-entry 只允许出现在 #modelListBody 的条目里）'); });
    return P;
  }, { viewer: !!opts.viewer, acts: ACTS });
  if (probs.length) throw new Error('结构缺失：' + probs.slice(0, 6).join('；') + (probs.length > 6 ? '；……共 ' + probs.length + ' 项' : ''));
}

/**
 * 页内点击读法（同步执行，替身机制照 DESCRIBE_AND_PROBE_FN）：对当前页每个条目 [data-id]，走「真实可达路径」读并点击：
 *   (a) 菜单外的 [data-act]（验收直接按钮）：可见性判定（契约 10）→ el.click() → 收集替身收到的调用；
 *   (b) 每个 [data-menu] 触发按钮：点开 → 断言 aria-expanded 与菜单可见 → 逐个菜单项（必要时重新打开）读 {act, disabled, title} → 点击收集调用 →
 *       可用项点后必须关闭菜单且 aria-expanded=false；置灰项点后必须 0 调用且菜单保持打开；
 *   (c) 每个触发按钮：点空白处必须关闭；Esc 必须关闭、焦点回触发按钮、且在 capture 阶段 stopPropagation（document 冒泡阶段的探针收不到）；
 *   (d) [data-entry]：逐个点击收集调用（open-drawer 经页面自己的委托到达 openModelDrawer）；
 *   (e) 相邻触发按钮：打开后一个必须关掉前一个（契约 9）；checkRender：先开一个菜单再 renderModelsPage()，所有菜单必须关闭。
 * 所有失败都带具体文本抛出；finally 恢复被替身替换的全局函数。返回 { rows:{id:[{act,where,disabled,ariaDisabled,title,calls}]}, extras:{id:[...]}, dupRows, order }。
 */
const DESCRIBE_AND_CLICK_FN = ({ names, normSrc, viewer, checkRender }) => {
  const norm = new Function('return ' + normSrc)();
  const calls = [];
  const saved = {};
  let cur = null;   // 当前被点击的元素（data-act / data-entry 元素本身）；元素参数必须就是它（预筛 H2）
  for (const n of names) if (typeof window[n] !== 'function') throw new Error('点击读法：页面上没有全局函数 ' + n);
  const jsonOf = (x) => { try { return JSON.stringify(x); } catch (_) { return '$unserializable'; } };
  const sharesRef = (x, y) => { const seen = new WeakSet(); const walk = (a, b) => { if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || seen.has(a)) return false; seen.add(a); for (const k of Object.keys(a)) { const v = a[k]; if (v && typeof v === 'object') { if (v === b[k]) return true; if (walk(v, b[k])) return true; } } return false; }; return walk(x, y); };   // 无深度上限，WeakSet 防循环
  const rowOfArg = (a) => (Array.isArray(allModelsData) ? allModelsData.find(m => String(m.id) === String(a.id)) : null);
  for (const n of names) {
    saved[n] = window[n];
    window[n] = function () {
      const rec = { fn: n, args: [] };
      // 归一化之前先记每个参数的原始类别：对象 / 字符串 / 元素；normArg 会把「对象」与「JSON 串」归成同一个 {$model}，不记就分不出来
      rec.raw = Array.prototype.slice.call(arguments).map((a) => (typeof a === 'string' ? { t: 'string' } : (a instanceof Element ? { t: 'element', isTarget: a === cur } : (a && typeof a === 'object' ? { t: 'object', plain: Object.getPrototypeOf(a) === Object.prototype, live: Array.isArray(allModelsData) && allModelsData.indexOf(a) >= 0, snap: jsonOf(a), rowJson: (() => { const r = rowOfArg(a); return r ? jsonOf(r) : null; })(), shares: (() => { const r = rowOfArg(a); return !!r && sharesRef(a, r); })() } : { t: typeof a }))));
      try { rec.args = Array.prototype.slice.call(arguments).map(norm); } catch (e) { rec.bad = String(e && e.message); rec.args = ['$bad']; }
      calls.push(rec);
    };
  }
  // ---- 可见性（契约 10）：自己及祖先都没有 hidden / aria-hidden="true" / display:none；自己 visibility=visible、pointer-events≠none（strict）
  const hiddenWhy = (el, strict) => {
    for (let a = el; a; a = a.parentElement) {
      const own = a === el ? '' : '祖先 ' + a.tagName.toLowerCase() + (a.id ? '#' + a.id : (typeof a.className === 'string' && a.className ? '.' + a.className.split(/\s+/)[0] : '')) + ' ';
      if (a.hasAttribute('hidden')) return own + '带 hidden 属性';
      if (a.getAttribute('aria-hidden') === 'true') return own + '带 aria-hidden="true"';
      const cs = getComputedStyle(a);
      if (cs.display === 'none') return own + 'display:none';
      if (cs.visibility !== 'visible') return own + 'visibility:' + cs.visibility;
      if (strict && cs.pointerEvents === 'none') return own + 'pointer-events:none';
    }
    return '';
  };
  const unreachable = (el, strict) => {
    const w = hiddenWhy(el, strict);
    if (w) return w;
    // 居中（预筛 H1）：真页面有 64px 固定导航栏，nearest 会把元素对齐到视口顶边、正好落在导航栏下面
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return '没有尺寸（' + r.width + 'x' + r.height + '）';
    if (!strict) return '';
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top || !(top === el || el.contains(top))) return '被遮挡（中心点命中 ' + (top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') : 'null') + '，不是该元素或其后代）';
    return '';
  };
  // 真实点击落在最深的第一个子元素上（按钮里的图标 / span）；置灰的 disabled 元素点自己（浏览器不对 disabled 控件派发 click）
  const press = (el) => {
    cur = el;
    let t = el;
    if (!el.disabled) while (t.firstElementChild) t = t.firstElementChild;
    if (typeof t.click === 'function') t.click(); else t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  };
  const mstate = (M) => { const w = hiddenWhy(M, true); return { open: !w, why: w }; };
  const mlabel = (T, id) => '行 ' + id + ' 的 ' + (T.dataset.menu === 'validate' ? '验收' : '⋯') + ' 菜单';
  const ensureOpen = (T, M, id) => {
    if (mstate(M).open) return;
    press(T);
    const st = mstate(M);
    if (!st.open) throw new Error('菜单没打开——' + mlabel(T, id) + '：点了触发按钮后菜单仍不可见（' + st.why + '）（契约 14：须同步——菜单开关必须在 click 事件内同步完成，不经 rAF / setTimeout / await）');
    if (T.getAttribute('aria-expanded') !== 'true') throw new Error('aria-expanded 与菜单可见性不一致——' + mlabel(T, id) + '：菜单已可见，但 aria-expanded=' + JSON.stringify(T.getAttribute('aria-expanded')));
  };
  const mustBeClosed = (T, M, id, why) => {
    const st = mstate(M);
    if (st.open) throw new Error(why + '——' + mlabel(T, id) + '：菜单仍可见（契约 14：须同步——关闭必须在事件内同步完成）');
    if (T.getAttribute('aria-expanded') !== 'false') throw new Error('aria-expanded 与菜单可见性不一致——' + mlabel(T, id) + '：菜单已关闭，但 aria-expanded=' + JSON.stringify(T.getAttribute('aria-expanded')));
    if (!M.hasAttribute('hidden')) throw new Error('关闭后的菜单缺 hidden 属性——' + mlabel(T, id));
  };
  // 点空白处：向 target 依次派发 pointerdown / mousedown / pointerup / mouseup / click（真实非菜单元素，不只 body）
  const blank = (target) => { for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) { const E = t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent; target.dispatchEvent(new E(t, { bubbles: true, cancelable: true, view: window })); } };
  // Esc：focusOn='item' 焦点先移进第一个可用菜单项；focusOn='trigger' 焦点留在触发按钮（真实用户点 ⋯ 后的状态）
  const pressEsc = (T, M, id, focusOn) => {
    const item = Array.from(M.querySelectorAll('[role="menuitem"]')).find(i => !i.disabled && i.getAttribute('aria-disabled') !== 'true');
    let path = '焦点在菜单项上', restoreTab = null;
    if (focusOn === 'trigger') { T.focus(); path = '焦点在触发按钮上'; }
    else if (item) { T.blur(); item.focus(); }   // 焦点先离开触发按钮，「焦点回到触发按钮」才有判别力
    else {   // 菜单项全部置灰：单列一条路径——把焦点放到菜单容器（tabindex=-1 可聚焦）再派发，不退化成在 body 上派发
      T.blur(); path = '焦点在菜单容器上，菜单项全部置灰';
      if (!M.hasAttribute('tabindex')) { M.setAttribute('tabindex', '-1'); restoreTab = true; }
      M.focus();
      if (document.activeElement !== M) { if (restoreTab) M.removeAttribute('tabindex'); throw new Error('Esc 测试无法把焦点放到全置灰菜单的容器上——' + mlabel(T, id)); }
    }
    let leaked = false;
    const spy = (e) => { if (e.key === 'Escape') leaked = true; };
    document.addEventListener('keydown', spy);   // 冒泡阶段探针：capture 阶段 stopPropagation 时收不到
    try { (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })); } finally { document.removeEventListener('keydown', spy); }
    if (restoreTab) M.removeAttribute('tabindex');
    const where = '（' + path + '）';
    mustBeClosed(T, M, id, 'Esc 后菜单未关闭' + where);
    if (document.activeElement !== T) throw new Error('Esc 后焦点未回到触发按钮——' + mlabel(T, id) + where + '：document.activeElement=' + (document.activeElement ? document.activeElement.tagName.toLowerCase() + (document.activeElement.id ? '#' + document.activeElement.id : '') : 'null') + '（契约 14：须同步——Esc 关闭菜单与焦点回到触发按钮都须同步完成）');
    if (leaked) throw new Error('Esc 关闭菜单时没有在 capture 阶段 stopPropagation——' + mlabel(T, id) + '：document 冒泡阶段仍收到了该 keydown（抽屉的 Esc 会同时触发）');
  };
  const describe = (el, id, where) => ({ act: el.dataset.act, where, menuKind: null, inActions: !!el.closest('.model-row-actions'), disabled: !!el.disabled || el.hasAttribute('disabled'), ariaDisabled: el.getAttribute('aria-disabled') === 'true', title: el.getAttribute('title') || '' });
  const out = { rows: {}, extras: {}, dupRows: [], order: [] };
  const trigs = [];
  try {
    const list = document.getElementById('modelListBody');
    // checkRender：每种触发按钮（⋯ / 验收）各开一个菜单，再 renderModelsPage()，所有菜单必须关闭（第 1、2 页都跑）
    if (checkRender && !viewer) {
      for (const kind of ['more', 'validate']) {
        const T0 = document.getElementById('modelListBody').querySelector('[data-menu="' + kind + '"]');
        if (!T0) continue;
        const M0 = document.getElementById(T0.getAttribute('aria-controls')); const e0 = T0.closest('[data-id]');
        if (!M0) continue;
        ensureOpen(T0, M0, e0 ? e0.dataset.id : '?');
        renderModelsPage();
        const left0 = Array.from(document.querySelectorAll('#modelListBody [role="menu"]')).filter(M => mstate(M).open);
        if (left0.length) throw new Error('渲染后仍有菜单打开——' + left0.map(m => m.id).join(',') + '（任何一次 renderModelsPage 都必须关闭全部菜单；先打开的是 ' + kind + ' 触发按钮的菜单；契约 14：须同步）');
      }
    }
    if (viewer) { const vm = Array.from(document.querySelectorAll('[role="menu"]')).filter(M => mstate(M).open); if (vm.length) throw new Error('viewer 渲染后页面上仍有可见的 [role=menu]——' + vm.map(m => m.id || '(无 id)').join(',') + '（viewer 没有操作区，也不应有可见菜单）'); }
    const stale = Array.from(document.querySelectorAll('#modelListBody [role="menu"]')).filter(M => mstate(M).open);
    if (stale.length) throw new Error('渲染后仍有菜单打开——' + stale.map(m => m.id).join(',') + '（任何一次 renderModelsPage 都必须关闭全部菜单）');
    const entriesAll = Array.from(document.getElementById('modelListBody').querySelectorAll('[data-id]'));
    // 点空白处的目标：页面上真实的非菜单元素——列表外的标题（没有则搜索框）与另一个条目的根元素
    const outside = document.querySelector('h1, h2, .page-title') || document.getElementById('searchKeyword');
    for (const en of entriesAll) {
      const id = en.dataset.id;
      if (id in out.rows) out.dupRows.push(id);
      out.order.push(id);
      const acts = [], xs = [];
      // (a) 菜单外的 data-act
      en.querySelectorAll('[data-act]').forEach((el) => {
        if (el.closest('[role="menu"]')) return;
        const d = describe(el, id, 'direct');
        const enabled = !d.disabled && !d.ariaDisabled;
        const w = unreachable(el, enabled);
        if (w) throw new Error('按钮不可点——行 ' + id + ' 的 data-act="' + d.act + '"：' + w);
        calls.length = 0; press(el); d.calls = calls.slice();
        if (!enabled && d.calls.length) throw new Error('置灰格被点击后仍收到调用——行 ' + id + ' 的 data-act="' + d.act + '"：' + d.calls.map(c => c.fn).join(','));
        acts.push(d);
      });
      // (b)(c) 菜单
      en.querySelectorAll('[data-menu]').forEach((T) => {
        const M = document.getElementById(T.getAttribute('aria-controls'));
        if (!M) throw new Error('菜单读法：触发按钮的 aria-controls 没有指向存在的元素（行 ' + id + '）');
        const wT = unreachable(T, true);
        if (wT) throw new Error('触发按钮不可见——' + mlabel(T, id) + '：' + wT);
        trigs.push({ T, M, id });
        const items = Array.from(M.querySelectorAll('[role="menuitem"][data-act]'));
        if (!items.length) throw new Error('菜单读法：' + mlabel(T, id) + '里没有 button[role="menuitem"][data-act]');
        for (const it of items) {
          ensureOpen(T, M, id);
          const d = describe(it, id, 'menu'); d.menuKind = T.dataset.menu;
          const rsEl = it.querySelector('.model-menu-reason'); d.reasonText = rsEl ? rsEl.textContent : null;
          const enabled = !d.disabled && !d.ariaDisabled;
          const w = unreachable(it, enabled);
          if (w) throw new Error('菜单项不可见——' + mlabel(T, id) + '的 data-act="' + d.act + '"：' + w);
          calls.length = 0; press(it); d.calls = calls.slice();
          if (!enabled && d.calls.length) throw new Error('置灰格被点击后仍收到调用——' + mlabel(T, id) + '的 data-act="' + d.act + '"：' + d.calls.map(c => c.fn).join(','));
          if (enabled) mustBeClosed(T, M, id, '点菜单项后菜单未关闭');
          else if (!mstate(M).open || T.getAttribute('aria-expanded') !== 'true') throw new Error('置灰项点击后菜单被关闭——' + mlabel(T, id) + '的 data-act="' + d.act + '"（置灰项点击必须无效，菜单保持打开）');
          acts.push(d);
        }
        // 再点一次触发按钮：收起（契约 9「点 ⋯ 切换本菜单」）
        ensureOpen(T, M, id); press(T); mustBeClosed(T, M, id, '再点触发按钮后菜单未收起');
        // 点空白处：body、列表外的真实元素、另一个条目的根元素，三处都必须关闭
        ensureOpen(T, M, id); blank(document.body); mustBeClosed(T, M, id, '点空白处后菜单未关闭（目标 body）');
        if (outside && !outside.closest('#modelListBody')) { ensureOpen(T, M, id); blank(outside); mustBeClosed(T, M, id, '点空白处后菜单未关闭（目标 ' + outside.tagName.toLowerCase() + (outside.id ? '#' + outside.id : '') + '，页面上真实的非菜单元素）'); }
        const other = entriesAll.find(x => x !== en);
        if (other) { ensureOpen(T, M, id); blank(other); mustBeClosed(T, M, id, '点空白处后菜单未关闭（目标 另一个条目 ' + other.dataset.id + '）'); }
        ensureOpen(T, M, id); pressEsc(T, M, id, 'item');
        ensureOpen(T, M, id); pressEsc(T, M, id, 'trigger');
      });
      // (d) 行内入口
      en.querySelectorAll('[data-entry]').forEach((el) => {
        const d = { entry: el.dataset.entry, tag: el.tagName, modelId: el.dataset.modelId === undefined ? null : el.dataset.modelId, disabled: !!el.disabled || el.hasAttribute('disabled'), ariaDisabled: el.getAttribute('aria-disabled') === 'true' };
        const enabled = !d.disabled && !d.ariaDisabled;
        const w = unreachable(el, enabled);
        if (w) throw new Error('入口不可点——行 ' + id + ' 的 data-entry="' + d.entry + '"：' + w);
        calls.length = 0; press(el); d.calls = calls.slice();
        xs.push(d);
      });
      out.rows[id] = acts; out.extras[id] = xs;
    }
    // (e) 相邻触发按钮：打开后一个必须关掉前一个
    for (let i = 0; i + 1 < trigs.length; i++) {
      const a = trigs[i], b = trigs[i + 1];
      ensureOpen(a.T, a.M, a.id);
      press(b.T);
      mustBeClosed(a.T, a.M, a.id, '打开另一个菜单时已打开的菜单没有关闭');
      if (!mstate(b.M).open) throw new Error('菜单没打开——' + mlabel(b.T, b.id) + '：点了触发按钮后菜单仍不可见（' + mstate(b.M).why + '）');
      blank(document.body); mustBeClosed(b.T, b.M, b.id, '点空白处后菜单未关闭');
    }
    const left = Array.from(document.querySelectorAll('#modelListBody [role="menu"]')).filter(M => mstate(M).open);
    if (left.length) throw new Error('读完后仍有菜单打开：' + left.map(m => m.id).join(','));
  } finally { for (const n of names) window[n] = saved[n]; }
  return out;
};
const CLICK_ARG = (viewer, checkRender) => ({ names: PROBE_NAMES_DATAACT, normSrc: normArg.toString(), viewer: !!viewer, checkRender: !!checkRender });

/**
 * node 侧建格：产出与 HEAD 读法（buildRowMatrix 点击路径）同形的格子 { present, enabled, reason, call | inert }。
 * 复用 cellFromProbe / actOfCall：可用格必须恰好 1 次调用、调用的函数 + 参数经对应表推出的动作 = data-act、目标 id = 所在行；置灰格（disabled 或 aria-disabled）必须 0 次调用。
 * 不产生 dead：可用格 0 次调用就是错误。reason = title 属性。
 */
/** 原始参数类别检查（预筛 H2）：归一化成 {$model} 的参数，原始值必须是普通对象且不是 allModelsData 里的原引用；'$element' 参数必须就是被点击的元素 */
/** 独立实现的深比较（不复用 deepEqual / JSON 串比较；键序无关） */
function deepEq(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) { if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEq(a[k], b[k])) return false; }
  return true;
}
function rawArgProblem(call) {
  for (let i = 0; i < call.args.length; i++) {
    const a = call.args[i], r = (call.raw || [])[i] || {};
    if (a && typeof a === 'object' && '$model' in a) {
      if (r.t === 'string') return '行副本必须是对象，第 ' + (i + 1) + ' 个参数实得字符串（JSON 串 / dataset 字符串；处理函数按对象取字段）';
      if (r.t !== 'object' || !r.plain) return '行副本必须是普通对象，第 ' + (i + 1) + ' 个参数的原始类别是 ' + JSON.stringify(r.t);
      if (r.live) return '行副本不得是 allModelsData 里的原引用（契约 8：须为独立副本），第 ' + (i + 1) + ' 个参数';
      if (r.rowJson == null || typeof r.snap !== 'string') return '无法核对行副本内容：第 ' + (i + 1) + ' 个参数在 allModelsData 里找不到对应行';
      let x, y;
      try { x = JSON.parse(r.snap); y = JSON.parse(r.rowJson); } catch (_) { return '行副本无法序列化（第 ' + (i + 1) + ' 个参数）'; }
      if (!deepEq(x, y)) return '行副本内容与该行不一致（第 ' + (i + 1) + ' 个参数缺字段 / 字段值不同；契约 8：JSON.parse(JSON.stringify(该行))）：快照 ' + r.snap.slice(0, 90);
      if (r.shares) return '行副本与该行共享嵌套引用（第 ' + (i + 1) + ' 个参数是浅拷贝；契约 8：须为独立深拷贝）';
    }
    if (a === '$element' && !r.isTarget) return '元素参数必须就是被点击的那个元素，第 ' + (i + 1) + ' 个参数不是';
  }
  return null;
}
const MORE_ORDER = ['etl', 'ddl', 'edit-config', 'view-config', 'edit-info', 'history', 'delete'];   // 契约 4：ETL / DDL / 编辑配置或配置（只读）/ 编辑信息 / 变更历史 / 删除
const VALIDATE_ORDER = ['validate-structure', 'validate-data', 'validate-semantic'];
/** 位置断言（预筛 M1）：validate = .model-row-actions 里菜单外的直接按钮；validate-* 只在 data-menu="validate" 的菜单；其余 7 个词只在 data-menu="more" 的菜单；菜单内顺序是契约顺序的子序列 */
/** 契约 6a：置灰菜单项里的 .model-menu-reason 文本与该项 title 逐字相同 */
function checkReasons(descs, rowId) {
  for (const d of descs) {
    if (d.where !== 'menu' || !(d.disabled || d.ariaDisabled)) continue;
    const t = d.title || '';
    if (t === '') throw new Error('置灰菜单项 title 为空（契约 6a：置灰项 title 必须非空）——行 ' + rowId + ' 的 data-act="' + d.act + '"');
    if (d.reasonText === null || d.reasonText === undefined) throw new Error('置灰菜单项缺 .model-menu-reason（契约 6a）——行 ' + rowId + ' 的 data-act="' + d.act + '"（title=' + JSON.stringify(t) + '）');
    if (d.reasonText !== t) throw new Error('置灰原因可见文字与 title 不一致（契约 6a）——行 ' + rowId + ' 的 data-act="' + d.act + '"：可见文字 ' + JSON.stringify(d.reasonText) + '，title ' + JSON.stringify(t));
  }
}
function checkActPositions(descs, rowId) {
  const seq = { more: [], validate: [] };
  for (const d of descs) {
    const lab = '行 ' + rowId + ' 的 data-act="' + d.act + '"';
    const got = '实得 where=' + d.where + ' menuKind=' + d.menuKind + ' inActions=' + d.inActions;
    if (d.act === 'validate') { if (d.where !== 'direct' || !d.inActions) throw new Error('位置不符（契约 4 / 5）——' + lab + ' 必须是 .model-row-actions 里菜单外的直接按钮（⋯ 菜单里不放验收），' + got); }
    else if (VALIDATE_ORDER.includes(d.act)) { if (d.where !== 'menu' || d.menuKind !== 'validate') throw new Error('位置不符（契约 4 / 5）——' + lab + ' 必须在 data-menu="validate" 的验收菜单里（⋯ 菜单里不放验收），' + got); seq.validate.push(d.act); }
    else { if (d.where !== 'menu' || d.menuKind !== 'more') throw new Error('位置不符（契约 4）——' + lab + ' 必须在 data-menu="more" 的 ⋯ 菜单里，' + got); seq.more.push(d.act); }
  }
  const sub = (arr, order, name) => { let last = -1; for (const a of arr) { const i = order.indexOf(a); if (i <= last) throw new Error('菜单项顺序不符（契约 4）——行 ' + rowId + ' 的 ' + name + ' 菜单项序列 [' + arr.join(',') + '] 不是 [' + order.join(',') + '] 的子序列'); last = i; } };
  sub(seq.more, MORE_ORDER, '⋯'); sub(seq.validate, VALIDATE_ORDER, '验收');
}
function buildRowMatrixFromDataAct(descs, rowId) {
  const row = {};
  for (const a of ACTS) row[a] = { present: false, enabled: false, reason: '' };
  for (const d of descs) {
    if (!ACTS.includes(d.act)) throw new Error('data-act 值 ' + JSON.stringify(d.act) + ' 不在词表里（行 ' + rowId + '）');
    if (row[d.act].present) throw new Error('同一行内动作 ' + d.act + ' 出现了两次');
    const enabled = !d.disabled && !d.ariaDisabled;
    const cell = { present: true, enabled, reason: d.title || '' };
    Object.assign(cell, cellFromProbe('动作 ' + d.act + '（行 ' + rowId + '）', enabled, d.calls, rowId, (call) => {
      if (!Object.prototype.hasOwnProperty.call(HANDLER_TO_ACT, call.fn)) return '点击调用了非动作处理函数 ' + call.fn;
      const a = actOfCall(call.fn, call.args);
      return a === d.act ? rawArgProblem(call) : '点击实际调用 ' + call.fn + '（= ' + a + '），与 data-act ' + d.act + ' 不一致';
    }, null));
    row[d.act] = cell;
  }
  checkActPositions(descs, rowId);
  checkReasons(descs, rowId);
  return row;
}
/** rowExtras 的 data-entry 读法：handler 名由 entry 名对应得到，并校验实际调用的函数（open-drawer → openModelDrawer 等） */
function buildRowExtrasFromDataEntry(descs, rowId) {
  const row = {};
  for (const e of EXTRA_ENTRIES) row[e] = { present: false, handler: '', enabled: false };
  for (const d of descs) {
    const entry = ENTRY_ALIAS[d.entry] || d.entry;
    if (!EXTRA_ENTRIES.includes(entry)) throw new Error('data-entry 值 ' + JSON.stringify(d.entry) + ' 不在入口表里（行 ' + rowId + '）');
    if (entry === 'open-drawer' && String(d.modelId) !== String(rowId)) throw new Error('打开按钮的 data-model-id=' + JSON.stringify(d.modelId) + ' 与所在行 ' + rowId + ' 不一致');
    const enabled = !d.disabled && !d.ariaDisabled;
    const cell = { present: true, handler: ENTRY_HANDLER[entry], enabled };
    Object.assign(cell, cellFromProbe('行内入口 ' + entry + '（行 ' + rowId + '）', enabled, d.calls, rowId, (call) => (call.fn === ENTRY_EXPECT_FN[entry] ? rawArgProblem(call) : entry + ' 应调用 ' + ENTRY_EXPECT_FN[entry] + '，实得 ' + call.fn), null, entry === 'design-notes'));
    if (row[entry].present && entry !== 'open-drawer') throw new Error('同一行内入口 ' + entry + ' 出现了两次');
    if (row[entry].present && JSON.stringify(row[entry]) !== JSON.stringify(cell)) throw new Error('同一行内多个抽屉入口的状态不一致');
    row[entry] = cell;
  }
  return row;
}
/**
 * 翻遍全部页读矩阵 + rowExtras（新读法）：总页数取 getCatalogView().totalPages；每页 currentPage = p; renderModelsPage() 后 settle，
 * 检查结构、条目 id 序列 = getCatalogView().pageGroups.flat()、跨页不重复，再点击读。opts = { viewer, timeout, settleFn }。
 */
async function readRowsFromDataAct(page, tr, ids = MODEL_IDS, opts = {}) {
  const viewer = !!opts.viewer;
  const doSettle = opts.settleFn || settle;
  const totalPages = await page.evaluate(() => getCatalogView().totalPages);
  const raw = {}, rawX = {};
  for (let p = 1; p <= totalPages; p++) {
    await page.evaluate((p) => { currentPage = p; renderModelsPage(); }, p);
    await doSettle(page, tr, () => listHash(page), `点击读法翻到第 ${p} 页`);
    await assertCatalogStructure(page, { phase: 'ready', viewer, timeout: opts.timeout });
    const r = await page.evaluate(DESCRIBE_AND_CLICK_FN, CLICK_ARG(viewer, true));
    const exp = await page.evaluate(() => getCatalogView().pageGroups.flat().map(String));
    if (r.dupRows.length) throw new Error('点击读法：第 ' + p + ' 页内同一模型渲染了多次：' + r.dupRows.join(','));
    if (JSON.stringify(r.order) !== JSON.stringify(exp)) throw new Error('结构缺失：第 ' + p + ' 页的条目序列 ' + JSON.stringify(r.order) + ' 与 getCatalogView().pageGroups 展平 ' + JSON.stringify(exp) + ' 不一致');
    for (const id of Object.keys(r.rows)) {
      if (id in raw) throw new Error('点击读法：模型 ' + id + ' 在多页重复渲染（第 ' + p + ' 页再次出现），不得静默覆盖');
      raw[id] = r.rows[id]; rawX[id] = r.extras[id];
    }
    await doSettle(page, tr, () => listHash(page), `点击读法第 ${p} 页点击后`);
  }
  await page.evaluate(() => { currentPage = 1; renderModelsPage(); });
  await doSettle(page, tr, () => listHash(page), '点击读法取样后回到第 1 页');
  const matrix = {}, extras = {};
  for (const id of ids) {
    if (!(String(id) in raw)) throw new Error('点击读法：翻遍 ' + totalPages + ' 页仍找不到模型 ' + id + ' 的条目');
    matrix[id] = buildRowMatrixFromDataAct(raw[id], id); extras[id] = buildRowExtrasFromDataEntry(rawX[id], id);
  }
  // 非 MODEL_IDS 的条目（如填充 ODS）：完整建格校验但不进比较（opts.extraIds → 返回值 extra，由调用方对独立手写期望）
  const extra = { matrix: {}, extras: {} };
  for (const id of opts.extraIds || []) {
    if (!(String(id) in raw)) throw new Error('点击读法：翻遍 ' + totalPages + ' 页仍找不到模型 ' + id + ' 的条目（extraIds）');
    extra.matrix[id] = buildRowMatrixFromDataAct(raw[id], id); extra.extras[id] = buildRowExtrasFromDataEntry(rawX[id], id);
  }
  return { matrix, extras, extra };
}
/**
 * 排序读法（dataact）：键集 = 契约 12 的 8 个键；只对基线仍保留的 6 个键各点三次，写进 sort / sortRendered（口径不变）。
 * 同页证明：每个键每个方向再用程序方式读一次（写 currentSortBy / currentSortDir 全局后 renderModelsPage()，经 getCatalogView().orderedIds 与渲染序），
 *   与点击读到的序列逐项相等；另断言渲染序 = orderedIds（无搜索时每页 pageGroups 展平的拼接就是全集）。
 */
async function readSortDataAct(page, tr, opts = {}) {
  const doSettle = opts.settleFn || settle;
  const keys = await page.evaluate(() => Array.from(document.querySelectorAll('button[data-sort-by]')).map(b => b.dataset.sortBy));
  if (JSON.stringify(keys.slice().sort()) !== JSON.stringify(DATAACT_SORT_KEYS.slice().sort())) throw new Error('排序控件键集不符：页面 ' + JSON.stringify(keys) + '，契约 12 要求恰为 ' + JSON.stringify(DATAACT_SORT_KEYS));
  if (DATAACT_BASELINE_SORT_KEYS.length !== 6) throw new Error('基线保留的排序键应为 6 个，实得 ' + DATAACT_BASELINE_SORT_KEYS.join(','));
  const ids = () => page.evaluate(() => getCatalogView().orderedIds);
  const rendered = (what) => readRenderedOrder(page, tr, what, doSettle);
  const out = {}, rend = {};
  const same = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('排序同页证明失败：' + what + '——' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); };
  out.default = await ids(); rend.default = await rendered('排序 default');
  same(rend.default, out.default, '默认序渲染序列 ≠ orderedIds');
  const init = await page.evaluate(() => ({ by: currentSortBy, dir: currentSortDir }));   // 页面初始值（复位状态）
  const prog = async (by, dir, what) => {
    await page.evaluate(({ init }) => { currentSortBy = init.by; currentSortDir = init.dir; currentPage = 1; renderModelsPage(); }, { init });   // 先复位，再写 (k, dir)：点击写错了全局时这里读到的才会不同
    await doSettle(page, tr, () => listHash(page), what + ' 复位');
    await page.evaluate(({ by, dir }) => { currentSortBy = by; currentSortDir = dir; currentPage = 1; renderModelsPage(); }, { by, dir });
    await doSettle(page, tr, () => listHash(page), what);
    return { ids: await ids(), rendered: await rendered(what) };
  };
  for (const k of DATAACT_BASELINE_SORT_KEYS) {
    const btn = page.locator(`button[data-sort-by="${k}"]`);
    out[k] = {}; rend[k] = {};
    for (const [dir, label] of [['desc', 'desc'], ['asc', 'asc'], [null, 'cleared']]) {
      await btn.click(); await doSettle(page, tr, () => listHash(page), `排序 ${k} ${label}`);
      out[k][label] = await ids(); rend[k][label] = await rendered(`排序 ${k} ${label}`);
      same(rend[k][label], out[k][label], `${k} ${label} 渲染序列 ≠ orderedIds`);
      const pg = await prog(dir ? k : init.by, dir || init.dir, `程序方式 ${k} ${label}`);
      same(out[k][label], pg.ids, `${k} ${label} 点击读到的 orderedIds ≠ 程序方式`);
      same(rend[k][label], pg.rendered, `${k} ${label} 点击读到的渲染序列 ≠ 程序方式`);
    }
    if (JSON.stringify(out[k].cleared) !== JSON.stringify(out.default)) throw new Error('第三次点击后没有回到默认顺序：' + k);
    if (JSON.stringify(rend[k].cleared) !== JSON.stringify(rend.default)) throw new Error('第三次点击后渲染序列没有回到默认序列：' + k);
  }
  return { sort: out, sortRendered: rend };
}

const MODAL_PROBE_FN = () => {
  const open = [];
  document.querySelectorAll('.modal, [id$="Modal"]').forEach((el) => { if (el.id && getComputedStyle(el).display !== 'none' && !open.includes(el.id)) open.push(el.id); });
  open.sort();
  const vis = (id) => open.includes(id);
  let target = null;
  if (vis('validationModal') && typeof currentValidationModelId !== 'undefined') target = currentValidationModelId;
  else if (vis('registerModal') && typeof currentEditId !== 'undefined' && currentEditId !== null) target = currentEditId;
  else { const m = /[?&]id=(\d+)/.exec(location.search); if (m && /Model_Workbench\.html$/.test(location.pathname)) target = Number(m[1]); }
  return { urlSearchEmpty: location.search === '', modal: open.length ? open.join(',') : null, targetModelId: target };
};
/** 深链用例里预期出现的 console / page error 个数（用例名 → {count, reason}）；不在表里的用例一律要求 0 */
const DEEPLINK_CONSOLE_ERRORS = {};
async function readDeepLinks(browserCtx, rowOf, stubRef, withStub) {
  const out = {};
  for (const [label, q] of DEEP_CASES(rowOf)) {
    const id = Number((q.match(/id=(\d+)/) || [])[1]) || null;
    if (id && rowOf(id)) withStub(id); else stubRef.fields = [];
    const { page, tr } = await openPage(browserCtx, q, { noSettle: true });
    const state = async () => ({ ...(await page.evaluate(MODAL_PROBE_FN)), ...(await finalLoc(page)) });
    await settle(page, tr, async () => JSON.stringify(await state()) + (await page.evaluate(() => (document.getElementById('modelListBody') || { innerHTML: '' }).innerHTML.length)), `深链 ${label}`);
    const st = await state();
    const noticeShown = tr.dialogs > 0 || (await page.evaluate(() => window.__mcToasts || 0)) > 0;
    out[label] = { finalPath: st.finalPath, finalSearch: st.finalSearch, urlSearchEmpty: st.urlSearchEmpty, modal: st.modal, targetModelId: st.targetModelId, noticeShown };
    // L5：console / page error 必须为 0；确有预期错误的用例登记在 DEEPLINK_CONSOLE_ERRORS（精确个数 + 理由，多一个少一个都失败）
    const errN = tr.errors + tr.pageErrors, expN = Object.prototype.hasOwnProperty.call(DEEPLINK_CONSOLE_ERRORS, label) ? DEEPLINK_CONSOLE_ERRORS[label].count : 0;
    if (errN !== expN) throw new Error(`深链 ${label} 出现 console / page 错误 ${errN} 个（期望 ${expN}）`);
    await page.close();
  }
  return out;
}

async function readKeywords(token) {
  const out = {};
  for (const [k] of KEYWORDS) {
    const res = await fetch(`${BASE}/api/models?keyword=${encodeURIComponent(k)}`, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('GET /api/models?keyword=' + k + ' → HTTP ' + res.status);
    out[k] = (await res.json()).map(m => m.id).sort((a, b) => a - b);
  }
  return out;
}

const NAV_PROBE_FN = (hiSel) => {
  const cs = (sel, props) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return Object.fromEntries(props.map(p => [p, s[p]])); };
  return {
    navbar: cs('.navbar', ['backgroundColor', 'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor']),
    plainItem: cs('a.nav-item[href="/Data_Collab.html"]', ['color', 'fontWeight']),
    dropdownTrigger: cs('.nav-dropdown-trigger', ['color', 'fontWeight']),
    dropdownMenu: cs('.nav-dropdown-menu', ['backgroundColor', 'borderTopColor']),   // 上边框色 = var(--color-border)
    menuPlainItem: cs('.nav-dropdown-menu a[href="/Dashboard.html"]', ['color', 'fontWeight']),
    highlightItem: cs(hiSel, ['color', 'fontWeight']),
    // M2：E 配色会动的变量消费者（--color-accent / --color-border / --color-text-primary）
    navTitle: cs('.nav-title', ['backgroundColor', 'backgroundImage']),        // background: var(--color-accent)
    navDivider: cs('.nav-divider', ['backgroundColor']),                       // var(--color-border)
    avatar: cs('.avatar-circle', ['backgroundColor']),                         // var(--color-accent)（app.js 渲染，等头像出现再取）
    profileName: cs('.profile-name', ['color']),                               // var(--color-text-primary)
  };
};
/**
 * M2 豁免表：页面 → { 探针键: 理由 }。某页在 HEAD 上确实没有该元素时才允许写在这里；没写而缺失 = 录制失败（不得静默跳过）。
 * 现状（HEAD）：两页上这些元素都存在，表为空。
 */
const NAV_MISSING_EXEMPT = {};
/** 悬停态取样：.nav-item（普通导航项）与下拉菜单项各取一个，hover 后等 CSS 过渡结束再读（transition: all 0.2s / 0.15s） */
async function readNavHover(page, tr, what) {
  const finished = () => page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.then(() => 0, () => 0))).then(() => document.getAnimations().length));
  const read = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const c = getComputedStyle(e); return { backgroundColor: c.backgroundColor, color: c.color }; }, sel);
  const out = {};
  await page.mouse.move(1, 1);
  await page.hover('a.nav-item[href="/Data_Collab.html"]');
  await finished(); await settle(page, tr, () => read('a.nav-item[href="/Data_Collab.html"]').then(JSON.stringify), what + ' 悬停 nav-item');
  out.hoverPlainItem = await read('a.nav-item[href="/Data_Collab.html"]');
  await page.mouse.move(1, 1);
  await page.hover('.nav-dropdown-trigger');
  await page.hover('.nav-dropdown-menu a[href="/Dashboard.html"]');
  await finished(); await settle(page, tr, () => read('.nav-dropdown-menu a[href="/Dashboard.html"]').then(JSON.stringify), what + ' 悬停下拉菜单项');
  out.hoverMenuItem = await read('.nav-dropdown-menu a[href="/Dashboard.html"]');
  await page.mouse.move(1, 1);
  return out;
}
async function readNav(ctx) {
  const out = {};
  for (const [name, file, hiSel] of [['Model_Center', 'Model_Center.html', '.nav-dropdown-menu a[href="/Model_Center.html"]'], ['Task_Pool', 'Task_Pool.html', 'a.nav-item[href="/Task_Pool.html"]']]) {
    const page = await ctx.newPage();
    const tr = track(page);
    await page.goto(`${BASE}/${file}`, { waitUntil: 'load' });
    await page.waitForSelector('.navbar', { timeout: SETTLE_LIMIT_MS });
    await page.waitForSelector('.avatar-circle', { timeout: SETTLE_LIMIT_MS });   // 确定信号：app.js 渲染完头像 = 按角色显隐导航跑完（取代 sleep(500)）
    await settle(page, tr, () => page.evaluate(() => document.querySelector('.navbar').innerHTML.length), `导航 ${name}`);
    const cur = await page.evaluate(NAV_PROBE_FN, hiSel);
    const exempt = NAV_MISSING_EXEMPT[name] || {};
    for (const [k, v] of Object.entries(cur)) if (v === null) { if (!exempt[k]) throw new Error('nav 探针没找到元素：' + name + '.' + k + '（HEAD 上确实没有的话，写进 NAV_MISSING_EXEMPT 并给理由）'); delete cur[k]; }
    out[name] = { ...cur, ...(await readNavHover(page, tr, `导航 ${name}`)) };
    for (const [k, v] of Object.entries(out[name])) if (v === null) throw new Error('nav 探针没找到元素：' + name + '.' + k);
    if (tr.errors + tr.pageErrors) throw new Error(`导航 ${name} 出现 console 错误 ${tr.errors + tr.pageErrors} 个`);
    await page.close();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 比较（allowedChanges 规则；复制自 C3a-0，规则来源改为本文件 ALLOWED_CHANGES）
// ---------------------------------------------------------------------------------------------
/**
 * 已登记的允许差异。结构照 C3a-0：{ id, source, title, rules:[{ pathRe, expect }] }。
 * 本基线只放行两种期望：{ eq: <精确新值> } 与 { absent: true }（M3：其余类型 notIncludes / sameAsCurrent 等弱期望一律在建规则时抛错）。
 * pathRe 一律按整串匹配（比较时包成 ^(?:…)$）。C4a–C4e 只在这里追加登记（精确值），不重录 baseline.json。当前：C4B-SORT 58 条（buildAllowedChanges 由基线推出）。
 * --self-test-compare 会对每条登记规则做逐条自证（节点在基线里存在 / 期望新值放行 / 第三个值判红）。
 */
let ALLOWED_CHANGES = null;   // C4b：C4B-SORT（58 条，由基线按规则推出）；[#106 S4b2] 值 buildAllowedChanges() 在 initDerived() 里赋（它读 baseline.json，路径在 ready 之后才有）

const escRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, (c) => '\\' + c);
const exactRe = (p) => '^' + escRe(p) + '$';
const subst = (v, m) => (typeof v === 'string' ? v.replace(/\$(\d)/g, (_, i) => (m && m[+i] !== undefined ? m[+i] : '')) : v);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function deepDiff(a, b, p = '', out = []) {
  if (a === b) return out;
  const ta = typeof a, tb = typeof b;
  if (ta !== tb || a === null || b === null || ta !== 'object') { out.push(p || '(root)'); return out; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(p || '(root)'); return out; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) deepDiff(a[k], b[k], p ? `${p}.${k}` : k, out);
  return out;
}
/** 路径解析（键名本身可含 '.'，逐段贪婪匹配；关键词 / 排序键里有 '.' 或空格都能解析） */
function getAt(o, p) {
  if (p === '') return { found: true, value: o };
  if (o === null || typeof o !== 'object') return { found: false };
  for (const k of Object.keys(o)) {
    if (p === k) return { found: true, value: o[k], parent: o, key: k };
    if (p.startsWith(k + '.')) { const r = getAt(o[k], p.slice(k.length + 1)); if (r.found) return r; }
  }
  return { found: false };
}
function satisfies(expect, cur, p, m) {
  const r = getAt(cur, p);
  if (expect.absent) return { ok: !r.found, why: '期望键不存在' };
  if (!r.found) return { ok: false, why: '键不存在' };
  if ('eq' in expect) { const want = subst(expect.eq, m); return { ok: deepEqual(r.value, want), why: `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(r.value)}` }; }
  throw new Error('不支持的期望类型 ' + JSON.stringify(Object.keys(expect)) + '（本基线只允许 eq / absent）');
}
/** 建规则时校验期望类型：只允许 { eq } 或 { absent: true }，其余直接抛错（不是判红，是登记本身非法） */
function assertExpectAllowed(id, expect) {
  const ks = expect && typeof expect === 'object' ? Object.keys(expect) : [];
  if (ks.length === 1 && (ks[0] === 'eq' || (ks[0] === 'absent' && expect.absent === true))) return;
  throw new Error('登记 ' + id + ' 的期望类型不被允许 ' + JSON.stringify(ks) + '：本基线只放行 { eq: 精确值 } 与 { absent: true }');
}
const nodeCandidates = (d) => { const c = [d]; for (let i = 0; i < d.length; i++) if (d[i] === '.') c.push(d.slice(0, i)); return c; };
function compareBaselines(base, cur, allowChanges = ALLOW_CHANGES, allowed0 = ALLOWED_CHANGES) {
  const diffs = deepDiff(cur, base).filter(d => !d.startsWith('meta.') && !d.startsWith('allowedChanges'));
  const rules = allowed0.flatMap(a => a.rules.map(r => { assertExpectAllowed(a.id, r.expect); return { id: a.id, re: new RegExp('^(?:' + r.pathRe + ')$'), expect: r.expect }; }));   // M3：整串匹配
  const real = [], allowed = [], cache = new Map(), hitKeys = new Set();
  for (const d of diffs) {
    if (!allowChanges) { real.push(d); continue; }
    let hit = null, why = null;
    for (const P of nodeCandidates(d)) {
      for (const r of rules) {
        const m = r.re.exec(P); if (!m) continue;
        const key = r.id + '|' + r.re.source + '|' + P;
        if (!cache.has(key)) cache.set(key, satisfies(r.expect, cur, P, m));
        const s = cache.get(key);
        if (s.ok) { hit = r; break; }
        if (!why) why = `[${r.id}] ${P}：${s.why}`;
      }
      if (hit) break;
    }
    if (hit) { allowed.push(`${d}  [允许 ${hit.id}]`); hitKeys.add(hit.id + '|' + hit.re.source); } else real.push(why ? `${d}  （登记键未满足期望：${why}）` : d);
  }
  return { real, allowed, hitKeys };
}

// ---- 比较机制自证（不起服务）----
function leafPaths(o, p = '', out = []) {
  if (o !== null && typeof o === 'object') { for (const k of Object.keys(o)) leafPaths(o[k], p ? p + '.' + k : k, out); } else out.push(p);
  return out;
}
function setAt(o, p, v, del) { const r = getAt(o, p); if (!r.found) throw new Error('setAt 找不到 ' + p); if (del) delete r.parent[r.key]; else r.parent[r.key] = v; }
function selfTestCompare() {
  const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  let bad = 0, n = 0;
  const check = (label, cond) => { n++; if (!cond) { bad++; console.log('  FAIL ' + label); } };
  const A = (id, rules) => ({ id, source: 'self-test', title: id, rules });
  const E = (p, expect) => ({ pathRe: exactRe(p), expect });
  const run = (cur, allow, rules) => compareBaselines(base, cur, allow, rules);
  const noRules = [];
  // 0 基线结构：五段齐全、矩阵规模
  for (const sec of ['matrix', 'rowExtras', 'sort', 'sortRendered', 'deepLinks', 'keyword', 'nav']) check(`基线含顶层段 ${sec}`, base[sec] && typeof base[sec] === 'object');
  check('矩阵规模 = 角色 × 模型 × 动作', ROLES.every(r => MODEL_IDS.every(id => ACTS.every(a => getAt(base, `matrix.${r}.${id}.${a}`).found))));
  { // H1：每个 present 格要么有 call（可用）要么 inert（置灰），二者互斥；absent 格两者都没有；rowExtras 同理
    let okAll = true;
    const eachCell = (sec, f) => { for (const role of Object.keys(base[sec])) for (const id of Object.keys(base[sec][role])) for (const k of Object.keys(base[sec][role][id])) f(base[sec][role][id][k]); };
    for (const sec of ['matrix', 'rowExtras']) eachCell(sec, (c) => { const k = (c.call ? 1 : 0) + (c.inert ? 1 : 0) + (c.dead ? 1 : 0); if (c.present && c.enabled && !(k === 1 && !c.inert)) okAll = false; if (c.present && !c.enabled && !(c.inert === true && k === 1)) okAll = false; if (!c.present && k) okAll = false; if (c.call && !(typeof c.call.fn === 'string' && Array.isArray(c.call.args))) okAll = false; });
    check('每个 present 格有 call / inert / dead 之一（互斥；置灰只能 inert），absent 格没有', okAll);
  }
  { // M1：渲染序列段与排序段同键同集
    const same = Object.keys(base.sort).length === Object.keys(base.sortRendered).length && Object.keys(base.sort).every(k => k in base.sortRendered);
    check('sortRendered 与 sort 键集相同', same);
    check('sortRendered 每个序列无重复且与 sort 同集', Object.keys(base.sortRendered).every(k => { const pairs = k === 'default' ? [[base.sort.default, base.sortRendered.default]] : ['desc', 'asc', 'cleared'].map(d => [base.sort[k][d], base.sortRendered[k][d]]); return pairs.every(([a, b]) => b && new Set(b).size === b.length && b.length === a.length && a.every(x => b.includes(x))); }));
  }
  check('未改动：0 差异（两种模式）', run(clone(base), true, noRules).real.length === 0 && run(clone(base), false, noRules).real.length === 0);
  // 1 未登记键变化：无规则时一律判红（两种模式）
  const leaves = leafPaths(base).filter(l => !l.startsWith('meta.') && !l.startsWith('allowedChanges'));
  const boolLeaf = 'matrix.admin.50.ddl.enabled';
  const orig = getAt(base, boolLeaf).value;
  { const c = clone(base); setAt(c, boolLeaf, !orig); check('未登记键翻转：--allow-changes 下判红', run(c, true, noRules).real.length === 1); check('未登记键翻转：默认模式判红', run(c, false, noRules).real.length === 1); }
  // 2 登记 eq：满足期望放行（仅 --allow-changes），第三个值判红
  const rulesEq = [A('T-EQ', [E(boolLeaf, { eq: !orig })])];
  { const c = clone(base); setAt(c, boolLeaf, !orig); const ra = run(c, true, rulesEq), rd = run(c, false, rulesEq); check('登记 eq：满足期望值 → --allow-changes 放行', ra.real.length === 0 && ra.allowed.length === 1); check('登记 eq：同一改动默认模式判红', rd.real.length === 1 && rd.allowed.length === 0); }
  { const c = clone(base); setAt(c, boolLeaf, '__third__'); const r = run(c, true, rulesEq); check('登记 eq：第三个值判红', r.real.length === 1 && r.allowed.length === 0); }
  // 3 精确值：登记的期望与实得差一个字符也判红（reason 字符串）
  const reasonLeaf = 'matrix.admin.53.etl.reason';
  { const rs = [A('T-EQ2', [E(reasonLeaf, { eq: '期望文案' })])]; const c = clone(base); setAt(c, reasonLeaf, '期望文案 '); check('精确值：多一个空格判红', run(c, true, rs).real.length === 1); setAt(c, reasonLeaf, '期望文案'); check('精确值：恰好相等放行', run(c, true, rs).real.length === 0); }
  // 4 缺键 / 多键
  { const c = clone(base); setAt(c, 'matrix.admin.50.ddl', null, true); const r = run(c, true, noRules); check('缺键（删掉一个动作）判红', r.real.length >= 1);
    const rs = [A('T-ABS', [E('matrix.admin.50.ddl', { absent: true })])]; check('登记 absent：缺键放行', run(c, true, rs).real.length === 0);
    const c2 = clone(base); c2.matrix.admin['50'].extraAct = { present: true, enabled: true, reason: '' }; check('多键（未登记）判红', run(c2, true, noRules).real.length >= 1);
    const c3 = clone(base); c3.matrix.admin['999'] = c3.matrix.admin['50']; check('多模型行（未登记）判红', run(c3, true, noRules).real.length >= 1);
    const c4 = clone(base); delete c4.nav.Task_Pool; check('缺整段 nav.Task_Pool 判红', run(c4, true, noRules).real.length >= 1); }
  // 5 数组截断 / 顺序
  { const arrPath = 'sort.id.desc'; const arr = getAt(base, arrPath).value; const c = clone(base); setAt(c, arrPath, arr.slice(0, -1)); check('数组截断（未登记）判红', run(c, true, noRules).real.length >= 1);
    const rs = [A('T-ARR', [E(arrPath, { eq: arr.slice().reverse() })])];
    check('登记 eq 整数组：截断判红', run(c, true, rs).real.length >= 1);
    const c2 = clone(base); setAt(c2, arrPath, arr.slice().reverse()); const r2 = run(c2, true, rs); check('登记 eq 整数组：恰好为期望（倒序）放行', r2.real.length === 0 && r2.allowed.length >= 1);
    const c3 = clone(base); const sw = arr.slice(); [sw[0], sw[1]] = [sw[1], sw[0]]; setAt(c3, arrPath, sw); check('数组仅交换两项（未登记）判红', run(c3, true, noRules).real.length >= 1); }
  // 6 正则不全匹配：规则路径少一个字符 / 多一层，不得放行
  { const rs = [A('T-RE', [{ pathRe: exactRe('matrix.admin.50.ddl.enable'), expect: { eq: !orig } }])]; const c = clone(base); setAt(c, boolLeaf, !orig); check('pathRe 不全匹配（少一个字符）不放行', run(c, true, rs).real.length === 1);
    const rs2 = [A('T-RE2', [{ pathRe: 'matrix\\.admin\\.50\\.ddl\\.enabled', expect: { eq: !orig } }])]; check('没写锚点、但整串写全的正则：整串命中时放行（与锚定写法等价）', run(c, true, rs2).real.length === 0);
    const rs3 = [A('T-RE3', [E('matrix.admin.5', { eq: {} })])]; check('键前缀（#5 vs #50）不串号', run(c, true, rs3).real.length === 1);
    // M3：未锚定的子串规则不得越界放行——旧实现 exec 不锚定，'matrix\.admin\.5' 会在节点 matrix.admin.50 上命中并按该节点当前值放行
    const c5 = clone(base); setAt(c5, boolLeaf, !orig);
    const rs4 = [A('T-SUB', [{ pathRe: 'matrix\\.admin\\.5', expect: { eq: clone(c5.matrix.admin['50']) } }])];
    check('未锚定的子串规则（matrix.admin.5 越界命中 matrix.admin.50）不得放行', run(c5, true, rs4).real.length === 1 && run(c5, true, rs4).allowed.length === 0);
    const rs5 = [A('T-SUB2', [{ pathRe: 'admin\\.50\\.ddl\\.enabled', expect: { eq: !orig } }])];
    check('未锚定的后缀子串规则（admin.50.ddl.enabled 缺 matrix. 前缀）不得放行', run(c5, true, rs5).real.length === 1); }
  // 7 期望类型：只允许 eq / absent；notIncludes / sameAsCurrent / 混合 / 未知类型建规则时直接抛错
  { const thrown = (rules) => { try { run(clone(base), true, rules); return false; } catch (e) { return /不被允许/.test(e.message); } };
    check('期望类型 notIncludes 被拒绝（抛错）', thrown([A('T-NI', [E('keyword.dim_', { notIncludes: 1 })])]));
    check('期望类型 sameAsCurrent 被拒绝（抛错）', thrown([A('T-SAC', [E('matrix.admin.50.ddl', { sameAsCurrent: 'matrix.admin.52.ddl', fields: ['present'] })])]));
    check('期望类型 eq + notIncludes 混写被拒绝（抛错）', thrown([A('T-MIX', [E('keyword.dim_', { eq: [], notIncludes: 1 })])]));
    check('期望类型 absent:false 被拒绝（抛错）', thrown([A('T-ABF', [E('keyword.dim_', { absent: false })])]));
    check('空期望被拒绝（抛错）', thrown([A('T-EMPTY', [E('keyword.dim_', {})])])); }
  // 7b 逐条登记规则自证（C3a-0 W:603-653 的做法）：规则命中的节点在基线里存在、满足期望的新值放行、第三个值判红
  const proveRules = (list, tag, chk = check) => {
    const allRules = list.flatMap(a => a.rules.map(r => ({ id: a.id, pathRe: r.pathRe, re: new RegExp('^(?:' + r.pathRe + ')$'), expect: r.expect })));
    for (const r of allRules) {
      let P = null, m = null;
      for (const l of leaves) { for (const cnd of nodeCandidates(l)) { const mm = r.re.exec(cnd); if (mm && getAt(base, cnd).found) { P = cnd; m = mm; break; } } if (P) break; }
      if (!P) { chk(`${tag}：${r.id} 规则 ${r.pathRe} 在基线里找不到对应节点（登记路径失效）`, false); continue; }
      const label = `${tag}：${r.id} ${P}`;
      const a = clone(base);
      if (r.expect.absent) setAt(a, P, null, true); else setAt(a, P, subst(r.expect.eq, m));
      const ra = run(a, true, list), rd = run(a, false, list);
      chk(`${label}：满足期望的新值在 --allow-changes 下放行`, ra.real.length === 0);
      chk(`${label}：同一改动在默认模式下判红（或无差异）`, rd.real.length === ra.allowed.length);
      const b = clone(base); setAt(b, P, '__third__');
      const rb = run(b, true, list);
      chk(`${label}：第三个值在 --allow-changes 下判红`, rb.real.length >= 1 && rb.allowed.length === 0);
    }
    return allRules.length;
  };
  const provedReal = proveRules(ALLOWED_CHANGES, 'ALLOWED_CHANGES');   // C4b 起 C4B-SORT，C4c-2 起共 6 族 143 条，每条被逐条自证（节点存在 / 期望新值放行 / 第三个值判红）
  check('C4c-2 登记共 143 条', provedReal === 143);
  { const want = { 'C4B-SORT': 34, 'C4C-PU1': 42, 'C4C-D18': 28, 'C4C-DEAD': 7, 'C4C-ITER': 24, 'C4C-SORT-RM': 8 };   // 手写条数（A.4）
    check('登记族恰为 6 个且各族条数 = 34 / 42 / 28 / 7 / 24 / 8', JSON.stringify(ALLOWED_CHANGES.map(a => a.id + ':' + a.rules.length)) === JSON.stringify(Object.keys(want).map(k => k + ':' + want[k]))); }
  { const cs = ALLOWED_CHANGES.find(a => a.id === 'C4B-SORT'); const regPaths = cs.rules.map(r => r.pathRe.replace(/^\^|\$$/g, '').replace(/\\(.)/g, '$1')); check('C4B-SORT 登记的路径恰为 sort / sortRendered 段，不含不变的 4 条', regPaths.every(p => /^(sort|sortRendered)\./.test(p)) && C4B_SORT_UNCHANGED.every(p => !regPaths.includes(p)));
    check('C4B-SORT 只登记仍有排序按钮的 6 个键（不含四个下线键）', regPaths.every(p => !/\.(table_comment|biz_owner|update_cycle|archived_task_count)\./.test(p)) && regPaths.some(p => /\.updated_at\./.test(p)) && regPaths.some(p => /\.status\./.test(p))); }
  { // 手写抽查（不经 buildAllowedChanges 的推导路径）：PU1 / D18 / DEAD / ITER / SORT-RM 的取值
    const find = (fam, p) => { const a = ALLOWED_CHANGES.find(x => x.id === fam); const r = a && a.rules.find(x => x.pathRe === '^' + p.split('.').join('\\.') + '$'); return r ? r.expect : null; };
    check('PU1：admin 伴生 #53 的 delete → 置灰「伴生表随主模型的变更追踪开关增删」', deepEqual(find('C4C-PU1', 'matrix.admin.53.delete'), { eq: { present: true, enabled: false, reason: '伴生表随主模型的变更追踪开关增删', inert: true } }));
    check('PU1：admin 伴生 #53 的 edit-info → 可用，调用 openEditModal(行副本)', deepEqual(find('C4C-PU1', 'matrix.admin.53.edit-info'), { eq: { present: true, enabled: true, reason: '', call: { fn: 'openEditModal', args: [{ $model: 53 }] } } }));
    check('PU1：nonowner 伴生 #53 的 edit-info → 置灰「无编辑权限」（基线同格删除不可用）', deepEqual(find('C4C-PU1', 'matrix.nonowner.53.edit-info'), { eq: { present: true, enabled: false, reason: '无编辑权限', inert: true } }));
    check('PU1：owner 的伴生 #208 edit-info 可用（owner 负责 #207 / #208）', deepEqual(find('C4C-PU1', 'matrix.owner.208.edit-info'), { eq: { present: true, enabled: true, reason: '', call: { fn: 'openEditModal', args: [{ $model: 208 }] } } }));
    check('D18：admin ODS #6 的 edit-config → 置灰「ODS 无平台配置，请用编辑信息」', deepEqual(find('C4C-D18', 'matrix.admin.6.edit-config'), { eq: { present: true, enabled: false, reason: 'ODS 无平台配置，请用编辑信息', inert: true } }));
    check('D18：不登记 viewer 与非 ODS 模型', find('C4C-D18', 'matrix.viewer.6.edit-config') === null && find('C4C-D18', 'matrix.admin.50.edit-config') === null);
    check('DEAD：owner 的 #6 ddl → 可用，调用 openDDLModal(行副本)', deepEqual(find('C4C-DEAD', 'matrix.owner.6.ddl'), { eq: { present: true, enabled: true, reason: '', call: { fn: 'openDDLModal', args: [{ $model: 6 }] } } }));
    check('ITER：viewer 的 #55 迭代徽章 → 消失', deepEqual(find('C4C-ITER', 'rowExtras.viewer.55.iteration-badge'), { eq: { present: false, handler: '', enabled: false } }));
    check('SORT-RM：sort.biz_owner 与 sortRendered.update_cycle 整段下线', deepEqual(find('C4C-SORT-RM', 'sort.biz_owner'), { absent: true }) && deepEqual(find('C4C-SORT-RM', 'sortRendered.update_cycle'), { absent: true }));
  }
  { // 对合成规则跑通自证流程本身（证明遍历 + 三段断言在有规则时真的会执行且会判红）
    const synth = [A('SYN', [E(boolLeaf, { eq: !orig }), E('matrix.admin.53.etl', { absent: true }), { pathRe: 'sort\\.(id)\\.desc', expect: { eq: getAt(base, 'sort.id.desc').value.slice().reverse() } }])];
    const before = n; const cnt = proveRules(synth, 'SYN'); check('自证流程对合成规则逐条执行（3 条 × 3 断言）', cnt === 3 && n - before === 9);
    // 自证本身要能判红：期望新值与第三个值判定被劫持（规则 eq 恰好等于 __third__ 时，第三个值会被放行）→ 流程应报失败
    const trap = [A('TRAP', [E(boolLeaf, { eq: '__third__' })])]; let failed = 0; const cnt2 = proveRules(trap, 'TRAP', (_l, ok) => { if (!ok) failed++; }); check('自证流程能判红：期望值 = 第三个值的退化规则被抓出', cnt2 === 1 && failed >= 1); }
  console.log(`[self-test-compare] 登记规则逐条自证：ALLOWED_CHANGES ${provedReal} 条（空表也要走流程）`);
  // 7c 类型替换（codex 32 L1）：number→string、object→标量、array→object，默认模式与 allow-changes 模式都必须判红
  for (const [label, p, v] of [['number→string', 'sort.id.desc.0', 'x'], ['object→标量', 'matrix.admin.50.ddl', 'x'], ['标量→object', boolLeaf, {}], ['array→object', 'sort.id.desc', {}], ['object→array', 'matrix.admin.50.ddl', []], ['number→array', 'sort.id.desc.0', []]]) {
    const c = clone(base); setAt(c, p, v);
    check(`类型替换 ${label}（${p}）：--allow-changes 判红`, run(c, true, noRules).real.length >= 1);
    check(`类型替换 ${label}（${p}）：默认模式判红`, run(c, false, noRules).real.length >= 1);
  }
  // 8 meta / allowedChanges 段的差异不计入
  { const c = clone(base); c.meta = { ...(c.meta || {}), note: 'x' }; check('meta 段差异不计入', run(c, false, noRules).real.length === 0); }
  // 9 随机抽 3 个叶子翻成第三个值：全部判红（覆盖面抽查）
  { const pick = [leaves[0], leaves[Math.floor(leaves.length / 2)], leaves[leaves.length - 1]]; for (const l of pick) { const c = clone(base); setAt(c, l, '__third__'); check(`叶子 ${l} 翻成第三个值：判红`, run(c, true, noRules).real.length === 1); } }
  console.log(`[self-test-compare] ${n - bad}/${n} 通过（基线叶子 ${leaves.length} 个）`);
  return bad ? 1 : 0;
}

// ---- settle 硬门自证（--self-test-settle：不起服务，只起浏览器 + data: 页面；注入 interval / 6000ms 定时器必须判红；复制自 C3a-0）----
async function selfTestSettle() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  let bad = 0, n = 0;
  const check = (label, cond, extra) => { n++; if (!cond) { bad++; console.log('  FAIL ' + label + (extra ? '：' + extra : '')); } };
  try {
    const run = async (label, inject, expectRed, re) => {
      const ctx = await browser.newContext();
      await ctx.addInitScript(INIT_SCRIPT);
      const page = await ctx.newPage();
      const tr = track(page);
      await page.goto('data:text/html,<html><body>x</body></html>');
      await page.evaluate(inject);
      let err = null;
      try { await settle(page, tr, () => page.evaluate(() => document.body.innerHTML.length), 'self-test'); } catch (e) { err = e; }
      if (expectRed) check(label + '：判红', !!err && re.test(err.message), err ? err.message.slice(0, 160) : '未抛错');
      else check(label + '：不误报', !err, err && err.message.slice(0, 160));
      await ctx.close();
    };
    await run('对照：无定时器', () => {}, false);
    await run('对照：短 setTimeout（100ms）会触发并等待', () => { setTimeout(() => {}, 100); }, false);
    await run('对照：2000ms setTimeout 等它触发，不触发硬门', () => { setTimeout(() => {}, 2000); }, false);
    await run('对照：interval 已 clear', () => { const i = setInterval(() => {}, 500); clearInterval(i); }, false);
    await run('对照：6000ms 定时器已 clear', () => { const t = setTimeout(() => {}, 6000); clearTimeout(t); }, false);
    await run('变异：注入活动 setInterval', () => { setInterval(() => {}, 700); }, true, /长期 \/ 周期定时器：setInterval/);
    await run('变异：注入 6000ms setTimeout', () => { setTimeout(() => {}, 6000); }, true, /长期 \/ 周期定时器：setTimeout 延迟 6000ms/);
    await run('变异：interval 在 setTimeout 回调里创建', () => { setTimeout(() => { setInterval(() => {}, 300); }, 150); }, true, /setInterval/);
  } finally { await browser.close(); }
  console.log('[self-test-settle] ' + (n - bad) + '/' + n + ' 通过');
  return bad ? 1 : 0;
}

// ---- 对应表自证（--self-test-mapping）----
async function selfTestMapping() {
  let bad = 0, n = 0;
  const check = (label, cond, extra) => { n++; if (!cond) { bad++; console.log('  FAIL ' + label + (extra ? '：' + extra : '')); } };
  const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e && e.message); } };
  const oc = (name, args = '5') => `${name}(${args})`;
  // 1 未知处理函数名 → 必须抛错
  { const m = throws(() => classifyElement({ onclick: oc('someBrandNewHandler'), text: 'X', disabled: false, notAllowed: false })); check('未知函数名抛错', !!m && /不在 HANDLER_TO_ACT/.test(m), m || '未抛错'); }
  { const m = throws(() => classifyElement({ onclick: "event.stopPropagation(); closeDimEditMenus(); mysteryAction(5)", text: 'X' })); check('菜单项里夹带未知函数名抛错', !!m && /mysteryAction/.test(m), m || '未抛错'); }
  { const m = throws(() => classifyElement({ onclick: "openDimDDLModal(1); openDimETLModal(1)", text: 'X' })); check('一个元素里两个动作函数抛错', !!m && /多个动作/.test(m), m || '未抛错'); }
  { const m = throws(() => classifyElement({ onclick: "closeDimEditMenus()", text: 'X' })); check('只有菜单修饰函数、没有动作也不是触发按钮 → 抛错', !!m, m || '未抛错'); }
  // 2 已知函数名 → 映射正确（对应表每一项）
  for (const [fn, act] of Object.entries(HANDLER_TO_ACT)) {
    if (fn === 'openWorkbench' || fn === 'openValidationModal') continue;
    const r = classifyElement({ onclick: oc(fn), text: 'X', disabled: false, notAllowed: false, title: 't' });
    check(`${fn} → ${act}`, r && r.act === act && r.enabled === true && r.reason === 't');
  }
  // 3 带参数细分：验收阶段 / 配置台模式
  for (const [ph, act] of [['structure', 'validate-structure'], ['data', 'validate-data'], ['semantic', 'validate-semantic']]) {
    const r = classifyElement({ onclick: `event.stopPropagation(); closeDimValidateDropdowns(); openValidationModal(55, "dim_x", "CREATED", "DIM", "${ph}")`, text: '验收' });
    check(`openValidationModal 阶段 ${ph} → ${act}`, r && r.act === act);
  }
  check('openValidationModal 无阶段（ODS）→ validate', classifyElement({ onclick: 'openValidationModal(6, "ods_x", "ONLINE", "ODS")', text: '验收' }).act === 'validate');
  { const m = throws(() => classifyElement({ onclick: 'openValidationModal(6, "t", "S", "DIM", "bogus")', text: 'x' })); check('openValidationModal 未知阶段抛错', !!m && /阶段参数/.test(m), m || '未抛错'); }
  check("openWorkbench(…,'edit') → edit-config", classifyElement({ onclick: "event.stopPropagation(); closeDimEditMenus(); openWorkbench(50, 'edit')", text: '编辑配置' }).act === 'edit-config');
  check("openWorkbench(…,'view') → view-config", classifyElement({ onclick: "openWorkbench(50, 'view')", text: '配置' }).act === 'view-config');
  { const m = throws(() => classifyElement({ onclick: "openWorkbench(50, 'zzz')", text: 'x' })); check('openWorkbench 未知模式抛错', !!m && /模式参数/.test(m), m || '未抛错'); }
  check('编辑信息菜单项（嵌套 JSON.parse / this.closest）→ edit-info', classifyElement({ onclick: "event.stopPropagation(); closeDimEditMenus(); openEditModal(JSON.parse(this.closest('.dim-edit-dropdown').dataset.model))", text: '编辑信息' }).act === 'edit-info');
  check('下拉触发按钮（toggleDimEditMenu / toggleDimValidateDropdown）→ null（不是动作）', classifyElement({ onclick: 'toggleDimEditMenu(event, this)', text: '编辑' }) === null && classifyElement({ onclick: 'event.stopPropagation(); toggleDimValidateDropdown(this)', text: '验收 ▾' }) === null);
  // 4 无 onclick 元素按文字归类；未知文字抛错；置灰一致性
  for (const [lb, act] of Object.entries(LABEL_TO_ACT)) { const r = classifyElement({ onclick: '', text: ' ' + lb + ' ', disabled: true, notAllowed: true, title: '无权限' }); check(`无 onclick「${lb}」→ ${act}（置灰）`, r && r.act === act && r.enabled === false && r.reason === '无权限'); }
  { const m = throws(() => classifyElement({ onclick: '', text: '未知按钮', disabled: true, notAllowed: true })); check('无 onclick 的未知文字抛错', !!m && /LABEL_TO_ACT/.test(m), m || '未抛错'); }
  { const m = throws(() => classifyElement({ onclick: 'openDimDDLModal(1)', text: 'DDL', disabled: true, notAllowed: false })); check('disabled 属性与置灰样式不一致抛错', !!m && /置灰方式不一致/.test(m), m || '未抛错'); }
  // 5 行矩阵：词表全量、重复动作抛错、缺席动作 present=false
  { const row = buildRowMatrix([{ onclick: 'openDimDDLModal(1)', text: 'DDL', disabled: false, notAllowed: false }], false); check('行矩阵含词表全量', ACTS.every(a => a in row) && row.ddl.present && !row.etl.present && row.etl.enabled === false); }
  { const m = throws(() => buildRowMatrix([{ onclick: 'openDimDDLModal(1)', text: 'DDL' }, { onclick: 'openDwdDDLModal(1)', text: 'DDL' }], false)); check('同一动作重复出现抛错', !!m && /出现了两次/.test(m), m || '未抛错'); }
  // 5b rowExtras 对应表
  check('抽屉入口 → open-drawer', classifyExtra({ drawer: true, onclick: '', disabled: false }).handler === 'open-drawer');
  check('迭代徽章 viewIterationHistory → iteration-history（与主矩阵 history 不同名，L4）', (() => { const r = classifyExtra({ onclick: 'viewIterationHistory(55)', disabled: false }); return r.entry === 'iteration-badge' && r.handler === 'iteration-history' && r.handler !== HANDLER_TO_ACT.viewModelChangeLogs; })());
  check('设计说明气泡 → design-notes', (() => { const r = classifyExtra({ onclick: 'event.stopPropagation(); showDesignNotesPopover(this, "x")', disabled: false }); return r.entry === 'design-notes' && r.handler === 'design-notes'; })());
  { const m = throws(() => classifyExtra({ onclick: 'someNewBadgeHandler(1)' })); check('行内入口未知处理函数抛错', !!m && /不在 EXTRA_HANDLER/.test(m), m || '未抛错'); }
  { const m = throws(() => classifyExtra({ onclick: '' })); check('行内入口无 onclick 且不是抽屉按钮抛错', !!m, m || '未抛错'); }
  { const m = throws(() => buildRowExtras([{ onclick: 'viewIterationHistory(1)' }, { onclick: 'viewIterationHistory(1)' }], false)); check('同一行迭代徽章重复抛错', !!m && /出现了两次/.test(m), m || '未抛错'); }
  { const row = buildRowExtras([{ drawer: true }, { drawer: true }], false); check('同一行两个抽屉入口合并为一个，其它入口缺席', row['open-drawer'].present && !row['design-notes'].present && !row['iteration-badge'].present && EXTRA_ENTRIES.every(e => e in row)); }
  { const m = throws(() => buildRowExtras([{ drawer: true }, { drawer: true, disabled: true }], false)); check('多个抽屉入口状态不一致抛错', !!m, m || '未抛错'); }
  check('EXTRA_HANDLER 与 openModelDrawer 的函数名在页面源码（html + catalog）里出现', Object.keys(EXTRA_HANDLER).concat(['openModelDrawer']).every(fn => readPageSource().includes(fn)));
  // C4c-2：旧下拉函数（TRIGGER_CALLS）已从页面删除；旧读法的常量（TRIGGER_CALLS / IGNORED_CALLS / PROBE_NAMES / LABEL_TO_ACT）只对 HEAD 有效，新读法用 PROBE_NAMES_DATAACT
  check('旧下拉函数名（TRIGGER_CALLS）不再出现在页面源码里（C4c-2 已删除；旧读法只对 HEAD 有效）', [...TRIGGER_CALLS].every(fn => !readPageSource().includes(fn)));
  check('PROBE_NAMES_DATAACT 的函数名都在页面源码里出现，且不含旧下拉函数', PROBE_NAMES_DATAACT.every(fn => readPageSource().includes(fn)) && PROBE_NAMES_DATAACT.every(fn => !TRIGGER_CALLS.has(fn)));
  // 5e 后端搜索字段硬断言（M1）
  { const ok = "app.get('/api/models', a, (q, r) => {\n if (keyword) {\n sql += \" AND (dm.table_name LIKE ? OR dm.table_comment LIKE ? OR dm.source_table LIKE ? OR dm.source_system LIKE ?)\";\n params.push(1);\n }\n});\napp.get('/x', a, b);";
    check('后端搜索字段：四个字段齐全通过', throws(() => checkBackendSearchFields(ok)) === null);
    const plus = ok.replace('OR dm.source_system LIKE ?)', 'OR dm.source_system LIKE ? OR dm.domain LIKE ?)');
    { const m = throws(() => checkBackendSearchFields(plus)); check('后端搜索字段：多一个字段判红', !!m && /后端搜索字段变了，补关键词/.test(m), m || '未抛错'); }
    const minus = ok.replace(' OR dm.source_system LIKE ?', '');
    { const m = throws(() => checkBackendSearchFields(minus)); check('后端搜索字段：少一个字段判红', !!m && /后端搜索字段变了/.test(m), m || '未抛错'); }
    const swapped = ok.replace('dm.table_comment', 'dm.biz_owner');
    { const m = throws(() => checkBackendSearchFields(swapped)); check('后端搜索字段：换一个字段判红', !!m && /后端搜索字段变了/.test(m), m || '未抛错'); }
    check('后端搜索字段：真实 server.js 通过', throws(() => checkBackendSearchFields(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))) === null);
    // L2 工作目录规则
    check('工作目录规则：E:/tmp 下含前缀通过', workdirProblem('E:/tmp/mc-catalog-x') === null);
    check('工作目录规则：缺前缀拒绝', !!workdirProblem('E:/tmp/other-dir'));
    check('工作目录规则：不在临时目录下拒绝', !!workdirProblem('E:/data/mc-catalog-x') && !!workdirProblem('C:/Windows/mc-catalog-x'));
  }
  // 5c parseCalls：引号内的 word( 不算调用（L3）
  { const names = (t) => parseCalls(t).map(c => c.name).join(',');
    check('parseCalls：双引号内的 word( 不算调用', names('openDDLModal({"table_comment":"foo(bar)","id":6})') === 'openDDLModal');
    check('parseCalls：单引号内的 word( 不算调用', names("openX('evil(1) and more(2)'); y(1)") === 'openX,y');
    check('parseCalls：转义引号不提前结束字符串', names('openX("a\\"b(c)d")') === 'openX');
    check('parseCalls：引号外的嵌套调用仍然识别', names("openEditModal(JSON.parse(this.closest('.x').dataset.model))") === 'openEditModal,JSON.parse,this.closest');
    check('parseCalls：引号内的内容不影响参数串边界', parseCalls('f("a(b", 2)')[0].args === '"a(b", 2');
    { const m = throws(() => classifyElement({ onclick: 'openDDLModal({"table_comment":"x(1)"})', text: 'DDL', disabled: false, notAllowed: false })); check('onclick 内嵌 JSON 里的 word( 不再造成「多个动作函数」假红', m === null, m || ''); }
  }
  // 5d 点击探针结果校验（cellFromProbe / buildRowMatrix / buildRowExtras 的 call / inert 规则）
  { const mk = (args) => cellFromProbe('t', true, [{ fn: 'deleteModel', args }], 5, () => null);
    check('call 区分参数个数：deleteModel(5) 与 deleteModel(5, true) 不同', JSON.stringify(mk([5])) !== JSON.stringify(mk([5, true])));
    const m1 = throws(() => cellFromProbe('t', true, [{ fn: 'deleteModel', args: [6] }], 5, () => null)); check('目标 id 与所在行不符抛错', !!m1 && /目标 id/.test(m1), m1 || '未抛错');
    const m2 = throws(() => cellFromProbe('t', true, [], 5, () => null)); check('可用格 0 次调用抛错', !!m2 && /恰好收到 1 次/.test(m2), m2 || '未抛错');
    const m3 = throws(() => cellFromProbe('t', true, [{ fn: 'deleteModel', args: [5] }, { fn: 'deleteModel', args: [5] }], 5, () => null)); check('可用格 2 次调用抛错', !!m3 && /恰好收到 1 次/.test(m3), m3 || '未抛错');
    const m4 = throws(() => cellFromProbe('t', false, [{ fn: 'deleteModel', args: [5] }], 5, () => null)); check('置灰格收到调用抛错', !!m4 && /置灰格/.test(m4), m4 || '未抛错');
    check('置灰格 0 次调用 → inert', JSON.stringify(cellFromProbe('t', false, [], 5, () => null)) === '{"inert":true}');
    check('触发按钮调用（toggleDimEditMenu）不计入', JSON.stringify(cellFromProbe('t', true, [{ fn: 'toggleDimEditMenu', args: [] }, { fn: 'deleteModel', args: [5] }], 5, () => null)) === '{"call":{"fn":"deleteModel","args":[5]}}');
    const m5 = throws(() => buildRowMatrix([{ onclick: 'openDimDDLModal(5)', text: 'DDL', disabled: false, notAllowed: false, calls: [{ fn: 'openDwdDDLModal', args: [5] }] }], false, 5)); check('同为 ddl 的不同函数：动作一致放行，call.fn 照实记', m5 === null);
    const m6 = throws(() => buildRowMatrix([{ onclick: 'openDimDDLModal(5)', text: 'DDL', disabled: false, notAllowed: false, calls: [{ fn: 'openDimETLModal', args: [5] }] }], false, 5)); check('点击实际调用的函数动作与格子动作不符抛错', !!m6 && /不一致/.test(m6), m6 || '未抛错');
    const row = buildRowMatrix([{ onclick: 'openValidationModal(5,"t","S","DIM","data")', text: 'x', disabled: false, notAllowed: false, calls: [{ fn: 'openValidationModal', args: [5, 't', 'S', 'DIM', 'data'] }] }], false, 5);
    check('validate-data 格带 call，参数个数 5', row['validate-data'].call.fn === 'openValidationModal' && row['validate-data'].call.args.length === 5);
    const m7 = throws(() => buildRowMatrix([{ onclick: 'openValidationModal(5,"t","S","DIM","data")', text: 'x', disabled: false, notAllowed: false, calls: [{ fn: 'openValidationModal', args: [5, 't', 'S', 'DIM', 'structure'] }] }], false, 5)); check('验收阶段点错（data 格实际调 structure）抛错', !!m7 && /不一致/.test(m7), m7 || '未抛错');
    const m8 = throws(() => buildRowExtras([{ drawer: true, calls: [{ fn: 'openModelDrawer', args: [9, '$element'] }] }], false, 5)); check('抽屉入口目标 id 不符抛错', !!m8 && /目标 id/.test(m8), m8 || '未抛错');
    const m9 = throws(() => buildRowExtras([{ onclick: 'viewIterationHistory(5)', calls: [{ fn: 'viewModelChangeLogs', args: [5] }] }], false, 5)); check('迭代徽章接成变更历史抛错', !!m9 && /应调用 viewIterationHistory/.test(m9), m9 || '未抛错');
    const mA = throws(() => cellFromProbe('t', true, [{ fn: 'deleteModel', args: ['$bad'], bad: 'x' }], 5, () => null)); check('无法归一化的参数抛错', !!mA && /无法归一化/.test(mA), mA || '未抛错'); }
  // 6 对应表无陈旧项：每个函数名都在 Model_Center.html 里出现；每个值都在词表里
  { const html = readPageSource(); for (const fn of Object.keys(HANDLER_TO_ACT)) check(`HANDLER_TO_ACT.${fn} 在页面源码（html + catalog）里出现`, html.includes(fn)); }
  check('对应表所有取值 ∈ 词表', Object.values(HANDLER_TO_ACT).concat(Object.values(VALIDATE_PHASE_TO_ACT), Object.values(WORKBENCH_MODE_TO_ACT), Object.values(LABEL_TO_ACT)).every(a => ACTS.includes(a)));
  // 7 data-act 读法与 handler 读法同一词表结构（浏览器内读合成 DOM）
  {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<table><tr data-id="7"><td><button data-act="ddl" title="t1">DDL</button><button data-act="etl" disabled title="ODS 同步由 FDL 工具管理">ETL</button><div data-act="validate-structure">x</div></td></tr></table>');
      const m = await readMatrixFromDataAct(page, [7]);
      const keys = Object.keys(m[7]);
      check('data-act 读法：词表全量键序一致', JSON.stringify(keys) === JSON.stringify(ACTS));
      check('data-act 读法：present / enabled / reason', m[7].ddl.present && m[7].ddl.enabled && m[7].ddl.reason === 't1' && m[7].etl.present && !m[7].etl.enabled && m[7].etl.reason === 'ODS 同步由 FDL 工具管理' && m[7]['validate-structure'].present && !m[7].history.present);
      const same = buildRowMatrix([{ onclick: 'openDimDDLModal(7)', text: 'DDL', disabled: false, notAllowed: false, title: 't1' }, { onclick: '', text: 'ETL', disabled: true, notAllowed: true, title: 'ODS 同步由 FDL 工具管理' }, { onclick: 'openValidationModal(7,"t","S","DIM","structure")', text: 'x' }], false);
      check('两种读法对同一组元素得到逐字段相同的矩阵', deepEqual(same, m[7]));
      await page.setContent('<table><tr data-id="7"><td><button data-act="bogus">x</button></td></tr></table>');
      let err = null; try { await readMatrixFromDataAct(page, [7]); } catch (e) { err = e; }
      await page.setContent('<table><tr data-id="7"><td><button data-entry="open-drawer" data-handler="open-drawer">a</button><button data-entry="iteration-badge" data-handler="iteration-history" disabled>b</button></td></tr></table>');
      const ex = await readExtrasFromDataEntry(page, [7]);
      check('data-entry 读法：与 handler 读法同一结构', deepEqual(ex[7], buildRowExtras([{ drawer: true }, { onclick: 'viewIterationHistory(7)', disabled: true }], false)));
      await page.setContent('<table><tr data-id="7"><td><button data-entry="bogus">x</button></td></tr></table>');
      let err3 = null; try { await readExtrasFromDataEntry(page, [7]); } catch (e) { err3 = e; }
      check('data-entry 读法：入口表外值抛错', !!err3 && /入口表里/.test(err3.message));
      check('data-act 读法：词表外值抛错', !!err && /不在词表/.test(err.message));
      let err2 = null; try { await readMatrixFromDataAct(page, [8]); } catch (e) { err2 = e; }
      check('data-act 读法：缺行抛错', !!err2 && /找不到模型/.test(err2.message));
      // 8 点击探针（H1）：在合成页面上跑真实的 DESCRIBE_AND_PROBE_FN
      {
        const names = ['deleteModel', 'viewModelChangeLogs', 'openModelDrawer', 'toggleDimEditMenu'];
        const norm = await page.evaluate(({ normSrc }) => {
          const f = new Function('return ' + normSrc)();
          const t = (v) => { try { return f(v); } catch (e) { return 'THROW:' + e.message; } };
          const el = document.createElement('div');
          return { model: t({ id: 7, table_name: 'x' }), modelStr: t('{"id":8,"a":1}'), plainStr: t('structure'), jsonNoId: t('{"a":1}'), el: t(el), ev: t(new MouseEvent('click')), und: t(undefined), nul: t(null), num: t(5), bool: t(true), arr: t([1]), objNoId: t({ a: 1 }), fn: t(() => 1), notJson: t('{oops') };
        }, { normSrc: normArg.toString() });
        check('normArg：模型对象 → {$model}', JSON.stringify(norm.model) === '{"$model":7}');
        check('normArg：模型 JSON 串 → {$model}', JSON.stringify(norm.modelStr) === '{"$model":8}');
        check('normArg：普通字符串原样；无 id 的 JSON 串 / 非法 JSON 串也原样', norm.plainStr === 'structure' && norm.jsonNoId === '{"a":1}' && norm.notJson === '{oops');
        check('normArg：DOM 元素 → $element；Event → $event', norm.el === '$element' && norm.ev === '$event');
        check('normArg：undefined → $undefined；null / 数字 / 布尔原样', norm.und === '$undefined' && norm.nul === null && norm.num === 5 && norm.bool === true);
        check('normArg：数组 / 无 id 对象 / 函数抛错', /THROW/.test(norm.arr) && /THROW/.test(norm.objNoId) && /THROW/.test(norm.fn));
        await page.setContent(`<script>
          window.__realCalls = 0;
          function deleteModel(id, force) { window.__realCalls++; }
          function viewModelChangeLogs(id) { window.__realCalls++; }
          function openModelDrawer(id, el) { window.__realCalls++; }
          function toggleDimEditMenu(ev, el) { window.__realCalls++; }
          const cachedDelete = deleteModel;
        </script>
        <table id="modelListBody"><tr data-id="7"><td class="model-row-actions">
          <button onclick="deleteModel(7)">删除</button>
          <button onclick="deleteModel(7, true)">删除</button>
          <button disabled style="cursor:not-allowed" title="无权限">历史</button>
          <button id="cached">删除</button>
          <button onclick="deleteModel(7, 'x'; oops">删除</button>
        </td><td><button class="model-open-btn" data-model-id="7" onclick="openModelDrawer(7, this)">x</button></td></tr></table>
        <script>document.getElementById('cached').addEventListener('click', () => cachedDelete(7));</script>`);
        const probeArg = { names, normSrc: normArg.toString(), triggers: ['toggleDimEditMenu'] };
        const r = await page.evaluate(DESCRIBE_AND_PROBE_FN, probeArg);
        const els = r.rows['7'];
        check('探针：可用按钮收到 1 次调用（函数名 + 参数）', els[0].calls.length === 1 && els[0].calls[0].fn === 'deleteModel' && JSON.stringify(els[0].calls[0].args) === '[7]');
        check('探针：第二个参数照实记（个数不同）', JSON.stringify(els[1].calls[0].args) === '[7,true]');
        check('探针：disabled 按钮不派发 click（0 次调用）', els[2].disabled && els[2].calls.length === 0);
        check('探针：缓存了函数引用的元素替身拦不到（0 次调用）', els[3].calls.length === 0);
        check('探针：onclick 无法编译的元素标 syntaxError 且不去点（0 调用、没有 pageerror）', els[4].syntaxError === true && els[4].calls.length === 0 && els[0].syntaxError === false);
        { const m = throws(() => buildRowMatrix([{ ...els[4], text: '删除' }], false, 7)); check('无法编译且未登记 KNOWN_DEAD_CLICKS 抛错', !!m && /未在 KNOWN_DEAD_CLICKS 登记/.test(m), m || '未抛错'); }
        { KNOWN_DEAD_CLICKS['7:delete'] = { id: 'self-test' }; try { const row = buildRowMatrix([{ ...els[4], text: '删除' }], false, 7); check('已登记的无法编译格记 dead（不是 call / inert）', JSON.stringify(row.delete) === '{"present":true,"enabled":true,"reason":"","dead":"self-test"}', JSON.stringify(row.delete));
            const m2 = throws(() => buildRowMatrix([{ ...els[0] }], false, 7)); check('KNOWN_DEAD_CLICKS 登记陈旧（现在能编译）抛错', !!m2 && /登记已陈旧/.test(m2), m2 || '未抛错'); } finally { delete KNOWN_DEAD_CLICKS['7:delete']; } }
        check('探针：行内入口 .model-open-btn 记下 openModelDrawer(id, $element)', JSON.stringify(r.extras['7'][0].calls) === '[{"fn":"openModelDrawer","args":[7,"$element"]}]');
        check('探针：原函数只被缓存引用的那一次调用到（其余都被替身拦下），且探针结束后已恢复', await page.evaluate(() => window.__realCalls === 1 && typeof deleteModel === 'function' && deleteModel.toString().includes('__realCalls')));
        { const m = throws(() => buildRowMatrix(els.slice(3, 4).map(d => ({ ...d, onclick: '', text: '删除' })), false, 7)); check('探针结果喂 buildRowMatrix：缓存引用的可用格 0 调用 → 抛错', !!m && /恰好收到 1 次/.test(m), m || '未抛错'); }
        { const m = throws(() => buildRowMatrix(els.slice(0, 1).map(d => ({ ...d, notAllowed: false })), false, 7)); check('探针结果喂 buildRowMatrix：正常可用格不抛错', m === null, m || ''); }
        let missErr = null; try { await page.evaluate(DESCRIBE_AND_PROBE_FN, { names: [...names, 'noSuchGlobalFn'], normSrc: normArg.toString(), triggers: ['toggleDimEditMenu'] }); } catch (e) { missErr = e; }
        check('探针：页面缺全局函数抛错', !!missErr && /没有全局函数 noSuchGlobalFn/.test(missErr.message));
        check('探针：缺函数时没有留下半拉子替身（未点任何元素，真实调用计数不变）', await page.evaluate(() => window.__realCalls === 1 && deleteModel.toString().includes('__realCalls')));
        check('PROBE_NAMES 覆盖对应表全部键 + 行内入口函数 + 抽屉 + 触发按钮函数', Object.keys(HANDLER_TO_ACT).concat(Object.keys(EXTRA_HANDLER), ['openModelDrawer'], [...TRIGGER_CALLS]).every(f => PROBE_NAMES.includes(f)));
      }
    } finally { await browser.close(); }
  }
  console.log(`[self-test-mapping] ${n - bad}/${n} 通过（对应表 ${Object.keys(HANDLER_TO_ACT).length} 个函数名 + ${Object.keys(LABEL_TO_ACT).length} 个文字）`);
  return bad ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// [C4c-1 自证段 S] --self-test-dataact：合成页面 + 变异 + 对照组（不起服务，起一次浏览器；页面由 route 提供，INIT_SCRIPT 照常注入以便使用真实 settle）。
//   S.1 夹具与期望（手写行数据 + 手写期望，不调用任何读法）  S.2 HEAD 形态渲染（行内 onclick + 旧下拉，对应现行页面）
//   S.3 data-act 形态渲染（契约 §B.3 的 DOM）  S.4 页面脚本（分页 / 排序 / 菜单 / 委托分发，变异开关 MUT）  S.5 用例
//   同一份行数据渲染两套 DOM：旧读法读 HEAD 形态、新读法读 data-act 形态，逐字段比较；期望格另由手写描述推出（不来自任何读法）。
//   合成页面里的分发脚本按契约 §B.3 第 8 条经全局名在调用时取函数；HEAD 形态里 design_notes 不含 HTML 特殊字符（HEAD 的 onclick 属性会二次解码实体，
//   这是 C4c-2 登记的「设计说明气泡改为转义」已知行为变更，不在读法等价性的范围内）。不与 --reading=legacy 同用。
// ---------------------------------------------------------------------------------------------
/** 设计说明注入样本（37T M2）：含 <、&、'、&#39;、<img onerror>；期望文本是手写的转义结果（只转义 & < >，与页面 DOM 版 escapeHtml 同口径），不调用任何转义函数 */
const SYNTH_INJ = "<img src=x onerror=alert(1)> & ' &#39; <b>";
const SYNTH_INJ_EXPECT = "&lt;img src=x onerror=alert(1)&gt; &amp; ' &amp;#39; &lt;b&gt;";
const SYNTH_ROWS = [
  { id: 11, layer: 'ods', table_name: 'ods_a_df', table_comment: '甲源表', status: 'ONLINE', companion_of: null, design_notes: '设计说明A', iter: 1, canEdit: true, canValidate: true, tech_owner: '丁', updated_at: '2026-01-05', domain: 'd2', acceptance_at: null },
  { id: 12, layer: 'ods', table_name: 'ods_b_df', table_comment: '乙源表', status: 'CREATED', companion_of: null, design_notes: null, iter: 0, canEdit: false, canValidate: false, tech_owner: '甲', updated_at: '2026-01-02', domain: 'd1', acceptance_at: '2026-01-03' },
  { id: 13, layer: 'dim', table_name: 'dim_a', table_comment: '甲维度', status: 'CREATED', companion_of: null, design_notes: null, iter: 2, canEdit: true, canValidate: true, tech_owner: '丙', updated_at: '2026-01-09', domain: 'd1', acceptance_at: '2026-01-08' },
  { id: 14, layer: 'dwd', table_name: 'dwd_a_df', table_comment: '甲明细', status: 'ONLINE', companion_of: null, design_notes: '含"引号"', iter: 0, canEdit: true, canValidate: true, tech_owner: '乙', updated_at: '2026-01-04', domain: 'd3', acceptance_at: null },
  { id: 15, layer: 'dwd', table_name: 'dwd_a_change_di', table_comment: '甲明细变更', status: 'ONLINE', companion_of: 14, design_notes: null, iter: 0, canEdit: true, canValidate: true, tech_owner: '乙', updated_at: '2026-01-04', domain: 'd3', acceptance_at: null },
  { id: 16, layer: 'dim', table_name: 'dim_b', table_comment: '乙维度', status: 'CREATED', companion_of: null, design_notes: null, iter: 0, canEdit: false, canValidate: false, tech_owner: '甲', updated_at: '2026-01-01', domain: 'd2', acceptance_at: null },
  { id: 17, layer: 'ODS', table_name: 'ods_c_df', table_comment: '丙源表', status: 'ONLINE', companion_of: null, design_notes: null, iter: 0, canEdit: true, canValidate: true, tech_owner: '丙', updated_at: '2026-01-06', domain: 'd1', acceptance_at: '2026-01-07' },
  { id: 18, layer: 'DWD', table_name: 'dwd_b_df', table_comment: '乙明细', status: 'ONLINE', companion_of: null, design_notes: null, iter: 1, canEdit: true, canValidate: true, tech_owner: '丁', updated_at: '2026-01-07', domain: 'd3', acceptance_at: null },
  { id: 19, layer: 'DWD', table_name: 'dwd_b_change_di', table_comment: '乙明细变更', status: 'ONLINE', companion_of: 18, design_notes: null, iter: 0, canEdit: true, canValidate: true, tech_owner: '丁', updated_at: '2026-01-07', domain: 'd3', acceptance_at: null },
  { id: 20, layer: 'DIM', table_name: 'dim_c', table_comment: '丙维度', status: 'CREATED', companion_of: null, design_notes: null, iter: 0, canEdit: true, canValidate: true, tech_owner: '乙', updated_at: '2026-01-08', domain: 'd2', acceptance_at: null },
  { id: 21, layer: 'dwd', table_name: 'dwd_c_df', table_comment: '丙明细', status: 'CREATED', companion_of: null, design_notes: null, iter: 0, canEdit: true, canValidate: false, tech_owner: '甲', updated_at: '2026-01-03', domain: 'd1', acceptance_at: null },
  { id: 22, layer: 'dim', table_name: 'dim_d', table_comment: '丁维度', status: 'CREATED', companion_of: null, design_notes: '说明X', iter: 1, canEdit: false, canValidate: true, tech_owner: '丙', updated_at: '2026-01-10', domain: 'd3', acceptance_at: null },
  // dataActOnly = 只出现在 data-act 形态（HEAD 的 onclick 属性会二次解码实体 / 行 24 的置灰不是 HEAD 规则）
  { id: 23, layer: 'ods', table_name: 'ods_inj_df', table_comment: '注入样本', status: 'ONLINE', companion_of: null, design_notes: SYNTH_INJ, notesExpected: SYNTH_INJ_EXPECT, dataActOnly: true, iter: 0, canEdit: true, canValidate: true, tech_owner: '丁', updated_at: '2026-01-11', domain: 'd1', acceptance_at: null },
  { id: 24, layer: 'dim', table_name: 'dim_off', table_comment: '全置灰', status: 'CREATED', companion_of: null, design_notes: null, allOff: true, dataActOnly: true, iter: 0, canEdit: true, canValidate: true, tech_owner: '乙', updated_at: '2026-01-12', domain: 'd2', acceptance_at: null },
  // 填充行（37T M3）：id 101 对应真实库的填充 ODS #101，走完整建格校验（extraIds）
  { id: 101, layer: 'ods', table_name: 'ods_filler_01_df', table_comment: '填充', status: 'ONLINE', companion_of: null, design_notes: null, iter: 0, canEdit: true, canValidate: true, tech_owner: '甲', updated_at: '2026-01-02', domain: 'd1', acceptance_at: null },
];
function initSynthRows() { SYNTH_ROWS.forEach((m, i) => { m.stages = { structure: { ok: i % 2 === 0, rules: [i, i + 1] }, data: i % 3 === 0 ? null : { rows: i * 10 } }; m.deep = { l1: { l2: { l3: { l4: { l5: { l6: { l7: { l8: { v: i } } } } } } } } }; }); }   // 嵌套字段：浅拷贝可被识别；[#106 S4b2] 原为顶层语句，改成函数由 initDerived() 调用
/** 一行的操作规格（手写规则，与 HEAD 渲染一致：置灰原因 / 调用的函数 / 参数个数）。args 里 {$row:true} = 行副本（归一化后 {$model:id}） */
function synthSpec(m) {
  const L = m.layer.toUpperCase(), comp = !!m.companion_of, ROW = { $row: true };
  const it = (act, enabled, title, fn, args) => ({ act, enabled, title: title || '', fn: fn || null, args: args || [] });
  const vcall = (act, phase) => it(act, true, '', 'openValidationModal', phase ? [m.id, m.table_name, m.status, L, phase] : [m.id, m.table_name, m.status, L]);
  const s = {};
  if (comp) { s.validate = [it('validate', false, '伴生表无需独立验收')]; s.vkind = 'disabled'; }
  else if (m.canValidate) {
    if (L === 'ODS') { s.validate = [vcall('validate')]; s.vkind = 'direct'; }
    else if (L === 'DIM') { s.validate = [vcall('validate-structure', 'structure'), vcall('validate-data', 'data'), vcall('validate-semantic', 'semantic')]; s.vkind = 'menu'; }
    else { s.validate = [vcall('validate-structure', 'structure'), vcall('validate-data', 'data')]; s.vkind = 'menu'; }
  } else { s.validate = [it('validate', false, '无验收权限')]; s.vkind = 'disabled'; }
  s.etl = comp ? it('etl', false, '伴生表写入逻辑在主表增量 ETL 的 Step 3 中') : L === 'ODS' ? it('etl', false, 'ODS 同步由 FDL 工具管理') : L === 'DIM' ? it('etl', true, '', 'openDimETLModal', [m.id]) : it('etl', true, '', 'openDwdScriptModal', [m.id]);
  s.ddl = comp ? it('ddl', false, '请在主表 DDL 弹窗中切换「伴生表 DDL」标签页查看') : L === 'ODS' ? it('ddl', true, '', 'openDDLModal', [ROW]) : L === 'DIM' ? it('ddl', true, '', 'openDimDDLModal', [m.id]) : it('ddl', true, '', 'openDwdDDLModal', [m.id]);
  if (comp) { s.edit = [it('view-config', true, '伴生表配置由主表自动管理（只读）', 'openDwdConfigViewModal', [m.id])]; s.ekind = 'btn'; }
  else if ((L === 'DIM' || L === 'DWD') && m.canEdit) { s.edit = [it('edit-config', true, '', 'openWorkbench', [m.id, 'edit']), it('edit-info', true, '', 'openEditModal', [ROW])]; s.ekind = 'menu'; }
  else if (L === 'DIM' || L === 'DWD') { s.edit = [it('view-config', true, L === 'DIM' ? '查看 DIM 配置（只读）' : '查看 DWD 配置（只读）', L === 'DIM' ? 'openDimConfigViewModal' : 'openDwdConfigViewModal', [m.id])]; s.ekind = 'btn'; }
  else if (m.canEdit) { s.edit = [it('edit-info', true, '', 'openEditModal', [ROW])]; s.ekind = 'btn'; }
  else { s.edit = [it('edit-info', false, '无编辑权限')]; s.ekind = 'btn'; }
  s.history = it('history', true, '查看变更历史', 'viewModelChangeLogs', [m.id]);
  s.del = m.canEdit ? it('delete', true, '', 'deleteModel', [m.id]) : it('delete', false, '无删除权限');
  if (m.allOff) { s.etl = it('etl', false, '暂不支持'); s.ddl = it('ddl', false, '暂不支持'); s.edit = s.edit.map(e => it(e.act, false, '暂不支持')); s.history = it('history', false, '暂不支持'); s.del = it('delete', false, '暂不支持'); }   // ⋯ 菜单项全部置灰（Esc 全置灰路径）
  return s;
}
const synthNormArgs = (m, args) => args.map(a => (a && a.$row ? { $model: m.id } : a));
function synthExpectedMatrix(m, viewer) {
  const row = {};
  for (const a of ACTS) row[a] = { present: false, enabled: false, reason: '' };
  if (!viewer) { const s = synthSpec(m); for (const it of [...s.validate, s.etl, s.ddl, ...s.edit, s.history, s.del]) row[it.act] = it.enabled ? { present: true, enabled: true, reason: it.title, call: { fn: it.fn, args: synthNormArgs(m, it.args) } } : { present: true, enabled: false, reason: it.title, inert: true }; }
  return row;
}
function synthExpectedExtras(m) {
  const row = {};
  for (const e of EXTRA_ENTRIES) row[e] = { present: false, handler: '', enabled: false };
  row['open-drawer'] = { present: true, handler: 'open-drawer', enabled: true, call: { fn: 'openModelDrawer', args: [m.id, '$element'] } };
  if (m.design_notes) row['design-notes'] = { present: true, handler: 'design-notes', enabled: true, call: { fn: 'showDesignNotesPopover', args: ['$element', m.notesExpected !== undefined ? m.notesExpected : m.design_notes] } };
  if (m.iter > 0) row['iteration-badge'] = { present: true, handler: 'iteration-history', enabled: true, call: { fn: 'viewIterationHistory', args: [m.id] } };
  return row;
}
const synthEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const synthEscapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');   // 与页面里生效的 DOM 版 escapeHtml 同口径：不转义引号
const SYNTH_LABEL = { validate: '验收', 'validate-structure': '结构验收', 'validate-data': '数据验收', 'validate-semantic': '语义验收', etl: 'ETL', ddl: 'DDL', 'edit-config': '编辑配置', 'view-config': '配置', 'edit-info': '编辑信息', history: '历史', delete: '删除' };
/** S.2 HEAD 形态：<tr data-id> + 行内 onclick + .dim-edit-dropdown / .dim-validate-dropdown（与现行 model-catalog.js 同结构） */
function synthHeadRow(m, viewer) {
  const s = synthSpec(m);
  const oc = (it) => synthEsc(it.fn + '(' + it.args.map(a => (a && a.$row ? JSON.stringify(m) : JSON.stringify(a))).join(', ') + ')');
  const btn = (it, label) => (it.enabled
    ? '<button type="button" class="btn-secondary" style="padding:4px 8px;" onclick="' + oc(it) + '"' + (it.title ? ' title="' + synthEsc(it.title) + '"' : '') + '>' + label + '</button>'
    : '<button type="button" class="btn-secondary" style="padding:4px 8px; cursor:not-allowed;" disabled title="' + synthEsc(it.title) + '">' + label + '</button>');
  const v = s.vkind === 'menu'
    ? '<div class="dim-validate-dropdown" style="position:relative; display:inline-block;"><button type="button" class="btn-secondary" style="padding:4px 8px;" onclick="event.stopPropagation(); toggleDimValidateDropdown(this)">验收 ▾</button><div class="dim-validate-menu" style="display:none; position:absolute; top:100%; right:0; background:white; border:1px solid #ccc; z-index:100; min-width:120px;">' + s.validate.map(it => '<div style="padding:8px 12px; cursor:pointer;" onclick="event.stopPropagation(); closeDimValidateDropdowns(); ' + oc(it) + '">' + SYNTH_LABEL[it.act] + '</div>').join('') + '</div></div>'
    : btn(s.validate[0], '验收');
  const edit = s.ekind === 'menu'
    ? '<div class="dim-edit-dropdown" style="position:relative; display:inline-block;" data-model="' + synthEsc(JSON.stringify(m)) + '"><button type="button" class="btn-secondary" style="padding:4px 8px;" onclick="toggleDimEditMenu(event, this)">编辑 ▾</button><div class="dim-edit-menu" style="display:none; position:absolute; top:100%; left:0; background:white; border:1px solid #ccc; z-index:100; min-width:120px;"><div style="padding:8px 12px;" onclick="event.stopPropagation(); closeDimEditMenus(); openWorkbench(' + m.id + ', \'edit\')">编辑配置</div><div style="padding:8px 12px;" onclick="event.stopPropagation(); closeDimEditMenus(); openEditModal(JSON.parse(this.closest(\'.dim-edit-dropdown\').dataset.model))">编辑信息</div></div></div>'
    : btn(s.edit[0], s.edit[0].act === 'view-config' ? '配置' : '编辑');
  const notes = m.design_notes ? '<button type="button" title="查看设计说明" onclick="event.stopPropagation(); showDesignNotesPopover(this, ' + JSON.stringify(synthEscapeHtml(m.design_notes)).replace(/"/g, '&quot;') + ')">i</button>' : '';
  const iter = m.iter > 0 ? '<button type="button" title="点击查看迭代历史" onclick="viewIterationHistory(' + m.id + ')">v' + m.iter + '</button>' : '<span>-</span>';
  return '<tr data-id="' + m.id + '"><td>#' + m.id + '</td><td>' + m.layer.toUpperCase() + '</td><td><button type="button" class="model-open-btn" data-model-id="' + m.id + '">' + m.table_name + '</button></td><td><span><button type="button" class="model-open-btn" data-model-id="' + m.id + '">' + m.table_comment + '</button>' + notes + '</span></td><td>' + iter + '</td>'
    + (viewer ? '' : '<td class="model-row-actions"><div style="display:flex; gap:4px; align-items:center;">' + [v, btn(s.etl, 'ETL'), btn(s.ddl, 'DDL'), edit, btn(s.history, '历史'), btn(s.del, '删除')].join('') + '</div></td>') + '</tr>';
}
/** S.3 data-act 形态（契约 §B.3）。cfg.mut = 变异码；cfg.ariaOnly = 置灰只用 aria-disabled；cfg.ctlExtra = 加入不带 data-act 的其它控件；bodyMenus 收集挂到 body 的菜单（变异 l2） */
function synthEntry(m, cfg, bodyMenus) {
  const mut = cfg.mut || '', viewer = !!cfg.viewer, s = synthSpec(m);
  const ariaOnly = cfg.ariaOnly || mut === 'c' || mut === 'dis';
  const dis = (it) => (it.enabled ? '' : (ariaOnly ? ' aria-disabled="true"' : ' disabled aria-disabled="true"'));
  const lab = (it) => (cfg.labels === 'alt' ? ({ history: '删除', delete: '历史' }[it.act] || '  ' + SYNTH_LABEL[it.act] + ' ') : SYNTH_LABEL[it.act]);
  const reason = (it, menuItem) => (menuItem && !it.enabled && mut !== 'reasonMissing' && mut !== 'emptyTitle' ? '<span class="model-menu-reason">' + synthEsc(it.title) + (mut === 'reasonMismatch' ? '（错）' : '') + '</span>' : '');
  const act = (it, menuItem) => (menuItem && mut === 'menuItemDiv' ? '<div' : '<button type="button"') + (menuItem ? ' role="menuitem"' : '') + ' data-act="' + it.act + '"' + dis(it) + (it.title && !(mut === 'emptyTitle' && !it.enabled) ? ' title="' + synthEsc(it.title) + '"' : '') + (mut === 'editDataset' && it.act === 'edit-info' ? ' data-model="' + synthEsc(JSON.stringify(m)) + '"' : '') + '><span>' + lab(it) + '</span>' + reason(it, menuItem) + (menuItem && mut === 'menuItemDiv' ? '</div>' : '</button>');
  const menu = (kind, items, text) => {
    const mid = 'menu-' + kind + '-' + m.id;
    const trig = '<button type="button" data-menu="' + kind + '"' + (mut === 'trigNoPopup' ? '' : ' aria-haspopup="menu"') + ' aria-expanded="false"' + (mut === 'trigNoControls' ? '' : ' aria-controls="' + mid + '"') + '><span>' + text + '</span></button>';
    const body = '<div role="menu" id="' + mid + '" class="menu"' + (mut === 'w' ? ' style="display:none"' : ' hidden') + '>' + items.map(i => act(i, true)).join('') + '</div>';
    if (mut === 'l2') { bodyMenus.push(body); return '<span class="mw">' + trig + '</span>'; }
    return '<span class="mw">' + trig + body + '</span>';
  };
  let acts = '';
  if (!viewer || mut === 'x') {
    let moreItems = [s.etl, s.ddl, ...s.edit, s.history, s.del];
    if (mut === 'valInMore' && s.vkind === 'direct') { moreItems = [s.validate[0], ...moreItems]; }   // M1：ODS 验收放进 ⋯ 菜单
    else if (mut === 'valMenuInMore' && s.vkind === 'menu') { moreItems = [...s.validate, ...moreItems]; }   // M1：DIM / DWD 的验收阶段项放进 ⋯ 菜单
    else acts += s.vkind === 'menu' ? menu('validate', s.validate, '验收 ▾') : act(s.validate[0]);
    if (mut === 'actDirect') { moreItems = moreItems.filter(i => i.act !== 'delete'); acts += act(s.del); }   // M1：删除做成菜单外按钮
    if (mut === 'orderRev') moreItems = moreItems.slice().reverse();   // M1：⋯ 菜单顺序颠倒
    if (!(mut === 'r' && m.id === 13)) acts += menu('more', moreItems, '⋯');
  }
  if (mut === 'm' && m.id === 11) acts += '<button type="button" data-act="frobnicate">?</button>';
  const notes = m.design_notes ? (mut === 'notesDiv' ? '<div data-entry="design-notes" title="查看设计说明"><span>i</span></div>' : '<button type="button" data-entry="design-notes" title="查看设计说明"><span>i</span></button>') : '';
  const iter = m.iter > 0 ? '<button type="button" data-entry="iteration-badge" title="点击查看迭代历史"><span>v' + m.iter + '</span></button>' : '';
  const ex = cfg.ctlExtra ? '<button type="button" data-expand-toggle="1">▸</button><button type="button" data-pane-act="retry">重试</button><span data-rail="x"></span><button type="button" data-catalog-act="x">c</button>' : '';
  const nested = mut === 'n' && m.id === 11 ? '<div data-id="9999"></div>' : mut === 'actInPanel' && m.id === 11 ? '<div class="expand-panel"><button type="button" data-act="history"><span>历史</span></button></div>' : mut === 'badEntry' && m.id === 11 ? '<button type="button" data-entry="mystery"><span>?</span></button>' : mut === 'viewerMenu' && m.id === 11 ? '<div role="menu" id="stray-menu"><span>stray</span></div>' : '';
  const open = '<button type="button" class="model-open-btn" data-entry="open-drawer" data-model-id="' + m.id + '">';
  return '<div class="entry' + (m.companion_of && mut !== 'noCompClass' ? ' is-companion' : '') + '" data-id="' + m.id + '">' + open + '<span>' + m.table_name + '</span></button>' + open + '<span>' + m.table_comment + '</span></button>' + notes + iter + ex + nested
    + (acts ? '<div class="model-row-actions">' + acts + '</div>' : '') + '</div>';
}
/** 对照组用：属性顺序倒置 + 标签间加空白换行（不改语义） */
const synthShuffle = (h) => h.replace(/<(button|div|span)((?:\s+[\w-]+(?:="[^"]*")?)+)>/g, (_, t, attrs) => '<' + t + (attrs.match(/\s+[\w-]+(?:="[^"]*")?/g) || []).reverse().join('') + '>').replace(/></g, '>\n   <');
const SYNTH_CSS = '[hidden]{display:none!important} body{font:14px sans-serif;margin:8px;padding-top:72px} #fixedNav{position:fixed;top:0;left:0;right:0;height:64px;z-index:1000;background:#fff;border-bottom:1px solid #999} .tall .entry{min-height:260px} .entry{position:relative;min-height:56px;padding:6px;border-bottom:1px solid #ccc} .model-row-actions{display:inline-flex;gap:4px;align-items:center;margin-left:12px} .mw{position:relative;display:inline-block} .menu{position:absolute;right:0;top:100%;z-index:10;background:#fff;border:1px solid #999;min-width:150px} .menu button{display:block;width:100%;text-align:left;padding:6px} #sortBar button{margin-right:4px}';
/** S.4 页面脚本（经 String.raw 内嵌，内部不得出现反引号 / ${）。MUT = 变异码；honest 实现 = MUT 为空 */
const SYNTH_SCRIPT = () => String.raw`
var CFG = __CFG__;
var MUT = CFG.mut || '';
var allModelsData = CFG.rows;
let currentPage = 1;
var pageSize = CFG.pageSize || 4;
let currentSortBy = null;
let currentSortDir = 'desc';
var STATE = { last: null, renders: 0 };
var LOCAL = { by: null, dir: 'desc' };
function escapeHtml(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
var LABEL2ACT = { '验收': 'validate', '结构验收': 'validate-structure', '数据验收': 'validate-data', '语义验收': 'validate-semantic', 'ETL': 'etl', 'DDL': 'ddl', '编辑配置': 'edit-config', '配置': 'view-config', '编辑信息': 'edit-info', '历史': 'history', '删除': 'delete' };
function openDimETLModal() {} function openDwdScriptModal() {} function openDDLModal() {} function openDimDDLModal() {} function openDwdDDLModal() {}
function openWorkbench() {} function openEditModal() {} function openDimConfigViewModal() {} function openDwdConfigViewModal() {}
function viewModelChangeLogs() {} function deleteModel() {} function openValidationModal() {}
function showDesignNotesPopover(btn, html) { var p = document.getElementById('popover'); if (!p) { p = document.createElement('div'); p.id = 'popover'; document.body.appendChild(p); } p.innerHTML = html; }
function viewIterationHistory() {} function openModelDrawer() {}
function getSortedModels() {} function goToPage() {} function highlightModel() {} function loadModels() {}
function toggleDimEditMenu(event, btn) { event.stopPropagation(); var dd = btn.closest('.dim-edit-dropdown'); var menu = dd.querySelector('.dim-edit-menu'); var vis = menu.style.display !== 'none'; closeDimEditMenus(); if (!vis) { var r = btn.getBoundingClientRect(); menu.style.position = 'fixed'; menu.style.top = (r.bottom + 2) + 'px'; menu.style.left = r.left + 'px'; menu.style.display = 'block'; } }
function closeDimEditMenus() { document.querySelectorAll('.dim-edit-menu').forEach(function (m) { m.style.display = 'none'; }); }
document.addEventListener('click', function (e) { if (e.target.closest('.dim-edit-dropdown')) return; closeDimEditMenus(); });
function toggleDimValidateDropdown(btn) { var menu = btn.nextElementSibling; var vis = menu.style.display !== 'none'; closeDimValidateDropdowns(); if (!vis) { var r = btn.getBoundingClientRect(); menu.style.position = 'fixed'; menu.style.width = 'max-content'; menu.style.top = (r.bottom + 2) + 'px'; menu.style.display = 'block'; menu.style.left = Math.max(0, r.right - menu.offsetWidth) + 'px'; } }
function closeDimValidateDropdowns() { document.querySelectorAll('.dim-validate-menu').forEach(function (m) { m.style.display = 'none'; }); }
document.addEventListener('click', closeDimValidateDropdowns);
var list = document.getElementById('modelListBody');
var cover = null;
if (CFG.bodyMenus) document.body.insertAdjacentHTML('beforeend', CFG.bodyMenus);
if (MUT === 'h') { var st1 = document.createElement('style'); st1.textContent = '.menu button{visibility:hidden}'; document.head.appendChild(st1); }
if (MUT === 'trigHidden') { var st3 = document.createElement('style'); st3.textContent = '[data-menu]{visibility:hidden}'; document.head.appendChild(st3); }
if (MUT === 'ancestorVis') { var st4 = document.createElement('style'); st4.textContent = '.mw{visibility:hidden} .mw *{visibility:visible}'; document.head.appendChild(st4); }
if (MUT === 'ancestorPE') { var st5 = document.createElement('style'); st5.textContent = '.mw{pointer-events:none} .mw *{pointer-events:auto}'; document.head.appendChild(st5); }
if (MUT === 'i') { var st2 = document.createElement('style'); st2.textContent = '.menu button{pointer-events:none}'; document.head.appendChild(st2); }
function orderIds(by, dir) {
  var mains = allModelsData.filter(function (m) { return !m.companion_of; }).slice();
  if (by) mains.sort(function (a, b) { var x = a[by] == null ? '' : a[by], y = b[by] == null ? '' : b[by]; var r = x < y ? -1 : x > y ? 1 : 0; return dir === 'asc' ? r : -r; });
  var out = [];
  mains.forEach(function (m) { out.push(m.id); allModelsData.filter(function (c) { return c.companion_of === m.id; }).forEach(function (c) { out.push(c.id); }); });
  return out;
}
function groupsOf(ids) { var gs = []; ids.forEach(function (id) { var m = allModelsData.filter(function (r) { return r.id === id; })[0]; if (m.companion_of && gs.length) gs[gs.length - 1].push(id); else gs.push([id]); }); return gs; }
function viewOf(ids) { var gs = groupsOf(ids); var total = Math.max(1, Math.ceil(gs.length / pageSize)); var cp = Math.min(Math.max(currentPage, 1), total); return { gs: gs, total: total, cp: cp }; }
function getCatalogView() { var ids = orderIds(currentSortBy, currentSortDir); var v = viewOf(ids); return { totalPages: v.total, orderedIds: ids, pageGroups: v.gs.slice((v.cp - 1) * pageSize, v.cp * pageSize), totalModels: ids.length, totalGroups: v.gs.length }; }
function isOpenMenu(M) { return !M.hasAttribute('hidden') && M.style.display !== 'none'; }
function ctrlOf(M) { return document.querySelector('[aria-controls="' + M.id + '"]'); }
function setMenu(M, open) {
  var T = ctrlOf(M);
  if (open) {
    M.removeAttribute('hidden'); M.style.display = '';
    if (MUT === 'j') M.setAttribute('aria-hidden', 'true');
    if (T && MUT !== 'p') T.setAttribute('aria-expanded', 'true');
    if (MUT === 'k') { if (!cover) { cover = document.createElement('div'); cover.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:50;background:transparent'; document.body.appendChild(cover); } cover.style.display = 'block'; }
  } else {
    if (MUT === 'w') { M.style.display = 'none'; M.removeAttribute('hidden'); } else M.setAttribute('hidden', '');
    M.removeAttribute('aria-hidden');
    if (T) T.setAttribute('aria-expanded', 'false');
    if (cover) cover.style.display = 'none';
  }
}
function closeAllMenus() { document.querySelectorAll('[role=menu]').forEach(function (M) { setMenu(M, false); }); }
function toggleMenu(T) {
  var M = document.getElementById(T.getAttribute('aria-controls'));
  var was = isOpenMenu(M);
  if (MUT === 'l' && !STATE.last) STATE.last = T.closest('[data-id]').dataset.id;
  if (MUT === 'noToggle') { closeAllMenus(); setMenu(M, true); return; }
  var idxT = Array.prototype.indexOf.call(list.querySelectorAll('[data-id]'), T.closest('[data-id]'));
  if (MUT !== 'v' && !(MUT === 'lateMutex' && idxT >= 9)) closeAllMenus(); else if (was) setMenu(M, false);
  if (MUT === 'asyncOpen') { if (!was) setTimeout(function () { setMenu(M, true); }, 0); return; }
  if (!was) setMenu(M, true);
}
function renderModelsPage() {
  var ids = MUT === 'sortSplit' ? orderIds(LOCAL.by, LOCAL.dir) : orderIds(currentSortBy, currentSortDir);
  var v = viewOf(ids);
  currentPage = v.cp;
  var pg = v.gs.slice((v.cp - 1) * pageSize, v.cp * pageSize);
  if (MUT === 'pgMismatch' && v.cp === 2) { var lg = pg[pg.length - 1]; lg.pop(); if (!lg.length) pg.pop(); }
  var html = '';
  pg.forEach(function (g) { var inner = g.map(function (id) { return CFG.html[id]; }).join(''); html += CFG.form === 'head' ? inner : '<div data-group="' + g[0] + '">' + inner + '</div>'; });
  list.innerHTML = html;
  STATE.renders++;
  closeAllMenus();
  if (MUT === 'viewerMenu') { var sm = document.getElementById('stray-menu'); if (sm) { sm.removeAttribute('hidden'); sm.style.display = ''; } }
  if (MUT === 'u') { var T = list.querySelector('[data-menu]'); if (T) setMenu(document.getElementById(T.getAttribute('aria-controls')), true); }
  if (MUT === 'lateRenderKeep' && currentPage >= 3) { var T4 = list.querySelector('[data-menu]'); if (T4) setMenu(document.getElementById(T4.getAttribute('aria-controls')), true); }
  if (MUT === 'uValidate') { var T2 = list.querySelector('[data-menu="validate"]'); if (T2) setMenu(document.getElementById(T2.getAttribute('aria-controls')), true); }
  if (MUT === 'escOnMenu') list.querySelectorAll('[role=menu]').forEach(function (M) { M.addEventListener('keydown', function (ev) { if (ev.key !== 'Escape') return; var T3 = ctrlOf(M); closeAllMenus(); if (T3) T3.focus(); ev.stopPropagation(); }); });
  if (CFG.form === 'dataact' && MUT === 'readyCleared' && STATE.renders > 1) list.removeAttribute('data-catalog-state');
  else if (CFG.form === 'dataact' && MUT === 'stateError') list.setAttribute('data-catalog-state', 'error');
  else if (CFG.form === 'dataact' && MUT !== 'q') list.setAttribute('data-catalog-state', 'ready');
}
var H = null;
if (MUT === 'a') H = { openDimETLModal: openDimETLModal, openDwdScriptModal: openDwdScriptModal, openDDLModal: openDDLModal, openDimDDLModal: openDimDDLModal, openDwdDDLModal: openDwdDDLModal, openWorkbench: openWorkbench, openEditModal: openEditModal, openDimConfigViewModal: openDimConfigViewModal, openDwdConfigViewModal: openDwdConfigViewModal, viewModelChangeLogs: viewModelChangeLogs, deleteModel: deleteModel, openValidationModal: openValidationModal, showDesignNotesPopover: showDesignNotesPopover, viewIterationHistory: viewIterationHistory };
function call(name) { var args = Array.prototype.slice.call(arguments, 1); var f = H ? H[name] : window[name]; return f.apply(window, args); }
function rowOfEl(el) {
  var en = el.closest('[data-id]'); var id = en ? en.dataset.id : null;
  if (MUT === 'l' && el.closest('[role=menu]') && STATE.last) id = STATE.last;
  return allModelsData.filter(function (m) { return String(m.id) === String(id); })[0];
}
function copyRow(m) {
  if (MUT === 'partialRow') return { id: m.id };
  if (MUT === 'shallowRow') return Object.assign({}, m);
  if (MUT === 'deepShared') { var cd = JSON.parse(JSON.stringify(m)); cd.deep.l1.l2.l3.l4.l5.l6.l7 = m.deep.l1.l2.l3.l4.l5.l6.l7; return cd; }
  if (MUT === 'tamperedRow') { var c = JSON.parse(JSON.stringify(m)); c.table_comment = c.table_comment + '!'; return c; }
  return JSON.parse(JSON.stringify(m));
}
function dispatchAct(el, ev) {
  var act = MUT === 'textDispatch' ? LABEL2ACT[el.firstElementChild.textContent.replace(/\s+/g, ' ').trim()] : el.dataset.act, m = rowOfEl(el), id = m.id;
  if (MUT === 'fillerWrongId' && m.id === 101) id = 100;
  var lo = MUT === 's';
  var L = lo ? String(m.layer) : String(m.layer).toUpperCase();
  var isODS = L === (lo ? 'ods' : 'ODS'), isDIM = L === (lo ? 'dim' : 'DIM');
  switch (act) {
    case 'ddl': if (isODS) call('openDDLModal', MUT === 'ddlStr' ? JSON.stringify(m) : copyRow(m)); else if (isDIM) call('openDimDDLModal', id); else call('openDwdDDLModal', id); break;
    case 'etl': if (isDIM) call('openDimETLModal', id); else call('openDwdScriptModal', id); break;
    case 'edit-config': call('openWorkbench', id, 'edit'); break;
    case 'view-config': if (m.companion_of) call('openDwdConfigViewModal', id); else if (isDIM) call('openDimConfigViewModal', id); else call('openDwdConfigViewModal', id); break;
    case 'edit-info': call('openEditModal', MUT === 'editDataset' ? el.dataset.model : MUT === 'liveRow' ? m : copyRow(m)); break;
    case 'history': if (MUT !== 'o') call('viewModelChangeLogs', id); break;
    case 'delete': if (MUT === 'b') call('deleteModel', id, ev); else call('deleteModel', id); break;
    case 'validate-structure': case 'validate-data': case 'validate-semantic': call('openValidationModal', id, m.table_name, m.status, isDIM ? 'DIM' : 'DWD', act.slice(9)); break;
    case 'validate': call('openValidationModal', id, m.table_name, m.status, 'ODS'); break;
  }
}
function dispatchEntry(el) {
  var m = rowOfEl(el);
  if (el.dataset.entry === 'design-notes') call('showDesignNotesPopover', MUT === 'notesEl' ? el.closest('[data-id]') : el, MUT === 'noEscape' ? m.design_notes : escapeHtml(m.design_notes));
  else if (el.dataset.entry === 'iteration-badge') call('viewIterationHistory', m.id);
}
list.addEventListener('click', function (ev) {
  var t = ev.target;
  var ob = t.closest('.model-open-btn');
  if (ob) { openModelDrawer(Number(ob.dataset.modelId), ob); return; }
  var tg = MUT === 'targetNoClosest' ? (t.dataset && t.dataset.menu ? t : null) : t.closest('[data-menu]');
  if (tg) { toggleMenu(tg); return; }
  var ae = MUT === 'targetNoClosest' ? (t.dataset && t.dataset.act ? t : null) : t.closest('[data-act]');
  if (ae) {
    if (ae.disabled) return;
    if (MUT !== 'c' && ae.getAttribute('aria-disabled') === 'true') { if (MUT === 'dis') closeAllMenus(); return; }
    dispatchAct(ae, ev);
    if (MUT !== 'd' && ae.closest('[role=menu]')) closeAllMenus();
    return;
  }
  var ee = t.closest('[data-entry]');
  if (ee) dispatchEntry(ee);
});
if (MUT !== 'e') document.addEventListener('click', function (ev) {
  if (MUT === 'outsideBodyOnly' && ev.target !== document.body) return;
  if (MUT === 'outsideIgnoresList' && ev.target.closest('#modelListBody')) return;
  if (!ev.target.closest('[role=menu], [data-menu]')) closeAllMenus();
});
if (MUT !== 'f' && MUT !== 'escOnMenu') document.addEventListener('keydown', function (ev) {
  if (ev.key !== 'Escape') return;
  if (MUT === 'escItemOnly' && ev.target.getAttribute && ev.target.getAttribute('role') === 'menu') return;
  var open = Array.prototype.filter.call(document.querySelectorAll('[role=menu]'), isOpenMenu);
  if (!open.length) return;
  var T = ctrlOf(open[0]);
  closeAllMenus();
  if (MUT === 'escFocusAsync') Promise.resolve().then(function () { if (T) T.focus(); }); else if (MUT !== 'g' && T) T.focus();
  if (MUT !== 't') ev.stopPropagation();
}, MUT !== 't');
document.getElementById('sortBar').addEventListener('click', function (e) {
  var b = e.target.closest('[data-sort-by]'); if (!b) return;
  var k = b.dataset.sortBy;
  var by = MUT === 'sortSplit' ? LOCAL.by : currentSortBy, dir = MUT === 'sortSplit' ? LOCAL.dir : currentSortDir;
  var kk = MUT === 'sortKeyMap' && k === 'layer' ? 'status' : k;
  if (by === kk) { if (dir === 'desc') dir = 'asc'; else { by = null; dir = 'desc'; } } else { by = kk; dir = MUT === 'sortDirFlip' ? 'asc' : 'desc'; }
  if (MUT === 'sortSplit') { LOCAL.by = by; LOCAL.dir = dir; } else { currentSortBy = by; currentSortDir = dir; }
  currentPage = 1; renderModelsPage();
});
renderModelsPage();
`;
function synthPage(cfg) {
  const viewer = !!cfg.viewer, bodyMenus = [], html = {};
  const rows = SYNTH_ROWS.filter(r => cfg.form !== 'head' || !r.dataActOnly);
  for (const m of rows) html[m.id] = cfg.form === 'head' ? synthHeadRow(m, viewer) : synthEntry(m, cfg, bodyMenus);
  let menusHtml = bodyMenus.join('');
  if (cfg.ctlWs) { for (const id of Object.keys(html)) html[id] = synthShuffle(html[id]); menusHtml = synthShuffle(menusHtml); }
  const keys = cfg.mut === 'sortKeys' ? DATAACT_SORT_KEYS.slice(1) : DATAACT_SORT_KEYS;
  const sortBar = keys.map(k => '<button type="button" data-sort-by="' + k + '">' + k + '</button>').join('');
  const listHtml = cfg.form === 'head' ? '<table id="modelListTable"><tbody id="modelListBody"></tbody></table>' : '<div id="modelListBody"' + (cfg.mut === 'roleList' ? '' : ' role="list"') + '></div>';
  let scriptSrc = SYNTH_SCRIPT();   // [#106 S4b2] 顶层不再调用 String.raw 标签模板：SYNTH_SCRIPT 改成返回脚本文本的箭头函数
  if (cfg.mut === 'readonlySort') scriptSrc = scriptSrc.replace('let currentSortBy = null;', "var __sb = null; Object.defineProperty(window, 'currentSortBy', { get: function () { return __sb; }, set: function () {} });").replace('{ currentSortBy = by; currentSortDir = dir; }', '{ __sb = by; currentSortDir = dir; }');   // 排序全局只读（getter），页面用私有状态排序
  if (cfg.mut === 'stickySort') scriptSrc = scriptSrc.replace('let currentSortBy = null;', "var __sb = null; Object.defineProperty(window, 'currentSortBy', { get: function () { return __sb; }, set: function (v) { if (v !== null) __sb = v; } });");   // 写入有效但无法恢复成 null
  if (cfg.mut === 'noSortGlobal') scriptSrc = scriptSrc.replace(/currentSortBy/g, 'sortByX');   // M3：页面没有 currentSortBy 全局
  const script = scriptSrc.replace('__CFG__', () => JSON.stringify({ form: cfg.form, mut: cfg.mut || '', rows, html, bodyMenus: menusHtml, pageSize: cfg.pageSize || 0 }).replace(/</g, '\\u003c'));
  return '<!doctype html><html><head><meta charset="utf-8"><style>' + SYNTH_CSS + '</style></head><body' + (cfg.tall ? ' class="tall"' : '') + '><nav id="fixedNav">固定导航栏</nav><h1 id="pageTitle">目录</h1><input id="searchKeyword"><div id="sortBar">' + sortBar + '</div>' + listHtml + '<script>' + script + '<\/script>' + (cfg.mut === 'rogueAct' ? '<button type="button" data-act="delete">rogue</button>' : '') + '</body></html>';
}
// ---- S.5 用例（--self-test-dataact）----
async function selfTestDataAct() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  let bad = 0, n = 0;
  const check = (label, cond, extra) => { n++; if (!cond) { bad++; console.log('  FAIL ' + label + (extra ? '：' + extra : '')); } else console.log('  ok   ' + label + (extra ? '：' + extra : '')); };
  const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e && e.message); } };
  const IDS = SYNTH_ROWS.map(m => m.id);
  const FILLER = 101;   // 对应真实库的填充 ODS #101：走 extraIds 完整建格
  const BASE_IDS = IDS.filter(id => id !== FILLER);
  const IDS_EQ = SYNTH_ROWS.filter(m => !m.dataActOnly).map(m => m.id);   // 旧读法能读的行（HEAD 形态里没有 dataActOnly 行）
  const flat = (r) => ({ matrix: { ...r.matrix, ...(r.extra ? r.extra.matrix : {}) }, extras: { ...r.extras, ...(r.extra ? r.extra.extras : {}) } });
  const pick = (o, ids) => Object.fromEntries(ids.map(i => [i, o[i]]));
  const firstLine = (e) => String(e && e.message).split('\n')[0].replace(/^page\.evaluate: (Error: )?/, '');
  let html = '';
  try {
    // 0 纯函数层：建格 / 对应表（不开页面）
    {
      const okCall = (fn, args) => [{ fn, args }];
      const PM = { where: 'menu', menuKind: 'more', inActions: true };
      check('建格：未知 data-act 值抛错', /不在词表里/.test(throws(() => buildRowMatrixFromDataAct([{ act: 'bogus', disabled: false, calls: [] }], 7)) || ''));
      check('建格：同一动作出现两次抛错', /出现了两次/.test(throws(() => buildRowMatrixFromDataAct([{ ...PM, act: 'delete', calls: okCall('deleteModel', [7]) }, { ...PM, act: 'delete', calls: okCall('deleteModel', [7]) }], 7)) || ''));
      check('建格：可用格 0 次调用抛错（不产生 dead）', /恰好收到 1 次/.test(throws(() => buildRowMatrixFromDataAct([{ ...PM, act: 'delete', calls: [] }], 7)) || ''));
      check('建格：置灰格（disabled 或 aria-disabled）收到调用抛错', /置灰格被点击后仍收到调用/.test(throws(() => buildRowMatrixFromDataAct([{ ...PM, act: 'delete', disabled: true, calls: okCall('deleteModel', [7]) }], 7)) || '') && /置灰格被点击后仍收到调用/.test(throws(() => buildRowMatrixFromDataAct([{ ...PM, act: 'delete', ariaDisabled: true, calls: okCall('deleteModel', [7]) }], 7)) || ''));
      check('建格：调用的函数与 data-act 不一致抛错', /不一致/.test(throws(() => buildRowMatrixFromDataAct([{ ...PM, act: 'delete', calls: okCall('viewModelChangeLogs', [7]) }], 7)) || ''));
      check('建格：目标 id 与所在行不符抛错', /目标 id/.test(throws(() => buildRowMatrixFromDataAct([{ ...PM, act: 'delete', calls: okCall('deleteModel', [8]) }], 7)) || ''));
      check('建格：验收阶段与 data-act 不符抛错（validate-data 实际调 structure）', /不一致/.test(throws(() => buildRowMatrixFromDataAct([{ ...PM, menuKind: 'validate', act: 'validate-data', calls: okCall('openValidationModal', [7, 't', 'S', 'DIM', 'structure']) }], 7)) || ''));
      check('建格：reason = title；置灰 → inert', JSON.stringify(buildRowMatrixFromDataAct([{ ...PM, act: 'etl', disabled: true, ariaDisabled: false, title: 'x', reasonText: 'x', calls: [] }], 7).etl) === '{"present":true,"enabled":false,"reason":"x","inert":true}');
      check('入口：data-entry 表外值抛错 / iteration-history 别名 → iteration-badge', /入口表里/.test(throws(() => buildRowExtrasFromDataEntry([{ entry: 'bogus', calls: [] }], 7)) || '') && buildRowExtrasFromDataEntry([{ entry: 'iteration-history', calls: okCall('viewIterationHistory', [7]) }], 7)['iteration-badge'].handler === 'iteration-history');
      check('入口：open-drawer 的 data-model-id 与所在行不符抛错', /data-model-id/.test(throws(() => buildRowExtrasFromDataEntry([{ entry: 'open-drawer', modelId: '8', calls: okCall('openModelDrawer', [8, '$element']) }], 7)) || ''));
      check('入口：入口调用了别的函数抛错（design-notes 实际调抽屉）', /应调用 showDesignNotesPopover/.test(throws(() => buildRowExtrasFromDataEntry([{ entry: 'design-notes', calls: okCall('openModelDrawer', [7, '$element']) }], 7)) || ''));
      check('PROBE_NAMES_DATAACT 覆盖对应表 + 入口函数 + 抽屉，且不含旧触发函数', Object.keys(HANDLER_TO_ACT).concat(Object.keys(EXTRA_HANDLER), ['openModelDrawer']).every(f => PROBE_NAMES_DATAACT.includes(f)) && ![...TRIGGER_CALLS].some(f => PROBE_NAMES_DATAACT.includes(f)));
      check('基线保留的排序键恰为 6 个：id / layer / table_name / tech_owner / status / updated_at', JSON.stringify(DATAACT_BASELINE_SORT_KEYS) === '["id","layer","table_name","tech_owner","status","updated_at"]' && DATAACT_SORT_KEYS.length === 8, JSON.stringify(DATAACT_BASELINE_SORT_KEYS));
      check('ACTS 恰为 11 个动作词', ACTS.length === 11);
      // 预筛 H2：原始参数类别
      const rawCall = (raw, args) => ({ fn: 'openDDLModal', args, raw });
      const OKO = { t: 'object', plain: true, live: false, snap: '{"id":7,"a":{"b":[1]}}', rowJson: '{"a":{"b":[1]},"id":7}', shares: false };
      check('原始参数：行副本是字符串 → 抛错；是 allModelsData 原引用 → 抛错；非普通对象 → 抛错；独立普通对象 → 通过', /实得字符串/.test(rawArgProblem(rawCall([{ t: 'string' }], [{ $model: 7 }])) || '') && /原引用/.test(rawArgProblem(rawCall([{ t: 'object', plain: true, live: true }], [{ $model: 7 }])) || '') && /普通对象/.test(rawArgProblem(rawCall([{ t: 'object', plain: false, live: false }], [{ $model: 7 }])) || '') && rawArgProblem(rawCall([OKO], [{ $model: 7 }])) === null);
      check('原始参数：$element 必须是被点击元素', /被点击的那个元素/.test(rawArgProblem({ fn: 'showDesignNotesPopover', args: ['$element', 'x'], raw: [{ t: 'element', isTarget: false }, { t: 'string' }] }) || '') && rawArgProblem({ fn: 'showDesignNotesPopover', args: ['$element', 'x'], raw: [{ t: 'element', isTarget: true }, { t: 'string' }] }) === null);
      check('行副本内容：缺字段 / 字段值不同 → 抛错；共享嵌套引用 → 抛错；找不到对应行 → 抛错；深拷贝通过；deepEq 独立实现（键序无关、数组 / 嵌套区分）', /内容与该行不一致/.test(rawArgProblem(rawCall([{ ...OKO, snap: '{"id":7}' }], [{ $model: 7 }])) || '') && /内容与该行不一致/.test(rawArgProblem(rawCall([{ ...OKO, snap: '{"id":7,"a":{"b":[2]}}' }], [{ $model: 7 }])) || '') && /共享嵌套引用/.test(rawArgProblem(rawCall([{ ...OKO, shares: true }], [{ $model: 7 }])) || '') && /找不到对应行/.test(rawArgProblem(rawCall([{ ...OKO, rowJson: null }], [{ $model: 7 }])) || '') && deepEq({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] }) && !deepEq({ a: [1] }, { a: { 0: 1 } }) && !deepEq({ a: 1 }, { a: 1, b: undefined }));
      check('置灰原因 6a：title 为空 / 缺 .model-menu-reason / 文字与 title 不同 → 抛错；相同、可用项不查', /缺 \.model-menu-reason/.test(throws(() => checkReasons([{ ...PM, act: 'etl', disabled: true, title: 'x' }], 7)) || '') && /不一致/.test(throws(() => checkReasons([{ ...PM, act: 'etl', disabled: true, title: 'x', reasonText: 'y' }], 7)) || '') && /title 为空/.test(throws(() => checkReasons([{ ...PM, act: 'ddl', disabled: true, title: '' }], 7)) || '') && throws(() => checkReasons([{ ...PM, act: 'etl', disabled: true, title: 'x', reasonText: 'x' }, { ...PM, act: 'delete', title: 'z' }], 7)) === null);
      // 预筛 M1：位置
      const pos = (arr) => throws(() => checkActPositions(arr, 7));
      check('位置：validate 在菜单里 → 抛错；validate-* 在 ⋯ 菜单 → 抛错；矩阵动作做成菜单外按钮 → 抛错；⋯ 顺序颠倒 → 抛错；合法排列通过', /位置不符/.test(pos([{ act: 'validate', where: 'menu', menuKind: 'more', inActions: true }]) || '') && /位置不符/.test(pos([{ act: 'validate-data', where: 'menu', menuKind: 'more', inActions: true }]) || '') && /位置不符/.test(pos([{ act: 'delete', where: 'direct', menuKind: null, inActions: true }]) || '') && /顺序不符/.test(pos([{ ...PM, act: 'delete' }, { ...PM, act: 'etl' }]) || '') && pos([{ act: 'validate', where: 'direct', menuKind: null, inActions: true }, { ...PM, act: 'etl' }, { ...PM, act: 'edit-info' }, { ...PM, act: 'delete' }]) === null);
    }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(INIT_SCRIPT);
    await ctx.route('http://synth.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    const open = async (cfg) => { html = synthPage(cfg); const page = await ctx.newPage(); const tr = track(page); await page.goto('http://synth.test/p', { waitUntil: 'load' }); return { page, tr }; };
    const TIMEOUT = 1500;
    const snap = (page) => () => page.evaluate(() => document.getElementById('modelListBody').innerHTML.length);
    /** 与 openPage 的 dataact 分支同序：static → ready → settle → 读 */
    const readNew = async (cfg) => {
      const { page, tr } = await open(cfg);
      try {
        const viewer = !!cfg.viewer;
        await assertCatalogStructure(page, { phase: 'static' });
        await assertCatalogStructure(page, { phase: 'ready', viewer, timeout: TIMEOUT });
        await settle(page, tr, snap(page), 'synth');
        const res = await readRowsFromDataAct(page, tr, BASE_IDS, { viewer, timeout: TIMEOUT, extraIds: [FILLER] });
        if (tr.pageErrors) throw new Error('合成页出现 pageerror ' + tr.pageErrors + ' 个');
        return res;
      } finally { await page.close(); }
    };
    const readOld = async (cfg) => {
      const { page, tr } = await open(cfg);
      try { await settle(page, tr, snap(page), 'synth-head'); return await readRowsFromHandlers(page, tr, IDS_EQ); } finally { await page.close(); }
    };
    const expectOf = (viewer) => ({ matrix: Object.fromEntries(SYNTH_ROWS.map(m => [m.id, synthExpectedMatrix(m, viewer)])), extras: Object.fromEntries(SYNTH_ROWS.map(m => [m.id, synthExpectedExtras(m)])) });
    const diffExpected = (res0, viewer, form, ids = IDS) => {
      const exp = expectOf(viewer), res = flat(res0);
      for (const id of ids) {
        for (const a of ACTS) if (!deepEqual(res.matrix[id][a], exp.matrix[id][a])) return form + ' 行 ' + id + ' 动作 ' + a + ' 与期望格不等：读到 ' + JSON.stringify(res.matrix[id][a]) + '，期望 ' + JSON.stringify(exp.matrix[id][a]);
        for (const e of EXTRA_ENTRIES) if (!deepEqual(res.extras[id][e], exp.extras[id][e])) return form + ' 行 ' + id + ' 入口 ' + e + ' 与期望格不等：读到 ' + JSON.stringify(res.extras[id][e]) + '，期望 ' + JSON.stringify(exp.extras[id][e]);
      }
      return null;
    };
    const runFull = async (cfg) => { const res = await readNew({ form: 'dataact', ...cfg }); const d = diffExpected(res, !!cfg.viewer, 'data-act 形态'); if (d) throw new Error(d); return res; };

    // 1 等价性：同一份行数据，旧读法读 HEAD 形态、新读法读 data-act 形态，格子逐字段相等；两者都与手写期望相等；手写锚点
    {
      const oldRes = await readOld({ form: 'head' });
      const newRes = await readNew({ form: 'dataact' });
      const nf = flat(newRes);
      check('等价性（admin 视角，12 行 × 11 动作 + 3 入口）：旧读法读 HEAD 形态 = 手写期望', diffExpected(oldRes, false, 'HEAD 形态', IDS_EQ) === null, diffExpected(oldRes, false, 'HEAD 形态', IDS_EQ) || '');
      check('等价性：新读法读 data-act 形态（15 行，含注入样本行 / 全置灰行 / 填充行）= 手写期望', diffExpected(newRes, false, 'data-act 形态') === null, diffExpected(newRes, false, 'data-act 形态') || '');
      check('等价性：矩阵逐字段相等（含 call.fn / 参数 / 参数个数 / inert / reason；旧读法能读的 13 行）', deepEqual(oldRes.matrix, pick(nf.matrix, IDS_EQ)));
      check('等价性：rowExtras 逐字段相等', deepEqual(oldRes.extras, pick(nf.extras, IDS_EQ)));
      check('填充行 #101（extraIds 完整建格）= 手写期望，且不进 matrix', !('101' in newRes.matrix) && JSON.stringify(newRes.extra.matrix[101].ddl) === '{"present":true,"enabled":true,"reason":"","call":{"fn":"openDDLModal","args":[{"$model":101}]}}' && JSON.stringify(newRes.extra.matrix[101].history) === '{"present":true,"enabled":true,"reason":"查看变更历史","call":{"fn":"viewModelChangeLogs","args":[101]}}' && JSON.stringify(newRes.extra.matrix[101].validate) === '{"present":true,"enabled":true,"reason":"","call":{"fn":"openValidationModal","args":[101,"ods_filler_01_df","ONLINE","ODS"]}}');
      check('设计说明注入样本（行 23）：参数 = 手写转义表结果；全置灰行 #24 的 ⋯ 菜单项全部置灰且读为 inert', JSON.stringify(newRes.extras[23]['design-notes']) === '{"present":true,"handler":"design-notes","enabled":true,"call":{"fn":"showDesignNotesPopover","args":["$element",' + JSON.stringify(SYNTH_INJ_EXPECT) + ']}}' && ['etl', 'ddl', 'edit-config', 'edit-info', 'history', 'delete'].every(a => newRes.matrix[24][a].present && !newRes.matrix[24][a].enabled && newRes.matrix[24][a].inert === true), JSON.stringify(newRes.extras[23]['design-notes']));
      const j = JSON.stringify;
      const anchors = [
        [oldRes.matrix[13].delete, '{"present":true,"enabled":true,"reason":"","call":{"fn":"deleteModel","args":[13]}}', '#13 delete：deleteModel 只有 1 个参数'],
        [oldRes.matrix[11].ddl, '{"present":true,"enabled":true,"reason":"","call":{"fn":"openDDLModal","args":[{"$model":11}]}}', '#11 ODS ddl：行副本归一化'],
        [oldRes.matrix[13]['validate-data'], '{"present":true,"enabled":true,"reason":"","call":{"fn":"openValidationModal","args":[13,"dim_a","CREATED","DIM","data"]}}', '#13 DIM validate-data：5 个参数'],
        [oldRes.matrix[18]['validate-structure'], '{"present":true,"enabled":true,"reason":"","call":{"fn":"openValidationModal","args":[18,"dwd_b_df","ONLINE","DWD","structure"]}}', '#18 大写 DWD validate-structure'],
        [oldRes.matrix[11].validate, '{"present":true,"enabled":true,"reason":"","call":{"fn":"openValidationModal","args":[11,"ods_a_df","ONLINE","ODS"]}}', '#11 ODS validate：4 个参数'],
        [oldRes.matrix[15].validate, '{"present":true,"enabled":false,"reason":"伴生表无需独立验收","inert":true}', '#15 伴生 validate 置灰'],
        [oldRes.matrix[12].delete, '{"present":true,"enabled":false,"reason":"无删除权限","inert":true}', '#12 无权限 delete 置灰'],
        [oldRes.matrix[14].history, '{"present":true,"enabled":true,"reason":"查看变更历史","call":{"fn":"viewModelChangeLogs","args":[14]}}', '#14 history：title 与 1 个参数'],
        [oldRes.matrix[14].etl, '{"present":true,"enabled":true,"reason":"","call":{"fn":"openDwdScriptModal","args":[14]}}', '#14 DWD etl：openDwdScriptModal 只传 1 个参数'],
        [oldRes.matrix[20].etl, '{"present":true,"enabled":true,"reason":"","call":{"fn":"openDimETLModal","args":[20]}}', '#20 大写 DIM etl'],
        [oldRes.matrix[16]['view-config'], '{"present":true,"enabled":true,"reason":"查看 DIM 配置（只读）","call":{"fn":"openDimConfigViewModal","args":[16]}}', '#16 无编辑权限 DIM view-config'],
        [oldRes.extras[11]['design-notes'], '{"present":true,"handler":"design-notes","enabled":true,"call":{"fn":"showDesignNotesPopover","args":["$element","设计说明A"]}}', '#11 设计说明入口'],
        [oldRes.extras[14]['design-notes'], '{"present":true,"handler":"design-notes","enabled":true,"call":{"fn":"showDesignNotesPopover","args":["$element","含\\"引号\\""]}}', '#14 设计说明（含引号）'],
        [oldRes.extras[13]['iteration-badge'], '{"present":true,"handler":"iteration-history","enabled":true,"call":{"fn":"viewIterationHistory","args":[13]}}', '#13 迭代入口'],
      ];
      for (const [cell, lit, what] of anchors) check('手写锚点（旧读法读 HEAD 形态）' + what, j(cell) === lit, j(cell));
      // 新读法读到的同位置格子与锚点相同
      const newAnchors = [[newRes.matrix[13].delete, anchors[0][1]], [newRes.matrix[11].ddl, anchors[1][1]], [newRes.matrix[13]['validate-data'], anchors[2][1]], [newRes.matrix[18]['validate-structure'], anchors[3][1]], [newRes.matrix[11].validate, anchors[4][1]], [newRes.matrix[15].validate, anchors[5][1]], [newRes.matrix[12].delete, anchors[6][1]], [newRes.matrix[14].history, anchors[7][1]], [newRes.matrix[14].etl, anchors[8][1]], [newRes.matrix[20].etl, anchors[9][1]], [newRes.matrix[16]['view-config'], anchors[10][1]], [newRes.extras[11]['design-notes'], anchors[11][1]], [newRes.extras[14]['design-notes'], anchors[12][1]], [newRes.extras[13]['iteration-badge'], anchors[13][1]]];
      check('手写锚点：新读法读 data-act 形态在同 14 处与锚点逐字相同', newAnchors.every(([c, lit]) => j(c) === lit));
      check('伴生行 #15 / #19 的 present 集合（词表序）= ddl,etl,view-config,history,delete,validate，无 edit-config / edit-info', [15, 19].every(id => ACTS.filter(a => newRes.matrix[id][a].present).join() === 'ddl,etl,view-config,history,delete,validate'), ACTS.filter(a => newRes.matrix[15][a].present).join());
      const oldV = await readOld({ form: 'head', viewer: true });
      const newV = await readNew({ form: 'dataact', viewer: true });
      const nvf = flat(newV);
      check('等价性（viewer 视角）：矩阵全 absent、rowExtras 逐字段相等且等于手写期望', deepEqual(oldV.matrix, pick(nvf.matrix, IDS_EQ)) && deepEqual(oldV.extras, pick(nvf.extras, IDS_EQ)) && diffExpected(newV, true, 'data-act viewer') === null && IDS.every(id => ACTS.every(a => !nvf.matrix[id][a].present)));
    }
    // 1b 替身恢复：读完后页面上的全局函数是原函数；缺全局函数时抛错且不留半拉子替身
    {
      const { page } = await open({ form: 'dataact' });
      try {
        const orig = await page.evaluate(() => deleteModel.toString());
        await assertCatalogStructure(page, { phase: 'ready', timeout: TIMEOUT });
        await page.evaluate(DESCRIBE_AND_CLICK_FN, CLICK_ARG(false, false));
        check('点击读法结束后全局函数已恢复（替身没有残留）', (await page.evaluate(() => deleteModel.toString())) === orig && !(await page.evaluate(() => deleteModel.toString())).includes('calls.push'));
        let err = null; try { await page.evaluate(DESCRIBE_AND_CLICK_FN, { ...CLICK_ARG(false, false), names: [...PROBE_NAMES_DATAACT, 'noSuchGlobalFn'] }); } catch (e) { err = e; }
        check('页面缺全局函数 → 抛「没有全局函数」且不留半拉子替身', !!err && /没有全局函数 noSuchGlobalFn/.test(err.message) && (await page.evaluate(() => deleteModel.toString())) === orig);
      } finally { await page.close(); }
    }
    // 2 对照组（必须绿）
    const green = async (label, cfg) => {
      let err = null; try { await runFull({ form: 'dataact', ...cfg }); } catch (e) { err = e; }
      check('对照 ' + label + '：必须通过', !err, err ? firstLine(err) : '');
    };
    await green('G1 诚实实现（admin 视角全部格 = 手写期望）', {});
    await green('G2 调整空白与属性顺序（语义不变）', { ctlWs: true });
    await green('G3 加入不带 data-act 的其他控件（展开按钮 / data-pane-act / data-rail / data-catalog-act）', { ctlExtra: true });
    await green('G4 置灰只用 aria-disabled 且分发检查 aria-disabled（读为 inert）', { ariaOnly: true });
    await green('G5 viewer 视角（无触发按钮、无 data-act）', { viewer: true });
    await green('G6 固定 64px 页头 + 长列表（每页高于视口，翻页时上一页已滚到底；按契约写对的页面不得被判被遮挡）', { tall: true });
    await green('G7 交叉文案（data-act="delete" 的项显示「历史」、data-act="history" 的项显示「删除」，其余加空白；data-act 不变），按 data-act 分发的正确实现', { labels: 'alt' });
    await green('G8 单页 13 个条目（相邻触发按钮互斥检查覆盖全部对）', { pageSize: 12 });
    // 2b 设计说明气泡：页面真实的 showDesignNotesPopover 在点击后不得生成 img 节点；噪声样本显示为字面文本
    for (const [mut, expectImg] of [['', 0], ['noEscape', 1]]) {
      const { page } = await open({ form: 'dataact', mut });
      try {
        await assertCatalogStructure(page, { phase: 'ready', timeout: TIMEOUT });
        await page.evaluate(() => { currentPage = 3; renderModelsPage(); });
        await page.click('[data-id="23"] [data-entry="design-notes"]');
        const r = await page.evaluate(() => ({ img: document.querySelectorAll('#popover img').length, text: document.getElementById('popover').textContent }));
        check('注入样本' + (mut ? '（变异 ' + mut + '）' : '（诚实实现）') + '：点击后 #popover 里 img 节点 ' + expectImg + ' 个' + (mut ? '' : '，文本为字面样本'), r.img === expectImg && (mut ? true : r.text === SYNTH_INJ && r.text.includes('<img src=x onerror=alert(1)>') && r.text.includes('&#39;')), JSON.stringify(r));
      } finally { await page.close(); }
    }
    // 3 变异（逐个判红；首条判红文本打印出来）
    const redRows = [];
    const red = async (code, label, cfg, re) => {
      let err = null; try { await runFull({ form: 'dataact', ...cfg }); } catch (e) { err = e; }
      const msg = err ? firstLine(err) : '';
      check('变异 ' + code + ' ' + label + '：必须判红', !!err && re.test(msg), err ? msg : '未判红（假绿）');
      redRows.push([code, label, err ? msg : '(未判红)']);
    };
    await red('a', '分发脚本加载时缓存处理函数引用', { mut: 'a' }, /恰好收到 1 次/);
    await red('b', 'deleteModel(id, ev) 多传第 2 个参数', { mut: 'b' }, /动作 delete 与期望格不等/);
    await red('c', '置灰只用 aria-disabled 且分发不检查', { mut: 'c' }, /置灰格被点击后仍收到调用/);
    await red('d', '点菜单项后菜单不关闭', { mut: 'd' }, /点菜单项后菜单未关闭/);
    await red('e', '点空白处菜单不关闭', { mut: 'e' }, /点空白处后菜单未关闭/);
    await red('f', 'Esc 不关闭', { mut: 'f' }, /Esc 后菜单未关闭/);
    await red('g', 'Esc 关闭了但焦点没回到触发按钮', { mut: 'g' }, /Esc 后焦点未回到触发按钮/);
    await red('h', '菜单项 visibility:hidden', { mut: 'h' }, /菜单项不可见.*visibility:hidden/);
    await red('i', '菜单项 pointer-events:none', { mut: 'i' }, /菜单项不可见.*pointer-events:none/);
    await red('j', '菜单上 aria-hidden="true"', { mut: 'j' }, /菜单没打开.*aria-hidden/);
    await red('k', '菜单项被覆盖层盖住（elementFromPoint）', { mut: 'k' }, /菜单项不可见.*被遮挡/);
    await red('l', '分发用「上次打开的行」而不是点击所在条目', { mut: 'l' }, /目标 id .* 与所在行 .* 不一致/);
    await red('l2', '菜单挂在 body 上（不在同一条目内部）', { mut: 'l2' }, /结构缺失.*不在同一条目内部/);
    await red('m', 'data-act 取了词表以外的值', { mut: 'm' }, /结构缺失.*data-act 值 "frobnicate" 不在词表里/);
    await red('n', '条目嵌套（[data-id] 里还有 [data-id]）', { mut: 'n' }, /结构缺失.*嵌套条目/);
    await red('o', '元素有 data-act 但分发表漏了这个 case', { mut: 'o' }, /恰好收到 1 次/);
    await red('p', '菜单打开了但 aria-expanded 没更新', { mut: 'p' }, /aria-expanded 与菜单可见性不一致/);
    await red('q', '永远不设 ready', { mut: 'q' }, /初始化超时/);
    await red('r', '设了 ready 但条目缺 ⋯ 触发按钮', { mut: 'r' }, /结构缺失.*缺 ⋯ 触发按钮/);
    await red('s', '分发用小写比较分层（大写行走兜底分支）', { mut: 's' }, /与期望格不等/);
    await red('t', 'Esc 处理在冒泡阶段且不 stopPropagation', { mut: 't' }, /没有在 capture 阶段 stopPropagation/);
    await red('u', 'renderModelsPage 之后菜单仍保持打开', { mut: 'u' }, /渲染后仍有菜单打开/);
    await red('v', '打开一个菜单时不关闭其他已打开的菜单', { mut: 'v' }, /打开另一个菜单时已打开的菜单没有关闭/);
    await red('w', '关闭菜单不带 hidden 属性（只改 display）', { mut: 'w' }, /结构缺失.*关闭态的菜单缺 hidden 属性/);
    await red('x', 'viewer 页面上仍有 ⋯ 触发按钮与 data-act', { mut: 'x', viewer: true }, /结构缺失.*viewer 的条目/);
    await red('dis', '置灰项（aria-disabled）被点击后分发脚本关闭了菜单', { mut: 'dis' }, /置灰项点击后菜单被关闭/);
    await red('pg', '第 2 页少渲染一个条目（与 getCatalogView().pageGroups 不一致）', { mut: 'pgMismatch' }, /条目序列/);
    // 预筛修复批新增（H1 / H2 / M1 / M2 / M5 / LOW）
    await red('k2', 'H1：固定页头 + 长列表下覆盖层遮挡仍须判红', { mut: 'k', tall: true }, /菜单项不可见.*被遮挡/);
    await red('ddlStr', 'H2：openDDLModal(JSON.stringify(row)) 行副本传成 JSON 串', { mut: 'ddlStr' }, /行副本必须是对象，第 1 个参数实得字符串/);
    await red('editDataset', 'H2：openEditModal 收到 dataset 字符串（漏 JSON.parse）', { mut: 'editDataset' }, /行副本必须是对象，第 1 个参数实得字符串/);
    await red('liveRow', 'H2：openEditModal 收到 allModelsData 里的原引用', { mut: 'liveRow' }, /行副本不得是 allModelsData 里的原引用/);
    await red('notesEl', 'H2：设计说明气泡传了条目而不是被点的按钮', { mut: 'notesEl' }, /元素参数必须就是被点击的那个元素/);
    await red('valInMore', 'M1：ODS 验收放进 ⋯ 菜单', { mut: 'valInMore' }, /位置不符（契约 4 \/ 5）——行 11 的 data-act="validate"/);
    await red('valMenuInMore', 'M1：DIM 验收阶段项放进 ⋯ 菜单', { mut: 'valMenuInMore' }, /位置不符（契约 4 \/ 5）——行 13 的 data-act="validate-structure"/);
    await red('actDirect', 'M1：删除做成菜单外的直接按钮', { mut: 'actDirect' }, /位置不符（契约 4）——行 11 的 data-act="delete"/);
    await red('orderRev', 'M1：⋯ 菜单顺序颠倒', { mut: 'orderRev' }, /菜单项顺序不符（契约 4）/);
    await red('escOnMenu', 'M2：Esc 监听只绑在菜单元素上（焦点在触发按钮时不关）', { mut: 'escOnMenu' }, /Esc 后菜单未关闭（焦点在触发按钮上）/);
    await red('noToggle', 'M2：再点 ⋯ 不收起', { mut: 'noToggle' }, /再点触发按钮后菜单未收起/);
    await red('outsideBodyOnly', 'M2：点空白只认 body', { mut: 'outsideBodyOnly' }, /点空白处后菜单未关闭（目标 h1#pageTitle/);
    await red('outsideIgnoresList', 'M2：点列表内其他条目不关', { mut: 'outsideIgnoresList' }, /点空白处后菜单未关闭（目标 另一个条目/);
    await red('targetNoClosest', 'M2：分发用 e.target.dataset 而不是 closest（点到项内 span 失效）', { mut: 'targetNoClosest' }, /菜单没打开/);
    await red('trigHidden', 'M2：触发按钮 visibility:hidden', { mut: 'trigHidden' }, /触发按钮不可见.*visibility:hidden/);
    await red('asyncOpen', 'M5：菜单经 setTimeout 才打开', { mut: 'asyncOpen' }, /契约 14：须同步/);
    await red('roleList', 'LOW：容器没有 role="list"', { mut: 'roleList' }, /结构缺失.*div\[role="list"\]/);
    await red('noCompClass', 'LOW：伴生条目缺 is-companion 类', { mut: 'noCompClass' }, /结构缺失.*缺 is-companion 类/);
    await red('readyCleared', 'LOW：重渲染把 ready 清掉', { mut: 'readyCleared' }, /初始化超时/);
    await red('uValidate', 'LOW：renderModelsPage 后只有验收菜单保持打开', { mut: 'uValidate' }, /渲染后仍有菜单打开.*validate/);
    // codex 37 / 37T 修复批新增
    await red('partialRow', '37 H1：行副本只传 {id}', { mut: 'partialRow' }, /行副本内容与该行不一致/);
    await red('shallowRow', '37 H1：行副本是浅拷贝（共享嵌套 stages 引用）', { mut: 'shallowRow' }, /共享嵌套引用/);
    await red('tamperedRow', '37 H1：行副本改了一个字段值', { mut: 'tamperedRow' }, /行副本内容与该行不一致/);
    await red('escFocusAsync', '37 H3：Esc 同步关闭菜单，焦点在 microtask 里才回到触发按钮', { mut: 'escFocusAsync' }, /Esc 后焦点未回到触发按钮.*契约 14：须同步——Esc 关闭菜单与焦点回到触发按钮都须同步完成/);
    await red('ancestorVis', '37 M1：祖先 visibility:hidden、子元素 visibility:visible', { mut: 'ancestorVis' }, /菜单没打开.*祖先 span\.mw visibility:hidden/);
    await red('ancestorPE', '37 M1：祖先 pointer-events:none、子元素 auto', { mut: 'ancestorPE' }, /菜单没打开.*祖先 span\.mw pointer-events:none/);
    await red('lateRenderKeep', '37 M2：只有第 3 页起重渲染不关菜单', { mut: 'lateRenderKeep' }, /渲染后仍有菜单打开/);
    await red('lateMutex', '37 M2：第 10 个条目起互斥失效（相邻对 > 8）', { mut: 'lateMutex', pageSize: 12 }, /打开另一个菜单时已打开的菜单没有关闭/);
    await red('rogueAct', '37 M3：列表外有一个 data-act 控件', { mut: 'rogueAct' }, /结构缺失.*列表外、不在任何条目里或位置不合法的控件.*button\[data-act="delete"\]/);
    await red('reasonMismatch', '37 M4：置灰原因可见文字与 title 不同', { mut: 'reasonMismatch' }, /置灰原因可见文字与 title 不一致（契约 6a）/);
    await red('reasonMissing', '37 M4：置灰菜单项缺 .model-menu-reason', { mut: 'reasonMissing' }, /置灰菜单项缺 \.model-menu-reason（契约 6a）/);
    await red('textDispatch', '37T H1：分发按 textContent 映射（映射表完整；G7 交叉文案下调错处理函数）', { mut: 'textDispatch', labels: 'alt' }, /点击实际调用 (deleteModel（= delete），与 data-act history|viewModelChangeLogs（= history），与 data-act delete) 不一致/);
    await red('noEscape', '37T M2：设计说明文本不转义', { mut: 'noEscape' }, /行 23 入口 design-notes 与期望格不等/);
    await red('fillerWrongId', '37T M3：填充行分发到错误 id', { mut: 'fillerWrongId' }, /目标 id .* 与所在行 101 不一致/);
    await red('menuItemDiv', '37T L1：菜单项是 div[role=menuitem] 而不是 button', { mut: 'menuItemDiv' }, /结构缺失.*必须是 button\[role="menuitem"\]/);
    await red('trigNoPopup', '37T L1：触发按钮缺 aria-haspopup', { mut: 'trigNoPopup' }, /结构缺失.*缺 aria-haspopup="menu"/);
    await red('trigNoControls', '37T L1：触发按钮缺 aria-controls', { mut: 'trigNoControls' }, /结构缺失.*aria-controls 没有指向存在的元素/);
    await red('notesDiv', '37T L1：设计说明入口是 div 不是 button', { mut: 'notesDiv' }, /结构缺失.*设计说明入口必须是 button/);
    await red('stateError', '37T L1：data-catalog-state="error"', { mut: 'stateError' }, /初始化失败/);
    // 37-R 收口批
    await red('deepShared', '37-R M1：行副本第 7 层共享引用（老深度上限 6 会漏）', { mut: 'deepShared' }, /共享嵌套引用/);
    await red('emptyTitle', '37-R M3：置灰项 title 为空且无 .model-menu-reason', { mut: 'emptyTitle' }, /置灰菜单项 title 为空（契约 6a/);
    await red('actInPanel', '37-R M4：条目内但不在动作区 / 菜单里的 data-act', { mut: 'actInPanel' }, /结构缺失.*位置不合法的控件.*button\[data-act="history"\]|结构缺失.*位置不合法的控件.*button/);
    await red('badEntry', '37-R M4：未登记的 data-entry 值', { mut: 'badEntry' }, /结构缺失.*data-entry 值 "mystery" 不在入口表里/);
    await red('viewerMenu', '37-R L2：viewer 页面上有可见的 [role=menu]', { mut: 'viewerMenu', viewer: true }, /viewer 渲染后页面上仍有可见的 \[role=menu\]/);
    await red('escItemOnly', '37 L1：Esc 在菜单容器（全置灰菜单）上不处理', { mut: 'escItemOnly' }, /Esc 后菜单未关闭（焦点在菜单容器上，菜单项全部置灰）/);
    // 4 排序读法：诚实页面 + 两个变异
    {
      const sortRun = async (cfg) => { const { page, tr } = await open({ form: 'dataact', ...cfg }); try { await assertCatalogStructure(page, { phase: 'static' }); await assertCatalogStructure(page, { phase: 'ready', timeout: TIMEOUT }); await settle(page, tr, snap(page), 'synth-sort'); return await readSortDataAct(page, tr); } finally { await page.close(); } };
      const honest = await sortRun({});
      const idDesc = [101, 24, 23, 22, 21, 20, 18, 19, 17, 16, 14, 15, 13, 12, 11], idAsc = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 101];
      check('排序读法（诚实页面）：default / id.desc / id.asc / id.cleared 等于手写序列（伴生紧跟主模型）', deepEqual(honest.sort.default, idAsc) && deepEqual(honest.sort.id.desc, idDesc) && deepEqual(honest.sort.id.asc, idAsc) && deepEqual(honest.sort.id.cleared, idAsc), JSON.stringify(honest.sort.id.desc));
      check('排序读法：键集 = 6 个基线保留键 + default；渲染序列 = orderedIds；每个键三态都读到', Object.keys(honest.sort).join() === ['default', ...DATAACT_BASELINE_SORT_KEYS].join() && deepEqual(honest.sort, honest.sortRendered) && DATAACT_BASELINE_SORT_KEYS.every(k => ['desc', 'asc', 'cleared'].every(d => honest.sort[k][d].length === 15)));
      check('排序读法：tech_owner.desc 手写序列（甲 > 乙 > 丙 > 丁 按码点降序，同值保持原序，伴生紧跟）', deepEqual(honest.sort.tech_owner.desc, [12, 16, 21, 101, 14, 15, 20, 24, 13, 17, 22, 11, 18, 19, 23]), JSON.stringify(honest.sort.tech_owner.desc));
      for (const [code, label, cfg, re] of [['sortSplit', '点击不写 currentSortBy / currentSortDir（渲染用私有状态）', { mut: 'sortSplit' }, /渲染序列 ≠ orderedIds|点击读到/], ['sortKeys', '排序按钮只有 7 个键', { mut: 'sortKeys' }, /目录页结构或全局已改.*button\[data-sort-by\]/], ['sortKeyMap', 'M3：点 layer 键实际按 status 排（全局同步写错）', { mut: 'sortKeyMap' }, /点击读到的 orderedIds ≠ 程序方式/], ['sortDirFlip', 'M3：第一次点得 asc（方向反了）', { mut: 'sortDirFlip' }, /点击读到的 orderedIds ≠ 程序方式/], ['noSortGlobal', 'M3：页面没有 currentSortBy 全局', { mut: 'noSortGlobal' }, /目录页结构或全局已改.*currentSortBy/], ['stickySort', '37-R M2：currentSortBy 写入有效但无法恢复成原值', { mut: 'stickySort' }, /currentSortBy 恢复后回读不等/], ['readonlySort', '37 H2：currentSortBy 是只读 getter（页面用私有状态排序）', { mut: 'readonlySort' }, /目录页结构或全局已改.*currentSortBy（须可写/]]) {
        let err = null; try { await sortRun(cfg); } catch (e) { err = e; }
        const msg = err ? firstLine(err) : '';
        check('变异 ' + code + ' ' + label + '：必须判红', !!err && re.test(msg), err ? msg : '未判红（假绿）');
        redRows.push([code, label, err ? msg : '(未判红)']);
      }
    }
    // 5 结构失败文本互不相同：静态缺失 / 初始化超时 / 结构缺失
    {
      const texts = redRows.filter(r => ['sortKeys', 'q', 'r'].includes(r[0])).map(r => r[2].slice(0, 12));
      check('三种结构失败文本可区分（目录页结构或全局已改 / 初始化超时 / 结构缺失）', new Set(texts).size === 3, texts.join(' | '));
    }
    console.log('---- 变异首条判红文本汇总（供报告引用）----');
    for (const r of redRows) console.log('[变异 ' + r[0] + '] ' + r[1] + ' ⇒ ' + r[2]);
  } finally { await browser.close(); }
  console.log(`[self-test-dataact] ${n - bad}/${n} 通过`);
  return bad ? 1 : 0;
}


// ---------------------------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------------------------
function tokenFor(secret, u) { return require('jsonwebtoken').sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, secret, { expiresIn: '2h' }); }
function stubFieldsFor(cfg) {
  const arr = []; const seen = new Set();
  const add = (n, dt, c) => { if (!n || seen.has(n)) return; seen.add(n); arr.push({ column_name: n, data_type: dt || 'nvarchar(128)', column_comment: c || '' }); };
  const sc = cfg && cfg.scdConfig;
  if (sc) { const fm = {}; (sc.fieldMappings || []).forEach(m => { fm[m.srcField] = m; }); (sc.trackFields || []).forEach(t => add(t, fm[t] && fm[t].dataType, fm[t] && fm[t].comment)); (sc.fieldMappings || []).forEach(m => add(m.srcField, m.dataType, m.comment)); }
  ((cfg && cfg.selectedFields) || []).forEach(m => add(m.srcField, m.dataType, m.comment));
  return arr;
}

/** 录制守卫：baseline.json 已存在时，只有 Model_Center.html 的 sha256（LF 规范化）与 MANIFEST 记录的相同才允许重录 */
function checkRecordGuard() {
  if (!RECORD) return;
  // baseline.json 不存在：只有 MANIFEST 也不存在才是真正的首次录制；MANIFEST 在而页面哈希不同 = 删了 baseline 想在改后代码上重录，拒绝（对抗项）
  if (!fs.existsSync(BASELINE_FILE) && !fs.existsSync(MANIFEST_FILE)) return;   // 首次录制
  const cur = sha256Lf(MC_HTML);
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')).modelCenterSha256Lf; } catch (_) { /* 缺 MANIFEST 视为无法证明 */ }
  if (!rec || rec !== cur) {
    if (!FORCE_RECORD) {
      console.error(`[record] 拒绝：baseline.json（或 MANIFEST.json）已存在，且 Model_Center.html 的 SHA-256（LF 规范化）与 MANIFEST 不同或 MANIFEST 缺失（MANIFEST ${rec ? rec.slice(0, 12) + '…' : '(无)'} / 当前 ${cur.slice(0, 12)}…）。期望值必须来自改前代码，C4 改过页面之后不得再录制。确需重录请加 --force-record。`);
      process.exit(2);
    }
    console.error('!!!!!! [record] --force-record：Model_Center.html 已与基线录制时不同，本次录制会把改后的行为固化为期望，仅限你明确知道在做什么 !!!!!!');
  }
}
function checkManifestIntegrity() {
  let man;
  try { man = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')); } catch (_) { throw new Error('缺少或无法解析 MANIFEST.json（baseline.json 的完整性登记）'); }
  // L1：共享夹具 models.json 被改动后，基线里的期望就不再对应同一批输入——fail-closed，不让夹具漂移被当成「行为变化」登记
  const fx = sha256Lf(MODELS_FILE);
  if (man.modelsFixtureSha256Lf !== fx) throw new Error(`共享夹具已变：models.json 的 SHA-256（LF 规范化）与 MANIFEST 登记不同（${String(man.modelsFixtureSha256Lf).slice(0, 12)}… / ${fx.slice(0, 12)}…）。先回退夹具，或在改前页面上另录基线；不得把夹具漂移登记成行为变化`);
  const bs = sha256Lf(BASELINE_FILE);
  if (man.baselineSha256Lf !== bs) throw new Error(`baseline.json 的 SHA-256（LF 规范化）与 MANIFEST 登记不同（${man.baselineSha256Lf.slice(0, 12)}… / ${bs.slice(0, 12)}…）：baseline.json 不得手改，后续差异只能登记在本文件 ALLOWED_CHANGES`);
}

/**
 * 填充行完整校验（codex 37T M3）：admin 视角的填充 ODS #101（ods_filler_01_df，ONLINE，创建者 admin，无设计说明、无迭代）。
 * 期望按基线里 admin 视角的 ODS #8 同形（ddl / edit-info / delete 可用，etl 置灰，validate 直接按钮，history 带 title）手写，id / 表名替换成 #101，不由任何读法产生。
 */
const FILLER_ID = 101;
function fillerExpected(id, tableName) {
  const row = {};
  for (const a of ACTS) row[a] = { present: false, enabled: false, reason: '' };
  row.ddl = { present: true, enabled: true, reason: '', call: { fn: 'openDDLModal', args: [{ $model: id }] } };
  row.etl = { present: true, enabled: false, reason: 'ODS 同步由 FDL 工具管理', inert: true };
  row['edit-config'] = { present: true, enabled: false, reason: 'ODS 无平台配置，请用编辑信息', inert: true };   // C4c-2 D-18：ODS 行 ⋯ 菜单里的「编辑配置」置灰（与 C4C-D18 登记同源，这里对填充行独立手写）
  row['edit-info'] = { present: true, enabled: true, reason: '', call: { fn: 'openEditModal', args: [{ $model: id }] } };
  row.history = { present: true, enabled: true, reason: '查看变更历史', call: { fn: 'viewModelChangeLogs', args: [id] } };
  row.delete = { present: true, enabled: true, reason: '', call: { fn: 'deleteModel', args: [id] } };
  row.validate = { present: true, enabled: true, reason: '', call: { fn: 'openValidationModal', args: [id, tableName, 'ONLINE', 'ODS'] } };
  const ex = {};
  for (const e of EXTRA_ENTRIES) ex[e] = { present: false, handler: '', enabled: false };
  ex['open-drawer'] = { present: true, handler: 'open-drawer', enabled: true, call: { fn: 'openModelDrawer', args: [id, '$element'] } };
  return { matrix: row, extras: ex };
}
async function mainRecordOrCompare(dbPath) {
  checkRecordGuard();
  checkBackendSearchFields(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'));   // M1：后端搜索字段硬断言（录制 / 比较都执行）
  const { chromium } = require('playwright');
  const secret = testEnv.env().jwtSecret;   // 实例随机密钥（与服务端同源）；不再读 .env
  const rows = loadModelRows();
  const rowOf = (id) => rows.find(r => r.id === id);
  await assertServing();
  await prepareDb(dbPath);
  const browser = await chromium.launch({ headless: true });
  const out = {};
  try {
    const stubRef = { fields: [] };
    const mkCtx = async (user) => {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: TIMEZONE });
      await ctx.clock.setFixedTime(new Date(FIXED_ISO));
      const tok = tokenFor(secret, user);
      await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify({ display_name: u })); } catch (e) { /* ignore */ } }, [tok, user.display_name]);
      await ctx.addInitScript(INIT_SCRIPT);
      await ctx.route('**/api/warehouse/describe-table*', async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stubRef.fields) }); });
      await ctx.route('**/api/models/*/save-scripts', async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: '{"savedFiles":[],"configRevBumped":false}' }); });
      return ctx;
    };
    const withStub = (id) => { stubRef.fields = stubFieldsFor(rowOf(id).dim_config); };
    const admin = await mkCtx(USERS[0]);

    // 1 语义矩阵
    out.matrix = {}; out.rowExtras = {};
    for (const role of ROLES) {
      const ctx = role === 'admin' ? admin : await mkCtx(USER_OF_ROLE[role]);
      stubRef.fields = [];
      const { page, tr } = await openPage(ctx, '', { viewer: role === 'viewer' });
      { const rr = READING === 'dataact' ? await readRowsFromDataAct(page, tr, MODEL_IDS, { viewer: role === 'viewer', extraIds: role === 'admin' ? [FILLER_ID] : [] }) : await readRowsFromHandlers(page, tr); out.matrix[role] = rr.matrix; out.rowExtras[role] = rr.extras;
        if (READING === 'dataact' && role === 'admin') { const fe = fillerExpected(FILLER_ID, 'ods_filler_01_df'); if (!deepEqual(rr.extra.matrix[FILLER_ID], fe.matrix) || !deepEqual(rr.extra.extras[FILLER_ID], fe.extras)) throw new Error('填充行 #' + FILLER_ID + ' 与手写期望不等：读到 ' + JSON.stringify(rr.extra.matrix[FILLER_ID]) + ' / ' + JSON.stringify(rr.extra.extras[FILLER_ID])); } }
      if (tr.errors + tr.pageErrors) throw new Error(`矩阵取样角色 ${role} 出现 console 错误 ${tr.errors + tr.pageErrors} 个`);
      await page.close();
      if (ctx !== admin) await ctx.close();
    }
    // 自检：admin 视角词表里每个动作至少出现过一次（防读法静默失效）
    for (const a of ACTS) if (!MODEL_IDS.some(id => out.matrix.admin[id][a].present)) throw new Error('矩阵自检失败：admin 视角下动作 ' + a + ' 一次都没读到');
    // 自检：creator 的创建者分支确实生效（#201 / #202 可编辑配置与删除；nonowner 不行）
    for (const id of [201, 202]) {
      if (!out.matrix.creator[id]['edit-config'].present || !out.matrix.creator[id].delete.enabled || out.matrix.nonowner[id]['edit-config'].present || out.matrix.nonowner[id].delete.enabled) throw new Error('矩阵自检失败：创建者夹具 #' + id + ' 的创建者分支未按预期生效');
    }
    // 自检：publisher 的 canValidate 分支生效（验收可用、编辑类不可用）；rowExtras 三类入口都读到过
    for (const id of [50, 55, 60, 201]) {
      const m = out.matrix.publisher[id];
      if (!m['validate-structure'].present || !m['validate-structure'].enabled || m['edit-config'].present || m['edit-info'].present || m.delete.enabled) throw new Error('矩阵自检失败：publisher 在 #' + id + ' 上应验收可用、编辑 / 删除不可用');
    }
    // C4c-2（C4C-ITER）：dataact 读法下行内迭代入口已删除（挪进抽屉），改为断言它在所有角色 × 所有模型上都读不到；其余读法（HEAD 复现）仍要求读到
    for (const e of EXTRA_ENTRIES) {
      const seen = MODEL_IDS.some(id => out.rowExtras.admin[id][e].present);
      if (READING === 'dataact' && e === 'iteration-badge') { if (seen || ROLES.some(r => MODEL_IDS.some(id => out.rowExtras[r][id][e].present))) throw new Error('rowExtras 自检失败：行内迭代入口 iteration-badge 应已删除，但仍读到'); }
      else if (!seen) throw new Error('rowExtras 自检失败：入口 ' + e + ' 一次都没读到');
    }
    if (!out.rowExtras.viewer[201]['design-notes'].present || (READING !== 'dataact' && !out.rowExtras.viewer[55]['iteration-badge'].present) || !out.rowExtras.viewer[50]['open-drawer'].present) throw new Error('rowExtras 自检失败：viewer 应能看到抽屉入口 / 设计说明' + (READING === 'dataact' ? '' : ' / 迭代徽章'));
    // 自检：taskowner 的验收权限确由任务种子产生（#60 可验收、#65 不可）
    if (!out.matrix.taskowner[60]['validate-structure'].present || out.matrix.taskowner[65]['validate-structure'].present) throw new Error('矩阵自检失败：taskowner 的任务种子未按预期生效（#60 应可验收、#65 应不可）');

    // 自检（H2）：admin 视角下，大写分层的 ODS / DWD / 伴生行与同层同形态的小写行逐字段相同（每个动作的 present / enabled / reason / call.fn / 参数个数 / inert）
    const cellSig = (c) => JSON.stringify({ present: c.present, enabled: c.enabled, reason: c.reason, inert: !!c.inert, fn: c.call && c.call.fn, argc: c.call && c.call.args.length });
    for (const [upper, lower, what] of [[203, 206, '大写 ODS'], [204, 59, '大写 DWD'], [205, 53, '大写 DWD 伴生行']]) {
      for (const a of ACTS) if (cellSig(out.matrix.admin[upper][a]) !== cellSig(out.matrix.admin[lower][a])) throw new Error(`矩阵自检失败：${what} #${upper} 在动作 ${a} 上与小写同形态行 #${lower} 不同（${cellSig(out.matrix.admin[upper][a])} / ${cellSig(out.matrix.admin[lower][a])}）`);
      if (!ACTS.some(a => out.matrix.admin[upper][a].present && out.matrix.admin[upper][a].enabled)) throw new Error('矩阵自检失败：' + what + ' #' + upper + ' 一个可用动作都没有（夹具未生效？）');
    }
    // 自检（M4）：非 admin 的 ODS 编辑者 / 伴生行负责人分支 / 创建者的 ODS 分支 / 负责人去空白 + 大小写
    { const M = out.matrix;
      if (!M.owner[203]['edit-info'].present || !M.owner[203]['edit-info'].enabled || !M.owner[203].delete.enabled || M.nonowner[203]['edit-info'].enabled || M.nonowner[203].delete.enabled) throw new Error('矩阵自检失败：大写 ODS #203 的负责人（owner）分支未按预期生效');
      if (!M.creator[206]['edit-info'].enabled || !M.creator[206].delete.enabled || M.nonowner[206]['edit-info'].enabled || M.owner[206]['edit-info'].enabled) throw new Error('矩阵自检失败：ODS #206 的创建者分支未按预期生效');
      // 伴生行的负责人分支：HEAD 读法看「删除」按钮（owner 可用、其余不可）；C4c-2 起（P-U1）伴生行删除一律置灰，负责人分支改由「编辑信息」体现（owner 可用、nonowner / creator 不可）
      const compOwnerOk = READING === 'dataact'
        ? (M.owner[208]['edit-info'].enabled && !M.nonowner[208]['edit-info'].enabled && !M.creator[208]['edit-info'].enabled && !M.owner[208].delete.enabled && !M.admin[208].delete.enabled)
        : (M.owner[208].delete.enabled && !M.nonowner[208].delete.enabled && !M.creator[208].delete.enabled);
      if (!M.owner[207]['edit-config'].present || !M.owner[207]['edit-config'].enabled || !compOwnerOk) throw new Error('矩阵自检失败：owner 负责的 DWD #207 / 伴生行 #208 的负责人分支未按预期生效');
      if (!M.owner_b[209]['edit-config'].present || !M.owner_b[209]['edit-config'].enabled || !M.owner_b[209].delete.enabled || !M.owner_b[209]['edit-info'].enabled) throw new Error('矩阵自检失败：owner_b 在其负责的 #209（tech_owner=" owner_b "）上应有编辑权（去空白 + 大小写归一化）');
      for (const id of [50, 55, 65, 203, 207]) if (M.owner_b[id].delete.enabled || M.owner_b[id]['edit-info'].enabled) throw new Error('矩阵自检失败：owner_b 在别人的 #' + id + ' 上不应有编辑权');
      if (M.owner[209].delete.enabled || M.nonowner[209].delete.enabled) throw new Error('矩阵自检失败：#209 对 owner / nonowner 不应可删除');
    }

    // 2 排序序列 + 渲染序列
    { stubRef.fields = []; const { page, tr } = await openPage(admin); const rs = READING === 'dataact' ? await readSortDataAct(page, tr) : await readSort(page, tr); out.sort = rs.sort; out.sortRendered = rs.sortRendered; if (tr.errors + tr.pageErrors) throw new Error(`排序阶段出现 console 错误 ${tr.errors + tr.pageErrors} 个`); await page.close(); }

    // 2b C4b：伴生映射硬断言 + 组页边界自检 + 前端搜索读法（不写进 out、不进基线，只做硬断言与打印）
    if (USE_VIEW) {
      stubRef.fields = [];
      const { page, tr } = await openPage(admin);
      await readGroupPagesAndMapping(page, tr);
      await readFrontendSearch(page, tr);
      if (tr.errors + tr.pageErrors) throw new Error('前端搜索 / 组页边界阶段出现 console 错误 ' + (tr.errors + tr.pageErrors) + ' 个');
      await page.close();
    }

    // 3 深链
    out.deepLinks = await readDeepLinks(admin, rowOf, stubRef, withStub);

    // 4 关键词
    out.keyword = await readKeywords(tokenFor(secret, USERS[0]));

    // 5 导航计算样式
    out.nav = await readNav(admin);

    out.allowedChanges = [];
    out.meta = { schema: 2, fillerRows: FILLER_COUNT, frozenInstant: FIXED_ISO, timezoneId: TIMEZONE, roles: ROLES, modelIds: MODEL_IDS, extraEntries: EXTRA_ENTRIES, acts: ACTS, sortKeys: SORT_KEYS, keywords: KEYWORDS.map(k => k[0]), keywordWildcardExceptions: Object.keys(KEYWORD_WILDCARD_EXCEPTIONS), note: '基线只存语义（动作矩阵 / 排序 id 序列 / 深链落点 / 搜索命中 id / 导航计算样式），不含列表 DOM 形状；夹具读自 C3a-0 models.json（脱敏）；任务种子见 TASK_SEEDS。' };
  } finally {
    await browser.close();
  }
  return out;
}

/** escapeHtml 引号注入实证：单独库副本里把 #55 的 table_comment 改成含 `" data-xss="1`，打开目录页检查带 title 的元素是否出现 data-xss 属性。只打印，不进 baseline */
async function mainEscapeProbe(dbPath) {
  const { chromium } = require('playwright');
  const secret = testEnv.env().jwtSecret;
  const PAYLOAD = 'XSS探针" data-xss="1';
  await assertServing();
  await prepareDb(dbPath, { mutateComment: { id: 55, comment: PAYLOAD } });
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: TIMEZONE });
    await ctx.clock.setFixedTime(new Date(FIXED_ISO));
    const tok = tokenFor(secret, USERS[0]);
    await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify({ display_name: u })); } catch (e) { /* ignore */ } }, [tok, USERS[0].display_name]);
    await ctx.addInitScript(INIT_SCRIPT);
    const { page } = await openPage(ctx);
    const r = await page.evaluate(() => {
      const row = document.querySelector('#modelListBody [data-id="55"]');
      const hits = Array.from(row ? row.querySelectorAll('[data-xss]') : []).map(el => ({ tag: el.tagName.toLowerCase(), cls: el.className, outer: el.outerHTML.slice(0, 200), dataXss: el.getAttribute('data-xss') }));
      const titled = Array.from(row ? row.querySelectorAll('.model-open-btn[title]') : []).map(el => el.outerHTML.slice(0, 200));
      return { rowFound: !!row, hits, titled, anyInPage: document.querySelectorAll('[data-xss]').length };
    });
    console.log(JSON.stringify({ payload: PAYLOAD, selector: '#modelListBody [data-id="55"] .model-open-btn[title]', result: r.hits.length ? '出现' : '未出现', ...r }, null, 1));
    await page.close();
  } finally { await browser.close(); }
}

/**
 * 设计说明点击型存储 XSS 实证（C4c-2 §4.0，派单 Q8 / 主会话裁定 4）：单独库副本里给 DIM #50 与伴生 #53 写 design_notes = `<img src=x onerror=…>`，
 * admin 打开目录页、点该行设计说明入口，读 window.__xss 与气泡里是否出现 img 节点。只打印，不进 baseline。
 *   页面形态按是否存在 [data-entry="design-notes"] 判定：HEAD 形态点 button[title="查看设计说明"]，data-entry 形态点 button[data-entry="design-notes"]。
 *   HEAD 形态只打印；data-entry 形态下「执行：是」→ 退出码 1（修复后的页面不得执行）。
 */
async function mainDesignNotesXssProbe(dbPath) {
  const { chromium } = require('playwright');
  const secret = testEnv.env().jwtSecret;
  const PAYLOAD = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
  const TARGETS = [50, 53];   // DIM #50（主模型）与 #53（变更追踪伴生）
  await assertServing();
  await prepareDb(dbPath, { mutateRows: { 50: { design_notes: PAYLOAD }, 53: { design_notes: PAYLOAD } } });
  const browser = await chromium.launch({ headless: true });
  let executed = false, form = '(未知)';
  const rowsOut = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: TIMEZONE });
    await ctx.clock.setFixedTime(new Date(FIXED_ISO));
    const tok = tokenFor(secret, USERS[0]);
    await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify({ display_name: u })); } catch (e) { /* ignore */ } }, [tok, USERS[0].display_name]);
    await ctx.addInitScript(INIT_SCRIPT);
    for (const id of TARGETS) {
      const page = await ctx.newPage();
      const tr = track(page);
      try {
        try { await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' }); } catch (e) { if (!isNavError(e)) throw e; }
        await page.waitForFunction(() => !!document.querySelector('#modelListBody [data-id]'), null, { timeout: SETTLE_LIMIT_MS });
        // 目标行在第 1 页：#50 / #53 都在默认序前 23 个里（DEFAULT_ORDER_HAND），必要时翻页
        const pf = await page.evaluate(() => ({ dataEntry: !!document.querySelector('#modelListBody [data-entry="design-notes"]') }));
        form = pf.dataEntry ? 'data-entry' : 'HEAD';
        const sel = pf.dataEntry ? `#modelListBody [data-id="${id}"] button[data-entry="design-notes"]` : `#modelListBody tr[data-id="${id}"] button[title="查看设计说明"]`;
        if (!(await page.locator(sel).count())) throw new Error(`第 1 页上找不到 #${id} 的设计说明入口（${sel}）`);
        await page.locator(sel).first().click();
        await page.waitForSelector('#designNotesPopover', { timeout: SETTLE_LIMIT_MS });
        await page.waitForFunction(() => window.__xss > 0, null, { timeout: 1500 }).catch(() => {});   // img onerror 是异步触发；执行了会立刻置位，没执行则等满 1.5s 后读数
        const r = await page.evaluate(() => { const p = document.getElementById('designNotesPopover'); return { xss: window.__xss === undefined ? 0 : window.__xss, popoverImg: p ? p.querySelectorAll('img').length : -1, popoverText: p ? p.textContent.slice(0, 120) : null }; });
        rowsOut.push({ id, ...r });
        if (r.xss > 0 || r.popoverImg > 0) executed = true;
      } finally { await page.close(); }
    }
    console.log(JSON.stringify({ payload: PAYLOAD, 页面形态: form, rows: rowsOut, 执行: executed ? '是' : '否' }, null, 1));
    console.log(`页面形态：${form}`);
    console.log(`执行：${executed ? '是' : '否'}`);
  } finally { await browser.close(); }
  return form === 'data-entry' && executed ? 1 : 0;
}

/** 点击探针覆盖统计（写进 MANIFEST.counts，报告用）：可用格 = 带 call 的 present 格；置灰格 = inert 格 */
function callCounts(cur) {
  const c = { matrixCallCells: 0, matrixInertCells: 0, matrixDeadCells: 0, rowExtrasCallCells: 0, rowExtrasInertCells: 0, rowExtrasDeadCells: 0 };
  for (const [sec, ck, ik, dk] of [['matrix', 'matrixCallCells', 'matrixInertCells', 'matrixDeadCells'], ['rowExtras', 'rowExtrasCallCells', 'rowExtrasInertCells', 'rowExtrasDeadCells']]) {
    for (const role of Object.keys(cur[sec])) for (const id of Object.keys(cur[sec][role])) for (const k of Object.keys(cur[sec][role][id])) { const x = cur[sec][role][id][k]; if (x.call) c[ck]++; if (x.inert) c[ik]++; if (x.dead) c[dk]++; }
  }
  return c;
}
/**
 * --self-test-probe（H2 自证，在隔离实例上跑，C4c-2 起读法 = dataact）：对真实页面做注入，点击读法必须在对应环节失败，对照组必须通过。
 *   对照（不注入）→ 通过；catalogToggleMenu 换空函数 →「菜单没打开」；#50 的 ⋯ 触发按钮删掉 →「结构缺失」；菜单项样式强制隐藏 →「菜单项不可见」；
 *   catalogCloseMenus 换空函数 →「菜单未关闭」；去掉 capture 阶段的 keydown 监听（Esc）→「Esc 后菜单未关闭」；
 *   结构检查（静态节点 / 全局）：getSortedModels / getCatalogView 赋成 undefined、排序按钮全部移除 → 「目录页结构或全局已改」。
 */
async function mainSelfTestProbe(dbPath) {
  if (READING !== 'dataact') { console.error('--self-test-probe 自 C4c-2 起只支持 dataact 读法（旧读法只对 HEAD 有效）'); process.exit(2); }
  const { chromium } = require('playwright');
  const secret = testEnv.env().jwtSecret;
  await assertServing();
  await prepareDb(dbPath);
  const browser = await chromium.launch({ headless: true });
  let bad = 0, n = 0;
  const check = (label, cond, extra) => { n++; if (!cond) { bad++; console.log('  FAIL ' + label + (extra ? '：' + extra : '')); } else console.log('  ok   ' + label + (extra ? '：' + extra : '')); };
  try {
    const mkCtx = async (initScript) => {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: TIMEZONE });
      await ctx.clock.setFixedTime(new Date(FIXED_ISO));
      const tok = tokenFor(secret, USERS[0]);
      await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify({ display_name: u })); } catch (e) { /* ignore */ } }, [tok, USERS[0].display_name]);
      await ctx.addInitScript(INIT_SCRIPT);
      if (initScript) await ctx.addInitScript(initScript);
      await ctx.route('**/api/warehouse/describe-table*', async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); });
      await ctx.route('**/api/models/*/save-scripts', async (route) => { await route.fulfill({ status: 200, contentType: 'application/json', body: '{"savedFiles":[],"configRevBumped":false}' }); });
      return ctx;
    };
    const ctx = await mkCtx();
    const run = async (label, inject, re, useCtx) => {
      const { page, tr } = await openPage(useCtx || ctx);
      if (inject) await page.evaluate(inject);
      let err = null;
      try { await readRowsFromDataAct(page, tr, [50]); } catch (e) { err = e; }
      const msg = err ? String(err.message).split('\n')[0] : '';
      if (re) check(label + '：必须失败', !!err && re.test(msg), err ? msg : '未失败（假绿）');
      else check(label + '：必须通过', !err, err ? msg : '');
      await page.close();
    };
    // H1 结构检查：运行时注入（不改页面文件）；开读前先跑静态结构检查，必须以「目录页结构或全局已改」失败（不是超时）
    const runStruct = async (label, inject, re) => {
      const { page } = await openPage(ctx);
      if (inject) await page.evaluate(inject);
      let err = null;
      try { await assertCatalogStructure(page, { phase: 'static' }); await assertCatalogStructure(page, { phase: 'ready' }); } catch (e) { err = e; }
      const msg = err ? String(err.message).split('\n')[0] : '';
      if (re) check(label + '：必须失败', !!err && re.test(msg), err ? msg : '未失败（假绿）');
      else check(label + '：必须通过', !err, err ? msg : '');
      await page.close();
    };
    await runStruct('H1 对照（不注入）', null, null);
    await runStruct('H1 getSortedModels 赋成 undefined', () => { window.getSortedModels = undefined; }, /目录页结构或全局已改，按 C4c DOM 契约（驱动头部）核对页面后再比较：缺 函数 getSortedModels/);
    await runStruct('H1 getCatalogView 赋成 undefined', () => { window.getCatalogView = undefined; }, /目录页结构或全局已改，按 C4c DOM 契约（驱动头部）核对页面后再比较：缺 函数 getCatalogView/);
    await runStruct('H1 删掉全部 button[data-sort-by]', () => { document.querySelectorAll('button[data-sort-by]').forEach(e => e.remove()); }, /目录页结构或全局已改，按 C4c DOM 契约（驱动头部）核对页面后再比较：缺 button\[data-sort-by\] 恰为 8 个键/);
    await run('对照（不注入）', null, null);
    await run('catalogToggleMenu 换成空函数（⋯ / 验收菜单打不开）', () => { window.catalogToggleMenu = function () {}; }, /菜单没打开/);
    await run('行 #50 的 ⋯ 触发按钮删掉', () => { const o = window.renderModelsPage; window.renderModelsPage = function () { o.apply(this, arguments); const b = document.querySelector('#modelListBody [data-id="50"] [data-menu="more"]'); if (b) b.remove(); }; }, /结构缺失/);
    await run('菜单项被样式强制隐藏（菜单能开、项没尺寸）', () => { const st = document.createElement('style'); st.textContent = '.catalog-menu-item { display: none !important; }'; document.head.appendChild(st); }, /菜单项不可见/);
    await run('catalogCloseMenus 换成空函数（菜单关不掉）', () => { window.catalogCloseMenus = function () {}; }, /菜单未关闭/);
    // 去掉 Esc 监听：页面把 capture 阶段的 keydown 监听注册在 document 上，运行时拿不到引用——在页面脚本执行之前包住 addEventListener，丢弃 capture 阶段的 keydown 注册
    const ctxNoEsc = await mkCtx(() => { const o = EventTarget.prototype.addEventListener; EventTarget.prototype.addEventListener = function (t, f, opt) { if (t === 'keydown' && (opt === true || (opt && opt.capture))) return; return o.call(this, t, f, opt); }; });
    await run('去掉 capture 阶段的 keydown 监听（Esc 不再关菜单）', null, /Esc 后菜单未关闭/, ctxNoEsc);
    await ctxNoEsc.close();
  } finally { await browser.close(); }
  console.log(`[self-test-probe] ${n - bad}/${n} 通过`);
  return bad ? 1 : 0;
}

function writeOutputs(cur) {
  const dir = OUT_DIR_ARG ? path.resolve(OUT_DIR_ARG) : FIX_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const bf = path.join(dir, 'baseline.json');
  fs.writeFileSync(bf, JSON.stringify(cur, null, 1) + '\n');
  const man = {
    schema: 1,
    note: 'baseline.json 的完整性登记 + 录制守卫依据：Model_Center.html 的 SHA-256（LF 规范化）与此处不同则拒绝重录；baseline.json 不得手改（比较模式会校验其哈希）。',
    modelCenterSha256Lf: sha256Lf(MC_HTML),
    modelsFixtureSha256Lf: sha256Lf(MODELS_FILE),
    baselineSha256Lf: sha256Lf(bf),
    counts: { roles: ROLES.length, models: MODEL_IDS.length, acts: ACTS.length, matrixCells: ROLES.length * MODEL_IDS.length * ACTS.length, rowExtrasCells: ROLES.length * MODEL_IDS.length * EXTRA_ENTRIES.length, sortKeys: SORT_KEYS.length, renderedSequences: 1 + SORT_KEYS.length * 3, deepLinks: Object.keys(cur.deepLinks).length, keywords: Object.keys(cur.keyword).length, ...callCounts(cur) },
  };
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(man, null, 1) + '\n');
  return { dir, bf, size: fs.statSync(bf).size };
}

/** [#106 S4b2] 原先在模块顶层求值的派生常量（顶层只允许纯声明）：入口函数 ready() 与 initRuntime() 之后调用，顺序与原来的出现顺序一致 */
function initDerived() {
  const withDefaults = (createdById) => (m) => ({ domain: '', tech_owner: '管理员', biz_owner: '', status: 'CREATED', created_at: '2026-01-01 08:00:00', updated_at: '2026-01-02 08:00:00', source_table: null, source_system: null, model_type: 'TABLE', created_by_id: createdById, category: 'general', dim_config: null, is_deleted: 0, config_mode: 'standard', design_notes: null, companion_of: null, ...m });
  CREATOR_MODELS = CREATOR_MODELS_RAW.map(withDefaults(6));
  UPPER_AND_OWNER_MODELS = UPPER_AND_OWNER_MODELS_RAW.map(withDefaults(1));
  PROBE_NAMES = [...Object.keys(HANDLER_TO_ACT), ...Object.keys(EXTRA_HANDLER), 'openModelDrawer', ...TRIGGER_CALLS];
  PROBE_ARG = { names: PROBE_NAMES, normSrc: normArg.toString(), triggers: [...TRIGGER_CALLS] };
  DATAACT_BASELINE_SORT_KEYS = SORT_KEYS.filter(k => DATAACT_SORT_KEYS.includes(k));
  PROBE_NAMES_DATAACT = [...Object.keys(HANDLER_TO_ACT), ...Object.keys(EXTRA_HANDLER), 'openModelDrawer'];
  ALLOWED_CHANGES = buildAllowedChanges();
  initSynthRows();
}

(async () => {
  let code = 1;
  // [#106 S4b2] ready() 是入口函数里第一条有副作用的语句（选项是纯字面量）；之后才解析参数 / 求派生常量。自测模式（--self-test-*）本不需要服务，但按硬规则也先起实例（裁定 D5）。
  //   SIGINT / SIGTERM 由 test-env 自己收实例（teardown 后以 130 / 143 退出），进程退出时的清理由它的 exit 钩子兜底。
  await testEnv.ready({ extraEnv: { SYS_FASTLANE_ENABLE: '0', LOG_LEVEL: 'INFO' } });
  initRuntime();
  initDerived();
  process.on('uncaughtException', (e) => { console.error(e && e.stack || e); process.exit(1); });
  process.on('unhandledRejection', (e) => { console.error(e && e.stack || e); process.exit(1); });
  if (ARGS.includes('--self-test-compare')) { const c = selfTestCompare(); await testEnv.teardown(); testEnv.finish(c); return; }
  if (ARGS.includes('--self-test-mapping')) { const c = await selfTestMapping(); await testEnv.teardown(); testEnv.finish(c); return; }
  if (ARGS.includes('--self-test-settle')) { const c = await selfTestSettle(); await testEnv.teardown(); testEnv.finish(c); return; }
  if (ARGS.includes('--self-test-dataact')) { const c = await selfTestDataAct(); await testEnv.teardown(); testEnv.finish(c); return; }
  const dbPath = testEnv.env().dbPath;
  try {
    if (ARGS.includes('--escape-probe')) { await mainEscapeProbe(dbPath); code = 0; } else if (ARGS.includes('--design-notes-xss-probe')) { code = await mainDesignNotesXssProbe(dbPath); } else if (ARGS.includes('--self-test-probe')) { code = await mainSelfTestProbe(dbPath); } else {
      if (!RECORD) { if (!fs.existsSync(BASELINE_FILE)) throw new Error('缺少基线文件，请先在 HEAD 上 --record'); checkManifestIntegrity(); }
      const cur = await mainRecordOrCompare(dbPath);
      if (process.env.MC_DUMP) fs.writeFileSync(process.env.MC_DUMP, JSON.stringify(cur, null, 1));
      if (RECORD) {
        const w = writeOutputs(cur);
        console.log(`[record] 基线已写入 ${w.dir}（baseline.json ${w.size} 字节，含 MANIFEST.json）`);
        code = 0;
      } else {
        const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
        const { real, allowed, hitKeys } = compareBaselines(base, JSON.parse(JSON.stringify(cur)));
        allowed.forEach(a => console.log('  允许差异 ' + a));
        real.forEach(d => console.log('  ✗ 差异 ' + d));
        console.log(`[baseline] 与基线比较：不允许的差异 ${real.length}，已登记的允许差异 ${allowed.length}`);
        code = real.length ? 1 : 0;
        if (ALLOW_CHANGES) {   // L4：登记是「允许」不是「要求」——比较时每条登记规则必须至少命中一次（与读法无关，预筛 M4）（页面退回按行排序时序列与基线相同，没有差异可命中，这里判红）
          const miss = [];
          let total = 0;
          for (const a of ALLOWED_CHANGES) for (const r of a.rules) { total++; if (!hitKeys.has(a.id + '|' + new RegExp('^(?:' + r.pathRe + ')$').source)) miss.push(a.id + ' ' + r.pathRe); }
          console.log(`[登记命中] ALLOWED_CHANGES 每条规则至少命中一次：${total - miss.length}/${total}`);
          if (miss.length) { miss.forEach(m => console.log('  ✗ 登记规则未被任何差异命中：' + m)); code = 1; }
        }
      }
    }
  } catch (e) {
    console.error(e && e.stack || e);
    code = 1;
  } finally {
    await testEnv.teardown();
  }
  // [#106 S4b2a] teardown 已在上面的 finally 里 await 落定；出口改 finish（只设退出码，不终止执行），它是入口函数的最后一条语句。入口 .catch 里的 process.exit(1) 不改。
  testEnv.finish(code);
})().catch(async (e) => {
  console.error(e && e.stack || e);
  try { await testEnv.teardown(); } catch (_) { /* 尽力收实例 */ }
  process.exit(1);
});
