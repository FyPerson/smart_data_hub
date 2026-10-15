/**
 * 共享 CSS 缓存串守卫（2026-08-12 新增·codex 352 号收口）
 *
 * 缺口来源（本次真实踩坑，不是假想）：给状态色板加第 14 层（「待上线」徽章青→橙）改了共享的
 *   `components.css`，**但没 bump 11 个页面的 `?v=` 缓存串**。后果是：
 *     · 全部静态守卫绿——它们读的是磁盘文件；
 *     · Playwright 实测也绿——每次跑都是全新 browser context，不吃缓存，拿到的就是新 CSS；
 *     · **唯独真实用户**打开页面看到的还是旧的青色，当场反馈"这个状态的样式好像还没做"。
 *   项目本有这条规矩（改共享静态资源必 bump 缓存串），且给**共享 JS** 配了运行时版本比对
 *   （u-paste.js / model-detail-normalize.js 的 KIT_VERSION 不一致就 console.error）；
 *   但 CSS 里没有可执行代码，运行时自证那条路走不通 —— 只能静态守，就是本脚本。
 *
 * 三条判据（缺一都能假绿）：
 *   ① **覆盖面**：登记的页面清单与实际引用页**双向相等**（少一页 = 那页用户拿旧 CSS；多一页 = 清单腐化）。
 *      刻意不用 `>= N` 这类宽松阈值——某页写法没被解析到时它会从集合里消失，剩下的页仍然"一致"，
 *      守卫照样绿（codex 352 号 HIGH）。
 *   ② **串一致**：清单内每页的 `?v=` 完全相同且等于登记版本。
 *   ③ **内容指纹**：资源文件 sha256 等于登记值。改了内容没更新登记 → 红，逼你在同一次改动里
 *      bump 串 + 更新登记。
 *   ④ **git 联动（可用时才跑）**：`components.css` 相对 HEAD 有改动时，引用页与本脚本必须出现在
 *      同一批改动里——这是唯一能真正**强制** bump 的判据（判据③只能强制"更新登记"，一个人若只改
 *      SHA 常量而不 bump 串，③ 仍然会绿·codex 352 号 MED）。git 不可用时跳过并显式说明，不假装通过。
 *
 * ⚠️ HTML 自身缓存这条链路已核实无隐患：server.js `express.static` 对 `.html` 显式设
 *   `Cache-Control: no-cache`（协商缓存 + ETag，命中 304），静态资源默认 maxAge 7d。
 *   即用户刷新必然拿到最新 HTML，进而请求到新的 `?v=`。若将来有人改掉那段 setHeaders，本守卫的
 *   整个前提就没了 —— 那里已与本文件互相点名。
 *
 * ⚠️ 维护提示：改完共享 CSS 跑一次本脚本，失败信息会打印实际指纹，照着更新对应资源的
 *   version / sha256 / log 三处，并把页面 `?v=` 一起换掉。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ── 登记表（改共享 CSS 时更新对应条目）────────────────────────────
const ASSETS = [
    {
        rel: 'assets/css/components.css',
        version: 'v1.153.0_fastlanetier15',
        sha256: '81dd4ef8f68a0d82e840cd543bfea1c9ed34fa624fb792d4f104761eb4a5e94d',
        // 期望引用页**显式清单**（双向对拍，新增/下线页面必须显式改这里）
        pages: [
            'IT_Ledger.html', // C7 新页面，加入双向覆盖；共享 CSS 未改变。
            'Data_Collab.html', 'Data_Correction.html', 'Issue_Lite.html', 'Issue_Tracker.html',
            'Legacy_Archive.html',   // 2026-08-27 补登记：Phase A cherry-pick 上主干时新增页漏登记（守卫双向对拍抓出）
            'Model_Center.html', 'Model_Workbench.html', 'My_Workspace.html', 'Periodic_Fetch.html', 'Quick_Log.html',   // Model_Workbench：#77 C3b 配置台新页
            'Statistics.html', 'Sys_Iteration.html', 'Task_Pool.html',
        ],
        log: [
            ['v1.142.0_notify1', '通知按钮与文本统一（前代登记，本守卫建立前）'],
            ['v1.152.0_prereleasetier1', '状态色板新增第 14 层 sem-prerelease（「待上线」青→橙）+ 两个待上线 flag 的 si-flag 修饰类。串名用 prereleasetier 而非 prerelease，避免被读成"预发布版本"（codex 352 号 LOW）'],
            ['v1.153.0_fastlanetier15', '状态色板新增第 15 层 sem-fastlane（先行上线两步化 S7·「待先行部署 x/N」徽章·靛紫色相，与第 14 层 prerelease 橙区分）。串名用 fastlanetier15 呼应既有 prereleasetier 命名习惯'],
        ],
    },
    {
        // #77 C3a L4：共享 JS 资源同样登记（kind: 'script'）。内容指纹按 LF 规范化后的字节算（工作区 CRLF / 仓库 LF 都一致）；
        //   改库内容不更新这里的 sha256 → 判红；只改 sha256 不 bump 页面 ?v= → 由 ②（串一致且等于登记值）与 ④（git 联动）卡住。
        //   ?v= 后缀必须等于库内 KIT_VERSION，由 verify-model-script-gen-single-source.js 校验。
        rel: 'assets/js/model-script-gen.js',
        kind: 'script',
        normalizeEol: true,
        version: 'v1.180.0_msg1',
        sha256: '366ea2f5acd7903b824649f8b316e6e2c51aae2fa0906f73a9cb44cae0ada8f4',
        pages: ['Model_Center.html', 'Model_Workbench.html'],   // C3b：配置台新页同引一份库、同一 ?v=
        log: [['v1.180.0_msg1', '#77 C3a：脚本生成器自 Model_Center.html 内联抽出为共享库（首次登记；函数体零改写）']],
    },
    {
        // #77 C4a：目录列表代码（经典脚本，顶层名与页面内联共享全局环境）。只由 Model_Center.html 引用（配置台页上 typeof currentPage 必须不存在）。
        rel: 'assets/js/model-catalog.js',
        kind: 'script',
        normalizeEol: true,
        version: 'v1.180.0_mcat17',
        sha256: 'd89f2ff7ced778685424f8029318795879c9505b65b89e247edde4076fabaf00',
        pages: ['Model_Center.html'],
        log: [['v1.180.0_mcat1', '#77 C4a：目录列表代码自 Model_Center.html 内联逐字抽出（首次登记；P22 权限判断改为调用页内同源函数）'], ['v1.180.0_mcat2', '#77 C4a 修复批：只改文件头注释（⑦ 守的口径描述对齐：解构名 / class 名同口径），代码零改动'], ['v1.180.0_mcat3', '#77 C4b：删除已搬进核心的排序常量 / 函数，目录列表改调 ModelCatalogCore（按组分页、前端搜索、重载保留页码、D-7 关闭钩子、高亮 3 秒）；新增 getCatalogView 等全局名'], ['v1.180.0_mcat4', '#77 C4b-2 预筛修复：D-7 在途写请求计数（catalogTrackWrite / 关闭钩子待重载 / 写入结束时无弹窗直接重载）、focus 经核心事件、highlightModel 用全量视图定位、getCatalogView 语义冻结、重载与回退的 loadModels 接 catch'], ['v1.180.0_mcat5', '#77 C4b-2 codex 36-R：重载统一不变量（有标记、无在途、没有带钩子的弹窗开着才重载；关闭钩子与写请求结束共用 reloadCatalogIfStale；删除 catalogOnWriteSettled / catalogReloadPending）、loadModels 失败返回 false 且 catalogReload 失败恢复标记'], ['v1.180.0_mcat6', '#77 C4b-2 codex 36-R2：D-7 改「代次推导」——删可变陈旧标记 / markCatalogStale / catalogReload，新增 catalogWritesDone / catalogListSeen / catalogListReqSeen / catalogListReqSeq 与 catalogIsStale()（过期 ⇔ catalogListSeen < catalogWritesDone）；loadModels 发出时记 seen / reqId，成功才推进 catalogListSeen，finally 仅最新请求清在途记录'], ['v1.180.0_mcat7', '#77 C4c-0b：版本握手 —— catalogCheckCoreVersion 的比较字面量与报错文案 mcc1 → mcc2，随核心 CORE_VERSION 升级；其余代码零改动'], ['v1.180.0_mcat8', '#77 C4c-2：行结构改为 DOM 构建 + 事件委托（data-act / data-entry）、⋯ 菜单与验收菜单、双行卡片、状态徽章、最近验收七态、业务域映射、排序按钮 8 键（button[data-sort-by]）、高亮改 data-focus-highlight 属性；删除旧下拉函数与行内迭代徽章；设计说明气泡内容在分发处转义（修点击型存储 XSS）；2c 修复（同一未提交版本，不再 bump）：设计说明分发先撤掉上一个气泡留下的「点别处关闭」once 监听（修二次打开回归）、业务域映射注释如实写停用域显示代码（P31）、头部关于 data 属性的说法如实改写'], ['v1.180.0_mcat9', '#77 C4c-2 收口修复批（codex 39）：catalogCall 先检查全局名是 function（否则 console.error 并返回 undefined，不抛 TypeError）；catalogDispatchAct 的 ddl / etl / view-config 按层级闭合（ddl：ODS / DIM / DWD；etl：DIM / DWD；view-config：伴生 → DWD 只读，非伴生 DIM → DIM，非伴生 DWD → DWD；其他层级不调用）'], ['v1.180.0_mcat10', '#77 C4c-3 子批 3a：展开区——条目首行最前加展开按钮（button[data-expand-toggle]，伴生与 viewer 也有）、条目内第二行之后的 pane 面板（loading / error 带重试 / loaded 上游 → 本模型 → 下游 + 实现对象表与三种空态，数据只经 textContent / title 写入）、面板里的模型链接（button[data-open-model]）、排序条里的「全部收起」；展开 / 重试 / 关系请求全部经核心 toggleExpand / retryExpand / relationsArrived（迟到响应丢弃），renderModelsPage 只给「展开集合 ∩ 当前页」建面板；loadModels 成功后把 listArrived 的 fetch-relations effect 逐个发出（仅此一行，D-7 逻辑不动）；data 属性白名单新增 expand-toggle / pane-act / catalog-act / open-model；子批 3b（同一未提交版本，不再 bump）：loadModels 返回 arrived / discarded / failed，失败（非 2xx、响应不是数组、网络错误 / 非 JSON）经 catalogFailList 调核心 listFailed（在途展开变为可重试、旧数据保留）并显示 #catalogListNotice 的「列表刷新失败，显示的是上次数据 / 列表加载失败」+ 重试按钮（button[data-catalog-act=retry-list]，不弹 toast、不自动重试）；data-catalog-state 改为只在列表数据至少成功套用过一次后设 ready、失败设 error（catalogSyncListState 为唯一写入点）；上游名链接匹配与后端 asciiLower 同口径（仅 ASCII 字母不区分大小写，归一化后命中恰一行才成链接）；D-7 代次推导逻辑一字未动；子批 3c（同一未提交版本，不再 bump）：loadModels 的 catch 转失败前在控制台记一条 warn（覆盖网络错误 / 非 JSON / 核心事件抛出的程序错误）；空态「暂无模型数据」只在列表数据至少成功套用过一次之后显示（从未成功时留空，失败由提示说明）；D-7 注释补「重试按钮直接 loadModels()、绕过 reloadCatalogIfStale 去重」（逻辑不动）'], ['v1.180.0_mcat11', '#77 C4c-3 codex 40 收口（3d；C4c-3 已提交为 7453420d，提交后再改 CAT 必须 bump）：/relations 响应逐项形状校验（下游 / 上游 / 实现对象的展示字段按服务端真实形状校验，任一元素不合格整体判加载失败，不再 filter 静默丢弃）、catalogRunEffects 发起的关系请求 promise 加 .catch；loadModels 一字未动'], ['v1.180.0_mcat12', '#77 C4c-4（4a）：页头在册数 catalogUpdateTotal、筛选单一来源 catalogFilters / catalogAdoptFilters、P36 的 applyCatalogSearch 旧词改取 catalogRenderedQuery、版本握手 mcc3、工具条文案；子批 4b（同一未提交版本，不再 bump）：左栏 catalogRenderRail（视图 / 分层 / 状态 / 业务域四组计数取 railCounts、点击经核心 setFilter 同组单选、再点取消、清除 N 项、选中值消失仍可取消、业务域名称映射、未归属对象置底虚线框）；子批 4c（同一未提交版本，不再 bump）：未归属对象——左栏入口按钮、初始化与重试时 GET /api/model-impl-objects?unowned=1（请求序号丢弃迟到响应）、未归属模式在列表区就地替换为只读对象表（返回恢复进入前的状态、点筛选先退出、失败显示加载失败加重试且不弹 toast）、徽章格 catalogObjBadgeKids 与展开区共用；子批 4d（同一未提交版本，不再 bump）：输入法组字标记 catalogComposing（组字期间不更新当前画面所用的词）、?focus= 先退出未归属模式、未归属面板 ok 态的刷新按钮、左栏重画改按键就地更新 catalogRailReconcile（修 mousedown 与 mouseup 之间重画丢点击）'], ['v1.180.0_mcat13', '#77 C4c-4 codex 41 收口（C4c-4 已提交为 12f093e1，提交后再改 CAT 必须 bump）：未归属面板 catalogRenderUnowned 改就地更新（catalogRailReconcile；返回按钮等节点不再随请求开始 / 完成被换掉，修 mousedown 与 mouseup 之间重画吞返回点击与丢焦点）、catalogRailPatch 纯文字叶子换成有子元素时先清旧文字、catalogRenderRail 对齐后归还焦点（reconcile 搬动有焦点的按钮会失焦）、未归属表类型列走 catalogOrDash'], ['v1.180.0_mcat14', '#77 C4d-a 窄屏两档断点（C4c-4 已提交为 c1c283e7，提交后再改 CAT 必须 bump；整个 C4d 只 bump 这一次）：左栏新增 ≤640px 折叠按钮 catalogRailOpen / catalogToggleRail（默认收起，不持久化）、左栏各区块加 id、首行状态格加 catalog-status 类、第二行最前新增 ≤640 才显示的 catalog-mobile-meta（状态徽章 catalogBuildStatusBadge、最近验收 catalogBuildAcceptance 的 rootClass、负责人）；C4d-b（同一未提交版本，不再 bump）：列表组包装与空态加 role=listitem、焦点移出菜单关闭 catalogOnFocusIn（document focusin）、catalogRailClear 后焦点移到「全部模型」（P40）、highlightModel 开头退出未归属模式；C4d 预筛修复批（同一未提交版本，不再 bump）：最近验收摘要拆成 catalogAcceptanceViewOf（算结果）与 catalogBuildAcceptance(v, rootClass)（建节点），一个条目只算一次；状态格 / 状态徽章 / 负责人格补 title；catalogLeaveUnowned 在左栏入口不可见时把焦点回退到折叠按钮'], ['v1.180.0_mcat15', '#77 C4d fix42b 收口（C4d 已提交为 9a34ad40，提交后再改 CAT 必须 bump）：第二行元数据容器里的状态徽章包进页面包装层 span.catalog-status-m（徽章仍只由 catalogBuildStatusBadge 构建；窄屏长状态值的收缩约束写在包装层上，不再用结构选择器改共享层徽章）；业务域格 span.catalog-domain 补 title = 完整显示文字（新增 catalogDomainTitle；首次渲染 catalogBuildEntry 与映射到达后就地改写 catalogApplyDomainNames 两处同口径，空值「未设置」不加 title）'], ['v1.180.0_mcat16', '#77 C4e-a 配色 E（C4d 已提交为 465f7d18，提交后再改 CAT 必须 bump，整个 C4e 只 bump 这一次）：renderPagination 的当前页按钮底色 / 边框由行内字面量 #d97706 改为 var(--color-accent)（取 Model_Center.html 作用域 token）；其余分页灰系与设计说明气泡不变；C4e 预筛修复批只改文件头注释（设计说明气泡注释如实化），版本不变、sha256 随之更新'], ['v1.180.0_mcat17', '#77 C5 修复批 2（C4e 已提交为 2330460d / 7ef5cfe1，提交后再改 CAT 必须 bump）：catalogTrackWrite 的 finally 在 catalogWritesDone++ 与 reloadCatalogIfStale() 之后向 document 派发 modelcatalog:write-settled（每个写请求结束、成败都算，派发一次），供抽屉在写结束的因果时点判定重载；CAT 其他任何地方零改动']],
    },
    {
        // #77 C4b：目录列表纯函数核心（UMD，window.ModelCatalogCore）。只由 Model_Center.html 引用；?v= 后缀必须等于核心内 CORE_VERSION（由 verify-model-catalog-core.js 接线节校验，不写死）。
        rel: 'assets/js/model-catalog-core.js',
        kind: 'script',
        normalizeEol: true,
        version: 'v1.180.0_mcc3',
        sha256: '908ba071b313a55dec872214090aaac377669951a2ac3f0c52d4b39ee2a4ff74',
        pages: ['Model_Center.html'],
        log: [['v1.180.0_mcc1', '#77 C4b：目录列表纯函数核心首次登记（分组 / 命中 / 排序 / 分页 / 事件顺序；CORE_VERSION mcc1）'], ['v1.180.0_mcc2', '#77 C4c-0：核心扩展（排序键 acceptance_at / domain、筛选键 view / status / domain、railCounts、listFailed、显示映射；CORE_VERSION mcc2）'], ['v1.180.0_mcc3', '#77 C4c-4（4a）：P36——setQuery 搜索词 trim 后不变、gotoPage 翻到当前页都原样返回（不回第 1 页、不收起展开、不作废令牌）；CORE_VERSION mcc3']],
    },
    {
        // #77 C6a：app.js 纳入登记（16 页共享的经典脚本）。此前没有守卫：#77 分支上动过 app.js 的提交有 3 个——6fdca766（C1a 前端 G3，+38 / −18）、
        //   fae946e4（缓存串 mc77c1a3）、28986d26（缓存串 mc77c1a4；其中 app.js 的 7 增 / 3 删是 C1 对抗审 F4）。16 页的 ?v= 由人工随之统一换成 mc77c1a4，
        //   本条把「内容变了 → 16 页串必须同批 bump」变成可执行判据。
        //   kind:'script' + normalizeEol：判据 ①②③④⑥ 对它同样生效（指纹按 LF 规范化后算，工作区 CRLF / 仓库 LF 一致）。
        rel: 'assets/js/app.js',
        kind: 'script',
        normalizeEol: true,
        version: 'v1.180.0_mc77c1a4',
        sha256: '8510d20bd43e0dd0466be465fec8e994028070469697491b0f603eafb47ef9d8',
        pages: [
            'Asset_Center.html', 'Dashboard.html', 'Data_Collab.html', 'Data_Correction.html', 'IT_Ledger.html',
            'Issue_Lite.html', 'Issue_Tracker.html', 'Legacy_Archive.html',
            'Model_Center.html', 'Model_Workbench.html',   // Model_Workbench：#77 C3b 配置台新页，同引 app.js、同一 ?v=
            'My_Workspace.html', 'Periodic_Fetch.html', 'Quick_Log.html', 'Statistics.html', 'Sys_Iteration.html', 'Task_Pool.html',
        ],
        log: [
            ['v1.159.0_debta4', '主干现状（#77 C6a 首次登记前的最后一个人工 bump；之后到 mc77c1a4 之前没有守卫）'],
            ['v1.180.0_mc77c1a4', '#77 C1a（6fdca766，方案 v0.9 §4.1.2 前端 G3）：任务卡验收状态条 fillDoneCardValidationStatus 与提交前验收提示 confirmSubmit2 改以后端 state / gatePass 为准（stale / warn / companion 三态，pass 与 warn 同算通过，DIM 不再要求语义验收）；缓存串 mc77c1a3（fae946e4）→ mc77c1a4（28986d26）：C1 对抗审 F4，任务卡展示分支优先按后端返回的模型分层 layer 判断、缺失时才按任务类别 category，放行仍只看 gatePass；C6a 首次登记，内容未再改'],
        ],
    },
    {
        // #77 C6a：model-detail-normalize.js 纳入登记（只由 Model_Center.html 引用）。?v= 后缀 mdc4 = 库内 KIT_VERSION，运行时另有 mdcCheckKitVersion 比对。
        //   分支上相对主干只改了一处注释（#77 C3a：说明 generateDimETLFromConfig 已随页面内联脚本删除），KIT_VERSION 与行为不变，所以串仍是 mdc4——
        //   以后改库内容（含注释）都会让指纹判红，逼着在同批里决定 bump 与否并更新本登记。
        rel: 'assets/js/model-detail-normalize.js',
        kind: 'script',
        normalizeEol: true,
        version: 'v1.125.0_mdc4',
        sha256: 'd5b536575f07d9f529e4e4699f590cf528366a2fda1055075bdb70b08c1518d9',
        pages: ['Model_Center.html'],
        log: [['v1.125.0_mdc4', '存量登记（#77 C6a 首次纳入守卫）：KIT_VERSION = mdc4；分支上仅一处注释变更（#77 C3a），按「注释变更不改行为」不 bump，指纹登记的是含该注释的当前内容']],
    },
    {
        rel: 'assets/css/style.css',
        version: 'v1.141.0_badge2',
        sha256: '6b4055aed8e9ed4f3711ff5a6d3b04914ffa81581f4556ad31a880ab96471a1c',
        // 本次未改 style.css，登记现状即可——它同为多页共享 CSS，同样的忘 bump 会同样出事
        //   （codex 352 号 LOW 建议后续单独守；配置表化后顺手纳入，零额外成本）
        pages: [
            'IT_Ledger.html', // C7 新页面，与 components.css 同步登记。
            'admin.html', 'Asset_Center.html', 'Dashboard.html', 'Data_Collab.html', 'Data_Correction.html',
            'Domain_Manager.html', 'Issue_Lite.html', 'Issue_Tracker.html',
            'Legacy_Archive.html',   // 2026-08-27 补登记：同上（components.css 条目的说明）
            'Metrics.html', 'Model_Center.html', 'Model_Workbench.html',
            'My_Workspace.html', 'Periodic_Fetch.html', 'Quick_Log.html', 'Statistics.html',
            'Sys_Iteration.html', 'Task_Pool.html',
        ],
        log: [['v1.141.0_badge2', '全站状态徽章统一（存量登记，本守卫建立时的现状）']],
    },
];

// 内容指纹：normalizeEol 的资源先把 CRLF 统一成 LF 再算 sha256
const fingerprint = (asset, buf) => crypto.createHash('sha256').update(asset.normalizeEol ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : buf).digest('hex');
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m) => { fail++; console.log(`  [FAIL] ${m}`); };
const must = (cond, m) => (cond ? ok(m) : bad(m));

// 从一个 HTML 里取某资源的 `?v=` 版本。解析走 HTML/URL 语义而不是一条大正则（codex 352 号 MED）：
//   先抓 <link> 标签（大小写不敏感），再取 href（双引号/单引号/裸值三种写法），
//   再用 URL 解析 pathname 与 searchParams —— 这样 `?x=1&v=…`、`?v=…&x=1`、带 #hash 都能正确处理。
// 先剔除 HTML 注释（<!-- <script src=…> --> 这类被注释掉的引用不算）；内联脚本正文里的 `<!--` 字面量不受影响（脚本元素先匹配、整体保留）。
function stripHtmlComments(html) {
    return html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => (m.startsWith('<!--') ? '' : m));
}
function readAssetVersion(html, relPath, kind) {
    const results = [];
    const isScript = kind === 'script';
    const attrRe = isScript ? /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i : /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
    const tags = stripHtmlComments(html).match(isScript ? /<script\b[^>]*>/gi : /<link\b[^>]*>/gi) || [];
    for (const tag of tags) {
        const hm = tag.match(attrRe);
        if (!hm) continue;
        const href = hm[1] !== undefined ? hm[1] : (hm[2] !== undefined ? hm[2] : hm[3]);
        let u;
        try { u = new URL(href, 'http://local/'); } catch (e) { continue; }
        if (!u.pathname.endsWith('/' + relPath) && u.pathname !== '/' + relPath) continue;
        results.push(u.searchParams.get('v') || '(无缓存串)');
    }
    return results;
}

console.log('=== 共享 CSS 缓存串守卫 ===\n');

const allPages = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
must(allPages.length >= 15, `public 下 HTML 页面实抓 ${allPages.length} 个（过少=目录读取异常，扫描面须非空）`);

for (const asset of ASSETS) {
    console.log(`\n--- ${asset.rel} ---`);

    // ① 覆盖面双向对拍：登记清单 ≡ 实际引用页
    const actualPages = [];
    const versionsByPage = new Map();
    for (const f of allPages) {
        const vs = readAssetVersion(fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8'), asset.rel, asset.kind);
        if (!vs.length) continue;
        actualPages.push(f);
        // 同一页多条引用（历史遗留/复制粘贴）会让"最后一条赢"掩盖前面的旧串，故单独断言
        must(vs.length === 1, `${f} 中 ${asset.rel} 恰好引用一次（实得 ${vs.length} 次·多条会互相掩盖）`);
        versionsByPage.set(f, vs[0]);
    }
    const missing = asset.pages.filter((p) => !actualPages.includes(p));
    const extra = actualPages.filter((p) => !asset.pages.includes(p));
    must(missing.length === 0 && extra.length === 0,
        `引用页清单与实际双向相等（登记 ${asset.pages.length} / 实测 ${actualPages.length}）${missing.length ? `——清单里有但没解析到：${missing.join(', ')}（该页写法未被解析=它的用户会一直拿旧资源而守卫不报）` : ''}${extra.length ? `——实际引用了但清单未登记：${extra.join(', ')}` : ''}`);

    // ② 串一致且等于登记版本
    const versions = [...new Set(versionsByPage.values())];
    must(versions.length === 1 && versions[0] === asset.version,
        `全部引用页 ?v= 一致且等于登记值 ${asset.version}${versions.length === 1 && versions[0] === asset.version ? '' : `——实得 ${versions.length} 种：${versions.join(' / ')}；逐页：${[...versionsByPage].map(([f, v]) => `${f}=${v}`).join(', ')}`}`);

    // ③ 内容指纹
    const actualSha = fingerprint(asset, fs.readFileSync(path.join(PUBLIC_DIR, asset.rel)));
    must(actualSha === asset.sha256,
        actualSha === asset.sha256
            ? `内容指纹与登记值一致（${actualSha.slice(0, 12)}…）`
            : `内容已变但登记值未更新 —— 实际 ${actualSha}\n         登记 ${asset.sha256}\n         ⇒ 改了共享 CSS 必须同时 bump 全部引用页的 ?v= 串（静态守卫与 Playwright 都发现不了，它们不吃浏览器缓存）。\n         做法：换全部引用页的 ?v= → 更新本文件该资源的 version/sha256 → log 追加一行原因。`);

    // ③b 登记日志自洽
    must(asset.log.length >= 1 && asset.log[asset.log.length - 1][0] === asset.version,
        `log 末行版本号 = 当前登记版本（防只改常量不写原因）`);
    must(new Set(asset.log.map((x) => x[0])).size === asset.log.length, 'log 无重复版本号');
}

// ── ④ git 联动：改了 CSS 就必须在同一批改动里动引用页 + 本登记 ──────
//   这是唯一能**强制 bump** 的判据（③ 只能强制"更新登记"：有人若只改 SHA 常量、不碰页面串，③ 照样绿）。
console.log('\n--- ④ git 联动检查 ---');
{
    let changed = null;
    try {
        const out = execSync('git status --porcelain=v1 -- . ../', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        changed = out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
    } catch (e) {
        changed = null;
    }
    if (changed === null) {
        console.log('  [SKIP] git 不可用（非仓库/命令缺失）——本判据跳过，不计入通过项，也不假装通过');
    } else {
        for (const asset of ASSETS) {
            const cssTouched = changed.some((f) => f.replace(/\\/g, '/').endsWith(`public/${asset.rel}`));
            if (!cssTouched) { ok(`${asset.rel} 相对工作区无未提交改动（本判据不适用）`); continue; }
            const pagesTouched = changed.some((f) => asset.pages.some((p) => f.replace(/\\/g, '/').endsWith(`public/${p}`)));
            const selfTouched = changed.some((f) => f.replace(/\\/g, '/').endsWith('scripts/verify-shared-css-cache-bust.js'));
            must(pagesTouched && selfTouched,
                `${asset.rel} 有未提交改动时，引用页与本登记文件也在同一批改动内（页面=${pagesTouched} / 登记=${selfTouched}）——只改 CSS 不动串，用户拿到的还是旧样式`);
        }
    }
}

// ── ⑤ 对照组：证明判据不是恒真 ───────────────────────────────────
console.log('\n--- ⑤ 对照组 ---');
{
    const html = `<link rel="stylesheet" HREF='assets/css/components.css?x=1&v=vX_test#frag'>
                  <link rel="stylesheet" href="assets/css/other.css?v=zzz">
                  <!-- 注释里提到 assets/css/components.css 不应被算作引用 -->`;
    const got = readAssetVersion(html, 'assets/css/components.css');
    must(got.length === 1 && got[0] === 'vX_test',
        `★对照组①：大写 HREF + 单引号 + 多查询参数 + hash 的写法能被正确解析为 vX_test（实得 ${JSON.stringify(got)}）——首版正则要求 ?v= 紧跟且到行尾，这些写法会漏`);

    const bare = readAssetVersion(`<link rel="stylesheet" href=assets/css/components.css>`, 'assets/css/components.css');
    must(bare.length === 1 && bare[0] === '(无缓存串)', `★对照组②：无引号且无 ?v= 的裸引用被判为"(无缓存串)"（实得 ${JSON.stringify(bare)}）`);

    const commentOnly = readAssetVersion('<!-- 详见 assets/css/components.css 该层注释 -->', 'assets/css/components.css');
    must(commentOnly.length === 0, '★对照组③：仅在注释里提到文件名不算引用（首版全文扫描曾因此把 11 页全判成"无缓存串"）');

    const fakeMissing = ['A.html', 'B.html'].filter((p) => !['A.html'].includes(p));
    must(fakeMissing.length === 1, '★对照组④：清单里有而实际没解析到的页会被算进 missing（证明覆盖面判据不恒真）');

    // ④ 的对照组：真实工作区此刻恰好构不成反例（CSS 已提交），故用假 changed 列表验判据逻辑本身。
    //   场景 = 只改了 CSS，引用页与本登记文件都没动 —— 正是本次事故的形态。
    {
        const fakeChanged = ['wbs-server/public/assets/css/components.css'];
        const asset = ASSETS[0];
        const cssTouched = fakeChanged.some((f) => f.replace(/\\/g, '/').endsWith(`public/${asset.rel}`));
        const pagesTouched = fakeChanged.some((f) => asset.pages.some((p) => f.replace(/\\/g, '/').endsWith(`public/${p}`)));
        const selfTouched = fakeChanged.some((f) => f.replace(/\\/g, '/').endsWith('scripts/verify-shared-css-cache-bust.js'));
        must(cssTouched && !(pagesTouched && selfTouched),
            '★对照组⑤：只改 CSS、不动引用页与登记文件的改动集会被 git 判据判红（证明④不恒真）');
    }
}

// ── ⑥ JS 资源的变异自证（内存里造，不动磁盘）：对每个 kind:'script' 的登记项、每个登记页各做一遍 ──
//   #77 C6a：原先只对第一个 script 资源（model-script-gen.js）的第一页做；登记 app.js（16 页）与 model-detail-normalize.js 后改成逐资源、逐页。
//   改库内容不改缓存串 / 页面串被改 / 引用被注释掉，都必须判红。
console.log('\n--- ⑥ JS 资源变异自证 ---');
for (const asset of ASSETS.filter((a) => a.kind === 'script')) {
    const tag = path.basename(asset.rel);
    const file = fs.readFileSync(path.join(PUBLIC_DIR, asset.rel));
    must(fingerprint(asset, file) === asset.sha256, `★变异⑥-0 对照（${tag}）：未变异的库内容指纹 = 登记值`);
    must(fingerprint(asset, Buffer.concat([file, Buffer.from('\n// x\n')])) !== asset.sha256, `★变异⑥-1（${tag}）：库内容改一处（页面串没动）⇒ 指纹与登记值不符 ⇒ 判红`);
    must(fingerprint(asset, Buffer.from(file.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8')) === asset.sha256, `★变异⑥-2（${tag}）：仅行尾 CRLF / LF 不同不误报（规范化生效）`);
    // 引用标签的匹配式由登记路径现算（转义正则元字符），改标签内的 ?v= 只动这一个标签，不会误改页面注释里恰好出现的同名串
    const refRe = new RegExp('(<script\\b[^>]*' + asset.rel.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '[^>]*></script>)', 'i');
    for (const pg of asset.pages) {
        const page = fs.readFileSync(path.join(PUBLIC_DIR, pg), 'utf8');
        const live = readAssetVersion(page, asset.rel, 'script');
        must(live.length === 1 && live[0] === asset.version, `★变异⑥-3 对照（${tag} @ ${pg}）：真实页面解析出的 ?v= = 登记版本（实得 ${JSON.stringify(live)}）`);
        const liveB = readAssetVersion(page.replace(refRe, (t) => t.replace(asset.version, 'v1.180.0_other')), asset.rel, 'script');
        must(liveB.length === 1 && liveB[0] !== asset.version, `★变异⑥-4（${tag} @ ${pg}）：该页 ?v= 被改而登记不变 ⇒ 解析值 ≠ 登记版本 ⇒ ② 判红`);
        const commented = page.replace(refRe, '<!-- $1 -->');
        must(commented !== page && readAssetVersion(commented, asset.rel, 'script').length === 0, `★变异⑥-5（${tag} @ ${pg}）：库引用被 HTML 注释掉 ⇒ 解析不到引用 ⇒ ① 判红`);
    }
}

console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
process.exit(fail === 0 ? 0 : 1);
