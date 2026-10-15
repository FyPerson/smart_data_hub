#!/usr/bin/env node
/**
 * #77 C4b：目录页接线用例（Playwright，隔离实例）。C4c 在本文件上扩展。
 *
 * 覆盖（W1–W8，每个用例写明「它锁的是什么」）：输入即过滤 / ?search= 预填首屏即过滤 / 重载保留页码与夹紧 / 迟到列表响应丢弃 /
 *   ?focus 清搜索并跳组页、高亮 3 秒 / D-7 验收弹窗关闭重载 / D-14 DDL·ETL 弹窗保存后关闭重载 / 组化渲染（第 1 页 20 组 = 21 行，伴生紧跟主模型）。
 *
 * 跑法（wbs-server 目录下，脚本自己起隔离实例，不碰 3000）：node scripts/test-model-catalog-playwright.js [--port=<n>]（默认 3377）
 * 追加（C4b-2 预筛修复）：W9 对象名搜索（路由注入 impl_obj_names：命中 / null / 非数组 / 大小写）；W10–W12 D-7 在途写请求（关闭时仍有在途 → 写完才重载、失败、连续关闭重开、关闭后启动的保存、DDL 关闭钩子）；
 *   W13 highlightModel 定位（跨页 / 过滤后 / 落单伴生）；W4 补列表请求失败；W3 补非默认排序 + 搜索下的夹紧；W5 补 ?focus 的不存在 / 已删除 / 伴生 id。
 *   B5 时序：每个页面记一条时间线（write-done / write-fail / list-req / close），断言列表请求严格在关闭之后、在途时在写请求完成之后、每次保存动作恰一次重载。
 * 追加（36-R2，D-7 代次推导）：W16 重载被取代且取代者失败 / W17 旧重载网络失败晚于新重载 / W18 请求先于写结束发出 / W19 覆盖请求在途时去重；过期读 catalogIsStale()（catalogListSeen < catalogWritesDone）。
 * 追加（C4c-2 子批 2b，依赖点迁移）：条目选择器 tr[data-id] → [data-id]（INIT_PROBE 行数时间线 / open() 等待 / domIds / W5 / W5c）；W3b 的排序点击改 button[data-sort-by="id"]；
 *   W5 的高亮读法改为 data-focus-highlight 属性 + 计算底色 #fef3c7（页面 CSS 带 0.3s 底色过渡，颜色用有界 waitForFunction 等到位；属性有无由假时钟同步决定）。W1–W19 的断言意图与期望值不变。
 * 追加（C4c-2 子批 2c，W20 起）：W20 c1 迁入（第二行 #id / viewer 无操作区 / ID 排序三态）/ W21 字段 / W22 业务域映射（含停用域显示代码 P31、映射失败、映射晚到不重渲染）/ W23 最近验收七态 + null + 未知态 /
 *   W24 菜单关闭契约与分发（互斥、置灰项零调用、aria-disabled 与 disabled 各自被检查、点外部、Esc 与抽屉 Esc、重渲染、经全局名取、删除只传 1 个参数）/ W25 P-U1 · D-18 · D-19 三种身份文案 / W26 落单伴生组头 + 组结构 /
 *   W27 抽屉业务负责人 + 「迭代历史 →」显示规则 / W28 新排序键 acceptance_at · domain / W29 XSS / W30 设计说明气泡二次打开 / W31 伴生「编辑信息」保存路径。每组都含伴生条目。
 * 追加（C4c-2 修复批 2d）：① W5 的假时钟（page.clock.install 是上下文级、暂停态）改在 W5 自己的独立上下文里装，用完关闭；W6 起回到不装假时钟的 admin 上下文，在真实计时器下运行。
 *   ② W31 把「伴生编辑信息保存不改 config_mode」写成计数断言（请求体不带 config_mode / 库里仍为 companion / 变更日志不含「配置方式」/ config_rev 不变），并加两条非伴生对照（#52 DWD、#58 DIM custom：请求体仍带 config_mode 且库里不变）。
 * 追加（C4c-2 修复批 2e）：① W24「点外部关闭」第三种（点另一个条目的第二行）补前提 onlyOpen(['catalog-menu-more-52'])；② W27 删掉恒真的「也没有原生 alert」半句（viewIterationHistory 在该用例里已打桩，原生 alert 根本不可达）；
 *   ③ W31 加深链 Model_Center.html?id=53&edit=1 的同口径用例（请求体不带 config_mode / 库里仍 companion / 日志不含「配置方式」/ config_rev 不变）；起点用 sqlite 把 #53 的 config_mode / config_rev 写回第一个用例之前的值，使两个用例互相独立。
 * 追加（C4c-2 收口修复批 codex 39）：W32 伴生保存而「列表缓存行」的 companion_of 已过期（置 null，弹窗副本不动）/ W33 「弹窗副本」过期（列表行不动）——两条都不得发 config_mode，库里仍 companion、config_rev 不变（confirmRegister 并集判断）；
 *   W34 catalogCall 的全局名不是函数时只 console.error（无 pageerror、菜单已关）/ W35 未知层级下 ddl · etl · view-config 零调用（分发按层级闭合），并带 DIM / DWD / ODS / 伴生的正向对照。
 *   W32 / W33 走 ⋯ →「编辑信息」（点击路径给处理函数的是行副本，所以列表行与副本是两个对象）；深链 ?id=&edit=1 传的是 allModelsData 里的那个对象本身（MC 的 openEditModal(targetModel)），两者同一对象，造不出「只过期一边」。
 * 追加（C4c-2 收口修复批 B2）：W34 收集到的 console.error 总数恰为 1 / W31（含 W32 / W33）读变更日志前有界等服务端写完（日志条数变化）/ W5 高亮消失后等计算底色回到高亮前基准 /
 *   W28d 用路由把业务域名称改写成码点序与 zh 拼音序下都与代码序相反（Z域 / A域 / M域）、等映射到达后再点排序 / W29 加 impl_obj_names 独有搜索词 / W27 抽屉点击前清空副标题与正文。
 * 追加（C4c-3 子批 3a，W36 起）：W36 展开按钮与面板结构（含伴生 #53、viewer）/ W37 loaded 内容与实现对象表（七种徽章文案 + 色调类、悬停、null 徽章）/ W38 三种空态 + 真实服务端往返 /
 *   W39 迟到的旧展开响应被丢弃（收起再展开；翻页）/ W40 失败重试（500 / 形状不对 / 连接失败；不弹 toast）/ W41 事件表（翻页收起、排序保留、改搜索收起、数据重载只保留当前页展开项并重新请求、?focus 不展开）/
 *   W42 全部收起 / W43 展开集合 ∩ 当前页（直接写 currentPage）/ W44 XSS（展开区）。W29 的属性白名单加入 DOM 契约新增的四个 data 键。
 *   「到达记录」旁听器：页内给 ModelCatalogCore.relationsArrived 套一层透传（window.__relArr），读核心对每次到达的判定（是否 discard-relations）；「同步读到加载态」的用例把响应用闸门扣住，保证读在响应之前。
 * 追加（C4c-3 子批 3b，W45 起）：W45 列表刷新失败（P28：提示 + 重试、在途展开变为可重试、旧数据保留、不弹 toast、不自动重试）/ W46 首次加载失败（提示「列表加载失败」、error、?focus·?id 不执行）/ W47 数据到达前输入搜索·点排序不设 ready /
 *   W48 loadModels 三态返回值 / W49 上游名匹配与后端 asciiLower 同口径（大小写变体命中、归一化后同名不成链接、非 ASCII 不折叠）。既有断言的两处改动（3b 起 loadModels 失败返回 'failed' 并调核心 listFailed，listToken 归 0）：W16 取代者失败的返回值由 false 改为 'failed'；
 *   W4b 由「listToken 保持在途令牌 ≠ 0」改为「返回 'failed'、listToken 归 0、listArrived 调用 0 次、旧数据与页码不变、状态 error、提示出现」，并补「200 非数组」「连接失败」两个失败形态；no-token 变异的正则随返回值改写。
 * 变异自证（MC_MUT=<名>，页内替换，期望判红；下列「红」是实测，不是设计意图）：
 *   —— 2c 新增的 7 个变异改的是 model-catalog.js 源码（委托在闭包里，page.evaluate 改全局函数够不着）：运行前在 node 里对 CAT 源码做锚点替换（锚点必须恰好出现 1 次，否则直接报错退出），
 *      再用 ctx.route 拦截 model-catalog.js 的响应换成变异后的源码；页面装载后用探针确认变异确实生效，探针不成立直接抛错（不静默放行）：
 *   dispatch-cached（处理函数按首次调用缓存）→ W24「经全局名取」判红；
 *   delete-force（删除多传第二个参数 true）→ W24「删除项只传 1 个参数」判红；
 *   aria-unchecked（委托不再检查 aria-disabled）→ W24「只有 aria-disabled」判红；
 *   disabled-unchecked（委托不再检查 disabled）→ W24「只有 disabled 属性」判红；
 *   notes-noescape（设计说明分发去掉 escapeHtml）→ W29 设计说明气泡（主模型行与伴生行）判红；
 *   domain-rerender（业务域映射到达时整页重渲染）→ W22c 判红；
 *   notes-keep-listener（设计说明分发不再撤掉上一个气泡的 once 监听）→ W30 第 2 次起判红。
 *   —— 2d 新增 1 个（page.evaluate 替换 Model_Center.html 的全局函数 confirmRegister）：
 *   companion-sends-mode（confirmRegister 对伴生行照旧发 config_mode）→ W31「伴生保存请求体不带 config_mode」及其后的库里 / 日志 / config_rev 断言判红；深链用例的请求体 / 库里 / 日志三条同样判红（2e 实测 7 条 FAIL）。
 *   clock-leak（测试自身的变异：W5 退回旧做法，假时钟装进 admin 上下文）→ 「W5 之后 admin 上下文的新页面定时器正常走」判红。
 *   —— B2 新增 3 个：catalog-call-extra-error（catalogCall 在 console.error 之外多发一条别的 console.error）→ W34 判红；domain-sort-by-name（核心排序 domain 时改按显示名 localeCompare，改的是 model-catalog-core.js）→ W28d 判红；
 *      search-skip-objnames（核心搜索不再含 impl_obj_names，改的是 model-catalog-core.js）→ W29 的独有搜索词判红（W9 也红）。
 *   —— 39 收口批新增 4 个：companion-list-priority（confirmRegister 退回「列表行优先」三元式）→ W32 判红；companion-editmodel-only（只看 editModel）→ W33 判红；
 *      dispatch-else-dwd（ddl / etl / view-config 恢复 else 兜底 DWD）→ W35 的未知层级三条判红（模型 ODS 的 etl 对照同样红）；catalog-call-noguard（catalogCall 去掉函数存在性检查）→ W34 判红。
 *   —— 以下 8 个是 C4b-2 的变异（page.evaluate 替换全局函数）：
 *   stale-noop（reloadCatalogIfStale 换空函数）→ 所有「保存 → 关闭」用例（W6 起）判红；
 *   no-token（loadModels 去掉令牌核对）→ W4 判红（W16 的「R1 被取代不推进」也判红）；
 *   inflight-immediate（关闭钩子不看在途写请求）→ W10d、W10g（在途写请求场景）判红；
 *   reopen-ignore（重载条件去掉「没有带钩子弹窗开着」）→ W6 / W6b / W7×3 / W10c / W10d / W12×2 / W10f / W18 判红（所有「写结束时弹窗仍开着」的场景；2e 在真实计时器下复测 27 条 FAIL）；
 *   no-dedupe（去掉「已有覆盖全部写入的请求在途」去重）→ 只有 W19 判红；
 *   seen-at-arrival（catalogListSeen 取到达时的 catalogWritesDone）→ 只有 W18 判红；
 *   seen-on-failure（失败 / 被取代时也推进 catalogListSeen）→ W14（两个失败形态）与 W16 判红；
 *   done-not-counted（finally 里不递增 catalogWritesDone）→ 所有需要重载的用例（W6 起）判红。
 *   （reload-no-restore 已删除：D-7 改代次推导后没有「恢复标记」机制，防护目标由 seen-on-failure 承担。）
 *   —— C4c-3 子批 3a 新增 37 个（33 个改 model-catalog.js、4 个改 model-catalog-core.js；「首红」= 该变异运行时第一条 FAIL，实测，日志 E:/tmp/mc77-c4/c4c3/mut_<名>.log）：
 *      toggle-act（展开按钮带 data-act）→ W20 viewer 先红（W36 按钮结构同样红）；toggle-second（展开按钮挪到分层徽章之后）/ toggle-no-controls（去掉 aria-controls）→ W36 按钮结构；viewer-no-toggle → W36 viewer；toggle-no-select → W36 P30；
 *      pane-first（面板插到条目最前）→ W36 同步读；companion-up-api（伴生上游不走 D-34 文案）→ W36 伴生；relations-wrong-path（请求路径写错）→ W36 请求路径；
 *      up-no-links / down-no-hint / badge-tone-fixed / badge-label-raw / obj-role-empty / obj-time-empty / null-badge-double / failed-title-generic / listed-hint-missing → W37（分别红在上游链接 / 下游提示 / 对象行 1 色调 / 对象行 1 文案 / 对象行 2 职责 / 对象行 2 核验时间 / 对象行 7 单个「—」/ 失败悬停 / 表下提示）；
 *      objstate-all-standard（pending 当 standard 显示）/ ods-sep（ODS 上游分隔符）→ W38；relations-no-token（迟到响应令牌取当前令牌）→ W39；retry-as-toggle（重试接成 toggleExpand）/ error-toast（失败弹 toast）→ W40；
 *      sort-collapses（排序清展开）/ render-no-panes（渲染不建面板）→ W41b；setquery-keeps-expand → W41c；reload-no-effects / reload-keeps-offpage → W41d；focus-keeps-expand → W41f；goto-keeps-expand → W39b（翻页后迟到响应）；
 *      collapse-all-noop → W42；no-page-intersect → W41b 先红（W43 同样红）；pane-link-innerhtml / plain-innerhtml（面板链接 / 纯文本用 innerHTML）→ W44；
 *      toggle-style-attr（展开按钮多一个 style 属性，非白名单）→ W29 载入后属性白名单（证明 W29 加入四个 data 键后仍拦得住 on* / style 之类的越界属性）；
 *      up-link-includes（上游名按 includes 匹配表名）→ W37 上游（第 3 项前缀名被误做成链接）；obj-name-innerhtml / down-desc-innerhtml（对象名格 / 下游中文短名用 innerHTML）→ W44。
 *   —— C4c-3 子批 3b 新增 15 个（14 个改 model-catalog.js、1 个改 Model_Center.html；运行前锚点替换并用页内探针确认生效）；另 3a 的 up-link-includes 随匹配口径改写重定了锚点：
 *      fail-no-notice（失败不显示提示）→ W45 / W46；ready-before-data（数据到达前设 ready）→ W47；fail-no-core（失败不调核心 listFailed）→ W45 在途展开变为可重试（及 W4b 令牌归 0）；fail-toast（失败弹 toast）→ W45；
 *      fail-wipes-data（失败清掉旧数据）→ W4b / W45；fail-never-error（失败后属性不设 error）→ W45 / W46；retry-no-request（重试按钮不发请求）→ W45 / W46；success-keeps-error（成功套用后不清失败标记）→ W45 重试后；
 *      ret-true（成功返回 true）→ MC 初始化门使 ?focus 不执行，最先红在 W4b（每个失败形态之前的前置要求先成功加载并返回 'arrived'），随后 W5 / W5b / W41f（?focus 不再执行）与 W48（'arrived' 断言）同样判红，脚本跑完（3b 版本在 W5 抛异常、W48 来不及运行，已更正）；discard-undefined（被取代返回 undefined）→ W48；net-error-throws（网络错误 / 非 JSON 仍抛出，不按失败处理）→ W4b；init-no-gate（Model_Center.html 初始化去掉 'arrived' 门）→ W46 的 ?focus（首次加载失败时）与 W46c / W46d（初始化请求被取代时）；W46b 不判红（它只是「失败时不报错」的冒烟检查——3b 把它写成判红是错的，3c 更正）；
 *      up-case-sensitive（上游名区分大小写）/ up-first-hit（归一化后多行同名仍取第一行）/ up-to-lowercase（归一化改用 toLowerCase）→ W49。
 *   —— C4c-3 子批 3c（预筛修复批）：W4b 每种失败形态（HTTP 500 / 200 非 JSON / 200 非数组 / 连接失败 / 核心事件 listArrived 抛程序错误）之前先成功加载一次并断言回到 ready、提示隐藏；两个走 catch 的形态与程序错误形态断言控制台有 warn；
 *      W5 / W5b / W5c 的 ?focus 等待改走 check（超时记 FAIL，W5 余下断言跳过），W31 深链与 W41f 在前提不成立（弹窗没自动打开 / 没跳页）时跳过后续点击——都不再因超时抛异常把脚本带崩（ret-true 才能跑到 W48）；W46c / W46d 在整体替换 loadModels 的三个 D-7 页内变异（no-token / seen-at-arrival / seen-on-failure）下跳过（会盖掉旁听包装）；W46 / W47 补「数据没到 / 从未成功时重渲染不显示暂无模型数据」；W46c / W46d 初始化请求被取代（'discarded'）时 ?focus / ?id 不执行（W46b 更正为冒烟）；W50 列表成功返回 [] → ready + 暂无模型数据。
 *      新增 7 个变异（页内 / MC 替换，运行前探针确认生效）：fail-nonarray-silent（非数组分支调核心 listFailed 但不置 error / 不显示提示）→ W4b 200 非数组；fail-catch-silent（catch 分支同上）→ W4b 200 非 JSON / 连接失败 / 程序错误；up-self-link（上游名命中自己也成链接）→ W49 ③；
 *      ready-needs-rows（ready 按 allModelsData.length > 0）→ W50；empty-before-data（空态不看 catalogListApplied）→ W46 / W47；catch-no-warn（catch 不记 warn）→ W4b；init-gate-failed-only（Model_Center.html 初始化门放宽成只拦 'failed'）→ W46c / W46d。
 *   —— C4c-3 子批 3d（codex 40 收口）：W51 关系响应逐项畸形（下游含 null / 上游 name 是 {"toString":0} / 实现对象缺 obj_name / 下游 id 非正整数 → 面板 error 且可重试，重试后 loaded）；W4b 提示 hidden=false 且 Playwright 可见、程序错误形态用「同数量同 id 但字段不同」的响应并比较 allModelsData 完整快照与页面文字；
 *      no-token 变异替换计数校验；W36 伴生 #53 先 loading（独立闸门）再 loaded；W41d / W46c / W46d 的直接 loadModels() 改页内有界；W45b 从第 2 页发起的列表刷新失败（页码、条目逐项保留，重试按 D-13 保留 / 夹页）；W45 刷新后各展开项恰各重新请求（#50=2、#53=2、#52=3）；
 *      W49b 本模型与他人归一化同名 → 纯文本；W41f 关系请求监听在导航前装。新增 12 个变异：rel-validate-top-only（关系校验退回只查顶层）→ W51；fail-notice-hidden（失败时忘记取消提示的 hidden）→ W4b；apply-before-event（先写 allModelsData 再调核心事件）→ W4b 程序错误形态；
 *      fail-resets-page（失败时 currentPage = 1）→ W4b / W45b；reload-first-only（重载只为第一个展开项发请求）→ W45；up-exclude-self-first（先排除自己再数命中）→ W49b；focus-prefetch-relations（深链初始化预取关系但保持收起）→ W41f；
 *      load-dedupe-inflight（loadModels 复用在途请求）→ W46c / W46d 有界超时；load-waits-relations（loadModels 等展开请求完成）→ W41d 有界超时；companion-skips-loading（伴生面板跳过加载态）→ W36 #53；
 *      no-page-intersect-inverted（交集谓词取反）→ W41b / W43、fail-discard-inverted（catalogFailList 丢弃条件取反）→ W4b 是对 codex 40Tc-M3 / M4 的核对变异（行为套件本来就拦得住，不改产品与守卫）；up-input-only（只归一化输入侧）原先 W 全绿，40Tc-L1 采纳后由 W49b「候选行表名含大写 ODS_X_UP、上游名 ods_x_up → 链接」判红。
 * 追加（C4c-4 子批 4a，W52 起）：W52 页头（P21：全页恰 1 个 h1「模型中心」；在册数「—」→ 36（含伴生，按组会得 35）→ 刷新失败不改 → 成功重载更新为 15；「批量导入」「＋ 注册新模型」在页头右上、点击行为、viewer 的注册按钮隐藏）/
 *   W53 工具条（元素顺序 [搜索框, 搜索按钮, updated_at, domain, id, 全部收起]、工具条 3 + 列头 5 = 全页 8 个排序键、#searchKeyword 属性原样、旧 .catalog-sortbar 已无）/ W54 P36 页面层（原词回车·「搜索」按钮·首尾空格·compositionend·点当前页码：展开都保留、不重新请求、不作废在途令牌；
 *   只差大小写·换词·翻页：才收起；?search= 预填词算「当前画面所用的词」）/ W55 筛选单一来源（4a 无左栏 UI，用测试钩子写 catalogFilters：catalogSyncState / getCatalogView / getSortedModels / 渲染都读它，focusCatalogModel 清空并写回）。W42 的「全部收起」选择器由 .catalog-sortbar 改为 .catalog-toolbar。
 *   新增 19 个页内变异（各自的首红见 E:/tmp/mc77-c4/c4c4/C4c4_4a_report.md）：total-groups / total-fail-zero / total-placeholder-zero / h1-hidden（页头 h1 的 display 覆盖被去掉，style.css 的全局 h1 { display: none } 生效 → W52 h1 可见性判红；这是 c7 R6b 先暴露的真缺陷）/ register-viewer-visible / register-wrong-target / batch-import-noop / toolbar-extra-sort-key / toolbar-oninput-no-composing（改 Model_Center.html 或 model-catalog.js）；
 *   p36-oldquery-sync / p36-no-rendered-record（改 model-catalog.js）；p36-core-no-guard / p36-core-no-trim / p36-case-fold / p36-goto-no-guard（改 model-catalog-core.js）；filters-sync-empty / filters-view-empty / filters-sorted-empty / focus-no-writeback（改 model-catalog.js）。
 * 追加（C4c-4 子批 4b，W56 起）：W56 左栏结构与计数（数据到达前计数「—」、五个分区、data-rail 与文案逐项等于手算值、未归属对象占位、业务域映射晚到就地换名）/ W57 点击筛选（核心 setFilter 调用序列、同组单选、再点取消、该组本来就是「全部」不调核心、多组 AND、P23 对照例、与搜索词 AND、计数不联动）/
 *   W58 回第 1 页与收起展开、「清除 N 项」只清筛选（搜索词与排序不变）/ W59 ?focus= 深链后左栏回「全部」/ W60 数据重载（失败保留计数、成功重算、选中值消失仍可取消）/ W61 左栏 XSS 与值里带冒号 / W62 两栏布局（1440 宽度无横向滚动、搜索框占位完整）/ W63 viewer 可用左栏。
 *   W24 的「点列表外真实元素」目标由已删除的列表区小标题（.section-title）改为页头 h1。新增 25 个页内变异（各自的首红见 E:/tmp/mc77-c4/c4c4/C4c4_4b_report.md）：rail-* 系列（改 model-catalog.js；含 rail-counts-filtered 只在数据重载时联动、rail-counts-live-filtered 每次重画都联动）、rail-layer-raw（改核心）、rail-layout-stacked / rail-wide / search-narrow（改 Model_Center.html）。
 *   既有变异 focus-no-writeback 的锚点补上行尾注释（focus 与左栏单击现在各有一行 catalogAdoptFilters(r.state);，原锚点不再唯一）。
 * 追加（C4c-4 子批 4c，W64 起，未归属对象）：W64 入口与计数（button#catalogRailUnowned、不带 data-rail / data-act / data-entry；初始化恰 1 次 GET /api/model-impl-objects?unowned=1；数据未到就点入口显示「加载中…」再就地换表；loadModels 不重取；空数组「没有未归属对象」；
 *   六种失败形态：计数「—」+「加载失败」+ 重试、无 toast、不影响列表）/ W65 未归属模式与表格（工具条 / 列头 / 列表体 / 分页 / 搜索框隐藏，表头与 5 行逐格手写期望，徽章文案·色调·悬停）/ W66 XSS（类型 / schema / 对象名 / 摘要 / 核验时间 / 徽章 code / failure 里的 <img onerror>、引号、</td>）/
 *   W67 失败→重试（在途置灰、在途再点不发请求、第 2 次失败按钮恢复、第 3 次成功就地换表）/ W68 迟到旧响应丢弃（成功 / HTTP 500 / 连接失败三种，页内连发两次 catalogLoadUnowned，第 1 次被扣住）/ W69 返回恢复五要素（页码·排序·搜索词·筛选·展开集合 + 关系数据，含列表失败提示；返回按钮与再点入口两条路径；不重发任何请求）/
 *   W70 未归属模式下点左栏（筛选项 / 清除 N 项 / 已是「全部」的「全部」：先退出，再按 4b 行为）/ W71 模式下列表重载（不退出、不重取、在册数与左栏计数更新、返回见新数据）/ W72 viewer。
 *   4c 对 4b 的两处改动：W56 的「未归属占位无按钮、计数『—』」断言改为「恰 1 个入口按钮、数据到达后计数『0』」（补充派单取代；数据到达前的用例同时扣住未归属请求，仍断言 8 个计数都是『—』）；变异 rail-orphan-clickable（给占位加按钮）因占位已是按钮而退役，同一防护由 un-entry-has-data-rail / un-entry-has-data-act 承担。
 *   新增 46 个页内变异（un- 前缀；各自首红见 E:/tmp/mc77-c4/c4c4/C4c4_4c 报告）；null-badge-double 的探针随徽章格抽成 catalogObjBadgeKids 由 catalogBuildObjectTable 改为 catalogObjBadgeKids。
 * 追加（C4c-4 子批 4d，预筛修复，W73 起）：W73 输入法组字标记（组字中渲染不更新「当前画面所用的词」；提交不同词 → 展开清空回第 1 页，含第 2 页场景；取消组字 → 展开保留；结束后普通输入照常记录）/
 *   W74 ?focus= 先退出未归属模式（首次列表请求扣住期间进入未归属模式，放行后目标可见且高亮）/ W75 未归属「刷新」按钮（ok 态与空态都有、在途置灰不可重复、成功更新表格与计数、失败转「加载失败」+ 重试、加载中 / 失败态没有刷新）/
 *   W76 左栏按键就地更新（mousedown 与 mouseup 之间被重画：左栏项 / 「清除 N 项」/ 未归属入口 × 手动重画 / 列表到达 / 未归属完成，点击不丢，按钮节点不变；数据不变节点逐个相同，数据变化只增删变化项；焦点保持）。
 *   既有用例的改动：W52b 的死断言（.section-title 内 input / button 恒为 0）改为「#modelListSection 内的 input / button 只出现在工具条、列头、列表、分页、列表提示里」（带正向计数，不再空转）；W72 viewer 的面板按钮由 1 个改为 [刷新, 返回]；
 *   全程 console error 统计收窄：pageerror 一律不豁免；console error 只豁免登记过的页面标签上、文本匹配「Failed to load resource|net::ERR_FAILED」的（W34 例外：只豁免以「[catalog] 处理函数不存在：」开头的那条）；并检查登记没有空挂；W64c 只给真发出 HTTP 500 / 连接失败的两个形态登记。
 *   新增页内变异（定义见 CAT_MUTS 末尾，各自的首红见 E:/tmp/mc77-c4/c4c4/4d 的 mut_summary_4d*.txt）：comp-* 4 个 / focus-no-exit-unowned / un-refresh-* 5 个 / rail-* 5 个 / section-stray-button / err-* 2 个。
 * 追加（C4c-4 codex 41 收口，缓存串 mcat12 → mcat13）：W77 未归属面板就地更新（刷新在途按下返回按钮 → 放行 → 抬起，点击生效、返回按钮同一节点、焦点不丢；刷新 / 重试按钮就地更新 disabled）/ W78 左栏选中值消失又恢复到排序位置后焦点仍在该按钮上 /
 *   W79 未归属表类型列空值显示「—」/ W80 P23 负例组（同组两个成员分别满足两个条件、没有单个成员同时满足 → 整组被排除）/ W54e 同词搜索留在第 2 页 / W54f 同页点击不作废在途令牌 / W81 未归属状态块「加载中…」「没有未归属对象」→「加载失败」后无残留文字节点（catalogRailPatch 清旧文字）。
 *   既有用例的加强：console error 豁免绑定请求地址（每个登记标签同时登记预期失败请求的 URL 模式，要求 m.location().url 命中；登记没有空挂按（标签 + 模式）检查）/ W52b 页头在列表区块之前真的进断言 / W5b 两处手工开页补 pageerror 收集 /
 *   W53 工具条三个排序键点击后立即断言手写的 DOM 序（updated_at 夹具逐行补丁）/ W57 后半段视图与业务域点击的 setFilter 调用序列 / W68、W76 页内 Promise 改有界等待 / W75 刷新在途逐格比较旧数据 / W73e 补完整输入法事件链 / W76 清除按钮节点身份与重画来源结果。
 *   新增页内变异：un-render-replace-all / rail-focus-lost / un-type-text / toolbar-sort-no-redraw / search-same-word-page1 / goto-same-bumps-token / core-p23-separate / rail-pick-double-call / un-load-hangs / un-refresh-clears-table / un-refresh-blank-rows / rail-clear-recreated /
 *   unowned-busy-not-set / unowned-busy-stuck-on-fail / unowned-busy-stuck-on-ok / rail-patch-keeps-old-text（删掉 catalogRailPatch 清旧文字那一行）/ open-dwd-script-hangs（openDwdScriptModal 做完事后永不 resolve，证明 pageCallBounded 后有结果行）/ head-after-section（脚本一载入就把页头搬到列表区块之后）/ rail-patch-attr-inverted / rail-patch-text-inverted（catalogRailPatch 两个比较条件各写反；与 VCC 的 WZ3 / WZ4 对应，41Td-M2 的页面层对照）；测试自身的变异（OLD_MUTS 里的，改的是本脚本）：err-domains-500-in-w52a / w5b-pageerror / w76-source-fails。
 * 追加（C4d-a 窄屏两档断点 + 桌面宽度，缓存串 mcat13 → mcat14）：W82 宽度矩阵（390 / 640 / 641 / 768 / 1024 / 1025 / 1280 / 1440 各一次：#modelListSection.scrollWidth ≤ clientWidth、main 内 .navbar 之外所有可见元素右沿 ≤ innerWidth + 0.5、首行 / 第二行 / 主列互不重叠、列头与首行同一网格）+
 *   W83 两档布局（>1024：左栏在左 208 sticky、负责人列可见、折叠按钮与第二行开头容器不可见、关系流五列；≤1024：左栏在列表区上方并横排换行、始终展开、负责人列隐藏（8 个 data-sort-by 仍在 DOM）、关系流单列箭头转 90°；≤640：实现对象表隐藏第 3、5 列、折叠按钮可见默认收起、首行 4 列）/
 *   W84 ≤640 折叠按钮（aria-expanded / aria-controls、点开后筛选落到 DOM 行、再点收起筛选仍在、第二行最前的状态 / 最近验收 / 负责人文案 = 宽屏首行文案（手写期望）、640 / 641 边界、新开页面默认收起）/ W85 未归属表 ≤640 隐藏「摘要」「核验时间」。
 *   新增 17 个页内变异（w82- 前缀，定义见 CAT_MUTS 末尾）。
 * 追加（C4d-b 可访问性七条 D-26 + LOW-9 + 带入项 ③⑤，缓存串仍 mcat14）：W86 A11Y-1 展开按钮 aria-expanded / aria-controls（含键盘回车 / 空格）+ A11Y-2 ⋯ 与「验收 ▾」aria-haspopup / aria-expanded /
 *   W87 A11Y-3 八个排序键 aria-sort 三态（desc → asc → 无，恰一个元素带）/ W88 A11Y-4 左栏 aria-pressed 与未归属入口、≤640 折叠按钮 aria-expanded / W89 A11Y-5 Tab 走查（上限 400；起点确认；类别覆盖；每次聚焦 outline ≥ 2px；
 *   不可见元素不得获得焦点；main 内可见可聚焦元素无遗漏；场景：1440 默认 / 有筛选 / 列表刷新失败 / 未归属模式 / 未归属失败 / 390 收起 / 390 展开）/ W90 菜单项焦点框 + A11Y-6 Esc 层级（菜单 → 抽屉）与焦点移出菜单关闭 /
 *   W91 A11Y-7 展开失败的「重试」键盘可达、回车重试 / W92 LOW-9 列头去 row / columnheader、每组与空态 role=listitem / W93 P40 清除后焦点到「全部模型」/ W94 带入项 ⑤ ?id=X、dev=1 的高亮定位先退出未归属模式。
 *   新增 20 个页内变异（w86- 前缀，定义见 CAT_MUTS 末尾）。
 * 追加（C4d 预筛修复批，缓存串仍 mcat14）：W82 宽度加 700 / 1040，并对第 1 页全部 21 个条目加 [判据 a 不越界 / b 表名下限 / c 无零尺寸可聚焦元素 + 641 Tab 走查]（路由替身构造最拥挤的标签组合）/
 *   W90 A11Y-6 补两个方向（焦点在菜单第一项时 Shift+Tab 回触发按钮菜单仍开；焦点在菜单项时点击触发按钮结束态关闭）/ W95 LOW-3 状态 / 负责人格 title 与 ≤1024 最近验收列不截断 / W96 LOW-4 ≤640 左栏收起时返回焦点落到折叠按钮 /
 *   W97 LOW-5 验收摘要无法识别时一次渲染只 1 条 warn / W89 390 forbidden 列表直接写三项（LOW-6）。
 *   新增页内变异：w82-pre-fix-css / w82-btn-shrinkable / w82-main-nowrap / w82-main-nowrap-btn-shrink / w82-tag-no-shrink / w82-acc-124 / w82-status-no-title / w82-badge-no-title / w82-owner-no-title / w82-owner-m-no-title / w82-acc-twice / w86-focusin-menu-only / w86-leave-no-toggle-fallback。
 * 追加（C4d codex 42 收口批 fix42，缓存串仍 mcat14）：W98 ≤640 第二行长字符串不越界（长负责人 / 长业务域 / 长状态，320 / 390 / 640）/ W82 判据 b 先核表名按钮存在可见再比宽度 / W83、W85 对象表读全部行（含表头）逐格 /
 *   W83 全部关系流箭头用 DOMMatrix 核 90° 旋转 / 视口切换后的双帧等待全部改有界页内调用 / W84 aria-controls 与预期 6 个区块 id 集合相等且点击链失败不崩 / W89 预期集合不因 tabindex 为负排除、焦点框再核颜色不透明度与 offset / W95 日期节点自身可见与不截断。
 *   新增页内变异：w82-btn-hidden-1024 / w82-objtable-th-only / w82-objtable-first-row-only / w82-arrow-rot0 / w82-arrow-rot180 / w82-arrow-second-unrotated / w84-ctl-dup / w84-ctl-wrong / w84-ctl-data-section / w84-no-toggle /
 *   w89-expand-tabindex-neg / w95-date-hidden / w95-date-clip / w86-focus-rule-transparent / w86-focusin-open-filter / w98-owner-m-no-constraint / w98-badge-no-constraint / w98-domain-no-constraint / w98-meta-no-min0。
 * 追加（C4d fix42b，复看收口，缓存串 mcat14 → mcat15）：W98 重写——宽度矩阵 320 / 360 / 390 / 640 / 641 / 768 / 1025，条目含伴生 #53、映射内长业务域名（路由替身让 /api/domains 返回 22 个汉字的名称）、映射外长代码、映射外长状态值，
 *   每个宽度在业务域映射到达前 / 后各量一轮（第二行与元数据容器的全部可见子项右沿 ≤ 容器右沿 + 0.5、documentElement / 列表区无横向滚动、长业务域真的被截断的前提）；业务域 title 在到达前（代码）与到达后（名称）都等于当时的完整显示文字，「未设置」不加 title；
 *   W82–W98 各用例段包 segGuard（段内未捕获异常记一条 FAIL 并继续）、点击一律 clickB / 聚焦 focusB 有界、页内读取助手缺节点返回可判定的缺失信息；各用例段注释按「首红落在本段」逐段列变异名（check_mut_comments_seg.js 按段切片对拍）。
 * 追加（C4e-a 配色 E：作用域 token + 列表 / 左栏 / 抽屉 + 页面级配色断言 ①②④，缓存串 mcat15 → mcat16）：W99 ①导航不变（模型中心页与 Task_Pool.html 的 .navbar / 未高亮导航项 / 下拉菜单 / logo 标题 / 分隔线 / 头像 / 用户名逐项相等，各页自身高亮项 rgb(217, 119, 6)，html·body 上读不到本页自定义属性）/
 *   ②E 取值（body 底、左栏底与选中项、表名、分页当前页、注册新模型按钮、条目与菜单悬停、展开面板血缘本模型、抽屉头与副标题，一律读计算样式）/ 语义色保持（DIM 徽章、自定义标签、验收有警告、需复验胶囊、抽屉 DIM 徽章）/ ④配置台 #registerBtn 四层计算底色与改前（基点 465f7d18）逐值相等。
 *   既有断言的改动：W5 定位高亮底色 rgb(254, 243, 199) → E 值 rgb(238, 240, 255)（--row-sel）；W54 分页当前页由读行内 style.background 字符串改为读计算样式 backgroundColor / borderTopColor = rgb(79, 70, 229)（CAT 行内写 var(--color-accent)，行内字符串读到的是变量文本）。
 *   C4e-a 新增 22 个页内变异：w99-*（定义见 CAT_MUTS 末尾；w99-w5-old-highlight 首红在 W5、w99-w54-old-page 首红在 W54，其余首红在 W99）；C4e 预筛修复批再加 2 个 w99-*（见下），w99-* 在 fix43 之前合计 24 个。
 * 追加（C4e-b P-U2 弹窗强调色 + 断言 ③ + 左栏焦点框对比度，缓存串仍 mcat16、CAT 未再改）：W100 ③作用域覆盖（详情抽屉 + #registerModal / #batchImportModal / #ddlModal / #validationModal + 9 个 JS 注入浮层根的 --color-accent = #4f46e5，有 E 主按钮的弹窗主按钮计算背景 = rgb(79, 70, 229)，
 *   三个标题渐变弹窗的标题背景 / 字 / 图标 stroke，P-U2 其余 E 行（信息条 / 表名 / 段标题 / 版本号 / 激活页签 / 编辑态切换只改编辑态那一支 / 改名输入框），语义色保持（DIM 架构决策区块、导入提示、ODS 使用说明、自定义徽章与模式条、验收有警告、迭代历史「修复」、变更历史「修改」、SQL 字符串高亮 #fbbf24），一律读计算样式）/
 *   W101 左栏焦点框（左栏内 outline = rgb(129, 140, 248)、与左栏底色对比度 ≥ 3:1，390 宽折叠按钮同；列表区仍 accent）。C4e-b 新增 84 个页内变异 w100-*，C4e 预筛修复批再加 3 个（w100-drawer-close-*），w100-* 在 fix43 之前合计 87 个 = W100 段 82 个 + W101 段 3 个 + W99 段 2 个（按首红所在段计；定义见 CAT_MUTS 末尾）。
 * 追加（C4e 预筛修复批，缓存串仍 mcat16、CAT 只改头注释）：W99 ② 列表选中条目（.selected-row）底色 --row-sel rgb(238, 240, 255) + inset 3px accent 色条（鼠标悬停其上也成立）、未选中条目不带；W100 抽屉小节补关闭按钮 .u-drawer-close 常态 rgb(203, 213, 225) / 悬停 rgb(255, 255, 255) 与抽屉头底色对比度 ≥ 3:1。
 *   新增变异：w99-selected-bar-missing / w99-selected-bg-old（首红在 W99）；w100-drawer-close-no-override / w100-drawer-close-no-hover / w100-drawer-close-hover-dark（首红在 W100）。
 * 追加（C4e codex 43 收口批 fix43，缓存串仍 mcat16、产品代码零改动，只改本测试）：W99 ① 作用域不外溢改用全量 token 清单（从页面 CSS 解析：作用域块 + .catalog-rail + #catalogRail 三处声明的全部自定义属性；本页独有 token 在 html / body / nav.navbar 上必须为空，
 *   共享 --color-* 在三处都 = 平台基线（Task_Pool.html 的 html 上的取值）且与 E 值不同的那些不等于 E 值）/ W99 ② 选中条目读底色时同时断言 selected-row 与 :hover（先收起抽屉，真实鼠标悬停回条目，等三者同时成立）/ 左栏选中项色条补读 ::before 的 content / display / visibility / opacity / height /
 *   W100 四处标题图标补读子图形（path 等）计算 stroke / 编辑态切换补全（自定义 DDL 进入编辑后可见的保存按钮背景、自定义 ETL 退出字色、FDL 非编辑态字色与退出后底 / 字 / 边）/ 动态浮层根「已出现」前提改有界可见等待（waitShown）/ W101 全部焦点断言补计算 outline-width = 2px /
 *   w100-scope-no-designnotespopover 的装载探针收紧为带结尾 " {" 的完整选择器列表（原版为假、变异版为真）；全部 w99-* / w100-* 探针另做过「原版页面上为假 / 变异版页面上为真」扫描（fix43/scan_probes.js）。
 *   新增页内变异 28 个（另有 1 个等价变异 eq99-selected-no-important 不判红）：w99-* 8 个 + w100-* 20 个（W100 段 18、W101 段 2），名单见各段注释。fix43 之后累计：w99-* 32 个、w100-* 107 个（W100 段 100 + W101 段 5 + W99 段 2）。
 * 追加（C5 抽屉概览「最近验收 / 实现说明 / 设计说明」+ 时间线「验收后」，缓存串仍 mcat16、CAT 未改；改的是 Model_Center.html 与 server.js 的 GET /api/models/:id）：W102 真实服务端往返（库里写验收记录 / 配置版本 / 说明：九个模型覆盖 pass / partial×2 / fail / warn / stale×2 / none（custom）/ companion，
 *   「最近验收」文字·类名·计算色·完整时间·需复验徽标·后端 reason、kv 末尾三行顺序、说明全文与空占位）/ W103 逐 state（路由替身给详情的 acceptance：十四种含 null / 键缺失 / 无法识别 / none 带 at）/ W104 说明全文换行与空占位（主模型 · custom · DWD · ODS 各一，companion 四种组合：两段都空 / 仅实现说明 / 仅设计说明 / 两段都有）/
 *   W105 说明与 reason 的 HTML 载荷以字面文本显示（主 · custom · companion）/ W106 时间线「验收后」标记（早于 / 晚于 / 同一秒、六种 state、T 分隔·缺失·乱串、真实 companion）/ W107 迟到的变更日志 / 详情响应不落到新抽屉（旧请求被扣住 → 切换 → 放行）。
 *   后端逐 state 的手写期望在 verify-model-list-extras.js 的「六」（详情 acceptance 与列表同口径）。新增页内变异 27 个（w102-* 11 / w103-* 3 / w104-* 3 / w105-* 2 / w106-* 4 / w107-* 2 + 等价 eq107-* 2，首红见各段注释；迟到响应的防线是——详情两层（切换时 navAborter 取消旧请求、落 DOM 前 mdcGuard）、时间线三层（再加闭包里的 host 已脱离文档）：w107-race-detail 去掉详情的两层才可观察，w107-race-timeline 去掉两层并让时间线改写当前抽屉里的位置才可观察；各去一层、以及时间线「取消 + guard 都去掉、host 不改」都是等价变异，见修复批段与 W107 注释）。
 * 追加（C5 预筛修复批，缓存串仍 mcat16、CAT / CORE / 后端 reason 文案未改；改的是 Model_Center.html 与本测试、verify-model-list-extras.js）：
 *   MED-1 抽屉内写操作后抽屉刷新：新增 W108（custom #58 的「查看 DDL →」打开 DDL 编辑器：a 保存后关闭 → 抽屉重载〔详情 +1、变更日志 +1、「最近验收」变「上次通过 ✓」+ 需复验、时间线多出带「验收后」的新行、焦点回到重建后的同一个按钮〕/ b 没写过就关闭、或只读弹窗开了再 Esc 关 → 不重载（打标的节点还在）/
 *   c 编辑器打开期间抽屉被 Esc 关掉 → 关闭编辑器后不重开 / d 编辑器打开期间抽屉换了模型 → 不重载、不串到别的模型）；写入信号 = 目录页的 catalogWritesDone（抽屉建 ctx 时记基数），触发点 = syncModelDrawerInert。
 *   待裁 1 stale 文案改「上次通过」（pass → 上次通过 ✓，warn → 上次通过（有警告）!，缺失 → 上次通过 —；时间线 stale 时 title =「发生在上次通过的验收（…）之后」）：W102 / W103 / W106 的相关期望同步改（不放宽），W102 补「旧版本通过 → 之后版本失败 → 再改配置」一例（#62 加一条版本 2 的失败记录并升到版本 3，显示更早那条通过记录的时间）。
 *   待裁 3「验收后」改中性（E 的 --color-bg-elevated 底 + --color-text-secondary 字 + 1px --color-border 边；「需复验」仍是语义琥珀）：W106 对每个标签读计算样式。待裁 2 顺序约束：W106 末段（扣住 #50 详情请求时变更日志请求数 = 0，放行后恰 1 次）。
 *   LOW：L1 W107 切换直接调 openModelDrawer、注释改「详情两层、时间线三层」、登记等价变异 eq107-all-off-host-kept；L2 W105 每个用例前重置 window.__xss；L5 完整验收时间读 --color-text-secondary，W102 / W103 逐条读计算色；L7 W107 的「不应发生」断言改页内记录器（MutationObserver）+ 等新模型内容渲染完成的正向信号，不靠固定等待（W105 的 400ms 保留并写明理由）。
 *   断言数（w_fix_full.log 按段统计）：W102 27 → 29、W106 26 → 34、W107 5 → 7、新增 W108 10 条；全量 1356 → 1378。页内变异 27 → 40：新增 w102-stale-old-wording / w102-stale-warn-no-note / w102-date-weak / w106-tl-title-stale-recent / w106-after-amber / w106-parallel-timeline / w108-no-reload / w108-reload-without-write / w108-reload-wrong-model / w108-no-refocus / w108-reopen-closed / w108-base-not-per-ctx（判红）+ 等价 eq107-all-off-host-kept（不判红）；w102-stale-text-plain / w106-tl-title-config 改了锚点。
 * 追加（C5 修复批 2，缓存串 mcat16 → mcat17、CAT 只改 catalogTrackWrite 的 finally 里派发一次 'modelcatalog:write-settled'）：
 *   W108 补 ① 前提：MC 依赖的三个 CAT 全局名都在（typeof）+ 预建 toast 容器 ② a 的「编辑器开着时 body 增删（复制回退的 textarea）不重载」——钩子闸判红不再靠第一次 toast ③ e：在途写时关闭编辑器 → 此刻不重载 → 放行（成功 / route.abort 各一腿）→ 恰好重载一次
 *   ④ f：无关的在途写（页内 catalogTrackWrite 一个受控 Promise，抽屉打开前发起、打开后才结束）——修复批 2 当时的期望是「已打开的非 custom 抽屉重载恰好一次」，修复批 3 改判为「不重载」，见下一段；W103 补 LOW-5（stale 且 prevResult = fail：抽屉「验收状态暂不可用」，时间线也不标「验收后」）。
 *   页内变异 40 → 46：新增 w108-sync-no-hook-check / w108-no-hook-check / w108-reload-while-inflight / w108-no-settle-listener / w108-settle-before-count（CAT）/ w103-markat-ignores-view；
 *   预筛的临时探针 p-no-hook-precontainer / p-no-inflight / p-writes-renamed 现在判红，p-no-userfocus-check 维持等价（防御性分支，登记不补测试）——探针不进本套件，见 E:/tmp/mc77-c5/fix2/mk_probe_quick.js。
 * 追加（C5 修复批 3，缓存串仍 mcat17；CAT / CORE / normalize / 共享 CSS 未改，改的是 Model_Center.html 与本测试）：抽屉只为「它自己发起的保存」刷新（主会话改判，预筛复看 2026-10-11：无关写引起的意外重载会把焦点移到关闭按钮、丢字段搜索词，用户接着敲空格 / 回车会把抽屉关掉）——
 *   ctx.hookSeen（这个抽屉打开期间观察到过带钩子的弹窗开着，只增不减，重载换新 ctx 归零）加进重载条件；W108f 改期望为「无关的写结束不重载」（详情 / 变更日志请求数不变、搜索框文字与焦点保留），新增 W108e3（只有被扣住的一次写，让 CAT 的「派发早于计数 +1」在 e 段判红）/ W108f2（登记的残余现状）/
 *   W108g（写在途时先关编辑器再开只读弹窗：放行后不重载，Esc 关闭后恰好重载一次、焦点回「验收记录 →」）；页内变异 46 → 51：新增 w108-ignore-hookseen / w108-hookseen-only-in-listener / w108-hookseen-only-in-sync / w108-settle-ignores-modal / w108-settle-only-on-success（CAT）；变异驱动日志名带运行序号（同一变异重跑不覆盖前一次）。
 * 追加（C5 修复批 4，缓存串仍 mcat17；改的是 Model_Center.html 与本测试）：hookSeen 改为「按证据记录」（主会话裁定，预筛复看 2026-10-11：观察式记录在竞态下会被外来的钩子弹窗触发、判据也能被放宽而测试不报）——
 *   custom 抽屉「查看 DDL →」的 click 处理里直接置真，删除 mdcNoteHookSeen 及其两处调用；W108d 口径改为「换模型后在编辑器里再保存、关闭，不重载新模型」；W108f 放行前先开关一次「验收记录 →」；W108f2 补「至多一次」；
 *   页内变异 51 → 53：删去修复批 3 的 w108-hookseen-only-in-listener / w108-hookseen-only-in-sync（记录点随观察式记录一起删除，变异已无对象），新增 w108-hookseen-not-set-on-click / w108-hookseen-on-readonly / w108-hookseen-carry-on-reload / w108-hookseen-carry-on-switch。
 * 追加（C5 修复批 5，只改测试与注释，实现不动；缓存串仍 mcat17）：W108 补 d2（#50 打开期间有无关写结束后换到 #58、点「查看 DDL →」不写就关 → #58 不重载：钉住写入基数按 ctx 重置，撤回修复批 4 把 w108-base-not-per-ctx 登记为等价的说法）/
 *   h（外来编辑器竞态挂到 #50 上 → 关掉 → 无关写结束 → #50 不重载：钉住 hookSeen 不能挪到编辑器挂载处置真）；页内变异 53 → 54：新增 w108-hookseen-at-mount；等价变异由 4 个降为 3 个（eq107-* 三个）。
 * 追加（C5 codex 44 收口批，四轮 0 HIGH / 7 MED / 3 LOW；缓存串仍 mcat17；产品代码只改 mdcNormTime：整串严格解析 + 日期 / 时分秒范围校验，后缀仍不换算）：
 *   W106 补非法时间（日志侧与验收侧）/ 闰年 / 验收侧 T·小数秒·Z·偏移量 / CASES 前提读同一次快照的「最近验收」；W102·W103 的 c5Read / c5AccOk 读状态文字·徽标·reason 各自的可见性、期望无徽标时徽标节点必须不存在；W104 补非空说明首尾空白原样保留；
 *   W107 补 c / d（响应头已到、res.json() 被扣住时切换，页内包 Response.prototype.json）、b 改正向信号顺序，eq107-guards-only-off 撤回等价并改名 w107-guards-only-off；页内变异 54 → 60：新增 w102-recheck-hidden / w102-reason-hidden / w104-prose-trimmed / w106-normtime-prefix-only / w106-normtime-no-range / w106-normtime-convert-zone，改名 1 个。
 * 隔离实例 / 库副本 / 账号夹具：自 test-model-workbench-playwright.js 逐字复制（复制日期 2026-10-07，由 E:/tmp/mc77-c4/c4b2/gen_catalog_test.js 生成，不手抄），
 *   夹具裁成 C3a-0 的 36 行（去掉配置台套件追加的 #70 / #71）；库副本放 MC_CAT_WORKDIR（默认 E:/tmp/mc77-c4/c4b2/pw-cat-run），运行结束删除。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const FIX_DIR = path.join(__dirname, 'fixtures', 'model-workbench-baseline');
const MODELS_FILE = path.join(FIX_DIR, 'models.json');
const PORT_ARG = (process.argv.slice(2).find(a => a.startsWith('--port=')) || '').slice('--port='.length);   // C4b：可指定端口（默认 3377），主工作区的其他 agent 占用 3377 时用
if (PORT_ARG && !/^\d{2,5}$/.test(PORT_ARG)) { console.error('--port 必须是数字：' + PORT_ARG); process.exit(2); }
const PORT = PORT_ARG ? Number(PORT_ARG) : 3377;
const BASE = `http://localhost:${PORT}`;
const WORKDIR = process.env.MC_CAT_WORKDIR || (fs.existsSync('E:/tmp') ? 'E:/tmp/mc77-c4/c4b2/pw-cat-run' : path.join(os.tmpdir(), 'mc77-c4b2-pw-cat-run'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// 隔离实例（逐字取自 test-model-workbench-baseline-playwright.js 的「夹具与隔离库」段）
// ---------------------------------------------------------------------------------------------
const FIXTURE_IDS = { dim: [50, 55, 60, 62, 65], dwd: [52, 59], dimCustom: 58, dwdCompanion: 53, ods: [6, 8], deletedDim: 66 };
const FILLER_COUNT = 25;
const USERS = [
  { id: 1, username: 'admin', display_name: '管理员', role: 'admin' },
  { id: 2, username: 'viewer_user', display_name: '测试查看者', role: 'viewer' },
  { id: 3, username: 'owner_user', display_name: '测试负责人', role: 'user' },
  { id: 4, username: 'nonowner_user', display_name: '测试非负责人', role: 'user' },
];
const loadModelRows = () => JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')).rows;

function dbRun(db, sql, params = []) { return new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); })); }
function dbClose(db) { return new Promise((res, rej) => db.close(e => e ? rej(e) : res())); }
const tryUnlink = (f) => { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
const removeDbFiles = (dbPath) => { for (const s of ['', '-wal', '-shm', '-journal']) tryUnlink(dbPath + s); };

async function prepareDb(dbPath) {
  fs.mkdirSync(WORKDIR, { recursive: true });
  removeDbFiles(dbPath);
  const realDb = path.join(ROOT, 'task_pool.db');
  if (!fs.existsSync(realDb)) throw new Error('缺少 wbs-server/task_pool.db（包装器也要求它存在）');
  const src = await new Promise((res, rej) => { const d = new sqlite3.Database(realDb, sqlite3.OPEN_READONLY, e => e ? rej(e) : res(d)); });
  await dbRun(src, 'VACUUM INTO ?', [dbPath]);   // 一致性快照；VACUUM INTO 不写源库
  await dbClose(src);
  const db = await new Promise((res, rej) => { const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, e => e ? rej(e) : res(d)); });
  // 清外部副作用面：钉钉凭证 / 数仓连接 / 周期任务；清与模型关联的数据与账号
  for (const t of ['system_configs', 'db_connections', 'periodic_tasks', 'model_change_logs', 'model_test_records', 'task_pool', 'data_models', 'users', 'sys_domains', 'sys_source_systems']) {
    await dbRun(db, `DELETE FROM ${t}`);
  }
  // C4b（§C-19 / L10）：本机库将来若有实现对象登记，夹具同号行会挂上对象名；表存在才清（与 C4-0 驱动一致）
  for (const t of ['model_impl_links', 'model_impl_objects']) { const ex = await new Promise((res, rej) => db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t], (e, r) => e ? rej(e) : res(r))); if (ex) await dbRun(db, `DELETE FROM ${t}`); }
  for (const u of USERS) await dbRun(db, 'INSERT INTO users (id, username, password, display_name, role, status) VALUES (?, ?, ?, ?, ?, ?)', [u.id, u.username, 'not-used-jwt-only', u.display_name, u.role, 'active']);
  for (const [code, name] of [['dom_a', '域甲'], ['dom_b', '域乙'], ['dom_c', '域丙']]) await dbRun(db, "INSERT INTO sys_domains (code, name, description, status) VALUES (?, ?, '', 'active')", [code, name]);
  await dbRun(db, "INSERT INTO sys_domains (code, name, description, status) VALUES ('dom_old', '停用域', '', 'deprecated')");   // 2c W22：库里真有一条停用域；服务端 GET /api/domains 只返回 active，所以页面查不到它的名称，显示代码（P31）
  for (const [code, name] of [['SYS_A', '来源系统甲'], ['SYS_B', '来源系统乙']]) await dbRun(db, "INSERT INTO sys_source_systems (code, name, description) VALUES (?, ?, '')", [code, name]);
  const COLS = ['id', 'layer', 'domain', 'table_name', 'table_comment', 'tech_owner', 'biz_owner', 'update_cycle', 'status', 'created_at', 'updated_at', 'source_table', 'source_system', 'model_type', 'created_by_id', 'category', 'dim_config', 'is_deleted', 'config_mode', 'design_notes', 'companion_of'];
  const ins = (row) => dbRun(db, `INSERT INTO data_models (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map(c => (c === 'dim_config' ? (row.dim_config == null ? null : JSON.stringify(row.dim_config)) : (row[c] === undefined ? null : row[c]))));
  const rows = loadModelRows();
  for (const r of rows) await ins(r);
  // 软删除夹具：62 的副本（CREATED 状态、is_deleted=1），用于解释「?validate=1 不开弹窗」
  const r62 = rows.find(r => r.id === 62);
  await ins({ ...r62, id: FIXTURE_IDS.deletedDim, table_name: r62.table_name + '_gone', is_deleted: 1 });
  // 填充 ODS（按表名排序排在 ods_w* 之前，让 DIM/DWD 夹具在第 1 页、ODS#6/#8 在第 2 页，列表跨页）
  for (let i = 1; i <= FILLER_COUNT; i++) {
    const nn = String(i).padStart(2, '0');
    await ins({ id: 100 + i, layer: 'ods', domain: '', table_name: `ods_filler_${nn}_df`, table_comment: '填充', tech_owner: '管理员', biz_owner: '', update_cycle: 'df', status: 'ONLINE', created_at: '2026-01-01 08:00:00', updated_at: '2026-01-02 08:00:00', source_table: `filler_${nn}`, source_system: 'SYS_A', model_type: 'TABLE', created_by_id: 1, category: 'general', dim_config: null, is_deleted: 0, config_mode: 'standard', design_notes: null, companion_of: null });
  }
  await dbClose(db);
}

function portBusy() {
  return new Promise((resolve) => {
    const s = net.createConnection({ port: PORT, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

let serverChild = null;
let serverKillIssued = false;
/** 只按自己 spawn 的 pid 停，同一 pid 只杀一次（exit 钩子与 finally 都可能调用） */
function killServer() {
  if (!serverChild || !serverChild.pid || serverKillIssued || serverChild.__dead) return;
  serverKillIssued = true;
  try { spawnSync('taskkill', ['/T', '/F', '/PID', String(serverChild.pid)], { stdio: 'ignore' }); } catch (_) { /* 下面等 exit 事件 */ }
}
async function stopServerAndCleanup(dbPath) {
  killServer();
  const t0 = Date.now();
  while (serverChild && !serverChild.__dead && Date.now() - t0 < 10000) await sleep(100);
  if (serverChild && !serverChild.__dead) { console.error('[cleanup] 隔离实例进程未在 10s 内退出，库副本未删除：' + dbPath); return; }
  try { removeDbFiles(dbPath); } catch (e) { console.error('[cleanup] 删除库副本失败：' + e.message); }
}
async function startServer(dbPath) {
  const logPath = path.join(WORKDIR, 'server.log');
  const fd = fs.openSync(logPath, 'w');
  serverChild = spawn(process.execPath, [path.join(ROOT, 'scripts', '_test-it-asset-ledger-server-wrapper.js')], {
    cwd: ROOT, stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(PORT), IA_TEST_DB_PATH: dbPath, SYS_FASTLANE_ENABLE: '0', LOG_LEVEL: 'INFO' },
  });
  fs.closeSync(fd);
  serverChild.on('exit', () => { serverChild.__dead = true; });
  const t0 = Date.now();
  for (;;) {
    if (serverChild.__dead) throw new Error('隔离实例提前退出，见日志 ' + logPath + '：\n' + fs.readFileSync(logPath, 'utf8').slice(-1500));
    if (/Task Pool Server running/.test(fs.readFileSync(logPath, 'utf8'))) return;
    if (Date.now() - t0 > 60000) throw new Error('隔离实例 60s 内未就绪，见日志 ' + logPath);
    await sleep(250);
  }
}


// ---------------------------------------------------------------------------------------------
// 用例（C4b 新增；C4c 在本文件上扩展）。夹具 = C3a-0：11 行共享夹具 + #66 软删除 + 25 填充 ODS ⇒ 列表 36 行 / 35 组（唯一伴生 #53 随 #52）。
//   默认序（table_name 升序）按组：60,50,55,58,62,65,[52,53],59,101..125,6,8；第 1 页 20 组 = 21 行（101..112），第 2 页 15 组（113..125,6,8）。
//   「它锁的是什么」写在每个用例的第一个 check 名里；期望值全部手写。
// ---------------------------------------------------------------------------------------------
const WAIT = 15000;
const MUT = process.env.MC_MUT || '';   // 变异开关（仅用于判别力自证；正常运行为空）：stale-noop（reloadCatalogIfStale 换空函数）/ no-token（loadModels 去掉令牌核对）
// 2c：改 model-catalog.js 源码的页内变异（见头部说明）。每项 edits = [[锚点, 替换]…]（锚点须在 CAT 源码里恰好出现 1 次），probe = 页面装载后必须为真的表达式（确认变异生效）
const OLD_MUTS = ['clock-leak', 'stale-noop', 'no-token', 'inflight-immediate', 'reopen-ignore', 'no-dedupe', 'seen-at-arrival', 'seen-on-failure', 'done-not-counted', 'companion-sends-mode', 'companion-list-priority', 'companion-editmodel-only', 'err-domains-500-in-w52a', 'w5b-pageerror', 'w76-source-fails'];
const CAT_MUTS = {
  'dispatch-cached': { edits: [['function catalogCall(name, args) {', 'const catalogCallCache = {};\nfunction catalogCall(name, args) {'], ['return window[name].apply(window, args);', 'return (catalogCallCache[name] || (catalogCallCache[name] = window[name])).apply(window, args);']], probe: "typeof catalogCallCache === 'object'" },
  'delete-force': { edits: [["catalogCall('deleteModel', [m.id]);", "catalogCall('deleteModel', [m.id, true]);"]], probe: "catalogDispatchAct.toString().includes('[m.id, true]')" },
  'aria-unchecked': { edits: [["if (actEl.disabled || actEl.getAttribute('aria-disabled') === 'true') return;", 'if (actEl.disabled) return;']], probe: "!catalogBindList.toString().includes('aria-disabled')" },
  'disabled-unchecked': { edits: [["if (actEl.disabled || actEl.getAttribute('aria-disabled') === 'true') return;", "if (actEl.getAttribute('aria-disabled') === 'true') return;"]], probe: "!catalogBindList.toString().includes('actEl.disabled')" },
  'notes-noescape': { edits: [['showDesignNotesPopover(btn, escapeHtml(m.design_notes));', 'showDesignNotesPopover(btn, m.design_notes);']], probe: "!catalogDispatchNotes.toString().includes('escapeHtml')" },
  'domain-rerender': { edits: [['catalogApplyDomainNames();', 'renderModelsPage();']], probe: "catalogLoadDomains.toString().includes('renderModelsPage()')" },
  'dispatch-else-dwd': { edits: [["else if (isDWD) catalogCall('openDwdDDLModal', [m.id]);", "else catalogCall('openDwdDDLModal', [m.id]);"], ["else if (isDWD) catalogCall('openDwdScriptModal', [m.id]);", "else catalogCall('openDwdScriptModal', [m.id]);"], ["else if (isDWD) catalogCall('openDwdConfigViewModal', [m.id]);", "else catalogCall('openDwdConfigViewModal', [m.id]);"]], probe: "!catalogDispatchAct.toString().includes('else if (isDWD)')" },
  'catalog-call-noguard': { edits: [["if (typeof window[name] !== 'function') {", 'if (false) {']], probe: "catalogCall.toString().includes('if (false) {')" },
  'catalog-call-extra-error': { edits: [["console.error('[catalog] 处理函数不存在：' + name);", "console.error('[catalog] 处理函数不存在：' + name); console.error('[catalog] 额外的一条 error');"]], probe: "catalogCall.toString().includes('额外的一条 error')" },
  'domain-sort-by-name': { file: 'model-catalog-core.js', edits: [["return { table_name: isBlankDomain(row.domain) ? null : row.domain };", "return { table_name: isBlankDomain(row.domain) ? null : (typeof catalogDomainText === 'function' ? catalogDomainText(row.domain) : row.domain) };"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => t.includes('catalogDomainText(row.domain)'))" },
  'search-skip-objnames': { file: 'model-catalog-core.js', edits: [["if (Array.isArray(row.impl_obj_names)) fields = fields.concat(row.impl_obj_names);", '']], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => !t.includes('fields.concat(row.impl_obj_names)'))" },
  'notes-keep-listener': { edits: [["document.removeEventListener('click', closeDesignNotesPopover);", '']], probe: "!catalogDispatchNotes.toString().includes('removeEventListener')" },
  // —— C4c-3 子批 3a 新增（展开区）：改 model-catalog.js 的 33 个 + 改 model-catalog-core.js 的 4 个（file 字段）；每个变异装载后用页内探针确认生效，不成立直接抛错
  'toggle-act': { edits: [["className: 'catalog-expand-btn', type: 'button', 'data-expand-toggle': true,", "className: 'catalog-expand-btn', type: 'button', 'data-expand-toggle': true, 'data-act': 'history',"]], probe: "catalogBuildExpandToggle.toString().includes(\"'data-act': 'history'\")" },
  'toggle-second': { edits: [["catalogBuildExpandToggle(m, expanded),\n                catalogEl('span', { className: 'catalog-layer ' + (catalogLayerClass[layer] || 'catalog-layer-other'), text: layer }),", "catalogEl('span', { className: 'catalog-layer ' + (catalogLayerClass[layer] || 'catalog-layer-other'), text: layer }),\n                catalogBuildExpandToggle(m, expanded),"]], probe: "catalogBuildEntry.toString().indexOf('catalogBuildExpandToggle(m, expanded)') > catalogBuildEntry.toString().indexOf('catalog-layer-other')" },
  'toggle-no-select': { edits: [["if (entry && list.contains(entry)) catalogSelectEntry(entry);", "if (entry && list.contains(entry) && !t.closest('[data-expand-toggle]')) catalogSelectEntry(entry);"]], probe: "catalogBindList.toString().includes(\"!t.closest('[data-expand-toggle]')\")" },
  'pane-first': { edits: [["else if (pane) entry.appendChild(pane);", "else if (pane) entry.insertBefore(pane, entry.firstChild);"]], probe: "catalogApplyPane.toString().includes('entry.insertBefore(pane')" },
  'up-no-links': { edits: [["hit && String(hit.id) !== String(m.id) ? catalogModelLink(hit.id, name)", "false && hit && String(hit.id) !== String(m.id) ? catalogModelLink(hit.id, name)"]], probe: "catalogBuildUpstream.toString().includes('false && hit')" },
  'down-no-hint': { edits: [["kids.push(catalogEl('div', { className: 'catalog-flow-hint', text: '按平台配置候选匹配' }));", ""]], probe: "!catalogBuildDownstream.toString().includes('按平台配置候选匹配')" },
  'badge-tone-fixed': { edits: [["const tone = known ? ModelCatalogCore.IMPL_BADGE_TONE[code] : 'muted';", "const tone = 'muted';"]], probe: "catalogBuildImplBadge.toString().includes(\"const tone = 'muted';\")" },
  'badge-label-raw': { edits: [["(known ? labels[code] : String(code))", "String(code)"]], probe: "!catalogBuildImplBadge.toString().includes('labels[code]')" },
  'objstate-all-standard': { edits: [["} else if (st === 'standard') {", "} else if (st !== 'companion') {"]], probe: "catalogBuildObjectBox.toString().includes(\"st !== 'companion'\")" },
  'companion-up-api': { edits: [["if (m.companion_of) {", "if (false && m.companion_of) {"]], probe: "catalogBuildUpstream.toString().includes('false && m.companion_of')" },
  'relations-no-token': { edits: [["{ id: id, token: token, ok: got.ok, data: got.data }", "{ id: id, token: catalogEventState.expandTokens[String(id)], ok: got.ok, data: got.data }"]], probe: "catalogFetchRelations.toString().includes('catalogEventState.expandTokens')" },
  'retry-as-toggle': { edits: [["ModelCatalogCore.retryExpand(catalogSyncState(), { id: id })", "ModelCatalogCore.toggleExpand(catalogSyncState(), { id: id })"]], probe: "catalogRetryExpand.toString().includes('toggleExpand')" },
  'error-toast': { edits: [["if (!res || !res.ok) return { ok: false };", "if (!res || !res.ok) { showToast('关系加载失败', 'error'); return { ok: false }; }"]], probe: "catalogRequestRelations.toString().includes(\"showToast('关系加载失败'\")" },
  'sort-collapses': { edits: [["catalogEventState = r.state;\n                    currentSortBy = r.state.sortBy;", "catalogEventState = Object.assign({}, r.state, { expanded: [] });\n                    currentSortBy = r.state.sortBy;"]], probe: "initListSorting.toString().includes('expanded: []')" },
  'reload-no-effects': { edits: [["catalogRunEffects(arrived.effects);", ""]], probe: "!loadModels.toString().includes('catalogRunEffects')" },
  'collapse-all-noop': { edits: [["ids.forEach(id => { s = ModelCatalogCore.toggleExpand(s, { id: id }).state; });", ""]], probe: "!catalogCollapseAll.toString().includes('toggleExpand')" },
  'no-page-intersect': { edits: [["return expanded.map(String).filter(id => onPage.has(id));", "return expanded.map(String);"]], probe: "catalogExpandedOnPage.toString().includes('return expanded.map(String);')" },
  'pane-link-innerhtml': { edits: [["return catalogEl('button', { className: 'catalog-model-link', type: 'button', 'data-open-model': String(modelId), text: text });", "const b = catalogEl('button', { className: 'catalog-model-link', type: 'button', 'data-open-model': String(modelId) }); b.innerHTML = text; return b;"]], probe: "catalogModelLink.toString().includes('b.innerHTML')" },
  'toggle-style-attr': { edits: [["function catalogBuildExpandToggle(m, expanded) {\n            return catalogEl(", "function catalogBuildExpandToggle(m, expanded) {\n            const bx = catalogEl('button', { type: 'button', 'data-expand-toggle': true, 'aria-expanded': expanded ? 'true' : 'false', 'aria-controls': 'pane-' + String(m.id), text: '▶' }); bx.setAttribute('style', 'color:red'); return bx;\n            return catalogEl("]], probe: "catalogBuildExpandToggle.toString().includes(\"setAttribute('style'\")" },
  'up-link-includes': { edits: [["const hits = allModelsData.filter(r => catalogAsciiLower(r.table_name === null || r.table_name === undefined ? '' : r.table_name) === key);", "const hits = allModelsData.filter(r => catalogAsciiLower(r.table_name === null || r.table_name === undefined ? '' : r.table_name).includes(key));"]], probe: "catalogRowByTableName.toString().includes(').includes(key));')" },
  'obj-name-innerhtml': { edits: [["catalogEl('td', { className: 'catalog-obj-name', title: catalogText(o.summary), text: (o.schema_name ? String(o.schema_name) + '.' : '') + catalogText(o.obj_name) }),", "(() => { const t = catalogEl('td', { className: 'catalog-obj-name', title: catalogText(o.summary) }); t.innerHTML = (o.schema_name ? String(o.schema_name) + '.' : '') + catalogText(o.obj_name); return t; })(),"]], probe: "catalogBuildObjectTable.toString().includes('t.innerHTML')" },
  'down-desc-innerhtml': { edits: [["catalogEl('span', { className: 'catalog-flow-desc', text: String(d.table_comment) })", "(() => { const s = catalogEl('span', { className: 'catalog-flow-desc' }); s.innerHTML = String(d.table_comment); return s; })()"]], probe: "catalogBuildDownstream.toString().includes('s.innerHTML')" },
  'viewer-no-toggle': { edits: [["catalogBuildExpandToggle(m, expanded),", "isViewer ? null : catalogBuildExpandToggle(m, expanded),"]], probe: "catalogBuildEntry.toString().includes('isViewer ? null : catalogBuildExpandToggle')" },
  'toggle-no-controls': { edits: [["'aria-expanded': expanded ? 'true' : 'false', 'aria-controls': 'pane-' + String(m.id),", "'aria-expanded': expanded ? 'true' : 'false',"]], probe: "!catalogBuildExpandToggle.toString().includes('aria-controls')" },
  'relations-wrong-path': { edits: [["encodeURIComponent(String(id)) + '/relations'", "encodeURIComponent(String(id)) + '/relation'"]], probe: "catalogRequestRelations.toString().includes(\"'/relation')\")" },
  'obj-role-empty': { edits: [["text: o.role ? String(o.role) : '—' }", "text: o.role ? String(o.role) : '' }"]], probe: "catalogBuildObjectTable.toString().includes(\"String(o.role) : '' }\")" },
  'obj-time-empty': { edits: [["text: o.verified_at ? String(o.verified_at) : '—' }", "text: o.verified_at ? String(o.verified_at) : '' }"]], probe: "catalogBuildObjectTable.toString().includes(\"String(o.verified_at) : '' }\")" },
  'null-badge-double': { edits: [["? [catalogBuildImplBadge('doc', null)]", "? [catalogBuildImplBadge('doc', null), catalogBuildImplBadge('reg', null)]"]], probe: "catalogObjBadgeKids.toString().includes(\"catalogBuildImplBadge('reg', null)\")" },
  'failed-title-generic': { edits: [["if (code === 'verify_failed' && catalogIsObj(failure)) hint =", "if (false && code === 'verify_failed' && catalogIsObj(failure)) hint ="]], probe: "catalogBuildImplBadge.toString().includes(\"false && code === 'verify_failed'\")" },
  'listed-hint-missing': { edits: [[", catalogEl('div', { className: 'catalog-flow-hint', text: '核验超过 7 天自动降为「待重核」' })]", "]"]], probe: "!catalogBuildObjectBox.toString().includes('核验超过 7 天')" },
  'ods-sep': { edits: [["parts.join(' · ')", "parts.join('/')"]], probe: "catalogBuildUpstream.toString().includes(\"parts.join('/')\")" },
  'render-no-panes': { edits: [["expandedHere.forEach(key => entryEls.get(key).appendChild(catalogMakePane(key)));", ""]], probe: "!renderModelsPage.toString().includes('catalogMakePane')" },
  'plain-innerhtml': { edits: [["catalogEl('span', { className: 'catalog-plain', text: name })", "(() => { const s = catalogEl('span', { className: 'catalog-plain' }); s.innerHTML = name; return s; })()"]], probe: "catalogBuildUpstream.toString().includes('s.innerHTML = name')" },
  'setquery-keeps-expand': { file: 'model-catalog-core.js', edits: [["c.query = q;\n        c.page = 1;\n        clearExpand(c);", "c.query = q;\n        c.page = 1;"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => !/c\\.query = q;\\s*c\\.page = 1;\\s*clearExpand/.test(t))" },
  'goto-keeps-expand': { file: 'model-catalog-core.js', edits: [["c.page = p;\n        clearExpand(c);", "c.page = p;"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => !/c\\.page = p;\\s*clearExpand/.test(t))" },
  'reload-keeps-offpage': { file: 'model-catalog-core.js', edits: [["c.expanded = S.expanded.filter(function (id) { return onPage.get(String(id)) === true; });", "c.expanded = S.expanded.slice();"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => t.includes('c.expanded = S.expanded.slice();'))" },
  // —— C4c-3 子批 3d 新增（codex 40 收口）
  'fail-notice-hidden': { edits: [["box.hidden = false;",""]], probe: "!catalogSyncListState.toString().includes('box.hidden = false')" },
  'apply-before-event': { edits: [["const arrived = ModelCatalogCore.listArrived(catalogSyncState(), { token, rows });","allModelsData = rows; const arrived = ModelCatalogCore.listArrived(catalogSyncState(), { token, rows });"]], probe: "loadModels.toString().includes('allModelsData = rows; const arrived')" },
  'fail-resets-page': { edits: [["catalogListError = true;\n            catalogSyncListState();","catalogListError = true;\n            currentPage = 1;\n            catalogSyncListState();"]], probe: "catalogFailList.toString().includes('currentPage = 1')" },
  'reload-first-only': { edits: [["(effects || []).forEach(e => {","(effects || []).slice(0, 1).forEach(e => {"]], probe: "catalogRunEffects.toString().includes('.slice(0, 1)')" },
  'up-exclude-self-first': { edits: [["const hit = name === '' ? null : catalogRowByTableName(name);","const hit = name === '' ? null : (() => { const k = catalogAsciiLower(name); const hs = allModelsData.filter(r => String(r.id) !== String(m.id) && catalogAsciiLower(r.table_name === null || r.table_name === undefined ? '' : r.table_name) === k); return hs.length === 1 ? hs[0] : null; })();"]], probe: "catalogBuildUpstream.toString().includes('String(r.id) !== String(m.id)')" },
  'focus-prefetch-relations': { file: 'Model_Center.html', edits: [["focusCatalogModel(focusParam);","focusCatalogModel(focusParam); if (allModelsData.some(m => String(m.id) === String(focusParam) && Number(m.id) < 9000)) authFetch('/api/models/' + encodeURIComponent(focusParam) + '/relations').catch(() => {});"]], probe: "Array.from(document.scripts).some((s) => s.textContent.includes(\"'/relations').catch(() => {});\"))" },
  'load-dedupe-inflight': { edits: [["async function loadModels() {","let catalogInflightP = null;\n        function loadModels() { if (catalogInflightP) return catalogInflightP; const p = catalogLoadModelsReal().finally(() => { if (catalogInflightP === p) catalogInflightP = null; }); catalogInflightP = p; return p; }\n        async function catalogLoadModelsReal() {"]], probe: "loadModels.toString().includes('catalogInflightP')" },
  'load-waits-relations': { edits: [["catalogRunEffects(arrived.effects);","await Promise.all((arrived.effects || []).filter(e => e && e.type === 'fetch-relations').map(e => catalogFetchRelations(e.id, e.token)));"]], probe: "loadModels.toString().includes('await Promise.all')" },
  'companion-skips-loading': { edits: [["return catalogBuildPane(m, st.expandStatus[key], st.relations[key]);","return catalogBuildPane(m, m.companion_of && st.expandStatus[key] === 'loading' ? 'loaded' : st.expandStatus[key], st.relations[key]);"]], probe: "catalogMakePane.toString().includes(\"'loading' ? 'loaded'\")" },
  'no-page-intersect-inverted': { edits: [["return expanded.map(String).filter(id => onPage.has(id));","return expanded.map(String).filter(id => !onPage.has(id));"]], probe: "catalogExpandedOnPage.toString().includes('!onPage.has(id)')" },
  'fail-discard-inverted': { edits: [["if (r.effects.some(e => e.type === 'discard-list')) return 'discarded';","if (!r.effects.some(e => e.type === 'discard-list')) return 'discarded';"]], probe: "catalogFailList.toString().includes(\"if (!r.effects.some(e => e.type === 'discard-list'))\")" },
  'up-input-only': { edits: [["const key = catalogAsciiLower(name);","const key = catalogAsciiLower(catalogAsciiLower(name));"],["const hits = allModelsData.filter(r => catalogAsciiLower(r.table_name === null || r.table_name === undefined ? '' : r.table_name) === key);","const hits = allModelsData.filter(r => String(r.table_name === null || r.table_name === undefined ? '' : r.table_name) === key);"]], probe: "catalogRowByTableName.toString().includes('catalogAsciiLower(catalogAsciiLower(name))')" },
  'rel-validate-top-only': { edits: [["return d.upstream.every(upOk) && d.downstream.every(downOk) && d.objects.every(objOk);","return true;"]], probe: "catalogValidRelations.toString().includes('return true;')" },
  // —— C4c-3 子批 3c 新增（预筛 LOW-1 / LOW-3 / LOW-4）
  'fail-nonarray-silent': { edits: [["if (!Array.isArray(rows)) return catalogFailList(token);", "if (!Array.isArray(rows)) return (catalogEventState = ModelCatalogCore.listFailed(catalogSyncState(), { token: token }).state, 'failed');"]], probe: "loadModels.toString().includes(\"listFailed(catalogSyncState(), { token: token }).state, 'failed')\")" },
  'fail-catch-silent': { edits: [["return catalogFailList(myToken);", "return (catalogEventState = ModelCatalogCore.listFailed(catalogSyncState(), { token: myToken }).state, 'failed');"]], probe: "loadModels.toString().includes('{ token: myToken }).state')" },
  'up-self-link': { edits: [["hit && String(hit.id) !== String(m.id) ? catalogModelLink", "hit ? catalogModelLink"]], probe: "catalogBuildUpstream.toString().includes('hit ? catalogModelLink')" },
  'ready-needs-rows': { edits: [["const state = catalogListError ? 'error' : (catalogListApplied ? 'ready' : '');", "const state = catalogListError ? 'error' : (allModelsData.length > 0 ? 'ready' : '');"]], probe: "catalogSyncListState.toString().includes('allModelsData.length > 0')" },
  'empty-before-data': { edits: [["if (view.totalModels === 0 && catalogListApplied) frag.appendChild(", "if (view.totalModels === 0) frag.appendChild("]], probe: "renderModelsPage.toString().includes('if (view.totalModels === 0) frag.appendChild(')" },
  'catch-no-warn': { edits: [["console.warn('[模型目录] 列表加载失败：', e && e.message); ", ""]], probe: "!loadModels.toString().includes('console.warn(')" },
  'init-gate-failed-only': { file: 'Model_Center.html', edits: [["if (loadResult !== 'arrived') return;", "if (loadResult === 'failed') return;"]], probe: "Array.from(document.scripts).some((s) => s.textContent.includes(\"if (loadResult === 'failed') return;\")) && !Array.from(document.scripts).some((s) => s.textContent.includes(\"if (loadResult !== 'arrived') return;\"))" },
  // —— C4c-3 子批 3b 新增（列表失败 / ready / 三态返回 / 初始化门 / 上游名口径）
  'fail-no-notice': { edits: [["if (!catalogListError) { box.replaceChildren(); box.hidden = true; return; }", "if (true) { box.replaceChildren(); box.hidden = true; return; }"]], probe: "catalogSyncListState.toString().includes('if (true) { box.replaceChildren()')" },
  'ready-before-data': { edits: [["const state = catalogListError ? 'error' : (catalogListApplied ? 'ready' : '');", "const state = catalogListError ? 'error' : 'ready';"]], probe: "catalogSyncListState.toString().includes(\"catalogListError ? 'error' : 'ready'\")" },
  'fail-no-core': { edits: [["const r = ModelCatalogCore.listFailed(catalogSyncState(), { token: token });", "const r = { state: catalogSyncState(), effects: [] };"]], probe: "!catalogFailList.toString().includes('listFailed')" },
  'fail-toast': { edits: [["catalogListError = true;\n            catalogSyncListState();", "catalogListError = true;\n            showToast('列表刷新失败', 'error');\n            catalogSyncListState();"]], probe: "catalogFailList.toString().includes(\"showToast('列表刷新失败'\")" },
  'fail-wipes-data': { edits: [["catalogListError = true;\n            catalogSyncListState();", "catalogListError = true;\n            allModelsData = []; renderModelsPage();\n            catalogSyncListState();"]], probe: "catalogFailList.toString().includes('allModelsData = []')" },
  'fail-never-error': { edits: [["const state = catalogListError ? 'error' : (catalogListApplied ? 'ready' : '');", "const state = catalogListApplied ? 'ready' : '';"]], probe: "catalogSyncListState.toString().includes(\"const state = catalogListApplied ? 'ready' : '';\")" },
  'retry-no-request': { edits: [["loadModels().catch(e => console.warn('[模型目录] 列表重试失败：', e && e.message));", ""]], probe: "!catalogRetryList.toString().includes('loadModels')" },
  'success-keeps-error': { edits: [["catalogListApplied = true; catalogListError = false;", "catalogListApplied = true;"]], probe: "!loadModels.toString().includes('catalogListError = false')" },
  'ret-true': { edits: [["return 'arrived';", "return true;"]], probe: "loadModels.toString().includes('return true;')" },
  'discard-undefined': { edits: [["return 'discarded';   // 被更新的请求取代：由取代它的那次请求负责结果", "return;   // 被更新的请求取代：由取代它的那次请求负责结果"]], probe: "loadModels.toString().includes('listToken !== token) return;')" },
  'net-error-throws': { edits: [["if (myToken !== 0 && catalogEventState.listToken === myToken) { console.warn('[模型目录] 列表加载失败：', e && e.message); return catalogFailList(myToken); }", ""]], probe: "!loadModels.toString().includes('catalogFailList(myToken)')" },
  'init-no-gate': { file: 'Model_Center.html', edits: [["if (loadResult !== 'arrived') return;", ""]], probe: "Array.from(document.scripts).some((s) => s.textContent.includes('loadModels().then(async (loadResult)')) && !Array.from(document.scripts).some((s) => s.textContent.includes(\"if (loadResult !== 'arrived') return;\"))" },
  'up-case-sensitive': { edits: [["const hits = allModelsData.filter(r => catalogAsciiLower(r.table_name === null || r.table_name === undefined ? '' : r.table_name) === key);", "const hits = allModelsData.filter(r => String(r.table_name) === String(name));"]], probe: "catalogRowByTableName.toString().includes('=== String(name)')" },
  'up-first-hit': { edits: [["return hits.length === 1 ? hits[0] : null;", "return hits.length >= 1 ? hits[0] : null;"]], probe: "catalogRowByTableName.toString().includes('hits.length >= 1')" },
  'up-to-lowercase': { edits: [["return String(s).replace(/[A-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 32); });", "return String(s).toLowerCase();"]], probe: "catalogAsciiLower.toString().includes('toLowerCase()')" },
  // —— C4c-4 子批 4a 新增（页头 / 工具条 / P36 页面层 / 筛选单一来源）：改 model-catalog.js 的、改 model-catalog-core.js 的、改 Model_Center.html 的
  'total-groups': { edits: [["el.textContent = String(ModelCatalogCore.railCounts(allModelsData).total);", "el.textContent = String(getCatalogView().totalGroups);"]], probe: "catalogUpdateTotal.toString().includes('totalGroups')" },
  'total-fail-zero': { edits: [["catalogListError = true;\n            catalogSyncListState();", "catalogListError = true;\n            { const tc = document.getElementById('catalogTotalCount'); if (tc) tc.textContent = '0'; }\n            catalogSyncListState();"]], probe: "catalogFailList.toString().includes(\"tc.textContent = '0'\")" },
  'total-placeholder-zero': { file: 'Model_Center.html', edits: [['在册 <span id="catalogTotalCount">—</span> 个模型', '在册 <span id="catalogTotalCount">0</span> 个模型']], probe: "fetch(location.pathname).then((r) => r.text()).then((t) => t.includes('<span id=\"catalogTotalCount\">0</span>'))" },
  'h1-hidden': { file: 'Model_Center.html', edits: [['.catalog-pagehead h1 { display: block; margin: 0;', '.catalog-pagehead h1 { margin: 0;']], probe: "getComputedStyle(document.querySelector('.catalog-pagehead h1')).display === 'none'" },
  'register-viewer-visible': { file: 'Model_Center.html', edits: [["if (registerNewBtn) registerNewBtn.style.display = 'none';", '']], probe: "!Array.from(document.scripts).some((s) => s.textContent.includes(\"registerNewBtn.style.display = 'none'\"))" },
  'register-wrong-target': { file: 'Model_Center.html', edits: [["onclick=\"window.location.href='Model_Workbench.html'\">＋ 注册新模型", "onclick=\"window.location.href='Model_Center.html'\">＋ 注册新模型"]], probe: "document.getElementById('registerNewModelBtn').getAttribute('onclick').includes('Model_Center.html')" },
  'batch-import-noop': { file: 'Model_Center.html', edits: [['onclick="openBatchImportModal()"\n                    style="background:#10b981; color:white;">', 'onclick="void 0"\n                    style="background:#10b981; color:white;">']], probe: "!Array.from(document.querySelectorAll('.catalog-pageactions button')).some((b) => (b.getAttribute('onclick') || '').includes('openBatchImportModal'))" },
  'toolbar-extra-sort-key': { file: 'Model_Center.html', edits: [['<button type="button" class="catalog-sort-btn" data-sort-by="id">ID<span class="sort-icon">⇅</span></button>\n', '<button type="button" class="catalog-sort-btn" data-sort-by="id">ID<span class="sort-icon">⇅</span></button>\n                    <button type="button" class="catalog-sort-btn" data-sort-by="layer">分层<span class="sort-icon">⇅</span></button>\n']], probe: "document.querySelectorAll('.catalog-toolbar button[data-sort-by]').length === 4" },
  'toolbar-oninput-no-composing': { file: 'Model_Center.html', edits: [['oninput="if (!event.isComposing) applyCatalogSearch()"', 'oninput="applyCatalogSearch()"']], probe: "document.getElementById('searchKeyword').getAttribute('oninput') === 'applyCatalogSearch()'" },
  'p36-oldquery-sync': { edits: [["ModelCatalogCore.setQuery(Object.assign({}, catalogSyncState(), { query: catalogRenderedQuery }), getCatalogQuery())", "ModelCatalogCore.setQuery(catalogSyncState(), getCatalogQuery())"]], probe: "applyCatalogSearch.toString().includes('setQuery(catalogSyncState(), getCatalogQuery())')" },
  'p36-no-rendered-record': { edits: [["catalogRenderedQuery = getCatalogQuery();", ""]], probe: "!renderModelsPage.toString().includes('catalogRenderedQuery')" },
  'p36-core-no-guard': { file: 'model-catalog-core.js', edits: [["if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (false) {"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => t.includes('if (false) {'))" },
  'p36-core-no-trim': { file: 'model-catalog-core.js', edits: [["if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q) === String(S.query === null || S.query === undefined ? '' : S.query)) {"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => t.includes(\"String(q === null || q === undefined ? '' : q) === String(S.query\"))" },
  'p36-case-fold': { file: 'model-catalog-core.js', edits: [["if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q).trim().toLowerCase() === String(S.query === null || S.query === undefined ? '' : S.query).trim().toLowerCase()) {"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => t.includes('.trim().toLowerCase() === String(S.query'))" },
  'p36-goto-no-guard': { file: 'model-catalog-core.js', edits: [["if (p === S.page) return { state: c, effects: [] };", ""]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => !t.includes('p === S.page'))" },
  'filters-sync-empty': { edits: [["sortDir: currentSortDir, query: getCatalogQuery(), filters: catalogFilters,", "sortDir: currentSortDir, query: getCatalogQuery(), filters: {},"]], probe: "catalogSyncState.toString().includes('filters: {}')" },
  'filters-view-empty': { edits: [["filters: catalogFilters, sortBy: currentSortBy, sortDir: currentSortDir,\n                page: page", "filters: {}, sortBy: currentSortBy, sortDir: currentSortDir,\n                page: page"]], probe: "catalogViewRaw.toString().includes('filters: {}')" },
  'filters-sorted-empty': { edits: [["filters: catalogFilters, sortBy: currentSortBy, sortDir: currentSortDir, page: 1, pageSize: pageSize,", "filters: {}, sortBy: currentSortBy, sortDir: currentSortDir, page: 1, pageSize: pageSize,"]], probe: "getSortedModels.toString().includes('filters: {}')" },
  'focus-no-writeback': { edits: [["catalogAdoptFilters(r.state);   // focus 清空筛选：回写单一来源，不让页面层残留旧筛选", ""]], probe: "!focusCatalogModel.toString().includes('catalogAdoptFilters(r.state)')" },
  'focus-keeps-expand': { file: 'model-catalog-core.js', edits: [["c.filters = {};\n        clearExpand(c);\n        var v = viewOf(c, a.rows, 1);", "c.filters = {};\n        var v = viewOf(c, a.rows, 1);"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => !/c\\.filters = \\{\\};\\s*clearExpand/.test(t))" },
  // —— C4c-4 子批 4b 新增（左栏 / 两栏布局 / 搜索框宽度）：改 model-catalog.js 的、改 model-catalog-core.js 的、改 Model_Center.html 的
  'rail-counts-filtered': { edits: [["catalogRailCounts = ModelCatalogCore.railCounts(allModelsData);", "catalogRailCounts = ModelCatalogCore.railCounts(getSortedModels());"]], probe: "catalogRefreshRail.toString().includes('getSortedModels()')" },
  'rail-no-companion': { edits: [["catalogRailCounts = ModelCatalogCore.railCounts(allModelsData);", "catalogRailCounts = ModelCatalogCore.railCounts(allModelsData.filter((m) => !m.companion_of));"]], probe: "catalogRefreshRail.toString().includes('!m.companion_of')" },
  'rail-layer-raw': { file: 'model-catalog-core.js', edits: [["var lv = String(row.layer === null || row.layer === undefined ? '' : row.layer).toUpperCase();", "var lv = String(row.layer === null || row.layer === undefined ? '' : row.layer);"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => t.includes(\"var lv = String(row.layer === null || row.layer === undefined ? '' : row.layer);\"))" },
  'rail-total-sum': { edits: [["catalogRailItem('layer', '', '全部', total, 'dot-all', false)", "catalogRailItem('layer', '', '全部', c ? c.layer.reduce((a, r) => a + r.count, 0) : null, 'dot-all', false)"]], probe: "catalogRenderRail.toString().includes('c.layer.reduce')" },
  'rail-pick-no-toggle': { edits: [["const next = catalogRailSame(key, cur, value) ? '' : value;", "const next = value;"]], probe: "catalogRailPick.toString().includes('const next = value;')" },
  'rail-pick-always-call': { edits: [["if (next === cur) return;", ""]], probe: "!catalogRailPick.toString().includes('next === cur')" },
  'rail-pick-no-adopt': { edits: [["catalogEventState = r.state;\n            catalogAdoptFilters(r.state);\n            currentPage = r.state.page;", "catalogEventState = r.state;\n            currentPage = r.state.page;"]], probe: "!catalogRailPick.toString().includes('catalogAdoptFilters')" },
  'rail-clear-no-adopt': { edits: [["catalogEventState = acc;\n            catalogAdoptFilters(acc);", "catalogEventState = acc;"]], probe: "!catalogRailClear.toString().includes('catalogAdoptFilters')" },
  'rail-clear-resets-query': { edits: [["if (keys.length === 0) return;\n            let acc = catalogSyncState();", "if (keys.length === 0) return;\n            document.getElementById('searchKeyword').value = '';\n            let acc = catalogSyncState();"]], probe: "catalogRailClear.toString().includes(\"getElementById('searchKeyword')\")" },
  'rail-clear-partial': { edits: [["const keys = catalogRailKeys.filter(k => catalogRailValue(k) !== '');", "const keys = catalogRailKeys.filter(k => catalogRailValue(k) !== '').slice(0, 1);"]], probe: "catalogRailClear.toString().includes('.slice(0, 1)')" },
  'rail-domain-code-only': { edits: [[": catalogDomainText(r.value), r.count, '', false)", ": r.value, r.count, '', false)"]], probe: "!catalogRenderRail.toString().includes('catalogDomainText(r.value)')" },
  'rail-none-raw': { edits: [["r.value === ModelCatalogCore.DOMAIN_NONE ? '未设置' : catalogDomainText(r.value)", "catalogDomainText(r.value)"]], probe: "!catalogRenderRail.toString().includes('DOMAIN_NONE')" },
  'rail-status-raw': { edits: [["catalogRailItem('status', r.value, catalogStatusText(r.value), r.count,", "catalogRailItem('status', r.value, r.value, r.count,"]], probe: "!catalogRenderRail.toString().includes('catalogStatusText(r.value)')" },
  'rail-drop-missing': { edits: [["if (sel !== '' && !rows.some(r => catalogRailSame(key, r.value, sel))) rows.push({ value: sel, count: 0 });", ""]], probe: "!catalogRailList.toString().includes('count: 0')" },
  'rail-fail-resets': { edits: [["catalogListError = true;\n            catalogSyncListState();", "catalogListError = true;\n            catalogRailCounts = null; catalogRenderRail();\n            catalogSyncListState();"]], probe: "catalogFailList.toString().includes('catalogRailCounts = null')" },
  'rail-placeholder-zero': { edits: [["text: count === null ? '—' : String(count)", "text: count === null ? '0' : String(count)"]], probe: "catalogRailItem.toString().includes(\"count === null ? '0'\")" },
  'rail-label-innerhtml': { edits: [["kids.push(catalogEl('span', { className: 'catalog-rail-lbl', text: label }));", "{ const lb = catalogEl('span', { className: 'catalog-rail-lbl' }); lb.innerHTML = label; kids.push(lb); }"]], probe: "catalogRailItem.toString().includes('lb.innerHTML')" },
  'rail-split-last-colon': { edits: [["const at = text.indexOf(':');", "const at = text.lastIndexOf(':');"]], probe: "catalogRailPick.toString().includes(\"lastIndexOf(':')\")" },
  'rail-view-all-value': { edits: [["catalogRailItem('view', '', '全部模型', c ? c.view.all : null, 'dot-all', false),", "catalogRailItem('view', 'all', '全部模型', c ? c.view.all : null, 'dot-all', false),"]], probe: "catalogRenderRail.toString().includes(\"catalogRailItem('view', 'all', '全部模型'\")" },
  'rail-counts-live-filtered': { edits: [["const c = catalogRailCounts;", "const c = catalogRailCounts ? ModelCatalogCore.railCounts(getSortedModels()) : null;"]], probe: "catalogRenderRail.toString().includes('getSortedModels()')" },
  'rail-domains-no-rerender': { edits: [["catalogRenderRail();   // 4b：左栏业务域项的名称随映射到达更新", ""]], probe: "!catalogApplyDomainNames.toString().includes('catalogRenderRail')" },
  'rail-layout-stacked': { file: 'Model_Center.html', edits: [[".catalog-layout { display: grid;", ".catalog-layout { display: block;"]], probe: "getComputedStyle(document.querySelector('.catalog-layout')).display === 'block'" },
  'rail-wide': { file: 'Model_Center.html', edits: [["grid-template-columns: 208px minmax(0, 1fr);", "grid-template-columns: 600px minmax(0, 1fr);"]], probe: "document.getElementById('catalogRail').getBoundingClientRect().width > 500" },
  'search-narrow': { file: 'Model_Center.html', edits: [[".catalog-toolbar #searchKeyword { flex: 1 1 420px; min-width: 260px; max-width: 560px; margin-right: 6px; }", ".catalog-toolbar #searchKeyword { min-width: 260px; margin-right: 6px; }"]], probe: "getComputedStyle(document.getElementById('searchKeyword')).flexGrow === '0'" },
  // —— C4c-4 子批 4c 新增（未归属对象）：改 model-catalog.js 的与改 Model_Center.html 的（定义见 E:/tmp/mc77-c4/c4c4/4c/muts_4c.js，运行前锚点替换并用页内探针确认生效）
  "un-count-fail-zero": { edits: [["return catalogUnownedStatus === 'ok' && Array.isArray(catalogUnownedRows) ? String(catalogUnownedRows.length) : '—';", "return catalogUnownedStatus === 'ok' && Array.isArray(catalogUnownedRows) ? String(catalogUnownedRows.length) : (catalogUnownedStatus === 'error' ? '0' : '—');"]], probe: "catalogUnownedCountText.toString().includes(\"'error' ? '0'\")" },
  "un-count-loading-zero": { edits: [["return catalogUnownedStatus === 'ok' && Array.isArray(catalogUnownedRows) ? String(catalogUnownedRows.length) : '—';", "return catalogUnownedStatus === 'ok' && Array.isArray(catalogUnownedRows) ? String(catalogUnownedRows.length) : (catalogUnownedStatus === 'loading' ? '0' : '—');"]], probe: "catalogUnownedCountText.toString().includes(\"'loading' ? '0'\")" },
  "un-count-distinct-type": { edits: [["return catalogUnownedStatus === 'ok' && Array.isArray(catalogUnownedRows) ? String(catalogUnownedRows.length) : '—';", "return catalogUnownedStatus === 'ok' && Array.isArray(catalogUnownedRows) ? String(new Set(catalogUnownedRows.map((o) => o.obj_type)).size) : '—';"]], probe: "catalogUnownedCountText.toString().includes('new Set(')" },
  "un-entry-has-data-rail": { edits: [["id: 'catalogRailUnowned', 'data-catalog-act': 'unowned',", "id: 'catalogRailUnowned', 'data-rail': 'unowned:', 'data-catalog-act': 'unowned',"]], probe: "catalogRenderRail.toString().includes(\"'data-rail': 'unowned:'\")" },
  "un-entry-has-data-act": { edits: [["id: 'catalogRailUnowned', 'data-catalog-act': 'unowned',", "id: 'catalogRailUnowned', 'data-act': 'history', 'data-catalog-act': 'unowned',"]], probe: "catalogRenderRail.toString().includes(\"'data-act': 'history'\")" },
  "un-entry-no-pressed": { edits: [["'data-catalog-act': 'unowned', 'aria-pressed': catalogUnownedMode ? 'true' : 'false' }", "'data-catalog-act': 'unowned' }"]], probe: "!catalogRenderRail.toString().includes(\"'aria-pressed': catalogUnownedMode\")" },
  "un-viewer-hidden": { edits: [["catalogEl('button', { className: 'catalog-rail-item catalog-rail-orphan-btn' + (catalogUnownedMode ? ' is-on' : ''),", "(currentUser && currentUser.role === 'viewer' ? () => null : catalogEl)('button', { className: 'catalog-rail-item catalog-rail-orphan-btn' + (catalogUnownedMode ? ' is-on' : ''),"]], probe: "catalogRenderRail.toString().includes(\"() => null : catalogEl\")" },
  "un-init-no-request": { edits: [["catalogLoadUnowned().catch((e) => console.warn('[模型目录] 未归属对象加载异常：', e && e.message));", ""]], probe: "!initListSorting.toString().includes('catalogLoadUnowned')" },
  "un-init-wrong-url": { edits: [["authFetch('/api/model-impl-objects?unowned=1')", "authFetch('/api/model-impl-objects')"]], probe: "catalogLoadUnowned.toString().includes(\"authFetch('/api/model-impl-objects')\")" },
  "un-reload-refetch": { edits: [["catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）", "catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）\n                catalogLoadUnowned();"]], probe: "loadModels.toString().includes('catalogLoadUnowned()')" },
  "un-reload-exits": { edits: [["catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）", "catalogRefreshRail();   // C4c-4（4b）：左栏计数与它同一时机重算（失败 / 被取代的路径不走到这里，保留上次计数）\n                catalogSetUnownedMode(false);"]], probe: "loadModels.toString().includes('catalogSetUnownedMode(false)')" },
  "un-reload-skips-render": { edits: [["renderModelsPage(); // 渲染当前页", "if (!catalogUnownedMode) renderModelsPage(); // 渲染当前页"]], probe: "loadModels.toString().includes('if (!catalogUnownedMode) renderModelsPage()')" },
  "un-mode-class-never": { edits: [["if (section) section.classList.toggle('is-unowned', catalogUnownedMode);", ""]], probe: "!catalogRenderUnowned.toString().includes('is-unowned')" },
  "un-panel-never-shown": { edits: [["panel.hidden = !catalogUnownedMode;", "panel.hidden = true;"]], probe: "catalogRenderUnowned.toString().includes('panel.hidden = true;')" },
  "un-pager-visible": { file: "Model_Center.html", edits: [["#modelListSection.is-unowned > .catalog-wrap, #modelListSection.is-unowned > #paginationContainer { display: none !important; }", "#modelListSection.is-unowned > .catalog-wrap { display: none !important; }"]], probe: "fetch(location.pathname).then((r) => r.text()).then((t) => !t.includes('is-unowned > #paginationContainer'))" },
  "un-list-visible": { file: "Model_Center.html", edits: [["#modelListSection.is-unowned > .catalog-wrap, #modelListSection.is-unowned > #paginationContainer { display: none !important; }", "#modelListSection.is-unowned > #paginationContainer { display: none !important; }"]], probe: "fetch(location.pathname).then((r) => r.text()).then((t) => !t.includes('is-unowned > .catalog-wrap'))" },
  "un-name-no-schema": { edits: [["catalogEl('td', { className: 'catalog-obj-name', text: (o.schema_name ? String(o.schema_name) + '.' : '') + catalogText(o.obj_name) }),", "catalogEl('td', { className: 'catalog-obj-name', text: catalogText(o.obj_name) }),"]], probe: "!catalogBuildUnownedTable.toString().includes('o.schema_name')" },
  "un-summary-raw": { edits: [["text: catalogOrDash(o.summary)", "text: catalogText(o.summary)"]], probe: "!catalogBuildUnownedTable.toString().includes('catalogOrDash(o.summary)')" },
  "un-time-raw": { edits: [["text: catalogOrDash(o.verified_at)", "text: catalogText(o.verified_at)"]], probe: "!catalogBuildUnownedTable.toString().includes('catalogOrDash(o.verified_at)')" },
  "un-dash-no-trim": { edits: [["return s.trim() === '' ? '—' : s;", "return s === '' ? '—' : s;"]], probe: "!catalogOrDash.toString().includes('trim()')" },
  "un-badges-doc-only": { edits: [["catalogEl('td', { className: 'catalog-obj-badges' }, catalogObjBadgeKids(o)),", "catalogEl('td', { className: 'catalog-obj-badges' }, [catalogBuildImplBadge('doc', o.badges ? o.badges.doc : null)]),"]], probe: "!catalogBuildUnownedTable.toString().includes('catalogObjBadgeKids')" },
  "un-head-wrong": { edits: [["['类型', '名称', '摘要', '徽章', '核验时间'].map((t) => catalogEl('th', { text: t }))", "['类型', '对象', '摘要', '徽章', '核验时间'].map((t) => catalogEl('th', { text: t }))"]], probe: "catalogBuildUnownedTable.toString().includes(\"'对象', '摘要'\")" },
  "un-type-innerhtml": { edits: [["const trs = rows.map((o) => catalogEl('tr', {}, [\n                catalogEl('td', { className: 'catalog-obj-type', text: catalogOrDash(o.obj_type) }),", "const trs = rows.map((o) => catalogEl('tr', {}, [\n                (() => { const t = catalogEl('td', { className: 'catalog-obj-type' }); t.innerHTML = catalogText(o.obj_type); return t; })(),"]], probe: "catalogBuildUnownedTable.toString().includes('t.innerHTML')" },
  "un-name-innerhtml": { edits: [["catalogEl('td', { className: 'catalog-obj-name', text: (o.schema_name ? String(o.schema_name) + '.' : '') + catalogText(o.obj_name) }),", "(() => { const t = catalogEl('td', { className: 'catalog-obj-name' }); t.innerHTML = (o.schema_name ? String(o.schema_name) + '.' : '') + catalogText(o.obj_name); return t; })(),"]], probe: "catalogBuildUnownedTable.toString().includes('t.innerHTML')" },
  "un-summary-innerhtml": { edits: [["catalogEl('td', { className: 'catalog-obj-summary', text: catalogOrDash(o.summary) }),", "(() => { const t = catalogEl('td', { className: 'catalog-obj-summary' }); t.innerHTML = catalogOrDash(o.summary); return t; })(),"]], probe: "catalogBuildUnownedTable.toString().includes('t.innerHTML')" },
  "un-time-innerhtml": { edits: [["catalogEl('td', { className: 'catalog-obj-time', text: catalogOrDash(o.verified_at) }),", "(() => { const t = catalogEl('td', { className: 'catalog-obj-time' }); t.innerHTML = catalogOrDash(o.verified_at); return t; })(),"]], probe: "catalogBuildUnownedTable.toString().includes('t.innerHTML')" },
  "un-fail-toast": { edits: [["catalogUnownedStatus = rows === null ? 'error' : 'ok';", "catalogUnownedStatus = rows === null ? 'error' : 'ok';\n            if (rows === null) showToast('未归属对象加载失败', 'error');"]], probe: "catalogLoadUnowned.toString().includes(\"showToast('未归属对象加载失败'\")" },
  "un-fail-no-retry": { edits: [["catalogEl('button', { className: 'catalog-unowned-retry', type: 'button', 'data-catalog-act': 'retry-unowned', disabled: catalogUnownedBusy, text: '重试' }),", ""]], probe: "!catalogRenderUnowned.toString().includes('retry-unowned')" },
  "un-retry-not-disabled": { edits: [["'data-catalog-act': 'retry-unowned', disabled: catalogUnownedBusy, text: '重试'", "'data-catalog-act': 'retry-unowned', text: '重试'"]], probe: "!catalogRenderUnowned.toString().includes(\"'retry-unowned', disabled: catalogUnownedBusy\")" },
  "un-retry-no-guard": { edits: [["if (catalogUnownedBusy) return;\n            catalogLoadUnowned().catch(", "catalogLoadUnowned().catch("]], probe: "!catalogRetryUnowned.toString().includes('catalogUnownedBusy')" },
  "un-error-sticky": { edits: [["catalogUnownedStatus = rows === null ? 'error' : 'ok';", "catalogUnownedStatus = rows === null || catalogUnownedStatus === 'error' ? 'error' : 'ok';"]], probe: "catalogLoadUnowned.toString().includes(\"catalogUnownedStatus === 'error' ? 'error'\")" },
  "un-valid-nothing": { edits: [["return rows.every((o) => catalogIsObj(o) && typeof o.obj_name === 'string'", "return rows.every((o) => true || catalogIsObj(o) && typeof o.obj_name === 'string'"]], probe: "catalogValidUnowned.toString().includes('(o) => true ||')" },
  "un-late-no-fetch-check": { edits: [["const res = await authFetch('/api/model-impl-objects?unowned=1');\n                if (seq !== catalogUnownedSeq) return 'discarded';", "const res = await authFetch('/api/model-impl-objects?unowned=1');"]], probe: "catalogLoadUnowned.toString().split(\"return 'discarded'\").length === 3" },
  "un-late-no-ok-checks": { edits: [["const res = await authFetch('/api/model-impl-objects?unowned=1');\n                if (seq !== catalogUnownedSeq) return 'discarded';", "const res = await authFetch('/api/model-impl-objects?unowned=1');"], ["const data = await res.json();\n                    if (seq !== catalogUnownedSeq) return 'discarded';", "const data = await res.json();"]], probe: "catalogLoadUnowned.toString().split(\"return 'discarded'\").length === 2" },
  "un-late-no-catch-check": { edits: [["} catch (e) {\n                if (seq !== catalogUnownedSeq) return 'discarded';\n                console.warn('[模型目录] 未归属对象加载失败：'", "} catch (e) {\n                console.warn('[模型目录] 未归属对象加载失败：'"]], probe: "catalogLoadUnowned.toString().split(\"return 'discarded'\").length === 3" },
  "un-seq-never-bump": { edits: [["const seq = ++catalogUnownedSeq;", "const seq = catalogUnownedSeq;"]], probe: "catalogLoadUnowned.toString().includes('const seq = catalogUnownedSeq;')" },
  "un-back-no-exit": { edits: [["function catalogLeaveUnowned() {\n            catalogSetUnownedMode(false);\n", "function catalogLeaveUnowned() {\n"]], probe: "!catalogLeaveUnowned.toString().includes('catalogSetUnownedMode')" },
  "un-back-resets-page": { edits: [["function catalogLeaveUnowned() {\n            catalogSetUnownedMode(false);\n", "function catalogLeaveUnowned() {\n            catalogSetUnownedMode(false);\n            currentPage = 1; renderModelsPage();\n"]], probe: "catalogLeaveUnowned.toString().includes('currentPage = 1; renderModelsPage();')" },
  "un-back-button-missing": { edits: [["catalogEl('button', { className: 'catalog-unowned-back', type: 'button', 'data-catalog-act': 'unowned-back', text: '返回模型列表' }),", ""]], probe: "!catalogRenderUnowned.toString().includes('unowned-back')" },
  "un-enter-collapses": { edits: [["if (on) catalogCloseMenus();", "if (on) { catalogCloseMenus(); catalogCollapseAll(); }"]], probe: "catalogSetUnownedMode.toString().includes('catalogCollapseAll')" },
  "un-toggle-always-enter": { edits: [["catalogSetUnownedMode(!catalogUnownedMode);", "catalogSetUnownedMode(true);"]], probe: "catalogToggleUnowned.toString().includes('catalogSetUnownedMode(true)')" },
  "un-pick-no-exit": { edits: [["catalogSetUnownedMode(false);   // 4c：未归属模式下点任一筛选项——先退出（同「返回」），再按 4b 现行为执行\n", ""]], probe: "!catalogRailPick.toString().includes('catalogSetUnownedMode')" },
  "un-clear-no-exit": { edits: [["catalogSetUnownedMode(false);   // 4c：未归属模式下点「清除 N 项」——先退出，再清筛选\n", ""]], probe: "!catalogRailClear.toString().includes('catalogSetUnownedMode')" },
  "un-pick-exit-late": { edits: [["catalogSetUnownedMode(false);   // 4c：未归属模式下点任一筛选项——先退出（同「返回」），再按 4b 现行为执行\n", ""], ["if (next === cur) return;", "if (next === cur) return;\n            catalogSetUnownedMode(false);"]], probe: "catalogRailPick.toString().indexOf('catalogSetUnownedMode') > catalogRailPick.toString().indexOf('next === cur')" },
  "un-empty-text": { edits: [["text: '没有未归属对象' }", "text: '暂无数据' }"]], probe: "catalogRenderUnowned.toString().includes(\"text: '暂无数据'\")" },
  "un-loading-text": { edits: [["body = catalogEl('div', { className: 'catalog-unowned-state', text: '加载中…' });", "body = catalogEl('div', { className: 'catalog-unowned-state', text: '' });"]], probe: "!catalogRenderUnowned.toString().includes('加载中')" },
  // —— C4c-4 子批 4d 新增（预筛修复批）
  "comp-records-during": { edits: [["if (!catalogComposing) { catalogRenderedQuery = getCatalogQuery(); }", "catalogRenderedQuery = getCatalogQuery();"]], probe: "!renderModelsPage.toString().includes('catalogComposing')" },
  "comp-no-start": { edits: [["el.addEventListener('compositionstart', () => { catalogComposing = true; });", ""]], probe: "!initCatalogSearch.toString().includes('compositionstart')" },
  "comp-end-no-clear": { edits: [["el.addEventListener('compositionend', () => { catalogComposing = false; });", ""]], probe: "!initCatalogSearch.toString().includes('catalogComposing = false')" },
  "comp-clear-after-apply": { edits: [["el.addEventListener('compositionend', () => { catalogComposing = false; });\n            el.addEventListener('compositionend', applyCatalogSearch);", "el.addEventListener('compositionend', applyCatalogSearch);\n            el.addEventListener('compositionend', () => { catalogComposing = false; });"]], probe: "initCatalogSearch.toString().indexOf('applyCatalogSearch') < initCatalogSearch.toString().indexOf('catalogComposing = false')" },
  "focus-no-exit-unowned": { edits: [["catalogSetUnownedMode(false);   // 4d：?focus= 是明确的定位意图——此刻若在未归属模式（列表被隐藏）先退出，否则下面的清搜索 / 跳页 / 高亮都落在看不见的列表上\n", ""]], probe: "!focusCatalogModel.toString().includes('catalogSetUnownedMode')" },
  "un-refresh-missing": { edits: [["catalogUnownedStatus === 'ok' ? catalogEl('button', { className: 'catalog-unowned-refresh', type: 'button', 'data-catalog-act': 'refresh-unowned', disabled: catalogUnownedBusy, text: '刷新' }) : null,", "null,"]], probe: "!catalogRenderUnowned.toString().includes('refresh-unowned')" },
  "un-refresh-not-disabled": { edits: [["'data-catalog-act': 'refresh-unowned', disabled: catalogUnownedBusy, text: '刷新'", "'data-catalog-act': 'refresh-unowned', text: '刷新'"]], probe: "!catalogRenderUnowned.toString().includes(\"'refresh-unowned', disabled\")" },
  "un-refresh-every-state": { edits: [["catalogUnownedStatus === 'ok' ? catalogEl('button', { className: 'catalog-unowned-refresh'", "true ? catalogEl('button', { className: 'catalog-unowned-refresh'"]], probe: "catalogRenderUnowned.toString().includes(\"true ? catalogEl('button', { className: 'catalog-unowned-refresh'\")" },
  "un-refresh-no-bind": { edits: [["const refresh = t.closest('[data-catalog-act=\"refresh-unowned\"]');\n                if (refresh && panel.contains(refresh)) { if (!refresh.disabled) catalogRetryUnowned(); }", ""]], probe: "!catalogBindUnowned.toString().includes('refresh-unowned')" },
  "un-refresh-fail-stays-ok": { edits: [["catalogUnownedRows = rows;\n            catalogUnownedStatus = rows === null ? 'error' : 'ok';", "if (rows !== null || catalogUnownedStatus !== 'ok') { catalogUnownedRows = rows; catalogUnownedStatus = rows === null ? 'error' : 'ok'; }"]], probe: "catalogLoadUnowned.toString().includes(\"catalogUnownedStatus !== 'ok') {\")" },
  "rail-replace-all": { edits: [["catalogRailReconcile(rail, [toggle, head, viewSec, layerSec, statusSec, domainSec, orphan]);", "rail.replaceChildren(toggle, head, viewSec, layerSec, statusSec, domainSec, orphan);"]], probe: "catalogRenderRail.toString().includes('rail.replaceChildren(')" },
  "rail-patch-no-attrs": { edits: [["Array.from(freshEl.attributes).forEach(a => { if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value); });", ""]], probe: "!catalogRailPatch.toString().includes('setAttribute')" },
  "rail-patch-no-text": { edits: [["if (oldEl.children.length > 0 || oldEl.textContent !== freshEl.textContent) oldEl.textContent = freshEl.textContent;", ""]], probe: "!catalogRailPatch.toString().includes('textContent = freshEl.textContent')" },
  "rail-reconcile-no-remove": { edits: [["pool.forEach(q => q.forEach(el => el.remove()));", ""]], probe: "!catalogRailReconcile.toString().includes('el.remove()')" },
  "rail-reconcile-moves-all": { edits: [["keep.forEach((el, i) => { if (parent.children[i] !== el) parent.insertBefore(el, parent.children[i] || null); });", "keep.forEach((el) => { parent.appendChild(el); });"]], probe: "catalogRailReconcile.toString().includes('parent.appendChild(el)')" },
  "section-stray-button": { file: "Model_Center.html", edits: [["<div id=\"catalogUnownedPanel\" class=\"catalog-unowned\"", "<button type=\"button\" id=\"strayCtl\">x</button><div id=\"catalogUnownedPanel\" class=\"catalog-unowned\""]], probe: "!!document.getElementById('strayCtl')" },
  "err-uncaught-in-error-branch": { edits: [["} else if (catalogUnownedStatus === 'error') {", "} else if (catalogUnownedStatus === 'error') {\n                setTimeout(() => { throw new Error('boom-uncaught'); }, 0);"]], probe: "catalogRenderUnowned.toString().includes('boom-uncaught')" },
  "err-console-error-in-fail": { edits: [["console.warn('[模型目录] 未归属对象加载失败：', e && e.message);", "console.error('[模型目录] 未归属对象加载失败：', e && e.message);"]], probe: "catalogLoadUnowned.toString().includes(\"console.error('[模型目录] 未归属对象加载失败：'\")" },
  // —— C4c-4 codex 41 收口新增
  "un-render-replace-all": { edits: [["catalogRailReconcile(panel, [\n                catalogEl('div', { className: 'catalog-unowned-head' }, [", "panel.replaceChildren(\n                catalogEl('div', { className: 'catalog-unowned-head' }, ["], ["                    catalogEl('div', { className: 'catalog-unowned-actions' }, actions),\n                ]),\n                body\n            ]);", "                    catalogEl('div', { className: 'catalog-unowned-actions' }, actions),\n                ]),\n                body\n            );"]], probe: "catalogRenderUnowned.toString().includes('panel.replaceChildren(')" },
  "rail-focus-lost": { edits: [["            if (focused && focused !== document.activeElement && rail.contains(focused)) focused.focus({ preventScroll: true });   // codex 41-L1\n", ""]], probe: "!catalogRenderRail.toString().includes('focused.focus(')" },
  "un-type-text": { edits: [["catalogEl('td', { className: 'catalog-obj-type', text: catalogOrDash(o.obj_type) }),", "catalogEl('td', { className: 'catalog-obj-type', text: catalogText(o.obj_type) }),"]], probe: "catalogBuildUnownedTable.toString().includes('text: catalogText(o.obj_type)')" },
  "toolbar-sort-no-redraw": { edits: [["                    currentPage = r.state.page;\n                    renderModelsPage();\n                });\n            });\n            document.querySelectorAll('[data-catalog-act=\"collapse-all\"]')", "                    currentPage = r.state.page;\n                    updateSortIcons();\n                });\n            });\n            document.querySelectorAll('[data-catalog-act=\"collapse-all\"]')"]], probe: "initListSorting.toString().includes('currentPage = r.state.page;\\n                    updateSortIcons();')" },
  "search-same-word-page1": { edits: [["catalogEventState = r.state;\n            currentPage = r.state.page;\n            renderModelsPage();\n        }\n\n        /**\n         * 输入法组字结束时再应用一次", "catalogEventState = r.state;\n            currentPage = 1;\n            renderModelsPage();\n        }\n\n        /**\n         * 输入法组字结束时再应用一次"]], probe: "applyCatalogSearch.toString().includes('currentPage = 1;')" },
  "goto-same-bumps-token": { edits: [["const r = ModelCatalogCore.gotoPage(catalogSyncState(), { page: p, totalPages });", "if (p === currentPage) { const tk = Object.assign({}, catalogEventState.expandTokens); Object.keys(tk).forEach((k) => { tk[k] = tk[k] + 1; }); catalogEventState = Object.assign({}, catalogEventState, { expandTokens: tk }); }\n            const r = ModelCatalogCore.gotoPage(catalogSyncState(), { page: p, totalPages });"]], probe: "goToPage.toString().includes('tk[k] = tk[k] + 1')" },
  "core-p23-separate": { file: 'model-catalog-core.js', edits: [["            for (j = 0; j < all[i].members.length && !hit; j++) {\n                hit = matchRow(all[i].members[j], o.query) && passesFilters(all[i].members[j], o.filters);\n            }", "            hit = all[i].members.some(function (m) { return matchRow(m, o.query); }) && Object.keys(o.filters || {}).every(function (k) { var one = {}; one[k] = o.filters[k]; return all[i].members.some(function (m) { return passesFilters(m, one); }); });"]], probe: "fetch('/assets/js/model-catalog-core.js').then((r) => r.text()).then((t) => t.includes('var one = {}; one[k] = o.filters[k];'))" },
  "rail-pick-double-call": { edits: [["const r = ModelCatalogCore.setFilter(catalogSyncState(), key, next);", "const r = (key === 'domain' || key === 'view') ? (ModelCatalogCore.setFilter(catalogSyncState(), key, next), ModelCatalogCore.setFilter(catalogSyncState(), key, next)) : ModelCatalogCore.setFilter(catalogSyncState(), key, next);"]], probe: "catalogRailPick.toString().includes(\"key === 'domain' || key === 'view'\")" },
  "un-load-hangs": { edits: [["            return rows === null ? 'failed' : 'ok';", "            if (rows !== null) await new Promise(() => {});\n            return rows === null ? 'failed' : 'ok';"]], probe: "catalogLoadUnowned.toString().includes('await new Promise(() => {})')" },
  "un-refresh-clears-table": { edits: [["            const seq = ++catalogUnownedSeq;\n            catalogUnownedBusy = true;\n", "            const seq = ++catalogUnownedSeq;\n            catalogUnownedBusy = true;\n            if (catalogUnownedStatus === 'ok') catalogUnownedStatus = 'loading';\n"]], probe: "catalogLoadUnowned.toString().includes(\"catalogUnownedStatus = 'loading'\")" },
  "un-refresh-blank-rows": { edits: [["catalogEl('td', { className: 'catalog-obj-summary', text: catalogOrDash(o.summary) }),", "catalogEl('td', { className: 'catalog-obj-summary', text: catalogUnownedBusy ? '…' : catalogOrDash(o.summary) }),"]], probe: "catalogBuildUnownedTable.toString().includes(\"catalogUnownedBusy ? '…'\")" },
  "rail-clear-recreated": { edits: [["catalogEl('button', { className: 'catalog-rail-clear', type: 'button', 'data-catalog-act': 'rail-clear', text: '清除 ' + n + ' 项' })", "catalogEl('button', { className: 'catalog-rail-clear', type: 'button', id: 'clr' + Math.random(), 'data-catalog-act': 'rail-clear', text: '清除 ' + n + ' 项' })"]], probe: "catalogRenderRail.toString().includes(\"'clr' + Math.random()\")" },
  "unowned-busy-not-set": { edits: [["            const seq = ++catalogUnownedSeq;\n            catalogUnownedBusy = true;\n            catalogRenderUnowned();", "            const seq = ++catalogUnownedSeq;\n            catalogRenderUnowned();"]], probe: "!catalogLoadUnowned.toString().includes('catalogUnownedBusy = true;')" },
  "unowned-busy-stuck-on-fail": { edits: [["            catalogUnownedBusy = false;\n            catalogUnownedRows = rows;", "            if (rows !== null) catalogUnownedBusy = false;\n            catalogUnownedRows = rows;"]], probe: "catalogLoadUnowned.toString().includes('if (rows !== null) catalogUnownedBusy = false;')" },
  "unowned-busy-stuck-on-ok": { edits: [["            catalogUnownedBusy = false;\n            catalogUnownedRows = rows;", "            if (rows === null) catalogUnownedBusy = false;\n            catalogUnownedRows = rows;"]], probe: "catalogLoadUnowned.toString().includes('if (rows === null) catalogUnownedBusy = false;')" },
  "rail-patch-attr-inverted": { edits: [["Array.from(freshEl.attributes).forEach(a => { if (oldEl.getAttribute(a.name) !== a.value) oldEl.setAttribute(a.name, a.value); });", "Array.from(freshEl.attributes).forEach(a => { if (oldEl.getAttribute(a.name) === a.value) oldEl.setAttribute(a.name, a.value); });"]], probe: "catalogRailPatch.toString().includes('if (oldEl.getAttribute(a.name) === a.value)')" },
  "rail-patch-text-inverted": { edits: [["if (oldEl.children.length > 0 || oldEl.textContent !== freshEl.textContent) oldEl.textContent = freshEl.textContent;", "if (oldEl.children.length > 0 || oldEl.textContent === freshEl.textContent) oldEl.textContent = freshEl.textContent;"]], probe: "catalogRailPatch.toString().includes('oldEl.textContent === freshEl.textContent')" },
  "rail-patch-keeps-old-text": { edits: [["            if (oldEl.children.length === 0 && oldEl.textContent !== '') oldEl.textContent = '';   // codex 41：旧节点是纯文字叶子、新节点有子元素（「加载中…」→「加载失败」+ 重试）：先清掉旧文字，否则它残留在新子元素之前\n", ""]], probe: "!catalogRailPatch.toString().includes(\"oldEl.textContent = ''\")" },
  "open-dwd-script-hangs": { file: 'Model_Center.html', edits: [["async function openDwdScriptModal(", "async function openDwdScriptModal() { await openDwdScriptModalReal.apply(this, arguments); await new Promise(() => {}); }\n        async function openDwdScriptModalReal("]], probe: "openDwdScriptModal.toString().includes('openDwdScriptModalReal')" },
  "head-after-section": { edits: [["        let allModelsData = []; // 存储所有模型数据", "        { const ph = document.querySelector('.catalog-pagehead'); const sc = document.getElementById('modelListSection'); if (ph && sc && sc.parentNode) sc.parentNode.appendChild(ph); }   // 变异：脚本一载入就把页头搬到列表区块之后\n        let allModelsData = []; // 存储所有模型数据"]], probe: "!!(document.querySelector('.catalog-pagehead').compareDocumentPosition(document.getElementById('modelListSection')) & Node.DOCUMENT_POSITION_PRECEDING)" },
  // —— C4d-a 新增（窄屏两档断点；改 Model_Center.html 样式的与改 model-catalog.js 的；探针确认变异已装载）
  "w82-no-1024-query": {"file":"Model_Center.html","edits":[["@media (max-width: 1024px) {","@media (max-width: 1px) {"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"@media (max-width: 1px) {\"))"},
  "w82-no-640-query": {"file":"Model_Center.html","edits":[["@media (max-width: 640px) {","@media (max-width: 1px) {\n            .w82probe { top: 0; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".w82probe { top: 0; }\"))"},
  "w82-owner-visible": {"file":"Model_Center.html","edits":[[".catalog-head > .catalog-col-owner, .catalog-row1 > .catalog-owner { display: none; }",".catalog-head > .catalog-col-owner, .catalog-row1 > .catalog-owner { display: block; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-row1 > .catalog-owner { display: block; }\"))"},
  "w82-mobile-meta-wide": {"file":"Model_Center.html","edits":[[".catalog-mobile-meta { display: none; }",".catalog-mobile-meta { display: flex; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-mobile-meta { display: flex; }\\n        @media\"))"},
  "w82-main-fixed-220": {"file":"Model_Center.html","edits":[["grid-template-columns: 28px 60px minmax(0, 1fr) 64px 132px 76px 104px; column-gap: 8px;","grid-template-columns: 28px 60px minmax(220px, 1fr) 64px 132px 76px 104px; column-gap: 8px;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"minmax(220px, 1fr) 64px 132px 76px 104px\"))"},
  "w82-head-pad-12": {"file":"Model_Center.html","edits":[[".catalog-head { padding: 8px 13px;",".catalog-head { padding: 8px 12px;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-head { padding: 8px 12px;\"))"},
  "w82-rail-sticky": {"file":"Model_Center.html","edits":[[".catalog-rail { position: static; max-height: none; overflow-y: visible;",".catalog-rail { position: sticky; max-height: none; overflow-y: visible;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-rail { position: sticky; max-height: none; overflow-y: visible;\"))"},
  "w82-flow-5col": {"file":"Model_Center.html","edits":[[".catalog-flow { grid-template-columns: minmax(0, 1fr); gap: 6px; }",".catalog-flow { gap: 6px; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-flow { gap: 6px; }\"))"},
  "w82-toggle-wide": {"file":"Model_Center.html","edits":[[".catalog-rail-toggle { display: none; }",".catalog-rail-toggle { display: flex; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-rail-toggle { display: flex; }\\n        .catalog-mobile-meta\"))"},
  "w82-collapse-ignored": {"file":"Model_Center.html","edits":[[".catalog-rail:not(.is-open) > :not(.catalog-rail-toggle) { display: none; }",".catalog-rail:not(.is-open) > :not(.catalog-rail-toggle) { display: block; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\":not(.catalog-rail-toggle) { display: block; }\"))"},
  "w82-layout-two-col": {"file":"Model_Center.html","edits":[[".catalog-layout { grid-template-columns: minmax(0, 1fr); }",".catalog-layout { }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-layout { }\"))"},
  "w82-objtable-cols": {"file":"Model_Center.html","edits":[[".catalog-objtable td:nth-child(5) { display: none; }",".catalog-objtable td:nth-child(5) { display: table-cell; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-objtable td:nth-child(5) { display: table-cell; }\"))"},
  "w82-toggle-open": {"edits":[["let catalogRailOpen = false;","let catalogRailOpen = true;"]],"probe":"catalogRailOpen === true"},
  "w82-toggle-stuck": {"edits":[["catalogRailOpen = !catalogRailOpen;","catalogRailOpen = false;"]],"probe":"catalogToggleRail.toString().includes(\"catalogRailOpen = false;\")"},
  "w82-toggle-aria-false": {"edits":[["'aria-expanded': catalogRailOpen ? 'true' : 'false',\n                'aria-controls': 'catalogRailHead","'aria-expanded': 'false',\n                'aria-controls': 'catalogRailHead"]],"probe":"catalogRenderRail.toString().includes(\"'aria-expanded': 'false',\")"},
  "w82-meta-owner-blank": {"edits":[["catalogEl('span', { className: 'catalog-owner-m', title: ownerTitle, text: ownerText }),","catalogEl('span', { className: 'catalog-owner-m', text: '' }),"]],"probe":"catalogBuildEntry.toString().includes(\"className: 'catalog-owner-m', text: ''\")"},
  // —— C4d-b 新增（可访问性；改 Model_Center.html 样式 / 结构的与改 model-catalog.js 的；探针确认变异已装载）
  "w86-expand-aria-stuck": {"edits":[["if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');","if (toggle) toggle.setAttribute('aria-expanded', 'false');"]],"probe":"catalogApplyPane.toString().includes(\"setAttribute('aria-expanded', 'false')\")"},
  "w86-menu-no-haspopup": {"edits":[["'data-menu': kind, 'aria-haspopup': 'menu',","'data-menu': kind,"]],"probe":"!catalogBuildMenu.toString().includes(\"aria-haspopup\")"},
  "w86-menu-expanded-stale": {"edits":[["trigger.setAttribute('aria-expanded', open ? 'true' : 'false');","trigger.setAttribute('aria-expanded', 'false');"]],"probe":"catalogSetMenu.toString().includes(\"setAttribute('aria-expanded', 'false')\")"},
  "w86-sort-aria-leak": {"edits":[["btn.removeAttribute('aria-sort');",""]],"probe":"!updateSortIcons.toString().includes(\"removeAttribute\")"},
  "w86-sort-aria-asc-only": {"edits":[["btn.setAttribute('aria-sort', currentSortDir === 'asc' ? 'ascending' : 'descending');","btn.setAttribute('aria-sort', 'ascending');"]],"probe":"updateSortIcons.toString().includes(\"'aria-sort', 'ascending')\")"},
  "w86-rail-pressed-false": {"edits":[["'aria-pressed': on ? 'true' : 'false' }, kids);","'aria-pressed': 'false' }, kids);"]],"probe":"catalogRailItem.toString().includes(\"'aria-pressed': 'false' }, kids)\")"},
  "w86-focus-rule-none": {"file":"Model_Center.html","edits":[["#paginationContainer :focus-visible { outline: 2px solid var(--catalog-focus, #d97706); outline-offset: 2px; }","#paginationContainer :focus-visible { outline: none; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#paginationContainer :focus-visible { outline: none; }\"))"},
  "w86-focus-rule-1px": {"file":"Model_Center.html","edits":[["#paginationContainer :focus-visible { outline: 2px solid var(--catalog-focus, #d97706);","#paginationContainer :focus-visible { outline: 1px solid var(--catalog-focus, #d97706);"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#paginationContainer :focus-visible { outline: 1px solid\"))"},
  "w86-focus-rule-list-only": {"file":"Model_Center.html","edits":[[".catalog-pagehead :focus-visible, .catalog-toolbar :focus-visible, #catalogRail :focus-visible, .catalog-head :focus-visible, #catalogListNotice :focus-visible, #modelListBody :focus-visible, #catalogUnownedPanel :focus-visible, #paginationContainer :focus-visible {","#modelListBody :focus-visible {"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelListBody :focus-visible { outline: 2px solid var(--catalog-focus\"))"},
  "w86-collapsed-rail-clip": {"file":"Model_Center.html","edits":[[".catalog-rail:not(.is-open) > :not(.catalog-rail-toggle) { display: none; }",".catalog-rail:not(.is-open) > :not(.catalog-rail-toggle) { height: 0; overflow: hidden; padding: 0; margin: 0; border: 0; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-rail:not(.is-open) > :not(.catalog-rail-toggle) { height: 0;\"))"},
  "w86-esc-no-focus": {"edits":[["            if (trigger) trigger.focus();\n            e.stopPropagation();\n        }, true);","            e.stopPropagation();\n        }, true);"]],"probe":"fetch(document.querySelector('script[src*=\"model-catalog.js\"]').src).then((r) => r.text()).then((t) => !t.includes('if (trigger) trigger.focus();'))"},
  "w86-esc-propagates": {"edits":[["            if (trigger) trigger.focus();\n            e.stopPropagation();\n        }, true);","            if (trigger) trigger.focus();\n        }, true);"]],"probe":"fetch(document.querySelector('script[src*=\"model-catalog.js\"]').src).then((r) => r.text()).then((t) => !t.includes('e.stopPropagation();'))"},
  "w86-focusout-noop": {"edits":[["if (!inside) catalogCloseMenus();",""]],"probe":"!catalogOnFocusIn.toString().includes(\"catalogCloseMenus\")"},
  "w86-focusout-always": {"edits":[["if (!inside) catalogCloseMenus();","catalogCloseMenus();"]],"probe":"!catalogOnFocusIn.toString().includes(\"if (!inside)\")"},
  "w86-pane-retry-div": {"edits":[["catalogEl('button', { className: 'catalog-pane-retry', type: 'button', 'data-pane-act': 'retry', text: '重试' })","catalogEl('div', { className: 'catalog-pane-retry', 'data-pane-act': 'retry', text: '重试' })"]],"probe":"catalogBuildPane.toString().includes(\"catalogEl('div', { className: 'catalog-pane-retry'\")"},
  "w86-head-role-row": {"file":"Model_Center.html","edits":[["<div class=\"catalog-head\">","<div class=\"catalog-head\" role=\"row\">"]],"probe":"document.querySelector('.catalog-head').getAttribute('role') === 'row'"},
  "w86-group-no-role": {"edits":[["className: 'catalog-group', role: 'listitem', 'data-group': g.id","className: 'catalog-group', 'data-group': g.id"]],"probe":"renderModelsPage.toString().includes(\"className: 'catalog-group', 'data-group': g.id\")"},
  "w86-empty-no-role": {"edits":[["className: 'catalog-empty', role: 'listitem', text: '暂无模型数据'","className: 'catalog-empty', text: '暂无模型数据'"]],"probe":"renderModelsPage.toString().includes(\"className: 'catalog-empty', text: '暂无模型数据'\")"},
  "w86-clear-no-focus": {"edits":[["if (allView) allView.focus({ preventScroll: true });",""]],"probe":"!catalogRailClear.toString().includes(\"allView.focus\")"},
  "w86-highlight-no-exit": {"edits":[["function highlightModel(modelId) {\n            catalogSetUnownedMode(false);","function highlightModel(modelId) {\n            void 0;"]],"probe":"highlightModel.toString().includes(\"void 0;\")"},
  "w82-meta-no-status": {"edits":[["                    catalogEl('span', { className: 'catalog-status-m' }, [catalogBuildStatusBadge(m)]),\n                    catalogBuildAcceptance(accView, 'catalog-cell catalog-acc-m'),","                    catalogBuildAcceptance(accView, 'catalog-cell catalog-acc-m'),"]],"probe":"!catalogBuildEntry.toString().includes('[catalogBuildStatusBadge(m)]')"},
  // —— C4d 预筛修复批新增（HIGH-1 主列换行 / LOW-3 title 与列余量 / LOW-1 / LOW-4 / LOW-5）
  "w82-pre-fix-css": {"file":"Model_Center.html","edits":[[".catalog-main { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; row-gap: 2px; min-width: 0; }",".catalog-main { display: flex; align-items: center; gap: 8px; min-width: 0; }"],[".catalog-main .model-open-btn { flex: 0 0 auto; min-width: 0;",".catalog-main .model-open-btn { flex: 0 1 auto; min-width: 0;"],[".catalog-comment { flex: 1 1 0; min-width: min(4em, 100%);",".catalog-comment { flex: 1 1 auto; min-width: 0;"],[".catalog-tag { flex: 0 1 auto; min-width: 0; max-width: 100%; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; padding: 1px 6px;",".catalog-tag { flex: 0 0 auto; padding: 1px 6px;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-tag { flex: 0 0 auto; padding: 1px 6px;\") && e.textContent.includes(\".catalog-comment { flex: 1 1 auto; min-width: 0;\"))"},
  "w82-btn-shrinkable": {"file":"Model_Center.html","edits":[[".catalog-main .model-open-btn { flex: 0 0 auto; min-width: 0;",".catalog-main .model-open-btn { flex: 0 1 auto; min-width: 0;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-main .model-open-btn { flex: 0 1 auto; min-width: 0;\"))"},
  "w82-main-nowrap": {"file":"Model_Center.html","edits":[[".catalog-main { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; row-gap: 2px; min-width: 0; }",".catalog-main { display: flex; align-items: center; gap: 8px; row-gap: 2px; min-width: 0; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-main { display: flex; align-items: center; gap: 8px; row-gap: 2px; min-width: 0; }\"))"},
  "w82-main-nowrap-btn-shrink": {"file":"Model_Center.html","edits":[[".catalog-main { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; row-gap: 2px; min-width: 0; }",".catalog-main { display: flex; align-items: center; gap: 8px; row-gap: 2px; min-width: 0; }"],[".catalog-main .model-open-btn { flex: 0 0 auto; min-width: 0;",".catalog-main .model-open-btn { flex: 0 1 auto; min-width: 0;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-main { display: flex; align-items: center; gap: 8px; row-gap: 2px; min-width: 0; }\") && e.textContent.includes(\".catalog-main .model-open-btn { flex: 0 1 auto; min-width: 0;\"))"},
  "w82-tag-no-shrink": {"file":"Model_Center.html","edits":[[".catalog-tag { flex: 0 1 auto; min-width: 0; max-width: 100%; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; padding: 1px 6px;",".catalog-tag { flex: 0 0 auto; padding: 1px 6px;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-tag { flex: 0 0 auto; padding: 1px 6px;\"))"},
  "w82-acc-124": {"file":"Model_Center.html","edits":[["64px 132px 104px; }","64px 124px 104px; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"64px 124px 104px; }\"))"},
  "w82-status-no-title": {"edits":[["{ className: 'catalog-cell catalog-status', title: statusBadge.title }","{ className: 'catalog-cell catalog-status' }"]],"probe":"!catalogBuildEntry.toString().includes(\"catalog-status', title:\")"},
  "w82-badge-no-title": {"edits":[["className: 'u-status-badge ' + mdcStatusClass(m.status), title: statusText, text: statusText","className: 'u-status-badge ' + mdcStatusClass(m.status), text: statusText"]],"probe":"!catalogBuildStatusBadge.toString().includes('title: statusText')"},
  "w82-owner-no-title": {"edits":[["{ className: 'catalog-cell catalog-owner', title: ownerTitle, text: ownerText }","{ className: 'catalog-cell catalog-owner', text: ownerText }"]],"probe":"!catalogBuildEntry.toString().includes(\"catalog-owner', title:\")"},
  "w82-owner-m-no-title": {"edits":[["{ className: 'catalog-owner-m', title: ownerTitle, text: ownerText }","{ className: 'catalog-owner-m', text: ownerText }"]],"probe":"!catalogBuildEntry.toString().includes(\"catalog-owner-m', title:\")"},
  "w82-acc-twice": {"edits":[["catalogBuildAcceptance(accView, 'catalog-cell catalog-acc-m')","catalogBuildAcceptance(catalogAcceptanceViewOf(m), 'catalog-cell catalog-acc-m')"]],"probe":"catalogBuildEntry.toString().includes(\"catalogBuildAcceptance(catalogAcceptanceViewOf(m), 'catalog-cell catalog-acc-m')\")"},
  "w86-focusin-menu-only": {"edits":[["menu.contains(t) || (catalogTriggerOf(menu) || menu).contains(t)","menu.contains(t)"]],"probe":"catalogOnFocusIn.toString().includes('open.some(menu => menu.contains(t))')"},
  "w86-leave-no-toggle-fallback": {"edits":[["            if (shown(tg)) tg.focus({ preventScroll: true });\n",""]],"probe":"!catalogLeaveUnowned.toString().includes('tg.focus')"},
  // —— C4d codex 42 收口批新增（42-M1 / 42Ta / 42Tb / 42Tc）
  "w82-btn-hidden-1024": {"file":"Model_Center.html","edits":[[".pane { padding-left: 16px; }",".pane { padding-left: 16px; }\n            .catalog-main .model-open-btn { display: none; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-main .model-open-btn { display: none; }\"))"},
  "w82-objtable-th-only": {"file":"Model_Center.html","edits":[[".catalog-objtable th:nth-child(3), .catalog-objtable td:nth-child(3), .catalog-objtable th:nth-child(5), .catalog-objtable td:nth-child(5) { display: none; }",".catalog-objtable th:nth-child(3), .catalog-objtable th:nth-child(5) { display: none; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-objtable th:nth-child(3), .catalog-objtable th:nth-child(5) { display: none; }\"))"},
  "w82-objtable-first-row-only": {"file":"Model_Center.html","edits":[[".catalog-objtable th:nth-child(3), .catalog-objtable td:nth-child(3), .catalog-objtable th:nth-child(5), .catalog-objtable td:nth-child(5) { display: none; }",".catalog-objtable th:nth-child(3), .catalog-objtable th:nth-child(5), .catalog-objtable tbody tr:first-child td:nth-child(3), .catalog-objtable tbody tr:first-child td:nth-child(5) { display: none; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"tbody tr:first-child td:nth-child(5) { display: none; }\"))"},
  "w82-arrow-rot0": {"file":"Model_Center.html","edits":[[".catalog-flow-arrow { transform: rotate(90deg); }",".catalog-flow-arrow { transform: rotate(0deg); }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-flow-arrow { transform: rotate(0deg); }\"))"},
  "w82-arrow-rot180": {"file":"Model_Center.html","edits":[[".catalog-flow-arrow { transform: rotate(90deg); }",".catalog-flow-arrow { transform: rotate(180deg); }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-flow-arrow { transform: rotate(180deg); }\"))"},
  "w82-arrow-second-unrotated": {"file":"Model_Center.html","edits":[[".catalog-flow-arrow { transform: rotate(90deg); }",".catalog-flow-arrow { transform: rotate(90deg); }\n            .catalog-flow-me ~ .catalog-flow-arrow { transform: none; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-flow-me ~ .catalog-flow-arrow { transform: none; }\"))"},
  "w84-ctl-dup": {"edits":[["'aria-controls': 'catalogRailHead catalogRailSecView catalogRailSecLayer catalogRailSecStatus catalogRailSecDomain catalogRailOrphan',","'aria-controls': 'catalogRailHead catalogRailHead catalogRailHead catalogRailHead catalogRailHead catalogRailHead',"]],"probe":"catalogRenderRail.toString().includes(\"'catalogRailHead catalogRailHead catalogRailHead\")"},
  "w84-ctl-wrong": {"edits":[[" catalogRailSecDomain catalogRailOrphan',"," catalogRail catalogRailOrphan',"]],"probe":"catalogRenderRail.toString().includes(\"catalogRailSecStatus catalogRail catalogRailOrphan'\")"},
  "w84-ctl-data-section": {"edits":[["return catalogEl('div', { className: 'catalog-rail-sec', id: id }, [","return catalogEl('div', { className: 'catalog-rail-sec', id: id === 'catalogRailSecDomain' ? null : id, title: id }, ["]],"probe":"catalogRailSection.toString().includes(\"id === 'catalogRailSecDomain'\")"},
  "w84-no-toggle": {"edits":[["catalogRailReconcile(rail, [toggle, head, viewSec, layerSec, statusSec, domainSec, orphan]);","catalogRailReconcile(rail, [head, viewSec, layerSec, statusSec, domainSec, orphan]);"]],"probe":"catalogRenderRail.toString().includes('catalogRailReconcile(rail, [head, viewSec')"},
  "w89-expand-tabindex-neg": {"edits":[["function catalogBuildExpandToggle(m, expanded) {\n            return catalogEl('button', {","function catalogBuildExpandToggle(m, expanded) {\n            const eb = catalogBuildExpandToggleReal(m, expanded); if (String(m.id) === '101') eb.tabIndex = -1; return eb;\n        }\n        function catalogBuildExpandToggleReal(m, expanded) {\n            return catalogEl('button', {"]],"probe":"catalogBuildExpandToggle.toString().includes('eb.tabIndex = -1')"},
  "w95-date-hidden": {"file":"Model_Center.html","edits":[[".catalog-acc-date { margin-left: 6px; color: #94a3b8; }",".catalog-acc-date { margin-left: 6px; color: #94a3b8; display: none; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-acc-date { margin-left: 6px; color: #94a3b8; display: none; }\"))"},
  "w95-date-clip": {"file":"Model_Center.html","edits":[[".catalog-acc-date { margin-left: 6px; color: #94a3b8; }",".catalog-acc-date { margin-left: 6px; color: #94a3b8; display: inline-block; max-width: 20px; overflow: hidden; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"display: inline-block; max-width: 20px; overflow: hidden; }\"))"},
  "w86-focus-rule-transparent": {"file":"Model_Center.html","edits":[["#paginationContainer :focus-visible { outline: 2px solid var(--catalog-focus, #d97706);","#paginationContainer :focus-visible { outline: 2px solid transparent;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#paginationContainer :focus-visible { outline: 2px solid transparent;\"))"},
  "w86-focusin-open-filter": {"edits":[["const open = catalogOpenMenus();\n            if (!open.length) return;\n            const inside","const open = catalogOpenMenus().filter(menu => menu.hidden);\n            if (!open.length) return;\n            const inside"]],"probe":"catalogOnFocusIn.toString().includes('.filter(menu => menu.hidden)')"},
  "w98-owner-m-no-constraint": {"file":"Model_Center.html","edits":[[".catalog-owner-m { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",".catalog-owner-m { }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-owner-m { }\"))"},
  "w98-badge-no-constraint": {"file":"Model_Center.html","edits":[[".catalog-status-m { min-width: 0; max-width: 100%; overflow: hidden; }",".catalog-status-m { }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-status-m { }\"))"},
  "w98-domain-no-constraint": {"file":"Model_Center.html","edits":[[".catalog-domain { flex: 0 1 auto; min-width: 0; max-width: min(14em, 100%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",".catalog-domain { flex: 0 0 auto; white-space: nowrap; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-domain { flex: 0 0 auto; white-space: nowrap; }\"))"},
  "w98-meta-no-min0": {"file":"Model_Center.html","edits":[[".catalog-mobile-meta { display: flex; flex: 0 0 100%; min-width: 0; flex-wrap: wrap;",".catalog-mobile-meta { display: flex; flex: 0 0 100%; flex-wrap: wrap;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-mobile-meta { display: flex; flex: 0 0 100%; flex-wrap: wrap;\"))"},
  "w98-badge-out-of-wrap": {"edits":[["catalogEl('span', { className: 'catalog-status-m' }, [catalogBuildStatusBadge(m)]),","catalogBuildStatusBadge(m),"]],"probe":"!catalogBuildEntry.toString().includes('[catalogBuildStatusBadge(m)]')"},
  "w98-domain-no-title": {"edits":[["title: catalogDomainTitle(m.domain), 'data-domain-code'","'data-domain-code'"]],"probe":"!catalogBuildEntry.toString().includes('catalogDomainTitle(m.domain)')"},
  "w98-domain-title-stale": {"edits":[["                if (t === null) el.removeAttribute('title'); else el.title = t;\n",""]],"probe":"!catalogApplyDomainNames.toString().includes('el.title = t')"},
  "w98-domain-unset-title": {"edits":[["            if (code === null || code === undefined || String(code).trim() === '') return null;\n            return catalogDomainText(code);","            return catalogDomainText(code);"]],"probe":"catalogDomainTitle.toString().indexOf('return null') < 0"},
  "w98-domain-title-rawcode": {"edits":[["title: catalogDomainTitle(m.domain), 'data-domain-code'","title: (m.domain === null || m.domain === undefined || String(m.domain).trim() === '') ? null : String(m.domain), 'data-domain-code'"]],"probe":"!catalogBuildEntry.toString().includes('catalogDomainTitle(m.domain)')"},
  "w98-impl-auto": {"file":"Model_Center.html","edits":[[".catalog-impl { flex: 1 1 0; min-width: 0;",".catalog-impl { flex: 1 1 auto; min-width: 0;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-impl { flex: 1 1 auto; min-width: 0;\"))"},
  // —— C4e-a 新增（配色 E；改 Model_Center.html 样式 / 配置台 / model-catalog.js；探针确认变异已装载）
  "w99-scope-root": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover {",":root {"]],"probe":"getComputedStyle(document.documentElement).getPropertyValue('--c-link').trim() === '#3730a3'"},
  "w99-scope-no-drawer": {"file":"Model_Center.html","edits":[["#modelDrawerOverlay, #modelDetailDrawer, #registerModal","#modelDrawerOverlay, #registerModal"]],"probe":"getComputedStyle(document.getElementById('modelDetailDrawer')).getPropertyValue('--c-link').trim() === ''"},
  "w99-drawer-head-no-override": {"file":"Model_Center.html","edits":[["        #modelDetailDrawer .u-drawer-header { background: var(--drawer-head-bg); color: var(--drawer-head-fg); }\n",""]],"probe":"getComputedStyle(document.querySelector('#modelDetailDrawer .u-drawer-header')).backgroundColor === 'rgb(217, 119, 6)'"},
  "w99-body-bg-missing": {"file":"Model_Center.html","edits":[["        body { background: #f1f5f9; }\n",""]],"probe":"getComputedStyle(document.body).backgroundColor !== 'rgb(241, 245, 249)'"},
  "w99-body-var-leak": {"file":"Model_Center.html","edits":[["        body { background: #f1f5f9; }\n","        body { background: #f1f5f9; --c-link: #3730a3; }\n"]],"probe":"getComputedStyle(document.body).getPropertyValue('--c-link').trim() === '#3730a3'"},
  "w99-rail-bg-white": {"file":"Model_Center.html","edits":[[".catalog-rail { --rail-bg: #1e293b;",".catalog-rail { --rail-bg: #fff;"]],"probe":"getComputedStyle(document.getElementById('catalogRail')).backgroundColor === 'rgb(255, 255, 255)'"},
  "w99-rail-on-amber": {"file":"Model_Center.html","edits":[["--rail-on-bg: #334155; --rail-on-fg: #c7d2fe; --rail-bar: #818cf8;","--rail-on-bg: #fef3c7; --rail-on-fg: #92400e; --rail-bar: #d97706;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"--rail-on-bg: #fef3c7; --rail-on-fg: #92400e; --rail-bar: #d97706;\"))"},
  "w99-link-amber": {"file":"Model_Center.html","edits":[["font-family: Consolas, monospace; color: var(--c-link); font-size: 0.88em; }","font-family: Consolas, monospace; color: #92400e; font-size: 0.88em; }"]],"probe":"getComputedStyle(document.querySelector('#modelListBody .model-open-btn')).color === 'rgb(146, 64, 14)'"},
  "w99-register-secondary": {"file":"Model_Center.html","edits":[["        #registerNewModelBtn { background: var(--color-accent); border-color: var(--color-accent); color: #fff; }\n",""]],"probe":"getComputedStyle(document.getElementById('registerNewModelBtn')).backgroundColor !== 'rgb(79, 70, 229)'"},
  "w99-flow-me-amber": {"file":"Model_Center.html","edits":[["padding: 8px 12px; background: var(--color-accent-soft); border: 1px solid var(--color-accent-line); border-radius: 8px; }","padding: 8px 12px; background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"padding: 8px 12px; background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; }\"))"},
  "w99-metable-amber": {"file":"Model_Center.html","edits":[["font-weight: 600; color: var(--c-link); word-break: break-all; }","font-weight: 600; color: #92400e; word-break: break-all; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"font-weight: 600; color: #92400e; word-break: break-all; }\"))"},
  "w99-model-link-amber": {"file":"Model_Center.html","edits":[["font-size: inherit; color: var(--c-link); cursor: pointer; }","font-size: inherit; color: #92400e; cursor: pointer; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"font-size: inherit; color: #92400e; cursor: pointer; }\"))"},
  "w99-menu-hover-amber": {"file":"Model_Center.html","edits":[[".catalog-menu-item:hover:not(:disabled) { background: var(--color-accent-soft); }",".catalog-menu-item:hover:not(:disabled) { background: #fef3c7; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-menu-item:hover:not(:disabled) { background: #fef3c7; }\"))"},
  "w99-row-hover-amber": {"file":"Model_Center.html","edits":[[".catalog-entry:hover { background: var(--row-hover); }",".catalog-entry:hover { background: #fffbeb; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-entry:hover { background: #fffbeb; }\"))"},
  "w99-sub-amber": {"file":"Model_Center.html","edits":[["color: var(--color-accent-line); font-weight: 400; margin-top: 2px; }","color: #fef3c7; font-weight: 400; margin-top: 2px; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"color: #fef3c7; font-weight: 400; margin-top: 2px; }\"))"},
  "w99-dim-badge-accent": {"file":"Model_Center.html","edits":[[".catalog-layer-dim { background: #fef3c7; color: #b45309; border: 1px solid #fcd34d; }",".catalog-layer-dim { background: var(--color-accent-soft); color: var(--color-accent); border: 1px solid var(--color-accent-line); }"]],"probe":"getComputedStyle(document.querySelector('#modelListBody .catalog-layer-dim')).color === 'rgb(79, 70, 229)'"},
  "w99-custom-tag-accent": {"file":"Model_Center.html","edits":[[".catalog-tag-custom { background: #fef3c7; color: #b45309; }",".catalog-tag-custom { background: var(--color-accent-soft); color: var(--color-accent); }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-tag-custom { background: var(--color-accent-soft); color: var(--color-accent); }\"))"},
  "w99-acc-warn-accent": {"file":"Model_Center.html","edits":[[".catalog-acc-warn, .catalog-acc-partial { color: #b45309; }",".catalog-acc-warn, .catalog-acc-partial { color: var(--color-accent); }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-acc-warn, .catalog-acc-partial { color: var(--color-accent); }\"))"},
  "w99-recheck-accent": {"file":"Model_Center.html","edits":[["border-radius: 8px; background: #fef3c7; color: #b45309; font-size: 0.85em; }","border-radius: 8px; background: var(--color-accent-soft); color: var(--color-accent); font-size: 0.85em; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"border-radius: 8px; background: var(--color-accent-soft); color: var(--color-accent); font-size: 0.85em; }\"))"},
  "w99-wb-accent": {"file":"Model_Workbench.html","edits":[["dim: { bg: '#fffbeb', border: '#fcd34d', title: '#b45309', btnBg: '#d97706',","dim: { bg: '#fffbeb', border: '#fcd34d', title: '#b45309', btnBg: '#4f46e5',"]],"probe":"fetch('/Model_Workbench.html').then((r) => r.text()).then((t) => t.includes(\"title: '#b45309', btnBg: '#4f46e5',\"))"},
  "w99-w5-old-highlight": {"file":"Model_Center.html","edits":[["#modelListBody [data-focus-highlight] { background: var(--row-sel) !important;","#modelListBody [data-focus-highlight] { background: #fef3c7 !important;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelListBody [data-focus-highlight] { background: #fef3c7 !important;\"))"},
  "w99-w54-old-page": {"edits":[["background:${isActive ? 'var(--color-accent)' : 'white'};","background:${isActive ? '#d97706' : 'white'};"]],"probe":"renderPagination.toString().includes(\"isActive ? '#d97706' : 'white'\")"},
  // —— C4e 预筛修复批新增（W99：列表选中条目；改 Model_Center.html；探针确认变异已装载）
  "w99-selected-bar-missing": {"file":"Model_Center.html","edits":[["        #modelListBody .selected-row { background: var(--row-sel) !important; box-shadow: inset 3px 0 0 var(--color-accent); }","        #modelListBody .selected-row { background: var(--row-sel) !important; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes('.selected-row { background: var(--row-sel) !important; }'))"},
  "w99-selected-bg-old": {"file":"Model_Center.html","edits":[["        #modelListBody .selected-row { background: var(--row-sel) !important; box-shadow: inset 3px 0 0 var(--color-accent); }","        #modelListBody .selected-row { background: #ebf5ff !important; box-shadow: inset 3px 0 0 var(--color-accent); }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes('.selected-row { background: #ebf5ff !important;'))"},
  // —— C4e-b 新增（P-U2 弹窗强调色 / ③ 作用域覆盖 / 语义色保持 / 左栏焦点框；改 Model_Center.html；探针确认变异已装载）
  "w100-scope-no-registermodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #batchImportModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-batchimportmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-ddlmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-validationmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-dimddlpreviewmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\\n        #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-dimetlpreviewmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-dwdddlmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-dwdetlpreviewmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-modeldrawertestmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-iterationhistorymodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-changelogsmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #scriptDiffModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #scriptDiffModal, #designNotesPopover\"))"},
  "w100-scope-no-scriptdiffmodal": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #designNotesPopover"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #designNotesPopover\"))"},
  "w100-scope-no-designnotespopover": {"file":"Model_Center.html","edits":[["main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal, #designNotesPopover","main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"main.workbench-container, #modelDrawerOverlay, #modelDetailDrawer, #registerModal, #batchImportModal, #ddlModal, #validationModal,\\n        #dimDdlPreviewModal, #dimEtlPreviewModal, #dwdDdlModal, #dwdEtlPreviewModal, #modelDrawerTestModal, #iterationHistoryModal, #changeLogsModal, #scriptDiffModal {\"))"},
  "w100-btn-batch-amber": {"file":"Model_Center.html","edits":[["style=\"background:var(--color-accent); color:white; padding:10px 20px; border:none; border-radius:6px; cursor:pointer;\">","style=\"background:#d97706; color:white; padding:10px 20px; border:none; border-radius:6px; cursor:pointer;\">"]],"probe":"document.querySelector('#batchImportModal button[onclick*=\"importFile\"]').getAttribute('style').includes('#d97706')"},
  "w100-btn-ddlcopy-amber": {"file":"Model_Center.html","edits":[["style=\"padding:8px 16px; background:var(--color-accent); color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.85em; font-weight:600;\">","style=\"padding:8px 16px; background:#d97706; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.85em; font-weight:600;\">"]],"probe":"document.getElementById('copySyncScriptBtn').getAttribute('style').includes('#d97706')"},
  "w100-btn-revalidate-static-amber": {"file":"Model_Center.html","edits":[["<button onclick=\"runValidation()\"\n                            style=\"padding:10px 20px; background:var(--color-accent);","<button onclick=\"runValidation()\"\n                            style=\"padding:10px 20px; background:#d97706;"]],"probe":"document.querySelector('#validationResultButtons button[onclick=\"runValidation()\"]').getAttribute('style').includes('#d97706')"},
  "w100-btn-revalidate-ods-amber": {"file":"Model_Center.html","edits":[["padding:10px 20px; background:var(--color-accent); color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.9em;\">\n                        <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 4px;\"><polyline points=\"23 4 23 10 17 10\"/><polyline points=\"1 20 1 14 7 14\"/><path d=\"M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15\"/></svg>重新验收\n                    </button>\n                    <button onclick=\"closeValidationModal()\"\n                        style=\"padding:10px 20px; background:#64748b; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.9em;\">\n                        关闭\n                    </button>\n                </div>`;\n\n            // 验","padding:10px 20px; background:#d97706; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.9em;\">\n                        <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 4px;\"><polyline points=\"23 4 23 10 17 10\"/><polyline points=\"1 20 1 14 7 14\"/><path d=\"M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15\"/></svg>重新验收\n                    </button>\n                    <button onclick=\"closeValidationModal()\"\n                        style=\"padding:10px 20px; background:#64748b; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.9em;\">\n                        关闭\n                    </button>\n                </div>`;\n\n            // 验"]],"probe":"renderValidationResult.toString().includes(\"padding:10px 20px; background:#d97706;\")"},
  "w100-btn-revalidate-dim-amber": {"file":"Model_Center.html","edits":[["padding:10px 20px; background:var(--color-accent); color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.9em;\">\n                        <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 4px;\"><polyline points=\"23 4 23 10 17 10\"/><polyline points=\"1 20 1 14 7 14\"/><path d=\"M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15\"/></svg>重新验收\n                    </button>\n                    <button onclick=\"closeValidationModal()\"\n                        style=\"padding:10px 20px; background:#64748b; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.9em;\">\n                        关闭\n                    </button>\n                </div>`;\n\n            // D","padding:10px 20px; background:#d97706; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.9em;\">\n                        <svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 4px;\"><polyline points=\"23 4 23 10 17 10\"/><polyline points=\"1 20 1 14 7 14\"/><path d=\"M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15\"/></svg>重新验收\n                    </button>\n                    <button onclick=\"closeValidationModal()\"\n                        style=\"padding:10px 20px; background:#64748b; color:white; border:none; border-radius:6px; cursor:pointer; font-size:0.9em;\">\n                        关闭\n                    </button>\n                </div>`;\n\n            // D"]],"probe":"renderDimValidationResult.toString().includes(\"padding:10px 20px; background:#d97706;\")"},
  "w100-btn-customsave-amber": {"file":"Model_Center.html","edits":[["display:none; background:var(--color-accent); color:white;","display:none; background:#d97706; color:white;"]],"probe":"openCustomDDLEditor.toString().includes(\"display:none; background:#d97706; color:white;\")"},
  "w100-btn-etlsave-amber": {"file":"Model_Center.html","edits":[["saveAllCustomETL(${model.id})\" style=\"background:var(--color-accent);","saveAllCustomETL(${model.id})\" style=\"background:#d97706;"]],"probe":"openCustomETLEditor.toString().includes(\"saveAllCustomETL(${model.id})\\\" style=\\\"background:#d97706;\")"},
  "w100-btn-dimddlcopy-amber": {"file":"Model_Center.html","edits":[["copyDimDdlToClipboard()\" style=\"background:var(--color-accent);","copyDimDdlToClipboard()\" style=\"background:#d97706;"]],"probe":"showDimDDLPreviewModal.toString().includes(\"copyDimDdlToClipboard()\\\" style=\\\"background:#d97706;\")"},
  "w100-btn-dwdcopy-amber": {"file":"Model_Center.html","edits":[["copyDwdDdl()\" style=\"background:var(--color-accent);","copyDwdDdl()\" style=\"background:#d97706;"]],"probe":"showDwdDDLPreviewModal.toString().includes(\"copyDwdDdl()\\\" style=\\\"background:#d97706;\")"},
  "w100-copysync-ok-amber": {"file":"Model_Center.html","edits":[["btn.style.background = 'var(--color-accent-hover)';","btn.style.background = '#b45309';"]],"probe":"copySyncScript.toString().includes(\"btn.style.background = '#b45309';\")"},
  "w100-copysync-restore-amber": {"file":"Model_Center.html","edits":[["btn.style.background = 'var(--color-accent)';","btn.style.background = '#d97706';"]],"probe":"copySyncScript.toString().includes(\"btn.style.background = '#d97706';\")"},
  "w100-grad-customddl-amber": {"file":"Model_Center.html","edits":[["linear-gradient(135deg,var(--color-accent-soft),var(--color-accent-line)); border-radius:12px 12px 0 0;\">\n                            <h3 style=\"margin:0; color:var(--c-link);\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M12","linear-gradient(135deg,#fef3c7,#fde68a); border-radius:12px 12px 0 0;\">\n                            <h3 style=\"margin:0; color:var(--c-link);\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M12"]],"probe":"openCustomDDLEditor.toString().includes(\"linear-gradient(135deg,#fef3c7,#fde68a)\")"},
  "w100-grad-dimddl-amber": {"file":"Model_Center.html","edits":[["linear-gradient(135deg,var(--color-accent-soft),var(--color-accent-line)); border-radius:12px 12px 0 0;\">\n                            <h3 style=\"margin:0; color:var(--c-link);\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M14","linear-gradient(135deg,#fffbeb,#fef3c7); border-radius:12px 12px 0 0;\">\n                            <h3 style=\"margin:0; color:var(--c-link);\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M14"]],"probe":"showDimDDLPreviewModal.toString().includes(\"linear-gradient(135deg,#fffbeb,#fef3c7)\")"},
  "w100-grad-dwdddl-amber": {"file":"Model_Center.html","edits":[["linear-gradient(135deg,var(--color-accent-soft),var(--color-accent-line));\"","linear-gradient(135deg,#fffbeb,#fef3c7);\""]],"probe":"showDwdDDLPreviewModal.toString().includes(\"linear-gradient(135deg,#fffbeb,#fef3c7)\")"},
  "w100-h3-customddl-amber": {"file":"Model_Center.html","edits":[["<h3 style=\"margin:0; color:var(--c-link);\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M12","<h3 style=\"margin:0; color:#92400e;\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M12"]],"probe":"openCustomDDLEditor.toString().includes(\"<h3 style=\\\"margin:0; color:#92400e;\\\">\")"},
  "w100-h3-dimddl-amber": {"file":"Model_Center.html","edits":[["<h3 style=\"margin:0; color:var(--c-link);\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M14","<h3 style=\"margin:0; color:#92400e;\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M14"]],"probe":"showDimDDLPreviewModal.toString().includes(\"<h3 style=\\\"margin:0; color:#92400e;\\\">\")"},
  "w100-h3-dwdddl-amber": {"file":"Model_Center.html","edits":[["<h3 style=\"margin:0; color:var(--c-link);\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M16","<h3 style=\"margin:0; color:#92400e;\">\n                                <svg width=\"20\" height=\"20\" viewBox=\"0 0 24 24\" fill=\"none\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M16"]],"probe":"showDwdDDLPreviewModal.toString().includes(\"<h3 style=\\\"margin:0; color:#92400e;\\\">\")"},
  "w100-stroke-customddl-amber": {"file":"Model_Center.html","edits":[["stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z\"/></svg>\n                                D","stroke=\"#d97706\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px;\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z\"/></svg>\n                                D"]],"probe":"openCustomDDLEditor.toString().includes(\"stroke=\\\"#d97706\\\" stroke-width=\\\"2\\\" style=\\\"vertical-align:middle; margin-right:8px;\\\"\")"},
  "w100-stroke-customeetl-amber": {"file":"Model_Center.html","edits":[["stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z\"/></svg>\n                                E","stroke=\"#d97706\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px;\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z\"/></svg>\n                                E"]],"probe":"openCustomETLEditor.toString().includes(\"stroke=\\\"#d97706\\\" stroke-width=\\\"2\\\" style=\\\"vertical-align:middle; margin-right:8px;\\\"\")"},
  "w100-stroke-dimddl-amber": {"file":"Model_Center.html","edits":[["stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M14","stroke=\"#d97706\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px;\"><path d=\"M14"]],"probe":"showDimDDLPreviewModal.toString().includes(\"stroke=\\\"#d97706\\\" stroke-width=\\\"2\\\" style=\\\"vertical-align:middle; margin-right:8px;\\\"\")"},
  "w100-stroke-dwdddl-amber": {"file":"Model_Center.html","edits":[["stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M16","stroke=\"#d97706\" stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px;\"><path d=\"M16"]],"probe":"showDwdDDLPreviewModal.toString().includes(\"stroke=\\\"#d97706\\\" stroke-width=\\\"2\\\" style=\\\"vertical-align:middle; margin-right:8px;\\\"\")"},
  "w100-dwd-pill-amber": {"file":"Model_Center.html","edits":[["background:var(--color-accent-soft); color:var(--c-link); padding:3px 8px;","background:#fef3c7; color:#92400e; padding:3px 8px;"]],"probe":"showDwdDDLPreviewModal.toString().includes(\"background:#fef3c7; color:#92400e; padding:3px 8px;\")"},
  "w100-dwd-info-amber": {"file":"Model_Center.html","edits":[["color:var(--c-link); background:var(--color-accent-soft); padding:4px 10px;","color:#92400e; background:#fef3c7; padding:4px 10px;"]],"probe":"showDwdDDLPreviewModal.toString().includes(\"color:#92400e; background:#fef3c7; padding:4px 10px;\")"},
  "w100-dimddl-bar-amber": {"file":"Model_Center.html","edits":[["background:var(--color-accent-soft); padding:10px 15px; border-radius:6px;","background:#fffbeb; padding:10px 15px; border-radius:6px;"]],"probe":"showDimDDLPreviewModal.toString().includes(\"background:#fffbeb; padding:10px 15px; border-radius:6px;\")"},
  "w100-dimddl-tname-amber": {"file":"Model_Center.html","edits":[["<span style=\"color:var(--c-link);\"><strong>表名：</strong>","<span style=\"color:#92400e;\"><strong>表名：</strong>"]],"probe":"showDimDDLPreviewModal.toString().includes(\"<span style=\\\"color:#92400e;\\\"><strong>表名：</strong>\")"},
  "w100-dimddl-desc-amber": {"file":"Model_Center.html","edits":[["margin-left:20px; color:var(--c-link);\"><strong>描述：</strong>","margin-left:20px; color:#92400e;\"><strong>描述：</strong>"]],"probe":"showDimDDLPreviewModal.toString().includes(\"margin-left:20px; color:#92400e;\\\"><strong>描述：</strong>\")"},
  "w100-tabbar-active-amber": {"file":"Model_Center.html","edits":[["border-bottom:2px solid ${i === 0 ? 'var(--color-accent)' : 'transparent'}; color:${i === 0 ? 'var(--color-accent)' : '#6b7280'};","border-bottom:2px solid ${i === 0 ? '#d97706' : 'transparent'}; color:${i === 0 ? '#d97706' : '#6b7280'};"]],"probe":"openCustomETLEditor.toString().includes(\"border-bottom:2px solid ${i === 0 ? '#d97706' : 'transparent'}; color:${i === 0 ? '#d97706' : '#6b7280'};\")"},
  "w100-addtab-amber": {"file":"Model_Center.html","edits":[["background:#f9fafb; color:var(--color-accent); cursor:pointer;","background:#f9fafb; color:#d97706; cursor:pointer;"]],"probe":"openCustomETLEditor.toString().includes(\"background:#f9fafb; color:#d97706; cursor:pointer;\")"},
  "w100-rename-amber": {"file":"Model_Center.html","edits":[["border:1px solid var(--color-accent); border-radius:3px;","border:1px solid #d97706; border-radius:3px;"]],"probe":"renameCustomEtlTab.toString().includes(\"border:1px solid #d97706; border-radius:3px;\")"},
  "w100-switch-etl-tab-amber": {"file":"Model_Center.html","edits":[["btn.style.borderBottom = '2px solid var(--color-accent)'; btn.style.color = 'var(--color-accent)';","btn.style.borderBottom = '2px solid #d97706'; btn.style.color = '#d97706';"]],"probe":"switchCustomEtlTab.toString().includes(\"btn.style.borderBottom = '2px solid #d97706'; btn.style.color = '#d97706';\")"},
  "w100-dwdtab-main-amber": {"file":"Model_Center.html","edits":[["border-bottom:2px solid var(--color-accent); color:var(--color-accent); cursor:pointer; font-weight:600;","border-bottom:2px solid #d97706; color:#d97706; cursor:pointer; font-weight:600;"]],"probe":"showDwdDDLPreviewModal.toString().includes(\"border-bottom:2px solid #d97706; color:#d97706; cursor:pointer; font-weight:600;\")"},
  "w100-switch-dwdtab-amber": {"file":"Model_Center.html","edits":[["btn.style.borderBottom = '2px solid var(--color-accent)';\n                    btn.style.color = 'var(--color-accent)';","btn.style.borderBottom = '2px solid #d97706';\n                    btn.style.color = '#d97706';"]],"probe":"switchDwdDdlTab.toString().includes(\"btn.style.borderBottom = '2px solid #d97706';\\n                    btn.style.color = '#d97706';\")"},
  "w100-iter-version-edit-amber": {"file":"Model_Center.html","edits":[["<span style=\"color:var(--c-link); font-weight:600;\">v${tasks.length - i}</span>\n                                    <span>${escapeHtml(t.title)}</span>\n                                </div>\n                                <div style=\"display:flex; align-items:center; gap:12px; margin-top:4px; color:#64748b; font-size:0.9em;\">\n                                    <span>${categoryMap[t.category] || t.category}</span>\n                                    <span><svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 2px;\"><path d=\"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/></svg>${escapeHtml(t.owner || '-')}</span>\n                                    <span><svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 2px;\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\"/><line x1=\"16\" y1=\"2\" x2=\"16\" y2=\"6\"/><line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"6\"/><line x1=\"3\" y1=\"10\" x2=\"21\" y2=\"10\"/></svg>${f","<span style=\"color:#b45309; font-weight:600;\">v${tasks.length - i}</span>\n                                    <span>${escapeHtml(t.title)}</span>\n                                </div>\n                                <div style=\"display:flex; align-items:center; gap:12px; margin-top:4px; color:#64748b; font-size:0.9em;\">\n                                    <span>${categoryMap[t.category] || t.category}</span>\n                                    <span><svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 2px;\"><path d=\"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/></svg>${escapeHtml(t.owner || '-')}</span>\n                                    <span><svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 2px;\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\"/><line x1=\"16\" y1=\"2\" x2=\"16\" y2=\"6\"/><line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"6\"/><line x1=\"3\" y1=\"10\" x2=\"21\" y2=\"10\"/></svg>${f"]],"probe":"openEditModal.toString().includes(\"<span style=\\\"color:#b45309; font-weight:600;\\\">v${tasks.length - i}</span>\")"},
  "w100-iter-version-view-amber": {"file":"Model_Center.html","edits":[["<span style=\"color:var(--c-link); font-weight:600;\">v${tasks.length - i}</span>\n                                    <span>${escapeHtml(t.title)}</span>\n                                </div>\n                                <div style=\"display:flex; align-items:center; gap:12px; margin-top:4px; color:#64748b; font-size:0.9em;\">\n                                    <span>${categoryMap[t.category] || t.category}</span>\n                                    <span><svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 2px;\"><path d=\"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/></svg>${escapeHtml(t.owner || '-')}</span>\n                                    <span><svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 2px;\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\"/><line x1=\"16\" y1=\"2\" x2=\"16\" y2=\"6\"/><line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"6\"/><line x1=\"3\" y1=\"10\" x2=\"21\" y2=\"10\"/></svg>${t","<span style=\"color:#b45309; font-weight:600;\">v${tasks.length - i}</span>\n                                    <span>${escapeHtml(t.title)}</span>\n                                </div>\n                                <div style=\"display:flex; align-items:center; gap:12px; margin-top:4px; color:#64748b; font-size:0.9em;\">\n                                    <span>${categoryMap[t.category] || t.category}</span>\n                                    <span><svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 2px;\"><path d=\"M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\"/><circle cx=\"12\" cy=\"7\" r=\"4\"/></svg>${escapeHtml(t.owner || '-')}</span>\n                                    <span><svg width=\"12\" height=\"12\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" style=\"vertical-align: middle; margin-right: 2px;\"><rect x=\"3\" y=\"4\" width=\"18\" height=\"18\" rx=\"2\" ry=\"2\"/><line x1=\"16\" y1=\"2\" x2=\"16\" y2=\"6\"/><line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"6\"/><line x1=\"3\" y1=\"10\" x2=\"21\" y2=\"10\"/></svg>${t"]],"probe":"viewIterationHistory.toString().includes(\"<span style=\\\"color:#b45309; font-weight:600;\\\">v${tasks.length - i}</span>\")"},
  "w100-val-name-js-amber": {"file":"Model_Center.html","edits":[["<span style=\"color:var(--c-link);\">${tableName}</span>","<span style=\"color:#b45309;\">${tableName}</span>"]],"probe":"openValidationModal.toString().includes(\"<span style=\\\"color:#b45309;\\\">${tableName}</span>\")"},
  "w100-val-sec-semantic-amber": {"file":"Model_Center.html","edits":[["<div style=\"font-weight:600; color:var(--c-link); margin-bottom:10px;\">${clipIcon}语义审查内容：","<div style=\"font-weight:600; color:#b45309; margin-bottom:10px;\">${clipIcon}语义审查内容："]],"probe":"openValidationModal.toString().includes(\"<div style=\\\"font-weight:600; color:#b45309; margin-bottom:10px;\\\">${clipIcon}语义审查内容：\")"},
  "w100-val-sec-dimstruct-amber": {"file":"Model_Center.html","edits":[["<div style=\"font-weight:600; color:var(--c-link); margin-bottom:10px;\">${clipIcon}结构验收检查项（10 项）：","<div style=\"font-weight:600; color:#b45309; margin-bottom:10px;\">${clipIcon}结构验收检查项（10 项）："]],"probe":"openValidationModal.toString().includes(\"<div style=\\\"font-weight:600; color:#b45309; margin-bottom:10px;\\\">${clipIcon}结构验收检查项（10 项）：\")"},
  "w100-val-sec-dimdata-amber": {"file":"Model_Center.html","edits":[["<div style=\"font-weight:600; color:var(--c-link); margin-bottom:10px;\">${clipIcon}数据验收检查项（5 项）：","<div style=\"font-weight:600; color:#b45309; margin-bottom:10px;\">${clipIcon}数据验收检查项（5 项）："]],"probe":"openValidationModal.toString().includes(\"<div style=\\\"font-weight:600; color:#b45309; margin-bottom:10px;\\\">${clipIcon}数据验收检查项（5 项）：\")"},
  "w100-val-sec-dwdstruct-amber": {"file":"Model_Center.html","edits":[["<div style=\"font-weight:600; color:var(--c-link); margin-bottom:10px;\">${clipIcon}结构验收检查项（7~8 项）：","<div style=\"font-weight:600; color:#b45309; margin-bottom:10px;\">${clipIcon}结构验收检查项（7~8 项）："]],"probe":"openValidationModal.toString().includes(\"<div style=\\\"font-weight:600; color:#b45309; margin-bottom:10px;\\\">${clipIcon}结构验收检查项（7~8 项）：\")"},
  "w100-val-sec-dwddata-amber": {"file":"Model_Center.html","edits":[["<div style=\"font-weight:600; color:var(--c-link); margin-bottom:10px;\">${clipIcon}数据验收检查项（6 项）：","<div style=\"font-weight:600; color:#b45309; margin-bottom:10px;\">${clipIcon}数据验收检查项（6 项）："]],"probe":"openValidationModal.toString().includes(\"<div style=\\\"font-weight:600; color:#b45309; margin-bottom:10px;\\\">${clipIcon}数据验收检查项（6 项）：\")"},
  "w100-val-sec-ods-amber": {"file":"Model_Center.html","edits":[["<div style=\"font-weight:600; color:var(--c-link); margin-bottom:10px;\">${clipIcon}验收检查项：","<div style=\"font-weight:600; color:#b45309; margin-bottom:10px;\">${clipIcon}验收检查项："]],"probe":"openValidationModal.toString().includes(\"<div style=\\\"font-weight:600; color:#b45309; margin-bottom:10px;\\\">${clipIcon}验收检查项：\")"},
  "w100-toggle-ddl-amber": {"file":"Model_Center.html","edits":[["editBtn.style.background = editMode ? 'var(--color-accent)' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n            if (saveBtn) saveBtn.style.display = editMode ? 'inline-flex' : 'none';\n        }\n\n        // =","editBtn.style.background = editMode ? '#f59e0b' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n            if (saveBtn) saveBtn.style.display = editMode ? 'inline-flex' : 'none';\n        }\n\n        // ="]],"probe":"toggleCustomDdlEditMode.toString().includes(\"editBtn.style.background = editMode ? '#f59e0b' : '#f8fafc';\")"},
  "w100-toggle-etl-amber": {"file":"Model_Center.html","edits":[["editBtn.style.background = editMode ? 'var(--color-accent)' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        /","editBtn.style.background = editMode ? '#f59e0b' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        /"]],"probe":"toggleCustomEtlEditMode.toString().includes(\"editBtn.style.background = editMode ? '#f59e0b' : '#f8fafc';\")"},
  "w100-toggle-fdl-amber": {"file":"Model_Center.html","edits":[["editBtn.style.background = editMode ? 'var(--color-accent)' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        f","editBtn.style.background = editMode ? '#f59e0b' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        f"]],"probe":"toggleCustomFdlEditMode.toString().includes(\"editBtn.style.background = editMode ? '#f59e0b' : '#f8fafc';\")"},
  "w100-toggle-dimetl-amber": {"file":"Model_Center.html","edits":[["editBtn.style.background = editMode ? 'var(--color-accent)' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n            if (saveBtn) saveBtn.style.display = editMode ? 'inline-flex' : 'none';\n        }\n\n        // 保","editBtn.style.background = editMode ? '#f59e0b' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n            if (saveBtn) saveBtn.style.display = editMode ? 'inline-flex' : 'none';\n        }\n\n        // 保"]],"probe":"toggleEtlEditMode.toString().includes(\"editBtn.style.background = editMode ? '#f59e0b' : '#f8fafc';\")"},
  "w100-toggle-ddl-border-amber": {"file":"Model_Center.html","edits":[["editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n            if (saveBtn) saveBtn.style.display = editMode ? 'inline-flex' : 'none';\n        }\n\n        // =","editBtn.style.border = editMode ? '1px solid #d97706' : '1px solid #d1d5db';\n            }\n            if (saveBtn) saveBtn.style.display = editMode ? 'inline-flex' : 'none';\n        }\n\n        // ="]],"probe":"toggleCustomDdlEditMode.toString().includes(\"editBtn.style.border = editMode ? '1px solid #d97706' : '1px solid #d1d5db';\")"},
  "w100-toggle-ddl-off-changed": {"file":"Model_Center.html","edits":[["editBtn.style.background = editMode ? 'var(--color-accent)' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n            if (saveBtn) saveBtn.style.display = editMode ? 'inline-flex' : 'none';\n        }\n\n        // =","editBtn.style.background = editMode ? 'var(--color-accent)' : 'var(--color-accent-soft)';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n            if (saveBtn) saveBtn.style.display = editMode ? 'inline-flex' : 'none';\n        }\n\n        // ="]],"probe":"toggleCustomDdlEditMode.toString().includes(\"editBtn.style.background = editMode ? 'var(--color-accent)' : 'var(--color-accent-soft)';\")"},
  "w100-regsource-bg-amber": {"file":"Model_Center.html","edits":[["margin-top:15px; padding:15px; background:var(--color-accent-soft); border-radius:8px;\">","margin-top:15px; padding:15px; background:#fffbeb; border-radius:8px;\">"]],"probe":"document.getElementById('regSourceSection').getAttribute('style').includes('#fffbeb')"},
  "w100-regsource-title-amber": {"file":"Model_Center.html","edits":[["<div style=\"font-size:0.9em; color:var(--c-link); font-weight:600; margin-bottom:10px;\"><svg width=\"14\"","<div style=\"font-size:0.9em; color:#b45309; font-weight:600; margin-bottom:10px;\"><svg width=\"14\""]],"probe":"document.getElementById('regSourceSection').firstElementChild.getAttribute('style').includes('#b45309')"},
  "w100-batch-box-amber": {"file":"Model_Center.html","edits":[["<div style=\"flex:1; padding:20px; background:var(--color-accent-soft); border-radius:8px; border:1px solid var(--color-accent-line);\">","<div style=\"flex:1; padding:20px; background:#fffbeb; border-radius:8px; border:1px solid #fcd34d;\">"]],"probe":"Array.from(document.querySelectorAll('#batchImportModal h4')).find((h) => h.textContent.includes('第二步')).parentElement.getAttribute('style').includes('#fcd34d')"},
  "w100-batch-title-amber": {"file":"Model_Center.html","edits":[["<h4 style=\"margin:0 0 10px 0; color:var(--c-link);\">","<h4 style=\"margin:0 0 10px 0; color:#b45309;\">"]],"probe":"Array.from(document.querySelectorAll('#batchImportModal h4')).find((h) => h.textContent.includes('第二步')).getAttribute('style').includes('#b45309')"},
  "w100-batch-note-amber": {"file":"Model_Center.html","edits":[["<div style=\"background:var(--color-accent-soft); padding:15px; border-radius:8px; font-size:0.85em; color:var(--c-link);\">","<div style=\"background:#fef3c7; padding:15px; border-radius:8px; font-size:0.85em; color:#92400e;\">"]],"probe":"Array.from(document.querySelectorAll('#batchImportModal strong')).find((s) => s.textContent.includes('模板说明')).parentElement.getAttribute('style').includes('#fef3c7')"},
  "w100-ddl-infobar-amber": {"file":"Model_Center.html","edits":[["<div style=\"background:var(--color-accent-soft); padding:15px; border-radius:8px; margin-bottom:20px;\">","<div style=\"background:#fffbeb; padding:15px; border-radius:8px; margin-bottom:20px;\">"]],"probe":"document.getElementById('ddlTableName').closest('div[style*=\"margin-bottom:20px\"]').getAttribute('style').includes('#fffbeb')"},
  "w100-ddl-name-amber": {"file":"Model_Center.html","edits":[["<strong id=\"ddlTableName\" style=\"color:var(--c-link); font-family:monospace;\">","<strong id=\"ddlTableName\" style=\"color:#b45309; font-family:monospace;\">"]],"probe":"document.getElementById('ddlTableName').getAttribute('style').includes('#b45309')"},
  "w100-val-name-static-amber": {"file":"Model_Center.html","edits":[["<span id=\"validationTableName\" style=\"color:var(--c-link);\"></span>","<span id=\"validationTableName\" style=\"color:#b45309;\"></span>"]],"probe":"document.getElementById('validationTableName').getAttribute('style').includes('#b45309')"},
  "w100-val-checklist-amber": {"file":"Model_Center.html","edits":[["style=\"background:var(--color-accent-soft); border:1px solid var(--color-accent-line); border-radius:8px; padding:15px; text-align:left; margin-bottom:20px;\">","style=\"background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; padding:15px; text-align:left; margin-bottom:20px;\">"]],"probe":"document.getElementById('validationChecklistBox').getAttribute('style').includes('#fcd34d')"},
  "w100-sem-batch-tip-accent": {"file":"Model_Center.html","edits":[["<p style=\"margin:10px 0 0 0; color:#b45309;\">","<p style=\"margin:10px 0 0 0; color:var(--c-link);\">"]],"probe":"Array.from(document.querySelectorAll('#batchImportModal p')).find((p) => p.textContent.includes('批量导入的模型状态')).getAttribute('style').includes('var(--c-link)')"},
  "w100-sem-decision-accent": {"file":"Model_Center.html","edits":[["regDecisionSection.style.background = '#fffbeb';","regDecisionSection.style.background = 'var(--color-accent-soft)';"]],"probe":"openEditModal.toString().includes(\"regDecisionSection.style.background = 'var(--color-accent-soft)';\")"},
  "w100-sem-testwarn-accent": {"file":"Model_Center.html","edits":[["warn ? '#d97706'","warn ? 'var(--color-accent)'"]],"probe":"viewTestRecordsReadOnly.toString().includes(\"warn ? 'var(--color-accent)'\")"},
  "w100-sem-datafix-accent": {"file":"Model_Center.html","edits":[["<span style=\"color:#f97316;\">修复</span>'\n            }","<span style=\"color:var(--color-accent);\">修复</span>'\n            }"]],"probe":"viewIterationHistory.toString().includes(\"<span style=\\\"color:var(--color-accent);\\\">修复</span>\")"},
  "w100-sem-update-accent": {"file":"Model_Center.html","edits":[["<span style=\"color:#f59e0b;\">修改</span>","<span style=\"color:var(--color-accent);\">修改</span>"]],"probe":"viewModelChangeLogs.toString().includes(\"<span style=\\\"color:var(--color-accent);\\\">修改</span>\")"},
  "w100-sem-custombadge-accent": {"file":"Model_Center.html","edits":[["background:#f59e0b; color:white; padding:2px 8px; border-radius:4px; margin-left:10px;\">自定义</span>\n                            </h3>\n                            <button onclick=\"closeDimD","background:var(--color-accent); color:white; padding:2px 8px; border-radius:4px; margin-left:10px;\">自定义</span>\n                            </h3>\n                            <button onclick=\"closeDimD"]],"probe":"openCustomDDLEditor.toString().includes(\"background:var(--color-accent); color:white; padding:2px 8px;\")"},
  "w100-sem-customtip-accent": {"file":"Model_Center.html","edits":[["background:#fef3c7; padding:8px 15px; border-radius:6px; font-size:0.82em; color:#92400e;","background:var(--color-accent-soft); padding:8px 15px; border-radius:6px; font-size:0.82em; color:var(--c-link);"]],"probe":"openCustomDDLEditor.toString().includes(\"background:var(--color-accent-soft); padding:8px 15px; border-radius:6px; font-size:0.82em; color:var(--c-link);\")"},
  "w100-sem-odstip-accent": {"file":"Model_Center.html","edits":[["style=\"margin-top:20px; padding:15px; background:#fefce8; border:1px solid #fde047; border-radius:8px; font-size:0.85em; color:#854d0e;\">","style=\"margin-top:20px; padding:15px; background:var(--color-accent-soft); border:1px solid var(--color-accent-line); border-radius:8px; font-size:0.85em; color:var(--c-link);\">"]],"probe":"Array.from(document.querySelectorAll('#ddlModal div')).some((d) => (d.getAttribute('style') || '').includes('background:var(--color-accent-soft); border:1px solid var(--color-accent-line); border-radius:8px; font-size:0.85em'))"},
  "w100-sql-accent": {"file":"Model_Center.html","edits":[["result += '<span style=\"color:#fbbf24;\">'","result += '<span style=\"color:var(--color-accent);\">'"]],"probe":"highlightSQL.toString().includes(\"result += '<span style=\\\"color:var(--color-accent);\\\">'\")"},
  "w100-rail-focus-var-missing": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n",""]],"probe":"getComputedStyle(document.getElementById('catalogRail')).getPropertyValue('--catalog-focus').trim() === '#4f46e5'"},
  "w100-focus-var-on-main": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        main.workbench-container { --catalog-focus: #818cf8; }\n"]],"probe":"getComputedStyle(document.querySelector('main.workbench-container')).getPropertyValue('--catalog-focus').trim() === '#818cf8'"},
  "w100-rail-focus-wrong-color": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-on-fg); }\n"]],"probe":"getComputedStyle(document.getElementById('catalogRail')).getPropertyValue('--catalog-focus').trim() === '#c7d2fe'"},
  "w100-drawer-head-no-override": {"file":"Model_Center.html","edits":[["        #modelDetailDrawer .u-drawer-header { background: var(--drawer-head-bg); color: var(--drawer-head-fg); }\n",""]],"probe":"getComputedStyle(document.querySelector('#modelDetailDrawer .u-drawer-header')).backgroundColor === 'rgb(217, 119, 6)'"},
  "w100-reg-confirm-accent": {"file":"Model_Center.html","edits":[["document.getElementById('confirmRegisterBtn').style.background = '#6b7280';","document.getElementById('confirmRegisterBtn').style.background = 'var(--color-accent)';"]],"probe":"openEditModal.toString().includes(\"document.getElementById('confirmRegisterBtn').style.background = 'var(--color-accent)';\")"},
  "w100-rail-bg-low-contrast": {"file":"Model_Center.html","edits":[[".catalog-rail { --rail-bg: #1e293b;",".catalog-rail { --rail-bg: #818cf8;"]],"probe":"getComputedStyle(document.getElementById('catalogRail')).backgroundColor === 'rgb(129, 140, 248)'"},
  "w100-drawer-close-no-override": {"file":"Model_Center.html","edits":[["        #modelDetailDrawer .u-drawer-close { color: #cbd5e1; border-radius: 4px; }\n        #modelDetailDrawer .u-drawer-close:hover { color: #fff; background: rgba(255, 255, 255, 0.18); }\n",""]],"probe":"getComputedStyle(document.querySelector('#modelDetailDrawer .u-drawer-close')).color === 'rgb(107, 114, 128)'"},
  "w100-drawer-close-no-hover": {"file":"Model_Center.html","edits":[["        #modelDetailDrawer .u-drawer-close:hover { color: #fff; background: rgba(255, 255, 255, 0.18); }\n",""]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelDetailDrawer .u-drawer-close { color: #cbd5e1; border-radius: 4px; }\")) && !Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".u-drawer-close:hover\"))"},
  "w100-drawer-close-hover-dark": {"file":"Model_Center.html","edits":[["#modelDetailDrawer .u-drawer-close:hover { color: #fff;","#modelDetailDrawer .u-drawer-close:hover { color: #111827;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".u-drawer-close:hover { color: #111827;\"))"},
  // —— C4e codex 43 收口批 fix43 新增（W99 / W100 / W101 判别力补强；改 Model_Center.html；探针确认变异已装载。eq99-* 是已核实的等价变异，不判红，见 fix43 报告）
  "eq99-selected-no-important": {"file":"Model_Center.html","edits":[["        #modelListBody .selected-row { background: var(--row-sel) !important; box-shadow: inset 3px 0 0 var(--color-accent); }","        #modelListBody .selected-row { background: var(--row-sel); box-shadow: inset 3px 0 0 var(--color-accent); }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelListBody .selected-row { background: var(--row-sel); box-shadow\"))"},
  "w99-selected-lowspec": {"file":"Model_Center.html","edits":[["        #modelListBody .selected-row { background: var(--row-sel) !important; box-shadow: inset 3px 0 0 var(--color-accent); }","        .selected-row { background: var(--row-sel); box-shadow: inset 3px 0 0 var(--color-accent); }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"        .selected-row { background: var(--row-sel); box-shadow\"))"},
  "w99-selected-hover-wins": {"file":"Model_Center.html","edits":[["        .catalog-entry:hover { background: var(--row-hover); }","        #modelListBody .catalog-entry:hover { background: var(--row-hover) !important; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelListBody .catalog-entry:hover { background: var(--row-hover) !important; }\"))"},
  "w99-body-row-open-leak": {"file":"Model_Center.html","edits":[["        body { background: #f1f5f9; }\n","        body { background: #f1f5f9; --row-open: #f5f6ff; }\n"]],"probe":"getComputedStyle(document.body).getPropertyValue('--row-open').trim() === '#f5f6ff'"},
  "w99-body-shared-leak": {"file":"Model_Center.html","edits":[["        body { background: #f1f5f9; }\n","        body { background: #f1f5f9; --color-border-strong: #cbd5e1; }\n"]],"probe":"getComputedStyle(document.body).getPropertyValue('--color-border-strong').trim() === '#cbd5e1'"},
  "w99-root-rail-leak": {"file":"Model_Center.html","edits":[["        body { background: #f1f5f9; }\n","        body { background: #f1f5f9; }\n        html { --rail-on-pill: #4338ca; }\n"]],"probe":"getComputedStyle(document.documentElement).getPropertyValue('--rail-on-pill').trim() === '#4338ca'"},
  "w99-bar-content-none": {"file":"Model_Center.html","edits":[[".catalog-rail-item.is-on::before { content: \"\";",".catalog-rail-item.is-on::before { content: none;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-rail-item.is-on::before { content: none;\"))"},
  "w99-bar-display-none": {"file":"Model_Center.html","edits":[[".catalog-rail-item.is-on::before { content: \"\"; position: absolute;",".catalog-rail-item.is-on::before { content: \"\"; display: none; position: absolute;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\".catalog-rail-item.is-on::before { content: \\\"\\\"; display: none; position: absolute;\"))"},
  "w99-bar-zero-height": {"file":"Model_Center.html","edits":[["left: 2px; top: 6px; bottom: 6px; width: 3px; border-radius: 2px; background: var(--rail-bar); }","left: 2px; top: 6px; height: 0; width: 3px; border-radius: 2px; background: var(--rail-bar); }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"left: 2px; top: 6px; height: 0; width: 3px;\"))"},
  "w100-save-ddl-shown-amber": {"file":"Model_Center.html","edits":[["if (saveBtn) saveBtn.style.display = editMode ? 'inline-flex' : 'none';\n        }\n\n        // =","if (saveBtn) { saveBtn.style.display = editMode ? 'inline-flex' : 'none'; if (editMode) saveBtn.style.background = '#d97706'; }\n        }\n\n        // ="]],"probe":"toggleCustomDdlEditMode.toString().includes(\"if (editMode) saveBtn.style.background = '#d97706';\")"},
  "w100-etl-exit-color-kept": {"file":"Model_Center.html","edits":[["editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        /","editBtn.style.color = editMode ? 'white' : 'white';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        /"]],"probe":"toggleCustomEtlEditMode.toString().includes(\"editBtn.style.color = editMode ? 'white' : 'white';\")"},
  "w100-fdl-exit-bg-kept": {"file":"Model_Center.html","edits":[["editBtn.style.background = editMode ? 'var(--color-accent)' : '#f8fafc';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        f","editBtn.style.background = editMode ? 'var(--color-accent)' : 'var(--color-accent)';\n                editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        f"]],"probe":"toggleCustomFdlEditMode.toString().includes(\"editBtn.style.background = editMode ? 'var(--color-accent)' : 'var(--color-accent)';\")"},
  "w100-fdl-exit-color-kept": {"file":"Model_Center.html","edits":[["editBtn.style.color = editMode ? 'white' : '#6b7280';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        f","editBtn.style.color = editMode ? 'white' : 'white';\n                editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        f"]],"probe":"toggleCustomFdlEditMode.toString().includes(\"editBtn.style.color = editMode ? 'white' : 'white';\")"},
  "w100-fdl-exit-border-kept": {"file":"Model_Center.html","edits":[["editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid #d1d5db';\n            }\n        }\n\n        f","editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid var(--color-accent)';\n            }\n        }\n\n        f"]],"probe":"toggleCustomFdlEditMode.toString().includes(\"editBtn.style.border = editMode ? '1px solid var(--color-accent)' : '1px solid var(--color-accent)';\")"},
  "w100-icon-child-customddl": {"file":"Model_Center.html","edits":[["stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z\"/></svg>\n                                D","stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path stroke=\"#d97706\" d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z\"/></svg>\n                                D"]],"probe":"openCustomDDLEditor.toString().includes(\"<path stroke=\\\"#d97706\\\" d=\\\"M12 20h9\\\"/>\")"},
  "w100-icon-child-custometl": {"file":"Model_Center.html","edits":[["stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z\"/></svg>\n                                E","stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path stroke=\"#d97706\" d=\"M12 20h9\"/><path d=\"M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z\"/></svg>\n                                E"]],"probe":"openCustomETLEditor.toString().includes(\"<path stroke=\\\"#d97706\\\" d=\\\"M12 20h9\\\"/>\")"},
  "w100-icon-child-dimddl": {"file":"Model_Center.html","edits":[["stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M14","stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path stroke=\"#d97706\" d=\"M14"]],"probe":"showDimDDLPreviewModal.toString().includes(\"<path stroke=\\\"#d97706\\\" d=\\\"M14\")"},
  "w100-icon-child-dwdddl": {"file":"Model_Center.html","edits":[["stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path d=\"M16","stroke-width=\"2\" style=\"vertical-align:middle; margin-right:8px; stroke:var(--color-accent);\"><path stroke=\"#d97706\" d=\"M16"]],"probe":"showDwdDDLPreviewModal.toString().includes(\"<path stroke=\\\"#d97706\\\" d=\\\"M16\")"},
  "w100-root-hidden-dimddl": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #dimDdlPreviewModal { display: none !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#dimDdlPreviewModal { display: none !important; }\"))"},
  "w100-root-hidden-dimetl": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #dimEtlPreviewModal { display: none !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#dimEtlPreviewModal { display: none !important; }\"))"},
  "w100-root-hidden-dwdddl": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #dwdDdlModal { display: none !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#dwdDdlModal { display: none !important; }\"))"},
  "w100-root-hidden-dwdetl": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #dwdEtlPreviewModal { display: none !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#dwdEtlPreviewModal { display: none !important; }\"))"},
  "w100-root-hidden-drawertest": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #modelDrawerTestModal { display: none !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelDrawerTestModal { display: none !important; }\"))"},
  "w100-root-hidden-iteration": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #iterationHistoryModal { display: none !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#iterationHistoryModal { display: none !important; }\"))"},
  "w100-root-hidden-changelogs": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #changeLogsModal { display: none !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#changeLogsModal { display: none !important; }\"))"},
  "w100-root-hidden-scriptdiff": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #scriptDiffModal { display: none !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#scriptDiffModal { display: none !important; }\"))"},
  "w100-root-hidden-designnotes": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #designNotesPopover { display: none !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#designNotesPopover { display: none !important; }\"))"},
  "w100-focus-width-rail-0": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #catalogRail :focus-visible { outline-width: 0 !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#catalogRail :focus-visible { outline-width: 0 !important; }\"))"},
  "w100-focus-width-list-0": {"file":"Model_Center.html","edits":[["        #catalogRail { --catalog-focus: var(--rail-bar); }\n","        #catalogRail { --catalog-focus: var(--rail-bar); }\n        #modelListBody :focus-visible { outline-width: 0 !important; }\n"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelListBody :focus-visible { outline-width: 0 !important; }\"))"},
  // —— C5：抽屉概览三行 + 时间线「验收后」（W102–W108，含预筛修复批、修复批 2 / 3 / 4 / 5 与 codex 44 收口批新增；改 Model_Center.html，w108-settle-before-count / w108-settle-only-on-success 改 model-catalog.js；探针确认变异已装载。eq107-* 是已核实的等价变异，不判红，见各段注释）
  "w102-drawer-uses-list": {"file":"Model_Center.html","edits":[["const rows = [['最近验收', mdcAcceptanceValue(m.acceptance)]];","const rows = [['最近验收', mdcAcceptanceValue((allModelsData.find(x => String(x.id) === String(m.id)) || {}).acceptance)]];"]],"probe":"mdcAcceptanceNoteRows.toString().includes(\"allModelsData.find(x => String(x.id) === String(m.id))\")"},
  "w102-date-mmdd": {"file":"Model_Center.html","edits":[["text: mdcNormTime(acc.at).slice(0, 16) || String(acc.at)","text: v.date"]],"probe":"mdcAcceptanceValue.toString().includes(\"className: 'mdc-acc-date', text: v.date\")"},
  "w102-no-reason": {"file":"Model_Center.html","edits":[["if (typeof acc.reason === 'string' && acc.reason.trim() !== '') {","if (false) {"]],"probe":"mdcAcceptanceValue.toString().includes(\"if (false) { wrap.appendChild(mdcEl(\")"},
  "w102-companion-no-acc": {"file":"Model_Center.html","edits":[["const rows = [['最近验收', mdcAcceptanceValue(m.acceptance)]];","const rows = isCompanion ? [] : [['最近验收', mdcAcceptanceValue(m.acceptance)]];"]],"probe":"mdcAcceptanceNoteRows.toString().includes(\"isCompanion ? [] :\")"},
  "w102-custom-no-rows": {"file":"Model_Center.html","edits":[["mdcAcceptanceNoteRows(detail._rawModel, false).forEach(r => rows.push(r)); // C5：最近验收 / 实现说明 / 设计说明三行（接在现有 kv 之后）","void 0; /* mut custom-no-rows */"]],"probe":"mdcRenderCustomView.toString().includes(\"mut custom-no-rows\")"},
  "w102-prose-no-prewrap": {"file":"Model_Center.html","edits":[["#modelDrawerBody .mdc-prose { display: block; white-space: pre-wrap;","#modelDrawerBody .mdc-prose { display: block;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelDrawerBody .mdc-prose { display: block; overflow-wrap\"))"},
  "w102-no-placeholder": {"file":"Model_Center.html","edits":[["mdcProseValue(m.impl_note, '（未填写实现说明）')","mdcProseValue(m.impl_note, '')"]],"probe":"mdcAcceptanceNoteRows.toString().includes(\"mdcProseValue(m.impl_note, '')\")"},
  "w102-companion-always-notes": {"file":"Model_Center.html","edits":[["if (!isCompanion || hasText(m.impl_note)) {","if (true) {"]],"probe":"mdcAcceptanceNoteRows.toString().includes(\"if (true) { rows.push([\")"},
  "w102-stale-old-wording": {"file":"Model_Center.html","edits":[["function mdcStaleLead(acc) { return acc.prevResult === 'warn' ? '上次通过（有警告）' : '上次通过 '; }","function mdcStaleLead(acc) { return '上次结果 '; }"]],"probe":"mdcStaleLead.toString().includes(\"return '上次结果 '\")"},
  "w102-stale-warn-no-note": {"file":"Model_Center.html","edits":[["function mdcStaleLead(acc) { return acc.prevResult === 'warn' ? '上次通过（有警告）' : '上次通过 '; }","function mdcStaleLead(acc) { return acc.prevResult === 'warn' ? '上次通过 ' : '上次通过 '; }"]],"probe":"mdcStaleLead.toString().includes(\"acc.prevResult === 'warn' ? '上次通过 ' : '上次通过 '\")"},
  "w102-date-weak": {"file":"Model_Center.html","edits":[["#modelDrawerBody .mdc-acc-date { color: var(--color-text-secondary, #475569); font-family: Consolas, monospace; font-size: 11.5px; }","#modelDrawerBody .mdc-acc-date { color: var(--color-text-muted, #94a3b8); font-family: Consolas, monospace; font-size: 11.5px; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelDrawerBody .mdc-acc-date { color: var(--color-text-muted, #94a3b8); font-family: Consolas\"))"},
  "w103-none-shows-date": {"file":"Model_Center.html","edits":[["if (v.date) {","if (acc.at) {"]],"probe":"mdcAcceptanceValue.toString().includes(\"if (acc.at) { line.appendChild(\")"},
  "w102-stale-no-badge": {"file":"Model_Center.html","edits":[["if (v.staleBadge) {","if (false) {"]],"probe":"mdcAcceptanceValue.toString().includes(\"if (false) { line.appendChild(mdcEl('span', { className: 'mdc-acc-recheck'\")"},
  "w103-null-as-none": {"file":"Model_Center.html","edits":[["text: '验收状态暂不可用' }));","text: '无验收' }));"]],"probe":"mdcAcceptanceValue.toString().includes(\"text: '无验收' }));\")"},
  "w103-unknown-throws": {"file":"Model_Center.html","edits":[["try { v = ModelCatalogCore.acceptanceView(acc); } catch (e) { console.warn('[模型抽屉] 验收摘要无法识别：', e && e.message); }","v = ModelCatalogCore.acceptanceView(acc);"]],"probe":"!mdcAcceptanceValue.toString().includes(\"catch (e)\")"},
  "w102-stale-text-plain": {"file":"Model_Center.html","edits":[["text: v.kind === 'stale' ? mdcStaleLead(acc) + v.text : v.text","text: v.text"]],"probe":"!mdcAcceptanceValue.toString().includes(\"mdcStaleLead\")"},
  "w102-recheck-accent": {"file":"Model_Center.html","edits":[["#modelDrawerBody .mdc-acc-recheck { padding: 1px 6px; border-radius: 8px; background: #fef3c7; color: #b45309;","#modelDrawerBody .mdc-acc-recheck { padding: 1px 6px; border-radius: 8px; background: var(--color-accent); color: #fff;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelDrawerBody .mdc-acc-recheck { padding: 1px 6px; border-radius: 8px; background: var(--color-accent); color: #fff;\"))"},
  "w104-empty-not-weak": {"file":"Model_Center.html","edits":[["#modelDrawerBody .mdc-prose-empty { color: var(--color-text-muted, #94a3b8); }","#modelDrawerBody .mdc-prose-empty { color: #111827; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelDrawerBody .mdc-prose-empty { color: #111827; }\"))"},
  "w104-companion-never-notes": {"file":"Model_Center.html","edits":[["if (!isCompanion || hasText(m.impl_note)) {","if (!isCompanion) {"],["if (!isCompanion || hasText(m.design_notes)) {","if (!isCompanion) {"]],"probe":"mdcAcceptanceNoteRows.toString().includes(\"if (!isCompanion) { rows.push(['实现说明'\")"},
  "w104-ods-no-rows": {"file":"Model_Center.html","edits":[["mdcAcceptanceNoteRows(detail._rawModel, false).forEach(r => kvRows.push(r)); // C5：最近验收 / 实现说明 / 设计说明三行（接在现有 kv 之后）","if (detail.kind !== 'ods') { mdcAcceptanceNoteRows(detail._rawModel, false).forEach(r => kvRows.push(r)); }"]],"probe":"renderModelDrawer.toString().includes(\"if (detail.kind !== 'ods') { mdcAcceptanceNoteRows(\")"},
  "w105-prose-innerhtml": {"file":"Model_Center.html","edits":[["return mdcEl('span', { className: has ? 'mdc-prose' : 'mdc-prose mdc-prose-empty', text: has ? String(text) : emptyText });","const el = mdcEl('span', { className: has ? 'mdc-prose' : 'mdc-prose mdc-prose-empty' }); el.innerHTML = has ? String(text) : emptyText; return el;"]],"probe":"mdcProseValue.toString().includes(\"el.innerHTML = has ?\")"},
  "w105-reason-innerhtml": {"file":"Model_Center.html","edits":[["wrap.appendChild(mdcEl('span', { className: 'mdc-acc-reason', text: acc.reason }));","const rs = mdcEl('span', { className: 'mdc-acc-reason' }); rs.innerHTML = acc.reason; wrap.appendChild(rs);"]],"probe":"mdcAcceptanceValue.toString().includes(\"rs.innerHTML = acc.reason\")"},
  "w106-tl-ge": {"file":"Model_Center.html","edits":[["logAt > markAt","logAt >= markAt"]],"probe":"loadFootprintTimeline.toString().includes(\"logAt >= markAt\")"},
  "w106-mark-all-states": {"file":"Model_Center.html","edits":[["if (['pass', 'warn', 'fail', 'partial', 'stale'].indexOf(acc.state) < 0) { return ''; }",""]],"probe":"!mdcTimelineMarkAt.toString().includes(\"'partial', 'stale'\")"},
  "w106-no-normalize": {"file":"Model_Center.html","edits":[["const logAt = mdcNormTime(log.created_at);","const logAt = String(log.created_at);"]],"probe":"loadFootprintTimeline.toString().includes(\"const logAt = String(log.created_at);\")"},
  "w106-tl-title-config": {"file":"Model_Center.html","edits":[["title: (markIsStale ? '发生在上次通过的验收（' : '发生在最近一次验收（') + markAt.slice(0, 16) + '）之后'","title: '配置变更于验收（' + markAt.slice(0, 16) + '）之后'"]],"probe":"loadFootprintTimeline.toString().includes(\"配置变更于验收（\")"},
  "w106-tl-title-stale-recent": {"file":"Model_Center.html","edits":[["title: (markIsStale ? '发生在上次通过的验收（' : '发生在最近一次验收（') + markAt.slice(0, 16) + '）之后'","title: '发生在最近一次验收（' + markAt.slice(0, 16) + '）之后'"]],"probe":"!loadFootprintTimeline.toString().includes(\"发生在上次通过的验收（\")"},
  "w106-after-amber": {"file":"Model_Center.html","edits":[["#modelDrawerBody .mdc-tl-after { font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 600; background: var(--color-bg-elevated, #f1f5f9); color: var(--color-text-secondary, #475569); border: 1px solid var(--color-border, #e2e8f0); flex-shrink: 0; }","#modelDrawerBody .mdc-tl-after { font-size: 10px; padding: 1px 6px; border-radius: 8px; font-weight: 600; background: #fef3c7; color: #b45309; border: 1px solid #fef3c7; flex-shrink: 0; }"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"background: #fef3c7; color: #b45309; border: 1px solid #fef3c7; flex-shrink: 0; }\"))"},
  "w106-parallel-timeline": {"file":"Model_Center.html","edits":[["const res = await mdcRequest(ctx, `/api/models/${ctx.modelId}`);\n                if (!mdcGuard(ctx) || !res) { return; }","mdcRequest(ctx, `/api/models/${ctx.modelId}/change-logs`).catch(() => {});\n                const res = await mdcRequest(ctx, `/api/models/${ctx.modelId}`);\n                if (!mdcGuard(ctx) || !res) { return; }"]],"probe":"loadModelDrawerDetail.toString().includes(\"/change-logs`).catch(() => {});\")"},
  "w107-race-timeline": {"file":"Model_Center.html","edits":[["const onNavAbort = () => { holder.reason = 'navigation'; holder.aborter.abort(); };","const onNavAbort = () => {};"],["const res = await mdcRequest(ctx, `/api/models/${modelId}/change-logs`);\n                if (!mdcGuard(ctx) || !res) { return; }","const res = await mdcRequest(ctx, `/api/models/${modelId}/change-logs`);\n                if (!res) { return; }"],["const logs = await res.json();\n                if (!mdcGuard(ctx)) { return; }","const logs = await res.json();"],["const parent = host.parentNode;","const foot2 = document.querySelector('#modelDrawerBody .foot-row'); const host2 = foot2 && foot2.previousElementSibling; const parent = (host2 || host).parentNode;"],["parent.replaceChild(tl, host);","parent.replaceChild(tl, host2 || host);"]],"probe":"loadFootprintTimeline.toString().includes(\"const host2 = foot2 && foot2.previousElementSibling\") && mdcRequest.toString().includes(\"const onNavAbort = () => {};\")"},
  "w107-race-detail": {"file":"Model_Center.html","edits":[["const onNavAbort = () => { holder.reason = 'navigation'; holder.aborter.abort(); };","const onNavAbort = () => {};"],["const res = await mdcRequest(ctx, `/api/models/${ctx.modelId}`);\n                if (!mdcGuard(ctx) || !res) { return; }","const res = await mdcRequest(ctx, `/api/models/${ctx.modelId}`);\n                if (!res) { return; }"],["const model = await res.json();\n                if (!mdcGuard(ctx)) { return; }\n                const detail = window.ModelDetailKit.normalizeModelDetail(model);","const model = await res.json();\n                const detail = window.ModelDetailKit.normalizeModelDetail(model);"]],"probe":"loadModelDrawerDetail.toString().includes(\"const model = await res.json();\\n                const detail = window.ModelDetailKit.normalizeModelDetail(model);\") && mdcRequest.toString().includes(\"const onNavAbort = () => {};\")"},
  "w107-guards-only-off": {"file":"Model_Center.html","edits":[["const res = await mdcRequest(ctx, `/api/models/${modelId}/change-logs`);\n                if (!mdcGuard(ctx) || !res) { return; }","const res = await mdcRequest(ctx, `/api/models/${modelId}/change-logs`);\n                if (!res) { return; }"],["const logs = await res.json();\n                if (!mdcGuard(ctx)) { return; }","const logs = await res.json();"],["const res = await mdcRequest(ctx, `/api/models/${ctx.modelId}`);\n                if (!mdcGuard(ctx) || !res) { return; }","const res = await mdcRequest(ctx, `/api/models/${ctx.modelId}`);\n                if (!res) { return; }"],["const model = await res.json();\n                if (!mdcGuard(ctx)) { return; }\n                const detail = window.ModelDetailKit.normalizeModelDetail(model);","const model = await res.json();\n                const detail = window.ModelDetailKit.normalizeModelDetail(model);"]],"probe":"loadModelDrawerDetail.toString().includes(\"const model = await res.json();\\n                const detail = window.ModelDetailKit.normalizeModelDetail(model);\") && loadFootprintTimeline.toString().includes(\"const logs = await res.json();\\n                const list\")"},
  "eq107-abort-only-off": {"file":"Model_Center.html","edits":[["const onNavAbort = () => { holder.reason = 'navigation'; holder.aborter.abort(); };","const onNavAbort = () => {};"]],"probe":"mdcRequest.toString().includes(\"const onNavAbort = () => {};\")"},
  "eq107-all-off-host-kept": {"file":"Model_Center.html","edits":[["const onNavAbort = () => { holder.reason = 'navigation'; holder.aborter.abort(); };","const onNavAbort = () => {};"],["const res = await mdcRequest(ctx, `/api/models/${modelId}/change-logs`);\n                if (!mdcGuard(ctx) || !res) { return; }","const res = await mdcRequest(ctx, `/api/models/${modelId}/change-logs`);\n                if (!res) { return; }"],["const logs = await res.json();\n                if (!mdcGuard(ctx)) { return; }","const logs = await res.json();"]],"probe":"loadFootprintTimeline.toString().includes(\"const logs = await res.json();\\n                const list\") && mdcRequest.toString().includes(\"const onNavAbort = () => {};\")"},
  "w108-no-reload": {"file":"Model_Center.html","edits":[["mdcReloadDrawerAfterWrite(interactive, refocusLabel);   // 修复批 MED-1：弹窗里写过 → 抽屉重载（见上）","void 0;"]],"probe":"!syncModelDrawerInert.toString().includes(\"mdcReloadDrawerAfterWrite(interactive\")"},
  "w108-reload-without-write": {"file":"Model_Center.html","edits":[["if (mdcWritesDone() <= ctx.writesBase) { return; }","if (!refocusLabel && !ctx.lastTriggerLabel) { return; }"]],"probe":"mdcReloadDrawerAfterWrite.toString().includes(\"if (!refocusLabel && !ctx.lastTriggerLabel) { return; }\")"},
  "w108-reload-wrong-model": {"file":"Model_Center.html","edits":[["openModelDrawer(ctx.modelId, ctx.openerEl, { refocusLabel: refocusLabel || ctx.lastTriggerLabel || '' });","openModelDrawer(50, ctx.openerEl, { refocusLabel: refocusLabel || ctx.lastTriggerLabel || '' });"]],"probe":"mdcReloadDrawerAfterWrite.toString().includes(\"openModelDrawer(50, ctx.openerEl\")"},
  "w108-no-refocus": {"file":"Model_Center.html","edits":[["mdcRestoreFocusAfterReload(ctx);   // 修复批 MED-1：重载后把焦点还给同文字的按钮（普通打开 refocusLabel 为空，无动作）","void 0;"]],"probe":"!loadModelDrawerDetail.toString().includes(\"mdcRestoreFocusAfterReload\")"},
  "w108-reopen-closed": {"file":"Model_Center.html","edits":[["const ctx = mdcCtx;\n            if (!interactive || !ctx || !mdcGuard(ctx)) { return; }","const ctx = mdcCtx || window.__mdcLastCtx;\n            if (!ctx) { return; }"],["const drawer = mdcDrawerEl();\n            document.getElementById('modelDrawerTitle').textContent = '模型详情';","const drawer = mdcDrawerEl();\n            window.__mdcLastCtx = ctx;\n            document.getElementById('modelDrawerTitle').textContent = '模型详情';"]],"probe":"mdcReloadDrawerAfterWrite.toString().includes(\"mdcCtx || window.__mdcLastCtx\") && openModelDrawer.toString().includes(\"window.__mdcLastCtx = ctx;\")"},
  "w108-base-not-per-ctx": {"file":"Model_Center.html","edits":[["writesBase: mdcWritesDone(),","writesBase: (opts ? mdcWritesDone() : (mdcCtx ? mdcCtx.writesBase : mdcWritesDone())),"]],"probe":"openModelDrawer.toString().includes(\"mdcCtx ? mdcCtx.writesBase : mdcWritesDone()\")"},
  "w108-no-hook-check": {"file":"Model_Center.html","edits":[["(typeof catalogHookModalOpen === 'function' && catalogHookModalOpen())","false"]],"probe":"mdcReloadDrawerAfterWrite.toString().includes(\"|| false) { return; }\")"},
  "w108-sync-no-hook-check": {"file":"Model_Center.html","edits":[["mdcReloadDrawerAfterWrite(interactive, refocusLabel);   // 修复批 MED-1：弹窗里写过 → 抽屉重载（见上）","{ const c = mdcCtx; if (interactive && c && mdcGuard(c) && !(typeof catalogWritesInFlight === 'number' && catalogWritesInFlight > 0) && mdcWritesDone() > c.writesBase && c.hookSeen === true) { openModelDrawer(c.modelId, c.openerEl, { refocusLabel: refocusLabel || c.lastTriggerLabel || '' }); } }"]],"probe":"syncModelDrawerInert.toString().includes(\"const c = mdcCtx; if (interactive && c && mdcGuard(c)\")"},
  "w108-reload-while-inflight": {"file":"Model_Center.html","edits":[["(typeof catalogWritesInFlight === 'number' && catalogWritesInFlight > 0) || ",""]],"probe":"!mdcReloadDrawerAfterWrite.toString().includes(\"catalogWritesInFlight\")"},
  "w108-no-settle-listener": {"file":"Model_Center.html","edits":[["document.addEventListener('modelcatalog:write-settled', () => {","document.addEventListener('modelcatalog:write-settled-x', () => {"]],"probe":"initModelDrawer.toString().includes(\"write-settled-x\")"},
  "w108-settle-before-count": {"file":"model-catalog.js","edits":[["                catalogWritesDone++;\n                reloadCatalogIfStale();\n                document.dispatchEvent(new CustomEvent('modelcatalog:write-settled'));","                document.dispatchEvent(new CustomEvent('modelcatalog:write-settled'));\n                catalogWritesDone++;\n                reloadCatalogIfStale();"]],"probe":"catalogTrackWrite.toString().indexOf('write-settled') < catalogTrackWrite.toString().indexOf('catalogWritesDone++')"},
  "w108-hookseen-not-set-on-click": {"file":"Model_Center.html","edits":[["if (mdcCtx) { mdcCtx.hookSeen = true; } mdcSubModalTrigger = e.currentTarget; (layer === 'DIM' ? openDimDDLModal : openDwdDDLModal)(modelId);","mdcSubModalTrigger = e.currentTarget; (layer === 'DIM' ? openDimDDLModal : openDwdDDLModal)(modelId);"]],"probe":"!mdcRenderCustomView.toString().includes(\"mdcCtx.hookSeen = true\")"},
  "w108-hookseen-on-readonly": {"file":"Model_Center.html","edits":[["btnTests.addEventListener('click', (e) => { mdcSubModalTrigger = e.currentTarget; viewTestRecordsReadOnly(modelId); });","btnTests.addEventListener('click', (e) => { if (mdcCtx) { mdcCtx.hookSeen = true; } mdcSubModalTrigger = e.currentTarget; viewTestRecordsReadOnly(modelId); });"]],"probe":"mdcRenderFootSection.toString().includes(\"if (mdcCtx) { mdcCtx.hookSeen = true; } mdcSubModalTrigger = e.currentTarget; viewTestRecordsReadOnly(modelId);\")"},
  "w108-hookseen-carry-on-reload": {"file":"Model_Center.html","edits":[["hookSeen: false,","hookSeen: !!(opts && mdcCtx && mdcCtx.hookSeen),"]],"probe":"openModelDrawer.toString().includes(\"hookSeen: !!(opts && mdcCtx && mdcCtx.hookSeen)\")"},
  "w108-hookseen-carry-on-switch": {"file":"Model_Center.html","edits":[["hookSeen: false,","hookSeen: !!(mdcCtx && mdcCtx.hookSeen),"]],"probe":"openModelDrawer.toString().includes(\"hookSeen: !!(mdcCtx && mdcCtx.hookSeen)\")"},
  "w108-hookseen-at-mount": {"file":"Model_Center.html","edits":[["window._customDdlModel = model;","window._customDdlModel = model; if (mdcCtx) { mdcCtx.hookSeen = true; }"]],"probe":"openCustomDDLEditor.toString().includes(\"window._customDdlModel = model; if (mdcCtx) { mdcCtx.hookSeen = true; }\")"},
  "w108-ignore-hookseen": {"file":"Model_Center.html","edits":[["if (ctx.hookSeen !== true) { return; }   // 修复批 3：这个抽屉没点过「查看 DDL →」 → 写不是它发起的，不重载（修复批 4：hookSeen 由该按钮的 click 处理置真）","void 0;"]],"probe":"!mdcReloadDrawerAfterWrite.toString().includes(\"hookSeen\")"},
  "w108-settle-ignores-modal": {"file":"Model_Center.html","edits":[["const interactive = !!drawer && drawer.classList.contains('open') && !isAnyModalOpen();","const interactive = !!drawer && drawer.classList.contains('open');"]],"probe":"initModelDrawer.toString().includes(\"const interactive = !!drawer && drawer.classList.contains('open');\")"},
  "w108-settle-only-on-success": {"file":"model-catalog.js","edits":[["document.dispatchEvent(new CustomEvent('modelcatalog:write-settled'));","Promise.resolve(promise).then(() => document.dispatchEvent(new CustomEvent('modelcatalog:write-settled')), () => {});"]],"probe":"catalogTrackWrite.toString().includes('.then(() => document.dispatchEvent')"},
  "w103-markat-ignores-view": {"file":"Model_Center.html","edits":[["            try { ModelCatalogCore.acceptanceView(acc); } catch (e) { return ''; }","            void 0;"]],"probe":"!mdcTimelineMarkAt.toString().includes(\"ModelCatalogCore.acceptanceView(acc); } catch\")"},
  "w102-recheck-hidden": {"file":"Model_Center.html","edits":[["#modelDrawerBody .mdc-acc-recheck { padding: 1px 6px;","#modelDrawerBody .mdc-acc-recheck { display: none; padding: 1px 6px;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelDrawerBody .mdc-acc-recheck { display: none; padding: 1px 6px;\"))"},
  "w102-reason-hidden": {"file":"Model_Center.html","edits":[["#modelDrawerBody .mdc-acc-reason { display: block;","#modelDrawerBody .mdc-acc-reason { display: none;"]],"probe":"Array.from(document.querySelectorAll('style')).some((e) => e.textContent.includes(\"#modelDrawerBody .mdc-acc-reason { display: none;\"))"},
  "w104-prose-trimmed": {"file":"Model_Center.html","edits":[["text: has ? String(text) : emptyText","text: has ? String(text).trim() : emptyText"]],"probe":"mdcProseValue.toString().includes(\"String(text).trim() : emptyText\")"},
  "w106-normtime-prefix-only": {"file":"Model_Center.html","edits":[["const m = /^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?(Z|[+-]\\d{2}:?\\d{2})?$/.exec(String(s === null || s === undefined ? '' : s).trim());","const m = /^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})/.exec(String(s === null || s === undefined ? '' : s).trim());"]],"probe":"mdcNormTime.toString().includes(\":(\\\\d{2})/.exec(String(s ===\")"},
  "w106-normtime-no-range": {"file":"Model_Center.html","edits":[["if (mo < 1 || mo > 12 || d < 1 || d > dim[mo - 1] || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) { return ''; }","void 0;"]],"probe":"!mdcNormTime.toString().includes(\"Number(m[6]) > 59\")"},
  "w106-normtime-convert-zone": {"file":"Model_Center.html","edits":[["return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6];","const z = m[7];\n            if (z) {\n                const sign = z[0] === '-' ? -1 : 1;\n                const off = z === 'Z' ? 0 : sign * (Number(z.slice(1, 3)) * 60 + Number(z.slice(-2))) * 60000;\n                const t = new Date(Date.UTC(y, mo - 1, d, Number(m[4]), Number(m[5]), Number(m[6])) - off);\n                const p2 = (n) => String(n).padStart(2, '0');\n                return t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' + p2(t.getUTCDate()) + ' ' + p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes()) + ':' + p2(t.getUTCSeconds());\n            }\n            return m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + m[6];"]],"probe":"mdcNormTime.toString().includes(\"Date.UTC(y, mo - 1, d\")"},
  // —— 末次合并审（M8 / H2）新增：改 Model_Center.html 的 confirmRegister（探针确认装上，否则抛错）
  "m8-always-dim": {"file":"Model_Center.html","edits":[["if (editScdTypeBaseline === null || scdType !== editScdTypeBaseline) {","if (true) {"]],"probe":"confirmRegister.toString().includes('if (true) {') && !confirmRegister.toString().includes('editScdTypeBaseline === null || scdType !== editScdTypeBaseline')"},
  "m8-uc-always": {"file":"Model_Center.html","edits":[["if (editScdTypeBaseline === null || scdNow !== editScdTypeBaseline) updateCycleValue =","if (true) updateCycleValue ="]],"probe":"confirmRegister.toString().includes('if (true) updateCycleValue =') && !confirmRegister.toString().includes('scdNow !== editScdTypeBaseline')"},
  "m8-cm-always": {"file":"Model_Center.html","edits":[["if (!isCompanionEdit && (editConfigModeBaseline === null || configMode !== editConfigModeBaseline)) payload.config_mode = configMode;","if (!isCompanionEdit && (true)) payload.config_mode = configMode;"]],"probe":"confirmRegister.toString().includes('!isCompanionEdit && (true)) payload.config_mode') && !confirmRegister.toString().includes('configMode !== editConfigModeBaseline')"},
  "m8-from-cache": {"file":"Model_Center.html","edits":[["const latest = await latestRes.json();","const latest = allModelsData.find(m => m.id == editId);"]],"probe":"confirmRegister.toString().includes('const latest = allModelsData.find(m => m.id == editId);')"},
  "m8-no-scd-overwrite": {"file":"Model_Center.html","edits":[["latestCfg.scdConfig.scdType = scdType;","void 0;"]],"probe":"confirmRegister.toString().includes('void 0;') && !confirmRegister.toString().includes('latestCfg.scdConfig.scdType = scdType')"},
  // 复审 47B MED-3：W109② 须断言「PUT 的 dim_config 除 scdType 外与 GET 返回的最新配置深度相等」——页面把 scdConfig 整体换成只有 scdType 的新对象（丢掉 scdConfig 里的其他子配置），或只回传 scdConfig（丢掉顶层其他配置）都须判红
  "m8-scdconfig-replace": {"file":"Model_Center.html","edits":[["latestCfg.scdConfig.scdType = scdType;","latestCfg.scdConfig = { scdType: scdType };"]],"probe":"confirmRegister.toString().includes('latestCfg.scdConfig = { scdType: scdType };') && !confirmRegister.toString().includes('latestCfg.scdConfig.scdType = scdType')"},
  "m8-drop-top-level": {"file":"Model_Center.html","edits":[["payload.dim_config = latestCfg;","payload.dim_config = { scdConfig: latestCfg.scdConfig };"]],"probe":"confirmRegister.toString().includes('payload.dim_config = { scdConfig: latestCfg.scdConfig };') && !confirmRegister.toString().includes('payload.dim_config = latestCfg;')"},
  "m409-off": {"file":"Model_Center.html","edits":[["} else if (res.status === 409) {","} else if (false) {"]],"probe":"confirmRegister.toString().includes('} else if (false) {')"},
  // —— P53 = B：ODS 验收后自动保存先 GET 最新行，请求体带 purpose 与最新行 config_rev（用列表缓存的版本 / GET 失败回退到缓存都须判红）
  "p53-cache-rev": {"file":"Model_Center.html","edits":[["expected_config_rev: latest.config_rev,","expected_config_rev: model.config_rev,"]],"probe":"autoSaveOdsScripts.toString().includes('expected_config_rev: model.config_rev,')"},
  "p53-fallback-cache": {"file":"Model_Center.html","edits":[["if (!latestRes.ok) throw new Error(`读取最新模型行失败（HTTP ${latestRes.status}），不自动保存`);\n                const latest = await latestRes.json();","const latest = latestRes.ok ? await latestRes.json() : model;"]],"probe":"autoSaveOdsScripts.toString().includes('const latest = latestRes.ok ? await latestRes.json() : model;')"},
  // —— P57②：409（版本过期 / 分层不是 ODS）⇒ 不重试、给 warning 提示、重查能否自行归档；POST 用发起时的模型 id
  "p57-retry-on-409": {"file":"Model_Center.html","edits":[["console.log('[autoSaveOdsScripts] 服务端拒绝自动保存（409）:', staleData && staleData.code);","console.log('[autoSaveOdsScripts] 服务端拒绝自动保存（409）:', staleData && staleData.code);\n                    if (!window.__p57retried) { window.__p57retried = true; return autoSaveOdsScripts(); }"]],"probe":"autoSaveOdsScripts.toString().includes('window.__p57retried')"},
  "p57-no-toast": {"file":"Model_Center.html","edits":[["showToast('配置在验收后已变化，ODS 脚本未自动保存', 'warning');","void 0; /* p57-no-toast */"]],"probe":"autoSaveOdsScripts.toString().includes('/* p57-no-toast */')"},
  "p57-no-recheck": {"file":"Model_Center.html","edits":[["showToast('配置在验收后已变化，ODS 脚本未自动保存', 'warning');\n                        checkCanSelfArchiveInModal();","showToast('配置在验收后已变化，ODS 脚本未自动保存', 'warning'); /* p57-no-recheck */"]],"probe":"autoSaveOdsScripts.toString().includes('/* p57-no-recheck */')"},
  "p57-409-ignores-current": {"file":"Model_Center.html","edits":[["if (stillCurrent()) {\n                        showToast('配置在验收后已变化，ODS 脚本未自动保存', 'warning');","if (true /* p57-ignores-current */) {\n                        showToast('配置在验收后已变化，ODS 脚本未自动保存', 'warning');"]],"probe":"autoSaveOdsScripts.toString().includes('p57-ignores-current')"},
  "p57-post-current-id": {"file":"Model_Center.html","edits":[["const url = `/api/models/${modelIdAtStart}/save-scripts`;","const url = `/api/models/${currentValidationModelId}/save-scripts`;"]],"probe":"autoSaveOdsScripts.toString().includes('${currentValidationModelId}/save-scripts')"},
  // —— C5 变异块结束
};
if (MUT && !OLD_MUTS.includes(MUT) && !CAT_MUTS[MUT]) { console.error('未知的 MC_MUT：' + MUT + '（已知：' + OLD_MUTS.concat(Object.keys(CAT_MUTS)).join(' / ') + '）'); process.exit(2); }
const catMutFile = (CAT_MUTS[MUT] && CAT_MUTS[MUT].file) || 'model-catalog.js';   // B2：变异也可以改核心文件 model-catalog-core.js
const catMutSrc = (() => {
  if (!CAT_MUTS[MUT]) return null;
  let src = fs.readFileSync(catMutFile.endsWith('.html') ? path.join(ROOT, 'public', catMutFile) : path.join(ROOT, 'public', 'assets', 'js', catMutFile), 'utf8').replace(/\r\n/g, '\n');
  for (const [anchor, repl] of CAT_MUTS[MUT].edits) {
    const n = src.split(anchor).length - 1;
    if (n !== 1) { console.error('页内变异 ' + MUT + '：锚点在 model-catalog.js 里出现 ' + n + ' 次（必须恰好 1 次）：' + anchor); process.exit(2); }
    src = src.split(anchor).join(repl);
  }
  return src;
})();
let nPass = 0, nFail = 0;
const check = (name, cond, detail) => {
  if (cond) { nPass++; console.log('  PASS ' + name); } else { nFail++; console.log('  FAIL ' + name + (detail === undefined ? '' : '\n    ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))); }
};
const J = (v) => JSON.stringify(v);
const tokenFor = (secret, u) => jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, secret, { expiresIn: '2h' });
const ALL36 = [60, 50, 55, 58, 62, 65, 52, 53, 59, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 6, 8];
const PAGE1_21 = ALL36.slice(0, 21);   // 第 1 页：20 组 21 行（#53 紧跟 #52）

// 每页的探针：列表行数时间线（首屏是否先出现过未过滤的列表）
const INIT_PROBE = () => {
  window.__rowCounts = [];
  document.addEventListener('DOMContentLoaded', () => {
    const tb = document.getElementById('modelListBody');
    if (tb) new MutationObserver(() => window.__rowCounts.push(tb.querySelectorAll('[data-id]').length)).observe(tb, { childList: true });
  });
};

async function main(dbPath) {
  if (await portBusy()) { console.error(`端口 ${PORT} 已被占用，拒绝启动（3000 是用户进程，不得占用或杀）。`); process.exit(2); }
  const secret = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env'))).JWT_SECRET;
  if (!secret) throw new Error('wbs-server/.env 缺 JWT_SECRET');
  await prepareDb(dbPath);
  await startServer(dbPath);
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const errUrl = (m) => { try { return (m.location() && m.location().url) || ''; } catch (_) { return ''; } };   // codex 41Ta-M1：浏览器自己记的「Failed to load resource」消息的 location().url 就是失败的那个请求地址
  const mkCtx = async (user, stubs = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const tok = tokenFor(secret, user);
    await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify({ display_name: u })); } catch (e) { /* ignore */ } }, [tok, user.display_name]);
    await ctx.addInitScript(INIT_PROBE);
    await ctx.route('**/api/warehouse/describe-table*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await ctx.route('**/api/models/*/save-scripts', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"savedFiles":[],"configRevBumped":false}' }));
    await ctx.route('**/api/models/*/edit-script', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }));
    await ctx.route('**/api/models/*/script-modified', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }));
    if (catMutSrc !== null) await ctx.route(catMutFile.endsWith('.html') ? '**/' + catMutFile + '*' : '**/assets/js/' + catMutFile + '*', (route) => route.fulfill({ status: 200, contentType: catMutFile.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript; charset=utf-8', body: catMutSrc }));   // 2c：CAT 源码变异（3b 起也可改 Model_Center.html 本体）
    await ctx.route('**/api/models/*/validate', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ overall_result: 'pass', total_rows: 10, execution_time_ms: 5, details: {} }) }));   // 桩：验收通过（不落库）；写请求发出即应标记（D-7）
    return ctx;
  };
  /** 打开目录页；返回 { page, reqs }：reqs.n = 打开稳定后的 GET /api/models 次数（pathname 恰为 /api/models） */
  const open = async (ctx, label, query = '', opts = {}) => {
    const page = await ctx.newPage();
    const reqs = { n: 0 };
    const tl = [];   // 时间线（事件到达 node 的先后）：write-done / write-fail / list-req / close
    const WRITE_RE = /\/api\/models\/\d+\/(save-scripts|edit-script|validate|script-modified|semantic-review)$|\/confirm$/;
    page.on('request', (r) => { try { const u = new URL(r.url()); if (u.pathname === '/api/models' && r.method() === 'GET') { reqs.n++; tl.push('list-req'); } } catch (_) { /* ignore */ } });
    page.on('response', (r) => { try { const u = new URL(r.url()); if (r.request().method() !== 'GET' && WRITE_RE.test(u.pathname)) tl.push('write-done'); } catch (_) { /* ignore */ } });
    page.on('requestfailed', (r) => { try { const u = new URL(r.url()); if (r.method() !== 'GET' && WRITE_RE.test(u.pathname)) tl.push('write-fail'); } catch (_) { /* ignore */ } });
    page.on('console', (m) => { if (m.type() === 'error') errors.push({ label, kind: 'console', text: m.text().slice(0, 200), url: errUrl(m) }); });
    page.on('pageerror', (e) => errors.push({ label, kind: 'pageerror', text: 'pageerror ' + String(e).slice(0, 200), url: '' }));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    if (opts.beforeGoto) await opts.beforeGoto(page);
    await page.goto(`${BASE}/Model_Center.html${query}`, { waitUntil: 'load' });
    if (!opts.noRows) await page.waitForSelector('#modelListBody [data-id]', { timeout: WAIT });   // 3b：noRows = 列表数据预期不到达（首次加载失败 / 请求被扣住），不等条目
    if (!opts.noIdle) await page.waitForLoadState('networkidle');
    await applyMut(page);
    if (catMutSrc !== null) { const ok = await page.evaluate(CAT_MUTS[MUT].probe); if (ok !== true) throw new Error('页内变异 ' + MUT + ' 未装载（探针不成立：' + CAT_MUTS[MUT].probe + '）'); }
    reqs.n = 0; tl.length = 0;
    const mark = (name) => tl.push(name);
    return { page, reqs, tl, mark };
  };
  // 故意制造 HTTP 500 / 连接失败 / 路由 abort 的用例：浏览器自己会记一条 console error（「Failed to load resource: …」）。4d 起豁免收窄为（页面标签 + 文本）：
  //   标签必须经 expectErr 登记（标签 + 预期失败请求的 URL 模式），文本匹配 BROWSER_NET_ERR 且 location().url 命中该标签登记的模式；pageerror 一律不豁免；页面代码自己记的 console.error（文本不匹配）也不豁免——唯一例外是 W34 期望的那条「[catalog] 处理函数不存在：…」。
  //   只给确实发出 500 / 断连 / abort 的页面登记（不产生浏览器错误的页面不登记；全程末尾另有「登记没有空挂」的检查）。
  //   codex 41Ta-M1：豁免再绑定到「预期失败的那个请求」——每个登记标签同时登记一组 URL 模式（expectErr），console 错误的 location().url 必须命中该标签登记的模式，
  //   所以 W52a 故意让列表 500 时，同页另一个资源（例如 /api/domains）意外失败仍会判红；末尾的「登记没有空挂」按（标签 + 模式）逐个检查。
  const expectedErr = new Map();
  const expectErr = (label, ...pats) => { expectedErr.set(label, (expectedErr.get(label) || []).concat(pats)); };
  const U_LIST = /\/api\/models(\?.*)?$/, U_DOMAINS = /\/api\/domains(\?.*)?$/, U_REL = /\/api\/models\/\d+\/relations(\?.*)?$/, U_SAVE = /\/api\/models\/\d+\/save-scripts(\?.*)?$/, U_UNOWNED = /\/api\/model-impl-objects\?unowned=1$/;
  const BROWSER_NET_ERR = /Failed to load resource|net::ERR_FAILED/;
  const isExpectedErr = (e) => e.kind === 'console' && ((expectedErr.has(e.label) && BROWSER_NET_ERR.test(e.text) && expectedErr.get(e.label).some((p) => p.test(e.url || ''))) || (e.label === 'W34' && /^\[catalog\] 处理函数不存在：/.test(e.text)) || (e.label === 'P53b' && /^\[autoSaveOdsScripts\] 自动保存 ODS 脚本失败/.test(e.text)));
  // gate 有界：WAIT*2 内没人放行就自动放行并记一条 FAIL（用例时序前提不成立），保证被扣住的请求 / route 不会永远互等；正常放行时清定时器
  const gate = () => {
    let timer = null; let released = false; let p0;
    const release = () => { if (released) return; released = true; if (timer) clearTimeout(timer); p0(); };
    const p = new Promise((r) => { p0 = r; });
    timer = setTimeout(() => { if (released) return; check('挂起请求等不到放行（超时自动放行）——用例时序前提不成立', false, 'gate 等待 ' + (WAIT * 2) + 'ms 无人放行'); release(); }, WAIT * 2);
    return { p, release };
  };
  // 页内有界等待：等页面里的 promise（window[name]）最多 WAIT，超时返回 '__timeout__'
  const pageAwait = (page, name) => page.evaluate(([n, ms]) => Promise.race([Promise.resolve(window[n]).catch(() => '__threw__'), new Promise((r) => setTimeout(() => r('__timeout__'), ms))]), [name, WAIT]);
  const isListReq = (r) => { const u = new URL(r.url()); return u.pathname === '/api/models' && r.method() === 'GET'; };
  // 正向等待列表重载请求：超时 = 判红（记一条 FAIL 并返回 null，不吞、也不抛出以免中断后续用例——变异自证需要每个用例各自给出判红）
  const waitList = (page) => page.waitForRequest(isListReq, { timeout: WAIT }).catch((e) => { check('等待列表重载请求（超时 = 没有重载 = 判红）', false, String(e && e.message).split('\n')[0]); return null; });
  const OK_SAVE = '{"savedFiles":[],"configRevBumped":false}';
  /** 变异：页内替换（仅 MC_MUT 非空时） */
  const applyMut = async (page) => {
    if (MUT === 'stale-noop') await page.evaluate(() => { window.reloadCatalogIfStale = function () {}; });
    if (MUT === 'inflight-immediate') await page.evaluate(() => { window.reloadCatalogIfStale = function () { if (catalogHookModalOpen()) return; if (catalogListSeen >= catalogWritesDone) return; if (catalogListReqSeen === catalogWritesDone) return; loadModels().catch(() => {}); }; });   // 关闭钩子不看在途写请求，立即重载
    if (MUT === 'reopen-ignore') await page.evaluate(() => { window.reloadCatalogIfStale = function () { if (catalogWritesInFlight > 0) return; if (catalogListSeen >= catalogWritesDone) return; if (catalogListReqSeen === catalogWritesDone) return; loadModels().catch(() => {}); }; });   // 重载条件去掉「没有带钩子弹窗开着」
    if (MUT === 'no-dedupe') await page.evaluate(() => { window.reloadCatalogIfStale = function () { if (catalogWritesInFlight > 0 || catalogHookModalOpen()) return; if (catalogListSeen >= catalogWritesDone) return; loadModels().catch(() => {}); }; });   // 去掉「已有覆盖全部写入的请求在途」去重
    if (MUT === 'seen-at-arrival') await page.evaluate(() => { const src = loadModels.toString().replace('catalogListSeen = Math.max(catalogListSeen, seen);', 'catalogListSeen = Math.max(catalogListSeen, catalogWritesDone);'); window.loadModels = (0, eval)('(' + src + ')'); });   // catalogListSeen 取到达时的 catalogWritesDone
    if (MUT === 'seen-on-failure') await page.evaluate(() => { const src = loadModels.toString().replace('if (catalogListReqSeq === reqId) catalogListReqSeen = -1;', 'catalogListSeen = Math.max(catalogListSeen, seen); if (catalogListReqSeq === reqId) catalogListReqSeen = -1;'); window.loadModels = (0, eval)('(' + src + ')'); });   // 失败 / 被取代时也推进 catalogListSeen
    if (MUT === 'done-not-counted') await page.evaluate(() => { const src = catalogTrackWrite.toString().replace('catalogWritesDone++;', ''); window.catalogTrackWrite = (0, eval)('(' + src + ')'); });   // finally 里不递增 catalogWritesDone
    // （reload-no-restore 已删除：D-7 改代次推导后没有「恢复标记」机制，其防护目标由 seen-on-failure 承担）
    if (MUT === 'companion-sends-mode') {   // 2d：confirmRegister 把「是否伴生行」判为假 → 伴生行也发 config_mode；探针确认确实装上，否则抛错（防止变异没生效却全绿）
      const ok = await page.evaluate(() => { const src = confirmRegister.toString(); const out = src.replace(/const isCompanionEdit = [^\n]*;/, 'const isCompanionEdit = false;'); if (out === src) return false; window.confirmRegister = (0, eval)('(' + out + ')'); return confirmRegister.toString().includes('const isCompanionEdit = false;'); });
      if (ok !== true) throw new Error('页内变异 companion-sends-mode 未装载');
    }
    if (MUT === 'companion-list-priority' || MUT === 'companion-editmodel-only') {   // 39：confirmRegister 的伴生判断退回旧写法；探针确认确实装上
      const to = MUT === 'companion-list-priority' ? 'const isCompanionEdit = listRowForMode ? !!listRowForMode.companion_of : !!(editModel && editModel.companion_of);' : 'const isCompanionEdit = !!(editModel && editModel.companion_of);';
      const ok = await page.evaluate((to) => { const src = confirmRegister.toString(); const out = src.replace(/const isCompanionEdit = [^\n]*;/, to); if (out === src) return false; window.confirmRegister = (0, eval)('(' + out + ')'); return confirmRegister.toString().includes(to); }, to);
      if (ok !== true) throw new Error('页内变异 ' + MUT + ' 未装载');
    }
    if (MUT === 'no-token') {   // 3d（40Ta-L1）：令牌核对行必须恰好匹配 2 处（authFetch 之后、res.json() 之后各一），替换后源码必须真的变化且不再含该行——否则抛错，不让变异静默零命中
      const nt = await page.evaluate(() => { const src = loadModels.toString(); const re = /if \(catalogEventState\.listToken !== token\) return 'discarded';/g; const n = (src.match(re) || []).length; if (n !== 2) return { n, changed: false }; const out = src.replace(re, ''); window.loadModels = (0, eval)('(' + out + ')'); return { n, changed: out !== src && !/listToken !== token\) return 'discarded'/.test(out) && !/listToken !== token\) return 'discarded'/.test(loadModels.toString()) }; });
      if (nt.n !== 2 || nt.changed !== true) throw new Error('页内变异 no-token 未装载：令牌核对行匹配 ' + nt.n + ' 次（期望 2 次），替换后源码' + (nt.changed ? '已' : '未') + '变化');
    }
  };
  const isList = (u) => u.pathname === '/api/models';   // route / unroute 用同一个谓词引用
  const view = (page) => page.evaluate(() => getCatalogView());
  /** 页内有界执行一个函数（fix41b：authFetch 读接口等多语句 async 体）：把 fn 序列化进页面执行（fn 不得引用 node 侧闭包变量，参数经 arg 传入），超时 / 被拒记 FAIL 并返回 '__timeout__' / '__threw__' */
  const pageEvalBounded = async (page, fn, arg) => {
    const r = await page.evaluate(([src, a, ms]) => Promise.race([Promise.resolve().then(() => (0, eval)('(' + src + ')')(a)).then((v) => v, () => '__threw__'), new Promise((res) => setTimeout(() => res('__timeout__'), ms))]), [fn.toString(), arg === undefined ? null : arg, WAIT]);
    if (r === '__timeout__' || r === '__threw__') check('页内函数在 ' + WAIT + 'ms 内正常完成（超时 / 被拒 = 判红）：' + fn.toString().slice(0, 60), false, r);
    return r;
  };
  /** 页内有界调用（codex 41Tc-M1）：对返回 Promise 的页面函数先存 Promise、再以 WAIT 为上限取结果；超时 / 被拒记一条 FAIL 并返回 '__timeout__' / '__threw__'（套件不挂起，继续往下跑）。expr 是页内表达式字符串（全局 eval，页面函数与顶层 let 都可见） */
  const pageCallBounded = async (page, expr, label) => {
    const r = await page.evaluate(([e, ms]) => Promise.race([Promise.resolve().then(() => (0, eval)(e)).then((v) => v, () => '__threw__'), new Promise((res) => setTimeout(() => res('__timeout__'), ms))]), [expr, WAIT]);
    if (r === '__timeout__' || r === '__threw__') check((label || expr) + '：页内 Promise 在 ' + WAIT + 'ms 内正常完成（超时 / 被拒 = 判红，套件不挂起）', false, r);
    return r;
  };
  const domIds = (page) => page.$$eval('#modelListBody [data-id]', (els) => els.map((el) => Number(el.dataset.id)));   // C4c-2：条目 [data-id]（组包装只带 data-group）
  /**
   * T1：「保存 → 关闭 ⇒ 重载」的时间线判据：自最近一次 save-start 起，close 之前没有 list-req（写请求结束时弹窗仍开着就重载并清标记的错误实现会在这里判红），close 之后恰 1 次 list-req。
   * 只数总次数（reqs.n === 1）分不出「写结束时就重载、关闭时不再重载」，所以保存类用例一律用它。
   */
  const tlCheck = (tl) => { const ss = tl.lastIndexOf('save-start'); const sl = tl.slice(ss + 1); const c = sl.indexOf('close'); return ss >= 0 && c >= 0 && !sl.slice(0, c).includes('list-req') && sl.slice(c).filter((e) => e === 'list-req').length === 1; };
  const stableCount = async (page, ms = 1200) => { await page.waitForTimeout(ms); };   // 「不应发生」的断言只能等一小段时间（负向等待）；正向事件一律用 waitForRequest

  const admin = await mkCtx(USERS[0]);
  try {
    // ===== W1 输入即过滤 =====
    // 它锁的是：搜索框输入即前端过滤（不发 GET /api/models）、回第 1 页、回车与「搜索」按钮幂等、输入法组字期间不过滤（compositionend 才应用）、清空恢复全量。
    console.log('W1 输入即过滤');
    {
      const { page, reqs } = await open(admin, 'W1');
      await page.evaluate(() => goToPage(2));
      check('W1 前置：翻到第 2 页', (await page.evaluate(() => currentPage)) === 2);
      await page.fill('#searchKeyword', 'dim_');
      let v = await view(page);
      check('W1 输入 dim_ 即过滤：恰剩 6 个 DIM 模型（手写期望）、回第 1 页、期间不发 GET /api/models', J(v.orderedIds) === J([60, 50, 55, 58, 62, 65]) && v.page === 1 && reqs.n === 0, { v: v.orderedIds, page: v.page, n: reqs.n });
      check('W1 渲染行与视图一致（DOM）', J(await domIds(page)) === J([60, 50, 55, 58, 62, 65]), await domIds(page));
      await page.press('#searchKeyword', 'Enter');
      v = await view(page);
      check('W1 回车幂等：结果不变、不发请求', J(v.orderedIds) === J([60, 50, 55, 58, 62, 65]) && reqs.n === 0, { n: reqs.n });
      await page.locator('button[onclick="applyCatalogSearch()"]').click();
      v = await view(page);
      check('W1 「搜索」按钮幂等：结果不变、不发请求', J(v.orderedIds) === J([60, 50, 55, 58, 62, 65]) && reqs.n === 0, { n: reqs.n });
      await page.fill('#searchKeyword', '');
      v = await view(page);
      check('W1 清空输入：恢复 36 行 / 35 组', v.totalModels === 36 && v.totalGroups === 35 && reqs.n === 0, v);
      // 输入法组字：isComposing 的 input 事件不过滤，compositionend 才应用
      await page.evaluate(() => { const el = document.getElementById('searchKeyword'); el.value = 'dwd'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); });
      check('W1 组字期间（input.isComposing）不渲染过滤：DOM 仍是未过滤的第 1 页（视图读输入框当前值，渲染要等 compositionend）', J(await domIds(page)) === J(PAGE1_21), await domIds(page));
      await page.evaluate(() => { document.getElementById('searchKeyword').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
      v = await view(page);
      check('W1 compositionend 时应用：dwd 命中 #52 #53 #59（主模型 #52 带伴生 #53），DOM 同步过滤', J(v.orderedIds) === J([52, 53, 59]) && J(await domIds(page)) === J([52, 53, 59]), { ids: v.orderedIds, dom: await domIds(page), h: await page.evaluate(() => typeof document.getElementById('searchKeyword').oncompositionend), cp: await page.evaluate(() => currentPage) });
      await page.close();
    }

    // ===== W2 ?search= 预填 =====
    // 它锁的是：?search= 预填后首屏即已过滤（从未渲染过未过滤列表）、地址栏保留 search、输入框带着预填值。
    console.log('W2 ?search= 预填');
    {
      const { page } = await open(admin, 'W2', '?search=dim_w0037');
      const rc = (await page.evaluate(() => window.__rowCounts)).filter((n) => n > 0);
      const v = await view(page);
      const st = await page.evaluate(() => ({ val: document.getElementById('searchKeyword').value, search: location.search }));
      check('W2 首屏即过滤：渲染过的非空行数只有 1（从未出现 20 / 21 行的未过滤列表）', rc.length >= 1 && rc.every((n) => n === 1), rc);
      check('W2 视图只剩 #55；输入框 = 预填值；地址栏保留 ?search=dim_w0037', J(v.orderedIds) === J([55]) && st.val === 'dim_w0037' && st.search === '?search=dim_w0037', { ids: v.orderedIds, st });
      await page.close();
    }

    // ===== W3 重载保留页码 + 夹紧 =====
    // 它锁的是：数据重载（loadModels）保留当前组页（D-13，不再回第 1 页）；重载到「组数 ≤ 20、行数 > 20」的数据时夹到最后一个非空页（按行算页会停在空页）。
    console.log('W3 重载保留页码 / 夹紧');
    {
      const { page } = await open(admin, 'W3');
      await page.evaluate(() => goToPage(2));
      await pageCallBounded(page, 'loadModels()');
      check('W3 goToPage(2) → loadModels() → 仍为第 2 页（保留页码）', (await page.evaluate(() => currentPage)) === 2 && J((await view(page)).pageGroups.flat()) === J([113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 6, 8]));
      for (const [label, take, wantRows, wantGroups] of [['前 15 行（14 组）', 15, 15, 14], ['前 21 行（20 组 21 行：按行算会多出一个空的第 2 页）', 21, 21, 20]]) {
        await page.route(isList, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          const resp = await route.fetch(); const rows = await resp.json();
          await route.fulfill({ response: resp, body: JSON.stringify(rows.slice(0, take)) });
        });
        await page.evaluate(() => { goToPage(2); });
        await pageCallBounded(page, 'loadModels()');
        const v = await view(page);
        check(`W3 第 2 页重载到${label} → 夹到第 1 页、总页数 1、渲染 ${wantRows} 行（不是空页）`, v.page === 1 && v.totalPages === 1 && v.totalGroups === wantGroups && v.totalModels === wantRows && (await domIds(page)).length === wantRows, { page: v.page, tp: v.totalPages, g: v.totalGroups, m: v.totalModels, dom: (await domIds(page)).length });
        await page.evaluate(() => goToPage(2));
        check(`W3 ${label}：totalPages 为 1 时 goToPage(2) 被拒、currentPage 仍为 1（按行算总页数会放行到空的第 2 页）`, (await page.evaluate(() => currentPage)) === 1 && (await domIds(page)).length === wantRows, await page.evaluate(() => currentPage));
        await page.unroute(isList);
        await pageCallBounded(page, 'loadModels()');   // 恢复全量
        await page.evaluate(() => { currentPage = 1; renderModelsPage(); });
      }
      await page.close();
    }

    // W3b（B4）：非默认排序 + 搜索条件下的重载夹紧——totalPages / currentPage 按「当前视图」算（排序 id desc + 搜索 ods_filler：25 组 → 去掉 10 个后 15 组 → 夹到第 1 页）
    {
      const { page } = await open(admin, 'W3b');
      await page.locator('button[data-sort-by="id"]').click();   // id desc（C4c-2：排序条里的按钮；旧：th.sortable）
      await page.fill('#searchKeyword', 'ods_filler');
      await page.evaluate(() => goToPage(2));
      let v = await view(page);
      check('W3b 前置：id desc + 搜索 ods_filler → 25 组 2 页，第 2 页（手写：105…101）', v.totalGroups === 25 && v.totalPages === 2 && v.page === 2 && J(v.pageGroups.flat()) === J([105, 104, 103, 102, 101]), { g: v.totalGroups, tp: v.totalPages, pg: v.page, ids: v.pageGroups.flat() });
      await page.route(isList, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const resp = await route.fetch(); const rows = await resp.json();
        await route.fulfill({ response: resp, body: JSON.stringify(rows.filter((r) => !(r.id >= 101 && r.id <= 110))) });
      });
      await pageCallBounded(page, 'loadModels()');
      v = await view(page);
      check('W3b 重载去掉 101–110 → 15 组 1 页：按当前视图夹到第 1 页，列表 = 125…111（手写），DOM 一致', v.page === 1 && v.totalPages === 1 && J(v.orderedIds) === J([125, 124, 123, 122, 121, 120, 119, 118, 117, 116, 115, 114, 113, 112, 111]) && J(await domIds(page)) === J(v.orderedIds), { page: v.page, tp: v.totalPages, ids: v.orderedIds });
      await page.unroute(isList);
      await page.close();
    }

    // ===== W4 迟到列表响应丢弃 =====
    // 它锁的是：两次重载并发时，先发后到的旧响应被令牌丢弃，最终数据是后发的那次（不是后到的那次）。
    console.log('W4 迟到列表响应丢弃');
    {
      const { page } = await open(admin, 'W4');
      let n = 0;
      await page.route(isList, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const mine = ++n;
        if (mine === 1) {   // 第一次（旧）：延迟 1500ms 才返回，且只返回 15 行
          const resp = await route.fetch(); const rows = await resp.json();
          await new Promise((r) => setTimeout(r, 1500));
          return route.fulfill({ response: resp, body: JSON.stringify(rows.slice(0, 15)) });
        }
        return route.continue();   // 第二次（新）：立即返回全量
      });
      const done = await page.evaluate(async (ms) => { const a = loadModels(); const b = loadModels(); const to = await Promise.race([Promise.all([a, b]).then(() => 'done'), new Promise((res) => setTimeout(() => res('__timeout__'), ms))]); return { len: allModelsData.length, view: getCatalogView().totalModels, to }; }, WAIT);
      check('W4 最终数据 = 后发的那次（36 行），迟到的旧响应（15 行）被丢弃（两次 loadModels 在 ' + WAIT + 'ms 内都完成）', done.len === 36 && done.view === 36 && n === 2 && done.to === 'done', { done, n });
      await page.unroute(isList);
      await page.close();
    }
    // W4b（B1）：列表请求失败（HTTP 500 / 200 非 JSON）→ allModelsData 与当前视图保持旧值、不调 listArrived（页码保留）；之后重试成功恢复
    console.log('W4b 列表请求失败 / 重试');
    {
      expectErr('W4b', U_LIST);
      const { page } = await open(admin, 'W4b');
      await page.evaluate(() => goToPage(2));
      const before = await view(page);
      await page.evaluate(() => { window.__la = 0; const o = ModelCatalogCore.listArrived; ModelCatalogCore.listArrived = function () { window.__la++; return o.apply(this, arguments); }; });   // 3b：旁听 listArrived 调用次数（失败路径不得调用）
      const warns = []; page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });   // 3c：收 console.warn（列表加载失败的 catch 要留一条，程序错误不能被静默吞掉）
      const waitWarn = async (n0) => { const t0 = Date.now(); while (warns.length <= n0 && Date.now() - t0 < WAIT) await page.waitForTimeout(20); return warns.length > n0; };   // 有界等待 node 侧收到 warn
      // 3c（预筛 LOW-1）：每种失败形态之前先成功加载一次（回到 ready、提示隐藏），后一种形态不沿用前一种形态留下的 error 属性与提示
      const preload = async (label) => {
        const o0 = await page.evaluate(async (ms) => { const r = await Promise.race([loadModels(), new Promise((res) => setTimeout(() => res('__timeout__'), ms))]); const n = document.getElementById('catalogListNotice'); return { r, state: document.getElementById('modelListBody').getAttribute('data-catalog-state'), hidden: n.hidden, kids: n.children.length, len: allModelsData.length, page: currentPage }; }, WAIT);
        check('W4b ' + label + " 前置：先成功加载一次 → 返回 'arrived'、data-catalog-state=ready、提示隐藏且为空、36 行、仍在第 2 页", o0.r === 'arrived' && o0.state === 'ready' && o0.hidden === true && o0.kids === 0 && o0.len === 36 && o0.page === 2, o0);
      };
      for (const [label, handler] of [['HTTP 500', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' })], ['200 非 JSON', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: 'not json' })], ['200 非数组', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"x":1}' })], ['连接失败', (route) => route.abort('failed')]]) {
        await preload(label);
        const w0 = warns.length;
        await page.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); await handler(route); });
        const out = await page.evaluate(async (ms) => { const tokBefore = catalogEventState.listToken; const la0 = window.__la; let r = 'resolved'; try { r = await Promise.race([loadModels(), new Promise((res) => setTimeout(() => res('__timeout__'), ms))]); } catch (e) { r = 'rejected'; } return { r, len: allModelsData.length, page: currentPage, tokBefore, tokAfter: catalogEventState.listToken, la: window.__la - la0, state: document.getElementById('modelListBody').getAttribute('data-catalog-state'), notice: document.getElementById('catalogListNotice').textContent, noticeHidden: document.getElementById('catalogListNotice').hidden }; }, WAIT);
        const v = await view(page);
        const vis = await page.locator('#catalogListNotice').isVisible();   // 3d（40Ta-M1）：提示不只要有文字，还要真的显示出来（hidden=false 且 Playwright 可见）
        check('W4b ' + label + "：返回 'failed'（不抛出）、列表保持旧值（36 行、第 2 页、视图不变）、未调 listArrived（0 次）、核心 listFailed 使 listToken 归 0、data-catalog-state=error、提示出现（hidden=false 且 Playwright 可见）", out.r === 'failed' && out.len === 36 && out.page === 2 && J(v.pageGroups) === J(before.pageGroups) && J(v.orderedIds) === J(before.orderedIds) && out.tokAfter === 0 && out.la === 0 && out.state === 'error' && out.notice === '列表刷新失败，显示的是上次数据重试' && out.noticeHidden === false && vis === true && J(await domIds(page)) === J(before.pageGroups.flat()), Object.assign({ vis }, out));
        if (label === '200 非 JSON' || label === '连接失败') {   // 3c（预筛 LOW-2）：这两种形态走 catch，转失败前必须在控制台留一条 warn
          const got = await waitWarn(w0);
          check('W4b ' + label + '：catch 转失败前控制台留一条 warn「[模型目录] 列表加载失败：…」（异常不被静默吞掉）', got && warns.slice(w0).some((t) => t.startsWith('[模型目录] 列表加载失败：')), warns.slice(w0));
        }
        await page.unroute(isList);
      }
      await preload('核心事件抛出程序错误');
      {
        const w1 = warns.length;
        // 3d（40Ta-M2）：这一轮请求返回「同数量、同 id、但描述等字段不同」的合法数组；失败后 allModelsData 的完整快照与当前页文字都必须等于失败前——先写 allModelsData 再调核心事件的实现在这里判红
        const snap0 = await page.evaluate(() => ({ rows: JSON.stringify(allModelsData), text: document.getElementById('modelListBody').innerText }));
        let servedP = 0;
        await page.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); servedP++; const resp = await route.fetch(); const rows = await resp.json(); await route.fulfill({ response: resp, body: JSON.stringify(rows.map((r) => Object.assign({}, r, { table_comment: '程序错误场景改后描述_' + r.id, tech_owner: '改后负责人' }))) }); });
        const outP = await page.evaluate(async (ms) => { const o = ModelCatalogCore.listArrived; ModelCatalogCore.listArrived = function () { throw new Error('boom-arrived'); }; let r = 'resolved'; try { r = await Promise.race([loadModels(), new Promise((res) => setTimeout(() => res('__timeout__'), ms))]); } catch (e) { r = 'rejected'; } ModelCatalogCore.listArrived = o; return { r, len: allModelsData.length, page: currentPage, tokAfter: catalogEventState.listToken, state: document.getElementById('modelListBody').getAttribute('data-catalog-state'), notice: document.getElementById('catalogListNotice').textContent, noticeHidden: document.getElementById('catalogListNotice').hidden, rows: JSON.stringify(allModelsData), text: document.getElementById('modelListBody').innerText }; }, WAIT);
        await page.unroute(isList);
        const visP = await page.locator('#catalogListNotice').isVisible();
        const gotP = await waitWarn(w1);
        check("W4b 核心事件抛出程序错误（listArrived 抛 boom-arrived）：同样按失败处理——返回 'failed'（不抛出）、旧数据与页码不变、listToken 归 0、data-catalog-state=error、提示出现（hidden=false 且可见）、allModelsData 完整快照与当前页文字都等于失败前（本轮响应是同数量同 id 但描述等字段不同的合法数组：异常时不部分套用）；控制台有一条 warn 带错误信息（异常不被静默吞掉）", servedP === 1 && !snap0.rows.includes('程序错误场景改后描述_') && outP.r === 'failed' && outP.len === 36 && outP.page === 2 && outP.tokAfter === 0 && outP.state === 'error' && outP.notice === '列表刷新失败，显示的是上次数据重试' && outP.noticeHidden === false && visP === true && outP.rows === snap0.rows && outP.text === snap0.text && gotP && warns.slice(w1).some((t) => t.startsWith('[模型目录] 列表加载失败：') && t.includes('boom-arrived')), { outP, warns: warns.slice(w1) });
      }
      await page.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); const resp = await route.fetch(); const rows = await resp.json(); await route.fulfill({ response: resp, body: JSON.stringify(rows.slice(0, 15)) }); });
      await pageCallBounded(page, 'loadModels()');
      const after = await view(page);
      check('W4b 重试成功（返回 15 行）→ 数据恢复更新、令牌归 0、夹到第 1 页', after.totalModels === 15 && after.page === 1 && (await page.evaluate(() => catalogEventState.listToken)) === 0, { m: after.totalModels, p: after.page });
      await page.unroute(isList);
      await page.close();
    }

    // ===== W5 ?search=…&focus=<id> =====
    // 它锁的是：?focus 清空搜索框、不再二次请求、跳到目标所在组页、清掉地址栏的 focus 与 search；高亮 3 秒（100ms 后出现、3000ms 后消失）。
    // 页内变异（首红落在本段）：w99-w5-old-highlight（定位高亮底色改回 #fef3c7，C4e-a 之前的值）
    console.log('W5 ?search=…&focus=6');
    {
      // 2d：page.clock.install 是上下文级假时钟（暂停态），装在哪个上下文，那个上下文里此后所有新页面的 setTimeout 都不走。
      //   所以假时钟只装在 W5 自己的独立上下文里，用完整个关闭；W6 起的 admin 上下文从未装过假时钟，跑在真实计时器下。
      const w5ctx = MUT === 'clock-leak' ? admin : await mkCtx(USERS[0]);   // clock-leak（自证变异）：W5 退回旧做法，把假时钟装进 admin 上下文
      const { page } = await open(w5ctx, 'W5', '?search=dim_w0037&focus=6', { noIdle: true, beforeGoto: async (p) => { await p.clock.install({ time: new Date('2026-01-15T04:05:06Z') }); await p.clock.pauseAt(new Date('2026-01-15T04:05:07Z')); } });
      const jumped = await page.waitForFunction(() => currentPage === 2 && !!document.querySelector('#modelListBody [data-id="6"]') && !/focus=/.test(location.search), null, { timeout: WAIT }).then(() => true, () => false);   // 3c（预筛 LOW-6）：超时不抛异常（会让变异下整套脚本中途结束、后面的用例来不及判红），改记 FAIL
      check('W5 ?focus=6：有界等待内跳到第 2 页、#6 条目已渲染、地址栏 focus 已清（超时 = 判红，余下 W5 断言跳过）', jumped);
      if (jumped) {
      const st = await page.evaluate(() => ({ val: document.getElementById('searchKeyword').value, search: location.search, page: currentPage, total: getCatalogView().totalModels }));
      check('W5 输入框清空、地址栏无 search / focus、跳到第 2 页（#6 所在组页）、列表恢复 36 行', st.val === '' && st.search === '' && st.page === 2 && st.total === 36, st);
      // C4c-2：高亮 = 条目 [data-id] 上的 data-focus-highlight 属性（页面 CSS 给底色 var(--row-sel)，C4e-a 起是 E 值 #eef0ff = rgb(238, 240, 255)，带 0.3s 底色过渡），不再写行内 style。
      //   属性的有无由页面定时器（假时钟）决定，同步可读；计算底色有 CSS 过渡，所以颜色用「等到计算样式到位」读（有界等待到出口层状态，超时 = 判红），不用固定 sleep。
      const hasAttr = () => page.evaluate(() => document.querySelector('#modelListBody [data-id="6"]').hasAttribute('data-focus-highlight'));
      const bgIs = (yes) => page.waitForFunction((y) => { const e = document.querySelector('#modelListBody [data-id="6"]'); return !!e && (getComputedStyle(e).backgroundColor === 'rgb(238, 240, 255)') === y; }, yes, { timeout: WAIT }).then(() => true, () => false);
      check('W5 高亮前：条目无 data-focus-highlight 属性、计算底色不是 --row-sel 的 E 值 rgb(238, 240, 255)', !(await hasAttr()) && (await bgIs(false)));
      // B2-3：消失后要等计算底色回到「高亮前的基准」（绑在这个条目上），不是只等「不再是 #fef3c7」——过渡中途的插值色也满足后者
      const bgNow = () => page.evaluate(() => getComputedStyle(document.querySelector('#modelListBody [data-id="6"]')).backgroundColor);
      const bgBase = await bgNow();
      const bgEq = (c) => page.waitForFunction((want) => { const e = document.querySelector('#modelListBody [data-id="6"]'); return !!e && getComputedStyle(e).backgroundColor === want; }, c, { timeout: WAIT }).then(() => true, () => false);
      check('W5 高亮前基准底色已读到，且不是 rgb(238, 240, 255)', bgBase !== 'rgb(238, 240, 255)', bgBase);
      await page.clock.runFor(100);
      check('W5 100ms 后高亮出现（data-focus-highlight 属性在、计算底色 rgb(238, 240, 255) = --row-sel）', (await hasAttr()) && (await bgIs(true)));
      await page.clock.runFor(2999);
      check('W5 再 2999ms 仍在高亮（属性在、底色仍 rgb(238, 240, 255)）', (await hasAttr()) && (await bgIs(true)));
      await page.clock.runFor(1);
      check('W5 再 1ms（满 3000ms）高亮消失（属性去掉、计算底色回到高亮前的基准底色 ' + bgBase + '，不是过渡中途的插值色）', !(await hasAttr()) && (await bgEq(bgBase)), { bgBase, now: await bgNow() });
      }
      await page.close();
      if (w5ctx !== admin) await w5ctx.close();
    }
    {
      // 2d 前提：W5 之后 admin 上下文里的新页面定时器正常走（W6–W19 在真实计时器下运行）。页内 setTimeout(30ms) 应在 node 侧 3s 内触发；假时钟冻结时它永远不触发。
      const pg = await admin.newPage();
      pg.on('console', (m) => { if (m.type() === 'error') errors.push({ label: 'W5-timer', kind: 'console', text: m.text().slice(0, 200), url: errUrl(m) }); });
      pg.on('pageerror', (e) => errors.push({ label: 'W5-timer', kind: 'pageerror', text: 'pageerror ' + String(e).slice(0, 200), url: '' }));
      await pg.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
      const ev = pg.evaluate(() => new Promise((res) => setTimeout(() => res('fired'), 30))).catch(() => '__closed__');
      const r = await Promise.race([ev, new Promise((res) => setTimeout(() => res('__frozen__'), 3000))]);
      check('W5 之后 admin 上下文的新页面定时器正常走（页内 setTimeout 30ms 在 3s 内触发；假时钟只装在 W5 自己的上下文里）', r === 'fired', r);
      await pg.close();
    }
    {
      // ?focus 不再二次请求：用请求日志核对（首屏 loadModels 1 次 + app.js loadAllModels 1 次；focus 分支不再发第 3 次，所有请求都不带 keyword）
      const page = await admin.newPage();
      const urls = [];
      page.on('request', (r) => { try { const u = new URL(r.url()); if (u.pathname === '/api/models' && r.method() === 'GET') urls.push(u.search); } catch (_) { /* ignore */ } });
      page.on('console', (m) => { if (m.type() === 'error') errors.push({ label: 'W5b', kind: 'console', text: m.text().slice(0, 200), url: errUrl(m) }); });
      page.on('pageerror', (e) => errors.push({ label: 'W5b', kind: 'pageerror', text: 'pageerror ' + String(e).slice(0, 200), url: '' }));
      if (MUT === 'w5b-pageerror') await page.addInitScript(() => { setTimeout(() => { throw new Error('boom-w5b'); }, 0); });   // 测试自身的变异：W5b 页面里出一次未捕获异常，必须判红（pageerror 收集真的装在这条手工开页路径上）
      await page.goto(`${BASE}/Model_Center.html?search=dim_w0037&focus=6`, { waitUntil: 'load' });
      const w5bOk = await page.waitForFunction(() => currentPage === 2 && !/focus=/.test(location.search), null, { timeout: WAIT }).then(() => true, () => false);   // 3c（LOW-6 同族）：等待超时记 FAIL，不抛异常带崩脚本
      check('W5b ?focus=6（首屏 loadModels 之后）：有界等待内跳到第 2 页并清掉地址栏 focus（超时 = 判红）', w5bOk);
      await page.waitForLoadState('networkidle');
      check('W5 ?focus 不发带 keyword 的请求、总请求数恰为 2（首屏 loadModels + app.js loadAllModels 各一次，focus 不再二次请求）', urls.length === 2 && urls.every((s) => !/keyword/.test(s)), urls);
      await page.close();
    }

    // W5c（B6）：?focus 的不存在 id（提示文本）/ 已删除 id（#66 软删除，不在列表）/ 伴生 id（跳到主模型组所在页）；均不自动展开
    console.log('W5c ?focus 的不存在 / 已删除 / 伴生 id');
    {
      for (const [label, id] of [['不存在 id 99999', 99999], ['已删除 id #66', 66]]) {
        const { page } = await open(admin, 'W5c', '?focus=' + id);
        const w5cOk = await page.waitForFunction(() => !/focus=/.test(location.search), null, { timeout: WAIT }).then(() => true, () => false);   // 3c：同上
        check(`W5c ?focus=${id}（${label}）：有界等待内地址栏 focus 被清（超时 = 判红）`, w5cOk);
        const st = await page.evaluate(() => ({ page: currentPage, toast: document.body.innerText.includes('模型不存在或已删除'), expanded: catalogEventState.expanded.length, search: location.search }));
        check(`W5c ?focus=${id}（${label}）：提示「模型不存在或已删除」、回第 1 页、不展开、地址栏清参`, st.toast && st.page === 1 && st.expanded === 0 && st.search === '', st);
        await page.close();
      }
      const { page } = await open(admin, 'W5c', '?focus=9002', { beforeGoto: async (pg) => {
        await pg.route(isList, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          const resp = await route.fetch(); const rows = await resp.json();
          const base = rows.find((r) => r.id === 6);
          await route.fulfill({ response: resp, body: JSON.stringify(rows.concat([Object.assign({}, base, { id: 9002, table_name: 'ods_w0001_change_df', companion_of: 6, config_mode: 'companion' })])) });
        });
      } });
      const w5c2Ok = await page.waitForFunction(() => !/focus=/.test(location.search), null, { timeout: WAIT }).then(() => true, () => false);   // 3c：同上
      check('W5c ?focus=9002（注入伴生）：有界等待内地址栏 focus 被清（超时 = 判红）', w5c2Ok);
      const st = await page.evaluate(() => ({ page: currentPage, row: !!document.querySelector('#modelListBody [data-id="9002"]'), expanded: catalogEventState.expanded.length, grp: getCatalogView().pageGroups.find((g) => g.includes(9002)) }));
      check('W5c ?focus=9002（#6 的注入伴生，#6 在第 2 页）：跳到主模型组所在的第 2 页、该行已渲染、组 = [6, 9002]、不展开', st.page === 2 && st.row && st.expanded === 0 && J(st.grp) === J([6, 9002]), st);
      await page.close();
    }

    // ===== W6 D-7：验收弹窗关闭 → 数据重载 =====
    // 它锁的是：验收弹窗内执行过验收（写请求发出）→ 关闭前不重载、关闭后恰重载一次列表（时间线）；只开只关不重载。
    console.log('W6 验收弹窗关闭重载');
    {
      const { page, reqs, tl, mark } = await open(admin, 'W6');
      await page.evaluate(() => { openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS'); });
      await page.evaluate(() => closeValidationModal());
      await stableCount(page);
      check('W6 对照：只开只关验收弹窗 → GET /api/models +0', reqs.n === 0, reqs.n);
      await page.evaluate(() => { openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS'); });
      mark('save-start');
      await pageCallBounded(page, 'runValidation()');
      await stableCount(page, 500);   // 让写请求结束的页面回调（含可能的错误重载）先到达 node，再标记 close
      const reload = waitList(page);
      mark('close');
      await page.evaluate(() => closeValidationModal());
      const got = !!(await reload);   // 超时 = 没有重载 = 判红（不吞）
      await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W6 执行验收（写请求已发出）→ 关闭 ⇒ 关闭前无 list-req、关闭后恰 1 次（时间线）', got && tlCheck(tl), tl);
      check('W6 时间线：列表请求严格在关闭之后；写请求都已完成（不在途）', tl.indexOf('list-req') > tl.indexOf('close') && tl.indexOf('close') >= 0 && tl.filter((e) => e === 'list-req').length === 1 && tl.slice(0, tl.indexOf('close')).every((e) => e === 'write-done' || e === 'save-start'), tl);
      await page.evaluate(() => { openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS'); });
      await page.evaluate(() => closeValidationModal());
      await stableCount(page);
      check('W6 标记已清：再开再关 ⇒ 仍是 +1（不重复重载）', reqs.n === 1, reqs.n);
      await page.close();
    }
    // W6b：DIM 验收失败（不是 ODS：没有 autoSave，只有 runValidation 自己的标记）——失败的验收也算写请求已发出，关闭时重载恰 1 次（时间线），且全程没有 save-scripts 请求
    {
      const { page, tl, mark } = await open(admin, 'W6b');
      let saves = 0;
      page.on('request', (r) => { if (r.method() === 'POST' && /\/save-scripts$/.test(new URL(r.url()).pathname)) saves++; });
      await page.route('**/api/models/50/validate', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ phase: 'structure', overall_result: 'fail', total_rows: 0, execution_time_ms: 3, structure: [{ id: 'S1', name: '桩', status: 'fail', detail: 'x' }], data: [] }) }));
      await page.evaluate(() => { openValidationModal(50, 'dim_w0007_w0008', 'DEVELOPING', 'DIM', 'structure'); });
      mark('save-start');
      await pageCallBounded(page, 'runValidation()');
      await stableCount(page, 500);   // 让写请求结束的页面回调（含可能的错误重载）先到达 node，再标记 close
      const reload = waitList(page);
      mark('close');
      await page.evaluate(() => closeValidationModal());
      const got = !!(await reload);
      await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W6b DIM 验收失败 → 关闭 ⇒ 关闭前无 list-req、关闭后恰 1 次（runValidation 自己的标记，不靠 autoSave），期间没有 save-scripts 请求', got && tlCheck(tl) && saves === 0, { tl, saves });
      await page.close();
    }

    // ===== W7 D-14：DDL / ETL 弹窗保存 → 关闭 → 数据重载 =====
    // 它锁的是：DWD ETL 弹窗「一键保存」、复制触发的静默保存、custom ETL 编辑器保存：关闭前不重载、关闭后各恰重载一次（时间线）；只开只关不重载。
    console.log('W7 DDL / ETL 弹窗关闭重载');
    {
      const { page, reqs, tl, mark } = await open(admin, 'W7');
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await stableCount(page);
      check('W7 对照：只开只关 DWD ETL 弹窗 → GET /api/models +0', reqs.n === 0, reqs.n);
      // 一键保存（saveAllDwdEtl 无界面入口，直接调用；桩：save-scripts / edit-script / script-modified）
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      mark('save-start');
      await pageCallBounded(page, 'saveAllDwdEtl(52)');
      await stableCount(page, 500);   // 让写请求结束的页面回调（含可能的错误重载）先到达 node，再标记 close
      let reload = waitList(page);
      mark('close');
      await page.evaluate(() => closeDwdEtlPreviewModal());
      let got = !!(await reload);
      await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W7 DWD ETL 一键保存 → 关闭 ⇒ 关闭前无 list-req、关闭后恰 1 次（时间线）', got && tlCheck(tl), tl);
      // 复制触发的静默保存（silentSaveScripts 一处覆盖 7 个复制入口）
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      const saved = page.waitForResponse((r) => /\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      mark('save-start');
      await page.evaluate(() => copyDwdEtlScript('init'));
      await saved;
      await stableCount(page, 500);   // 让写请求结束的页面回调（含可能的错误重载）先到达 node，再标记 close
      reload = waitList(page);
      mark('close');
      await page.evaluate(() => closeDwdEtlPreviewModal());
      got = !!(await reload);
      await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W7 复制触发静默保存 → 关闭 ⇒ 关闭前无 list-req、关闭后恰 1 次（时间线）', got && tlCheck(tl), tl);
      // custom ETL 编辑器保存（saveAllCustomETL）
      await pageCallBounded(page, 'openDimETLModal(58)');
      await page.waitForSelector('#dimEtlPreviewModal', { timeout: WAIT });
      mark('save-start');
      await pageCallBounded(page, 'saveAllCustomETL(58)');
      await stableCount(page, 500);   // 让写请求结束的页面回调（含可能的错误重载）先到达 node，再标记 close
      reload = waitList(page);
      mark('close');
      await page.evaluate(() => closeDimEtlPreviewModal());
      got = !!(await reload);
      await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W7 custom ETL 编辑器保存 → 关闭 ⇒ 关闭前无 list-req、关闭后恰 1 次（时间线）', got && tlCheck(tl), tl);
      reqs.n = 0;
      await pageCallBounded(page, 'openDimETLModal(58)');
      await page.waitForSelector('#dimEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => closeDimEtlPreviewModal());
      await stableCount(page);
      check('W7 对照：只开只关 custom ETL 弹窗 → +0', reqs.n === 0, reqs.n);
      await page.close();
    }

    // ===== W8 组化渲染 =====
    // 它锁的是：第 1 页按「组」切：20 组 = 21 行，伴生 #53 紧跟主模型 #52；分页文案是组口径。
    console.log('W8 组化渲染');
    {
      const { page } = await open(admin, 'W8');
      const ids = await domIds(page);
      const info = await page.textContent('#paginationInfo');
      check('W8 第 1 页 21 行 = 20 组，顺序手写期望，#53 紧跟 #52', J(ids) === J(PAGE1_21) && ids.indexOf(53) === ids.indexOf(52) + 1, ids);
      check('W8 分页文案按组口径：共 35 组（36 个模型），显示第 1-20 组', /共\s*35\s*组（36 个模型），显示第 1-20 组/.test(info.replace(/\s+/g, ' ').trim()), info);
      const v = await view(page);
      check('W8 getCatalogView：35 组 / 36 个模型 / 2 页；第 1 页分组含 [52,53]', v.totalGroups === 35 && v.totalModels === 36 && v.totalPages === 2 && v.pageGroups.some((g) => J(g) === J([52, 53])), v);
      await page.close();
    }

    // ===== W9 对象名搜索（路由注入 impl_obj_names）=====
    // 它锁的是：已登记的对象名能搜到（命中对应组）、大小写不敏感；整批 impl_obj_names 为 null（C4-api 附加失败）/ 非数组形态（字符串、对象、数字）时搜索不抛错、按空处理。
    //   （上一批提交说明声称 W1–W8 含对象名搜索，实际没有；本用例补上。）
    console.log('W9 对象名搜索');
    {
      const inject = (mode) => async (pg) => {
        await pg.route(isList, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          const resp = await route.fetch(); const rows = await resp.json();
          const out = rows.map((r) => {
            if (mode === 'null') return Object.assign({}, r, { impl_obj_names: null });
            if (mode === 'shapes') return Object.assign({}, r, { impl_obj_names: r.id === 59 ? 'dbo.usp_str_probe' : (r.id === 60 ? { a: 'usp_obj_probe' } : (r.id === 50 ? 12345 : r.impl_obj_names)) });
            return r.id === 59 ? Object.assign({}, r, { impl_obj_names: ['dbo.usp_cat_probe'] }) : r;
          });
          await route.fulfill({ response: resp, body: JSON.stringify(out) });
        });
      };
      {
        const { page } = await open(admin, 'W9', '', { beforeGoto: inject('names') });
        await page.fill('#searchKeyword', 'usp_cat_probe');
        const v = await view(page);
        check('W9 注入 #59 的 impl_obj_names=[dbo.usp_cat_probe] → 搜 usp_cat_probe：视图与 DOM 都是 [59]', J(v.orderedIds) === J([59]) && J(await domIds(page)) === J([59]), v.orderedIds);
        await page.fill('#searchKeyword', 'DBO.USP_CAT');
        check('W9 对象名搜索大小写不敏感（DBO.USP_CAT → [59]）', J((await view(page)).orderedIds) === J([59]), (await view(page)).orderedIds);
        await page.close();
      }
      {
        const { page } = await open(admin, 'W9n', '', { beforeGoto: inject('null') });
        await page.fill('#searchKeyword', 'dim_');
        const v = await view(page);
        check('W9 所有行 impl_obj_names 为 null：搜 dim_ 仍是 6 个 DIM、不抛错', J(v.orderedIds) === J([60, 50, 55, 58, 62, 65]) && J(await domIds(page)) === J([60, 50, 55, 58, 62, 65]), v.orderedIds);
        await page.fill('#searchKeyword', 'usp_cat_probe');
        check('W9 impl_obj_names 为 null 时搜对象名 → 无命中（空）', (await view(page)).totalModels === 0);
        await page.close();
      }
      {
        const { page } = await open(admin, 'W9s', '', { beforeGoto: inject('shapes') });
        for (const q of ['usp_str_probe', 'usp_obj_probe', '12345']) {
          await page.fill('#searchKeyword', q);
          check(`W9 非数组形态（字符串 / 对象 / 数字）按空处理：搜 ${q} 无命中、不抛错`, (await view(page)).totalModels === 0, (await view(page)).orderedIds);
        }
        await page.fill('#searchKeyword', 'dim_');
        check('W9 非数组形态下其余字段搜索照常（dim_ → 6 个 DIM）', J((await view(page)).orderedIds) === J([60, 50, 55, 58, 62, 65]));
        await page.close();
      }
    }

    // ===== W10 D-7 在途写请求（B5 时序）=====
    // 它锁的是：关闭时仍有在途写请求 → 此刻不重载，写请求结束后才重载一次（读到写入后的数据，时间线 close → write-done → list-req）；
    //   写请求失败 / 关闭先于自动保存完成 / 连续关闭重开 的场景各恰重载一次。
    console.log('W10 在途写请求');
    {
      // W10a：复制触发的静默保存在途时关闭
      const { page, reqs, tl, mark } = await open(admin, 'W10a');
      const g = gate();
      await page.route('**/api/models/52/save-scripts', async (route) => { await g.p; await route.fulfill({ status: 200, contentType: 'application/json', body: OK_SAVE }); });
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => copyDwdEtlScript('init'));
      await posted;
      mark('close');
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await stableCount(page, 1000);
      check('W10a 关闭时写请求仍在途：此刻不重载（GET +0）', reqs.n === 0, reqs.n);
      const listReq = waitList(page);
      g.release();
      await listReq; await page.waitForLoadState('networkidle');
      check('W10a 写请求结束后才重载：时间线恰为 close → write-done → list-req（读到写入后的数据），共 1 次重载', J(tl) === J(['close', 'write-done', 'list-req']) && reqs.n === 1, tl);
      await page.close();
    }
    {
      // W10b：验收请求在途时关闭（ODS：validate 在途，关闭后返回；autoSave 因弹窗已关 modelId 为空而跳过）
      const { page, reqs, tl, mark } = await open(admin, 'W10b');
      const g = gate(); let saves = 0;
      page.on('request', (r) => { if (r.method() === 'POST' && /\/save-scripts$/.test(new URL(r.url()).pathname)) saves++; });
      await page.route('**/api/models/6/validate', async (route) => { await g.p; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ overall_result: 'pass', total_rows: 10, execution_time_ms: 5, details: {} }) }); });
      await page.evaluate(() => { openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS'); });
      const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/6\/validate$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => { window.__rv = runValidation(); });
      await posted;
      mark('close');
      await page.evaluate(() => closeValidationModal());
      await stableCount(page, 1000);
      check('W10b 验收在途时关闭：此刻不重载（+0）', reqs.n === 0, reqs.n);
      const listReq = waitList(page);
      g.release();
      await listReq; await pageAwait(page, "__rv"); await page.waitForLoadState('networkidle');
      check('W10b 验收结束后才重载：close → write-done → list-req 各一次；弹窗已关，自动保存被跳过（0 次 save-scripts），不再多重载', J(tl) === J(['close', 'write-done', 'list-req']) && reqs.n === 1 && saves === 0, { tl, n: reqs.n, saves });
      await page.close();
    }
    {
      // W10c：写请求失败（HTTP 500）——失败也算已发出（可能已落库），关闭时仍重载一次；在途时关闭则失败结束后重载
      expectErr('W10c', U_SAVE);
      const { page, reqs, tl, mark } = await open(admin, 'W10c');
      await page.route('**/api/models/52/save-scripts', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' }));
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      const saved = page.waitForResponse((r) => /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => copyDwdEtlScript('init'));
      await saved; await page.waitForTimeout(100);
      mark('close');
      const listReq = waitList(page);
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await listReq; await page.waitForLoadState('networkidle');
      check('W10c 静默保存失败（500）后关闭 ⇒ 仍重载 +1（时间线 write-done → close → list-req）', reqs.n === 1 && tl.indexOf('list-req') > tl.indexOf('close') && tl.indexOf('close') > tl.indexOf('write-done'), tl);
      // 连接级失败（请求 abort，等价于超时 / 断网）：在途时关闭 → 失败结束后重载
      await page.unroute('**/api/models/52/save-scripts');
      const g = gate();
      await page.route('**/api/models/52/save-scripts', async (route) => { await g.p; await route.abort('failed'); });
      reqs.n = 0; tl.length = 0;
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => copyDwdEtlScript('init'));
      await posted;
      mark('close');
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await stableCount(page, 800);
      check('W10c 在途时关闭（请求随后连接失败）：失败前不重载（+0）', reqs.n === 0, reqs.n);
      const listReq2 = waitList(page);
      g.release();
      await listReq2; await page.waitForLoadState('networkidle');
      check('W10c 请求连接失败结束后重载 +1：时间线 close → write-fail → list-req', J(tl) === J(['close', 'write-fail', 'list-req']) && reqs.n === 1, tl);
      await page.close();
    }
    {
      // W10d：关闭先于自动保存完成（ODS 验收立即通过，autoSave 的 save-scripts 在途时关闭）
      const { page, reqs, tl, mark } = await open(admin, 'W10d');
      const g = gate();
      await page.route('**/api/models/6/save-scripts', async (route) => { await g.p; await route.fulfill({ status: 200, contentType: 'application/json', body: OK_SAVE }); });
      await page.evaluate(() => { openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS'); });
      const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/6\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => { window.__rv = runValidation(); });
      await posted;
      mark('close');
      await page.evaluate(() => closeValidationModal());
      await stableCount(page, 800);
      check('W10d 自动保存在途时关闭：此刻不重载（+0；验收本身已完成但保存未完成）', reqs.n === 0, reqs.n);
      const listReq = waitList(page);
      g.release();
      await listReq; await pageAwait(page, "__rv"); await page.waitForLoadState('networkidle');
      check('W10d 自动保存完成后重载恰 1 次：时间线末尾 close → write-done → list-req', reqs.n === 1 && J(tl.slice(tl.indexOf('close'))) === J(['close', 'write-done', 'list-req']), tl);
      await page.close();
    }
    // ===== P53 = B：ODS 验收后自动保存——先 GET 最新行（列表缓存可能过期），请求体带 purpose 与最新行的 config_rev；GET 失败不保存、不回退列表缓存 =====
    console.log('P53 ODS 自动保存');
    {
      // P53a：替身让「最新行」的 config_rev 与列表缓存不同、table_comment 带标记；自动保存的请求必须 ① 先发 GET /api/models/6 再发 POST ② 带 purpose ③ 带最新行的版本（不是缓存的）④ 脚本由最新行生成
      const { page } = await open(admin, 'P53a');
      const seq = []; let postBody = null; let latestRev = null; const MARK = 'P53-最新行注释标记';
      page.on('request', (r) => { try { const u = new URL(r.url()); if (u.pathname === '/api/models/6' && r.method() === 'GET') seq.push('GET'); if (u.pathname === '/api/models/6/save-scripts' && r.method() === 'POST') { seq.push('POST'); postBody = JSON.parse(r.postData() || '{}'); } } catch (_) { /* ignore */ } });
      await page.route('**/api/models/6', async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const real = await route.fetch(); const j = await real.json();
        latestRev = j.config_rev + 5; j.config_rev = latestRev; j.table_comment = MARK;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
      });
      await page.route('**/api/models/6/save-scripts', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: OK_SAVE }));
      const cachedRev = await page.evaluate(() => allModelsData.find((m) => m.id === 6).config_rev);
      await page.evaluate(() => { openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS'); });
      const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/6\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => { window.__rv = runValidation(); });
      await posted; await pageAwait(page, '__rv'); await page.waitForLoadState('networkidle');
      check('P53a 自动保存先 GET 最新行再 POST：请求顺序恰为 GET, POST（各 1 次）', J(seq) === J(['GET', 'POST']), seq);
      check('P53a 请求体带 purpose = ods-auto-save，tableName 为模型表名', postBody && postBody.purpose === 'ods-auto-save' && postBody.tableName === 'ods_w0001_df', postBody && { purpose: postBody.purpose, tableName: postBody.tableName });
      check('P53a 请求体的 expected_config_rev 是最新行的版本（' + latestRev + '），不是列表缓存的（' + cachedRev + '）', postBody && Number.isInteger(latestRev) && postBody.expected_config_rev === latestRev && latestRev !== cachedRev, { body: postBody && postBody.expected_config_rev, latestRev, cachedRev });
      check('P53a 脚本由最新行生成（DDL 含最新行的表注释标记）', postBody && postBody.scripts && typeof postBody.scripts.ddl === 'string' && postBody.scripts.ddl.includes(MARK) && typeof postBody.scripts.sync === 'string', postBody && postBody.scripts && String(postBody.scripts.ddl).slice(0, 120));
      await page.close();
    }
    {
      // P53b：GET 最新行失败（HTTP 500）⇒ 不自动保存（0 次 save-scripts），不回退到列表缓存
      expectErr('P53b', /\/api\/models\/6$/);
      const { page } = await open(admin, 'P53b');
      let saves = 0; let gets = 0;
      page.on('request', (r) => { try { const u = new URL(r.url()); if (u.pathname === '/api/models/6/save-scripts' && r.method() === 'POST') saves++; if (u.pathname === '/api/models/6' && r.method() === 'GET') gets++; } catch (_) { /* ignore */ } });
      await page.route('**/api/models/6', (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' }) : route.fallback()));
      await page.evaluate(() => { openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS'); });
      await page.evaluate(() => { window.__rv = runValidation(); });
      await pageAwait(page, '__rv'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(500);
      check('P53b 读最新行失败（500）：发过 GET、0 次 save-scripts（不保存，也不回退列表缓存）', gets >= 1 && saves === 0, { gets, saves });
      await page.close();
    }
    // ===== P57②（codex 49A-astra MED + 预筛 §7）：服务端对 purpose = ods-auto-save 返回 409（版本过期 / 分层已不是 ODS）⇒ 前端**不自动重试**，只重查能否自行归档并给一条 warning 提示 =====
    //   依据：409 ⇒ 当前版本 ≠ 请求版本 ≥ 验收时的版本 ⇒ 这次验收已失效；重试只会把没验收过的配置生成的脚本按首次豁免落盘。stillCurrent() 为假（已重新渲染验收结果）⇒ 既不重查也不提示。
    {
      const instrument = (page) => page.evaluate(() => {
        window.__toasts = []; window.__csa = 0;
        const ot = window.showToast; window.showToast = function (m, t) { window.__toasts.push([m, t]); return ot.apply(this, arguments); };
        const oc = window.checkCanSelfArchiveInModal; window.checkCanSelfArchiveInModal = function () { window.__csa++; return oc.apply(this, arguments); };
      });
      const WARN = '配置在验收后已变化，ODS 脚本未自动保存';
      for (const [tag, code, bump] of [['P57a', 'CONFIG_REV_STALE', false], ['P57a2', 'LAYER_NOT_ODS', false], ['P57b', 'CONFIG_REV_STALE', true]]) {
        expectErr(tag, U_SAVE);
        const { page } = await open(admin, tag);
        await instrument(page);
        let gets = 0, posts = 0, csaAtPost = null; const g = gate();
        page.on('request', (r) => { try { const u = new URL(r.url()); if (u.pathname === '/api/models/6' && r.method() === 'GET') gets++; if (u.pathname === '/api/models/6/save-scripts' && r.method() === 'POST') posts++; } catch (_) { /* ignore */ } });
        await page.route('**/api/models/6/save-scripts', async (route) => {
          csaAtPost = await page.evaluate(() => window.__csa);
          if (bump) await g.p;   // P57b：扣住响应，期间模拟「又渲染了新的验收结果」（stillCurrent() 变假）
          await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: '桩', code, current_config_rev: 99 }) });
        });
        await page.evaluate(() => { openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS'); });
        const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/6\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
        await page.evaluate(() => { window.__rv = runValidation(); });
        await posted;
        if (bump) { await page.evaluate(() => { validationRenderGen++; }); g.release(); }
        await pageAwait(page, '__rv'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(500);
        const st = await page.evaluate(() => ({ toasts: window.__toasts, csa: window.__csa }));
        const warns = st.toasts.filter((x) => x[0] === WARN);
        check(`${tag} 409 ${code}：不重试——GET /api/models/6 与 POST save-scripts 各恰 1 次（没有第二次 GET / POST）`, gets === 1 && posts === 1, { gets, posts });
        if (!bump) {
          check(`${tag} 409 ${code}：弹窗仍是这次验收 ⇒ 恰 1 条 warning 提示「${WARN}」，没有「已自动保存」成功提示`, warns.length === 1 && warns[0][1] === 'warning' && !st.toasts.some((x) => /已自动保存/.test(x[0])), st.toasts);
          check(`${tag} 409 ${code}：弹窗仍是这次验收 ⇒ POST 之后恰重查一次能否自行归档（checkCanSelfArchiveInModal +1）`, csaAtPost !== null && st.csa - csaAtPost === 1, { csaAtPost, final: st.csa });
        } else {
          check(`${tag} 409 ${code}：响应到达时验收结果已重新渲染（stillCurrent() 为假）⇒ 不提示`, warns.length === 0 && !st.toasts.some((x) => /已自动保存/.test(x[0])), st.toasts);
          check(`${tag} 409 ${code}：stillCurrent() 为假 ⇒ 不重查能否自行归档（checkCanSelfArchiveInModal +0）`, csaAtPost !== null && st.csa - csaAtPost === 0, { csaAtPost, final: st.csa });
        }
        g.release();
        await page.close();
      }
    }
    {
      // P57 LOW-3：GET 最新行期间关闭验收弹窗（currentValidationModelId 置空）⇒ POST 仍用发起时的模型 id，路径是 /api/models/6/save-scripts，不是 /api/models/null/save-scripts
      const { page } = await open(admin, 'P57c');
      const g = gate(); const postUrls = [];
      page.on('request', (r) => { try { const u = new URL(r.url()); if (r.method() === 'POST' && /save-scripts$/.test(u.pathname)) postUrls.push(u.pathname); } catch (_) { /* ignore */ } });
      await page.route('**/api/models/6', async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        await g.p;
        const real = await route.fetch();
        await route.fulfill({ response: real });
      });
      await page.evaluate(() => { openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS'); });
      const gotGet = page.waitForRequest((r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/models/6', { timeout: WAIT });
      await page.evaluate(() => { window.__rv = runValidation(); });
      await gotGet;
      await page.evaluate(() => closeValidationModal());
      const cleared = await page.evaluate(() => currentValidationModelId === null);
      g.release();
      await pageAwait(page, '__rv'); await page.waitForLoadState('networkidle'); await page.waitForTimeout(500);
      check('P57c GET 期间关闭弹窗：此刻 currentValidationModelId 已置空（用例前提）', cleared === true, cleared);
      check('P57c GET 期间关闭弹窗后放行：POST 路径是 /api/models/6/save-scripts（用发起时的模型 id），不是 /api/models/null/save-scripts', J(postUrls) === J(['/api/models/6/save-scripts']), postUrls);
      await page.close();
    }
    {
      // W10e：连续关闭 / 重开——在途时关闭（待重载），写请求结束前重开同一类弹窗，结束后重载恰 1 次；再关闭不再重载
      const { page, reqs, tl } = await open(admin, 'W10e');
      const g = gate();
      await page.route('**/api/models/52/save-scripts', async (route) => { await g.p; await route.fulfill({ status: 200, contentType: 'application/json', body: OK_SAVE }); });
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => copyDwdEtlScript('init'));
      await posted;
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await stableCount(page, 800);
      check('W10e 连续关闭 / 重开 / 再关闭，写请求仍在途：不重载（+0）', reqs.n === 0, reqs.n);
      const listReq = waitList(page);
      g.release();
      await listReq; await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W10e 写请求结束后重载恰 1 次（不因两次关闭重复）', reqs.n === 1, reqs.n);
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await stableCount(page, 800);
      check('W10e 无关的再一次开关：不再重载（无陈旧标记）', reqs.n === 1, reqs.n);
      void tl;
      await page.close();
    }

    // ===== W11 关闭后才发起的写入 =====
    // 它锁的是：弹窗已关后才发起的静默保存（复制的剪贴板 promise 在关闭后才完成），结束后直接重载一次；下一次无关的开关不再重载（不留跨弹窗的陈旧标记）。
    console.log('W11 关闭后才发起的写入');
    {
      const { page, reqs, tl, mark } = await open(admin, 'W11');
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => { window.copyToClipboard = () => new Promise((r) => { window.__releaseCopy = r; }); });
      await page.evaluate(() => copyDwdEtlScript('init'));
      mark('close');
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await stableCount(page, 800);
      check('W11 关闭时还没有写请求（剪贴板未完成）：不重载（+0）', reqs.n === 0, reqs.n);
      const listReq = waitList(page);
      await page.evaluate(() => window.__releaseCopy());
      await listReq; await page.waitForLoadState('networkidle');
      check('W11 关闭后才发起的保存结束后直接重载 +1：时间线 close → write-done → list-req', J(tl) === J(['close', 'write-done', 'list-req']) && reqs.n === 1, tl);
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await stableCount(page, 800);
      check('W11 下一次无关的开关：不再重载（仍 +1）', reqs.n === 1, reqs.n);
      await page.close();
    }

    // ===== W12 DDL 弹窗的关闭钩子 =====
    // 它锁的是：closeDimDdlPreviewModal（custom DDL 编辑器保存）与 closeDwdDdlModal（复制 DDL 触发静默保存）各自保存后关闭：关闭前不重载、关闭后恰 1 次（时间线）；只开只关 +0。
    console.log('W12 DDL 弹窗关闭钩子');
    {
      const { page, reqs, tl, mark } = await open(admin, 'W12');
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      await pageCallBounded(page, 'openDimDDLModal(58)');
      await page.waitForSelector('#dimDdlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => closeDimDdlPreviewModal());
      await stableCount(page, 800);
      check('W12 对照：只开只关 custom DIM DDL 弹窗 → +0', reqs.n === 0, reqs.n);
      await pageCallBounded(page, 'openDimDDLModal(58)');
      await page.waitForSelector('#dimDdlPreviewModal', { timeout: WAIT });
      mark('save-start');
      await pageCallBounded(page, "(function () { document.getElementById('customDdlEditor').value = 'CREATE TABLE t_probe (a INT)'; return saveCustomDDL(58); })()", 'saveCustomDDL(58)');
      await stableCount(page, 500);   // 让写请求结束的页面回调（含可能的错误重载）先到达 node，再标记 close
      let reload = waitList(page);
      mark('close');
      await page.evaluate(() => closeDimDdlPreviewModal());
      let got = !!(await reload);
      await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W12 custom DIM DDL 编辑器保存 → closeDimDdlPreviewModal ⇒ 关闭前无 list-req、关闭后恰 1 次（时间线）', got && tlCheck(tl), tl);
      reqs.n = 0;
      await pageCallBounded(page, 'openDwdDDLModal(52)');
      await page.waitForSelector('#dwdDdlModal', { timeout: WAIT });
      await page.evaluate(() => closeDwdDdlModal());
      await stableCount(page, 800);
      check('W12 对照：只开只关 DWD DDL 弹窗 → +0', reqs.n === 0, reqs.n);
      await pageCallBounded(page, 'openDwdDDLModal(52)');
      await page.waitForSelector('#dwdDdlModal', { timeout: WAIT });
      const saved = page.waitForResponse((r) => /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      mark('save-start');
      await page.evaluate(() => copyDwdDdl());
      await saved;
      await stableCount(page, 500);   // 让写请求结束的页面回调（含可能的错误重载）先到达 node，再标记 close
      reload = waitList(page);
      mark('close');
      await page.evaluate(() => closeDwdDdlModal());
      got = !!(await reload);
      await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W12 复制 DWD DDL 触发静默保存 → closeDwdDdlModal ⇒ 关闭前无 list-req、关闭后恰 1 次（时间线）', got && tlCheck(tl), tl);
      await page.close();
    }

    // ===== W13 highlightModel 定位（A2）=====
    // 它锁的是：目标所在页由「全量视图」推导，与当前页无关——跨页、搜索过滤后、落单伴生（主模型不在列表里）都定位到正确的组页；被过滤掉的目标不跳转。
    console.log('W13 highlightModel 定位');
    {
      const { page } = await open(admin, 'W13', '', { beforeGoto: async (pg) => {
        await pg.route(isList, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          const resp = await route.fetch(); const rows = await resp.json();
          const base = rows.find((r) => r.id === 59);
          await route.fulfill({ response: resp, body: JSON.stringify(rows.concat([Object.assign({}, base, { id: 9001, table_name: 'dwd_orphan_change_di', companion_of: 9999, config_mode: 'companion' })])) });   // 落单伴生：主模型 #9999 不在列表里，排在输入末尾 = 第 36 组
        });
      } });
      check('W13 前置：37 行 / 36 组，#9001 是落单组', (await view(page)).totalGroups === 36 && (await page.evaluate(() => catalogFullView().groups.some((g) => g.orphan && g.id === 9001))));
      await page.evaluate(() => highlightModel(6));
      check('W13 跨页：当前第 1 页 → highlightModel(6)（第 2 页）→ 跳到第 2 页', (await page.evaluate(() => currentPage)) === 2 && (await domIds(page)).includes(6));
      await page.evaluate(() => highlightModel(60));
      check('W13 跨页：第 2 页 → highlightModel(60)（第 1 页）→ 回第 1 页', (await page.evaluate(() => currentPage)) === 1 && (await domIds(page)).includes(60));
      await page.evaluate(() => highlightModel(9001));
      check('W13 落单伴生：highlightModel(9001) → 第 36 组所在的第 2 页，行已渲染', (await page.evaluate(() => currentPage)) === 2 && (await domIds(page)).includes(9001));
      await page.evaluate(() => { currentPage = 1; renderModelsPage(); });
      await page.fill('#searchKeyword', 'dim_');
      const vf = await view(page);
      await page.evaluate(() => highlightModel(50));
      check('W13 过滤后：搜 dim_（6 组，1 页）→ highlightModel(50) 留在第 1 页，行已渲染', (await page.evaluate(() => currentPage)) === 1 && (await domIds(page)).includes(50));
      await page.evaluate(() => highlightModel(6));
      const vf2 = await view(page);
      check('W13 过滤后：目标 #6 被过滤掉 → highlightModel(6) 不跳转（仍第 1 页）、没有该行；搜索框仍为 dim_，视图（totalModels / orderedIds）不变', (await page.evaluate(() => currentPage)) === 1 && !(await domIds(page)).includes(6) && (await page.inputValue('#searchKeyword')) === 'dim_' && vf2.totalModels === vf.totalModels && J(vf2.orderedIds) === J(vf.orderedIds) && vf.totalModels === 6, { vf: vf.orderedIds, vf2: vf2.orderedIds });
      await page.close();
    }

    // W10f（R1 场景③ + ⑤）：在途时关闭 → 重开另一个带钩子弹窗 → 旧写请求结束：弹窗开着，不重载；再关闭恰 1 次；之后无关开关 0 次。
    //   场景⑤：两个写请求在途、关闭 → 第一个结束不重载、第二个结束时恰 1 次。
    //   场景⑥（嵌套：一个带钩子弹窗开着时再打开另一个）：页面里没有真实路径——五个弹窗的打开函数只有行按钮（CAT 行模板 onclick）、?validate 深链（Model_Center.html:1204，加载时）、抽屉里的 DDL 按钮（:3946，抽屉不是带钩子弹窗）调用；
    //   任一带钩子弹窗开着时都是全屏遮罩（验收 z-index 2000、DDL / ETL 预览 3000），盖住行按钮；故不做嵌套用例，重开场景用「关闭后重开另一个」覆盖。
    console.log('W10f 在途时关闭后重开另一个弹窗 / 两个写请求在途');
    {
      const { page, reqs, tl, mark } = await open(admin, 'W10f');
      const g = gate();
      await page.route('**/api/models/52/save-scripts', async (route) => { await g.p; await route.fulfill({ status: 200, contentType: 'application/json', body: OK_SAVE }); });
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      const posted = page.waitForRequest((r) => r.method() === 'POST' && /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => copyDwdEtlScript('init'));
      await posted;
      mark('close');
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await pageCallBounded(page, 'openDwdDDLModal(52)');   // 重开另一个带钩子的弹窗（DWD DDL）
      await page.waitForSelector('#dwdDdlModal', { timeout: WAIT });
      mark('reopen');
      g.release();
      await page.waitForResponse((r) => /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await stableCount(page, 1200);
      check('W10f 场景③：重开期间旧写请求结束 → 弹窗开着，不重载（0 次 list-req）', reqs.n === 0 && !tl.includes('list-req'), tl);
      const listReq = waitList(page);
      mark('close2');
      await page.evaluate(() => closeDwdDdlModal());
      await listReq; await page.waitForLoadState('networkidle'); await stableCount(page, 800);
      check('W10f 场景③：再关闭后恰重载 1 次（时间线 … reopen → write-done → close2 → list-req）', reqs.n === 1 && tl.indexOf('list-req') > tl.indexOf('close2') && tl.indexOf('close2') > tl.indexOf('reopen'), tl);
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await stableCount(page, 800);
      check('W10f 场景③：之后无关的开关 0 次（仍 +1）', reqs.n === 1, reqs.n);
      await page.close();
    }
    {
      // 场景⑤：两个写请求在途
      const { page, reqs } = await open(admin, 'W10g');
      const g1 = gate(), g2 = gate(); let n = 0;
      await page.route('**/api/models/52/save-scripts', async (route) => { const mine = ++n; await (mine === 1 ? g1.p : g2.p); await route.fulfill({ status: 200, contentType: 'application/json', body: OK_SAVE }); });
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      const two = new Promise((resolve) => { let c = 0; page.on('request', (r) => { if (r.method() === 'POST' && /\/52\/save-scripts$/.test(new URL(r.url()).pathname) && ++c === 2) resolve(); }); });
      await page.evaluate(() => { copyDwdEtlScript('init'); copyDwdEtlScript('incr'); });
      await two;
      await page.evaluate(() => closeDwdEtlPreviewModal());
      g1.release();
      await page.waitForResponse((r) => /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await stableCount(page, 1000);
      check('W10g 场景⑤：两个写请求在途、关闭 → 第一个结束仍有一个在途，不重载（0 次）', reqs.n === 0, reqs.n);
      const listReq = waitList(page);
      g2.release();
      await listReq; await page.waitForLoadState('networkidle'); await stableCount(page, 800);
      check('W10g 场景⑤：第二个结束时恰重载 1 次', reqs.n === 1, reqs.n);
      await page.close();
    }

    // ===== W14（R2）重载失败后写入标记恢复，下一次关闭 / 写结束重试 =====
    // 它锁的是：第一次重载失败（HTTP 500 / 200 非 JSON）不丢标记；之后一次无关的带钩子弹窗开关恰重试 1 次并成功；再开关一次 0 次。
    console.log('W14 重载失败后重试');
    for (const [label, fulfill] of [['HTTP 500', { status: 500, contentType: 'application/json', body: '{"error":"桩"}' }], ['200 非 JSON', { status: 200, contentType: 'application/json', body: 'not json' }]]) {
      expectErr('W14', U_LIST);
      const { page, reqs } = await open(admin, 'W14');
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      await page.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); await route.fulfill(fulfill); });
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      const saved = page.waitForResponse((r) => /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => copyDwdEtlScript('init'));
      await saved;
      const first = waitList(page);
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await first; await stableCount(page, 800);
      const st = await page.evaluate(() => ({ stale: catalogIsStale(), len: allModelsData.length }));
      check('W14 ' + label + '：第一次重载失败 → 列表仍过期（catalogIsStale() 为 true）、保持旧值（36 行）', reqs.n === 1 && st.stale === true && st.len === 36, { n: reqs.n, st });
      await page.unroute(isList);
      const retry = waitList(page);
      await pageCallBounded(page, 'openDwdScriptModal(52)');   // 无关的带钩子弹窗开关
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await retry; await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      const st2 = await page.evaluate(() => ({ stale: catalogIsStale(), len: allModelsData.length }));
      check('W14 ' + label + '：再一次无关开关 → 恰重试 1 次（累计 2 次）并成功、不再过期', reqs.n === 2 && st2.stale === false && st2.len === 36, { n: reqs.n, st2 });
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await stableCount(page, 800);
      check('W14 ' + label + '：再开关一次 0 次（仍累计 2 次）', reqs.n === 2, reqs.n);
      await page.close();
    }

    // ===== W15（R3）五个带钩子弹窗的 catalogHookModalOpen 判定 =====
    // 它锁的是：五个弹窗各走真实打开函数 → catalogHookModalOpen() 为 true；走真实关闭函数 → false（DIM DDL / DIM ETL 各有标准与 custom 两套模板，都走到）。
    console.log('W15 catalogHookModalOpen 五弹窗判定');
    {
      const { page } = await open(admin, 'W15');
      const isOpen = () => page.evaluate(() => catalogHookModalOpen());
      check('W15 前置：没有弹窗开着 → false', (await isOpen()) === false);
      const CASES = [
        ['验收弹窗（openValidationModal / closeValidationModal）', "openValidationModal(6, 'ods_w0001_df', 'ONLINE', 'ODS')", null, 'closeValidationModal()'],
        ['DIM DDL 标准模板（#50）', 'openDimDDLModal(50)', '#dimDdlPreviewModal', 'closeDimDdlPreviewModal()'],
        ['DIM DDL custom 模板（#58）', 'openDimDDLModal(58)', '#dimDdlPreviewModal', 'closeDimDdlPreviewModal()'],
        ['DIM ETL 标准模板（#50）', 'openDimETLModal(50)', '#dimEtlPreviewModal', 'closeDimEtlPreviewModal()'],
        ['DIM ETL custom 模板（#58）', 'openDimETLModal(58)', '#dimEtlPreviewModal', 'closeDimEtlPreviewModal()'],
        ['DWD DDL（#52）', 'openDwdDDLModal(52)', '#dwdDdlModal', 'closeDwdDdlModal()'],
        ['DWD ETL（#52）', 'openDwdScriptModal(52)', '#dwdEtlPreviewModal', 'closeDwdEtlPreviewModal()'],
      ];
      for (const [label, openExpr, sel, closeExpr] of CASES) {
        await pageCallBounded(page, openExpr);
        if (sel) await page.waitForSelector(sel, { timeout: WAIT });
        const during = await isOpen();
        await page.evaluate((e) => (0, eval)(e), closeExpr);
        const after = await isOpen();
        check('W15 ' + label + '：打开后 true、关闭后 false', during === true && after === false, { during, after });
      }
      await page.close();
    }

    // ===== W16–W19 D-7「代次推导」（codex 36-R2）：重叠的列表请求不污染过期判断 =====
    // 过期 ⇔ catalogListSeen < catalogWritesDone；失败 / 被取代的列表请求什么都不改变；覆盖全部写入的请求在途时不重复发。
    const holdList = async (page, plan) => {   // plan(n) → 'continue' | 'hold-continue' | 'hold-abort' | 500；hold-* 先等 gate.p 再放行 / 失败
      let n = 0; const g = gate();
      await page.route(isList, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const mine = ++n; const act = plan(mine);
        if (act === 'hold-continue') { await g.p; return route.continue(); }
        if (act === 'hold-abort') { await g.p; return route.abort('failed'); }
        if (act === 500) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' });
        return route.continue();
      });
      return { g, count: () => n };
    };
    const openClose = async (page, expr, sel, closeExpr) => { await pageCallBounded(page, expr); await page.waitForSelector(sel, { timeout: WAIT }); await page.evaluate((e) => (0, eval)(e), closeExpr); };
    const saveViaEtlAndClose = async (page, mark, releaseAfter) => {   // DWD ETL 弹窗内复制触发静默保存（桩立即完成）→ 关闭
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      const saved = page.waitForResponse((r) => /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => copyDwdEtlScript('init'));
      await saved; await stableCount(page, 400);
      if (mark) mark('close');
      await page.evaluate(() => closeDwdEtlPreviewModal());
      void releaseAfter;
    };

    // W16（36-R2 H1，场景 6）：关闭触发的重载 R1 在途 → 直接 loadModels()（删除 / 注册等流程）取代它且失败 → 之后一次无关的带钩子弹窗开关 → 恰 1 次重试 → 成功后再开关 0 次
    console.log('W16 重载被取代且取代者失败');
    W16: {
      expectErr('W16', U_LIST);
      const { page, reqs } = await open(admin, 'W16');
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      check('W16 / 场景 10：页面初始加载后 catalogIsStale() === false', (await page.evaluate(() => catalogIsStale())) === false);
      const h = await holdList(page, (n) => (n === 1 ? 'hold-continue' : (n === 2 ? 500 : 'continue')));
      await saveViaEtlAndClose(page, null);
      await stableCount(page, 600);
      const w16pre = h.count() === 1 && reqs.n === 1;
      check('W16 关闭触发重载 R1（挂起，在途）', w16pre, { n: h.count(), reqs: reqs.n });
      if (!w16pre) { h.g.release(); await page.close(); break W16; }   // 前置不成立（R1 没发出）：直接 loadModels() 会成为第 1 个被扣住的请求而互等，故止于此
      const direct = await page.evaluate(async (ms) => { try { return String(await Promise.race([loadModels(), new Promise((r) => setTimeout(() => r('__timeout__'), ms))])); } catch (e) { return 'threw'; } }, WAIT);   // 直接 loadModels()：取代 R1，且返回 500
      check("W16 取代者（直接 loadModels）失败：返回 'failed'，列表仍过期", direct === 'failed' && (await page.evaluate(() => catalogIsStale())) === true, direct);
      h.g.release(); await stableCount(page, 800);
      check('W16 R1 随后放行：被取代，不推进 catalogListSeen（仍过期）', (await page.evaluate(() => catalogIsStale())) === true && h.count() === 2, h.count());
      const before = reqs.n;
      const retry = waitList(page);
      await openClose(page, 'openDwdScriptModal(52)', '#dwdEtlPreviewModal', 'closeDwdEtlPreviewModal()');   // 无关的带钩子弹窗开关
      await retry; await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W16 之后一次无关开关 → 恰 1 次重试（R3），成功后不再过期', reqs.n - before === 1 && (await page.evaluate(() => catalogIsStale())) === false, { d: reqs.n - before });
      const before2 = reqs.n;
      await openClose(page, 'openDwdScriptModal(52)', '#dwdEtlPreviewModal', 'closeDwdEtlPreviewModal()');
      await stableCount(page, 800);
      check('W16 再开关一次 → 0 次', reqs.n === before2, reqs.n - before2);
      await page.close();
    }

    // W17（36-R2 H2，场景 7）：R1 在途（挂起）→ 另一弹窗内写完并关闭 → R2 发出并成功 → R1 以网络错误结束 → 之后无关开关 0 次（旧请求的失败不污染）
    console.log('W17 旧重载网络失败晚于新重载');
    W17: {
      expectErr('W17', U_LIST);
      const { page, reqs } = await open(admin, 'W17');
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      const h = await holdList(page, (n) => (n === 1 ? 'hold-abort' : 'continue'));
      await saveViaEtlAndClose(page, null);   // 写 A → 关闭 → R1（挂起）
      await stableCount(page, 600);
      check('W17 R1 在途（挂起）', h.count() === 1, h.count());
      if (h.count() !== 1) { h.g.release(); await page.close(); break W17; }   // 前置不成立：止
      // 另一弹窗（DWD DDL）内写完并关闭 → R2
      await pageCallBounded(page, 'openDwdDDLModal(52)');
      await page.waitForSelector('#dwdDdlModal', { timeout: WAIT });
      const saved = page.waitForResponse((r) => /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => copyDwdDdl());
      await saved; await stableCount(page, 400);
      const r2 = waitList(page);
      await page.evaluate(() => closeDwdDdlModal());
      await r2; await page.waitForLoadState('networkidle'); await stableCount(page, 800);
      check('W17 R2 发出并成功：不再过期', h.count() === 2 && (await page.evaluate(() => catalogIsStale())) === false, { n: h.count() });
      h.g.release(); await stableCount(page, 800);   // R1 以网络错误结束（晚于 R2）
      const before = reqs.n;
      check('W17 R1 失败后仍不过期（旧请求的失败不污染）', (await page.evaluate(() => catalogIsStale())) === false);
      await openClose(page, 'openDwdScriptModal(52)', '#dwdEtlPreviewModal', 'closeDwdEtlPreviewModal()');
      await stableCount(page, 900);
      check('W17 之后无关开关 → 0 次（不多重载）', reqs.n === before, reqs.n - before);
      await page.close();
    }

    // W18（场景 8）：列表请求先于写结束发出 → 请求成功后 catalogIsStale() 仍为 true → 下一次关闭 → 1 次
    console.log('W18 请求先于写结束发出');
    W18: {
      const { page, reqs, tl, mark } = await open(admin, 'W18');
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      const h = await holdList(page, (n) => (n === 1 ? 'hold-continue' : 'continue'));
      await pageCallBounded(page, 'openDwdScriptModal(52)');
      await page.waitForSelector('#dwdEtlPreviewModal', { timeout: WAIT });
      await page.evaluate(() => { window.__d = loadModels(); });   // 直接 loadModels()（挂起）：发出时 catalogWritesDone = 0
      await stableCount(page, 300);
      if (h.count() !== 1) { check('W18 前置：直接 loadModels() 的列表请求已发出（被扣住）', false, h.count()); h.g.release(); await page.close(); break W18; }
      const saved = page.waitForResponse((r) => /\/52\/save-scripts$/.test(new URL(r.url()).pathname), { timeout: WAIT });
      await page.evaluate(() => copyDwdEtlScript('init'));   // 写在列表请求在途期间结束（此时弹窗开着）
      await saved; await stableCount(page, 500);
      h.g.release(); await pageAwait(page, "__d"); await stableCount(page, 600);
      check('W18 列表请求成功后仍过期（它发出时写还没结束）；弹窗开着，没有额外请求', (await page.evaluate(() => catalogIsStale())) === true && h.count() === 1, { n: h.count() });
      const listReq = waitList(page);
      mark('close');
      await page.evaluate(() => closeDwdEtlPreviewModal());
      await listReq; await page.waitForLoadState('networkidle'); await stableCount(page, 600);
      check('W18 下一次关闭 → 恰 1 次重载（时间线 close → list-req），之后不再过期', reqs.n === 2 && h.count() === 2 && tl.indexOf('list-req', tl.indexOf('close')) > tl.indexOf('close') && (await page.evaluate(() => catalogIsStale())) === false, { reqs: reqs.n, tl });
      await page.close();
    }

    // W19（场景 9，去重）：关闭触发的覆盖请求在途时，再开关一个无写入的带钩子弹窗 → 不再发第二个请求
    console.log('W19 覆盖请求在途时去重');
    W19: {
      const { page, reqs } = await open(admin, 'W19');
      await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
      const h = await holdList(page, (n) => (n === 1 ? 'hold-continue' : 'continue'));
      await saveViaEtlAndClose(page, null);   // 写 → 关闭 → 覆盖请求 R1（挂起）
      await stableCount(page, 500);
      if (h.count() !== 1) { check('W19 前置：关闭触发的覆盖请求 R1 已发出（被扣住）', false, h.count()); h.g.release(); await page.close(); break W19; }
      await openClose(page, 'openDwdScriptModal(52)', '#dwdEtlPreviewModal', 'closeDwdEtlPreviewModal()');   // 无写入的开关（R1 在途）
      await stableCount(page, 900);
      check('W19 覆盖请求在途时再开关一个无写入弹窗 → 不发第二个请求（共 1 次）', h.count() === 1 && reqs.n === 1, { n: h.count(), reqs: reqs.n });
      h.g.release(); await page.waitForLoadState('networkidle'); await stableCount(page, 800);
      check('W19 覆盖请求成功后：不再过期，总共仍 1 次', (await page.evaluate(() => catalogIsStale())) === false && reqs.n === 1, reqs.n);
      await page.close();
    }


    // ====================================================================================================================
    // 子批 2c：W20 起（C4c-2：行结构 / 菜单 / 委托 / 抽屉 / 新排序键 / XSS / 页内变异）。
    //   约定：每组用例都含伴生条目（#53 随 #52；需要时用路由改写出落单伴生 / 额外伴生）；每个 check 的第一个名字写清「它锁的是什么」，期望值全部手写。
    // ====================================================================================================
    // 2d：W5 的假时钟已改装在 W5 自己的独立上下文里（见 W5），admin 上下文不再被冻结。adminN 仍是一个全新的干净上下文（不带 W1–W19 留下的页面状态 / localStorage），W20 起沿用。
    const adminN = await mkCtx(USERS[0]);
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const HANDLERS = ['openWorkbench', 'openDimDDLModal', 'openDimETLModal', 'openDwdDDLModal', 'openDwdScriptModal', 'openEditModal', 'openDimConfigViewModal', 'openDwdConfigViewModal', 'viewModelChangeLogs', 'deleteModel', 'openDDLModal', 'openValidationModal'];
    /** 把 12 个处理函数换成记录型替身（经全局名；分发若缓存了旧引用就记不到） */
    const stubHandlers = (page) => page.evaluate((names) => { window.__calls = []; names.forEach((n) => { window[n] = function () { window.__calls.push({ fn: n, n: arguments.length, args: Array.prototype.slice.call(arguments) }); }; }); }, HANDLERS);
    const callsOf = (page) => page.evaluate(() => window.__calls);
    /** 路由改写列表：fn(rows) → rows（pathname 恰为 /api/models 的 GET；首屏 loadModels 与 app.js loadAllModels 都经它） */
    const rewriteList = (fn) => async (pg) => {
      await pg.route(isList, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const resp = await route.fetch(); const rows = await resp.json();
        await route.fulfill({ response: resp, body: JSON.stringify(fn(rows)) });
      });
    };
    const patchRows = (patches) => (rows) => rows.map((r) => (patches[r.id] ? (typeof patches[r.id] === 'function' ? patches[r.id](r) : Object.assign({}, r, patches[r.id])) : r));   // 函数补丁返回整行（可删键）；对象补丁合并
    const addRows = (mk) => (rows) => rows.concat(mk(rows));
    const chain = (...fs) => (rows) => fs.reduce((acc, f) => f(acc), rows);
    const isDomains = (u) => u.pathname === '/api/domains';
    const both = (...fs) => async (pg) => { for (const f of fs) await f(pg); };
    /** 定时器 FIFO 栅栏：showDesignNotesPopover 用 setTimeout(0) 才注册「点别处关闭」监听；这里在页内再排一个 setTimeout(0)，它必然排在那一个之后执行——栅栏返回时监听已注册（事件驱动，不是 sleep 猜时序） */
    const fence = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    const clickC = async (page, sel, opts) => { const l = page.locator(sel).first(); await l.evaluate((e) => e.scrollIntoView({ block: 'center' })); await l.click(opts); };
    const domainText = (page, id) => page.$eval(`#modelListBody [data-id="${id}"] .catalog-domain`, (e) => e.textContent);
    const waitDomain = (page, id, want) => page.waitForFunction(([i, w]) => { const e = document.querySelector(`#modelListBody [data-id="${i}"] .catalog-domain`); return !!e && e.textContent === w; }, [id, want], { timeout: WAIT }).then(() => true, () => false);
    /** 当前打开的菜单 id 与 aria-expanded 为真的触发按钮所控制的菜单 id（两者必须一致，契约 9） */
    const menuStates = (page) => page.evaluate(() => ({
      open: Array.from(document.querySelectorAll('#modelListBody [role="menu"]')).filter((m) => !m.hasAttribute('hidden')).map((m) => m.id).sort(),
      expanded: Array.from(document.querySelectorAll('#modelListBody [data-menu]')).filter((t) => t.getAttribute('aria-expanded') === 'true').map((t) => t.getAttribute('aria-controls')).sort(),
    }));
    /** 断言「恰好这些菜单开着，且 aria-expanded 与可见性一致」 */
    const onlyOpen = async (page, ids) => { const s = await menuStates(page); return J(s.open) === J(ids.slice().sort()) && J(s.expanded) === J(s.open) ? true : s; };
    const readEntry = (page, id) => page.evaluate((id) => {
      const e = document.querySelector(`#modelListBody [data-id="${id}"]`); if (!e) return null;
      const t = (sel) => { const x = e.querySelector(sel); return x ? x.textContent : null; };
      const badge = e.querySelector('.u-status-badge'); const open = e.querySelector('.model-open-btn'); const impl = e.querySelector('.catalog-impl');
      return {
        layer: t('.catalog-layer'), layerCls: e.querySelector('.catalog-layer').className, name: open.textContent, nameTitle: open.getAttribute('title'), modelIdAttr: open.getAttribute('data-model-id'),
        comment: t('.catalog-comment'), tags: Array.from(e.querySelectorAll('.catalog-tag')).map((x) => x.textContent),
        status: badge ? badge.textContent : null, statusCls: badge ? badge.className : null, owner: t('.catalog-owner'),
        id2: t('.catalog-id'), impl: impl.textContent, implTitle: impl.getAttribute('title'), implEmpty: impl.classList.contains('catalog-impl-empty'),
        domain: t('.catalog-domain'), updated: t('.catalog-updated'), rel: t('.catalog-rel'), isCompanion: e.classList.contains('is-companion'), hasNotes: !!e.querySelector('[data-entry="design-notes"]'),
        padLeft: parseFloat(getComputedStyle(e).paddingLeft),
      };
    }, id);
    const readAcc = (page, id) => page.evaluate((id) => {
      const c = document.querySelector(`#modelListBody [data-id="${id}"] .catalog-acc`); if (!c) return null;
      const tx = c.querySelector('.catalog-acc-text'); const dt = c.querySelector('.catalog-acc-date'); const rc = c.querySelector('.catalog-acc-recheck');
      return { text: tx.textContent, kindCls: tx.className, date: dt ? dt.textContent : '', recheck: rc ? rc.textContent : '', title: c.getAttribute('title') || '', cell: c.textContent };
    }, id);
    /** 菜单项读数：{ vKind: menu|direct|disabled, vTitle, vItems:[…], more:[…] }；项 = { act, label, disabled, aria, title, reason } */
    const readMenus = (page, id) => page.evaluate((id) => {
      const e = document.querySelector(`#modelListBody [data-id="${id}"]`);
      const items = (menu) => Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => ({ act: b.getAttribute('data-act'), label: b.querySelector('.catalog-menu-label').textContent, disabled: b.disabled, aria: b.getAttribute('aria-disabled'), title: b.getAttribute('title') || '', reason: (b.querySelector('.model-menu-reason') || { textContent: '' }).textContent }));
      const vTrig = e.querySelector('[data-menu="validate"]'); const vBtn = e.querySelector('.model-row-actions > [data-act="validate"]');
      const vMenu = vTrig ? document.getElementById(vTrig.getAttribute('aria-controls')) : null;
      const more = document.getElementById(e.querySelector('[data-menu="more"]').getAttribute('aria-controls'));
      return { vKind: vTrig ? 'menu' : (vBtn ? (vBtn.disabled ? 'disabled' : 'direct') : 'none'), vTitle: vBtn ? (vBtn.getAttribute('title') || '') : '', vItems: vMenu ? items(vMenu) : [], more: items(more) };
    }, id);
    /** 期望项 [act, 标签, 可用?, title]；置灰项还须 aria-disabled="true" 且 .model-menu-reason 与 title 逐字相同（契约 6 / 6a），可用项无 aria-disabled、无 reason */
    const itemsOk = (got, want) => got.length === want.length && want.every((w, i) => { const g = got[i]; return g.act === w[0] && g.label === w[1] && g.disabled === !w[2] && g.title === w[3] && (w[2] ? (g.aria === null && g.reason === '') : (g.aria === 'true' && g.reason === w[3])); });
    const LBL = { etl: 'ETL 脚本', ddl: 'DDL', 'edit-config': '编辑配置', 'view-config': '配置（只读）', 'edit-info': '编辑信息', history: '变更历史', delete: '删除', 'validate-structure': '结构验收', 'validate-data': '数据验收', 'validate-semantic': '语义验收' };
    const it = (act, enabled, title) => [act, LBL[act], enabled, title || ''];
    const V3 = [it('validate-structure', true), it('validate-data', true), it('validate-semantic', true)];
    const V2 = [it('validate-structure', true), it('validate-data', true)];
    const T_HIST = '查看变更历史';
    const R_COMP_DEL = '伴生表随主模型的变更追踪开关增删';
    const R_COMP_ETL = '伴生表写入逻辑在主表增量 ETL 的 Step 3 中';
    const R_COMP_DDL = '请在主表 DDL 弹窗中切换「伴生表 DDL」标签页查看';
    const R_ODS_CFG = 'ODS 无平台配置，请用编辑信息';
    const R_ODS_ETL = 'ODS 同步由 FDL 工具管理';
    const T_VIEW_DIM = '查看 DIM 配置（只读）';
    const T_VIEW_DWD = '查看 DWD 配置（只读）';
    const T_VIEW_COMP = '伴生表配置由主表自动管理（只读）';
    const DESC_ALL = range(101, 125).reverse().concat([65, 62, 60, 59, 58, 55, 52, 53, 50, 8, 6]);
    const ASC_ALL = [6, 8, 50, 52, 53, 55, 58, 59, 60, 62, 65].concat(range(101, 125));

    // ===== W20 c1 迁入（c1 已退役，其契约在新结构下的等价物）=====
    // 它锁的是：①每个条目（含伴生）第二行 #id 文本 === "#" + data-id；②viewer 没有 .model-row-actions / data-act / data-menu 且操作列头隐藏（节点保留）、空态文案；
    //   ③ID 排序三态（desc → asc → 清除）的手写序列：主模型按数值序（非字符串序）、伴生紧跟主模型，aria-sort 与图标跟随。
    console.log('W20 c1 迁入');
    {
      const { page } = await open(adminN, 'W20');
      const pairs = await page.$$eval('#modelListBody [data-id]', (els) => els.map((e) => [Number(e.getAttribute('data-id')), (e.querySelector('.catalog-row2 .catalog-id') || { textContent: null }).textContent]));
      check('W20 第二行 #id：第 1 页 21 个条目（手写 PAGE1_21，含伴生 #53）的 .catalog-id 文本都等于 "#" + data-id', J(pairs.map((p) => p[0])) === J(PAGE1_21) && pairs.every((p) => p[1] === '#' + p[0]), pairs.filter((p) => p[1] !== '#' + p[0]));
      await page.fill('#searchKeyword', 'dwd_w0001_w0060_change_di');
      const cp = await page.$$eval('#modelListBody [data-id]', (els) => els.map((e) => [Number(e.getAttribute('data-id')), e.classList.contains('is-companion'), (e.querySelector('.catalog-id') || { textContent: null }).textContent]));
      check('W20 搜伴生表名：#53 在结果里、带 is-companion、第二行显示自己的 #53（伴生行同显自己的 id）；结果只含 #52 / #53', cp.some((r) => r[0] === 53 && r[1] === true && r[2] === '#53') && cp.every((r) => r[0] === 52 || r[0] === 53), cp);
      await page.fill('#searchKeyword', 'zzz_no_such_model_xyz');
      check('W20 admin 空态：.catalog-empty 文案「暂无模型数据」、没有任何 [data-id] 条目（旧：colspan=11 的空行）', (await page.$$eval('#modelListBody .catalog-empty', (e) => e.map((x) => x.textContent))).join() === '暂无模型数据' && (await domIds(page)).length === 0);
      await page.fill('#searchKeyword', '');
      check('W20 admin：操作列头 #modelListOpHeader 可见且文本含「操作」', await page.$eval('#modelListOpHeader', (e) => getComputedStyle(e).display !== 'none' && /操作/.test(e.textContent)));
      const st = () => page.evaluate(() => { const b = document.querySelector('button[data-sort-by="id"]'); return { icon: b.querySelector('.sort-icon').textContent, aria: b.getAttribute('aria-sort'), by: currentSortBy, dir: currentSortDir }; });
      await page.locator('button[data-sort-by="id"]').click();
      let v = await view(page); let s = await st();
      check('W20 ID 首击 desc：全量序列 = 手写 DESC_ALL（主模型数值降序 125…101,65,…,6，#53 紧跟 #52），第 1 页 DOM = 前 20 个（125…106），图标 ↓、aria-sort=descending', J(v.orderedIds) === J(DESC_ALL) && J(await domIds(page)) === J(DESC_ALL.slice(0, 20)) && s.icon === '↓' && s.aria === 'descending' && s.by === 'id' && s.dir === 'desc', { ids: v.orderedIds, s });
      await page.evaluate(() => goToPage(2));
      check('W20 ID desc 第 2 页 DOM = 手写 [105…101,65,62,60,59,58,55,52,53,50,8,6]（含伴生 #53 紧跟 #52）', J(await domIds(page)) === J(DESC_ALL.slice(20)), await domIds(page));
      await page.locator('button[data-sort-by="id"]').click();
      v = await view(page); s = await st();
      check('W20 ID 二击 asc：全量序列 = 手写 ASC_ALL（严格数值升序 6,8,50,52,53,55,…；非字符串序），回第 1 页，DOM = 前 21 行（含 #52 #53），图标 ↑、aria-sort=ascending', J(v.orderedIds) === J(ASC_ALL) && v.page === 1 && J(await domIds(page)) === J(ASC_ALL.slice(0, 21)) && s.icon === '↑' && s.aria === 'ascending' && s.dir === 'asc', { ids: v.orderedIds, s });
      await page.locator('button[data-sort-by="id"]').click();
      v = await view(page); s = await st();
      check('W20 ID 三击清排序：恢复默认序（手写 ALL36）、DOM = PAGE1_21，图标 ⇅、aria-sort 去掉、currentSortBy 为 null', J(v.orderedIds) === J(ALL36) && J(await domIds(page)) === J(PAGE1_21) && s.icon === '⇅' && s.aria === null && s.by === null, { s });
      await page.close();
      const vctx = await mkCtx(USERS[1]);
      const { page: vp } = await open(vctx, 'W20v');
      const vcnt = await vp.evaluate(() => ({ actions: document.querySelectorAll('#modelListBody .model-row-actions').length, acts: document.querySelectorAll('#modelListBody [data-act]').length, menus: document.querySelectorAll('#modelListBody [data-menu]').length, roleMenus: document.querySelectorAll('#modelListBody [role="menu"]').length, op: getComputedStyle(document.getElementById('modelListOpHeader')).display, opIn: !!document.getElementById('modelListOpHeader') }));
      check('W20 viewer：列表里没有 .model-row-actions / data-act / data-menu / role=menu（含伴生 #53 所在的第 1 页）；操作列头节点保留但 display:none', J(await domIds(vp)) === J(PAGE1_21) && vcnt.actions === 0 && vcnt.acts === 0 && vcnt.menus === 0 && vcnt.roleMenus === 0 && vcnt.op === 'none' && vcnt.opIn, vcnt);
      const vpairs = await vp.$$eval('#modelListBody [data-id]', (els) => els.every((e) => (e.querySelector('.catalog-id') || { textContent: '' }).textContent === '#' + e.getAttribute('data-id')));
      check('W20 viewer：第二行 #id 同样可见（含伴生）', vpairs);
      await vp.locator('button[data-sort-by="id"]').click();
      check('W20 viewer：ID 排序可用（desc 全量序列 = DESC_ALL）', J((await view(vp)).orderedIds) === J(DESC_ALL));
      await vp.fill('#searchKeyword', 'zzz_no_such_model_xyz');
      check('W20 viewer 空态：「暂无模型数据」、无条目', (await vp.$$eval('#modelListBody .catalog-empty', (e) => e.map((x) => x.textContent))).join() === '暂无模型数据' && (await domIds(vp)).length === 0);
      await vp.close(); await vctx.close();
    }

    // ===== W21 字段（#50 DIM、#58 custom、#52 core + #53 伴生缩进、#6 ODS、填充 ODS）=====
    // 它锁的是：分层徽章大写 + 分层 class；表名按钮的文字 / title / data-model-id；中文短名；标签「核心」「自定义脚本」「伴生」的有无与次序；状态徽章文案与 class（五态 + 未知状态原样显示）；
    //   负责人空值显示「-」；实现说明首句（。 ； 截断）与占位「（未填写实现说明）」；rel 对象 / null；伴生条目缩进大于主条目。
    console.log('W21 字段');
    {
      const patches = {
        50: { impl_note: '先说结论。再说细节；还有补充', rel: { obj: 1, up: 2, down: 3 } },
        52: { impl_note: '主表实现；伴生另写', rel: { obj: 0, up: 12, down: 1 } },
        53: { impl_note: '   ', rel: null },
        58: { impl_note: null, tech_owner: '', rel: { obj: 0, up: 0, down: 0 } },
        60: { status: 'REVIEWING' }, 62: { status: 'OFFLINE' }, 65: { status: 'ONLINE' }, 55: { status: 'WEIRD' },
      };
      const { page } = await open(adminN, 'W21', '', { beforeGoto: rewriteList(patchRows(patches)) });
      check('W21 前置：业务域映射已到达（#52 显示「域甲」）', await waitDomain(page, 52, '域甲'));
      const e50 = await readEntry(page, 50); const e52 = await readEntry(page, 52); const e53 = await readEntry(page, 53); const e58 = await readEntry(page, 58);
      check('W21 #50 DIM：分层 DIM + catalog-layer-dim；表名 dim_w0007_w0008、title「…（点击查看详情）」、data-model-id=50；短名「字段说明3」；无标签；状态「开发中」+ u-status-badge sem-active；负责人「测试负责人」；第二行 #50；实现说明首句「先说结论」（title=全文）；业务域「未设置」；rel「对象 1 · 上游 2 · 下游 3」',
        e50.layer === 'DIM' && /catalog-layer-dim/.test(e50.layerCls) && e50.name === 'dim_w0007_w0008' && e50.nameTitle === 'dim_w0007_w0008（点击查看详情）' && e50.modelIdAttr === '50' && e50.comment === '字段说明3' && e50.tags.length === 0
        && e50.status === '开发中' && /\bu-status-badge\b/.test(e50.statusCls) && /\bsem-active\b/.test(e50.statusCls) && e50.owner === '测试负责人' && e50.id2 === '#50' && e50.impl === '先说结论' && e50.implTitle === '先说结论。再说细节；还有补充' && !e50.implEmpty && e50.domain === '未设置' && e50.rel === '对象 1 · 上游 2 · 下游 3' && !e50.isCompanion && !e50.hasNotes, e50);
      check('W21 #52 core DWD：分层 DWD + catalog-layer-dwd；标签恰为「核心」；状态「规划中」sem-wait；实现说明首句按「；」截成「主表实现」；业务域映射为「域甲」；rel「对象 0 · 上游 12 · 下游 1」',
        e52.layer === 'DWD' && /catalog-layer-dwd/.test(e52.layerCls) && J(e52.tags) === J(['核心']) && e52.status === '规划中' && /\bsem-wait\b/.test(e52.statusCls) && e52.impl === '主表实现' && e52.domain === '域甲' && e52.rel === '对象 0 · 上游 12 · 下游 1' && !e52.isCompanion, e52);
      check('W21 #53 伴生：is-companion；标签恰为「核心」「伴生」（次序）；表名 title 带「 [变更追踪伴生表]」；实现说明全空白 → 占位「（未填写实现说明）」且带 catalog-impl-empty、无 title；rel 为 null → 显示「—」；第二行 #53；业务域「域甲」；缩进大于主条目 #52',
        e53.isCompanion && J(e53.tags) === J(['核心', '伴生']) && e53.nameTitle === 'dwd_w0001_w0060_change_di [变更追踪伴生表]（点击查看详情）' && e53.impl === '（未填写实现说明）' && e53.implEmpty && e53.implTitle === null && e53.rel === '—' && e53.id2 === '#53' && e53.domain === '域甲' && e53.padLeft > e52.padLeft && e53.comment === '字段说明1 - 字段说明235', { e53, e52pad: e52.padLeft });
      check('W21 #58 custom：标签恰为「自定义脚本」；表名 title 带「 [手工模式]」；有设计说明按钮；负责人为空 → 「-」；实现说明为 null → 占位；rel 全 0 → 「对象 0 · 上游 0 · 下游 0」',
        J(e58.tags) === J(['自定义脚本']) && e58.nameTitle === 'dim_w0153 [手工模式]（点击查看详情）' && e58.hasNotes && e58.owner === '-' && e58.impl === '（未填写实现说明）' && e58.implEmpty && e58.rel === '对象 0 · 上游 0 · 下游 0', e58);
      const s60 = await readEntry(page, 60); const s62 = await readEntry(page, 62); const s65 = await readEntry(page, 65); const s55 = await readEntry(page, 55);
      check('W21 状态徽章五态：REVIEWING「待验收」sem-review、OFFLINE「已下线」sem-archived、ONLINE「已上线」sem-done；未知状态 WEIRD 原样显示、只有 u-status-badge 一个 class',
        s60.status === '待验收' && /\bsem-review\b/.test(s60.statusCls) && s62.status === '已下线' && /\bsem-archived\b/.test(s62.statusCls) && s65.status === '已上线' && /\bsem-done\b/.test(s65.statusCls) && s55.status === 'WEIRD' && s55.statusCls.trim() === 'u-status-badge', { s60: s60.statusCls, s62: s62.statusCls, s65: s65.statusCls, s55: s55.statusCls });
      await page.evaluate(() => goToPage(2));
      const e6 = await readEntry(page, 6);
      check('W21 #6 ODS（第 2 页）：分层 ODS + catalog-layer-ods；状态「已上线」sem-done；业务域「域甲」；无标签；短名「字段说明1」',
        e6.layer === 'ODS' && /catalog-layer-ods/.test(e6.layerCls) && e6.status === '已上线' && /\bsem-done\b/.test(e6.statusCls) && e6.domain === '域甲' && e6.tags.length === 0 && e6.comment === '字段说明1', e6);
      await page.close();
    }

    // ===== W22 业务域映射（GET /api/domains 只返回启用域；停用域显示代码 = 已知行为 P31）=====
    // 它锁的是：映射到达后显示名称（含伴生）；未知代码原样显示；空值 / 纯空白显示「未设置」；停用域（库里真有一条 deprecated 的 dom_old，服务端不返回）显示代码而不是停用域名称；
    //   映射请求失败（连接失败）时显示代码、页面照常、不抛 pageerror，页面代码自己不记 console.error；映射晚于用户打开菜单到达时只就地改文字（条目节点不换、菜单不被关）。
    console.log('W22 业务域映射');
    {
      const patches = { 50: { domain: null }, 60: { domain: '' }, 62: { domain: '   ' }, 59: { domain: 'zzz_unknown' }, 55: { domain: 'dom_old' }, 65: { domain: 'dom_b' } };
      const { page } = await open(adminN, 'W22', '', { beforeGoto: rewriteList(patchRows(patches)) });
      check('W22 前置：#52 显示「域甲」（映射到达）', await waitDomain(page, 52, '域甲'));
      const got = {}; for (const id of [52, 53, 65, 55, 59, 50, 60, 62]) got[id] = await domainText(page, id);
      check('W22 域名显示：#52 / 伴生 #53 =「域甲」、#65（dom_b）=「域乙」、未知代码 zzz_unknown 原样、null / 空串 / 纯空白 =「未设置」', J(got) === J({ 52: '域甲', 53: '域甲', 65: '域乙', 55: got[55], 59: 'zzz_unknown', 50: '未设置', 60: '未设置', 62: '未设置' }), got);
      const dom = await pageEvalBounded(page, async () => (await (await authFetch('/api/domains')).json()).map((d) => d.code).sort());
      check('W22 前提（P31）：服务端 /api/domains 只返回启用域（dom_a / dom_b / dom_c），不含库里的停用域 dom_old', J(dom) === J(['dom_a', 'dom_b', 'dom_c']), dom);
      check('W22 停用域 dom_old（库里 status=deprecated，名称「停用域」）显示代码「dom_old」，不显示停用域名称', got[55] === 'dom_old', got[55]);
      await page.close();
    }
    {
      expectErr('W22b', U_DOMAINS);   // 连接失败：浏览器自己会记一条 "Failed to load resource: net::ERR_FAILED"（abort 与 fulfill 5xx 都会，实测）；下面单独断言它是唯一的 console.error
      const msgs = [];
      const { page } = await open(adminN, 'W22b', '', { beforeGoto: async (pg) => { pg.on('console', (m) => msgs.push([m.type(), m.text()])); pg.on('pageerror', (e) => msgs.push(['pageerror', String(e)])); await pg.route(isDomains, (route) => route.abort('failed')); } });
      const t52 = await domainText(page, 52); const t53 = await domainText(page, 53); const t50 = await domainText(page, 50);
      const errsOf = msgs.filter((m) => m[0] === 'error' || m[0] === 'pageerror');
      check('W22b 映射请求连接失败：#52 / 伴生 #53 显示代码「dom_a」，空值仍「未设置」，列表照常渲染（21 行）', t52 === 'dom_a' && t53 === 'dom_a' && t50 === '未设置' && (await domIds(page)).length === 21, { t52, t53, t50 });
      check('W22b 失败时页面代码不产生 pageerror / console.error：唯一的 error 是浏览器自己记的「Failed to load resource: net::ERR_FAILED」（不是页面代码）；页面代码只 console.warn', errsOf.length === 1 && errsOf[0][0] === 'error' && /^Failed to load resource: net::ERR_FAILED$/.test(errsOf[0][1]) && msgs.some((m) => m[0] === 'warning' && /业务域映射加载失败/.test(m[1])), errsOf);
      await page.close();
    }
    {
      // 映射晚到：先把 /api/domains 扣住，打开 #50 的 ⋯ 菜单，再放行
      const g = gate();
      const { page } = await open(adminN, 'W22c', '', { noIdle: true, beforeGoto: async (pg) => { await pg.route(isDomains, async (route) => { await g.p; await route.continue(); }); } });
      await page.waitForFunction(() => document.querySelectorAll('#modelListBody [data-id]').length === 21, null, { timeout: WAIT });
      check('W22c 映射未到时：#52 / 伴生 #53 显示代码「dom_a」', (await domainText(page, 52)) === 'dom_a' && (await domainText(page, 53)) === 'dom_a');
      await clickC(page, '[data-id="50"] [data-menu="more"]');
      await page.evaluate(() => { window.__e50 = document.querySelector('#modelListBody [data-id="50"]'); window.__e53 = document.querySelector('#modelListBody [data-id="53"]'); });
      check('W22c 前置：#50 的 ⋯ 菜单已打开', (await onlyOpen(page, ['catalog-menu-more-50'])) === true);
      g.release();
      check('W22c 映射到达：#52 / 伴生 #53 就地改成「域甲」', (await waitDomain(page, 52, '域甲')) && (await waitDomain(page, 53, '域甲')));
      const after = await page.evaluate(() => ({ same50: document.querySelector('#modelListBody [data-id="50"]') === window.__e50, same53: document.querySelector('#modelListBody [data-id="53"]') === window.__e53 }));
      check('W22c 映射晚到只改文字、不重渲染：#50 / #53 条目仍是同一个 DOM 节点，且用户刚打开的 #50 菜单没被关（aria-expanded 与可见性一致）', after.same50 && after.same53 && (await onlyOpen(page, ['catalog-menu-more-50'])) === true, after);
      await page.close();
    }

    // ===== W23 最近验收（七态 + null + 未知态）=====
    // 它锁的是：acceptanceView 的文本 / MM-DD / 「需复验」徽章 / unknown 的 title 逐态显示；文本里的符号只出现一次（页面不再拼 mark，L1）；kind 对应的 class；未知态不让整页渲染中断；伴生行恒「随主模型」无日期。
    console.log('W23 最近验收七态');
    {
      const acc = (state, at, extra) => Object.assign({ state, at, rows: 1, stages: { structure: 'pass', data: 'pass' }, prevResult: null }, extra || {});
      const patches = {
        60: { acceptance: acc('pass', '2026-03-04 10:00:00') },
        50: { acceptance: acc('warn', '2026-03-05 10:00:00') },
        55: { acceptance: acc('fail', '2026-03-06 10:00:00') },
        58: { acceptance: acc('partial', '2026-03-07 10:00:00', { stages: { structure: 'pass', data: null } }) },
        62: { acceptance: acc('partial', '2026-03-08 10:00:00', { stages: { structure: null, data: 'pass' } }) },
        65: { acceptance: acc('stale', '2026-03-09 10:00:00', { prevResult: 'pass' }) },
        52: { acceptance: acc('stale', '2026-03-10 10:00:00', { prevResult: 'warn' }) },
        59: { acceptance: acc('stale', '2026-03-11 10:00:00', { prevResult: null }) },
        101: { acceptance: { state: 'none', at: null, rows: null, stages: null, prevResult: null } },
        102: { acceptance: null },
        103: { acceptance: { state: 'bogus', at: null } },
      };
      const msgs = [];
      const { page } = await open(adminN, 'W23', '', { beforeGoto: async (pg) => { pg.on('console', (m) => msgs.push([m.type(), m.text()])); await rewriteList(patchRows(patches))(pg); } });
      const A = {}; for (const id of [60, 50, 55, 58, 62, 65, 52, 59, 101, 53, 102, 103]) A[id] = await readAcc(page, id);
      const once = (a, mark) => a.cell.split(mark).length - 1 === 1;
      check('W23 pass：「✓ 通过」+ 日期 03-04、kind=pass、符号 ✓ 只出现一次、无「需复验」', A[60].text === '✓ 通过' && A[60].date === '03-04' && /catalog-acc-pass/.test(A[60].kindCls) && once(A[60], '✓') && A[60].recheck === '', A[60]);
      check('W23 warn：「! 有警告」03-05、符号 ! 只出现一次', A[50].text === '! 有警告' && A[50].date === '03-05' && /catalog-acc-warn/.test(A[50].kindCls) && once(A[50], '!'), A[50]);
      check('W23 fail：「✕ 未通过」03-06、符号 ✕ 只出现一次', A[55].text === '✕ 未通过' && A[55].date === '03-06' && /catalog-acc-fail/.test(A[55].kindCls) && once(A[55], '✕'), A[55]);
      check('W23 partial：阶段结构有数据无 →「◐ 缺数据验收」03-07；结构无数据有 →「◐ 缺结构验收」03-08；符号 ◐ 各只出现一次', A[58].text === '◐ 缺数据验收' && A[58].date === '03-07' && A[62].text === '◐ 缺结构验收' && A[62].date === '03-08' && /catalog-acc-partial/.test(A[58].kindCls) && once(A[58], '◐') && once(A[62], '◐'), { a58: A[58], a62: A[62] });
      check('W23 stale：前结果 pass →「✓」03-09 + 「需复验」；warn →「!」03-10 + 「需复验」；无前结果 →「—」03-11 + 「需复验」；符号各只出现一次（文本就是符号本身，不再前缀一个）',
        A[65].text === '✓' && A[65].date === '03-09' && A[65].recheck === '需复验' && once(A[65], '✓') && A[52].text === '!' && A[52].date === '03-10' && A[52].recheck === '需复验' && once(A[52], '!') && A[59].text === '—' && A[59].date === '03-11' && A[59].recheck === '需复验' && once(A[59], '—') && /catalog-acc-stale/.test(A[65].kindCls), { a65: A[65], a52: A[52], a59: A[59] });
      check('W23 none →「无验收」无日期；伴生 #53（服务端真实 companion 态）→「随主模型」无日期无「需复验」', A[101].text === '无验收' && A[101].date === '' && /catalog-acc-none/.test(A[101].kindCls) && A[53].text === '随主模型' && A[53].date === '' && A[53].recheck === '' && /catalog-acc-companion/.test(A[53].kindCls), { a101: A[101], a53: A[53] });
      check('W23 unknown（acceptance 为 null）→「—」、格子 title「验收摘要加载失败」、kind=unknown', A[102].text === '—' && A[102].title === '验收摘要加载失败' && /catalog-acc-unknown/.test(A[102].kindCls) && once(A[102], '—'), A[102]);
      check('W23 未知 state（bogus）：该行显示「—」+ title「验收摘要无法识别」，其余行照常渲染（21 行），页面代码只 console.warn、没有 console.error / pageerror', A[103].text === '—' && A[103].title === '验收摘要无法识别' && (await domIds(page)).length === 21 && !msgs.some((m) => m[0] === 'error') && msgs.some((m) => m[0] === 'warning' && /验收摘要无法识别（模型 103）/.test(m[1])), { a103: A[103], errs: msgs.filter((m) => m[0] === 'error') });
      await page.close();
    }

    // ===== W24 菜单关闭契约 + 分发 =====
    // 它锁的是（契约 9 / 9a / 14）：再点 ⋯ 收起；点另一个触发按钮互斥（含伴生 #53 的 ⋯、验收阶段菜单）；点置灰项保持打开且零调用（真实点击 disabled 浏览器不派发；aria-disabled 与 disabled 各自单独被委托检查）；
    //   点外部（body / 标题 / 另一个条目）关闭；Esc 关闭并聚焦触发按钮，且抽屉打开时第一次 Esc 只关菜单、第二次才关抽屉；重渲染关闭全部；aria-expanded 始终与可见性一致；
    //   可用项点击 → 关闭菜单、处理函数恰调用 1 次且经全局名取（替身在两次点击之间被换掉，第二次必须落到新替身）；删除只传 1 个参数。
    console.log('W24 菜单契约与分发');
    {
      const { page } = await open(adminN, 'W24');
      await stubHandlers(page);
      check('W24 初始：所有菜单关闭、aria-expanded 全为 false', (await onlyOpen(page, [])) === true);
      await clickC(page, '[data-id="50"] [data-menu="more"]');
      check('W24 点 #50 的 ⋯：菜单打开（可见）、aria-expanded=true', (await onlyOpen(page, ['catalog-menu-more-50'])) === true && await page.locator('#catalog-menu-more-50').isVisible());
      await page.locator('[data-id="50"] [data-menu="more"]').click();
      check('W24 再点同一个 ⋯：收起（菜单不可见、aria-expanded=false）', (await onlyOpen(page, [])) === true && !(await page.locator('#catalog-menu-more-50').isVisible()));
      // 菜单是绝对定位的覆盖层，向下展开 ~190px，会盖住其下方 1–3 个条目的触发按钮（点到的是别人菜单里的项）；所以互斥用例从下往上点：伴生 #53（第 8 个）→ #65（第 6 个）→ #50（第 2 个）→ #60 的验收菜单（第 1 个）
      await clickC(page, '[data-id="53"] [data-menu="more"]');
      check('W24 互斥起点：伴生 #53 的 ⋯ 菜单打开（只有它）', (await onlyOpen(page, ['catalog-menu-more-53'])) === true);
      await clickC(page, '[data-id="65"] [data-menu="more"]');
      check('W24 互斥（伴生先开）：开着伴生 #53 的 ⋯ 再点 #65 的 ⋯ → 只有 #65 的菜单开着', (await onlyOpen(page, ['catalog-menu-more-65'])) === true);
      await clickC(page, '[data-id="50"] [data-menu="more"]');
      check('W24 互斥：再点 #50 的 ⋯ → 只有 #50 的开着', (await onlyOpen(page, ['catalog-menu-more-50'])) === true);
      await clickC(page, '[data-id="60"] [data-menu="validate"]');
      check('W24 互斥（验收阶段菜单）：点 #60 的「验收 ▾」→ 只有验收菜单开着（⋯ 菜单被关）', (await onlyOpen(page, ['catalog-menu-validate-60'])) === true);
      // 置灰项：#53 的 ETL（伴生，disabled + aria-disabled）
      await clickC(page, '[data-id="53"] [data-menu="more"]');
      await page.locator('#catalog-menu-more-53 [data-act="etl"]').click({ force: true });
      check('W24 点置灰项（伴生 #53 的 ETL，真实点击）：零调用、菜单保持打开', (await callsOf(page)).length === 0 && (await onlyOpen(page, ['catalog-menu-more-53'])) === true);
      // 只剩 aria-disabled（去掉 disabled 属性）：委托必须仍识别 aria-disabled="true"
      await page.evaluate(() => { const b = document.querySelector('#catalog-menu-more-53 [data-act="etl"]'); b.removeAttribute('disabled'); });
      await page.locator('#catalog-menu-more-53 [data-act="etl"]').click({ force: true });   // Playwright 把 aria-disabled=true 当作不可点，需 force（此时按钮本身已无 disabled 属性，浏览器会派发 click）
      check('W24 只有 aria-disabled="true"（无 disabled 属性）的项被点：零调用、菜单保持打开（委托检查 aria-disabled）', (await callsOf(page)).length === 0 && (await onlyOpen(page, ['catalog-menu-more-53'])) === true, await callsOf(page));
      // 只剩 disabled（去掉 aria-disabled）：真实点击浏览器不派发，用脚本派发的 click 事件验证委托自己也检查 disabled
      await page.evaluate(() => { const b = document.querySelector('#catalog-menu-more-53 [data-act="ddl"]'); b.removeAttribute('aria-disabled'); b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      check('W24 只有 disabled 属性（无 aria-disabled）的项收到脚本派发的 click：零调用、菜单保持打开（委托检查 disabled）', (await callsOf(page)).length === 0 && (await onlyOpen(page, ['catalog-menu-more-53'])) === true, await callsOf(page));
      // 可用项：伴生「配置（只读）」→ openDwdConfigViewModal(53) 恰 1 次、菜单关闭
      await page.locator('#catalog-menu-more-53 [data-act="view-config"]').click();
      let c = await callsOf(page);
      check('W24 可用项（伴生 #53「配置（只读）」）：openDwdConfigViewModal(53) 恰 1 次（1 个参数）、菜单关闭', c.length === 1 && c[0].fn === 'openDwdConfigViewModal' && c[0].n === 1 && c[0].args[0] === 53 && (await onlyOpen(page, [])) === true, c);
      // 删除只传 1 个参数（force 会跳过确认直接强删）
      await page.evaluate(() => { window.__calls = []; });
      await clickC(page, '[data-id="50"] [data-menu="more"]');
      await page.locator('#catalog-menu-more-50 [data-act="delete"]').click();
      c = await callsOf(page);
      check('W24 删除项：deleteModel 恰 1 次且只传 1 个参数（id=50；多传第二个参数 true 会跳过确认强删）', c.length === 1 && c[0].fn === 'deleteModel' && c[0].n === 1 && c[0].args[0] === 50, c);
      // 经全局名取：同一个项连点两次，中间换替身，第二次必须落到新替身
      await page.evaluate(() => { window.__calls = []; });
      await clickC(page, '[data-id="50"] [data-menu="more"]');
      await page.locator('#catalog-menu-more-50 [data-act="history"]').click();
      await page.evaluate(() => { window.viewModelChangeLogs = function () { window.__calls.push({ fn: 'viewModelChangeLogs#2', n: arguments.length, args: Array.prototype.slice.call(arguments) }); }; });
      await clickC(page, '[data-id="50"] [data-menu="more"]');
      await page.locator('#catalog-menu-more-50 [data-act="history"]').click();
      c = await callsOf(page);
      check('W24 处理函数经全局名取（不缓存）：同一个「变更历史」项点两次，中间把 window.viewModelChangeLogs 换成新替身 → 调用依次落到旧、新替身', c.length === 2 && c[0].fn === 'viewModelChangeLogs' && c[1].fn === 'viewModelChangeLogs#2' && c[0].args[0] === 50 && c[1].args[0] === 50, c);
      // 点外部
      for (const [label, act] of [
        ['点 body（脚本 click）', () => page.evaluate(() => document.body.click())],
        ['点列表外的真实元素（页头标题 h1；列表区原来的小标题已删）', () => page.locator('.catalog-pagehead h1').click()],
      ]) {
        await clickC(page, '[data-id="52"] [data-menu="more"]');
        const was = (await onlyOpen(page, ['catalog-menu-more-52'])) === true;
        await act();
        check('W24 点外部关闭：' + label, was && (await onlyOpen(page, [])) === true);
      }
      await clickC(page, '[data-id="52"] [data-menu="more"]');
      const wasOpen3 = (await onlyOpen(page, ['catalog-menu-more-52'])) === true;   // 2e：前提——点之前 #52 的菜单确实是唯一开着的（否则「点完是关着的」恒真）
      await page.locator('[data-id="55"] .catalog-row2').click();   // 另一个条目的非交互区：关菜单，同时按 C7 打开 #55 的抽屉
      const outsideOk = wasOpen3 && (await onlyOpen(page, [])) === true;
      await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT });
      check('W24 点外部关闭：点另一个条目（#55 的第二行）→ 菜单关闭（该点击同时按 C7 打开 #55 的抽屉，已 Esc 关掉）', outsideOk);
      // Esc：焦点在菜单项上 / 在触发按钮上
      await clickC(page, '[data-id="50"] [data-menu="more"]');
      await page.locator('#catalog-menu-more-50 [data-act="etl"]').focus();
      await page.keyboard.press('Escape');
      let esc = await page.evaluate(() => ({ trigger: document.activeElement === document.querySelector('#modelListBody [data-id="50"] [data-menu="more"]') }));
      check('W24 Esc（焦点在菜单项上）：菜单关闭、焦点回到 #50 的 ⋯ 触发按钮', (await onlyOpen(page, [])) === true && esc.trigger, esc);
      await clickC(page, '[data-id="53"] [data-menu="more"]');
      await page.keyboard.press('Escape');
      esc = await page.evaluate(() => ({ trigger: document.activeElement === document.querySelector('#modelListBody [data-id="53"] [data-menu="more"]') }));
      check('W24 Esc（焦点在触发按钮上，伴生 #53）：菜单关闭、焦点仍在触发按钮', (await onlyOpen(page, [])) === true && esc.trigger, esc);
      // 抽屉打开时的 Esc：第一次只关菜单，第二次才关抽屉
      await page.evaluate(() => openModelDrawer(50, document.querySelector('#modelListBody [data-id="50"] .model-open-btn')));
      await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
      await page.evaluate(() => document.querySelector('#modelListBody [data-id="52"] [data-menu="more"]').click());
      const preOpen = (await onlyOpen(page, ['catalog-menu-more-52'])) === true;
      await page.keyboard.press('Escape');
      const afterEsc1 = await page.evaluate(() => ({ drawer: document.getElementById('modelDetailDrawer').classList.contains('open') }));
      const menuClosed = (await onlyOpen(page, [])) === true;
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT });
      check('W24 抽屉打开 + 菜单打开：第一次 Esc 只关菜单（capture 阶段 stopPropagation，抽屉不同时关），第二次 Esc 才关抽屉', preOpen && menuClosed && afterEsc1.drawer === true, { preOpen, menuClosed, afterEsc1 });
      // 重渲染关闭全部
      await clickC(page, '[data-id="50"] [data-menu="more"]');
      await page.evaluate(() => renderModelsPage());
      check('W24 重渲染（renderModelsPage）关闭全部菜单，data-catalog-state 仍为 ready', (await onlyOpen(page, [])) === true && (await page.getAttribute('#modelListBody', 'data-catalog-state')) === 'ready');
      await page.close();
    }

    // ===== W25 P-U1 / D-18 / D-19 文案在 admin / owner / nonowner 下的切换 =====
    // 它锁的是：伴生行删除一律置灰且原因是 P-U1 文案（压过权限文案）；伴生「编辑信息」按编辑权限（owner 可用、nonowner「无编辑权限」）；ODS 的「编辑配置」对所有非 viewer 置灰「ODS 无平台配置，请用编辑信息」；
    //   无编辑权限的 DIM / DWD 显示「配置（只读）」（D-19）；无验收权限时验收按钮置灰「无验收权限」；置灰项的 aria-disabled / title / 可见原因文字三者一致。
    console.log('W25 三种身份下的文案');
    {
      const ownerCompanion = patchRows({ 53: { tech_owner: '测试负责人' } });   // 让伴生行的负责人是 owner_user / 不是 nonowner（伴生行编辑权限看它自己的负责人）
      const ADMIN_50 = [it('etl', true), it('ddl', true), it('edit-config', true), it('edit-info', true), it('history', true, T_HIST), it('delete', true)];
      const ADMIN_52 = ADMIN_50;
      const COMP_OPEN = [it('etl', false, R_COMP_ETL), it('ddl', false, R_COMP_DDL), it('view-config', true, T_VIEW_COMP), it('edit-info', true), it('history', true, T_HIST), it('delete', false, R_COMP_DEL)];
      const COMP_NOEDIT = [it('etl', false, R_COMP_ETL), it('ddl', false, R_COMP_DDL), it('view-config', true, T_VIEW_COMP), it('edit-info', false, '无编辑权限'), it('history', true, T_HIST), it('delete', false, R_COMP_DEL)];
      const ODS_EDIT = [it('etl', false, R_ODS_ETL), it('ddl', true), it('edit-config', false, R_ODS_CFG), it('edit-info', true), it('history', true, T_HIST), it('delete', true)];
      const ODS_NOEDIT = [it('etl', false, R_ODS_ETL), it('ddl', true), it('edit-config', false, R_ODS_CFG), it('edit-info', false, '无编辑权限'), it('history', true, T_HIST), it('delete', false, '无删除权限')];
      const RO_DIM = [it('etl', true), it('ddl', true), it('view-config', true, T_VIEW_DIM), it('history', true, T_HIST), it('delete', false, '无删除权限')];
      const RO_DWD = [it('etl', true), it('ddl', true), it('view-config', true, T_VIEW_DWD), it('history', true, T_HIST), it('delete', false, '无删除权限')];
      const NOVAL = '无验收权限';
      const ctxs = [[adminN, USERS[0], 'admin'], [await mkCtx(USERS[2]), USERS[2], 'owner'], [await mkCtx(USERS[3]), USERS[3], 'nonowner']];
      const expectations = {
        admin: { 50: ['menu', '', V3, ADMIN_50], 52: ['menu', '', V2, ADMIN_52], 53: ['disabled', '伴生表无需独立验收', [], COMP_OPEN], 101: ['direct', '', [], ODS_EDIT] },
        owner: { 50: ['menu', '', V3, ADMIN_50], 55: ['disabled', NOVAL, [], RO_DIM], 52: ['menu', '', V2, ADMIN_52], 53: ['disabled', '伴生表无需独立验收', [], COMP_OPEN], 101: ['disabled', NOVAL, [], ODS_NOEDIT] },
        nonowner: { 50: ['disabled', NOVAL, [], RO_DIM], 52: ['disabled', NOVAL, [], RO_DWD], 53: ['disabled', '伴生表无需独立验收', [], COMP_NOEDIT], 101: ['disabled', NOVAL, [], ODS_NOEDIT] },
      };
      for (const [ctx, user, who] of ctxs) {
        const { page } = await open(ctx, 'W25-' + who, '', { beforeGoto: who === 'admin' ? undefined : rewriteList(ownerCompanion) });
        for (const [idStr, [vKind, vTitle, vItems, more]] of Object.entries(expectations[who])) {
          const id = Number(idStr); const m = await readMenus(page, id);
          check(`W25 ${who} #${id}：验收入口 ${vKind}${vTitle ? '（title「' + vTitle + '」）' : ''}；⋯ 菜单项 [${more.map((x) => x[1] + (x[2] ? '' : '×')).join(' / ')}]（× = 置灰；title / aria-disabled / 可见原因逐项核对）`,
            m.vKind === vKind && m.vTitle === vTitle && itemsOk(m.vItems, vItems) && itemsOk(m.more, more), m);
        }
        await page.close();
        if (ctx !== adminN) await ctx.close();
      }
    }

    // ===== W26 落单伴生组头 + 组结构 =====
    // 它锁的是：伴生的主模型不在列表里时，该组头写「主模型不在列表中」（D-15），组包装只带 data-group（不带 data-id）、条目不嵌套、后代不再带 data-id；
    //   正常伴生组（#60 + 注入的伴生 #9002）没有组头；伴生条目与主条目是兄弟（同一个 [data-group] 的直接子元素）。
    console.log('W26 落单伴生组头');
    {
      const inject = chain(patchRows({ 53: { companion_of: 9999 } }), addRows((rows) => [Object.assign({}, rows.find((r) => r.id === 59), { id: 9002, table_name: 'dwd_w0155_test_change_di', companion_of: 60, config_mode: 'companion' })]));
      const { page } = await open(adminN, 'W26', '', { beforeGoto: rewriteList(inject) });
      const s = await page.evaluate(() => {
        const grp = (id) => document.querySelector(`#modelListBody [data-group="${id}"]`);
        const kids = (g) => Array.from(g.children).map((c) => c.classList.contains('catalog-group-head') ? 'HEAD:' + c.textContent : 'E:' + c.getAttribute('data-id') + (c.classList.contains('is-companion') ? ':C' : ''));
        return {
          g53: kids(grp(53)), g60: kids(grp(60)), g52: kids(grp(52)),
          groupWithDataId: document.querySelectorAll('#modelListBody [data-group][data-id]').length, nested: document.querySelectorAll('#modelListBody [data-id] [data-id]').length,
          heads: Array.from(document.querySelectorAll('#modelListBody .catalog-group-head')).map((e) => e.textContent), dom: Array.from(document.querySelectorAll('#modelListBody [data-id]')).map((e) => Number(e.getAttribute('data-id'))),
        };
      });
      check('W26 落单伴生组（#53 的 companion_of 指向不存在的 9999）：data-group="53" 的子元素依次是组头「主模型不在列表中」、条目 #53（is-companion）', J(s.g53) === J(['HEAD:主模型不在列表中', 'E:53:C']), s.g53);
      check('W26 正常伴生组 [60, 9002]：data-group="60" 的子元素是 #60、#9002（is-companion，兄弟关系），没有组头；#52 现在是没有伴生的单独组', J(s.g60) === J(['E:60', 'E:9002:C']) && J(s.g52) === J(['E:52']), { g60: s.g60, g52: s.g52 });
      check('W26 全页只有一个「主模型不在列表中」组头；[data-group] 上没有 data-id；条目之间不嵌套（[data-id] 里没有 [data-id]）', J(s.heads) === J(['主模型不在列表中']) && s.groupWithDataId === 0 && s.nested === 0, s);
      check('W26 条目文档顺序 = getCatalogView().pageGroups 展平（契约 1a）', J(s.dom) === J((await view(page)).pageGroups.flat()), s.dom);
      await page.close();
    }

    // ===== W27 抽屉：业务负责人 + 「迭代历史 →」显示规则 =====
    // 它锁的是：三个视图（伴生 #53 / 标准 #50 / custom #58）都有「业务负责人」行（取 detail 的 biz_owner，空值「-」）；归档任务数 > 0 才显示可点的「迭代历史 →」（调用 viewIterationHistory(id)），
    //   为 0 或字段缺失（含伴生行）显示灰色「暂无迭代历史」、没有按钮、点灰字不调用 viewIterationHistory（该函数在本用例里已打桩，所以「不弹原生 alert」在这里无法被断言，2e 删掉了那半句）。
    console.log('W27 抽屉');
    {
      const { page } = await open(adminN, 'W27', '', { beforeGoto: async (pg) => {
        await rewriteList(patchRows({ 50: { archived_task_count: 3 }, 58: { archived_task_count: 0 }, 52: { archived_task_count: 2 }, 53: (r) => { const o = Object.assign({}, r); delete o.archived_task_count; return o; } }))(pg);
        await pg.route('**/api/models/50', async (route) => { const resp = await route.fetch(); const j = await resp.json(); await route.fulfill({ response: resp, body: JSON.stringify(Object.assign({}, j, { biz_owner: '甲方负责人' })) }); });
        await pg.route('**/api/models/58', async (route) => { const resp = await route.fetch(); const j = await resp.json(); await route.fulfill({ response: resp, body: JSON.stringify(Object.assign({}, j, { biz_owner: '乙方负责人' })) }); });
      } });
      await page.evaluate(() => { window.__iter = []; window.viewIterationHistory = function (id) { window.__iter.push([id, arguments.length]); }; });
      const drawerOf = async (id) => {
        // B2-6（与 c7 2e M1 同口径）：点击前把副标题与正文清空，再等「副标题含目标 id 且 .foot-links 重新出现」——不会读到上一个抽屉留下的正文
        await page.evaluate(() => { const s = document.getElementById('modelDrawerSub'); if (s) s.textContent = ''; const b = document.getElementById('modelDrawerBody'); while (b && b.firstChild) b.removeChild(b.firstChild); });
        await page.locator(`#modelListBody [data-id="${id}"] .model-open-btn`).click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
        await page.waitForFunction((id) => { const s = document.getElementById('modelDrawerSub'); return !!s && new RegExp('#' + id + '(?!\\d)').test(s.textContent) && !!document.querySelector('#modelDrawerBody .foot-links'); }, id, { timeout: WAIT });
        const r = await page.evaluate(() => {
          const kv = {}; const ks = Array.from(document.querySelectorAll('#modelDrawerBody .kv .k')); ks.forEach((k) => { kv[k.textContent] = k.nextElementSibling ? k.nextElementSibling.textContent : null; });
          const links = Array.from(document.querySelectorAll('#modelDrawerBody .foot-links button')).map((b) => b.textContent);
          const none = document.querySelector('#modelDrawerBody .foot-links .foot-none');
          return { kv, links, none: none ? none.textContent : null, noneTag: none ? none.tagName : null };
        });
        return r;
      };
      const closeDrawer = async () => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT }); };
      const d53 = await drawerOf(53); await closeDrawer();
      check('W27 伴生 #53 抽屉：「业务负责人」=「业务方」（库里值）、「技术负责人」=「管理员」；archived_task_count 字段缺失按 0 → 灰色「暂无迭代历史」、没有「迭代历史 →」按钮', d53.kv['业务负责人'] === '业务方' && d53.kv['技术负责人'] === '管理员' && d53.none === '暂无迭代历史' && d53.noneTag === 'SPAN' && !d53.links.includes('迭代历史 →'), d53);
      const d50 = await drawerOf(50);
      check('W27 标准视图 #50 抽屉：「业务负责人」=「甲方负责人」（路由改写）；archived_task_count=3 → 有可点的「迭代历史 →」、没有灰色提示', d50.kv['业务负责人'] === '甲方负责人' && d50.links.includes('迭代历史 →') && d50.none === null, d50);
      await page.locator('#modelDrawerBody .foot-links button', { hasText: '迭代历史 →' }).click();
      check('W27 点「迭代历史 →」：viewIterationHistory(50) 恰 1 次（1 个参数）', J(await page.evaluate(() => window.__iter)) === J([[50, 1]]), await page.evaluate(() => window.__iter));
      await closeDrawer();
      const d58 = await drawerOf(58);
      check('W27 custom 视图 #58 抽屉：「业务负责人」=「乙方负责人」；archived_task_count=0 → 灰色「暂无迭代历史」、无按钮', d58.kv['业务负责人'] === '乙方负责人' && d58.none === '暂无迭代历史' && !d58.links.includes('迭代历史 →'), d58);
      await page.locator('#modelDrawerBody .foot-links .foot-none').click();
      await closeDrawer();
      const d52 = await drawerOf(52);
      check('W27 标准 DWD #52 抽屉：「业务负责人」空值显示「-」；archived_task_count=2 → 有「迭代历史 →」', d52.kv['业务负责人'] === '-' && d52.links.includes('迭代历史 →'), d52);
      await closeDrawer();
      check('W27 灰色「暂无迭代历史」不可点：点击后没有调用 viewIterationHistory（仍只有 #50 那一次）', J(await page.evaluate(() => window.__iter)) === J([[50, 1]]), await page.evaluate(() => window.__iter));
      await page.close();
    }

    // ===== W28 新排序键 acceptance_at / domain =====
    // 它锁的是：acceptance_at 按 acceptance.at 排序、domain 按业务域「代码」排序（不是显示名：W28d 用路由把名称改写成 dom_a=Z域 / dom_b=A域 / dom_c=M域，码点序与 zh 拼音序下按名称排都是 b,c,a，与代码序 a,b,c 相反；种子里的 域甲 / 域乙 只在码点比较下相反，拼音序下相同，区分不了按显示名 localeCompare 排序的错误实现）；
    //   空值恒排末尾（升降序都是）、并列按输入序、伴生 #53 紧跟主模型 #52；aria-sort 跟随、第三击清排序。
    console.log('W28 新排序键');
    {
      const acc = (at) => ({ acceptance: { state: 'pass', at, rows: 1, stages: { structure: 'pass', data: 'pass' }, prevResult: null } });
      const patches = { 60: acc('2026-03-01 09:00:00'), 58: acc('2026-03-02 09:00:00'), 50: acc('2026-03-03 09:00:00'), 59: acc('2026-03-03 09:00:00'), 52: acc('2026-03-04 09:00:00'), 65: acc('2026-03-05 09:00:00') };
      const { page } = await open(adminN, 'W28', '', { beforeGoto: rewriteList(patchRows(patches)) });
      const AC_DESC = [65, 52, 53, 50, 59, 58, 60, 55, 62].concat(range(101, 125), [6, 8]);
      const AC_ASC = [60, 58, 50, 59, 52, 53, 65, 55, 62].concat(range(101, 125), [6, 8]);
      const aria = (key) => page.getAttribute(`button[data-sort-by="${key}"]`, 'aria-sort');
      await page.locator('button[data-sort-by="acceptance_at"]').click();
      let v = await view(page);
      check('W28 acceptance_at 首击 desc：全量序列 = 手写（03-05:65 → 03-04:52+53 → 03-03:50,59（并列按输入序）→ 03-02:58 → 03-01:60 → 无验收的 55,62,101…125,6,8 排末尾）；DOM = 前 21 行；aria-sort=descending', J(v.orderedIds) === J(AC_DESC) && J(await domIds(page)) === J(AC_DESC.slice(0, 21)) && (await aria('acceptance_at')) === 'descending', v.orderedIds);
      await page.locator('button[data-sort-by="acceptance_at"]').click();
      v = await view(page);
      check('W28 acceptance_at 二击 asc：手写 60,58,50,59,52+53,65，然后同样的空值组排末尾（空值升降序都在最后）；aria-sort=ascending', J(v.orderedIds) === J(AC_ASC) && J(await domIds(page)) === J(AC_ASC.slice(0, 21)) && (await aria('acceptance_at')) === 'ascending', v.orderedIds);
      await page.locator('button[data-sort-by="acceptance_at"]').click();
      v = await view(page);
      check('W28 acceptance_at 三击：清排序回默认序 ALL36，aria-sort 去掉', J(v.orderedIds) === J(ALL36) && (await aria('acceptance_at')) === null, v.orderedIds);
      await page.close();
    }
    {
      const DOM_NAMES = { dom_a: 'Z域', dom_b: 'A域', dom_c: 'M域' };
      const { page } = await open(adminN, 'W28d', '', { beforeGoto: async (pg) => {
        await pg.route(isDomains, async (route) => {
          if (route.request().method() !== 'GET') return route.continue();
          const resp = await route.fetch(); const j = await resp.json();
          await route.fulfill({ response: resp, body: JSON.stringify(j.map((d) => (DOM_NAMES[d.code] ? Object.assign({}, d, { name: DOM_NAMES[d.code] }) : d))) });
        });
      } });
      const DOM_ASC = [52, 53, 6, 55, 60, 50, 58, 62, 65, 59].concat(range(101, 125), [8]);
      const DOM_DESC = [55, 52, 53, 6, 60, 50, 58, 62, 65, 59].concat(range(101, 125), [8]);
      const prem = await pageEvalBounded(page, async () => {
        const ds = await (await authFetch('/api/domains')).json(); const nm = {}; ds.forEach((d) => { nm[d.code] = d.name; });
        const codes = ['dom_a', 'dom_b', 'dom_c'];
        const cmps = { codepoint: (x, y) => (x < y ? -1 : x > y ? 1 : 0), zh: (x, y) => x.localeCompare(y, 'zh-Hans-CN') };
        const out = {}; Object.keys(cmps).forEach((k) => { out[k] = { byCode: codes.slice().sort((p, q) => cmps[k](p, q)), byName: codes.slice().sort((p, q) => cmps[k](nm[p], nm[q])) }; });
        return { nm, out };
      });
      check('W28 前提：路由改写后 dom_a=Z域 / dom_b=A域 / dom_c=M域；按代码排是 a,b,c；按名称排（码点比较与 zh-Hans-CN localeCompare 两种口径）都是 b,c,a，与代码序相反——能区分代码序和名称序',
        J(prem.nm.dom_a) === J('Z域') && J(prem.nm.dom_b) === J('A域') && J(prem.nm.dom_c) === J('M域') && ['codepoint', 'zh'].every((k) => J(prem.out[k].byCode) === J(['dom_a', 'dom_b', 'dom_c']) && J(prem.out[k].byName) === J(['dom_b', 'dom_c', 'dom_a'])), prem);
      check('W28 业务域映射已到达：#55 显示「A域」、#52 显示「Z域」（排序在映射到达后才点，按显示名排序的实现此刻才有名称可用）', (await waitDomain(page, 55, 'A域')) && (await waitDomain(page, 52, 'Z域')), { d55: await domainText(page, 55), d52: await domainText(page, 52) });
      await page.locator('button[data-sort-by="domain"]').click();
      let v = await view(page);
      check('W28 domain 首击 desc（按代码）：dom_b:55 → dom_a:52+53,6（并列按输入序）→ 无业务域（null / 空串）按输入序排末尾；DOM = 前 21 行', J(v.orderedIds) === J(DOM_DESC) && J(await domIds(page)) === J(DOM_DESC.slice(0, 21)) && (await page.getAttribute('button[data-sort-by="domain"]', 'aria-sort')) === 'descending', v.orderedIds);
      await page.locator('button[data-sort-by="domain"]').click();
      v = await view(page);
      check('W28 domain 二击 asc（按代码）：dom_a:52+53,6 → dom_b:55 → 无业务域排末尾（即使 asc 也在最后）', J(v.orderedIds) === J(DOM_ASC) && J(await domIds(page)) === J(DOM_ASC.slice(0, 21)) && (await page.getAttribute('button[data-sort-by="domain"]', 'aria-sort')) === 'ascending', v.orderedIds);
      await page.locator('button[data-sort-by="domain"]').click();
      check('W28 domain 三击：清排序回 ALL36', J((await view(page)).orderedIds) === J(ALL36));
      await page.close();
    }

    // ===== W29 XSS（主模型行与伴生行各一份）=====
    // 它锁的是：table_name / table_comment / impl_note / design_notes / impl_obj_names / domain 里的 '、"、&#39;、<img onerror> 不会变成可执行内容或注入属性：
    //   整页 window.__xss 始终未被赋值、页面里没有 onerror 属性 / img、列表区元素没有 on* / src / href / style 属性（只有白名单属性）、文字与 title 都是字面文本；
    //   含 ' " 的 ODS 行点 DDL 仍正确调用 openDDLModal（行副本的 id / table_name 不被引号截断）；点开设计说明（主模型行与伴生行）气泡里是字面文本、没有 img 节点、__xss 仍未赋值。
    console.log('W29 XSS');
    {
      const XS = `'"&#39;<img src=x onerror="window.__xss=1">`;
      const evil = (tag) => ({ table_name: tag + XS, table_comment: XS + tag, impl_note: XS + tag + '。后半句', design_notes: XS + tag, impl_obj_names: [XS + tag, 'zqobjonly_' + tag.toLowerCase()], domain: XS + tag });
      const odsName = `ods_o'x"y&#39;<b>_df`;
      const { page } = await open(adminN, 'W29', '', { beforeGoto: rewriteList(patchRows({ 50: evil('M'), 53: evil('C'), 101: { table_name: odsName } })) });
      await stubHandlers(page);
      const st = await page.evaluate(() => {
        const ok = new Set(['class', 'title', 'type', 'role', 'id', 'disabled', 'hidden']);
        const okData = new Set(['data-id', 'data-group', 'data-entry', 'data-model-id', 'data-act', 'data-menu', 'data-sort-by', 'data-catalog-state', 'data-focus-highlight', 'data-domain-code', 'data-expand-toggle', 'data-pane-act', 'data-catalog-act', 'data-open-model']);   // C4c-3：随 CAT 的 data 键白名单加入展开区的四个键（展开按钮 / 面板重试 / 全部收起 / 面板模型链接）；其余（on* / src / href / style）仍判红
        const bad = [];
        document.querySelectorAll('#modelListBody, #modelListBody *').forEach((e) => { Array.from(e.attributes).forEach((a) => { if (!(ok.has(a.name) || okData.has(a.name) || a.name.startsWith('aria-'))) bad.push(e.tagName + '@' + a.name); }); });
        return { xss: window.__xss === undefined, onerrorAttr: document.querySelectorAll('[onerror]').length, imgs: document.querySelectorAll('#modelListBody img').length, bad };
      });
      check('W29 载入后：window.__xss 未赋值、全页没有 onerror 属性、列表里没有 img；列表区所有元素只有白名单属性（无 on* / src / href / style）', st.xss && st.onerrorAttr === 0 && st.imgs === 0 && st.bad.length === 0, st);
      const m = await readEntry(page, 50); const c = await readEntry(page, 53);
      check('W29 主模型行 #50 全是字面文本：表名按钮文字 / title、短名、实现说明首句（title=全文）、业务域', m.name === 'M' + XS && m.nameTitle === 'M' + XS + '（点击查看详情）' && m.comment === XS + 'M' && m.impl === XS + 'M' && m.implTitle === XS + 'M。后半句' && m.domain === XS + 'M', m);
      check('W29 伴生行 #53 全是字面文本（同上，且 title 带伴生标注）', c.name === 'C' + XS && c.nameTitle === 'C' + XS + ' [变更追踪伴生表]（点击查看详情）' && c.comment === XS + 'C' && c.impl === XS + 'C' && c.domain === XS + 'C', c);
      // ODS DDL 分发：含引号的表名
      await clickC(page, '[data-id="101"] [data-menu="more"]');
      await page.locator('#catalog-menu-more-101 [data-act="ddl"]').click();
      const cs = await callsOf(page);
      check('W29 含 \' " &#39; 的 ODS 行（#101）点 DDL：openDDLModal 恰 1 次、行副本 id=101、table_name 与改写后逐字相同（不被引号截断）', cs.length === 1 && cs[0].fn === 'openDDLModal' && cs[0].n === 1 && cs[0].args[0].id === 101 && cs[0].args[0].table_name === odsName, cs);
      // 设计说明气泡（主模型 + 伴生）
      for (const [id, tag] of [[50, 'M'], [53, 'C']]) {
        await clickC(page, `[data-id="${id}"] [data-entry="design-notes"]`);
        const p = await page.evaluate(() => { const e = document.getElementById('designNotesPopover'); return e ? { text: e.innerText, imgs: e.querySelectorAll('img').length, xss: window.__xss === undefined } : null; });
        check(`W29 设计说明气泡（${tag === 'M' ? '主模型 #50' : '伴生 #53'}）：气泡里是字面文本（含 <img … onerror=…> 与 &#39; 原样）、没有 img 节点、__xss 仍未赋值`, !!p && p.text.includes(XS + tag) && p.imgs === 0 && p.xss, p);
        await fence(page);   // 等「点别处关闭」监听注册完（setTimeout 0）
        await page.evaluate(() => document.body.click());
        await page.waitForFunction(() => !document.getElementById('designNotesPopover'), null, { timeout: WAIT });
      }
      // B2-5：impl_obj_names 的独有搜索词（只出现在该字段）：按它搜必须命中目标，其他字段一概不含它（否则「搜得到」可能来自别的字段）
      const OBJ_TOK = { M: 'zqobjonly_m', C: 'zqobjonly_c' };
      const own = await page.evaluate((toks) => {
        const out = {};
        Object.keys(toks).forEach((tag) => { const tok = toks[tag]; out[tag] = {
          objRows: allModelsData.filter((r) => Array.isArray(r.impl_obj_names) && r.impl_obj_names.some((n) => String(n).toLowerCase().includes(tok))).map((r) => r.id),
          otherRows: allModelsData.filter((r) => JSON.stringify(Object.assign({}, r, { impl_obj_names: null })).toLowerCase().includes(tok)).map((r) => r.id) }; });
        return out;
      }, OBJ_TOK);
      check('W29 前提：唯一搜索词 zqobjonly_m / zqobjonly_c 分别只出现在 #50 / #53 的 impl_obj_names 里；其他字段（表名 / 描述 / 实现说明 / 设计说明 / 业务域 / 来源 / 验收 …）一概不含', J(own.M.objRows) === J([50]) && J(own.C.objRows) === J([53]) && own.M.otherRows.length === 0 && own.C.otherRows.length === 0, own);
      //   命中口径（P23 same-member：组内同一成员命中，整组保留）：#50 无伴生 → [50]；伴生 #53 自己命中 → 整组 [52, 53]（主模型 #52 不含该词，由前提断言保证，它是陪同显示的）
      for (const [tag, want, who] of [['M', [50], '主模型 #50'], ['C', [52, 53], '伴生 #53 自己命中，整组（#52 陪同）']]) {
        await page.fill('#searchKeyword', OBJ_TOK[tag]);
        const ids = (await view(page)).orderedIds;
        check('W29 按 impl_obj_names 独有搜索词「' + OBJ_TOK[tag] + '」搜：命中恰为 ' + J(want) + '（' + who + '）；渲染后 __xss 仍未赋值', J(ids) === J(want) && (await page.evaluate(() => window.__xss === undefined)), ids);
      }
      // 搜索命中 payload（多个字段）后渲染也不执行
      await page.fill('#searchKeyword', 'onerror');
      const hit = (await view(page)).orderedIds;
      check('W29 搜 onerror 命中带 payload 的 #50 / 伴生 #53（载荷在表名等多个字段里，这条命中不依赖 impl_obj_names）；渲染后 __xss 仍未赋值、仍无 onerror 属性', hit.includes(50) && hit.includes(53) && (await page.evaluate(() => window.__xss === undefined && document.querySelectorAll('[onerror]').length === 0)), hit);
      await page.close();
    }

    // ===== W30 设计说明气泡二次打开（预筛 MED-1）=====
    // 它锁的是：气泡开着时再点任何条目（含伴生）的 ⓘ，必须立即看到新气泡且内容是那个条目的设计说明（冻结函数留下的「点别处关闭」once 监听会把刚建的新气泡删掉，分发必须先撤掉它）；
    //   只剩一个气泡；点别处仍能关闭。
    console.log('W30 设计说明二次打开');
    {
      const { page } = await open(adminN, 'W30', '', { beforeGoto: rewriteList(patchRows({ 50: { design_notes: 'DIM 说明甲' }, 53: { design_notes: '伴生说明乙' } })) });
      const pop = () => page.evaluate(() => ({ n: document.querySelectorAll('#designNotesPopover').length, text: (document.getElementById('designNotesPopover') || { innerText: null }).innerText }));
      const steps = [[58, '123'], [50, 'DIM 说明甲'], [53, '伴生说明乙'], [58, '123'], [53, '伴生说明乙']];
      for (let i = 0; i < steps.length; i++) {
        const [id, want] = steps[i];
        await clickC(page, `[data-id="${id}"] [data-entry="design-notes"]`);
        const p = await pop();
        check(`W30 第 ${i + 1} 次点 ⓘ（#${id}${id === 53 ? ' 伴生' : ''}）：立即只有 1 个气泡，内容含「${want}」${i > 0 ? '（上一个气泡还开着）' : ''}`, p.n === 1 && p.text !== null && p.text.includes(want), p);
        await fence(page);   // 保证这个气泡的「点别处关闭」once 监听已注册——下一次点击时它若没被撤掉（A1 的 bug）就会把新气泡删掉
      }
      await page.evaluate(() => document.body.click());
      await page.waitForFunction(() => !document.getElementById('designNotesPopover'), null, { timeout: WAIT }).then(() => check('W30 点别处：气泡关闭', true), () => check('W30 点别处：气泡关闭', false, '气泡仍在'));
      await page.close();
    }

    // ===== W31 伴生「编辑信息」保存路径（派单 §10 第 6 条；2d 起含 config_mode 完整性断言）=====
    // 它锁的是：伴生行经 ⋯ →「编辑信息」走真实 openEditModal（不打桩）→ 弹窗按该行回填 → 保存发出 PUT /api/models/53（表名 / layer 为伴生自己的）→ 200 → 弹窗关闭 → 列表重载（GET /api/models +1）→ 列表里该条目显示新中文描述。
    //   2d 起还锁：伴生行保存不得改写 config_mode（弹窗的配置方式下拉没有 companion 选项，回填落空串；confirmRegister 对伴生行不带 config_mode，服务端未提交即保留原值）：
    //     请求体不带 config_mode 键 / 库里 #53 仍是 companion 且仍挂在 #52 下 / 变更日志新增恰 1 条且摘要含「表注释」不含「配置方式」 / config_rev 不变 / update_cycle 往返不变。
    //   config_rev 期望依据（server.js 的 PUT /api/models/:id，configRevChanged 判定，8262-8269 行）：只有 A 类字段变化才 +1——dim_config（剔除簿记键）/ table_name / source_system / source_table / update_cycle / config_mode，
    //     按「实际写入值」与旧值比较；table_comment 是 B 类，不触发。本用例只改中文描述；DWD 不发 dim_config；table_name 原样回传；source_* 空值 → null（空与 NULL 视同空）；
    //     update_cycle 经 di → INCREMENTAL_APPEND → di 往返；config_mode 不带键 → 取旧值。所以 config_rev 必须保持不变（修复前：config_mode companion → standard 触发 +1）。
    //   对照（非伴生行行为不变）：#52（DWD standard）、#58（DIM custom）走同一条路径，库里 config_mode 不变；#52 请求体仍带 config_mode 且等于原值，#58（DIM，收口批 2 MED-1 起按基线判断）没改配置方式故不带。
//   2e 深链：Model_Center.html?id=53&edit=1 页面加载后自动 openEditModal(#53)，保存走同一个 confirmRegister；请求体不带 config_mode / 库里仍 companion / 日志不含「配置方式」 / config_rev 不变。
    console.log('W31 伴生编辑信息保存路径');
    {
      const { page } = await open(adminN, 'W31');
      const puts = []; const gets = { n: 0 };
      page.on('request', (r) => { try { const u = new URL(r.url()); if (/^\/api\/models\/\d+$/.test(u.pathname) && r.method() === 'PUT') puts.push({ path: u.pathname, body: JSON.parse(r.postData() || '{}') }); if (u.pathname === '/api/models' && r.method() === 'GET') gets.n++; } catch (_) { /* ignore */ } });
      /** 库里该行的相关字段 + 变更日志条数 / 最新一条摘要（读服务端真实状态，不读页面缓存） */
      const dbState = (id) => pageEvalBounded(page, async (id) => {
        const r = await (await authFetch('/api/models/' + id)).json();
        const l = await (await authFetch('/api/models/' + id + '/change-logs')).json();
        const last = l.reduce((a, b) => (!a || b.id > a.id ? b : a), null);
        return { mode: r.config_mode, rev: r.config_rev, co: r.companion_of, cycle: r.update_cycle, comment: r.table_comment, nLogs: l.length, lastSummary: last ? last.change_summary : null };
      }, id);
      /** B2-2：服务端 PUT /api/models/:id 先回 200、变更日志是未 await 的异步写（server.js insertModelChangeLog 在 res.json 之前发起、不等完成）——读日志前有界轮询到「日志条数 ≠ 保存前」（WAIT 内、每 200ms 一次，到达信号不是固定 sleep），超时判失败 */
      const dbStateAfter = async (id, prevN) => {
        const arrived = await page.waitForFunction(async ([i, n]) => { const l = await (await authFetch('/api/models/' + i + '/change-logs')).json(); return l.length !== n; }, [id, prevN], { timeout: WAIT, polling: 200 }).then(() => true, () => false);
        check('B2 保存后 #' + id + ' 的变更日志在 ' + WAIT + 'ms 内出现（条数 ≠ 保存前的 ' + prevN + '）', arrived);
        return dbState(id);
      };
      /** 真实路径：⋯ →「编辑信息」→ 改中文描述 → 保存；返回 { put, status, getsN, modalAfter, commentAfter } */
      const editInfoSave = async (id, newComment, afterOpen) => {
        puts.length = 0;
        const resp = new Promise((resolve) => { const h = (r) => { try { const u = new URL(r.url()); if (u.pathname === '/api/models/' + id && r.request().method() === 'PUT') { page.off('response', h); resolve(r.status()); } } catch (_) { /* ignore */ } }; page.on('response', h); });
        await clickC(page, `[data-id="${id}"] [data-menu="more"]`);
        await page.locator(`#catalog-menu-more-${id} [data-act="edit-info"]`).click();
        await page.waitForFunction(() => document.getElementById('registerModal').style.display === 'flex', null, { timeout: WAIT });
        const mv = await page.evaluate(() => ({ title: document.getElementById('modalTitle').textContent, tn: document.getElementById('regTableName').value, cm: document.getElementById('regComment').value, tnDisabled: document.getElementById('regTableName').disabled }));
        const hook = afterOpen ? await afterOpen() : null;
        gets.n = 0;
        await page.fill('#regComment', newComment);
        await page.click('#confirmRegisterBtn');
        const status = await Promise.race([resp, new Promise((r) => setTimeout(() => r('__timeout__'), WAIT))]);
        await page.waitForFunction(() => document.getElementById('registerModal').style.display === 'none', null, { timeout: WAIT }).catch(() => {});
        // 正向等待结果出现（waitForLoadState('networkidle') 在页面已达过 networkidle 后会立即返回，不能当作「重载完成」的信号）
        await page.waitForFunction(([i, c]) => { const e = document.querySelector(`#modelListBody [data-id="${i}"] .catalog-comment`); return !!e && e.textContent === c; }, [id, newComment], { timeout: WAIT }).catch(() => {});
        const after = await page.evaluate((i) => ({ modal: document.getElementById('registerModal').style.display, comment: document.querySelector(`#modelListBody [data-id="${i}"] .catalog-comment`).textContent }), id);
        return { mv, put: puts.slice(), status, getsN: gets.n, after, hook };
      };

      const before53 = await dbState(53);
      check('W31 前置：保存前库里 #53 是伴生（config_mode=companion、companion_of=52、update_cycle=di、config_rev 为整数）', before53.mode === 'companion' && before53.co === 52 && before53.cycle === 'di' && Number.isInteger(before53.rev), before53);
      const r53 = await editInfoSave(53, '伴生-改后描述');
      check('W31 伴生 #53 点「编辑信息」：真实编辑弹窗按该行回填（标题「编辑模型」、表名 dwd_w0001_w0060_change_di 且不可改、中文描述「字段说明1 - 字段说明235」）', r53.mv.title === '编辑模型' && r53.mv.tn === 'dwd_w0001_w0060_change_di' && r53.mv.tnDisabled && r53.mv.cm === '字段说明1 - 字段说明235', r53.mv);
      check('W31 保存：恰 1 个 PUT /api/models/53（layer=dwd、table_name 为伴生自己的、table_comment=新描述）→ 200', r53.put.length === 1 && r53.put[0].path === '/api/models/53' && r53.put[0].body.layer === 'dwd' && r53.put[0].body.table_name === 'dwd_w0001_w0060_change_di' && r53.put[0].body.table_comment === '伴生-改后描述' && r53.status === 200, { puts: r53.put, status: r53.status });
      check('W31 保存后：弹窗关闭、列表重载恰 1 次（GET /api/models）、#53 条目显示新中文描述「伴生-改后描述」', r53.after.modal === 'none' && r53.getsN === 1 && r53.after.comment === '伴生-改后描述', { after: r53.after, gets: r53.getsN });
      check('W31 伴生保存的请求体不带 config_mode 键（服务端未提交即保留原值）', r53.put.length === 1 && !Object.prototype.hasOwnProperty.call(r53.put[0].body, 'config_mode'), r53.put.map((p) => Object.keys(p.body)));
      const after53 = await dbStateAfter(53, before53.nLogs);
      check('W31 保存后库里 #53 仍是伴生：config_mode 仍为 companion、companion_of 仍为 52、update_cycle 仍为 di、中文描述已更新', after53.mode === 'companion' && after53.co === 52 && after53.cycle === 'di' && after53.comment === '伴生-改后描述', after53);
      check('W31 保存后 #53 变更日志新增恰 1 条，摘要含「表注释」且不含「配置方式」', after53.nLogs === before53.nLogs + 1 && typeof after53.lastSummary === 'string' && after53.lastSummary.includes('表注释') && !after53.lastSummary.includes('配置方式'), { before: before53.nLogs, after: after53.nLogs, summary: after53.lastSummary });
      check('W31 保存后 #53 的 config_rev 不变（只改了 B 类字段 table_comment；A 类字段全部原值，见头部依据）', after53.rev === before53.rev, { before: before53.rev, after: after53.rev });

      // 对照：非伴生行走同一条路径，请求体仍带 config_mode（等于原值），库里不变
      //   收口批 2 MED-1 起，DIM 的 config_mode 按弹窗打开时的基线判断：#58（DIM custom）没改配置方式 → 请求体不带 config_mode（服务端保留现值）；DWD 仍恒带（#52）。
      for (const [id, wantMode, tag, wantSent] of [[52, 'standard', 'DWD standard', true], [58, 'custom', 'DIM custom', false]]) {
        const b = await dbState(id);
        const r = await editInfoSave(id, '对照-改后描述' + id);
        const a = await dbStateAfter(id, b.nLogs);
        const hasMode = r.put.length === 1 && Object.prototype.hasOwnProperty.call(r.put[0].body, 'config_mode');
        check(`W31 对照 #${id}（${tag}，非伴生）：保存前库里 config_mode=${wantMode}；恰 1 个 PUT /api/models/${id} → 200，请求体${wantSent ? '仍带 config_mode=' + wantMode : '不带 config_mode（没改配置方式，服务端保留现值）'}；保存后库里 config_mode 不变、描述已更新`,
          b.mode === wantMode && r.put.length === 1 && r.put[0].path === '/api/models/' + id && r.status === 200 && (wantSent ? r.put[0].body.config_mode === wantMode : !hasMode) && a.mode === wantMode && a.comment === '对照-改后描述' + id, { before: b, put: r.put, status: r.status, after: a });
      }

      // 2e 深链：生产里 Model_Center.html?id=53&edit=1（资产中心等处的链接）打开的是同一个编辑弹窗，保存走同一个 confirmRegister——同口径再锁一次（读服务端真实状态）
      // 深链用例与前一个用例从同一个起点开始（互相独立）：把 #53 的 config_mode / config_rev 写回第一个用例之前的值。
      //   正常实现下它们本来就相等（no-op）；companion-sends-mode 变异下第一个用例已把 #53 改成 standard，不写回的话深链用例会在被污染的状态上跑，它自己的红就证明不了什么。
      { const rdb = await new Promise((res, rej) => { const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (e) => (e ? rej(e) : res(d))); });
        try { rdb.configure('busyTimeout', 5000); await dbRun(rdb, 'UPDATE data_models SET config_mode = ?, config_rev = ? WHERE id = 53', [before53.mode, before53.rev]); } finally { rdb.close(); } }
      const before53d = await dbState(53);
      check('W31 深链起点：#53 回到第一个用例之前的状态（config_mode=companion、config_rev 同前）', before53d.mode === 'companion' && before53d.rev === before53.rev, { before53, before53d });
      const dl = (await open(adminN, 'W31 深链', '?id=53&edit=1')).page;
      const dlPuts = [];
      dl.on('request', (r) => { try { const u = new URL(r.url()); if (/^\/api\/models\/\d+$/.test(u.pathname) && r.method() === 'PUT') dlPuts.push({ path: u.pathname, body: JSON.parse(r.postData() || '{}') }); } catch (_) { /* ignore */ } });
      await dl.waitForFunction(() => document.getElementById('registerModal').style.display === 'flex', null, { timeout: WAIT }).catch(() => {});
      const dlModal = await dl.evaluate(() => ({ display: document.getElementById('registerModal').style.display, title: document.getElementById('modalTitle').textContent, tn: document.getElementById('regTableName').value, cm: document.getElementById('regComment').value }));
      check('W31 深链 ?id=53&edit=1：页面加载后自动打开 #53 的编辑弹窗（标题「编辑模型」、表名为伴生自己的、中文描述为库里当前值）', dlModal.display === 'flex' && dlModal.title === '编辑模型' && dlModal.tn === 'dwd_w0001_w0060_change_di' && dlModal.cm === '伴生-改后描述', dlModal);
      const dlResp = dl.waitForResponse((r) => { try { return new URL(r.url()).pathname === '/api/models/53' && r.request().method() === 'PUT'; } catch (_) { return false; } }, { timeout: WAIT }).then((r) => r.status(), () => '__timeout__');
      if (dlModal.display === 'flex') {   // 3c：弹窗没自动打开（深链被门拦住）时上面的 check 已判红；不再 fill 超时抛异常带崩脚本
        await dl.fill('#regComment', '深链-改后描述');
        await dl.click('#confirmRegisterBtn');
      }
      const dlStatus = await dlResp;
      const after53d = await dbStateAfter(53, before53d.nLogs);   // PUT 的 200 先于日志写入返回（B2-2）：等日志条数变化后再读
      check('W31 深链保存：恰 1 个 PUT /api/models/53 → 200，请求体不带 config_mode 键', dlPuts.length === 1 && dlPuts[0].path === '/api/models/53' && dlStatus === 200 && !Object.prototype.hasOwnProperty.call(dlPuts[0].body, 'config_mode'), { puts: dlPuts.map((p) => Object.keys(p.body)), status: dlStatus });
      check('W31 深链保存后库里 #53 仍是伴生：config_mode 仍为 companion、companion_of 仍为 52、update_cycle 仍为 di、中文描述已更新', after53d.mode === 'companion' && after53d.co === 52 && after53d.cycle === 'di' && after53d.comment === '深链-改后描述', after53d);
      check('W31 深链保存后 #53 变更日志新增恰 1 条，摘要含「表注释」且不含「配置方式」；config_rev 不变', after53d.nLogs === before53d.nLogs + 1 && typeof after53d.lastSummary === 'string' && after53d.lastSummary.includes('表注释') && !after53d.lastSummary.includes('配置方式') && after53d.rev === before53d.rev, { before: before53d, after: after53d });
      await dl.close();

      // ===== W32 / W33（39 号 MED）：伴生「编辑信息」保存时，列表缓存行与弹窗副本的 companion_of 任一非空即按伴生处理 =====
      // 它锁的是：confirmRegister 的伴生判断是并集——列表行过期（W32）或弹窗副本过期（W33）其中一边变空，请求体仍不带 config_mode；库里 #53 仍是 companion、config_rev 不变、日志不含「配置方式」。
      //   走 ⋯ →「编辑信息」（行副本路径）：此时 currentEditModel 是点击时的副本、allModelsData 里是另一个对象；弹窗开着之后才改其中一边（保存读的是保存那一刻的值）。
      console.log('W32 / W33 伴生保存：列表行或弹窗副本过期');
      const resetCo53 = async () => {   // 每个用例同一起点：#53 的 config_mode / config_rev 写回第一个用例之前的值（正常实现下是 no-op，变异下前一个用例可能已把它改成 standard）
        const rdb = await new Promise((res, rej) => { const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (e) => (e ? rej(e) : res(d))); });
        try { rdb.configure('busyTimeout', 5000); await dbRun(rdb, 'UPDATE data_models SET config_mode = ?, config_rev = ? WHERE id = 53', [before53.mode, before53.rev]); } finally { rdb.close(); }
      };
      const staleCase = async (tag, mk) => {
        await resetCo53();
        const b = await dbState(53);
        const r = await editInfoSave(53, tag + '-改后描述', () => page.evaluate(mk));
        const a = await dbStateAfter(53, b.nLogs);
        return { b, r, a };
      };
      const finishStale = (tag, which, { b, r, a }) => {
        check(`${tag} 前置：库里 #53 是伴生（config_mode=companion、companion_of=52），${which}`, b.mode === 'companion' && b.co === 52 && b.rev === before53.rev, { b });
        check(`${tag} 保存：恰 1 个 PUT /api/models/53 → 200，layer=dwd、table_comment=新描述`, r.put.length === 1 && r.put[0].path === '/api/models/53' && r.put[0].body.layer === 'dwd' && r.put[0].body.table_comment === tag + '-改后描述' && r.status === 200, { puts: r.put, status: r.status });
        check(`${tag} 请求体不带 config_mode 键（${which}，另一边仍是伴生 ⇒ 按伴生处理）`, r.put.length === 1 && !Object.prototype.hasOwnProperty.call(r.put[0].body, 'config_mode'), r.put.map((p) => Object.keys(p.body)));
        check(`${tag} 保存后库里 #53 仍是 companion、companion_of 仍为 52、config_rev 不变，变更日志新增恰 1 条且摘要不含「配置方式」`, a.mode === 'companion' && a.co === 52 && a.rev === b.rev && a.nLogs === b.nLogs + 1 && typeof a.lastSummary === 'string' && !a.lastSummary.includes('配置方式'), { b, a });
      };
      {
        const res = await staleCase('W32', () => { const row = allModelsData.find((m) => m.id == 53); const cem = currentEditModel; const pre = { rowCo: row.companion_of, cemCo: cem.companion_of }; row.companion_of = null; return { pre, post: { rowCo: row.companion_of, cemCo: cem.companion_of }, sameObj: row === cem, cemId: cem.id }; });
        const h = res.r.hook;
        check('W32 前置（改动确实生效）：弹窗已开着时把列表行 companion_of 由 52 置 null，读回 null；弹窗副本 companion_of 仍为 52（currentEditModel 未动）；两者不是同一对象', !!h && h.pre.rowCo === 52 && h.pre.cemCo === 52 && h.post.rowCo === null && h.post.cemCo === 52 && h.sameObj === false && h.cemId === 53, h);
        finishStale('W32', '列表行过期', res);
      }
      {
        const res = await staleCase('W33', () => { const row = allModelsData.find((m) => m.id == 53); const cem = currentEditModel; const pre = { rowCo: row.companion_of, cemCo: cem.companion_of }; cem.companion_of = null; return { pre, post: { rowCo: row.companion_of, cemCo: cem.companion_of }, sameObj: row === cem, cemId: cem.id }; });
        const h = res.r.hook;
        check('W33 前置（改动确实生效）：弹窗已开着时把弹窗副本 companion_of 由 52 置 null，读回 null；列表行 companion_of 仍为 52（未动）；两者不是同一对象', !!h && h.pre.rowCo === 52 && h.pre.cemCo === 52 && h.post.cemCo === null && h.post.rowCo === 52 && h.sameObj === false && h.cemId === 53, h);
        finishStale('W33', '弹窗副本过期', res);
      }
      await page.close();
    }

    // ===== W34 catalogCall 处理函数存在性（39 号 L1）=====
    // 它锁的是：菜单项对应的全局处理函数不是函数时，分发不抛 TypeError（无 pageerror），只记一条 console.error「处理函数不存在：<名>」；菜单已由委托关闭；恢复函数后同一个项照常调用。
    //   这条 console.error 是本用例的期望值：全程统计里只豁免该标签上文本以「[catalog] 处理函数不存在：」开头的 console.error（4d 起不再整标签豁免），pageerror 一律不豁免，本用例自己也断言为 0。
    console.log('W34 catalogCall 处理函数不存在');
    {
      const { page } = await open(adminN, 'W34');
      const perrs = []; const cerrs = [];
      page.on('pageerror', (e) => perrs.push(String(e).slice(0, 200)));
      page.on('console', (m) => { if (m.type() === 'error') cerrs.push(m.text()); });
      await page.evaluate(() => { window.__origVMCL = window.viewModelChangeLogs; window.viewModelChangeLogs = undefined; });
      const pre = await page.evaluate(() => typeof window.viewModelChangeLogs);
      const seen = page.waitForEvent('console', { predicate: (m) => m.type() === 'error' && m.text().includes('处理函数不存在：viewModelChangeLogs'), timeout: 5000 }).then(() => true, () => false);
      await clickC(page, '[data-id="50"] [data-menu="more"]');
      const preMenu = (await onlyOpen(page, ['catalog-menu-more-50'])) === true;
      await page.locator('#catalog-menu-more-50 [data-act="history"]').click();
      const got = await seen;
      await fence(page);
      check('W34 前置：window.viewModelChangeLogs 已被换成 undefined（typeof 读回 undefined），#50 的 ⋯ 菜单已打开', pre === 'undefined' && preMenu, { pre, preMenu });
      check('W34 点「变更历史」：W34 内收集到的 console.error 总数恰为 1，且就是「处理函数不存在：viewModelChangeLogs」', got && cerrs.length === 1 && cerrs[0].includes('处理函数不存在：viewModelChangeLogs'), cerrs);
      check('W34 点「变更历史」：无未捕获异常（pageerror 0 次，不是 TypeError）', perrs.length === 0, perrs);
      check('W34 点「变更历史」后菜单已关闭（委托先关菜单再分发）', (await onlyOpen(page, [])) === true);
      await page.evaluate(() => { window.viewModelChangeLogs = window.__origVMCL; });
      check('W34 结束恢复原函数：window.viewModelChangeLogs 读回为 function', (await page.evaluate(() => typeof window.viewModelChangeLogs)) === 'function');
      await page.close();
    }

    // ===== W35 分发按层级闭合（39 号 L2）=====
    // 它锁的是：ddl / etl / view-config 的分发只对明确层级调用对应处理函数（ddl：ODS / DIM / DWD；etl：DIM / DWD；view-config：伴生 → DWD 只读，非伴生 DIM → DIM，非伴生 DWD → DWD），未知层级一个处理函数都不调。
    //   动作规格对未知层级本来就生成禁用项，所以真实点击到不了这里；用伪造的启用 data-act 元素直接调 catalogDispatchAct。12 个处理函数换成记录型替身，结束恢复原函数。
    //   对照（正常层级仍调对应处理函数）：#50 DIM / #52 DWD / #53 伴生（含改成 DIM 的伴生）/ #101 ODS（ddl 调 openDDLModal；etl 与 view-config 不调）。
    console.log('W35 分发按层级闭合');
    {
      const { page } = await open(adminN, 'W35');
      await page.evaluate((names) => { window.__orig35 = {}; names.forEach((n) => { window.__orig35[n] = window[n]; }); }, HANDLERS);
      await stubHandlers(page);
      const fire = async (id, act) => {
        await page.evaluate(() => { window.__calls = []; });
        await page.evaluate(([id, act]) => { const entry = document.querySelector('#modelListBody [data-id="' + id + '"]'); const el = document.createElement('button'); el.setAttribute('data-act', act); entry.appendChild(el); try { catalogDispatchAct(el); } finally { el.remove(); } }, [id, act]);
        return (await callsOf(page)).map((x) => x.fn + '(' + (x.args[0] && typeof x.args[0] === 'object' ? '#' + x.args[0].id : x.args[0]) + ')');
      };
      const controls = [
        [50, 'ddl', ['openDimDDLModal(50)']], [50, 'etl', ['openDimETLModal(50)']], [50, 'view-config', ['openDimConfigViewModal(50)']],
        [52, 'ddl', ['openDwdDDLModal(52)']], [52, 'etl', ['openDwdScriptModal(52)']], [52, 'view-config', ['openDwdConfigViewModal(52)']],
        [53, 'view-config', ['openDwdConfigViewModal(53)']],
        [101, 'ddl', ['openDDLModal(#101)']], [101, 'etl', []], [101, 'view-config', []],
      ];
      const got = [];
      for (const [id, act, want] of controls) got.push([id, act, want, await fire(id, act)]);
      check('W35 对照（正常层级）：DIM #50 / DWD #52 / 伴生 #53 / ODS #101 的 ddl · etl · view-config 各调用且仅调用对应处理函数（ODS 的 etl 与 view-config 零调用）', got.every(([, , w, g]) => J(w) === J(g)), got.filter(([, , w, g]) => J(w) !== J(g)));
      const co = await page.evaluate(() => { const r = allModelsData.find((m) => m.id == 53); r.layer = 'DIM'; return { layer: r.layer, co: r.companion_of }; });
      const coCalls = await fire(53, 'view-config');
      check('W35 对照（DIM 伴生）：#53 的 layer 改成 DIM 后 view-config 仍调 openDwdConfigViewModal(53)（伴生一律走 DWD 只读配置，不调 openDimConfigViewModal）', co.layer === 'DIM' && co.co === 52 && J(coCalls) === J(['openDwdConfigViewModal(53)']), { co, coCalls });
      const x = await page.evaluate(() => { const r = allModelsData.find((m) => m.id == 50); r.layer = 'XYZ'; return { layer: r.layer, co: r.companion_of }; });
      check('W35 前置（改动确实生效）：#50 的 layer 读回 XYZ、非伴生', x.layer === 'XYZ' && !x.co, x);
      check('W35 未知层级 XYZ 的 ddl：零个处理函数被调用（openDwdDDLModal 0 次）', J(await fire(50, 'ddl')) === J([]), await callsOf(page));
      check('W35 未知层级 XYZ 的 etl：零个处理函数被调用（openDwdScriptModal 0 次）', J(await fire(50, 'etl')) === J([]), await callsOf(page));
      check('W35 未知层级 XYZ 的 view-config：零个处理函数被调用（openDwdConfigViewModal 0 次）', J(await fire(50, 'view-config')) === J([]), await callsOf(page));
      await page.evaluate(() => { Object.keys(window.__orig35).forEach((n) => { window[n] = window.__orig35[n]; }); });
      check('W35 结束恢复 12 个处理函数原件（typeof 均为 function）', (await page.evaluate((names) => names.every((n) => typeof window[n] === 'function' && window[n] === window.__orig35[n]), HANDLERS)) === true);
      await page.close();
    }

    // ====================================================================================================================
    // 子批 3a（C4c-3）：W36 起（展开区：展开按钮 / 面板三态 / 关系渲染 / 迟到丢弃 / 失败重试 / 事件表 / 全部收起 / 展开集合 ∩ 当前页 / XSS）。
    //   约定同 W20 起：每组用例含伴生条目；关系响应由路由手写（确定、可扣住），W38 / W39 另有一组走真实服务端往返；等待一律绑在被断言对象上（面板节点 / 到达记录 / 请求计数），有界；期望值全部手写。
    //   「到达记录」= 页内给 ModelCatalogCore.relationsArrived 套一层透传的旁听器（window.__relArr），每条记 id / token / ok / 是否被核心丢弃——迟到响应是否被丢弃，直接读核心的判定，不靠 sleep 猜。
    // ====================================================================================================================
    const isRel = (u) => /^\/api\/models\/\d+\/relations$/.test(u.pathname);
    const relIdOf = (u) => Number(u.pathname.split('/')[3]);
    /** 记录页面发出的 GET /api/models/<id>/relations（按发出顺序的 id 序列；独立于路由 handler） */
    const trackRel = (page) => { const ids = []; page.on('request', (r) => { try { const u = new URL(r.url()); if (isRel(u) && r.method() === 'GET') ids.push(relIdOf(u)); } catch (_) { /* ignore */ } }); return ids; };
    /** 路由：handler(id, 该 id 的第几次请求) → { status?, json? , body? } | { abort: true }；handler 内可 await 闸门扣住响应。返回按 id 计数的对象（handler 入口处 +1，用来确认「第 n 次请求已到达」） */
    const routeRel = async (page, handler) => {
      const counts = {};
      await page.route(isRel, async (route) => {
        const id = relIdOf(new URL(route.request().url()));
        counts[id] = (counts[id] || 0) + 1;
        const r = await handler(id, counts[id]);
        if (r && r.abort) return route.abort('failed');
        return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: r.body !== undefined ? r.body : JSON.stringify(r.json) });
      });
      return counts;
    };
    const untilTrue = async (fn, ms = WAIT) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); } return false; };   // 有界轮询 node 侧状态（请求计数 / 序列），不是睡眠猜时序
    /** 页内旁听器：给 ModelCatalogCore.relationsArrived 套一层透传，记下每次到达（id / token / ok / 是否被核心判为迟到丢弃） */
    const spyArrived = (page) => page.evaluate(() => { window.__relArr = []; const o = ModelCatalogCore.relationsArrived; ModelCatalogCore.relationsArrived = function (S, a) { const r = o.apply(this, arguments); window.__relArr.push({ id: String(a.id), token: a.token, ok: a.ok, discarded: r.effects.some((e) => e.type === 'discard-relations') }); return r; }; });
    /** 页内有界调用 loadModels()：超时返回 '__timeout__'（3d，40Tb-M1：闸门释放前的直接调用不能无界——错误实现若等展开请求完成 / 复用被扣住的请求，套件不能挂起） */
    const loadBounded = (page) => page.evaluate((ms) => Promise.race([loadModels().then((v) => v, () => '__threw__'), new Promise((r) => setTimeout(() => r('__timeout__'), ms))]), WAIT);
    const waitArrived = (page, n) => page.waitForFunction((k) => window.__relArr.length >= k, n, { timeout: WAIT }).then(() => true, () => false);
    const arrivals = (page) => page.evaluate(() => window.__relArr.slice());
    const paneInfo = (page, id) => page.evaluate((id) => { const p = document.querySelector(`#modelListBody [data-id="${id}"] > .pane`); if (!p) return null; const m = /catalog-pane-(loading|error|loaded)/.exec(p.className); return { state: m ? m[1] : null, text: p.textContent, id: p.id }; }, id);
    const waitPane = (page, id, state) => page.waitForSelector(`#modelListBody [data-id="${id}"] > .pane.catalog-pane-${state}`, { timeout: WAIT }).then(() => true, () => false);
    const expandedIdsDom = (page) => page.$$eval('#modelListBody [data-expand-toggle]', (bs) => bs.filter((b) => b.getAttribute('aria-expanded') === 'true').map((b) => Number(b.closest('[data-id]').getAttribute('data-id'))));
    const paneCount = (page) => page.$$eval('#modelListBody .pane', (ps) => ps.length);
    const stateExpanded = (page) => page.evaluate(() => catalogEventState.expanded.map(String));
    const toggleOf = (page, id) => clickC(page, `#modelListBody [data-id="${id}"] [data-expand-toggle]`);
    const tagRel = (id, n) => ({ upstream: [{ name: 'g' + id + '_' + n }], downstream: [], objects: [], objectState: 'standard' });   // 带「第几次请求」标记的响应：内容能区分是哪一次请求的结果
    const REL_STD = { upstream: [{ name: 'ods_w0001_df' }, { name: 'ods_unknown_src' }, { name: 'ods_w0001' }], downstream: [{ id: 52, table_name: 'dwd_w0001_w0060_df', table_comment: '主表 52', layer: 'dwd', status: 'ONLINE', config_mode: 'standard' }], objects: [], objectState: 'standard' };
    const REL_COMP = { upstream: [], downstream: [], objects: [], objectState: 'companion' };
    const ob = (type, schema, name, summary, role, verified, badges) => ({ obj_type: type, schema_name: schema, obj_name: name, summary, role, verified_at: verified, badges });
    const REL_LISTED = {
      upstream: [{ name: 'ods_w0001_df' }],
      downstream: [],
      objects: [
        ob('PROC', 'dbo', 'usp_a', 'sum1', '主加工', '2026-03-01 08:00:00', { doc: 'consistent', reg: 'inconsistent' }),
        ob('VIEW', 'dbo', 'v_b', null, null, null, { doc: 'unregistered', reg: 'consistent' }),
        ob('TRIGGER', null, 'trg_c', '触发器说明', '触发', null, { doc: 'unverified', reg: 'unverified' }),
        ob('PROC', 'dbo', 'usp_d', null, '清洗', '2026-02-01 00:00:00', { doc: 'stale', reg: 'stale' }),
        ob('PROC', 'dbo', 'usp_e', null, '汇总', '2026-03-03 10:00:00', { doc: 'prod_missing', reg: 'prod_missing' }),
        ob('PROC', 'dbo', 'usp_f', null, '回写', '2026-03-04 11:00:00', { doc: 'verify_failed', reg: 'verify_failed', failure: { at: '2026-03-02 09:09:09', error: '连接超时' } }),
        ob('FDL_TASK', null, 'fdl任务一', null, '调度', null, { doc: null, reg: null }),
        ob('TABLE', 'dbo', 't_x', null, '目标表', '2026-03-05 12:00:00', { doc: 'inconsistent', reg: 'unregistered' }),
      ],
      objectState: 'listed',
    };
    const HINT_DOC = '文档 ↔ 生产：不一致 = 有人绕过审查改了生产（事故级）';
    const HINT_REG = '模型中心登记 ↔ 生产：不一致 = 登记过期（卫生级）';
    /** 读 loaded 面板：上游 / 下游两列（条数、每项的链接 [data-open-model, 文本] / 纯文本 / 说明、空态、提示）、本模型格、实现对象框 */
    const readLoaded = (page, id) => page.evaluate((id) => {
      const p = document.querySelector(`#modelListBody [data-id="${id}"] > .pane.catalog-pane-loaded`); if (!p) return null;
      const col = (t) => {
        const c = Array.from(p.querySelectorAll('.catalog-flow-col')).find((x) => x.querySelector('.catalog-flow-title > span').textContent === t); if (!c) return null;
        const cnt = c.querySelector('.catalog-flow-title .catalog-flow-count'); const one = (s) => { const e = c.querySelector(s); return e ? e.textContent : null; };
        return { count: cnt ? cnt.textContent : null, empty: one('.catalog-flow-empty'), hint: one('.catalog-flow-hint'),
          items: Array.from(c.querySelectorAll('.catalog-flow-item')).map((it) => ({ text: it.textContent, links: Array.from(it.querySelectorAll('button')).map((b) => [b.getAttribute('data-open-model'), b.textContent]), plain: Array.from(it.querySelectorAll('.catalog-plain')).map((s) => s.textContent), desc: (it.querySelector('.catalog-flow-desc') || { textContent: null }).textContent })) };
      };
      const me = p.querySelector('.catalog-flow-me'); const box = p.querySelector('.catalog-objbox');
      if (!box) return { up: col('上游'), down: col('下游引用'), me: me ? me.textContent : null, boxText: null, boxStates: [], boxLinks: [], hasTable: false, hint: null };
      return { up: col('上游'), down: col('下游引用'), me: me ? me.textContent : null, boxText: box.textContent, boxStates: Array.from(box.querySelectorAll('.catalog-objstate')).map((s) => s.className), boxLinks: Array.from(box.querySelectorAll('button')).map((b) => [b.getAttribute('data-open-model'), b.textContent]), hasTable: !!box.querySelector('table'), hint: (box.querySelector('.catalog-flow-hint') || { textContent: null }).textContent };
    }, id);
    const readObjRows = (page, id) => page.evaluate((id) => Array.from(document.querySelectorAll(`#modelListBody [data-id="${id}"] > .pane .catalog-objtable tbody tr`)).map((tr) => {
      const c = (k) => tr.querySelector('.' + k); const bs = Array.from(tr.querySelectorAll('.catalog-obj-badges > span'));
      return { type: c('catalog-obj-type').textContent, name: c('catalog-obj-name').textContent, summary: c('catalog-obj-name').getAttribute('title'), role: c('catalog-obj-role').textContent, time: c('catalog-obj-time').textContent, badgeText: bs.map((b) => b.textContent), badgeCls: bs.map((b) => b.className), badgeTitle: bs.map((b) => b.getAttribute('title')) };
    }), id);

    // ===== W36 展开按钮与面板结构 =====
    // 它锁的是（DOM 契约 1 / 3，方案 §3.1 / §3.5）：①第 1 页 21 个条目（含伴生 #53）每个恰有 1 个 button[data-expand-toggle]，是首行的第一个子元素，aria-expanded="false"、aria-controls="pane-<id>"，不带 data-act / data-entry；
    //   ②点击同步展开：aria-expanded=true、条目内第二行之后出现 div.pane#pane-<id>（loading「加载中…」），面板及其后代不带 data-id / data-entry / data-act；发出恰 1 次 GET /api/models/<id>/relations；点展开按钮不开抽屉、按 P30 选中该条目（先把选中清空再点）；
    //   ③响应到达后 loaded；再点收起（面板撤掉、不发请求），再点展开重新请求且先显示加载态；④伴生 #53 同样可展开（上游「随主模型 #52 生成」，D-34）；⑤viewer 也有展开按钮并可展开。
    console.log('W36 展开按钮与面板');
    {
      const { page } = await open(adminN, 'W36');
      const relIds = trackRel(page);
      const g = gate(); const g2 = gate(); const g3 = gate();   // g 扣住 #50 的第 1 次响应、g2 扣住第 2 次响应：「同步读到加载态」的用例必须让响应在读之后才到达，否则读到的可能已是 loaded
      const counts = await routeRel(page, async (id, n) => { if (id === 50 && n === 1) await g.p; if (id === 50 && n === 2) await g2.p; if (id === 53 && n === 1) await g3.p; return { json: id === 53 ? REL_COMP : REL_STD }; });
      await page.evaluate(() => { window.__omd = []; const orig = window.openModelDrawer; window.openModelDrawer = function (id) { window.__omd.push(id); return orig.apply(this, arguments); }; });
      const tg = await page.$$eval('#modelListBody [data-id]', (els) => els.map((e) => { const bs = e.querySelectorAll('[data-expand-toggle]'); const b = bs[0]; const r1 = e.querySelector('.catalog-row1'); return { id: Number(e.getAttribute('data-id')), n: bs.length, tag: b ? b.tagName : null, first: !!b && r1.firstElementChild === b, exp: b ? b.getAttribute('aria-expanded') : null, ctl: b ? b.getAttribute('aria-controls') : null, act: b ? (b.hasAttribute('data-act') || b.hasAttribute('data-entry')) : null, type: b ? b.getAttribute('type') : null, hasPane: !!e.querySelector('.pane') }; }));
      check('W36 第 1 页 21 个条目（手写 PAGE1_21，含伴生 #53）每个恰有 1 个展开按钮：button、首行第一个子元素、aria-expanded="false"、aria-controls="pane-<id>"、不带 data-act / data-entry、初始无面板',
        J(tg.map((x) => x.id)) === J(PAGE1_21) && tg.every((x) => x.n === 1 && x.tag === 'BUTTON' && x.type === 'button' && x.first && x.exp === 'false' && x.ctl === 'pane-' + x.id && x.act === false && x.hasPane === false), tg.filter((x) => !(x.n === 1 && x.first && x.exp === 'false' && x.ctl === 'pane-' + x.id && x.act === false)).slice(0, 3));
      await page.evaluate(() => document.querySelectorAll('#modelListBody .selected-row').forEach((e) => e.classList.remove('selected-row')));   // 先清选中，再测「点展开按钮会选中」（前一个动作的副作用不得掩盖被测动作）
      check('W36 前提：点击前没有任何条目被选中', (await page.$$eval('#modelListBody .selected-row', (e) => e.length)) === 0);
      const reqP = page.waitForRequest((r) => isRel(new URL(r.url())), { timeout: WAIT });
      await toggleOf(page, 50);
      const sync1 = await page.evaluate(() => {
        const e = document.querySelector('#modelListBody [data-id="50"]'); const kids = Array.from(e.children); const p = kids.find((c) => c.classList.contains('pane'));
        const bad = []; if (p) [p].concat(Array.from(p.querySelectorAll('*'))).forEach((x) => ['data-id', 'data-entry', 'data-act'].forEach((a) => { if (x.hasAttribute(a)) bad.push(x.tagName + '@' + a); }));
        return { exp: e.querySelector('[data-expand-toggle]').getAttribute('aria-expanded'), kids: kids.map((c) => c.className.split(' ')[0]), tag: p ? p.tagName : null, pid: p ? p.id : null, prev: p && p.previousElementSibling ? p.previousElementSibling.className : null, cls: p ? p.className : null, text: p ? p.textContent : null, bad, selected: Array.from(document.querySelectorAll('#modelListBody .selected-row')).map((x) => Number(x.getAttribute('data-id'))), omd: window.__omd.length, drawer: document.getElementById('modelDetailDrawer').classList.contains('open') };
      });
      check('W36 点 #50 的展开按钮（同步读）：aria-expanded=true；条目子元素依次为 row1 / row2 / pane；面板是 div#pane-50、紧跟在第二行之后、加载态「加载中…」', sync1.exp === 'true' && J(sync1.kids) === J(['catalog-row1', 'catalog-row2', 'pane']) && sync1.tag === 'DIV' && sync1.pid === 'pane-50' && /catalog-row2/.test(sync1.prev) && /catalog-pane-loading/.test(sync1.cls) && sync1.text === '加载中…', sync1);
      check('W36 面板及其全部后代不带 data-id / data-entry / data-act（DOM 契约 1 / 3）', sync1.bad.length === 0, sync1.bad);
      check('W36 P30：点展开按钮选中该条目（全表只有 #50 .selected-row），且没有打开抽屉（openModelDrawer 0 次、抽屉无 open 类）', J(sync1.selected) === J([50]) && sync1.omd === 0 && sync1.drawer === false, sync1);
      const req = await reqP.catch(() => null);
      check('W36 展开发出恰 1 次 GET /api/models/50/relations（路径与方法逐字）', !!req && req.method() === 'GET' && new URL(req.url()).pathname === '/api/models/50/relations' && J(relIds) === J([50]), { url: req && req.url(), relIds });
      g.release();
      check('W36 响应到达：#50 面板变为 loaded', await waitPane(page, 50, 'loaded'));
      check('W36 loaded 后仍是 1 次请求、aria-expanded 仍为 true', J(relIds) === J([50]) && J(await expandedIdsDom(page)) === J([50]), { relIds, exp: await expandedIdsDom(page) });
      await toggleOf(page, 50);
      check('W36 再点 #50：收起——面板撤掉、aria-expanded=false、不发请求（仍 1 次）、状态里展开集合为空', (await paneCount(page)) === 0 && J(await expandedIdsDom(page)) === J([]) && J(relIds) === J([50]) && J(await stateExpanded(page)) === J([]), { panes: await paneCount(page), relIds });
      await toggleOf(page, 50);
      const again = await paneInfo(page, 50);
      check('W36 再展开：先显示加载态（不沿用旧数据；第 2 次响应被 g2 扣住，所以此刻读到的一定是加载态）', !!again && again.state === 'loading' && again.text === '加载中…', again);
      check('W36 再展开重新请求：第 2 次请求已到达路由', await untilTrue(() => counts[50] === 2 && relIds.length === 2));
      g2.release();
      check('W36 再展开的响应到达后 loaded、请求恰 2 次', (await waitPane(page, 50, 'loaded')) && J(relIds) === J([50, 50]) && counts[50] === 2, { relIds, counts });
      await toggleOf(page, 53);
      const c53req = await untilTrue(() => counts[53] === 1);   // 3d（40Ta-L2）：#53 的响应由 g3 扣住，先读到加载态再放行
      const c53load = await paneInfo(page, 53);
      const c53exp = (await expandedIdsDom(page)).includes(53);
      check('W36 伴生 #53 先 loading（响应被 g3 扣住）：请求已到达路由、面板加载态「加载中…」、展开按钮 aria-expanded=true', c53req && !!c53load && c53load.state === 'loading' && c53load.text === '加载中…' && c53exp, { c53req, c53load, c53exp });
      g3.release();
      check('W36 伴生 #53 可展开：先 loading 再 loaded', await waitPane(page, 53, 'loaded'));
      const c53 = await readLoaded(page, 53);
      check('W36 伴生 #53 的上游写「随主模型 #52 生成」（D-34；链接指向 #52）；下游空态「未发现下游引用」；实现对象框是伴生空态', !!c53 && c53.up.items.length === 1 && c53.up.items[0].text === '随主模型 #52 生成' && J(c53.up.items[0].links) === J([['52', '#52']]) && c53.down.empty === '未发现下游引用' && c53.down.items.length === 0 && c53.boxStates.length === 1 && /catalog-objstate-companion/.test(c53.boxStates[0]), c53);
      check('W36 点 #50 / #53 展开按钮全程没有打开抽屉（openModelDrawer 共 0 次）', (await page.evaluate(() => window.__omd.length)) === 0);
      await page.close();
      const vctx = await mkCtx(USERS[1]);
      const { page: vp } = await open(vctx, 'W36v');
      await routeRel(vp, async () => ({ json: REL_STD }));
      const vcnt = await vp.$$eval('#modelListBody [data-id]', (els) => els.map((e) => e.querySelectorAll('[data-expand-toggle]').length));
      check('W36 viewer：21 个条目（含伴生）也各有 1 个展开按钮（viewer 没有操作区，展开按钮不依赖权限）', vcnt.length === 21 && vcnt.every((n) => n === 1) && (await vp.$$eval('#modelListBody .model-row-actions', (e) => e.length)) === 0, vcnt);
      if (await vp.locator('#modelListBody [data-id="50"] [data-expand-toggle]').count() === 1) {
        await toggleOf(vp, 50);
        check('W36 viewer 点展开：#50 面板 loaded', await waitPane(vp, 50, 'loaded'));
      } else {
        check('W36 viewer 点展开：#50 面板 loaded', false, 'viewer 的 #50 没有展开按钮，无法点击（上一条已判红）');
      }
      await vp.close(); await vctx.close();
    }

    // ===== W37 loaded 内容与实现对象表 =====
    // 它锁的是（方案 §3.1 展开区 / §4.5 / D-34 / D-35）：上游 → 本模型 → 下游三栏的条数、链接与纯文本（名字等于列表里某个表名才是 button[data-open-model] 链接，指向该模型 id）、下游「中文短名」与提示；
    //   listed 的实现对象表（类型 / schema.对象 / 职责 / 两枚徽章 / 核验时间；空职责与空核验时间显示「—」；summary 作悬停）；七种徽章文案 + 四种色调类（手写表，不读被测常量）；两枚都为 null 只显示一个「—」；
    //   verify_failed 的悬停写失败时间与错误；表下提示；标准配置空态含表名。
    console.log('W37 loaded 内容');
    {
      const { page } = await open(adminN, 'W37');
      await routeRel(page, async (id) => ({ json: id === 52 ? REL_LISTED : REL_STD }));
      await toggleOf(page, 50); await waitPane(page, 50, 'loaded');
      const a = await readLoaded(page, 50);
      check('W37 #50 上游：条数 3；第 1 项「ods_w0001_df」等于列表里 #6 的表名 → 链接 [6, 文本]；第 2 项「ods_unknown_src」不在列表、第 3 项「ods_w0001」只是 #6 表名的前缀（不相等）→ 都是纯文本（无链接；includes / startsWith 式的匹配会把第 3 项误做成链接）', !!a && a.up.count === '3' && a.up.items.length === 3 && J(a.up.items[0].links) === J([['6', 'ods_w0001_df']]) && a.up.items[0].plain.length === 0 && a.up.items[1].links.length === 0 && J(a.up.items[1].plain) === J(['ods_unknown_src']) && a.up.items[2].links.length === 0 && J(a.up.items[2].plain) === J(['ods_w0001']) && a.up.empty === null, a && a.up);
      check('W37 #50 下游：条数 1；链接 [52, dwd_w0001_w0060_df] + 中文短名「主表 52」；提示「按平台配置候选匹配」；无空态文案', !!a && a.down.count === '1' && a.down.items.length === 1 && J(a.down.items[0].links) === J([['52', 'dwd_w0001_w0060_df']]) && a.down.items[0].desc === '主表 52' && a.down.hint === '按平台配置候选匹配' && a.down.empty === null, a && a.down);
      check('W37 #50 本模型格「本模型」+ 表名；标准配置空态：「▢ 标准配置模型：由平台生成，实现对象只有目标表本身 dim_w0007_w0008」，无对象表', !!a && a.me === '本模型dim_w0007_w0008' && a.boxText === '实现对象▢ 标准配置模型：由平台生成，实现对象只有目标表本身 dim_w0007_w0008' && a.hasTable === false && a.boxStates.length === 1 && /catalog-objstate-standard/.test(a.boxStates[0]), a && { me: a.me, box: a.boxText });
      await toggleOf(page, 52); await waitPane(page, 52, 'loaded');
      const l = await readLoaded(page, 52);
      check('W37 #52 listed：有对象表（无空态块）、框标题「实现对象 8 个」、表下提示「核验超过 7 天自动降为「待重核」」', !!l && l.hasTable && l.boxStates.length === 0 && l.boxText.startsWith('实现对象8 个') && l.hint === '核验超过 7 天自动降为「待重核」', l && { box: l.boxText.slice(0, 20), hint: l.hint });
      const rows = await readObjRows(page, 52);
      const W = [   // [类型, 对象, 悬停(summary), 职责, [徽章文本], [徽章色调类后缀], 核验时间]
        ['PROC', 'dbo.usp_a', 'sum1', '主加工', ['文档 一致', '登记 不一致'], ['ok', 'bad'], '2026-03-01 08:00:00'],
        ['VIEW', 'dbo.v_b', null, '—', ['文档 未登记', '登记 一致'], ['muted', 'ok'], '—'],
        ['TRIGGER', 'trg_c', '触发器说明', '触发', ['文档 未核验', '登记 未核验'], ['muted', 'muted'], '—'],
        ['PROC', 'dbo.usp_d', null, '清洗', ['文档 待重核', '登记 待重核'], ['warn', 'warn'], '2026-02-01 00:00:00'],
        ['PROC', 'dbo.usp_e', null, '汇总', ['文档 生产缺失', '登记 生产缺失'], ['bad', 'bad'], '2026-03-03 10:00:00'],
        ['PROC', 'dbo.usp_f', null, '回写', ['文档 核验失败', '登记 核验失败'], ['warn', 'warn'], '2026-03-04 11:00:00'],
        ['FDL_TASK', 'fdl任务一', null, '调度', ['—'], ['none'], '—'],
        ['TABLE', 'dbo.t_x', null, '目标表', ['文档 不一致', '登记 未登记'], ['bad', 'muted'], '2026-03-05 12:00:00'],
      ];
      check('W37 对象表 8 行（顺序 = 响应顺序）', rows.length === 8, rows.length);
      W.forEach((w, i) => {
        const r = rows[i]; if (!r) { check(`W37 对象行 ${i + 1} 存在`, false); return; }
        const toneOk = r.badgeCls.length === w[5].length && r.badgeCls.every((c, k) => c === (w[5][k] === 'none' ? 'catalog-cons-none' : 'catalog-cons-badge catalog-cons-' + w[5][k]));
        check(`W37 对象行 ${i + 1}（${w[1]}）：类型 / 对象 / summary 悬停 / 职责 / 徽章文案 / 徽章色调类 / 核验时间逐项相等`, r.type === w[0] && r.name === w[1] && r.summary === w[2] && r.role === w[3] && J(r.badgeText) === J(w[4]) && toneOk && r.time === w[6], r);
      });
      const bt = (i) => (rows[i] ? rows[i].badgeTitle : null);
      check('W37 徽章悬停：普通徽章 doc 写「文档 ↔ 生产…」、reg 写「模型中心登记 ↔ 生产…」（行 1）；verify_failed 的两枚徽章悬停都写失败时间与错误「核验失败于 2026-03-02 09:09:09：连接超时」（行 6）；null 徽章「—」无悬停（行 7）',
        J(bt(0)) === J([HINT_DOC, HINT_REG]) && J(bt(5)) === J(['核验失败于 2026-03-02 09:09:09：连接超时', '核验失败于 2026-03-02 09:09:09：连接超时']) && J(bt(6)) === J([null]), { r0: bt(0), r5: bt(5), r6: bt(6) });
      await page.close();
    }

    // ===== W38 三种空态 + 真实服务端往返 =====
    // 它锁的是（方案 §3.1 / §4.5 objectState）：不经路由、走真实 GET /api/models/:id/relations（隔离库里没有登记对象）——伴生 #53 → companion 空态、custom #58 → pending 空态（「未接入登记」）、标准配置 #59 → standard 空态含表名；
    //   #59 上游（sourceTables 为空）显示「无」、条数 0，下游无候选显示「未发现下游引用」；#52 的上游名里等于列表表名的两个（ods_w0001_df → #6、ods_w0006_w0007_w0008_df → #8）渲染成链接；ODS #6 的上游写「源系统 · 源表」，其下游是 #52。
    console.log('W38 三种空态与真实往返');
    {
      const { page } = await open(adminN, 'W38');
      const loadedAll = [];
      for (const id of [53, 58, 59, 52]) { await toggleOf(page, id); loadedAll.push(await waitPane(page, id, 'loaded')); }
      check('W38 前置：#53 / #58 / #59 / #52 四个面板（真实服务端响应）都 loaded', loadedAll.every((x) => x === true), loadedAll);
      const e53 = await readLoaded(page, 53); const e58 = await readLoaded(page, 58); const e59 = await readLoaded(page, 59); const e52 = await readLoaded(page, 52);
      check('W38 伴生 #53（真实响应 objectState=companion）：「↳ 伴生表：随主模型 #52 生成，实现对象登记在主模型下」，链接 [52, #52]，companion 空态类', !!e53 && e53.boxText === '实现对象↳ 伴生表：随主模型 #52 生成，实现对象登记在主模型下' && J(e53.boxLinks) === J([['52', '#52']]) && e53.boxStates.length === 1 && /catalog-objstate-companion/.test(e53.boxStates[0]) && e53.hasTable === false, e53 && { box: e53.boxText, st: e53.boxStates });
      check('W38 custom #58（真实响应 objectState=pending）：「◌ 未接入登记：这是自定义脚本模型，过程 / 视图 / 任务还没登记进来（数仓 #18）」，pending 空态类', !!e58 && e58.boxText === '实现对象◌ 未接入登记：这是自定义脚本模型，过程 / 视图 / 任务还没登记进来（数仓 #18）' && e58.boxStates.length === 1 && /catalog-objstate-pending/.test(e58.boxStates[0]), e58 && { box: e58.boxText, st: e58.boxStates });
      check('W38 标准配置 #59（真实响应 objectState=standard）：「▢ 标准配置模型：由平台生成，实现对象只有目标表本身 dwd_w0155_test_df」，standard 空态类', !!e59 && e59.boxText === '实现对象▢ 标准配置模型：由平台生成，实现对象只有目标表本身 dwd_w0155_test_df' && e59.boxStates.length === 1 && /catalog-objstate-standard/.test(e59.boxStates[0]), e59 && { box: e59.boxText, st: e59.boxStates });
      check('W38 #59 上游空（sourceTables 为空）：条数 0、显示「无」、没有项；下游无候选：条数 0、显示「未发现下游引用」、无提示', !!e59 && e59.up.count === '0' && e59.up.empty === '无' && e59.up.items.length === 0 && e59.down.count === '0' && e59.down.empty === '未发现下游引用' && e59.down.items.length === 0 && e59.down.hint === null, e59 && { up: e59.up, down: e59.down });
      const links52 = e52 ? e52.up.items.map((it) => it.links[0]).filter(Boolean) : null;
      check('W38 #52 上游：12 项（sourceTables 不去重）；其中等于列表表名的恰两项成链接，依次 [6, ods_w0001_df]、[8, ods_w0006_w0007_w0008_df]，其余 10 项纯文本', !!e52 && e52.up.count === '12' && e52.up.items.length === 12 && J(links52) === J([['6', 'ods_w0001_df'], ['8', 'ods_w0006_w0007_w0008_df']]) && e52.up.items.filter((it) => it.links.length === 0 && it.plain.length === 1).length === 10, e52 && { count: e52.up.count, links: links52 });
      await page.evaluate(() => goToPage(2));
      const loadedOds = [];
      for (const id of [6, 8]) { await toggleOf(page, id); loadedOds.push(await waitPane(page, id, 'loaded')); }
      check('W38 前置：第 2 页 #6 / #8 面板（真实服务端响应）都 loaded', loadedOds.every((x) => x === true), loadedOds);
      const e6 = await readLoaded(page, 6); const e8 = await readLoaded(page, 8);
      check('W38 ODS #6 上游写「源系统 · 源表」=「W0003 · w0002_w0001」（纯文本）；下游 1 项：链接 [52, dwd_w0001_w0060_df]', !!e6 && e6.up.count === '1' && J(e6.up.items.map((it) => it.plain)) === J([['W0003 · w0002_w0001']]) && e6.up.items[0].links.length === 0 && e6.down.count === '1' && J(e6.down.items.map((it) => it.links[0])) === J([['52', 'dwd_w0001_w0060_df']]), e6 && { up: e6.up, down: e6.down });
      check('W38 ODS #8 下游 2 项，顺序按 (分层, 表名) 字节序：dim #50 在前、dwd #52 在后；提示「按平台配置候选匹配」', !!e8 && e8.down.count === '2' && J(e8.down.items.map((it) => it.links[0])) === J([['50', 'dim_w0007_w0008'], ['52', 'dwd_w0001_w0060_df']]) && e8.down.hint === '按平台配置候选匹配', e8 && e8.down);
      await page.close();
    }

    // ===== W39 迟到的旧展开响应被丢弃 =====
    // 它锁的是（方案 §3.4 展开加载 / 事件顺序，核心 relationsArrived 的令牌）：A 展开→请求 1 被扣住→收起→再展开→请求 2 先返回（面板显示请求 2 的内容）→放行请求 1：旧响应被核心判为 discard-relations（旁听器读到 discarded=true、令牌比请求 2 的小），面板仍是请求 2 的内容；
    //   翻页：展开→扣住→翻页→放行：丢弃、新页上没有面板、状态里没有关系数据；翻回第 1 页该条目仍是收起。
    console.log('W39 迟到响应丢弃');
    {
      const { page } = await open(adminN, 'W39');
      const g1 = gate();
      const counts = await routeRel(page, async (id, n) => { if (n === 1) await g1.p; return { json: tagRel(id, n) }; });
      await spyArrived(page);
      await toggleOf(page, 50);
      check('W39 请求 1 已到达路由（将被扣住，响应内容 g50_1）', await untilTrue(() => counts[50] === 1));
      await toggleOf(page, 50);
      check('W39 收起：面板撤掉', (await paneCount(page)) === 0);
      await toggleOf(page, 50);
      check('W39 再展开：请求 2 已到达路由（即时返回 g50_2），面板 loaded 且内容含 g50_2', (await untilTrue(() => counts[50] === 2)) && (await waitPane(page, 50, 'loaded')) && (await paneInfo(page, 50)).text.includes('g50_2'));
      g1.release();
      check('W39 放行请求 1 后核心收到第 2 次到达（等旁听器记录，不 sleep）', await waitArrived(page, 2));
      const arr = await arrivals(page);
      const pi = await paneInfo(page, 50);
      check('W39 到达记录：第 1 条（请求 2）未被丢弃；第 2 条（迟到的请求 1）被核心判为 discard，且令牌小于请求 2 的令牌', arr.length === 2 && arr[0].discarded === false && arr[1].discarded === true && arr[1].token < arr[0].token, arr);
      check('W39 迟到的旧响应没有改动面板：仍是 loaded 且内容含 g50_2、不含 g50_1', !!pi && pi.state === 'loaded' && pi.text.includes('g50_2') && !pi.text.includes('g50_1'), pi);
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W39b');
      const g1 = gate();
      const counts = await routeRel(page, async (id, n) => { await g1.p; return { json: tagRel(id, n) }; });
      await spyArrived(page);
      await toggleOf(page, 50);
      check('W39b 请求已到达路由并被扣住', await untilTrue(() => counts[50] === 1));
      await page.evaluate(() => goToPage(2));
      g1.release();
      check('W39b 翻页后放行：核心收到到达记录', await waitArrived(page, 1));
      const arr = await arrivals(page);
      check('W39b 翻页后迟到的响应被核心判为 discard；第 2 页没有任何面板；状态里没有关系数据、展开集合为空', arr.length === 1 && arr[0].discarded === true && (await paneCount(page)) === 0 && (await page.evaluate(() => Object.keys(catalogEventState.relations).length)) === 0 && J(await stateExpanded(page)) === J([]), { arr, panes: await paneCount(page) });
      await page.evaluate(() => goToPage(1));
      check('W39b 翻回第 1 页：#50 仍是收起（aria-expanded=false、无面板）', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0);
      await page.close();
    }

    // ===== W40 失败后重试 + 不弹 toast =====
    // 它锁的是（方案 §3.4 展开加载「失败在展开区内显示重试，不 toast」）：路由先 500 再 200 → 面板 error「关系加载失败」+ button[data-pane-act="retry"]（不带 data-act）；点重试同步回到加载态、重新请求，成功后 loaded；全程 showToast 0 次；
    //   响应形状不对（200 但缺字段）和连接失败同样落成 error（可重试）。
    console.log('W40 失败重试');
    {
      expectErr('W40', U_REL);   // 500 / 连接失败：浏览器自己记 console error（Failed to load resource），按标签豁免
      const { page } = await open(adminN, 'W40');
      const relIds = trackRel(page);
      await page.evaluate(() => { window.__toasts = []; window.showToast = function () { window.__toasts.push(Array.from(arguments)); }; });
      const gR = gate();   // 扣住 #50 重试的响应：点重试后「同步回到加载态」的断言要在响应到达之前读
      const counts = await routeRel(page, async (id, n) => {
        if (id === 50) { if (n === 1) return { status: 500, json: { error: '关系查询失败' } }; await gR.p; return { json: REL_STD }; }
        if (id === 52) return n === 1 ? { json: { x: 1 } } : { json: REL_STD };
        return n === 1 ? { abort: true } : { json: REL_STD };
      });
      await toggleOf(page, 50);
      check('W40 500 → #50 面板 error', await waitPane(page, 50, 'error'));
      const er = await page.evaluate(() => { const p = document.querySelector('#modelListBody [data-id="50"] > .pane'); const b = Array.from(p.querySelectorAll('button')); return { text: p.textContent, n: b.length, act: b[0] ? b[0].getAttribute('data-pane-act') : null, dataAct: b[0] ? b[0].hasAttribute('data-act') : null, exp: document.querySelector('#modelListBody [data-id="50"] [data-expand-toggle]').getAttribute('aria-expanded') }; });
      check('W40 error 面板：文字「关系加载失败」+ 恰 1 个按钮 button[data-pane-act="retry"]（文字「重试」，不带 data-act）；展开按钮仍是展开态', er.text === '关系加载失败重试' && er.n === 1 && er.act === 'retry' && er.dataAct === false && er.exp === 'true', er);
      await clickC(page, '#modelListBody [data-id="50"] [data-pane-act="retry"]');
      const afterClick = await paneInfo(page, 50);
      check('W40 点重试：同步回到加载态（「加载中…」，重试响应被扣住所以此刻读到的一定是加载态），不是收起', !!afterClick && afterClick.state === 'loading' && afterClick.text === '加载中…', afterClick);
      gR.release();
      check('W40 重试成功：#50 面板 loaded，请求共 2 次（500 + 200）', (await waitPane(page, 50, 'loaded')) && J(relIds) === J([50, 50]) && counts[50] === 2, { relIds });
      await toggleOf(page, 52);
      check('W40 200 但形状不对（{"x":1}）→ #52 面板 error（不渲染半截数据）', await waitPane(page, 52, 'error'));
      await clickC(page, '#modelListBody [data-id="52"] [data-pane-act="retry"]');
      check('W40 #52 重试成功 → loaded', await waitPane(page, 52, 'loaded'));
      await toggleOf(page, 55);
      check('W40 连接失败（abort）→ #55 面板 error；点重试成功 → loaded', (await waitPane(page, 55, 'error')) && (await (async () => { await clickC(page, '#modelListBody [data-id="55"] [data-pane-act="retry"]'); return waitPane(page, 55, 'loaded'); })()));
      check('W40 全程 showToast 0 次（失败只在展开区内显示，不 toast）', (await page.evaluate(() => window.__toasts.length)) === 0, await page.evaluate(() => window.__toasts));
      await page.close();
    }

    // ===== W41 事件表：翻页 / 排序 / 搜索 / 数据重载 / ?focus =====
    // 它锁的是（方案 §3.4 事件表）：①翻页→全部收起（翻回仍收起、不重新请求）②排序→展开集合保留，不在当前页的 id 留在集合里，排序翻回来该条目仍展开且沿用已有数据（不重新请求）③改搜索→全部收起
    //   ④数据重载→只保留仍在当前页的展开项并重新请求，旧内容先显示加载态（不沿用旧数据），被去掉的条目不再请求 ⑤重载时不在当前页的展开项被丢掉（翻回来是收起）⑥?focus 跳页高亮且不展开，focusCatalogModel 清掉已有展开。
    console.log('W41 事件表');
    {
      const { page } = await open(adminN, 'W41a');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await toggleOf(page, 50); await waitPane(page, 50, 'loaded');
      await page.evaluate(() => goToPage(2));
      check('W41a 展开 #50 后翻页：第 2 页没有展开项 / 面板，状态展开集合为空', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && J(await stateExpanded(page)) === J([]));
      await page.evaluate(() => goToPage(1));
      check('W41a 翻回第 1 页：#50 是收起（翻页清空展开）、没有面板、没有重新请求（共 1 次）', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && J(relIds) === J([50]), { relIds });
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W41b');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await toggleOf(page, 50); await waitPane(page, 50, 'loaded');
      await page.locator('button[data-sort-by="id"]').click();   // id desc：第 1 页 = 125…106，#50 在第 2 页
      let v = await view(page);
      check('W41b 排序 id desc：#50 不在第 1 页（手写 DESC_ALL 前 20 个）、第 1 页没有面板；展开集合仍含 50（排序不收起）', J(v.pageGroups.flat()) === J(DESC_ALL.slice(0, 20)) && (await paneCount(page)) === 0 && J(await stateExpanded(page)) === J(['50']), { ids: v.pageGroups.flat(), st: await stateExpanded(page) });
      await page.locator('button[data-sort-by="id"]').click();   // id asc：第 1 页 = 6,8,50,52,53,…，#50 回到第 1 页
      v = await view(page);
      const pi = await paneInfo(page, 50);
      check('W41b 排序 id asc：#50 回到第 1 页，仍是展开且 loaded、内容仍是首次请求的 g50_1（沿用已有数据），没有重新请求（共 1 次）', v.pageGroups.flat().includes(50) && J(await expandedIdsDom(page)) === J([50]) && !!pi && pi.state === 'loaded' && pi.text.includes('g50_1') && J(relIds) === J([50]), { pi, relIds });
      await page.locator('button[data-sort-by="id"]').click();   // 清排序
      const pi2 = await paneInfo(page, 50);
      check('W41b 清排序（默认序）：#50 仍展开且沿用 g50_1，共 1 次请求', !!pi2 && pi2.state === 'loaded' && pi2.text.includes('g50_1') && J(relIds) === J([50]) && J(await expandedIdsDom(page)) === J([50]), { pi2, relIds });
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W41c');
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await toggleOf(page, 50); await waitPane(page, 50, 'loaded');
      await page.fill('#searchKeyword', 'dim_');
      check('W41c 展开 #50 后改搜索词：全部收起（无展开按钮为 true、无面板），状态展开集合为空', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && J(await stateExpanded(page)) === J([]));
      await page.fill('#searchKeyword', '');
      check('W41c 清空搜索词：仍是收起', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0);
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W41d');
      const relIds = trackRel(page);
      const g2 = gate();
      const counts = await routeRel(page, async (id, n) => { if (id === 50 && n === 2) await g2.p; return { json: tagRel(id, n) }; });
      await toggleOf(page, 50); await toggleOf(page, 52);
      check('W41d 前置：#50 / #52 都 loaded（g50_1 / g52_1）', (await waitPane(page, 50, 'loaded')) && (await waitPane(page, 52, 'loaded')) && (await paneInfo(page, 50)).text.includes('g50_1') && (await paneInfo(page, 52)).text.includes('g52_1'));
      await page.route(isList, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const resp = await route.fetch(); const rows = await resp.json();
        await route.fulfill({ response: resp, body: JSON.stringify(rows.filter((r) => r.id !== 52 && r.id !== 53)) });
      });
      const lr41d = await loadBounded(page);   // 重载成功：#52 / #53 被去掉，#50 仍在当前页；3d（40Tb-M1）有界——错误实现若等展开请求完成会挂在被扣住的 #50 第 2 次响应上，超时记 FAIL 并放行闸门
      if (lr41d === '__timeout__') g2.release();
      check("W41d 数据重载在有界时间内返回 'arrived'（不等展开请求完成）", lr41d === 'arrived', lr41d);
      const lo = await paneInfo(page, 50);
      check('W41d 数据重载（#52 / #53 不再存在）：#50 的面板先显示加载态（「加载中…」，不沿用旧内容 g50_1）', !!lo && lo.state === 'loading' && lo.text === '加载中…' && !lo.text.includes('g50_1'), lo);
      check('W41d 重载后：当前页不再有 #52 / #53 条目；展开集合只剩 50；展开按钮只有 #50 是展开态', !(await domIds(page)).includes(52) && !(await domIds(page)).includes(53) && J(await stateExpanded(page)) === J(['50']) && J(await expandedIdsDom(page)) === J([50]), { dom: await domIds(page), st: await stateExpanded(page) });
      check('W41d #50 重新请求（第 2 次到达路由、被扣住）；#52 不再请求：请求序列恰为 [50, 52, 50]', (await untilTrue(() => counts[50] === 2 && relIds.length === 3)) && J(relIds) === J([50, 52, 50]), { relIds, counts });
      g2.release();
      check('W41d 放行后 #50 面板 loaded，内容是第 2 次请求的 g50_2；请求序列仍为 [50, 52, 50]', (await waitPane(page, 50, 'loaded')) && (await paneInfo(page, 50)).text.includes('g50_2') && J(relIds) === J([50, 52, 50]), { relIds });
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W41e');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await toggleOf(page, 50); await waitPane(page, 50, 'loaded');
      await page.locator('button[data-sort-by="id"]').click();   // id desc：#50 离开第 1 页但留在集合里
      check('W41e 前置：排序后 #50 不在当前页，展开集合仍含 50', !(await domIds(page)).includes(50) && J(await stateExpanded(page)) === J(['50']));
      await pageCallBounded(page, 'loadModels()');
      check('W41e 此时数据重载：只保留仍在当前页的展开项——#50 不在当前页，被丢掉（展开集合为空），不为它重新请求（共 1 次）', J(await stateExpanded(page)) === J([]) && J(relIds) === J([50]), { st: await stateExpanded(page), relIds });
      await page.locator('button[data-sort-by="id"]').click();   // id asc：#50 回到第 1 页
      check('W41e 排序翻回 #50 所在页：#50 是收起（已被重载丢掉）、没有面板', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0);
      await page.close();
    }
    {
      let relIds = [];   // 3d（40Tb-M5）：监听与路由在导航前装（覆盖初始化全过程），否则「深链初始化预取关系但保持收起」的错误实现发出的请求会漏记
      const { page } = await open(adminN, 'W41f', '?focus=8', { beforeGoto: async (pg) => { relIds = trackRel(pg); await routeRel(pg, async (id, n) => ({ json: tagRel(id, n) })); } });
      const hl = await page.waitForSelector('#modelListBody [data-id="8"][data-focus-highlight]', { timeout: WAIT }).then(() => true, () => false);
      check('W41f ?focus=8：跳到 #8 所在的第 2 页、#8 带 data-focus-highlight；全部收起（没有展开态 / 面板）、没有发 relations 请求', hl && (await page.evaluate(() => currentPage)) === 2 && J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && relIds.length === 0, { cp: await page.evaluate(() => currentPage), relIds });
      if (hl) {   // 3c：?focus 没跳页（初始化门被拦住）时上面的 check 已判红；#6 不在当前页，toggleOf 会超时抛异常
      await toggleOf(page, 6); await waitPane(page, 6, 'loaded');
      check('W41f 前置：在 ?focus 页上展开 #6 → loaded', J(await expandedIdsDom(page)) === J([6]));
      await page.evaluate(() => focusCatalogModel(8));
      check('W41f focusCatalogModel(8)：清掉已有展开（#6 收起、无面板、展开集合为空），仍在第 2 页', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && J(await stateExpanded(page)) === J([]) && (await page.evaluate(() => currentPage)) === 2);
      }
      await page.close();
    }

    // ===== W42 全部收起 =====
    // 它锁的是（D-22）：按钮 button[data-catalog-act="collapse-all"] 在工具条里（C4c-4 起；3b 时在排序条）、文字「全部收起」、不带 data-act；点击收起当前页所有展开项（含伴生 #53）并清掉令牌：
    //   正在加载的条目（请求被扣住）也被收起，其迟到响应被核心丢弃（旁听器 discarded=true），不会让面板再冒出来。
    console.log('W42 全部收起');
    {
      const { page } = await open(adminN, 'W42');
      const g = gate();
      const counts = await routeRel(page, async (id, n) => { if (id === 52) await g.p; return { json: id === 53 ? REL_COMP : tagRel(id, n) }; });
      await spyArrived(page);
      const btn = await page.$$eval('.catalog-toolbar [data-catalog-act="collapse-all"]', (bs) => bs.map((b) => ({ text: b.textContent, act: b.hasAttribute('data-act'), entry: b.hasAttribute('data-entry'), tag: b.tagName })));
      check('W42 工具条里恰有 1 个 button[data-catalog-act="collapse-all"]，文字「全部收起」，不带 data-act / data-entry', btn.length === 1 && btn[0].tag === 'BUTTON' && btn[0].text === '全部收起' && !btn[0].act && !btn[0].entry, btn);
      await toggleOf(page, 50); await toggleOf(page, 53); await toggleOf(page, 52);
      check('W42 前置：#50 / #53 loaded，#52 请求被扣住（loading）', (await waitPane(page, 50, 'loaded')) && (await waitPane(page, 53, 'loaded')) && (await untilTrue(() => counts[52] === 1)) && (await paneInfo(page, 52)).state === 'loading' && J(await expandedIdsDom(page)) === J([50, 52, 53]), await expandedIdsDom(page));
      await page.locator('.catalog-toolbar [data-catalog-act="collapse-all"]').click();
      check('W42 点「全部收起」：展开按钮全部 false、没有面板（含 loading 的 #52 与伴生 #53）、状态展开集合 / 令牌 / 关系数据全空', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && J(await stateExpanded(page)) === J([]) && (await page.evaluate(() => Object.keys(catalogEventState.expandTokens).length + Object.keys(catalogEventState.relations).length + Object.keys(catalogEventState.expandStatus).length)) === 0);
      g.release();
      check('W42 放行被扣住的 #52 响应后核心收到到达记录（#50 / #53 的两条在前，第 3 条是 #52）', await waitArrived(page, 3));
      const arr = await arrivals(page);
      check('W42 #52 的迟到响应被核心判为 discard；面板没有冒出来、展开按钮仍全是收起', arr.length === 3 && arr[2].id === '52' && arr[2].discarded === true && (await paneCount(page)) === 0 && J(await expandedIdsDom(page)) === J([]), arr);
      await page.close();
    }

    // ===== W43 展开集合 ∩ 当前页 =====
    // 它锁的是（派单 §2.2）：驱动与用例会直接写 currentPage（不经核心 gotoPage），状态里的展开集合不一定都在当前页；renderModelsPage 只给「展开集合 ∩ 当前页 pageIds」建面板——
    //   展开 #50 后直接 currentPage = 2; renderModelsPage()：不抛错（无 pageerror）、第 2 页 DOM 正是手写的 15 组 / 15 个条目、没有面板、没有展开态；状态里展开集合没被渲染改动（仍含 50，页面只读）。
    console.log('W43 展开集合 ∩ 当前页');
    {
      const { page } = await open(adminN, 'W43');
      const perrs = []; page.on('pageerror', (e) => perrs.push(String(e).slice(0, 200)));
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await toggleOf(page, 50); await waitPane(page, 50, 'loaded');
      const thrown = await page.evaluate(() => { try { currentPage = 2; renderModelsPage(); return null; } catch (e) { return String(e).slice(0, 160); } });
      check('W43 展开 #50 后直接 currentPage = 2; renderModelsPage()：渲染不抛错（展开集合里的 50 不在第 2 页，被「∩ 当前页」滤掉）', thrown === null && perrs.length === 0, { thrown, perrs });
      check('W43 第 2 页 DOM = 手写的第 2 页 15 个条目（113…125, 6, 8）；没有面板、没有展开态', J(await domIds(page)) === J(ALL36.slice(21)) && (await paneCount(page)) === 0 && J(await expandedIdsDom(page)) === J([]), { dom: await domIds(page) });
      check('W43 页面只读状态：展开集合仍含 50（渲染不改事件态）', J(await stateExpanded(page)) === J(['50']));
      await page.close();
    }

    // ===== W44 XSS（展开区）=====
    // 它锁的是：关系响应里的 obj_name / schema_name / obj_type / role / summary / verified_at / last_error（失败悬停）/ failure.at / 下游 table_name 与 table_comment / 上游名 / ODS 的 source_system·source_table，
    //   以及展开按钮 aria-label 里的表名，写入 '、"、&#39;、<img onerror> 后：不执行（window.__xss 未赋值）、面板里没有 img 节点 / onerror 属性、面板所有元素只有白名单属性（无 on* / src / href / style）、文字与 title 都是字面文本、
    //   data-open-model 的值只是模型 id（数字）。
    console.log('W44 XSS（展开区）');
    {
      const XS = `'"&#39;<img src=x onerror="window.__xss=1">`;
      const T50 = 'T50' + XS;
      const REL_X = {
        upstream: [{ name: 'ods_xss' + XS }, { name: XS }],
        downstream: [{ id: 52, table_name: XS, table_comment: XS, layer: 'dwd', status: 'ONLINE', config_mode: 'standard' }],
        objects: [ob(XS, XS, XS, XS, XS, XS, { doc: 'verify_failed', reg: 'verify_failed', failure: { at: XS, error: XS } })],
        objectState: 'listed',
      };
      const REL_X_ODS = { upstream: [{ source_system: XS, source_table: XS }], downstream: [], objects: [], objectState: 'standard' };
      const { page } = await open(adminN, 'W44', '', { beforeGoto: rewriteList(patchRows({ 50: { table_name: T50 }, 8: { table_name: 'ods_xss' + XS } })) });
      await routeRel(page, async (id) => ({ json: id === 6 ? REL_X_ODS : REL_X }));
      check('W44 前置：#50 展开按钮的 aria-label 是字面文本「展开 T50… 的关系」（属性值不被引号截断）', (await page.getAttribute('#modelListBody [data-id="50"] [data-expand-toggle]', 'aria-label')) === '展开 ' + T50 + ' 的关系');
      await toggleOf(page, 50); await waitPane(page, 50, 'loaded');
      const st = await page.evaluate(() => {
        const p = document.querySelector('#modelListBody [data-id="50"] > .pane'); const ok = new Set(['class', 'title', 'type', 'id', 'data-open-model', 'aria-hidden']); const bad = [];
        [p].concat(Array.from(p.querySelectorAll('*'))).forEach((e) => Array.from(e.attributes).forEach((a) => { if (!ok.has(a.name)) bad.push(e.tagName + '@' + a.name); }));
        return { xss: window.__xss === undefined, onerrorAttr: document.querySelectorAll('[onerror]').length, imgs: p.querySelectorAll('img').length, bad, linkVals: Array.from(p.querySelectorAll('[data-open-model]')).map((b) => b.getAttribute('data-open-model')) };
      });
      check('W44 面板载入后：window.__xss 未赋值、全页没有 onerror 属性、面板里没有 img；面板所有元素只有白名单属性；所有 data-open-model 值都是纯数字 id', st.xss && st.onerrorAttr === 0 && st.imgs === 0 && st.bad.length === 0 && st.linkVals.length > 0 && st.linkVals.every((x) => /^\d+$/.test(x)), st);
      const a = await readLoaded(page, 50); const rows = await readObjRows(page, 50);
      check('W44 上游：第 1 项名字等于 #8 被改写后的表名 → 链接 [8, 字面文本]；第 2 项（XS）不在列表 → 纯文本 XS', !!a && J(a.up.items[0].links) === J([['8', 'ods_xss' + XS]]) && J(a.up.items[1].plain) === J([XS]), a && a.up);
      check('W44 下游：链接文字 = XS（table_name），中文短名 = XS（table_comment），均为字面文本', !!a && J(a.down.items[0].links) === J([['52', XS]]) && a.down.items[0].desc === XS, a && a.down);
      check('W44 对象表：类型 / 对象（schema.对象）/ 职责 / 核验时间 / summary 悬停都是字面文本；两枚 verify_failed 徽章的悬停 =「核验失败于 XS：XS」（失败时间与错误原文）', rows.length === 1 && rows[0].type === XS && rows[0].name === XS + '.' + XS && rows[0].role === XS && rows[0].time === XS && rows[0].summary === XS && J(rows[0].badgeTitle) === J(['核验失败于 ' + XS + '：' + XS, '核验失败于 ' + XS + '：' + XS]), rows[0]);
      await page.evaluate(() => goToPage(2));
      await toggleOf(page, 6); await waitPane(page, 6, 'loaded');
      const o6 = await readLoaded(page, 6);
      check('W44 ODS #6 的上游「源系统 · 源表」= XS · XS 字面文本；__xss 仍未赋值', !!o6 && J(o6.up.items.map((it) => it.plain)) === J([[XS + ' · ' + XS]]) && (await page.evaluate(() => window.__xss === undefined)), o6 && o6.up);
      await page.close();
    }

    // ====================================================================================================================
    // 子批 3b（C4c-3）：W45 起（列表加载失败 P28 / ready 口径 / loadModels 三态 / 初始化门 / 上游名匹配口径）。约定同 W36 起：每组含伴生条目，期望值全部手写，等待绑在被断言对象上且有界。
    // ====================================================================================================================
    const MSG_REFRESH = '列表刷新失败，显示的是上次数据';
    const MSG_FIRST = '列表加载失败';
    /** 提示节点与列表状态的当前读数（shown = 既未 hidden 属性、计算样式也不是 none） */
    const noticeInfo = (page) => page.evaluate(() => {
      const n = document.getElementById('catalogListNotice'); if (!n) return null;
      const bs = Array.from(n.querySelectorAll('button')); const b = bs[0] || null;
      return { hidden: n.hidden, shown: !n.hidden && getComputedStyle(n).display !== 'none', text: n.textContent, kids: n.children.length, nb: bs.length, tag: b ? b.tagName : null, act: b ? b.getAttribute('data-catalog-act') : null, dataAct: b ? b.hasAttribute('data-act') : null, btnText: b ? b.textContent : null, role: n.getAttribute('role'), state: document.getElementById('modelListBody').getAttribute('data-catalog-state') };
    });
    /** 页面装载时（先于页面自己的 DOMContentLoaded 回调）给 showToast 与指定全局函数套记录型包装：window.__toasts / window.__spied[name] */
    const initSpies = (names) => async (pg) => {
      await pg.addInitScript((ns) => {
        document.addEventListener('DOMContentLoaded', () => {
          window.__toasts = []; const t = window.showToast;
          window.showToast = function () { window.__toasts.push(Array.from(arguments)); return typeof t === 'function' ? t.apply(this, arguments) : undefined; };
          window.__spied = {};
          ns.forEach((n) => { window.__spied[n] = []; const o = window[n]; window[n] = function () { window.__spied[n].push(Array.from(arguments)); return typeof o === 'function' ? o.apply(this, arguments) : undefined; }; });
        });
      }, names);
    };
    /** 先确认按钮存在再点：不存在 = 判红并返回 false（直接 click 会等 30 秒后抛超时、让整个脚本崩掉而没有结果行） */
    const clickIf = async (page, sel, label) => { if ((await page.locator(sel).count()) < 1 || !(await page.locator(sel).first().isVisible())) { check(label, false, '按钮不存在或不可见：' + sel); return false; } await clickC(page, sel); return true; };
    const pInfo = async (page, id) => (await paneInfo(page, id)) || { state: null, text: '' };   // 面板不存在时给空读数（直接取 .state 会抛 TypeError 把脚本带崩）
    const failListRoute = (pg) => pg.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' }); });

    // ===== W45 列表刷新失败（P28）=====
    // 它锁的是（方案 §3.4 / 派单 §2.3 P28）：列表重载失败（HTTP 500）→ loadModels 返回 'failed'；旧数据与页码保留（36 行、条目 id 序列不变）；在列表区上方显示「列表刷新失败，显示的是上次数据」+ 一个
    //   button[data-catalog-act="retry-list"]（文字「重试」，不带 data-act）；data-catalog-state=error；在途展开（#52，请求被扣住、令牌已被 reloadStart 作废）变为 error 可重试，已 loaded 的 #50 / #53 保留旧内容；
    //   迟到的 #52 响应被核心丢弃；全程 showToast 0 次；不自动重试（负向等待后列表请求仍只有失败的那 1 次）；面板重试可用；点提示里的重试 → 恰发 1 次列表请求 → 成功套用后提示消失、回到 ready、展开项重新请求。
    console.log('W45 列表刷新失败');
    {
      expectErr('W45', U_LIST);
      const { page, reqs } = await open(adminN, 'W45', '', { beforeGoto: initSpies([]) });
      const g52 = gate();
      const counts = await routeRel(page, async (id, n) => { if (id === 52 && n === 1) await g52.p; return { json: id === 53 ? REL_COMP : tagRel(id, n) }; });
      await spyArrived(page);
      await toggleOf(page, 50); await toggleOf(page, 53);
      check('W45 前置：#50 / #53 面板 loaded（#50 内容 g50_1）', (await waitPane(page, 50, 'loaded')) && (await waitPane(page, 53, 'loaded')) && (await pInfo(page, 50)).text.includes('g50_1'));
      await toggleOf(page, 52);
      check('W45 前置：#52 的请求已到达路由并被扣住（面板加载中）', (await untilTrue(() => counts[52] === 1)) && (await pInfo(page, 52)).state === 'loading');
      const domBefore = await domIds(page);
      const n0 = await noticeInfo(page);
      check('W45 前置：失败前 data-catalog-state=ready，提示节点 hidden 且为空', !!n0 && n0.state === 'ready' && n0.hidden === true && n0.shown === false && n0.kids === 0, n0);
      let nList = 0;
      await page.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); nList++; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' }); });
      const r1 = await pageCallBounded(page, 'loadModels()');
      check("W45 列表重载 500：loadModels 返回 'failed'（恰发 1 次列表请求）", r1 === 'failed' && nList === 1, { r1, nList });
      const n1 = await noticeInfo(page);
      check('W45 失败后提示：可见，文字「列表刷新失败，显示的是上次数据」+ 恰 1 个 BUTTON（文字「重试」、data-catalog-act="retry-list"、不带 data-act），role=status；data-catalog-state=error', !!n1 && n1.shown === true && n1.text === MSG_REFRESH + '重试' && n1.nb === 1 && n1.tag === 'BUTTON' && n1.btnText === '重试' && n1.act === 'retry-list' && n1.dataAct === false && n1.role === 'status' && n1.state === 'error', n1);
      check('W45 旧数据保留：条目 id 序列不变（手写 PAGE1_21）、allModelsData 仍 36 行、当前页仍为 1', J(await domIds(page)) === J(domBefore) && J(domBefore) === J(PAGE1_21) && (await page.evaluate(() => allModelsData.length)) === 36 && (await page.evaluate(() => currentPage)) === 1, await domIds(page));
      check('W45 在途展开变为可重试：#52 面板 error（文字「关系加载失败」+ data-pane-act="retry" 按钮）；已 loaded 的 #50 仍 loaded 且内容仍是 g50_1、#53 仍 loaded；三个展开按钮仍是展开态', (await waitPane(page, 52, 'error')) && (await pInfo(page, 52)).text === '关系加载失败重试' && (await page.locator('#modelListBody [data-id="52"] > .pane [data-pane-act="retry"]').count()) === 1 && (await pInfo(page, 50)).state === 'loaded' && (await pInfo(page, 50)).text.includes('g50_1') && (await pInfo(page, 53)).state === 'loaded' && J(await expandedIdsDom(page)) === J([50, 52, 53]), { p52: await pInfo(page, 52), exp: await expandedIdsDom(page) });
      g52.release();
      check('W45 放行被扣住的 #52 响应：核心判为迟到丢弃（到达记录第 3 条 #52 discarded=true），#52 面板仍是 error', (await waitArrived(page, 3)) && (await arrivals(page))[2].id === '52' && (await arrivals(page))[2].discarded === true && (await pInfo(page, 52)).state === 'error', await arrivals(page));
      await stableCount(page, 800);
      check('W45 不自动重试：负向等待后列表请求仍只有失败的 1 次（路由与页面请求计数都是 1）', nList === 1 && reqs.n === 1, { nList, n: reqs.n });
      check('W45 失败全程没有 toast（showToast 0 次）', (await page.evaluate(() => window.__toasts.length)) === 0, await page.evaluate(() => window.__toasts));
      await clickIf(page, '#modelListBody [data-id="52"] > .pane [data-pane-act="retry"]', 'W45 前提：#52 的 error 面板里有重试按钮');
      check('W45 面板重试可用：#52 重新请求（第 2 次）→ loaded，内容是第 2 次请求的 g52_2', (await waitPane(page, 52, 'loaded')) && counts[52] === 2 && (await pInfo(page, 52)).text.includes('g52_2'), { c: counts[52] });
      await page.unroute(isList);
      const listReq = page.waitForRequest(isListReq, { timeout: WAIT }).catch(() => null);   // 先挂 catch：点击若失败，不能留下未处理的 rejection 把脚本带崩
      if (await clickIf(page, '#catalogListNotice [data-catalog-act="retry-list"]', 'W45 前提：提示里有重试按钮')) await listReq;
      check('W45 点提示里的重试：直接发 1 次列表请求，成功套用后 data-catalog-state 回到 ready', await page.waitForSelector('#modelListBody[data-catalog-state="ready"]', { timeout: WAIT }).then(() => true, () => false));
      await stableCount(page, 600);
      const n2 = await noticeInfo(page);
      check('W45 重试成功后：提示消失（hidden 且为空）；累计列表请求 2 次（失败 1 + 重试 1）；条目 id 序列仍是 PAGE1_21；仍无 toast', !!n2 && n2.hidden === true && n2.shown === false && n2.kids === 0 && n2.state === 'ready' && reqs.n === 2 && J(await domIds(page)) === J(PAGE1_21) && (await page.evaluate(() => window.__toasts.length)) === 0, { n2, n: reqs.n });
      check('W45 成功套用后展开项按核心规则重新请求：#50 / #53 重新加载（#50 内容为第 2 次请求的 g50_2），#52 也按重载规则重新请求', (await waitPane(page, 50, 'loaded')) && (await pInfo(page, 50)).text.includes('g50_2') && (await waitPane(page, 53, 'loaded')) && (await waitPane(page, 52, 'loaded')), { p50: await pInfo(page, 50) });
      await stableCount(page, 600);
      const p52 = await pInfo(page, 52);
      check('W45 刷新后每个展开项恰各重新请求一次（3d，40Tb-M3）：关系请求次数 #50 = 2、#53 = 2、#52 = 3（失败前 1 次 + 面板重试 1 次 + 刷新 1 次），#52 内容是第 3 次响应 g52_3', counts[50] === 2 && counts[53] === 2 && counts[52] === 3 && p52.text.includes('g52_3'), { counts, p52 });
      await page.close();
    }

    // ===== W45b 从第 2 页发起的列表刷新失败：页码与条目保留（3d，40Tb-M2）=====
    // 它锁的是：W45 在第 1 页上失败，「失败时 currentPage = 1」的实现照样过；这里从第 2 页发起——失败前后页码、条目 id 序列逐项相等（手写 ALL36.slice(21)）；
    //   点提示里的重试成功（数据不变）仍在第 2 页（D-13：保留当前页）；再失败一次后重试拿到只有 15 行的数据 → 越界夹到最后一个非空页（第 1 页）。
    console.log('W45b 第 2 页上的列表刷新失败');
    {
      expectErr('W45b', U_LIST);
      const { page } = await open(adminN, 'W45b');
      await page.evaluate(() => goToPage(2));
      const P2 = ALL36.slice(21);
      check('W45b 前置：在第 2 页，条目 id 序列 = 手写 ALL36.slice(21)（113…125, 6, 8）', (await page.evaluate(() => currentPage)) === 2 && J(await domIds(page)) === J(P2), await domIds(page));
      await failListRoute(page);
      const r1 = await pageCallBounded(page, 'loadModels()');
      const a1 = await page.evaluate(() => ({ page: currentPage, state: document.getElementById('modelListBody').getAttribute('data-catalog-state') }));
      const n1 = await noticeInfo(page);
      check("W45b 第 2 页上列表刷新 500：返回 'failed'、currentPage 仍是 2、条目 id 序列逐项不变、提示可见、data-catalog-state=error", r1 === 'failed' && a1.page === 2 && J(await domIds(page)) === J(P2) && !!n1 && n1.shown === true && a1.state === 'error', { r1, a1, ids: await domIds(page) });
      await page.unroute(isList);
      await clickIf(page, '#catalogListNotice [data-catalog-act="retry-list"]', 'W45b 前提：提示里有重试按钮');
      const ready1 = await page.waitForSelector('#modelListBody[data-catalog-state="ready"]', { timeout: WAIT }).then(() => true, () => false);
      check('W45b 点重试成功（数据不变）：回到 ready，仍在第 2 页（D-13 保留当前页），条目 id 序列仍是 P2', ready1 && (await page.evaluate(() => currentPage)) === 2 && J(await domIds(page)) === J(P2), { cp: await page.evaluate(() => currentPage) });
      await failListRoute(page);
      await pageCallBounded(page, 'loadModels()');
      await page.unroute(isList);
      await page.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); const resp = await route.fetch(); const rows = await resp.json(); await route.fulfill({ response: resp, body: JSON.stringify(rows.slice(0, 15)) }); });
      await clickIf(page, '#catalogListNotice [data-catalog-act="retry-list"]', 'W45b 前提：再次失败后提示里有重试按钮');
      const ready2 = await page.waitForSelector('#modelListBody[data-catalog-state="ready"]', { timeout: WAIT }).then(() => true, () => false);
      const v2 = await view(page);
      check('W45b 再次失败后点重试拿到 15 行：越界夹到最后一个非空页（第 1 页）', ready2 && v2.totalModels === 15 && v2.page === 1 && (await page.evaluate(() => currentPage)) === 1, { m: v2.totalModels, p: v2.page });
      await page.unroute(isList);
      await page.close();
    }

    // ===== W46 首次加载失败 + ?focus / ?id 不执行 =====
    // 它锁的是（派单 §2.3）：列表第一次就加载失败：data-catalog-state=error（不是 ready）、没有条目、提示「列表加载失败」+ 同一个重试按钮、无 toast；MC 初始化的 ?focus / ?id&edit 分支只在 'arrived' 时执行——
    //   失败时 focusCatalogModel / openEditModal 都不被调用（旧写法会因列表为空而弹「模型不存在或已删除」）、地址栏的 focus 参数不被清理；点重试成功后回到 ready，条目出现，初始化分支不再补跑。
    //   更正（3c，预筛 MED-1）：W46b 只是「失败时不报错」的冒烟检查——首次加载失败时 allModelsData 为空，?id 分支本来就找不到目标，去掉 'arrived' 门它也绿（实测 init-no-gate 下 W46b 两条 PASS）。
    //   'arrived' 门对 'discarded'（初始化请求被取代）的拦截由 W46c / W46d 判；门本身另有 VCC W:list-init 静态判据。
    console.log('W46 首次加载失败');
    {
      expectErr('W46', U_LIST); expectErr('W46b', U_LIST);
      const { page } = await open(adminN, 'W46', '?focus=8', { noRows: true, beforeGoto: async (pg) => { await initSpies(['focusCatalogModel', 'openEditModal'])(pg); await failListRoute(pg); } });
      const hasErr = await page.waitForSelector('#modelListBody[data-catalog-state="error"]', { state: 'attached', timeout: WAIT }).then(() => true, () => false);
      check('W46 首次加载 500：data-catalog-state=error（等待有界；不是 ready）', hasErr);
      const f1 = await noticeInfo(page);
      check('W46 提示是「列表加载失败」（不是「刷新失败」）+ 恰 1 个重试按钮 data-catalog-act="retry-list"；没有条目（allModelsData 为空）', !!f1 && f1.shown === true && f1.text === MSG_FIRST + '重试' && f1.nb === 1 && f1.act === 'retry-list' && f1.dataAct === false && f1.state === 'error' && (await domIds(page)).length === 0 && (await page.evaluate(() => allModelsData.length)) === 0, f1);
      const st = await page.evaluate(() => ({ fc: window.__spied.focusCatalogModel.length, toasts: window.__toasts.length, hl: document.querySelectorAll('[data-focus-highlight]').length, cp: currentPage, focusInUrl: new URL(location.href).searchParams.get('focus') }));
      check('W46 ?focus=8 在失败时不执行：focusCatalogModel 调用 0 次、无 toast（旧写法会弹「模型不存在或已删除」）、无高亮、仍在第 1 页、地址栏 focus=8 未被清理', st.fc === 0 && st.toasts === 0 && st.hl === 0 && st.cp === 1 && st.focusInUrl === '8', st);
      await page.evaluate(() => { window.__rm = 0; const o = window.renderModelsPage; window.renderModelsPage = function () { window.__rm++; return o.apply(this, arguments); }; });   // 3c：数这两次输入确实触发了渲染（否则下面的「不显示空态」可能是没渲染的空话）
      await page.fill('#searchKeyword', 'dim_');
      const f2 = await noticeInfo(page);
      check('W46 错误态下输入搜索词（触发重渲染）：data-catalog-state 仍是 error（重渲染不把它改成 ready），提示仍在', !!f2 && f2.state === 'error' && f2.shown === true && f2.text === MSG_FIRST + '重试', f2);
      await page.fill('#searchKeyword', '');
      const f5 = await page.evaluate(() => ({ rm: window.__rm, empty: document.querySelectorAll('#modelListBody .catalog-empty').length, rows: document.querySelectorAll('#modelListBody [data-id]').length }));
      const f6 = await noticeInfo(page);
      check('W46 从未加载成功时重渲染（输入搜索词再清空，renderModelsPage ≥ 2 次）：列表区不显示「暂无模型数据」（与「列表加载失败」提示矛盾），没有条目，提示仍在、仍是 error', f5.rm >= 2 && f5.empty === 0 && f5.rows === 0 && !!f6 && f6.shown === true && f6.text === MSG_FIRST + '重试' && f6.state === 'error', { f5, f6 });
      await page.unroute(isList);
      await clickIf(page, '#catalogListNotice [data-catalog-act="retry-list"]', 'W46 前提：提示里有重试按钮');
      check('W46 点重试成功：data-catalog-state=ready，条目出现（第 1 页 21 个 = PAGE1_21），提示消失', (await page.waitForSelector('#modelListBody[data-catalog-state="ready"]', { timeout: WAIT }).then(() => true, () => false)) && J(await domIds(page)) === J(PAGE1_21) && (await noticeInfo(page)).hidden === true);
      const st2 = await page.evaluate(() => ({ fc: window.__spied.focusCatalogModel.length, toasts: window.__toasts.length, hl: document.querySelectorAll('[data-focus-highlight]').length }));
      check('W46 重试成功后初始化分支不补跑：focusCatalogModel 仍 0 次、仍无 toast、无高亮', st2.fc === 0 && st2.toasts === 0 && st2.hl === 0, st2);
      await page.close();
      const { page: p2 } = await open(adminN, 'W46b', '?id=50&edit=1', { noRows: true, beforeGoto: async (pg) => { await initSpies(['openEditModal', 'highlightModel'])(pg); await failListRoute(pg); } });
      check('W46b ?id=50&edit=1 首次加载 500：data-catalog-state=error', await p2.waitForSelector('#modelListBody[data-catalog-state="error"]', { state: 'attached', timeout: WAIT }).then(() => true, () => false));
      await stableCount(p2, 600);
      const st3 = await p2.evaluate(() => ({ oe: window.__spied.openEditModal.length, hm: window.__spied.highlightModel.length, toasts: window.__toasts.length }));
      check("W46b（冒烟，判别不了「去掉 'arrived' 门」，门由 W46c / W46d 判）?id=…&edit=1 首次加载失败时不报错：openEditModal 0 次、highlightModel 0 次、无 toast", st3.oe === 0 && st3.hm === 0 && st3.toasts === 0, st3);
      await p2.close();
    }

    // ===== W46c / W46d 初始化请求被取代时 ?focus / ?id 不执行（预筛 MED-1；主会话裁定 P2）=====
    // 它锁的是：MC 初始化只认「初始化那次 loadModels 自己的 'arrived'」——初始化请求（被闸门扣住）之后页内直接 loadModels() 先成功套用（36 行已在），再放行初始化请求使其返回 'discarded'：
    //   ?focus=8 → focusCatalogModel 调用 0 次、地址栏 focus 不被清理；?id=50&edit=1 → openEditModal / highlightModel 各 0 次、地址栏不被清理。去掉 'arrived' 门（init-no-gate）或把门放宽成只拦 'failed'（init-gate-failed-only）都会让它们判红。
    //   这里数据其实已到（取代者先到），仍不执行：真实使用中初始化请求几乎不会被取代（初始化时没有写请求、重试按钮只在失败后出现），规则保持「只认初始化请求自己的 'arrived'」最简单。
    /** 先于页面自己的 DOMContentLoaded 回调：给 loadModels 套透传包装，记下第一次调用（MC 初始化那次）的 promise 与结果（__initP / __initRes） */
    const initLoadSpy = async (pg) => {
      await pg.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const o = window.loadModels; window.__initP = null; window.__initRes = undefined;
          window.loadModels = function () { const p = o.apply(this, arguments); if (window.__initP === null) { window.__initP = p; p.then((v) => { window.__initRes = v; }, () => { window.__initRes = 'threw'; }); } return p; };
          window.loadModels.toString = function () { return o.toString(); };   // 包装对页内变异的探针与 toString 替换透明（探针读 loadModels.toString() 看到的是原函数源码）
        });
      });
    };
    const REPLACES_LOADMODELS = ['no-token', 'seen-at-arrival', 'seen-on-failure'].includes(MUT);   // 这三个页内变异在页面装载后整体替换 window.loadModels，会盖掉下面的旁听包装；它们的目标用例不在 W46c / W46d
    const supersededInit = async (label, query, names) => {
      if (REPLACES_LOADMODELS) { console.log('  （' + label + ' 跳过：变异 ' + MUT + ' 整体替换 loadModels，盖掉初始化旁听包装）'); return null; }
      const g = gate(); let nList = 0;
      const { page } = await open(adminN, label, query, { noRows: true, noIdle: true, beforeGoto: async (pg) => {
        await initSpies(names)(pg); await initLoadSpy(pg);
        await pg.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); nList++; if (nList === 1) await g.p; return route.continue(); });
      } });
      const held = await untilTrue(() => nList >= 1);
      const pre = await page.evaluate(() => ({ started: window.__initP !== null, res: window.__initRes, n: allModelsData.length }));
      check(label + ' 前置：初始化的列表请求已被扣住（初始化的 loadModels 已调用、尚未返回、无数据）', held && pre.started && pre.res === undefined && pre.n === 0, { held, pre });
      const nBefore = nList;
      const direct = await loadBounded(page);   // 3d（40Tb-M1）有界：错误实现若复用被扣住的初始化请求，这里等不到；超时记 FAIL 并放行闸门
      if (direct === '__timeout__') g.release();
      check(label + ' 前置：页内直接 loadModels() 确实发出了第二次列表请求（路由收到的 GET /api/models 比调用前多）', await untilTrue(() => nList > nBefore), { nBefore, nList });
      const mid = await page.evaluate(() => ({ n: allModelsData.length, state: document.getElementById('modelListBody').getAttribute('data-catalog-state'), res: window.__initRes }));
      check(label + " 前置：页内直接 loadModels() 先成功（返回 'arrived'）、36 行已套用、data-catalog-state=ready，初始化请求仍未返回", direct === 'arrived' && mid.n === 36 && mid.state === 'ready' && mid.res === undefined, { direct, mid });
      g.release();
      const initRes = await page.evaluate((ms) => Promise.race([(window.__initP || Promise.resolve('__no_init_promise__')).then((v) => v, () => 'threw'), new Promise((r) => setTimeout(() => r('__timeout__'), ms))]).then((v) => new Promise((r) => setTimeout(() => r(v), 0))), WAIT);   // 页面自己的 .then 先于本 .then 登记，先于它执行；再排一个 setTimeout(0) 栅栏
      check(label + " 放行后：初始化的 loadModels 返回 'discarded'（被页内直接调用的那次取代）", initRes === 'discarded', initRes);
      return page;
    };
    console.log('W46c 初始化请求被取代：?focus');
    {
      const page = await supersededInit('W46c', '?focus=8', ['focusCatalogModel']);
      if (page) {
      const st = await page.evaluate(() => ({ fc: window.__spied.focusCatalogModel.length, toasts: window.__toasts.length, hl: document.querySelectorAll('[data-focus-highlight]').length, cp: currentPage, focusInUrl: new URL(location.href).searchParams.get('focus') }));
      check('W46c ?focus=8 在初始化请求被取代时不执行：focusCatalogModel 调用 0 次、无 toast、无高亮、仍在第 1 页、地址栏 focus=8 未被清理', st.fc === 0 && st.toasts === 0 && st.hl === 0 && st.cp === 1 && st.focusInUrl === '8', st);
      await page.close();
      }
    }
    console.log('W46d 初始化请求被取代：?id&edit');
    {
      const page = await supersededInit('W46d', '?id=50&edit=1', ['openEditModal', 'highlightModel']);
      if (page) {
      const st = await page.evaluate(() => ({ oe: window.__spied.openEditModal.length, hm: window.__spied.highlightModel.length, toasts: window.__toasts.length, id: new URL(location.href).searchParams.get('id'), edit: new URL(location.href).searchParams.get('edit') }));
      check('W46d ?id=50&edit=1 在初始化请求被取代时不执行：openEditModal 0 次、highlightModel 0 次、无 toast、地址栏 id=50&edit=1 未被清理', st.oe === 0 && st.hm === 0 && st.toasts === 0 && st.id === '50' && st.edit === '1', st);
      await page.close();
      }
    }

    // ===== W47 数据到达前不设 ready =====
    // 它锁的是（派单 §2.3 ready 口径，2a 预筛 LOW-1）：data-catalog-state="ready" 只在「列表数据至少成功套用过一次」之后的渲染里设置——首次列表请求被扣住期间输入搜索词、点排序（两次都真的触发了 renderModelsPage）
    //   属性仍不是 ready（也不是 error，即没有该属性）、没有条目；放行后到达 → ready、条目出现。
    console.log('W47 数据到达前不设 ready');
    {
      const gH = gate(); let nH = 0;
      const { page } = await open(adminN, 'W47', '', { noRows: true, noIdle: true, beforeGoto: async (pg) => { await pg.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); nH++; await gH.p; return route.continue(); }); } });
      check('W47 前置：首次列表请求已到达路由（被扣住）', await untilTrue(() => nH >= 1));
      await page.evaluate(() => { window.__rm = 0; const o = window.renderModelsPage; window.renderModelsPage = function () { window.__rm++; return o.apply(this, arguments); }; });
      await page.fill('#searchKeyword', 'dim_');
      await page.locator('button[data-sort-by="id"]').click();
      const pre = await page.evaluate(() => ({ rm: window.__rm, state: document.getElementById('modelListBody').getAttribute('data-catalog-state'), rows: document.querySelectorAll('#modelListBody [data-id]').length, empty: document.querySelectorAll('#modelListBody .catalog-empty').length, applied: catalogListApplied, len: allModelsData.length }));
      check('W47 数据到达前输入搜索词并点排序：renderModelsPage 被调用 ≥ 2 次（交互确实触发了渲染），data-catalog-state 不存在（不是 ready，也不是 error）、没有条目、不显示「暂无模型数据」（数据还没到，不是空）、allModelsData 为空', pre.rm >= 2 && pre.state === null && pre.rows === 0 && pre.empty === 0 && pre.applied === false && pre.len === 0, pre);
      gH.release();
      check('W47 放行后数据到达：data-catalog-state=ready，有条目', (await page.waitForSelector('#modelListBody[data-catalog-state="ready"]', { timeout: WAIT }).then(() => true, () => false)) && (await page.$$eval('#modelListBody [data-id]', (e) => e.length)) > 0);
      await page.close();
    }

    // ===== W48 loadModels 三态返回值 =====
    // 它锁的是（派单 §2.3）：成功套用 → 'arrived'；被更新的请求取代 → 'discarded'（先发的那次；后发的 'arrived'）；失败 → 'failed'（W4b / W45 / W46 已覆盖各失败形态）。
    console.log('W48 loadModels 三态');
    {
      const { page } = await open(adminN, 'W48');
      const a = await pageCallBounded(page, 'loadModels()');
      check("W48 成功套用：返回 'arrived'", a === 'arrived', a);
      const both = await page.evaluate(async (ms) => { const to = () => new Promise((res) => setTimeout(() => res('__timeout__'), ms)); const x = loadModels(); const y = loadModels(); return [await Promise.race([x, to()]), await Promise.race([y, to()])]; }, WAIT);
      check("W48 两次并发调用：先发的被取代返回 'discarded'，后发的返回 'arrived'", J(both) === J(['discarded', 'arrived']), both);
      await page.close();
    }

    // ===== W49 上游名匹配与后端 asciiLower 同口径 =====
    // 它锁的是（3a 待裁定 ②，后端 routes/model-center/model-relations.js 的 asciiLower：仅 ASCII 字母转小写）：上游名与列表表名按同一归一化比较——
    //   ①大小写变体命中并成链接（上游「ODS_W0001_DF」→ #6「ods_w0001_df」；上游「Uniq_Case_Y」→ #103「uniq_case_y」），链接文字保留上游名原样；②归一化后命中多行（#101「Dup_Name_X」与 #102「dup_NAME_x」；#105 / #106 同为「same_name_z」）→ 纯文本；
    //   ③命中的是自己（本模型表名的大写形态）→ 纯文本；④非 ASCII 不折叠（#104「ΣIGMA_t」与上游「σigma_t」不相等；toLowerCase 会把 Σ 折成 σ 而误成链接）；⑤原样同名（「ods_w0001_df」）仍成链接。
    console.log('W49 上游名匹配');
    {
      const { page } = await open(adminN, 'W49', '', { beforeGoto: rewriteList(patchRows({ 101: { table_name: 'Dup_Name_X' }, 102: { table_name: 'dup_NAME_x' }, 103: { table_name: 'uniq_case_y' }, 104: { table_name: 'ΣIGMA_t' }, 105: { table_name: 'same_name_z' }, 106: { table_name: 'same_name_z' } })) });
      const own = await page.evaluate(() => allModelsData.find((r) => r.id === 55).table_name);
      const REL_M = { upstream: [{ name: 'ODS_W0001_DF' }, { name: 'Uniq_Case_Y' }, { name: 'dup_name_x' }, { name: 'σigma_t' }, { name: own.toUpperCase() }, { name: 'same_name_z' }, { name: 'ods_w0001_df' }], downstream: [], objects: [], objectState: 'standard' };
      await routeRel(page, async () => ({ json: REL_M }));
      await toggleOf(page, 55);
      const ok = await waitPane(page, 55, 'loaded');
      const a = await readLoaded(page, 55);
      const it = (i) => (a && a.up.items[i]) || { links: ['缺'], plain: ['缺'] };
      check('W49 前置：#55 面板 loaded，上游 7 项', ok && !!a && a.up.count === '7' && a.up.items.length === 7, a && a.up.count);
      check('W49 ①大小写变体命中：上游「ODS_W0001_DF」→ 链接 [6, ODS_W0001_DF]（链接文字保留上游原样）', J(it(0).links) === J([['6', 'ODS_W0001_DF']]) && it(0).plain.length === 0, it(0));
      check('W49 ①上游「Uniq_Case_Y」→ 链接 [103, Uniq_Case_Y]（#103 的表名是小写 uniq_case_y）', J(it(1).links) === J([['103', 'Uniq_Case_Y']]), it(1));
      check('W49 ②归一化后命中 2 行（#101「Dup_Name_X」、#102「dup_NAME_x」）：上游「dup_name_x」→ 纯文本，不成链接', it(2).links.length === 0 && J(it(2).plain) === J(['dup_name_x']), it(2));
      check('W49 ④非 ASCII 不折叠：上游「σigma_t」与 #104「ΣIGMA_t」（ASCII 归一化后 Σigma_t ≠ σigma_t）不相等 → 纯文本', it(3).links.length === 0 && J(it(3).plain) === J(['σigma_t']), it(3));
      check('W49 ③命中的只有自己（本模型表名的大写形态）→ 纯文本，不链到自己', it(4).links.length === 0 && J(it(4).plain) === J([own.toUpperCase()]), it(4));
      check('W49 ②表名完全相同的两行（#105 / #106 都叫 same_name_z）：上游「same_name_z」→ 纯文本（不再取第一行）', it(5).links.length === 0 && J(it(5).plain) === J(['same_name_z']), it(5));
      check('W49 ⑤原样同名「ods_w0001_df」仍成链接 [6, ods_w0001_df]', J(it(6).links) === J([['6', 'ods_w0001_df']]), it(6));
      await page.close();
    }

    // ===== W49b 本模型与另一模型归一化后同名（3d，40Tb-M4）=====
    // 它锁的是：上游名等于本模型表名、而另一条记录的表名与它只差大小写（ASCII 归一化后同名）→ 命中 2 行 → 纯文本。先排除自己再数命中的实现（up-exclude-self-first）会把它链到另一条记录。W49 ③（唯一命中自己）保留。
    console.log('W49b 本模型与他人归一化同名');
    {
      const { page } = await open(adminN, 'W49b', '', { beforeGoto: rewriteList((rows) => { const o = rows.find((r) => r.id === 50); return patchRows({ 108: { table_name: String(o.table_name).toUpperCase() }, 109: { table_name: 'ODS_X_UP' } })(rows); }) });
      const own = await page.evaluate(() => allModelsData.find((r) => r.id === 50).table_name);
      const twin = await page.evaluate(() => allModelsData.find((r) => r.id === 108).table_name);
      await routeRel(page, async () => ({ json: { upstream: [{ name: own }, { name: 'ods_w0001_df' }, { name: 'ods_x_up' }], downstream: [], objects: [], objectState: 'standard' } }));
      await toggleOf(page, 50);
      const ok = await waitPane(page, 50, 'loaded');
      const a = await readLoaded(page, 50);
      const it = (i) => (a && a.up.items[i]) || { links: ['缺'], plain: ['缺'] };
      check('W49b 前置：#108 的表名是 #50 表名的大写形态（原样不同、归一化后同名）；#109 的表名被改成含大写的 ODS_X_UP；#50 面板 loaded、上游 3 项', ok && twin === own.toUpperCase() && twin !== own && (await page.evaluate(() => allModelsData.find((r) => r.id === 109).table_name)) === 'ODS_X_UP' && !!a && a.up.items.length === 3, { own, twin });
      check('W49b 上游名 = 本模型 #50 的表名，归一化后命中 2 行（#50 自己 + #108）→ 纯文本，不链到 #108', it(0).links.length === 0 && J(it(0).plain) === J([own]), it(0));
      check('W49b 对照：上游「ods_w0001_df」唯一命中 #6 → 链接 [6, ods_w0001_df]', J(it(1).links) === J([['6', 'ods_w0001_df']]), it(1));
      // 3d 追加（40Tc-L1 采纳）：候选行（列表里的表名）含大写、上游名全小写 → 两侧都归一化后唯一命中 → 链接；只归一化输入侧（up-input-only）会因候选行 ODS_X_UP 未折叠而落成纯文本
      check('W49b 候选行表名含大写：列表里 #109 叫「ODS_X_UP」，上游名「ods_x_up」（全小写）→ 唯一命中 → button[data-open-model] 链接 [109, ods_x_up]（链接文字保留上游原样），不是纯文本', J(it(2).links) === J([['109', 'ods_x_up']]) && it(2).plain.length === 0, it(2));
      await page.close();
    }
    // ===== W50 列表成功返回空数组 =====
    // 它锁的是（预筛 LOW-4）：列表请求成功但返回 []——这是「成功套用」，不是失败也不是没到：data-catalog-state=ready，列表区显示「暂无模型数据」，没有条目，P28 提示隐藏且为空。
    //   把 ready 写成按 allModelsData.length > 0 的诚实错误实现（ready-needs-rows）会在这里判红。
    console.log('W50 列表为空');
    {
      const { page } = await open(adminN, 'W50', '', { noRows: true, beforeGoto: async (pg) => { await pg.route(isList, (route) => (route.request().method() !== 'GET' ? route.continue() : route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))); } });
      const okReady = await page.waitForSelector('#modelListBody[data-catalog-state="ready"]', { state: 'attached', timeout: WAIT }).then(() => true, () => false);
      const info = await noticeInfo(page);
      const empties = await page.$$eval('#modelListBody .catalog-empty', (e) => e.map((x) => x.textContent));
      const cnt = await page.evaluate(() => ({ len: allModelsData.length, applied: catalogListApplied, err: catalogListError }));
      check('W50 列表成功返回 []：data-catalog-state=ready（等待有界；不是 error，也不是缺省）、列表区显示「暂无模型数据」、没有条目、allModelsData 为空且已套用、P28 提示隐藏且为空', okReady && J(empties) === J(['暂无模型数据']) && (await domIds(page)).length === 0 && cnt.len === 0 && cnt.applied === true && cnt.err === false && !!info && info.hidden === true && info.shown === false && info.kids === 0 && info.state === 'ready', { okReady, empties, cnt, info });
      await page.close();
    }

    // ===== W51 关系响应畸形：面板 error 且可重试（codex 40 M1）=====
    // 它锁的是：/relations 响应通过顶层形状校验、但元素畸形——下游含 null、上游元素的 name 是 {"toString":0}（String() 会抛）、实现对象缺 obj_name、下游 id 不是正整数——一律按加载失败处理：
    //   面板进入 error（文字「关系加载失败」+ 重试按钮），不静默丢掉坏元素、也不停在加载中；点重试后拿到合法响应（第 2 次请求）→ loaded。校验退回只查顶层（rel-validate-top-only）会让它们判红。
    console.log('W51 关系响应畸形');
    {
      const BAD = [
        ['下游含 null 元素', { upstream: [], downstream: [null], objects: [], objectState: 'standard' }],
        ['上游元素的 name 是 {"toString":0}（String() 会抛）', { upstream: [{ name: { toString: 0 } }], downstream: [], objects: [], objectState: 'standard' }],
        ['实现对象缺 obj_name', { upstream: [], downstream: [], objects: [{ obj_type: 'PROC', schema_name: 'dbo', summary: null, role: null, verified_at: null, badges: { doc: null, reg: null } }], objectState: 'listed' }],
        ['下游元素 id 不是正整数', { upstream: [], downstream: [{ id: 0, table_name: 'x_down', table_comment: null }], objects: [], objectState: 'standard' }],
      ];
      for (const [label, body] of BAD) {
        const { page } = await open(adminN, 'W51', '');
        const counts = await routeRel(page, async (id, n) => ({ json: n === 1 ? body : tagRel(id, n) }));
        await toggleOf(page, 50);
        const isErr = await waitPane(page, 50, 'error');
        const pi = await pInfo(page, 50);
        check('W51 ' + label + '：面板进入 error（文字「关系加载失败」+ 1 个重试按钮），不是 loaded，也不停在加载中', isErr && pi.text === '关系加载失败重试' && (await page.locator('#modelListBody [data-id="50"] > .pane [data-pane-act="retry"]').count()) === 1, pi);
        await clickIf(page, '#modelListBody [data-id="50"] > .pane [data-pane-act="retry"]', 'W51 ' + label + ' 前提：error 面板里有重试按钮');
        check('W51 ' + label + '：点重试 → 第 2 次请求拿到合法响应 → loaded，内容是第 2 次的 g50_2', (await waitPane(page, 50, 'loaded')) && counts[50] === 2 && (await pInfo(page, 50)).text.includes('g50_2'), { c: counts[50] });
        await page.close();
      }
    }
    // ====================================================================================================================
    // 子批 4a（C4c-4）：W52 起（页头 P21 / 工具条 / P36 页面层 / 筛选单一来源）。约定同 W36 起：期望值全部手写，等待绑在被断言对象上且有界。
    // ====================================================================================================================

    // ===== W52 页头（P21）=====
    // 它锁的是：①页面恰有 1 个 h1「模型中心」，副标题「数仓模型登记与验收 · 在册 N 个模型」，N 在 #catalogTotalCount 里：数据到达前是「—」（不是 0），到达后 = 夹具 36 行（含伴生 #53；35 组 ≠ 36 行，
    //   「按组计数」「不含伴生」都会得 35），列表刷新失败不改（仍 36），之后一次成功重载（路由只返回前 15 行）更新为 15；②「批量导入」「＋ 注册新模型」在页头右上（.catalog-pageactions），不在列表标题栏；
    //   admin 两个都可见，注册按钮 id / onclick 不变、点击跳 Model_Workbench.html，批量导入点击打开 #batchImportModal；③viewer 的注册按钮被隐藏（MC 初始化逻辑不变，仍生效）。
    console.log('W52 页头（P21）');
    {
      expectErr('W52a', U_LIST);
      const gH = gate(); let nH = 0;
      const { page } = await open(adminN, 'W52a', '', { noRows: true, noIdle: true, beforeGoto: async (pg) => { await pg.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); nH++; await gH.p; return route.continue(); }); if (MUT === 'err-domains-500-in-w52a') await pg.route(isDomains, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' })); } });
      check('W52 前置：首次列表请求已到达路由（被扣住）', await untilTrue(() => nH >= 1));
      const pre = await page.evaluate(() => ({ h1: Array.from(document.querySelectorAll('h1')).map((h) => h.textContent), sub: (document.querySelector('.catalog-pagesub') || { textContent: null }).textContent, n: (document.getElementById('catalogTotalCount') || { textContent: null }).textContent, inMain: !!document.querySelector('main.workbench-container > .catalog-pagehead h1'),
        vis: (() => { const h = document.querySelector('.catalog-pagehead h1'); if (!h) return null; const cs = getComputedStyle(h); const r = h.getBoundingClientRect(); return { display: cs.display, align: cs.textAlign, w: Math.round(r.width), hgt: Math.round(r.height) }; })() }));
      check('W52 数据到达前：全页恰 1 个 h1「模型中心」（在 main 的页头里）；在册数是「—」（不是 0），副标题「数仓模型登记与验收 · 在册 — 个模型」', J(pre.h1) === J(['模型中心']) && pre.inMain === true && pre.n === '—' && pre.sub === '数仓模型登记与验收 · 在册 — 个模型', pre);
      check('W52 h1 真的可见：计算样式 display 不是 none（style.css 有全局 h1 { display: none }，页头必须显式覆盖）、有宽高、文字靠左（全局 h1 是居中）', !!pre.vis && pre.vis.display !== 'none' && pre.vis.w > 0 && pre.vis.hgt > 0 && (pre.vis.align === 'left' || pre.vis.align === 'start'), pre.vis);
      gH.release();
      await page.waitForSelector('#modelListBody [data-id]', { timeout: WAIT });
      const post = await page.evaluate(() => ({ sub: document.querySelector('.catalog-pagesub').textContent, n: document.getElementById('catalogTotalCount').textContent }));
      check('W52 数据到达后：在册数 36（夹具 36 行含伴生 #53；按组计数会得 35），副标题「数仓模型登记与验收 · 在册 36 个模型」', post.n === '36' && post.sub === '数仓模型登记与验收 · 在册 36 个模型', post);
      await page.route(isList, (route) => (route.request().method() !== 'GET' ? route.continue() : route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' })));
      const rFail = await loadBounded(page);
      check("W52 列表刷新失败（HTTP 500，loadModels 返回 'failed'）：在册数不改，仍是 36", rFail === 'failed' && (await page.textContent('#catalogTotalCount')) === '36', { rFail, n: await page.textContent('#catalogTotalCount') });
      await page.unroute(isList);
      await page.route(isList, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const resp = await route.fetch(); const rows = await resp.json();
        await route.fulfill({ response: resp, body: JSON.stringify(rows.slice(0, 15)) });
      });
      const rOk = await loadBounded(page);
      check("W52 一次成功重载（路由只返回前 15 行）：返回 'arrived'，在册数更新为 15（= 行数）", rOk === 'arrived' && (await page.textContent('#catalogTotalCount')) === '15', { rOk, n: await page.textContent('#catalogTotalCount') });
      await page.unroute(isList);
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W52b');
      const b = await page.evaluate(() => {
        const vis = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
        const reg = document.getElementById('registerNewModelBtn');
        const bi = Array.from(document.querySelectorAll('.catalog-pageactions button')).find((x) => /批量导入/.test(x.textContent));
        const head = document.querySelector('.catalog-pagehead'); const sec = document.getElementById('modelListSection');
        return { regN: document.querySelectorAll('#registerNewModelBtn').length, regIn: !!(reg && reg.closest('.catalog-pageactions')), regText: reg && reg.textContent, regOn: reg && reg.getAttribute('onclick'), regVis: vis(reg),
          bi: !!bi, biVis: vis(bi), biOn: bi && bi.getAttribute('onclick'), biText: bi && bi.textContent.trim(),
          zones: ['.catalog-toolbar', '.catalog-head', '#modelListBody', '#paginationContainer', '#catalogListNotice'].map((z) => sec.querySelectorAll(z + ' input, ' + z + ' button').length),
          stray: Array.from(sec.querySelectorAll('input, button')).filter((e) => !e.closest('.catalog-toolbar, .catalog-head, #modelListBody, #paginationContainer, #catalogListNotice')).map((e) => e.tagName + '#' + e.id + ':' + e.textContent.slice(0, 12)), regInSec: !!sec.querySelector('#registerNewModelBtn'), biInSec: Array.from(sec.querySelectorAll('button')).some((x) => /批量导入/.test(x.textContent)),
          before: !!(head && sec && (head.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING)) };
      });
      check('W52 admin 页头：#registerNewModelBtn 恰 1 个、在页头右上、文字「＋ 注册新模型」、onclick 仍是跳 Model_Workbench.html、可见', b.regN === 1 && b.regIn === true && b.regText === '＋ 注册新模型' && b.regOn === "window.location.href='Model_Workbench.html'" && b.regVis === true, b);
      check('W52 admin 页头：「批量导入」按钮在页头右上、onclick 仍是 openBatchImportModal()、可见；两个入口都不在列表区块（#modelListSection）里；列表区块里的 input / button 只出现在工具条、列头、列表条目、分页、列表提示里（4d：旧断言查 .section-title，该节点早已删除、恒为 0 是死断言，改为统计区块内不在这五处的 input / button，并带正向计数：工具条 6 个控件〔搜索框 + 搜索按钮 + 3 个排序键 + 全部收起〕、列头 5 个排序键、列表与分页非空）；页头在列表区块之前', b.bi === true && b.biVis === true && b.biOn === 'openBatchImportModal()' && b.biText === '批量导入' && b.regInSec === false && b.biInSec === false && b.stray.length === 0 && b.zones[0] === 6 && b.zones[1] === 5 && b.zones[2] > 0 && b.zones[3] > 0 && b.before === true, b);
      // 按文字找按钮（不按 onclick 属性找：onclick 被改坏时按钮仍要能被点到，红在「点击后的行为」上而不是找不到元素抛超时）；前提不成立判红并跳过，不空转
      if (await clickIf(page, '.catalog-pageactions button:has-text("批量导入")', 'W52 前提：页头里有可点的「批量导入」按钮')) {
        const modalOpen = await page.waitForSelector('#batchImportModal', { state: 'visible', timeout: WAIT }).then(() => true, () => false);
        check('W52 点「批量导入」：#batchImportModal 打开（可见）', modalOpen);
        await page.evaluate(() => closeBatchImportModal());
      }
      if (await clickIf(page, '.catalog-pageactions button:has-text("注册新模型")', 'W52 前提：页头里有可点的「注册新模型」按钮')) {
        const okNav = await page.waitForURL(/Model_Workbench\.html/, { timeout: WAIT }).then(() => true, () => false);
        check('W52 点「＋ 注册新模型」：跳到 Model_Workbench.html', okNav);
      }
      await page.close();
    }
    {
      const vctx = await mkCtx(USERS[1]);
      const { page } = await open(vctx, 'W52v');
      const v = await page.evaluate(() => {
        const reg = document.getElementById('registerNewModelBtn');
        return { exists: !!reg, hidden: !!reg && (getComputedStyle(reg).display === 'none' || reg.getClientRects().length === 0), inHead: !!(reg && reg.closest('.catalog-pageactions')), n: document.getElementById('catalogTotalCount').textContent, h1: Array.from(document.querySelectorAll('h1')).map((h) => h.textContent) };
      });
      check('W52 viewer：注册按钮在页头里但被隐藏（MC 的 viewer 隐藏逻辑仍生效）；页头与在册数 36 照常显示', v.exists === true && v.inHead === true && v.hidden === true && v.n === '36' && J(v.h1) === J(['模型中心']), v);
      await page.close(); await vctx.close();
    }

    // ===== W53 工具条 =====
    // 它锁的是：#modelListSection 里的 div.catalog-toolbar 依次是 搜索框（#searchKeyword 元素原样迁移：id / placeholder / oninput / onkeyup 不变）→「搜索」按钮 →「排序：」→ 三个排序键 updated_at / domain / id →「全部收起」；
    //   列头恰 5 个排序键（layer / table_name / status / acceptance_at / tech_owner），全页 button[data-sort-by] 恰这 8 个键；旧排序条（.catalog-sortbar）已不存在；工具条在列头之前；工具条里的排序键可用。
    console.log('W53 工具条');
    {
      // codex 41Tb-M1：工具条排序键点击后立即断言手写的 DOM 序。夹具：路由把每个组主模型的 updated_at 逐个补丁——UPD_ORDER 是「最旧 → 最新」的组主模型序列（伴生 #53 与主模型 #52 同时间）。
      //   默认序是 ALL36（table_name 升序：60,50,55,58,62,65,52+53,59,101…125,6,8），UPD_ORDER 取「默认序的组列表向左旋转 5 位」：65,52,59 | 101…125 | 6,8 | 60,50,55,58,62，所以 updated_at 升序、降序都与默认序不同，
      //   也与 id 升降序、domain 升降序（下面手写）都不同。降序 = UPD_ORDER 反序（伴生仍紧跟主模型）；第 1 页 = 前 20 组。
      const UPD_ORDER = [65, 52, 59].concat(range(101, 125), [6, 8, 60, 50, 55, 58, 62]);
      const dayOf = (k) => (k < 31 ? '2026-05-' : '2026-06-') + String(k < 31 ? k + 1 : k - 30).padStart(2, '0') + ' 10:00:00';
      const updPatch = {}; UPD_ORDER.forEach((id, k) => { updPatch[id] = { updated_at: dayOf(k) }; if (id === 52) updPatch[53] = { updated_at: dayOf(k) }; });
      const U_ASC = [65, 52, 53, 59].concat(range(101, 125), [6, 8, 60, 50, 55, 58, 62]);
      const U_DESC = [62, 58, 55, 50, 60, 8, 6].concat(range(101, 125).reverse(), [59, 52, 53, 65]);
      const D_DESC = [55, 52, 53, 6, 60, 50, 58, 62, 65, 59].concat(range(101, 125), [8]);   // domain 降序（按代码）：同 W28d 的手写序列（业务域字段没被补丁，名称映射不影响按代码排序）
      const I_DESC = range(101, 125).reverse().concat([65, 62, 60, 59, 58, 55, 52, 53, 50, 8, 6]);   // id 降序：组主模型 id 125…101, 65, 62, 60, 59, 58, 55, 52(+53), 50, 8, 6
      const { page } = await open(adminN, 'W53', '', { beforeGoto: rewriteList(patchRows(updPatch)) });
      const t = await page.evaluate(() => {
        const sec = document.getElementById('modelListSection'); const tb = sec.querySelector('.catalog-toolbar'); const head = sec.querySelector('.catalog-head');
        const keysOf = (root) => Array.from(root.querySelectorAll('button[data-sort-by]')).map((b) => b.getAttribute('data-sort-by'));
        const si = document.getElementById('searchKeyword');
        const collapse = Array.from(document.querySelectorAll('[data-catalog-act="collapse-all"]'));
        return {
          tb: !!tb, tbKeys: tb ? keysOf(tb) : null, headKeys: head ? keysOf(head) : null, allKeys: keysOf(document).slice().sort(),
          seq: tb ? Array.from(tb.querySelectorAll('input, button')).map((e) => e.id || e.getAttribute('data-sort-by') || e.getAttribute('data-catalog-act') || (e.getAttribute('onclick') === 'applyCatalogSearch()' ? 'search-btn' : '?')) : null,
          label: tb ? Array.from(tb.querySelectorAll('span')).filter((s) => s.textContent === '排序：').length : -1,
          searchN: document.querySelectorAll('#searchKeyword').length, searchIn: !!(tb && tb.contains(si)), type: si.type, ph: si.getAttribute('placeholder'), oninput: si.getAttribute('oninput'), onkeyup: si.getAttribute('onkeyup'),
          collapseN: collapse.length, collapseIn: collapse.every((b) => !!tb && tb.contains(b)), collapseText: collapse.map((b) => b.textContent),
          before: !!(tb && head && (tb.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING)), oldBar: document.querySelectorAll('.catalog-sortbar').length };
      });
      check('W53 工具条存在，内部按钮 / 输入框顺序恰为 [searchKeyword, search-btn, updated_at, domain, id, collapse-all]（手写），文字「排序：」恰 1 个', t.tb === true && J(t.seq) === J(['searchKeyword', 'search-btn', 'updated_at', 'domain', 'id', 'collapse-all']) && t.label === 1, t);
      check('W53 工具条里恰 3 个排序键 [updated_at, domain, id]；列头恰 5 个 [layer, table_name, status, acceptance_at, tech_owner]；全页 button[data-sort-by] 恰这 8 个键（无重复）', J(t.tbKeys) === J(['updated_at', 'domain', 'id']) && J(t.headKeys) === J(['layer', 'table_name', 'status', 'acceptance_at', 'tech_owner']) && J(t.allKeys) === J(['acceptance_at', 'domain', 'id', 'layer', 'status', 'table_name', 'tech_owner', 'updated_at']), t);
      check('W53 #searchKeyword 页面上恰 1 个、在工具条里，属性原样（type=text、placeholder / oninput / onkeyup 与迁移前逐字相同）', t.searchN === 1 && t.searchIn === true && t.type === 'text' && t.ph === '搜索表名 / 描述 / 源表 / 上游表 / 对象名 / #ID...' && t.oninput === 'if (!event.isComposing) applyCatalogSearch()' && t.onkeyup === "if(event.key==='Enter') applyCatalogSearch()", t);
      check('W53 「全部收起」恰 1 个、在工具条里、文字「全部收起」；工具条在列头之前；旧排序条 .catalog-sortbar 已不存在', t.collapseN === 1 && t.collapseIn === true && J(t.collapseText) === J(['全部收起']) && t.before === true && t.oldBar === 0, t);
      await page.locator('.catalog-toolbar button[data-sort-by="updated_at"]').click();
      const s = await page.evaluate(() => { const b = document.querySelector('.catalog-toolbar button[data-sort-by="updated_at"]'); return { by: currentSortBy, dir: currentSortDir, active: b.classList.contains('active'), aria: b.getAttribute('aria-sort'), icon: b.querySelector('.sort-icon').textContent }; });
      check('W53 点工具条里的「最后更新」排序键：currentSortBy=updated_at、desc，按钮 active、aria-sort=descending、图标 ↓（排序逻辑随按钮迁移后仍接着）', s.by === 'updated_at' && s.dir === 'desc' && s.active === true && s.aria === 'descending' && s.icon === '↓', s);
      check('W53 「最后更新」首击后立即核列表顺序（降序，手写 U_DESC = UPD_ORDER 反序：62,58,55,50,60,8,6,125…101,59,52+53,65）：全量序列与第 1 页 DOM（前 20 组 = 20 行）逐项相等——排序点击自己重画了列表（只更新状态与图标的实现在这里判红）', J((await view(page)).orderedIds) === J(U_DESC) && J(await domIds(page)) === J(U_DESC.slice(0, 20)), { ids: (await view(page)).orderedIds, dom: await domIds(page) });
      await page.locator('.catalog-toolbar button[data-sort-by="updated_at"]').click();
      check('W53 「最后更新」二击后立即核列表顺序（升序，手写 U_ASC = UPD_ORDER：65,52+53,59,101…125,6,8,60,50,55,58,62）：全量序列与第 1 页 DOM（前 20 组 = 21 行）逐项相等', J((await view(page)).orderedIds) === J(U_ASC) && J(await domIds(page)) === J(U_ASC.slice(0, 21)), { ids: (await view(page)).orderedIds, dom: await domIds(page) });
      await page.locator('.catalog-toolbar button[data-sort-by="updated_at"]').click();
      check('W53 「最后更新」三击清排序后立即核列表顺序（回默认序 ALL36）', J((await view(page)).orderedIds) === J(ALL36) && J(await domIds(page)) === J(PAGE1_21), { ids: (await view(page)).orderedIds });
      await page.locator('.catalog-toolbar button[data-sort-by="domain"]').click();
      check('W53 工具条「业务域」首击后立即核列表顺序（降序，按代码，手写 D_DESC：55,52+53,6,60,50,58,62,65,59,101…125,8；无业务域的排末尾）：全量序列与第 1 页 DOM（前 20 组 = 21 行）逐项相等', J((await view(page)).orderedIds) === J(D_DESC) && J(await domIds(page)) === J(D_DESC.slice(0, 21)), { ids: (await view(page)).orderedIds, dom: await domIds(page) });
      await page.locator('.catalog-toolbar button[data-sort-by="id"]').click();
      check('W53 工具条「ID」首击（换键 → 降序）后立即核列表顺序（手写 I_DESC：125…101,65,62,60,59,58,55,52+53,50,8,6）：全量序列与第 1 页 DOM（前 20 组 = 125…106）逐项相等', J((await view(page)).orderedIds) === J(I_DESC) && J(await domIds(page)) === J(I_DESC.slice(0, 20)), { ids: (await view(page)).orderedIds, dom: await domIds(page) });
      await page.close();
    }

    // ===== W54 P36 页面层 =====
    // 它锁的是（P36，用户 10-09 同意）：「改」指实际变化——展开一个条目后，在搜索框「原词」上按回车 / 点「搜索」按钮 / 首尾空格不同 / 输入法 compositionend，以及点当前页码，条目都仍展开（不收起、不重新请求关系、不作废在途令牌）；
    //   真的改了才收起：只差大小写（DIM_ → 不同于 dim_）、换词、翻到别的页（翻回来也不恢复）。旧词取「当前画面所用的词」（catalogRenderedQuery），而不是 catalogSyncState().query（那已经是输入框的新词）；
    //   ?search= 预填的词也算「当前画面所用的词」（预填后展开，回车仍展开）。
    // 页内变异（首红落在本段）：w99-w54-old-page（分页当前页底色改回 #d97706，C4e-a 之前的值）
    console.log('W54 P36 页面层');
    {
      const { page } = await open(adminN, 'W54a');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await page.fill('#searchKeyword', 'dim_');
      check('W54 前置：搜索 dim_ 命中 6 个 DIM（60,50,55,58,62,65），第 1 页', J((await view(page)).orderedIds) === J([60, 50, 55, 58, 62, 65]) && (await page.evaluate(() => currentPage)) === 1);
      await toggleOf(page, 50);
      check('W54 前置：展开 #50 → loaded（g50_1），关系请求恰 1 次', (await waitPane(page, 50, 'loaded')) && J(relIds) === J([50]) && J(await expandedIdsDom(page)) === J([50]));
      const still = async (label) => {
        const pi = await pInfo(page, 50);
        check('W54 ' + label + '：#50 仍展开且 loaded（沿用 g50_1）、面板 1 个、状态展开集合仍为 [50]、没有重新请求（共 1 次）', J(await expandedIdsDom(page)) === J([50]) && (await paneCount(page)) === 1 && pi.state === 'loaded' && pi.text.includes('g50_1') && J(await stateExpanded(page)) === J(['50']) && J(relIds) === J([50]), { pi, relIds, st: await stateExpanded(page) });
      };
      await page.press('#searchKeyword', 'Enter');
      await still('原词按回车');
      await page.locator('button[onclick="applyCatalogSearch()"]').click();
      await still('原词点「搜索」按钮');
      await page.fill('#searchKeyword', 'dim_ ');
      await still('词尾多一个空格（trim 后同词）');
      await page.fill('#searchKeyword', ' dim_');
      await still('词首多一个空格（trim 后同词）');
      await page.evaluate(() => { document.getElementById('searchKeyword').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
      await still('输入法 compositionend（同值）');
      await page.fill('#searchKeyword', 'DIM_');
      const vCase = await view(page);
      check('W54 只差大小写（dim_ → DIM_）按「改搜索」处理：展开全部收起（无展开按钮为 true、无面板、状态展开集合为空）；搜索结果本身不变（ASCII 大小写折叠，仍是 60,50,55,58,62,65）', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && J(await stateExpanded(page)) === J([]) && J(vCase.orderedIds) === J([60, 50, 55, 58, 62, 65]), { st: await stateExpanded(page), ids: vCase.orderedIds });
      await toggleOf(page, 50);
      check('W54 前置：再展开 #50 → loaded（第 2 次请求，g50_2）', (await waitPane(page, 50, 'loaded')) && J(relIds) === J([50, 50]) && (await pInfo(page, 50)).text.includes('g50_2'));
      await page.fill('#searchKeyword', 'dim_w');
      check('W54 换词（DIM_ → dim_w）：展开全部收起、没有面板、没有多余请求（共 2 次）', J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && J(await stateExpanded(page)) === J([]) && J(relIds) === J([50, 50]), { relIds });
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W54b');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await page.evaluate(() => goToPage(2));
      check('W54 前置：翻到第 2 页（113…125, 6, 8）', J(await domIds(page)) === J(ALL36.slice(21)) && (await page.evaluate(() => currentPage)) === 2);
      await toggleOf(page, 113);
      check('W54 前置：展开 #113 → loaded，关系请求恰 1 次', (await waitPane(page, 113, 'loaded')) && J(relIds) === J([113]));
      const before113 = await pInfo(page, 113);   // ODS 的上游行取自列表行（源系统 · 源表），不显示 tagRel 的标记名——用点击前后面板文字逐字相等 + 请求次数判「沿用」
      // C4e-a：当前页底色在行内样式里写成 var(--color-accent)（CAT renderPagination），行内 style.background 读到的是变量文本，不是色值——改读该按钮的计算样式（读的是页码 2 按钮自身的 backgroundColor / borderTopColor）
      const cur = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#paginationControls button')).find((x) => x.textContent.trim() === '2'); if (!b) return null; const cs = getComputedStyle(b); return { bg: cs.backgroundColor, border: cs.borderTopColor, weight: b.style.fontWeight }; });
      check('W54 前置：页码 2 的按钮是当前页样式（计算底色与边框色都是 accent rgb(79, 70, 229)、字重 600）', !!cur && cur.bg === 'rgb(79, 70, 229)' && cur.border === 'rgb(79, 70, 229)' && cur.weight === '600', cur);
      await clickC(page, '#paginationControls button:text-is("2")');
      const pi = await pInfo(page, 113);
      check('W54 点当前页码（第 2 页）：仍在第 2 页、#113 仍展开且 loaded（面板文字与点击前逐字相同）、没有重新请求（共 1 次）', (await page.evaluate(() => currentPage)) === 2 && J(await expandedIdsDom(page)) === J([113]) && pi.state === 'loaded' && pi.text === before113.text && J(relIds) === J([113]), { pi, before113, relIds });
      await clickC(page, '#paginationControls button:text-is("1")');
      check('W54 翻到第 1 页：展开全部收起（状态展开集合为空）', (await page.evaluate(() => currentPage)) === 1 && J(await stateExpanded(page)) === J([]) && (await paneCount(page)) === 0);
      await clickC(page, '#paginationControls button:text-is("2")');
      check('W54 翻回第 2 页：#113 是收起（翻页收起后不恢复）、没有面板、没有重新请求（共 1 次）', (await page.evaluate(() => currentPage)) === 2 && J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && J(relIds) === J([113]), { relIds });
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W54c');
      const g = gate();
      const counts = await routeRel(page, async (id, n) => { if (id === 50) await g.p; return { json: tagRel(id, n) }; });
      await spyArrived(page);
      await page.fill('#searchKeyword', 'dim_');
      await toggleOf(page, 50);
      check('W54 前置：#50 的关系请求已发出且被扣住，面板是加载态', (await untilTrue(() => counts[50] === 1)) && (await pInfo(page, 50)).state === 'loading');
      await page.press('#searchKeyword', 'Enter');
      check('W54 加载中在原词上按回车：#50 仍展开、面板仍是加载态（没有收起，也没有重发请求：共 1 次）', J(await expandedIdsDom(page)) === J([50]) && (await pInfo(page, 50)).state === 'loading' && counts[50] === 1, { st: (await pInfo(page, 50)).state, c: counts[50] });
      g.release();
      check('W54 放行后：#50 面板 loaded（g50_1）——在途令牌没被作废', (await waitPane(page, 50, 'loaded')) && (await pInfo(page, 50)).text.includes('g50_1'));
      const arr = await arrivals(page);
      check('W54 核心收到的到达记录恰 1 条（#50），不是迟到丢弃（discarded=false）', arr.length === 1 && arr[0].id === '50' && arr[0].discarded === false, arr);
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W54d', '?search=dim_');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      check('W54 前置：?search=dim_ 预填后首屏即过滤（60,50,55,58,62,65）', J((await view(page)).orderedIds) === J([60, 50, 55, 58, 62, 65]) && (await page.inputValue('#searchKeyword')) === 'dim_');
      await toggleOf(page, 50); await waitPane(page, 50, 'loaded');
      await page.press('#searchKeyword', 'Enter');
      const pi = await pInfo(page, 50);
      check('W54 ?search= 预填的词算「当前画面所用的词」：展开后在预填词上按回车，#50 仍展开且 loaded、没有重新请求（共 1 次）', J(await expandedIdsDom(page)) === J([50]) && pi.state === 'loaded' && pi.text.includes('g50_1') && J(relIds) === J([50]), { pi, relIds });
      await page.close();
    }

    // ===== W54e 同词搜索不回第 1 页（codex 41Tb-M2）=====
    // 它锁的是：结果有两页的查询（ods_filler：25 组，默认序 101…125，第 1 页 101…120、第 2 页 121…125）下翻到第 2 页并展开 #121 后，原词回车 / 点「搜索」按钮 / 输入 trim 后同词（词尾、词首加空格）——
    //   都不回第 1 页：currentPage 仍为 2、DOM 仍是 121…125、#121 仍展开且面板文字逐字不变、状态展开集合不变、关系请求次数不变。（W54a 的同词用例都在第 1 页，实现若同词时把页码置 1 分不出来。）
    console.log('W54e 同词搜索留在第 2 页');
    {
      const { page } = await open(adminN, 'W54e');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await page.fill('#searchKeyword', 'ods_filler');
      check('W54e 前置：搜 ods_filler → 25 组 2 页，第 1 页 101…120', J(await domIds(page)) === J(range(101, 120)) && (await page.evaluate(() => getCatalogView().totalPages)) === 2, await domIds(page));
      await clickC(page, '#paginationControls button:text-is("2")');
      check('W54e 前置：翻到第 2 页（121…125）', (await page.evaluate(() => currentPage)) === 2 && J(await domIds(page)) === J(range(121, 125)), await domIds(page));
      await toggleOf(page, 121);
      check('W54e 前置：展开 #121 → loaded（关系请求恰 1 次）', (await waitPane(page, 121, 'loaded')) && J(relIds) === J([121]));
      const base121 = await pInfo(page, 121);
      const stay = async (label) => {
        const pi = await pInfo(page, 121);
        const cp = await page.evaluate(() => currentPage);
        check('W54e ' + label + '：仍在第 2 页（currentPage 2、DOM 121…125）、#121 仍展开且面板文字与之前逐字相同、状态展开集合仍 [121]、没有重新请求（共 1 次）', cp === 2 && J(await domIds(page)) === J(range(121, 125)) && J(await expandedIdsDom(page)) === J([121]) && pi.state === 'loaded' && pi.text === base121.text && J(await stateExpanded(page)) === J(['121']) && J(relIds) === J([121]), { cp, pi, relIds });
      };
      await page.press('#searchKeyword', 'Enter');
      await stay('原词回车');
      await page.locator('button[onclick="applyCatalogSearch()"]').click();
      await stay('点「搜索」按钮');
      await page.fill('#searchKeyword', 'ods_filler ');
      await stay('输入 trim 后同词（词尾加空格）');
      await page.fill('#searchKeyword', ' ods_filler');
      await stay('输入 trim 后同词（词首加空格）');
      await page.close();
    }

    // ===== W54f 同页点击不作废在途令牌（codex 41Tb-M3）=====
    // 它锁的是：第 2 页展开 #113 并扣住关系响应（面板加载态）后点当前页码 2——仍是加载态、关系请求恰 1 次；放行后面板 loaded，核心到达记录 discarded=false（同页点击没有作废在途令牌）。
    //   （W54b 的同页点击发生在关系请求已完成之后，只能证明已加载面板保留，看不出「同页点击提前作废在途令牌」。）
    console.log('W54f 同页点击不作废在途令牌');
    {
      const { page } = await open(adminN, 'W54f');
      const g = gate();
      const counts = await routeRel(page, async (id, n) => { if (id === 113) await g.p; return { json: tagRel(id, n) }; });
      await spyArrived(page);
      await page.evaluate(() => goToPage(2));
      await toggleOf(page, 113);
      check('W54f 前置：第 2 页、#113 的关系请求已到达路由并被扣住（面板加载态）', (await page.evaluate(() => currentPage)) === 2 && (await untilTrue(() => counts[113] === 1)) && (await pInfo(page, 113)).state === 'loading');
      await clickC(page, '#paginationControls button:text-is("2")');
      const mid = await pInfo(page, 113);
      check('W54f 加载中点当前页码（第 2 页）：仍在第 2 页、#113 仍展开且面板仍是加载态、没有重发请求（共 1 次）', (await page.evaluate(() => currentPage)) === 2 && J(await expandedIdsDom(page)) === J([113]) && mid.state === 'loading' && counts[113] === 1, { mid, c: counts[113] });
      g.release();
      check('W54f 放行后：#113 面板 loaded——在途令牌没被同页点击作废', await waitPane(page, 113, 'loaded'));
      const arr = await arrivals(page);
      check('W54f 核心收到的到达记录恰 1 条（#113），不是迟到丢弃（discarded=false）；关系请求仍恰 1 次', arr.length === 1 && arr[0].id === '113' && arr[0].discarded === false && counts[113] === 1, { arr, c: counts[113] });
      await page.close();
    }

    // ===== W55 筛选单一来源 =====
    // 它锁的是（4a 还没有左栏 UI，用测试钩子直接写 catalogFilters；4b 起由左栏点击经 setFilter 写）：catalogSyncState().filters / getCatalogView() / getSortedModels() / 渲染都取同一个 catalogFilters——
    //   置 { layer: 'ODS' } 后三处读到的都是 ODS（27 个：101…125, 6, 8）、第 1 页 DOM 是前 20 个；focusCatalogModel(60) 经核心 focus 清空筛选并写回 catalogFilters（回到 36 行 / 第 1 页 / #60 高亮），
    //   事件态里的 filters 与 catalogFilters 一致（都为空）。
    console.log('W55 筛选单一来源');
    {
      const { page } = await open(adminN, 'W55');
      const ODS27 = range(101, 125).concat([6, 8]);
      await page.evaluate(() => { catalogFilters = { layer: 'ODS' }; renderModelsPage(); });
      const a = await page.evaluate(() => ({ sync: catalogSyncState().filters, view: getCatalogView().orderedIds, sorted: getSortedModels().map((m) => m.id), full: catalogFullView().orderedIds }));
      check('W55 置 catalogFilters={layer:ODS} 后：catalogSyncState().filters、getCatalogView().orderedIds、getSortedModels() 的 id、catalogFullView().orderedIds 都读到它（手写 ODS27）', J(a.sync) === J({ layer: 'ODS' }) && J(a.view) === J(ODS27) && J(a.sorted) === J(ODS27) && J(a.full) === J(ODS27), a);
      check('W55 渲染也取它：第 1 页 DOM 是 ODS27 的前 20 个（101…120）', J(await domIds(page)) === J(ODS27.slice(0, 20)), await domIds(page));
      await page.evaluate(() => focusCatalogModel(60));
      const b = await page.evaluate(() => ({ cf: catalogFilters, st: catalogEventState.filters, view: getCatalogView().orderedIds, page: currentPage }));
      check('W55 focusCatalogModel(60) 后：catalogFilters 与事件态 filters 都被清空（{}），视图回到 36 行（ALL36）、第 1 页', J(b.cf) === J({}) && J(b.st) === J({}) && J(b.view) === J(ALL36) && b.page === 1, b);
      const hl = await page.waitForSelector('#modelListBody [data-id="60"][data-focus-highlight]', { timeout: WAIT }).then(() => true, () => false);
      check('W55 focus 后 DOM 是 PAGE1_21 且 #60 带 data-focus-highlight', hl && J(await domIds(page)) === J(PAGE1_21), await domIds(page));
      await page.close();
    }

    // ====================================================================================================================
    // 子批 4b（C4c-4）：W56 起（左栏 / 两栏布局）。约定同 W36 起：期望值全部手写，等待绑在被断言对象上且有界；带 4a 起的页内变异（CAT_MUTS，4b 新增 24 个）。
    //   左栏夹具 RAIL11（路由改写列表，11 行 10 组，每个数都能由下表手算；不改共享夹具）：
    //     id 层   状态       业务域    config_mode 伴生  验收   rel.obj
    //     201 ods ONLINE     dom_a     standard    -     pass   1
    //     202 ODS ONLINE     dom_a     standard    -     none   0
    //     203 Ods DEVELOPING dom_b     standard    -     stale  2
    //     204 dim ONLINE     dom_b     custom      -     none   0     ← 未接入登记（custom 且 rel.obj=0）
    //     205 DIM CREATED    dom_zzz   custom      -     stale  3     ← 业务域代码不在 /api/domains 里
    //     206 dwd CREATED    null      standard    -     pass   0
    //     207 dwd CREATED    ''        custom      -     stale  rel=null（关系加载失败：不算未接入）
    //     208 ads DEVELOPING '  '(空白) standard    -     none   0
    //     209 dwd ONLINE     dom_a     companion   206   null   rel=null    ← 与主模型 #206 状态不同（P23 对照例）
    //     210 dws WEIRD      dom_c     standard    -     none   0     ← 状态不在映射表里
    //     211 null null      dom_c     standard    -     none   0     ← 层、状态都为空：只计入总数
    //   手算：总数 11；视图 全部 11 / 需复验（203,205,207）3 / 未接入登记（204）1 / 自定义脚本（204,205,207）3；
    //     分层（大写归一）ODS（201,202,203）3 / DIM（204,205）2 / DWD（206,207,209）3 / DWS 1 / ADS 1，合计 10（#211 没有层）；
    //     状态 规划中（205,206,207）3 / 开发中（203,208）2 / 已上线（201,202,204,209）4 / WEIRD 1，合计 10（#211 没有状态）；
    //     业务域 dom_a（201,202,209）3 / dom_b（203,204）2 / dom_c（210,211）2 / dom_zzz（205）1 / 未设置（206,207,208）3，合计 11。
    //   四种常见写错各有不同的数：不含伴生（总数 10、已上线 3）、分层不做大写归一（ODS 1）、按组计数（总数 10）、「全部」取分区求和（分层 / 状态的「全部」会是 10 而不是 11）。
    // ====================================================================================================================
    const NOACC = { state: 'none', at: null, rows: null, stages: null, prevResult: null };
    const RACC = (state, at, prev) => ({ state, at, rows: 1, stages: { structure: 'pass', data: 'pass' }, prevResult: prev === undefined ? null : prev });
    const railRow = (rows, id, o) => Object.assign({}, rows.find((r) => r.id === 50), { id, table_name: 'rail_' + id, table_comment: '左栏夹具', tech_owner: '示例用户A', design_notes: null, category: 'general', companion_of: null, config_mode: 'standard', impl_note: null, acceptance: NOACC, rel: { obj: 0, up: 0, down: 0 }, domain: null }, o);
    const RAIL11 = (rows) => [
      railRow(rows, 201, { layer: 'ods', status: 'ONLINE', domain: 'dom_a', acceptance: RACC('pass', '2026-03-01 10:00:00'), rel: { obj: 1, up: 0, down: 0 } }),
      railRow(rows, 202, { layer: 'ODS', status: 'ONLINE', domain: 'dom_a' }),
      railRow(rows, 203, { layer: 'Ods', status: 'DEVELOPING', domain: 'dom_b', acceptance: RACC('stale', '2026-03-02 10:00:00', 'pass'), rel: { obj: 2, up: 0, down: 0 } }),
      railRow(rows, 204, { layer: 'dim', status: 'ONLINE', domain: 'dom_b', config_mode: 'custom' }),
      railRow(rows, 205, { layer: 'DIM', status: 'CREATED', domain: 'dom_zzz', config_mode: 'custom', acceptance: RACC('stale', '2026-03-03 10:00:00', 'warn'), rel: { obj: 3, up: 0, down: 0 } }),
      railRow(rows, 206, { layer: 'dwd', status: 'CREATED', domain: null, acceptance: RACC('pass', '2026-03-04 10:00:00') }),
      railRow(rows, 207, { layer: 'dwd', status: 'CREATED', domain: '', config_mode: 'custom', acceptance: RACC('stale', '2026-03-05 10:00:00', 'pass'), rel: null }),
      railRow(rows, 208, { layer: 'ads', status: 'DEVELOPING', domain: '  ' }),
      railRow(rows, 209, { layer: 'dwd', status: 'ONLINE', domain: 'dom_a', config_mode: 'companion', companion_of: 206, acceptance: null, rel: null }),
      railRow(rows, 210, { layer: 'dws', status: 'WEIRD', domain: 'dom_c' }),
      railRow(rows, 211, { layer: null, status: null, domain: 'dom_c' }),
    ];
    const RAIL35 = (rows) => RAIL11(rows).concat(range(301, 325).map((i) => railRow(rows, i, { layer: 'ods', status: 'ONLINE', domain: 'dom_a' })));   // 再加 25 个 ODS / ONLINE / dom_a 的单行组：共 35 组 2 页
    const RAIL_IDS = [201, 202, 203, 204, 205, 206, 209, 207, 208, 210, 211];   // 默认序：组按主模型在输入里的位置排，伴生 #209 紧跟 #206
    const RV = ['全部模型11', '需复验3', '未接入登记1', '自定义脚本3'];
    const RL = ['全部11', 'ODS3', 'DIM2', 'DWD3', 'DWS1', 'ADS1'];
    const RS = ['全部11', '规划中3', '开发中2', '已上线4', 'WEIRD1'];
    const RD = ['全部11', '域甲3', '域乙2', '域丙2', 'dom_zzz1', '未设置3'];
    const RAIL_SPECS = ['view:', 'view:stale', 'view:pending', 'view:custom', 'layer:', 'layer:ODS', 'layer:DIM', 'layer:DWD', 'layer:DWS', 'layer:ADS', 'status:', 'status:CREATED', 'status:DEVELOPING', 'status:ONLINE', 'status:WEIRD', 'domain:', 'domain:dom_a', 'domain:dom_b', 'domain:dom_c', 'domain:dom_zzz', 'domain:__none__'];
    const D0 = ['view:', 'layer:', 'status:', 'domain:'];   // 四组都在「全部」时按下的四个项
    const railTexts = (page, key) => page.$$eval('#catalogRail [data-rail]', (bs, k) => bs.filter((b) => b.getAttribute('data-rail').startsWith(k + ':')).map((b) => b.textContent), key);
    const railAll = async (page) => ({ v: await railTexts(page, 'view'), l: await railTexts(page, 'layer'), s: await railTexts(page, 'status'), d: await railTexts(page, 'domain') });
    const railSpecs = (page) => page.$$eval('#catalogRail [data-rail]', (bs) => bs.map((b) => b.getAttribute('data-rail')));
    const railPressed = (page) => page.$$eval('#catalogRail [data-rail]', (bs) => bs.filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-rail')));
    const railHead = (page) => page.$eval('#catalogRail .catalog-rail-head', (e) => e.textContent);
    const railClick = (page, spec) => clickC(page, '#catalogRail [data-rail="' + spec + '"]');
    const waitRailDomains = (page, want) => page.waitForFunction((w) => Array.from(document.querySelectorAll('#catalogRail [data-rail^="domain:"]')).map((b) => b.textContent).join('|') === w, want.join('|'), { timeout: WAIT }).then(() => true, () => false);
    // 探针只记 [筛选键, 取值]（setFilter 的第 2、3 实参）：核对的是「点击 → 哪个筛选键、什么取值」；第 1 实参（状态）：Pick 的首参 catalogSyncState()、Clear 的首参 acc 由 VCC W:rail（catalogRailPick / catalogRailClear 两条正则）负责；catalogAdoptFilters( 的实参与 acc 的种子 / 累积来源由 W:filters 负责（41Tb-L1：不再称为「完整参数向量」）。
    const spySetFilter = (page) => page.evaluate(() => { window.__sf = []; const o = ModelCatalogCore.setFilter; ModelCatalogCore.setFilter = function (S, k, v) { window.__sf.push([k, v]); return o.apply(this, arguments); }; });
    const sfCalls = (page) => page.evaluate(() => window.__sf);

    // ====================================================================================================================
    // 子批 4c 公用夹具与读取助手（放在 W62 / W56 之前：W56 的数据到达前断言要扣住未归属请求）。
    //   未归属清单 = GET /api/model-impl-objects?unowned=1；测试库里 model_impl_objects 被清空，所以不改写路由时真实服务端返回 []（W56 用）。
    //   unRoute 用 page.route 改写该请求的响应（沿用 W 现有写法，不改共享夹具）：handler(n) 返回 { json } | { status, body } | { abort: true }，n 是第几次到达路由的请求（从 1 数），可 await 闸门。
    // ====================================================================================================================
    const isUnowned = (u) => u.pathname === '/api/model-impl-objects' && u.searchParams.get('unowned') === '1';
    const unRoute = (un, handler) => async (pg) => {
      un.reqs = un.reqs || [];
      await pg.route(isUnowned, async (route) => {
        const u = new URL(route.request().url());
        un.reqs.push(route.request().method() + ' ' + u.pathname + u.search);
        un.n++;
        const r = await handler(un.n);
        if (r && r.abort) return route.abort('failed');
        return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: r.body !== undefined ? r.body : JSON.stringify(r.json) });
      });
    };
    const waitUnCount = (page, want) => page.waitForFunction((w) => { const c = document.getElementById('catalogRailUnownedCount'); return !!c && c.textContent === w; }, want, { timeout: WAIT }).then(() => true, () => false);
    const waitUnRows = (page, n) => page.waitForFunction((k) => document.querySelectorAll('#catalogUnownedPanel tbody tr').length === k, n, { timeout: WAIT }).then(() => true, () => false);
    const waitUnState = (page, text) => page.waitForFunction((t) => { const s = document.querySelector('#catalogUnownedPanel .catalog-unowned-state'); return !!s && s.textContent.indexOf(t) >= 0; }, text, { timeout: WAIT }).then(() => true, () => false);
    /** 左栏入口按钮（button#catalogRailUnowned）的读数 */
    const unBtn = (page) => page.evaluate(() => {
      const b = document.getElementById('catalogRailUnowned'); const c = document.getElementById('catalogRailUnownedCount');
      return b ? { tag: b.tagName, type: b.getAttribute('type'), act: b.getAttribute('data-catalog-act'), pressed: b.getAttribute('aria-pressed'), hasRail: b.hasAttribute('data-rail'), hasDataAct: b.hasAttribute('data-act'), hasEntry: b.hasAttribute('data-entry'), count: c ? c.textContent : null, cntInside: !!c && b.contains(c) } : null;
    });
    /** 左栏底部虚线框的读数：是否左栏最后一个区块、边框样式、标题、说明、框内可点元素（id 或标签名） */
    const unBox = (page) => page.evaluate(() => {
      const r = document.getElementById('catalogRail'); const b = document.getElementById('catalogRailUnowned'); const o = b ? b.closest('.catalog-rail-orphan') : null;
      return o ? { last: r.lastElementChild === o, bs: getComputedStyle(o).borderTopStyle, h5: o.querySelector('h5').textContent, fine: o.querySelector('.catalog-rail-fine').textContent, ctl: Array.from(o.querySelectorAll('button, a, input, select, [data-rail], [role="button"], [tabindex]')).map((e) => e.id || e.tagName) } : null;
    });
    /** 未归属面板的读数（面板可见性、标题、说明、返回按钮、状态块文字、重试按钮、表头与逐行逐格） */
    const unPanel = (page) => page.evaluate(() => {
      const p = document.getElementById('catalogUnownedPanel'); if (!p) return null;
      const vis = !p.hidden && getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().height > 0;
      const q = (s) => p.querySelector(s); const st = q('.catalog-unowned-state'); const retry = q('[data-catalog-act="retry-unowned"]'); const back = q('[data-catalog-act="unowned-back"]');
      const rows = Array.from(p.querySelectorAll('tbody tr')).map((tr) => {
        const tds = Array.from(tr.children);
        return { n: tds.length, type: tds[0] ? tds[0].textContent : null, name: tds[1] ? tds[1].textContent : null, summary: tds[2] ? tds[2].textContent : null, time: tds[4] ? tds[4].textContent : null,
          badges: tds[3] ? Array.from(tds[3].children).map((b) => ({ t: b.textContent, c: b.className, title: b.getAttribute('title') })) : [] };
      });
      return { vis, title: q('.catalog-unowned-title') ? q('.catalog-unowned-title').textContent : null, desc: q('.catalog-unowned-desc') ? q('.catalog-unowned-desc').textContent : null,
        back: back ? { tag: back.tagName, text: back.textContent, type: back.getAttribute('type'), hasDataAct: back.hasAttribute('data-act') } : null,
        state: st ? st.textContent : null, stateIsError: !!st && st.classList.contains('is-error'),
        retry: retry ? { tag: retry.tagName, text: retry.textContent, disabled: retry.disabled, hasDataAct: retry.hasAttribute('data-act') } : null,
        tables: p.querySelectorAll('table').length, heads: Array.from(p.querySelectorAll('thead th')).map((th) => th.textContent), rows };
    });
    /** 列表区各部分是否可见（Playwright 可见性：祖先 display:none 即不可见） */
    const listParts = async (page) => { const o = {}; for (const [k, sel] of [['toolbar', '.catalog-toolbar'], ['head', '.catalog-head'], ['body', '#modelListBody'], ['pager', '#paginationContainer'], ['notice', '#catalogListNotice'], ['search', '#searchKeyword']]) o[k] = await page.locator(sel).first().isVisible(); return o; };
    const UN_ROWS = [
      { id: 901, obj_type: 'PROC', schema_name: 'dbo', obj_name: 'usp_orphan_a', summary: '孤儿过程 A', verified_at: '2026-03-01 08:00:00', badges: { doc: 'consistent', reg: 'inconsistent' } },
      { id: 902, obj_type: 'VIEW', schema_name: null, obj_name: 'v_orphan_b', summary: null, verified_at: null, badges: { doc: 'unverified', reg: 'unverified' } },
      { id: 903, obj_type: 'TRIGGER', schema_name: '', obj_name: 'trg_c', summary: '触发器 C', verified_at: '2026-03-02 09:00:00', badges: { doc: 'verify_failed', reg: 'verify_failed', failure: { at: '2026-03-02 09:09:09', error: '连接超时' } } },
      { id: 904, obj_type: 'FDL_TASK', schema_name: null, obj_name: 'fdl任务', summary: '', verified_at: '', badges: { doc: null, reg: null } },
      { id: 905, obj_type: 'PROC', schema_name: 'dbo', obj_name: 'usp_e', summary: '   ', verified_at: '2026-03-03 10:00:00', badges: { doc: 'weird_code', reg: 'stale' } },
    ];
    const UN_B = [   // 第二组数据（2 行）：用来区分「哪一次响应生效」
      { id: 911, obj_type: 'PROC', schema_name: 'dbo', obj_name: 'usp_new', summary: '新清单', verified_at: null, badges: { doc: 'unverified', reg: 'unverified' } },
      { id: 912, obj_type: 'VIEW', schema_name: 'dbo', obj_name: 'v_new', summary: null, verified_at: null, badges: { doc: null, reg: null } },
    ];
    const FAILMSG = '核验失败于 2026-03-02 09:09:09：连接超时';
    // [类型, 名称, 摘要, [[徽章文案, 色调后缀, 悬停]…], 核验时间]——手写期望，逐格对照 UN_ROWS
    const UN_WANT = [
      ['PROC', 'dbo.usp_orphan_a', '孤儿过程 A', [['文档 一致', 'ok', HINT_DOC], ['登记 不一致', 'bad', HINT_REG]], '2026-03-01 08:00:00'],
      ['VIEW', 'v_orphan_b', '—', [['文档 未核验', 'muted', HINT_DOC], ['登记 未核验', 'muted', HINT_REG]], '—'],
      ['TRIGGER', 'trg_c', '触发器 C', [['文档 核验失败', 'warn', FAILMSG], ['登记 核验失败', 'warn', FAILMSG]], '2026-03-02 09:00:00'],
      ['FDL_TASK', 'fdl任务', '—', [['—', 'none', null]], '—'],
      ['PROC', 'dbo.usp_e', '—', [['文档 weird_code', 'muted', HINT_DOC], ['登记 待重核', 'warn', HINT_REG]], '2026-03-03 10:00:00'],
    ];
    const unRowOk = (r, w) => !!r && r.n === 5 && r.type === w[0] && r.name === w[1] && r.summary === w[2] && r.time === w[4] && J(r.badges.map((b) => b.t)) === J(w[3].map((x) => x[0]))
      && r.badges.every((b, k) => b.c === (w[3][k][1] === 'none' ? 'catalog-cons-none' : 'catalog-cons-badge catalog-cons-' + w[3][k][1])) && J(r.badges.map((b) => b.title)) === J(w[3].map((x) => x[2]));

    // （W62 排在 W56 之前运行：布局错位时，后面的左栏点击会被遮挡而超时抛出，脚本异常退出、没有 FAIL 行；先跑布局才能在目标用例上给出 FAIL。）
    // ===== W62 两栏布局（1440 宽度）=====
    // 它锁的是：页头之下是两栏——左栏（宽 200–220px）在左、列表区在右且不与左栏重叠、两者顶端对齐、页头标题在它们上方；1440 宽度下列表区没有横向滚动（#modelListSection 的 scrollWidth ≤ clientWidth，整页也没有横向滚动）；
    //   搜索框在 1440 宽度下完整显示占位文字（按同字体量出占位文字宽度，不超过输入框内宽）；左栏自身没有横向溢出。
    console.log('W62 两栏布局');
    {
      const { page } = await open(adminN, 'W62');
      await page.setViewportSize({ width: 1440, height: 900 });
      await pageEvalBounded(page, () => new Promise((r) => requestAnimationFrame(() => r())));   // 42Ta-M4：全文件扫出的无界单帧等待改有界
      const m = await page.evaluate(() => {
        const r = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom }; };
        const sec = document.getElementById('modelListSection'); const rail = document.getElementById('catalogRail'); const h1 = document.querySelector('.catalog-pagehead h1'); const si = document.getElementById('searchKeyword');
        const cs = getComputedStyle(si); const cv = document.createElement('canvas').getContext('2d'); cv.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
        return { vw: window.innerWidth, sec: { scrollW: sec.scrollWidth, clientW: sec.clientWidth, rect: r(sec) }, rail: { scrollW: rail.scrollWidth, clientW: rail.clientWidth, rect: r(rail) }, h1: r(h1), doc: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth },
          ph: { textW: cv.measureText(si.placeholder).width, inner: si.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), text: si.placeholder } };
      });
      check('W62 视口 1440：左栏在左、宽 200–220px，列表区在它右边且不重叠（列表区左缘 ≥ 左栏右缘），两者顶端对齐（差 ≤ 2px），页头标题在它们上方（标题下缘 ≤ 左栏上缘）', m.vw === 1440 && m.rail.rect.x < m.sec.rect.x && m.rail.rect.w >= 200 && m.rail.rect.w <= 220 && m.sec.rect.x >= m.rail.rect.right && Math.abs(m.rail.rect.y - m.sec.rect.y) <= 2 && m.h1.bottom <= m.rail.rect.y, m);
      check('W62 1440 宽度下列表区没有横向滚动（#modelListSection 的 scrollWidth ≤ clientWidth），整页也没有（documentElement 同），左栏自身不溢出', m.sec.scrollW <= m.sec.clientW && m.doc.scrollW <= m.doc.clientW && m.rail.scrollW <= m.rail.clientW, m);
      check('W62 1440 宽度下搜索框完整显示占位文字（占位文字宽度 ≤ 输入框内宽，同字体量出）', m.ph.textW > 0 && m.ph.textW <= m.ph.inner, m.ph);
      await page.close();
    }

    // ===== W56 左栏：结构与计数 =====
    // 它锁的是：①数据到达前左栏已在（aside#catalogRail[aria-label=筛选与分组]，视图四项恒显示，分层 / 状态 / 业务域各只有「全部」），所有计数显示「—」而不是 0；
    //   ②数据到达后：五个分区标题 [视图, 分层, 状态, 业务域, 未归属对象]、每项 data-rail 与文案（含计数）逐项等于上表的手算值（含伴生、分层大写合并、业务域名称 / 未知代码 / 「未设置」、未知状态原值、「全部」取总数）、
    //   四组「全部」按下、头部「筛选 全部」；③「未归属对象」置底，是虚线框（4c 起框里恰 1 个按钮 #catalogRailUnowned：数据到达前计数「—」，之后等于未归属清单条数——测试库没有实现对象，真实服务端返回 []，计数「0」；4b 的「占位无按钮」断言已被补充派单取代，行为见 W64）；④业务域映射晚到时按代码显示，到达后就地换成名称（不需要别的触发）。
    //   4c：数据到达前的用例同时扣住未归属请求（同一个闸门），否则它的计数会先于列表数据变成 0，「全部 8 个计数都是「—」」不成立。
    console.log('W56 左栏：结构与计数');
    {
      const g = gate(); let hit = 0;
      const { page } = await open(adminN, 'W56a', '', { noRows: true, noIdle: true, beforeGoto: async (pg) => { await pg.route(isUnowned, async (route) => { await g.p; return route.continue(); }); await pg.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); hit++; await g.p; const resp = await route.fetch(); const rows = await resp.json(); return route.fulfill({ response: resp, body: JSON.stringify(RAIL11(rows)) }); }); } });
      check('W56 前置：首次列表请求已到达路由（被扣住，数据还没到）', await untilTrue(() => hit >= 1));
      const pre = await page.evaluate(() => { const r = document.getElementById('catalogRail'); return { n: document.querySelectorAll('#catalogRail').length, tag: r && r.tagName, label: r && r.getAttribute('aria-label'), h5: Array.from(r.querySelectorAll('h5')).map((h) => h.textContent), counts: Array.from(r.querySelectorAll('.catalog-rail-n')).map((e) => e.textContent), specs: Array.from(r.querySelectorAll('[data-rail]')).map((b) => b.getAttribute('data-rail')), head: r.querySelector('.catalog-rail-head').textContent }; });
      check('W56 数据到达前：左栏已渲染（恰 1 个 aside#catalogRail，aria-label「筛选与分组」），分区标题 [视图, 分层, 状态, 业务域, 未归属对象]，头部「筛选全部」', pre.n === 1 && pre.tag === 'ASIDE' && pre.label === '筛选与分组' && J(pre.h5) === J(['视图', '分层', '状态', '业务域', '未归属对象']) && pre.head === '筛选全部', pre);
      check('W56 数据到达前：视图四项恒显示，分层 / 状态 / 业务域只有各自的「全部」；全部 8 个计数都是「—」（不是 0）', J(pre.specs) === J(['view:', 'view:stale', 'view:pending', 'view:custom', 'layer:', 'status:', 'domain:']) && J(pre.counts) === J(Array(8).fill('—')), pre);
      g.release();
      await page.waitForSelector('#modelListBody [data-id]', { timeout: WAIT });
      check('W56 前置：业务域映射到达（域名替换代码）', await waitRailDomains(page, RD));
      const post = await railAll(page);
      check('W56 视图四项文案与计数（手算）：全部模型 11 / 需复验 3 / 未接入登记 1 / 自定义脚本 3', J(post.v) === J(RV), post.v);
      check('W56 分层（大写归一、含伴生）：全部 11（取总数，#211 没有层）/ ODS 3（ods + ODS + Ods 合并）/ DIM 2 / DWD 3（含伴生 #209）/ DWS 1 / ADS 1', J(post.l) === J(RL), post.l);
      check('W56 状态：全部 11 / 规划中 3 / 开发中 2 / 已上线 4（含伴生 #209）/ WEIRD 1（映射表里没有的状态显示原值）；只列出现过的值，顺序规划中 → 开发中 → 已上线 → 未知', J(post.s) === J(RS), post.s);
      check('W56 业务域：全部 11 / 域甲 3 / 域乙 2 / 域丙 2 / dom_zzz 1（查不到名称显示代码）/ 未设置 3（null、空串、纯空白合并，不显示 __none__）', J(post.d) === J(RD), post.d);
      check('W56 前置：未归属计数到达（真实服务端：测试库没有实现对象 → 空数组 → 0）', await waitUnCount(page, '0'));
      const st = await page.evaluate(() => { const r = document.getElementById('catalogRail'); const b = document.getElementById('catalogRailUnowned'); const o = b ? b.closest('.catalog-rail-orphan') : null; return { specs: Array.from(r.querySelectorAll('[data-rail]')).map((b) => b.getAttribute('data-rail')), noPressed: r.querySelectorAll('[data-rail]:not([aria-pressed])').length, tags: Array.from(r.querySelectorAll('[data-rail]')).map((b) => b.tagName).filter((t) => t !== 'BUTTON').length, last: r.lastElementChild === o, ctl: o ? Array.from(o.querySelectorAll('button, a, input, select, [data-rail], [role="button"], [tabindex]')).map((e) => e.id || e.tagName) : [], cnt: (document.getElementById('catalogRailUnownedCount') || {}).textContent, fine: o && o.querySelector('.catalog-rail-fine').textContent, bs: o && getComputedStyle(o).borderTopStyle, h5: o && o.querySelector('h5').textContent }; });
      check('W56 data-rail 值（<组>:<值>，「全部」项的值为空）逐项等于手写清单；每项都是 button 且带 aria-pressed', J(st.specs) === J(RAIL_SPECS) && st.noPressed === 0 && st.tags === 0, st);
      check('W56 默认：四组「全部」按下（view: / layer: / status: / domain:），其余都未按下；头部「筛选全部」', J(await railPressed(page)) === J(D0) && (await railHead(page)) === '筛选全部', await railPressed(page));
      check('W56 「未归属对象」：是左栏最后一个区块、虚线框、标题「未归属对象」+ 说明「登记了但没挂到任何模型的运维对象」+ 计数「0」（4c：数据到达后 = 未归属清单条数，测试库为空）；区块里恰 1 个可点元素 = 入口按钮 #catalogRailUnowned（4b 的「占位无按钮」断言由补充派单取代；入口细节见 W64）', st.last === true && st.bs === 'dashed' && st.h5 === '未归属对象' && st.fine === '登记了但没挂到任何模型的运维对象' && st.cnt === '0' && J(st.ctl) === J(['catalogRailUnowned']), st);
      await page.close();
    }
    {
      const gd = gate();
      const { page } = await open(adminN, 'W56b', '', { noIdle: true, beforeGoto: both(rewriteList(RAIL11), async (pg) => { await pg.route(isDomains, async (route) => { await gd.p; return route.continue(); }); }) });
      check('W56 业务域映射还没到：业务域项显示代码（dom_a / dom_b / dom_c / dom_zzz），未设置照常显示「未设置」', J(await railTexts(page, 'domain')) === J(['全部11', 'dom_a3', 'dom_b2', 'dom_c2', 'dom_zzz1', '未设置3']), await railTexts(page, 'domain'));
      gd.release();
      check('W56 映射到达后：业务域项就地换成名称（域甲 / 域乙 / 域丙），dom_zzz 仍显示代码', await waitRailDomains(page, RD), await railTexts(page, 'domain'));
      await page.close();
    }

    // ===== W57 左栏：点击筛选 =====
    // 它锁的是：点击经核心 setFilter（函数名 + 筛选键与取值由页内探针记录——第 1 实参：Pick 的首参 catalogSyncState()、Clear 的首参 acc 由 VCC W:rail 负责，catalogAdoptFilters( 实参与 acc 的种子 / 累积来源由 W:filters 负责；期望手写）；同组单选；再点已选中项回到该组「全部」；该组本来就是「全部」时再点「全部」不调核心；多组 AND；
    //   计数不随筛选联动（D-8）；P23 对照例（#206 主模型 CREATED、伴生 #209 ONLINE：DWD ∧ 已上线 按「同一成员须同时满足」留下该组 → [206, 209]，按「主模型决定」会得 []）；与搜索词也是 AND。
    console.log('W57 左栏：点击筛选');
    {
      const { page } = await open(adminN, 'W57', '', { beforeGoto: rewriteList(RAIL11) });
      await spySetFilter(page);
      check('W57 前置：业务域映射到达', await waitRailDomains(page, RD));
      const same = async () => { const a = await railAll(page); return J(a) === J({ v: RV, l: RL, s: RS, d: RD }); };
      check('W57 前置：默认 11 行 10 组全部显示（伴生 #209 紧跟 #206），四组「全部」按下，头部「筛选全部」，核心 setFilter 一次都没被调用', J(await domIds(page)) === J(RAIL_IDS) && J(await railPressed(page)) === J(D0) && (await railHead(page)) === '筛选全部' && J(await sfCalls(page)) === J([]), { ids: await domIds(page), sf: await sfCalls(page) });
      await railClick(page, 'layer:DWD');
      check('W57 点「DWD」：setFilter(layer, DWD) 恰 1 次；列表 = 3 个 DWD 成员所在的 2 组 [206, 209, 207]；DWD 按下、分层的「全部」释放；头部「清除 1 项」；四组计数一个都没变（D-8）', J(await sfCalls(page)) === J([['layer', 'DWD']]) && J(await domIds(page)) === J([206, 209, 207]) && J(await railPressed(page)) === J(['view:', 'layer:DWD', 'status:', 'domain:']) && (await railHead(page)) === '筛选清除 1 项' && (await same()), { sf: await sfCalls(page), ids: await domIds(page), pressed: await railPressed(page) });
      await railClick(page, 'status:ONLINE');
      check('W57 再点「已上线」（DWD ∧ 已上线，P23 对照例）：列表 [206, 209]——组命中看同一成员（#209 同时是 DWD 和已上线），主模型 #206 是规划中也随组显示；按「主模型决定」会得 []（「各条件分别命中」口径在这个夹具上区分不出——#207 没有已上线成员，由 W80 负例组负责）；头部「清除 2 项」；计数不变', J(await sfCalls(page)) === J([['layer', 'DWD'], ['status', 'ONLINE']]) && J(await domIds(page)) === J([206, 209]) && J(await railPressed(page)) === J(['view:', 'layer:DWD', 'status:ONLINE', 'domain:']) && (await railHead(page)) === '筛选清除 2 项' && (await same()), { ids: await domIds(page), pressed: await railPressed(page) });
      await railClick(page, 'status:CREATED');
      check('W57 同组单选：点「规划中」→ 已上线释放、规划中按下（AND 不是并集）；列表 [206, 209, 207]；头部仍「清除 2 项」', J(await sfCalls(page)) === J([['layer', 'DWD'], ['status', 'ONLINE'], ['status', 'CREATED']]) && J(await domIds(page)) === J([206, 209, 207]) && J(await railPressed(page)) === J(['view:', 'layer:DWD', 'status:CREATED', 'domain:']) && (await railHead(page)) === '筛选清除 2 项', { pressed: await railPressed(page), ids: await domIds(page) });
      await railClick(page, 'status:CREATED');
      check('W57 再点已选中的「规划中」→ 回到状态的「全部」：setFilter(status, \'\')；列表 [206, 209, 207]（只剩 DWD）；头部「清除 1 项」', J((await sfCalls(page)).slice(3)) === J([['status', '']]) && J(await domIds(page)) === J([206, 209, 207]) && J(await railPressed(page)) === J(['view:', 'layer:DWD', 'status:', 'domain:']) && (await railHead(page)) === '筛选清除 1 项', { sf: await sfCalls(page), pressed: await railPressed(page) });
      await railClick(page, 'layer:');
      check('W57 点分层的「全部」（当前是 DWD）→ setFilter(layer, \'\')；列表回到全部 11 行；四组「全部」按下；头部「筛选全部」', J((await sfCalls(page)).slice(4)) === J([['layer', '']]) && J(await domIds(page)) === J(RAIL_IDS) && J(await railPressed(page)) === J(D0) && (await railHead(page)) === '筛选全部', { sf: await sfCalls(page), ids: await domIds(page) });
      await railClick(page, 'layer:');
      check('W57 该组本来就是「全部」时再点「全部」：核心 setFilter 不再被调用（共仍是 5 次）、列表与按下状态不变', (await sfCalls(page)).length === 5 && J(await domIds(page)) === J(RAIL_IDS) && J(await railPressed(page)) === J(D0), await sfCalls(page));
      // 视图四项
      await railClick(page, 'view:stale');
      check('W57 视图「需复验」→ [203, 205, 207]（验收摘要陈旧的 3 个）；头部「清除 1 项」', J(await domIds(page)) === J([203, 205, 207]) && J(await railPressed(page)) === J(['view:stale', 'layer:', 'status:', 'domain:']) && (await railHead(page)) === '筛选清除 1 项', { ids: await domIds(page) });
      await railClick(page, 'view:custom');
      check('W57 视图同组单选：点「自定义脚本」→ [204, 205, 207]，需复验释放', J(await domIds(page)) === J([204, 205, 207]) && J(await railPressed(page)) === J(['view:custom', 'layer:', 'status:', 'domain:']), { ids: await domIds(page) });
      await railClick(page, 'view:pending');
      check('W57 视图「未接入登记」→ [204]（custom 且 rel.obj=0；#205 有 3 个对象、#207 关系加载失败 rel=null 都不算）', J(await domIds(page)) === J([204]) && J(await railPressed(page)) === J(['view:pending', 'layer:', 'status:', 'domain:']), { ids: await domIds(page) });
      await railClick(page, 'view:');
      check('W57 视图「全部模型」→ 回到全部 11 行，四组「全部」按下', J(await domIds(page)) === J(RAIL_IDS) && J(await railPressed(page)) === J(D0), { ids: await domIds(page) });
      // 分层不分大小写：ODS 项命中 ods / ODS / Ods 三种写法
      await railClick(page, 'layer:ODS');
      check('W57 分层「ODS」→ [201, 202, 203]（ods / ODS / Ods 三种写法都命中）', J(await domIds(page)) === J([201, 202, 203]), { ids: await domIds(page) });
      await railClick(page, 'layer:ODS');
      check('W57 再点已选中的「ODS」→ 取消，回到全部 11 行', J(await domIds(page)) === J(RAIL_IDS) && J(await railPressed(page)) === J(D0), { ids: await domIds(page) });
      // 业务域：未设置 / 未知代码 / 普通代码
      await railClick(page, 'domain:__none__');
      check('W57 业务域「未设置」→ [206, 209, 207, 208]（null / 空串 / 纯空白三种空值都命中；#209 是 #206 的伴生随组显示）', J(await domIds(page)) === J([206, 209, 207, 208]) && J(await railPressed(page)) === J(['view:', 'layer:', 'status:', 'domain:__none__']), { ids: await domIds(page) });
      await railClick(page, 'domain:dom_zzz');
      check('W57 业务域「dom_zzz」（查不到名称、显示代码的那一项）→ [205]', J(await domIds(page)) === J([205]), { ids: await domIds(page) });
      await railClick(page, 'domain:dom_c');
      check('W57 业务域「域丙」→ [210, 211]', J(await domIds(page)) === J([210, 211]), { ids: await domIds(page) });
      await railClick(page, 'domain:');
      check('W57 业务域的「全部」→ 回到全部 11 行', J(await domIds(page)) === J(RAIL_IDS) && J(await railPressed(page)) === J(D0), { ids: await domIds(page) });
      check('W57 视图与业务域点击的核心调用序列（第 6 次起，手写）：view stale → custom → pending → \'\'（全部）；layer ODS → \'\'（取消）；domain __none__ → dom_zzz → dom_c → \'\'（全部）；共 10 次（codex 41Tb-L1：后半段此前只核结果，没核调用）', J((await sfCalls(page)).slice(5)) === J([['view', 'stale'], ['view', 'custom'], ['view', 'pending'], ['view', ''], ['layer', 'ODS'], ['layer', ''], ['domain', '__none__'], ['domain', 'dom_zzz'], ['domain', 'dom_c'], ['domain', '']]), await sfCalls(page));
      // 与搜索词也是 AND
      await railClick(page, 'layer:DWD');
      await page.fill('#searchKeyword', 'rail_207');
      check('W57 筛选与搜索词 AND：DWD + 搜索 rail_207 → [207]', J(await domIds(page)) === J([207]), { ids: await domIds(page) });
      await railClick(page, 'status:ONLINE');
      check('W57 再加「已上线」→ []（#207 是规划中；筛选不会绕过搜索词，搜索词也不会绕过筛选）', J(await domIds(page)) === J([]) && (await page.inputValue('#searchKeyword')) === 'rail_207', { ids: await domIds(page) });
      await railClick(page, 'status:ONLINE');
      check('W57 取消「已上线」→ 回到 [207]', J(await domIds(page)) === J([207]), { ids: await domIds(page) });
      await page.close();
    }

    // ===== W80 P23 负例组（codex 41Tb-M4）=====
    // 它锁的是：W57 的「DWD ∧ 已上线」对照例里 #207 没有已上线成员，区分不了「同一成员同时满足全部条件」与「各条件分别由组内任意成员满足」。这里专建一个只在本条用的负例夹具（不动 RAIL11）：
    //   #501 主模型：规划中（CREATED）、验收摘要陈旧（stale）→ 视图「需复验」成立、状态「已上线」不成立；
    //   #502 #501 的伴生：已上线（ONLINE）、无验收摘要（acceptance null：伴生不独立验收，同 RAIL11 的 #209）→ 状态「已上线」成立、视图「需复验」不成立；
    //   #503 单成员对照组：已上线 + 验收陈旧（同一成员两个条件都成立）；#504 单成员：已上线、验收通过（只满足状态）。
    //   生产可达：主模型与伴生的分层、业务域相同，状态与验收摘要各自独立（伴生状态跟随自己的生命周期，验收摘要只挂在主模型上）。
    //   手写期望：状态「已上线」→ #501 组（经伴生 #502）、#503、#504 → [501, 502, 503, 504]；再加视图「需复验」→ A 口径（同一成员）：#501 组没有任何单个成员同时满足 → 整组排除，#504 验收通过不需复验 → [503]；
    //   「各条件分别由任意成员满足」口径会多留下 #501 组 → [501, 502, 503]（页内核心变异 core-p23-separate 对照）。
    console.log('W80 P23 负例组');
    {
      const P23N = (rows) => [
        railRow(rows, 501, { layer: 'dwd', status: 'CREATED', domain: 'dom_a', acceptance: RACC('stale', '2026-03-01 10:00:00', 'pass'), rel: { obj: 1, up: 0, down: 0 } }),
        railRow(rows, 502, { layer: 'dwd', status: 'ONLINE', domain: 'dom_a', config_mode: 'companion', companion_of: 501, acceptance: null, rel: null }),
        railRow(rows, 503, { layer: 'dwd', status: 'ONLINE', domain: 'dom_a', acceptance: RACC('stale', '2026-03-02 10:00:00', 'pass'), rel: { obj: 1, up: 0, down: 0 } }),
        railRow(rows, 504, { layer: 'dwd', status: 'ONLINE', domain: 'dom_a', acceptance: RACC('pass', '2026-03-03 10:00:00'), rel: { obj: 1, up: 0, down: 0 } }),
      ];
      const { page } = await open(adminN, 'W80', '', { beforeGoto: rewriteList(P23N) });
      check('W80 前置：默认 4 行 3 组（伴生 #502 紧跟 #501）', J(await domIds(page)) === J([501, 502, 503, 504]), await domIds(page));
      await railClick(page, 'status:ONLINE');
      check('W80 状态「已上线」→ [501, 502, 503, 504]（#501 组经伴生 #502 命中；#503、#504 自身已上线）', J(await domIds(page)) === J([501, 502, 503, 504]), await domIds(page));
      await railClick(page, 'view:stale');
      check('W80 再加视图「需复验」（状态 ∧ 视图）：[503]——#501 组里没有任何单个成员同时满足（主模型需复验但不是已上线，伴生已上线但不需复验）整组排除；「各条件分别由任意成员满足」口径会得 [501, 502, 503]；#504 已上线但验收通过，不需复验', J(await domIds(page)) === J([503]), await domIds(page));
      await railClick(page, 'status:ONLINE');
      check('W80 取消状态后只剩视图「需复验」→ [501, 502, 503]（#501 主模型自身需复验，伴生 #502 随组显示；#503 需复验）', J(await domIds(page)) === J([501, 502, 503]), await domIds(page));
      await page.close();
    }

    // ===== W58 左栏：筛选回第 1 页并收起展开、「清除 N 项」只清筛选 =====
    // 它锁的是：改筛选（点项 / 取消 / 清除）都回第 1 页、收起全部展开（核心负责，页面不覆盖）；「清除 N 项」对取值非「全部」的组逐个调核心 setFilter(组, '')，最后列表回第 1 页、展开收起；
    //   只清筛选：搜索框的词、排序（id 降序）都不变。夹具 RAIL35 = RAIL11 + 25 个 ODS / 已上线单行组（#301…#325）：共 35 组；id 降序的第 1 页 = 325…306，第 2 页 = 305…301, 211, 210, 208, 207, 206, 209, 205, 204, 203, 202, 201（15 组 16 行）。
    //   已上线 ∧ 无其他条件的 29 组：id 降序第 2 页 = 305…301, 206, 209, 204, 202, 201；再加 ODS 的 27 组：第 2 页 = 305…301, 202, 201。
    console.log('W58 左栏：回第 1 页 / 收起展开 / 清除 N 项');
    {
      const { page } = await open(adminN, 'W58', '', { beforeGoto: rewriteList(RAIL35) });
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await spySetFilter(page);
      const P1 = range(306, 325).reverse();
      await clickC(page, '.catalog-toolbar button[data-sort-by="id"]');
      // fix41b（预筛 LOW-1，41Tb-M1 点名 W58）：点「ID」后、填搜索词之前立即核顺序——搜索引发的重画会掩盖排序点击自己没重画的错误。手写：RAIL35 共 35 组，按组主模型 id 降序 = 325…301, 211, 210, 208, 207, 206(+209), 205…201，第 1 页前 20 组 = 325…306 = P1
      check('W58 点「ID」排序后立即核列表顺序（RAIL35、id 降序，第 1 页 = 325…306，手写 P1）；状态是 id / desc；之后才填搜索词', J(await domIds(page)) === J(P1) && (await page.evaluate(() => currentSortBy + '/' + currentSortDir)) === 'id/desc', { ids: await domIds(page) });
      await page.fill('#searchKeyword', 'rail');
      check('W58 前置：id 降序 + 搜索 rail（全部命中）：35 组，第 1 页 = 325…306，状态是 id / desc', J(await domIds(page)) === J(P1) && (await page.evaluate(() => currentSortBy + '/' + currentSortDir)) === 'id/desc' && (await page.evaluate(() => getCatalogView().totalGroups)) === 35, await domIds(page));
      await clickC(page, '#paginationControls button:text-is("2")');
      check('W58 前置：翻到第 2 页 = 305…301, 211, 210, 208, 207, 206, 209, 205, 204, 203, 202, 201', J(await domIds(page)) === J([305, 304, 303, 302, 301, 211, 210, 208, 207, 206, 209, 205, 204, 203, 202, 201]) && (await page.evaluate(() => currentPage)) === 2, await domIds(page));
      await toggleOf(page, 305);
      check('W58 前置：展开 #305 → loaded，关系请求恰 1 次', (await waitPane(page, 305, 'loaded')) && J(relIds) === J([305]) && J(await stateExpanded(page)) === J(['305']));
      await railClick(page, 'status:ONLINE');
      const a = await page.evaluate(() => ({ page: currentPage, st: catalogEventState.expanded.map(String), panes: document.querySelectorAll('#modelListBody .pane').length }));
      check('W58 在第 2 页点「已上线」：回第 1 页（现在共 29 组仍有第 2 页，不回第 1 页的话会停在第 2 页）、展开全部收起（状态展开集合空、面板 0 个）；第 1 页 = 325…306', a.page === 1 && J(a.st) === J([]) && a.panes === 0 && J(await domIds(page)) === J(P1), a);
      await clickC(page, '#paginationControls button:text-is("2")');
      check('W58 前置：已上线共 29 组，第 2 页 = 305…301, 206, 209, 204, 202, 201', J(await domIds(page)) === J([305, 304, 303, 302, 301, 206, 209, 204, 202, 201]), await domIds(page));
      await railClick(page, 'layer:ODS');
      check('W58 在第 2 页再点「ODS」（已上线 ∧ ODS，27 组）：回第 1 页 = 325…306；头部「清除 2 项」', (await page.evaluate(() => currentPage)) === 1 && J(await domIds(page)) === J(P1) && (await railHead(page)) === '筛选清除 2 项', await domIds(page));
      await clickC(page, '#paginationControls button:text-is("2")');
      check('W58 前置：已上线 ∧ ODS 第 2 页 = 305…301, 202, 201', J(await domIds(page)) === J([305, 304, 303, 302, 301, 202, 201]), await domIds(page));
      await toggleOf(page, 304);
      check('W58 前置：展开 #304 → loaded（关系请求累计 [305, 304]）', (await waitPane(page, 304, 'loaded')) && J(relIds) === J([305, 304]));
      await clickC(page, '#catalogRail [data-catalog-act="rail-clear"]');
      const b = await page.evaluate(() => ({ page: currentPage, st: catalogEventState.expanded.map(String), panes: document.querySelectorAll('#modelListBody .pane').length, q: document.getElementById('searchKeyword').value, by: currentSortBy, dir: currentSortDir, aria: document.querySelector('.catalog-toolbar button[data-sort-by="id"]').getAttribute('aria-sort'), filters: Object.keys(catalogFilters).filter((k) => catalogFilters[k] !== '' && catalogFilters[k] !== null && catalogFilters[k] !== undefined) }));
      check('W58 「清除 2 项」：回第 1 页（35 组仍有第 2 页，不回第 1 页就停在第 2 页）= 325…306、展开全部收起、面板 0 个', b.page === 1 && J(b.st) === J([]) && b.panes === 0 && J(await domIds(page)) === J(P1), b);
      check('W58 「清除 2 项」只清筛选：搜索框仍是 rail、排序仍是 id 降序（按钮 aria-sort=descending）、catalogFilters 里没有非空取值；四组「全部」按下，头部「筛选全部」', b.q === 'rail' && b.by === 'id' && b.dir === 'desc' && b.aria === 'descending' && J(b.filters) === J([]) && J(await railPressed(page)) === J(D0) && (await railHead(page)) === '筛选全部', b);
      check('W58 核心 setFilter 的调用序列（函数名 + 筛选键与取值）：点已上线、点 ODS、清除时对非「全部」的两组逐个清（layer 在前 status 在后，按左栏组顺序）= [[status,ONLINE],[layer,ODS],[layer,\'\'],[status,\'\']]；展开请求没有因收起而重发（[305, 304]）', J(await sfCalls(page)) === J([['status', 'ONLINE'], ['layer', 'ODS'], ['layer', ''], ['status', '']]) && J(relIds) === J([305, 304]), { sf: await sfCalls(page), relIds });
      await page.close();
    }

    // ===== W59 左栏：?focus= 深链 =====
    // 它锁的是：核心 focus 清空搜索与筛选后，左栏回到「全部」（选中态与 catalogFilters、搜索框一致）；目标 #65（开发中，筛选里是规划中所以原本看不到）出现在第 1 页并高亮；之后点左栏仍正常；「清除 N 项」在真实夹具上同样回第 1 页。
    console.log('W59 左栏：?focus= 深链');
    {
      const { page } = await open(adminN, 'W59');
      await railClick(page, 'layer:DIM');
      await railClick(page, 'status:CREATED');
      await page.fill('#searchKeyword', 'dim_');
      check('W59 前置：DIM ∧ 规划中 ∧ 搜索 dim_ → [60, 55, 58, 62]（#50 / #65 是开发中，被筛掉）；按下 layer:DIM / status:CREATED；头部「清除 2 项」', J(await domIds(page)) === J([60, 55, 58, 62]) && J(await railPressed(page)) === J(['view:', 'layer:DIM', 'status:CREATED', 'domain:']) && (await railHead(page)) === '筛选清除 2 项', { ids: await domIds(page) });
      await page.evaluate(() => focusCatalogModel(65));
      const f = await page.evaluate(() => ({ q: document.getElementById('searchKeyword').value, filters: Object.keys(catalogFilters).filter((k) => catalogFilters[k] !== '' && catalogFilters[k] !== null && catalogFilters[k] !== undefined), st: Object.keys(catalogEventState.filters).filter((k) => catalogEventState.filters[k] !== '' && catalogEventState.filters[k] !== null && catalogEventState.filters[k] !== undefined) }));
      check('W59 focusCatalogModel(65) 之后：搜索框清空、catalogFilters 与事件态里都没有非空筛选；左栏四组「全部」按下、头部「筛选全部」（左栏与筛选状态一致）', f.q === '' && J(f.filters) === J([]) && J(f.st) === J([]) && J(await railPressed(page)) === J(D0) && (await railHead(page)) === '筛选全部', f);
      const hl = await page.waitForSelector('#modelListBody [data-id="65"][data-focus-highlight]', { timeout: WAIT }).then(() => true, () => false);
      check('W59 focus 之后列表回到第 1 页的 21 行（含原本被筛掉的 #65）、#65 带高亮', hl && J(await domIds(page)) === J(PAGE1_21), await domIds(page));
      await railClick(page, 'layer:DWD');
      check('W59 focus 之后点左栏仍正常：DWD → [52, 53, 59]，头部「清除 1 项」', J(await domIds(page)) === J([52, 53, 59]) && (await railHead(page)) === '筛选清除 1 项', await domIds(page));
      await clickC(page, '#catalogRail [data-catalog-act="rail-clear"]');
      check('W59 「清除 1 项」→ 回到第 1 页的 21 行，头部「筛选全部」', J(await domIds(page)) === J(PAGE1_21) && (await railHead(page)) === '筛选全部' && J(await railPressed(page)) === J(D0), await domIds(page));
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W59b', '?focus=65');
      const hl = await page.waitForSelector('#modelListBody [data-id="65"][data-focus-highlight]', { timeout: WAIT }).then(() => true, () => false);
      check('W59 地址带 ?focus=65 直接打开：#65 高亮、第 1 页 21 行；左栏四组「全部」按下、头部「筛选全部」', hl && J(await domIds(page)) === J(PAGE1_21) && J(await railPressed(page)) === J(D0) && (await railHead(page)) === '筛选全部', { ids: await domIds(page), pressed: await railPressed(page) });
      await page.close();
    }

    // ===== W60 左栏：数据重载（失败保留计数 / 选中值消失仍可取消）=====
    // 它锁的是：①列表刷新失败（HTTP 500）不动左栏计数与选中态；②一次成功重载（路由去掉 #210、#211，业务域 dom_c 不再出现）按新数据重算计数（总数 9、DWS / WEIRD 项消失）；
    //   ③当前选中的「域丙」已不在计数里，仍列在业务域末尾、计数 0、保持按下，头部「清除 1 项」，列表为空——不让用户困在看不见的筛选里；再点它取消，列表回到 9 行。
    console.log('W60 左栏：数据重载');
    {
      expectErr('W60', U_LIST);
      const { page } = await open(adminN, 'W60', '', { beforeGoto: rewriteList(RAIL11) });
      check('W60 前置：业务域映射到达', await waitRailDomains(page, RD));
      await railClick(page, 'domain:dom_c');
      check('W60 前置：点「域丙」→ [210, 211]，头部「清除 1 项」', J(await domIds(page)) === J([210, 211]) && (await railHead(page)) === '筛选清除 1 项', await domIds(page));
      await page.route(isList, (route) => (route.request().method() !== 'GET' ? route.continue() : route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' })));
      const rFail = await loadBounded(page);
      const aFail = await railAll(page);
      check("W60 列表刷新失败（HTTP 500，loadModels 返回 'failed'）：左栏计数一个都没变（仍是 11 行的手算值）、域丙仍按下、头部「清除 1 项」、列表仍是 [210, 211]", rFail === 'failed' && J(aFail) === J({ v: RV, l: RL, s: RS, d: RD }) && J(await railPressed(page)) === J(['view:', 'layer:', 'status:', 'domain:dom_c']) && (await railHead(page)) === '筛选清除 1 项' && J(await domIds(page)) === J([210, 211]), { rFail, aFail });
      await page.unroute(isList);
      await rewriteList((rows) => RAIL11(rows).filter((r) => r.id !== 210 && r.id !== 211))(page);
      const rOk = await loadBounded(page);
      const aOk = await railAll(page);
      check("W60 一次成功重载（去掉 #210 / #211）：'arrived'；计数按新数据重算——视图 [9, 3, 1, 3]、分层 [全部 9, ODS 3, DIM 2, DWD 3, ADS 1]（DWS 消失）、状态 [全部 9, 规划中 3, 开发中 2, 已上线 4]（WEIRD 消失）", rOk === 'arrived' && J(aOk.v) === J(['全部模型9', '需复验3', '未接入登记1', '自定义脚本3']) && J(aOk.l) === J(['全部9', 'ODS3', 'DIM2', 'DWD3', 'ADS1']) && J(aOk.s) === J(['全部9', '规划中3', '开发中2', '已上线4']), { rOk, aOk });
      check('W60 选中的「域丙」已不在计数里：仍列在业务域末尾、计数 0（域甲 3 / 域乙 2 / dom_zzz 1 / 未设置 3 / 域丙 0），保持按下；头部「清除 1 项」；列表为空', J(aOk.d) === J(['全部9', '域甲3', '域乙2', 'dom_zzz1', '未设置3', '域丙0']) && J(await railPressed(page)) === J(['view:', 'layer:', 'status:', 'domain:dom_c']) && (await railHead(page)) === '筛选清除 1 项' && J(await domIds(page)) === J([]), { d: aOk.d, pressed: await railPressed(page) });
      await railClick(page, 'domain:dom_c');
      check('W60 再点那个 0 计数的「域丙」→ 取消：列表回到 9 行 [201…208 含 209]，域丙项消失，头部「筛选全部」', J(await domIds(page)) === J([201, 202, 203, 204, 205, 206, 209, 207, 208]) && J(await railTexts(page, 'domain')) === J(['全部9', '域甲3', '域乙2', 'dom_zzz1', '未设置3']) && (await railHead(page)) === '筛选全部', { ids: await domIds(page), d: await railTexts(page, 'domain') });
      await page.close();
    }

    // ===== W61 左栏：XSS =====
    // 它锁的是：业务域代码 / 分层 / 状态里的 '、"、&#39;、<img onerror>、<b> 只经 textContent 与 data-rail 属性写入：window.__xss 始终未赋值、左栏里没有 img / onerror / 内联事件 / style，属性只有白名单，文案与 data-rail 值逐字等于原文；
    //   业务域代码里的冒号（a:b）按第一个冒号拆「组:值」，点击后筛选值逐字等于原值，列表按它过滤。
    console.log('W61 左栏：XSS 与值里带冒号');
    {
      const XS = `'"&#39;<img src=x onerror="window.__xss=1">`;
      const { page } = await open(adminN, 'W61', '', { beforeGoto: rewriteList((rows) => [railRow(rows, 401, { layer: 'ods', status: 'ONLINE', domain: XS }), railRow(rows, 402, { layer: 'ods', status: 'ONLINE', domain: 'a:b' }), railRow(rows, 403, { layer: '<b>x</b>', status: '<i>s</i>', domain: 'dom_a' })]) });
      check('W61 前置：业务域映射到达（域甲）', await page.waitForFunction(() => Array.from(document.querySelectorAll('#catalogRail [data-rail^="domain:"]')).some((b) => b.textContent === '域甲1'), null, { timeout: WAIT }).then(() => true, () => false));
      const x = await page.evaluate(() => {
        const ok = new Set(['class', 'type', 'id', 'data-rail', 'data-catalog-act']);
        const bad = [];
        document.querySelectorAll('#catalogRail, #catalogRail *').forEach((e) => { Array.from(e.attributes).forEach((a) => { if (!(ok.has(a.name) || a.name.startsWith('aria-'))) bad.push(e.tagName + '@' + a.name); }); });
        return { xss: window.__xss === undefined, imgs: document.querySelectorAll('#catalogRail img, #catalogRail i, #catalogRail .catalog-rail-lbl b').length, onerr: document.querySelectorAll('#catalogRail [onerror]').length, bad, specs: Array.from(document.querySelectorAll('#catalogRail [data-rail]')).map((b) => b.getAttribute('data-rail')) };
      });
      check('W61 载入后：window.__xss 未赋值、左栏里没有 img / b / i 节点、没有 onerror 属性；左栏所有元素只有白名单属性（class / type / id / data-rail / data-catalog-act / aria-*）', x.xss && x.imgs === 0 && x.onerr === 0 && x.bad.length === 0, x);
      check('W61 data-rail 值逐字等于「<组>:<原值>」（业务域含 XSS 串、a:b；分层大写 <B>X</B>；状态 <i>s</i>）', J(x.specs) === J(['view:', 'view:stale', 'view:pending', 'view:custom', 'layer:', 'layer:ODS', 'layer:<B>X</B>', 'status:', 'status:ONLINE', 'status:<i>s</i>', 'domain:', 'domain:' + XS, 'domain:a:b', 'domain:dom_a']), x.specs);
      const t = await railAll(page);
      check('W61 文案逐字等于原文：分层 [全部 3, ODS 2, <B>X</B> 1]、状态 [全部 3, 已上线 2, <i>s</i> 1]、业务域 [全部 3, XSS 串 1, a:b 1, 域甲 1]', J(t.l) === J(['全部3', 'ODS2', '<B>X</B>1']) && J(t.s) === J(['全部3', '已上线2', '<i>s</i>1']) && J(t.d) === J(['全部3', XS + '1', 'a:b1', '域甲1']), t);
      const clickSpec = (spec) => page.evaluate((s) => { Array.from(document.querySelectorAll('#catalogRail [data-rail]')).find((b) => b.getAttribute('data-rail') === s).click(); }, spec);
      await clickSpec('domain:' + XS);
      const c1 = await page.evaluate(() => ({ v: catalogFilters.domain, xss: window.__xss === undefined }));
      check('W61 点 XSS 业务域项：筛选值逐字等于原串，列表 [401]，window.__xss 仍未赋值', c1.v === XS && c1.xss && J(await domIds(page)) === J([401]), { c1, ids: await domIds(page) });
      await clickSpec('domain:a:b');
      const c2 = await page.evaluate(() => ({ v: catalogFilters.domain }));
      check('W61 点业务域「a:b」：按第一个冒号拆成 domain / a:b，筛选值 = a:b，列表 [402]（按最后一个冒号拆会把组拆成 domain:a 而点击无效）', c2.v === 'a:b' && J(await domIds(page)) === J([402]), { c2, ids: await domIds(page) });
      await clickSpec('layer:<B>X</B>');
      const c3 = await page.evaluate(() => ({ layer: catalogFilters.layer, domain: catalogFilters.domain }));
      check('W61 再点分层「<B>X</B>」（与业务域 a:b 同时生效，两组 AND）：筛选值逐字是 <B>X</B>，业务域仍是 a:b，列表 []（#402 是 ODS、#403 的业务域是 dom_a）', c3.layer === '<B>X</B>' && c3.domain === 'a:b' && J(await domIds(page)) === J([]), { c3, ids: await domIds(page) });
      await clickSpec('domain:a:b');
      check('W61 取消业务域「a:b」后只剩分层筛选：列表 [403]（行里的 <b>x</b> 与筛选值 <B>X</B> 不分大小写命中）', J(await domIds(page)) === J([403]), { ids: await domIds(page) });
      await page.close();
    }

    // ===== W63 viewer 也能用左栏（只读筛选，不涉及权限）=====
    console.log('W63 viewer 左栏');
    {
      const vctx = await mkCtx(USERS[1]);
      const { page } = await open(vctx, 'W63v', '', { beforeGoto: rewriteList(RAIL11) });
      await railClick(page, 'layer:DWD');
      check('W63 viewer：左栏可见、点「DWD」→ [206, 209, 207]，头部「清除 1 项」；计数照常（视图 [11, 3, 1, 3]）', J(await domIds(page)) === J([206, 209, 207]) && (await railHead(page)) === '筛选清除 1 项' && J(await railTexts(page, 'view')) === J(RV), { ids: await domIds(page) });
      await page.close(); await vctx.close();
    }

    // ====================================================================================================================
    // 子批 4c：W64 起（未归属对象）。夹具 UN_ROWS 5 行（schema 为 null / 空串 / 有值；summary 为 null / 空串 / 纯空白 / 有值；verified_at 为 null / 空串 / 有值；
    //   徽章 一致+不一致 / 未核验×2 / 核验失败×2（带 failure）/ doc·reg 都为 null（FDL_TASK）/ 未知 code + 待重核）。期望值全部手写在 UN_WANT（helpers 段）。
    //   本段所有页面都经 unRoute 改写 GET /api/model-impl-objects?unowned=1；故意制造 HTTP 500 / 连接失败的页面标签经 expectErr 登记（U_UNOWNED 模式）。
    // ====================================================================================================================

    // ===== W64 入口与计数 =====
    // 它锁的是（补充派单 §2.1 / §2.2）：①入口是 button#catalogRailUnowned（type=button，data-catalog-act="unowned"，aria-pressed），不带 data-rail / data-act / data-entry，内含 span#catalogRailUnownedCount；
    //   ②初始化时发恰 1 次 GET /api/model-impl-objects?unowned=1（路径 + 查询串逐字），数据到达前计数「—」、到达后 = 数组长度；③数据未到就点入口：进入模式显示「加载中…」，响应到达后就地换成表格；
    //   ④模型列表重载（loadModels）不重取未归属清单；⑤空数组：计数「0」，表格位置「没有未归属对象」；⑥失败（HTTP 500 / 200 非数组 / 200 非 JSON / 连接失败 / 元素缺 obj_name / 元素是 null）：计数「—」，进入后「加载失败」+ 重试按钮，不弹 toast，不影响模型列表。
    console.log('W64 未归属入口与计数');
    {
      const un = { n: 0 }; const g = gate();
      const { page } = await open(adminN, 'W64a', '', { noIdle: true, beforeGoto: both(initSpies([]), unRoute(un, async () => { await g.p; return { json: UN_ROWS }; })) });
      check('W64 前置：初始化请求已到达路由（被扣住，数据还没到）', await untilTrue(() => un.n >= 1));
      const pre = await unBtn(page); const box = await unBox(page);
      check('W64 入口：button#catalogRailUnowned（type=button）、data-catalog-act="unowned"、aria-pressed="false"；不带 data-rail / data-act / data-entry；计数 span 在按钮内；数据到达前计数「—」（不是 0）', !!pre && pre.tag === 'BUTTON' && pre.type === 'button' && pre.act === 'unowned' && pre.pressed === 'false' && !pre.hasRail && !pre.hasDataAct && !pre.hasEntry && pre.cntInside && pre.count === '—', pre);
      check('W64 入口所在区块：左栏最后一个区块、虚线框、标题「未归属对象」、说明「登记了但没挂到任何模型的运维对象」；框内恰 1 个可点元素（入口按钮本身）', !!box && box.last === true && box.bs === 'dashed' && box.h5 === '未归属对象' && box.fine === '登记了但没挂到任何模型的运维对象' && J(box.ctl) === J(['catalogRailUnowned']), box);
      await clickC(page, '#catalogRailUnowned');
      const e1 = await unPanel(page); const lp1 = await listParts(page); const b1 = await unBtn(page);
      check('W64 数据未到就点入口：进入未归属模式——入口 aria-pressed="true"；面板可见、状态块「加载中…」、没有表格 / 重试按钮；工具条 / 列头 / 列表体 / 分页都不可见', !!b1 && b1.pressed === 'true' && !!e1 && e1.vis && e1.state === '加载中…' && e1.tables === 0 && e1.retry === null && lp1.toolbar === false && lp1.head === false && lp1.body === false && lp1.pager === false, { b1, e1, lp1 });
      g.release();
      check('W64 响应到达：就地换成表格（5 行）、入口计数「5」、仍在未归属模式（aria-pressed 仍为 true）、状态块消失', (await waitUnRows(page, 5)) && (await waitUnCount(page, '5')) && (await unBtn(page)).pressed === 'true' && (await unPanel(page)).state === null, await unPanel(page));
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="unowned-back"]', '4c 返回按钮存在且可见（第 1 处点击）');
      const b2 = await unBtn(page); const lp2 = await listParts(page); const e2 = await unPanel(page);
      check('W64 返回后：入口 aria-pressed="false"、计数仍「5」、面板隐藏、工具条 / 列头 / 列表体 / 分页恢复可见', b2.pressed === 'false' && b2.count === '5' && e2.vis === false && lp2.toolbar && lp2.head && lp2.body && lp2.pager, { b2, lp2 });
      check('W64 初始化期间未归属请求恰 1 次，方法与路径逐字为 GET /api/model-impl-objects?unowned=1', un.n === 1 && J(un.reqs) === J(['GET /api/model-impl-objects?unowned=1']), un);
      const rl = await loadBounded(page);
      check("W64 模型列表重载（loadModels，返回 'arrived'）不重新取未归属清单：请求仍恰 1 次、计数仍「5」", rl === 'arrived' && un.n === 1 && (await unBtn(page)).count === '5', { rl, n: un.n });
      await page.close();
    }
    {
      const un = { n: 0 };
      const { page } = await open(adminN, 'W64b', '', { beforeGoto: unRoute(un, async () => ({ json: [] })) });
      check('W64 空数组：计数「0」（数据到了，不是「—」）', await waitUnCount(page, '0'));
      await clickC(page, '#catalogRailUnowned');
      const p = await unPanel(page);
      check('W64 空数组：进入后表格位置显示「没有未归属对象」，没有表格 / 重试按钮；标题「未归属对象」，返回按钮「返回模型列表」', !!p && p.vis && p.state === '没有未归属对象' && p.tables === 0 && p.retry === null && p.title === '未归属对象' && !!p.back && p.back.text === '返回模型列表', p);
      await page.close();
    }
    const FAIL_FORMS = [
      ['HTTP 500', { status: 500, body: '{"error":"桩"}' }],
      ['200 非数组', { json: { a: 1 } }],
      ['200 非 JSON', { status: 200, body: '<html>x</html>' }],
      ['连接失败', { abort: true }],
      ['元素缺 obj_name', { json: [{ id: 1, obj_type: 'PROC', badges: { doc: null, reg: null } }] }],
      ['元素是 null', { json: [null] }],
    ];
    for (let i = 0; i < FAIL_FORMS.length; i++) {
      const [label, resp] = FAIL_FORMS[i];
      if (resp.status === 500 || resp.abort) expectErr('W64c' + i, U_UNOWNED);   // 4d：只有真发出 HTTP 500 / 连接失败的形态才登记（200 非数组 / 非 JSON / 元素形状不对不产生浏览器错误）
      const un = { n: 0 };
      const { page } = await open(adminN, 'W64c' + i, '', { beforeGoto: both(initSpies([]), unRoute(un, async () => resp)) });
      check('W64 失败（' + label + '）前置：请求已到达路由，模型列表照常（PAGE1_21），列表区没有失败提示', un.n === 1 && J(await domIds(page)) === J(PAGE1_21) && (await listParts(page)).notice === false, { n: un.n });
      await clickC(page, '#catalogRailUnowned');
      check('W64 失败（' + label + '）：进入后显示「加载失败」', await waitUnState(page, '加载失败'));
      const p = await unPanel(page); const b = await unBtn(page);
      check('W64 失败（' + label + '）：计数「—」（不是 0）；状态块「加载失败」+ button[data-catalog-act="retry-unowned"]（文字「重试」，未置灰，不带 data-act）；没有表格；不弹 toast', b.count === '—' && p.state === '加载失败重试' && p.stateIsError && !!p.retry && p.retry.tag === 'BUTTON' && p.retry.text === '重试' && p.retry.disabled === false && p.retry.hasDataAct === false && p.tables === 0 && (await page.evaluate(() => window.__toasts.length)) === 0, { b, p });
      await page.close();
    }

    // ===== W65 未归属模式与表格 =====
    // 它锁的是（补充派单 §2.3）：点入口后——入口 aria-pressed="true"；列表区的工具条 / 列头 / 列表体 / 分页一并隐藏（左栏与页头仍在）；面板里有标题「未归属对象」+ 一句说明 +「返回模型列表」按钮（button[data-catalog-act="unowned-back"]，不带 data-act）；
    //   表头 [类型, 名称, 摘要, 徽章, 核验时间]；5 行逐格等于手写期望（schema 为 null / 空串只显示 obj_name；summary / verified_at 为 null / 空串 / 纯空白显示「—」；
    //   徽章文案与色调类、悬停提示、FDL_TASK 的单个「—」、未知 code 原样显示 + muted 色调，与展开区实现对象表同一套渲染）。
    console.log('W65 未归属对象表格');
    {
      const un = { n: 0 };
      const { page } = await open(adminN, 'W65', '', { beforeGoto: both(initSpies([]), unRoute(un, async () => ({ json: UN_ROWS }))) });
      check('W65 前置：计数「5」（= 响应数组长度）', await waitUnCount(page, '5'));
      await clickC(page, '#catalogRailUnowned');
      const b = await unBtn(page); const p = await unPanel(page); const lp = await listParts(page);
      const keep = await page.evaluate(() => ({ rail: document.getElementById('catalogRail').getBoundingClientRect().width > 0, h1: !!document.querySelector('.catalog-pagehead h1') && document.querySelector('.catalog-pagehead h1').getBoundingClientRect().height > 0, total: document.getElementById('catalogTotalCount').textContent }));
      check('W65 进入后：入口 aria-pressed="true"；工具条 / 列头 / 列表体 / 分页 / 搜索框都不可见；左栏与页头标题仍可见，在册数仍是 36', b.pressed === 'true' && lp.toolbar === false && lp.head === false && lp.body === false && lp.pager === false && lp.search === false && keep.rail && keep.h1 && keep.total === '36', { b, lp, keep });
      check('W65 面板：可见；标题「未归属对象」；有说明（含「登记了但没挂到任何模型的运维对象」）；返回按钮是 button、文字「返回模型列表」、不带 data-act；恰 1 个表格', !!p && p.vis && p.title === '未归属对象' && typeof p.desc === 'string' && p.desc.includes('登记了但没挂到任何模型的运维对象') && !!p.back && p.back.tag === 'BUTTON' && p.back.type === 'button' && p.back.text === '返回模型列表' && p.back.hasDataAct === false && p.tables === 1 && p.state === null, p);
      check('W65 表头恰为 [类型, 名称, 摘要, 徽章, 核验时间]；表格 5 行（顺序 = 响应顺序）', J(p.heads) === J(['类型', '名称', '摘要', '徽章', '核验时间']) && p.rows.length === 5, { heads: p.heads, n: p.rows.length });
      UN_WANT.forEach((w, i) => {
        const r = p.rows[i];
        check('W65 第 ' + (i + 1) + ' 行（' + w[1] + '）：五格逐格相等——类型 / 名称 / 摘要 / 徽章文案·色调类·悬停 / 核验时间', unRowOk(r, w), r);
      });
      check('W65 请求仍只有初始化的 1 次（进入模式不重发请求）', un.n === 1, un.n);
      await page.close();
    }

    // ===== W66 未归属清单 XSS（§4.3）=====
    // 它锁的是：类型 / schema / 对象名 / 摘要 / 核验时间 / 徽章 code / failure 里写入 <img src=x onerror=window.__xss=1>、单双引号、&#39;、</td>、</tbody></table> 后——不执行（window.__xss 未定义）、面板里没有 img / b 节点、没有 onerror / style 属性、
    //   每行恰 5 个 td（</td> 没有把格子切开）、全部文字逐字等于原文；面板所有元素只有白名单属性。
    console.log('W66 未归属清单 XSS');
    {
      const XSI = '<img src=x onerror=window.__xss=1>';
      const XSQ = `'"&#39;` + XSI;
      const ROWS = [
        { id: 921, obj_type: XSI, schema_name: XSQ, obj_name: '</td><td>x</td>' + XSI, summary: `'"&#39;</td></tr>` + XSI, verified_at: XSI + `'"`, badges: { doc: XSI, reg: 'verify_failed', failure: { at: XSI, error: `"><img src=x onerror=window.__xss=1>'` } } },
        { id: 922, obj_type: '"', schema_name: "'", obj_name: '</tbody></table><b>z</b>', summary: '&lt;b&gt;', verified_at: '</td>', badges: { doc: null, reg: null } },
      ];
      const un = { n: 0 };
      const { page } = await open(adminN, 'W66', '', { beforeGoto: both(initSpies([]), unRoute(un, async () => ({ json: ROWS }))) });
      check('W66 前置：计数「2」', await waitUnCount(page, '2'));
      await clickC(page, '#catalogRailUnowned');
      check('W66 前置：表格 2 行已渲染', await waitUnRows(page, 2));
      const x = await page.evaluate(() => {
        const p = document.getElementById('catalogUnownedPanel');
        const ok = new Set(['class', 'type', 'id', 'data-catalog-act', 'title', 'role', 'aria-label', 'hidden', 'disabled']);
        const bad = [];
        [p].concat(Array.from(p.querySelectorAll('*'))).forEach((e) => { Array.from(e.attributes).forEach((a) => { if (!(ok.has(a.name) || a.name.startsWith('aria-'))) bad.push(e.tagName + '@' + a.name); }); });
        const rows = Array.from(p.querySelectorAll('tbody tr')).map((tr) => ({ n: tr.children.length, cells: Array.from(tr.children).slice(0, 3).map((c) => c.textContent).concat([tr.children[4] ? tr.children[4].textContent : null]), badges: Array.from(tr.children[3].children).map((b) => ({ t: b.textContent, title: b.getAttribute('title') })) }));
        return { xss: window.__xss === undefined, imgs: p.querySelectorAll('img, b').length, onerr: p.querySelectorAll('[onerror], [style]').length, tables: p.querySelectorAll('table').length, trs: p.querySelectorAll('tbody tr').length, bad, rows };
      });
      check('W66 载入后：window.__xss 未赋值、面板里没有 img / b 节点、没有 onerror / style 属性、仍恰 1 个表格 2 行；面板所有元素只有白名单属性', x.xss && x.imgs === 0 && x.onerr === 0 && x.tables === 1 && x.trs === 2 && x.bad.length === 0, x);
      check('W66 第 1 行：恰 5 个 td（</td> 没有切开格子）；类型 / 名称（schema.obj_name）/ 摘要 / 核验时间逐字等于原文', x.rows[0].n === 5 && x.rows[0].cells[0] === XSI && x.rows[0].cells[1] === XSQ + '.</td><td>x</td>' + XSI && x.rows[0].cells[2] === `'"&#39;</td></tr>` + XSI && x.rows[0].cells[3] === XSI + `'"`, x.rows[0]);
      check('W66 第 1 行徽章：未知 code 原样显示「文档 <img…>」、悬停为普通提示；verify_failed 的悬停写「核验失败于 <at>：<error>」逐字等于原文', J(x.rows[0].badges.map((b) => b.t)) === J(['文档 ' + XSI, '登记 核验失败']) && x.rows[0].badges[0].title === HINT_DOC && x.rows[0].badges[1].title === '核验失败于 ' + XSI + '：' + `"><img src=x onerror=window.__xss=1>'`, x.rows[0].badges);
      check('W66 第 2 行：恰 5 个 td；类型「"」、名称「\'.</tbody></table><b>z</b>」、摘要「&lt;b&gt;」、核验时间「</td>」逐字；徽章单个「—」', x.rows[1].n === 5 && x.rows[1].cells[0] === '"' && x.rows[1].cells[1] === "'.</tbody></table><b>z</b>" && x.rows[1].cells[2] === '&lt;b&gt;' && x.rows[1].cells[3] === '</td>' && J(x.rows[1].badges.map((b) => b.t)) === J(['—']), x.rows[1]);
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="unowned-back"]', '4c 返回按钮存在且可见（第 2 处点击）');
      check('W66 返回后 window.__xss 仍未赋值', (await page.evaluate(() => window.__xss === undefined)) && (await page.evaluate(() => document.querySelectorAll('img[src="x"]').length)) === 0);
      await page.close();
    }

    // ===== W67 失败 → 重试 =====
    // 它锁的是（补充派单 §2.2 / §2.3）：请求序列 500 → 500（被扣住）→ 200：①第 1 次失败后进入：「加载失败」+ 重试（可点）；②点重试发出第 2 次请求，在途期间状态块仍是「加载失败」、重试按钮置灰（disabled），
    //   在途时再点（DOM click、直接调 catalogRetryUnowned）都不发请求（请求恰 2 次）；③第 2 次也失败 → 按钮恢复可点；④再点重试（第 3 次）成功 → 就地换成表格（5 行），计数「5」，仍在未归属模式；全程不弹 toast。
    console.log('W67 未归属失败重试');
    {
      expectErr('W67', U_UNOWNED);
      const un = { n: 0 }; const g2 = gate();
      const { page } = await open(adminN, 'W67', '', { beforeGoto: both(initSpies([]), unRoute(un, async (n) => { if (n === 1) return { status: 500, body: '{"error":"桩"}' }; if (n === 2) { await g2.p; return { status: 500, body: '{"error":"桩"}' }; } return { json: UN_ROWS }; })) });
      await clickC(page, '#catalogRailUnowned');
      check('W67 前置：第 1 次失败后进入显示「加载失败」，重试可点，计数「—」', (await waitUnState(page, '加载失败')) && (await unPanel(page)).retry.disabled === false && (await unBtn(page)).count === '—');
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="retry-unowned"]', '4c 重试按钮存在且可见（第 1 处点击）');
      check('W67 点重试：第 2 次请求已到达路由（被扣住）', await untilTrue(() => un.n === 2));
      const mid = await unPanel(page);
      check('W67 在途期间：状态块仍是「加载失败」（不闪成「加载中…」）、重试按钮置灰（disabled）、没有表格', mid.state === '加载失败重试' && !!mid.retry && mid.retry.disabled === true && mid.tables === 0, mid);
      await page.evaluate(() => { document.querySelector('#catalogUnownedPanel [data-catalog-act="retry-unowned"]').click(); catalogRetryUnowned(); });
      await stableCount(page, 400);
      check('W67 在途时再点（DOM click 一次 + 直接调 catalogRetryUnowned() 一次）都不再发请求：路由收到的请求仍恰 2 次', un.n === 2 && un.reqs.length === 2, un);
      g2.release();
      check('W67 第 2 次也失败：按钮恢复可点（disabled=false），仍是「加载失败」，计数「—」', (await page.waitForFunction(() => { const r = document.querySelector('#catalogUnownedPanel [data-catalog-act="retry-unowned"]'); return !!r && !r.disabled; }, null, { timeout: WAIT }).then(() => true, () => false)) && (await unBtn(page)).count === '—');
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="retry-unowned"]', '4c 重试按钮存在且可见（第 2 处点击）');
      check('W67 第 3 次成功：就地换成表格（5 行），计数「5」，入口仍按下（aria-pressed="true"），请求恰 3 次', (await waitUnRows(page, 5)) && (await waitUnCount(page, '5')) && (await unBtn(page)).pressed === 'true' && un.n === 3, { n: un.n });
      const fin = await unPanel(page);
      check('W67 成功后表格内容逐行等于手写期望（第 1 行与第 5 行抽查），状态块消失、没有重试按钮；全程 showToast 0 次', fin.state === null && fin.retry === null && unRowOk(fin.rows[0], UN_WANT[0]) && unRowOk(fin.rows[4], UN_WANT[4]) && (await page.evaluate(() => window.__toasts.length)) === 0, fin);
      await page.close();
    }

    // ===== W68 迟到的旧响应被丢弃 =====
    // 它锁的是（补充派单 §2.2）：请求序号只认最新一次——初始化请求先正常完成（5 行），然后在页内连发两次 catalogLoadUnowned()：第 1 次（路由第 2 个请求）被扣住，第 2 次（路由第 3 个请求）返回 UN_B（2 行）并生效；
    //   放行第 1 次后：迟到成功（5 行）/ 迟到 HTTP 500 / 迟到连接失败 都不动状态：第 1 次的 Promise 以 'discarded' 结束，计数仍「2」，表格仍是 UN_B。
    console.log('W68 未归属迟到响应');
    for (const [kind, late] of [['迟到成功（5 行）', { json: UN_ROWS }], ['迟到 HTTP 500', { status: 500, body: '{"error":"桩"}' }], ['迟到连接失败', { abort: true }]]) {
      const tag = 'W68' + (kind === '迟到成功（5 行）' ? 'a' : kind === '迟到 HTTP 500' ? 'b' : 'c');
      if (kind !== '迟到成功（5 行）') expectErr(tag, U_UNOWNED);
      const un = { n: 0 }; const g = gate();
      const { page } = await open(adminN, tag, '', { beforeGoto: unRoute(un, async (n) => { if (n === 1) return { json: UN_ROWS }; if (n === 2) { await g.p; return late; } return { json: UN_B }; }) });
      check(tag + ' 前置：初始化请求完成，计数「5」', await waitUnCount(page, '5'));
      await clickC(page, '#catalogRailUnowned');
      await page.evaluate(() => { window.__a = catalogLoadUnowned(); });
      check(tag + ' 前置：第 1 次手动请求（路由第 2 个）已到达并被扣住', await untilTrue(() => un.n === 2));
      const rb = await pageCallBounded(page, 'catalogLoadUnowned()', tag + ' 第 2 次手动未归属请求');
      check(tag + ' 第 2 次手动请求（路由第 3 个，UN_B）生效：返回 \'ok\'，计数「2」，表格 2 行（usp_new / v_new）', rb === 'ok' && (await waitUnCount(page, '2')) && (await waitUnRows(page, 2)) && J((await unPanel(page)).rows.map((r) => r.name)) === J(['dbo.usp_new', 'dbo.v_new']), { rb });
      g.release();
      const ra = await pageAwait(page, '__a');
      const after = await unPanel(page);
      check(tag + '（' + kind + '）：第 1 次的 Promise 以 \'discarded\' 结束；计数仍「2」、表格仍是 UN_B 的 2 行、没有出现「加载失败」、入口仍按下', ra === 'discarded' && (await unBtn(page)).count === '2' && after.rows.length === 2 && J(after.rows.map((r) => r.name)) === J(['dbo.usp_new', 'dbo.v_new']) && after.state === null && after.retry === null && (await unBtn(page)).pressed === 'true', { ra, after });
      await page.close();
    }

    // ===== W69 返回恢复进入前的画面（五要素）=====
    // 它锁的是（补充派单 §2.4）：进入前的状态——id 降序（排序）、搜索 ods_filler（搜索词）、分层 ODS（筛选）、第 2 页（页码）、#104 展开且已 loaded（展开集合与关系数据）、列表刷新失败提示可见——
    //   进入未归属模式后这些状态原样不动（页内状态逐项读），列表区各部分（含失败提示）不可见；点「返回模型列表」/ 再点一次入口都恢复为进入前：五要素 + 条目 id 序列 + 展开内容逐项相等，
    //   且没有重发关系请求、列表请求、未归属请求。
    console.log('W69 返回恢复五要素');
    {
      expectErr('W69', U_LIST);
      const un = { n: 0 };
      const { page, reqs } = await open(adminN, 'W69', '', { beforeGoto: both(initSpies([]), unRoute(un, async () => ({ json: UN_ROWS }))) });
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: { upstream: [{ source_system: 'SYS_A', source_table: 'ods_src_' + id + '_' + n }], downstream: [], objects: [], objectState: 'standard' } }));
      check('W69 前置：未归属计数「5」', await waitUnCount(page, '5'));
      await clickC(page, '.catalog-toolbar button[data-sort-by="id"]');
      await railClick(page, 'layer:ODS');
      await page.fill('#searchKeyword', 'ods_filler');
      await clickC(page, '#paginationControls button:text-is("2")');
      await toggleOf(page, 104);
      check('W69 前置：#104 展开且 loaded（关系请求恰 1 次）', (await waitPane(page, 104, 'loaded')) && J(relIds) === J([104]));
      await page.route(isList, (route) => (route.request().method() !== 'GET' ? route.continue() : route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' })));
      const rFail = await loadBounded(page);
      await page.unroute(isList);
      const cap = () => page.evaluate(() => {
        const pane = document.getElementById('pane-104'); const n = document.getElementById('catalogListNotice');
        return {
          page: currentPage, sortBy: currentSortBy, sortDir: currentSortDir, query: document.getElementById('searchKeyword').value,
          filters: Object.keys(catalogFilters).filter((k) => catalogFilters[k] !== '' && catalogFilters[k] != null).map((k) => k + '=' + catalogFilters[k]),
          expanded: catalogEventState.expanded.map(String), status104: catalogEventState.expandStatus['104'] || null, rel104: JSON.stringify(catalogEventState.relations['104'] || null),
          ids: Array.from(document.querySelectorAll('#modelListBody [data-id]')).map((e) => Number(e.getAttribute('data-id'))),
          paneText: pane ? pane.textContent : null, paneCls: pane ? pane.className : null,
          pressed: Array.from(document.querySelectorAll('#catalogRail [data-rail][aria-pressed="true"]')).map((b) => b.getAttribute('data-rail')), head: document.querySelector('#catalogRail .catalog-rail-head').textContent,
          notice: n ? { hidden: n.hidden, text: n.textContent } : null,
        };
      });
      const S0 = await cap();
      const WANT0 = { page: 2, sortBy: 'id', sortDir: 'desc', query: 'ods_filler', filters: ['layer=ODS'], expanded: ['104'], status104: 'loaded', ids: [105, 104, 103, 102, 101], pressed: ['view:', 'layer:ODS', 'status:', 'domain:'], head: '筛选清除 1 项' };
      check("W69 前置（进入前的画面，手写期望）：第 2 页 / id 降序 / 搜索 ods_filler / 分层 ODS / #104 展开 loaded / 条目 [105, 104, 103, 102, 101] / 左栏 ODS 按下；刷新失败（返回 'failed'）后失败提示可见", rFail === 'failed' && S0.page === WANT0.page && S0.sortBy === WANT0.sortBy && S0.sortDir === WANT0.sortDir && S0.query === WANT0.query && J(S0.filters) === J(WANT0.filters) && J(S0.expanded) === J(WANT0.expanded) && S0.status104 === WANT0.status104 && J(S0.ids) === J(WANT0.ids) && J(S0.pressed) === J(WANT0.pressed) && S0.head === WANT0.head && !!S0.notice && S0.notice.hidden === false && S0.notice.text.includes('列表刷新失败，显示的是上次数据') && !!S0.paneText && S0.paneText.includes('SYS_A · ods_src_104_1') && (await listParts(page)).notice === true, { rFail, S0 });
      const nList0 = reqs.n; const nUn0 = un.n;
      await clickC(page, '#catalogRailUnowned');
      const S1 = await cap(); const lp = await listParts(page);
      check('W69 进入未归属模式后：页内状态（页码 / 排序 / 搜索词 / 筛选 / 展开集合 / 关系数据 / 条目 DOM / 展开内容 / 左栏按下项 / 失败提示文字）与进入前逐项相同；工具条 / 列头 / 列表体 / 分页 / 失败提示都不可见', J(S1) === J(S0) && lp.toolbar === false && lp.head === false && lp.body === false && lp.pager === false && lp.notice === false, { S1, lp });
      for (const [how, sel] of [['返回按钮', '#catalogUnownedPanel [data-catalog-act="unowned-back"]'], ['再点一次入口', '#catalogRailUnowned']]) {
        const S2 = await (async () => { await clickIf(page, sel, 'W69 ' + how + '：点击目标存在且可见'); return cap(); })();
        const lp2 = await listParts(page); const b2 = await unBtn(page);
        check('W69 ' + how + '：入口 aria-pressed="false"；页码 2 / id 降序 / 搜索 ods_filler / 分层 ODS / 展开 [104] loaded / 条目 [105…101] / 展开内容 / 失败提示可见 逐项等于进入前；工具条 / 列头 / 列表体 / 分页 / 失败提示都可见', J(S2) === J(S0) && b2.pressed === 'false' && lp2.toolbar && lp2.head && lp2.body && lp2.pager && lp2.notice, { S2, b2, lp2 });
        check('W69 ' + how + '：没有重发请求——关系请求仍 [104]、列表请求数不变、未归属请求数不变', J(relIds) === J([104]) && reqs.n === nList0 && un.n === nUn0, { relIds, list: reqs.n, nList0, un: un.n });
        if (how === '返回按钮') await clickC(page, '#catalogRailUnowned');
      }
      await page.close();
    }

    // ===== W70 未归属模式下点左栏 =====
    // 它锁的是（补充派单 §2.4）：未归属模式下点左栏任一筛选项 / 「清除 N 项」→ 先退出模式（面板隐藏、入口 aria-pressed="false"、列表区恢复），再按 4b 现行为执行（核心 setFilter 调用向量、回第 1 页、收起展开）；
    //   该组本来就是「全部」时点「全部」：照样先退出，筛选动作是空操作（setFilter 不被调用、页码与展开保持）。
    console.log('W70 未归属模式下点左栏');
    {
      const un = { n: 0 };
      const { page } = await open(adminN, 'W70', '', { beforeGoto: both(initSpies([]), unRoute(un, async () => ({ json: UN_ROWS }))) });
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await spySetFilter(page);
      check('W70 前置：未归属计数「5」', await waitUnCount(page, '5'));
      await clickC(page, '#paginationControls button:text-is("2")');
      await toggleOf(page, 113);
      check('W70 前置：第 2 页、#113 展开 loaded', (await page.evaluate(() => currentPage)) === 2 && (await waitPane(page, 113, 'loaded')) && J(await stateExpanded(page)) === J(['113']));
      await clickC(page, '#catalogRailUnowned');
      check('W70 前置：进入未归属模式（面板可见，列表体不可见）', (await unPanel(page)).vis === true && (await listParts(page)).body === false);
      await railClick(page, 'layer:DWD');
      const a = await page.evaluate(() => ({ page: currentPage, st: catalogEventState.expanded.map(String), panes: document.querySelectorAll('#modelListBody .pane').length }));
      check('W70 未归属模式下点「DWD」：先退出模式（面板隐藏、入口 aria-pressed="false"、列表体可见）；再执行筛选：setFilter(layer, DWD) 恰 1 次、列表 [52, 53, 59]、回第 1 页、展开全部收起（状态展开集合空、面板 0 个）；DWD 按下，头部「清除 1 项」', (await unPanel(page)).vis === false && (await unBtn(page)).pressed === 'false' && (await listParts(page)).body === true && J(await sfCalls(page)) === J([['layer', 'DWD']]) && J(await domIds(page)) === J([52, 53, 59]) && a.page === 1 && J(a.st) === J([]) && a.panes === 0 && J(await railPressed(page)) === J(['view:', 'layer:DWD', 'status:', 'domain:']) && (await railHead(page)) === '筛选清除 1 项', { a, sf: await sfCalls(page), ids: await domIds(page) });
      await clickC(page, '#catalogRailUnowned');
      await clickC(page, '#catalogRail [data-catalog-act="rail-clear"]');
      check('W70 未归属模式下点「清除 1 项」：先退出模式；再清筛选：setFilter 序列追加 [layer, \'\']、列表回到 PAGE1_21、头部「筛选全部」、四组「全部」按下', (await unPanel(page)).vis === false && (await unBtn(page)).pressed === 'false' && J(await sfCalls(page)) === J([['layer', 'DWD'], ['layer', '']]) && J(await domIds(page)) === J(PAGE1_21) && (await railHead(page)) === '筛选全部' && J(await railPressed(page)) === J(D0), { sf: await sfCalls(page), ids: await domIds(page) });
      await clickC(page, '#paginationControls button:text-is("2")');
      await toggleOf(page, 113);
      check('W70 前置：回到第 2 页并展开 #113（关系请求累计 [113, 113]）', (await page.evaluate(() => currentPage)) === 2 && (await waitPane(page, 113, 'loaded')) && J(relIds) === J([113, 113]));
      await clickC(page, '#catalogRailUnowned');
      await railClick(page, 'layer:');
      const c = await page.evaluate(() => ({ page: currentPage, st: catalogEventState.expanded.map(String), panes: document.querySelectorAll('#modelListBody .pane').length }));
      check('W70 未归属模式下点已是「全部」的分层「全部」：先退出模式（面板隐藏、入口未按下）；筛选动作是空操作——setFilter 仍只被调用过 2 次、页码仍是 2、展开 [113] 保留（面板 1 个）、没有重发关系请求', (await unPanel(page)).vis === false && (await unBtn(page)).pressed === 'false' && (await sfCalls(page)).length === 2 && c.page === 2 && J(c.st) === J(['113']) && c.panes === 1 && J(relIds) === J([113, 113]), { c, sf: await sfCalls(page), relIds });
      await page.close();
    }

    // ===== W71 未归属模式下模型列表重载 =====
    // 它锁的是（补充派单 §2.4）：未归属模式下发生模型列表重载（loadModels 成功，路由把列表改写成 4 行 [60, 50, 52, 53]）——不退出该模式（面板与表格不变、入口仍按下）、不重取未归属清单（请求仍 1 次）；
    //   页头在册数与左栏计数照常更新（36 → 4、全部模型 4）；返回后列表显示新数据（条目 [60, 50, 52, 53]）。
    console.log('W71 未归属模式下列表重载');
    {
      const un = { n: 0 }; let keep = null;
      const { page } = await open(adminN, 'W71', '', { beforeGoto: both(unRoute(un, async () => ({ json: UN_ROWS })), rewriteList((rows) => (keep ? rows.filter((r) => keep.has(r.id)) : rows))) });
      check('W71 前置：计数「5」，在册数 36', (await waitUnCount(page, '5')) && (await page.evaluate(() => document.getElementById('catalogTotalCount').textContent)) === '36');
      await clickC(page, '#catalogRailUnowned');
      check('W71 前置：进入后表格 5 行', await waitUnRows(page, 5));
      keep = new Set([60, 50, 52, 53]);
      const r = await loadBounded(page);
      const p = await unPanel(page); const b = await unBtn(page);
      check("W71 模式下重载（loadModels 返回 'arrived'）：仍在未归属模式——面板可见、入口 aria-pressed=\"true\"、表格仍是 5 行且逐行等于手写期望（抽查第 1 / 5 行）、计数仍「5」、未归属请求仍恰 1 次", r === 'arrived' && p.vis && b.pressed === 'true' && p.rows.length === 5 && unRowOk(p.rows[0], UN_WANT[0]) && unRowOk(p.rows[4], UN_WANT[4]) && b.count === '5' && un.n === 1, { r, p: { vis: p.vis, n: p.rows.length }, b, n: un.n });
      check('W71 页头在册数更新为 4（含伴生 #53）、左栏「全部模型」计数更新为 4；隐藏着的列表 DOM 已是新数据 [60, 50, 52, 53]', (await page.evaluate(() => document.getElementById('catalogTotalCount').textContent)) === '4' && (await railTexts(page, 'view'))[0] === '全部模型4' && J(await domIds(page)) === J([60, 50, 52, 53]), { total: await page.evaluate(() => document.getElementById('catalogTotalCount').textContent), v: await railTexts(page, 'view'), ids: await domIds(page) });
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="unowned-back"]', '4c 返回按钮存在且可见（第 3 处点击）');
      const lp = await listParts(page);
      check('W71 返回后：列表区可见，条目 [60, 50, 52, 53]（新数据），分页信息「共 3 组（4 个模型）」，入口未按下', lp.body && lp.pager && J(await domIds(page)) === J([60, 50, 52, 53]) && (await page.$eval('#paginationInfo', (e) => e.textContent)).replace(/\s+/g, '').startsWith('共3组（4个模型）') && (await unBtn(page)).pressed === 'false', { lp, info: await page.$eval('#paginationInfo', (e) => e.textContent) });
      await page.close();
    }

    // ===== W72 viewer 也能用 =====
    // 它锁的是（补充派单 §2.6）：viewer 可见入口、可进入、可看到表格、可返回（GET 只需登录；面板里没有任何写操作控件）。
    console.log('W72 viewer 未归属对象');
    {
      const vctx = await mkCtx(USERS[1]);
      const un = { n: 0 };
      const { page } = await open(vctx, 'W72v', '', { beforeGoto: unRoute(un, async () => ({ json: UN_ROWS })) });
      check('W72 viewer：入口可见，计数「5」', (await page.locator('#catalogRailUnowned').isVisible()) && (await waitUnCount(page, '5')));
      await clickC(page, '#catalogRailUnowned');
      const p = await unPanel(page);
      check('W72 viewer 进入：面板可见、表格 5 行逐行等于手写期望（第 1 / 3 行）、入口 aria-pressed="true"；面板里恰 2 个按钮 [刷新, 返回]（4d 加刷新；都是 GET 类操作，没有写操作控件）', p.vis && p.rows.length === 5 && unRowOk(p.rows[0], UN_WANT[0]) && unRowOk(p.rows[2], UN_WANT[2]) && (await unBtn(page)).pressed === 'true' && J(await page.$$eval('#catalogUnownedPanel button', (bs) => bs.map((b) => b.getAttribute('data-catalog-act')))) === J(['refresh-unowned', 'unowned-back']), p);
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="unowned-back"]', '4c 返回按钮存在且可见（第 4 处点击）');
      const lp = await listParts(page);
      check('W72 viewer 返回：列表区恢复可见，入口未按下', lp.body && lp.toolbar && lp.pager && (await unBtn(page)).pressed === 'false' && (await unPanel(page)).vis === false, lp);
      await page.close(); await vctx.close();
    }

    // ====================================================================================================================
    // 子批 4d（C4c-4 预筛修复批）：W73 起。约定同 W36 起：期望值全部手写，等待绑在被断言对象上且有界；带 4d 新增的页内变异（CAT_MUTS）。
    // ====================================================================================================================

    // ===== W73 输入法组字标记（预筛 LOW-1）=====
    // 它锁的是：组字期间（compositionstart → compositionend）发生的列表渲染（例如重载到达）不更新「当前画面所用的词」catalogRenderedQuery（列表照常按输入框当前值渲染）——
    //   否则组字文本被记成旧词，提交同样文字时 compositionend → applyCatalogSearch 判「没改」，不回第 1 页、不收起展开。
    //   a. 搜 dim_ 展开 #50 → 组字（compositionstart）中输入框置 dim_w01 并模拟一次渲染：旧词仍是 dim_、标记为真、列表按 dim_w01 渲染 [60, 58, 62, 65] → 派发 compositionend：展开清空、回第 1 页、旧词 = dim_w01、标记清除；
    //   b. 第 2 页展开 #113 → 组字中输入框置 dwd 并渲染 → compositionend：回第 1 页、展开清空、列表 [52, 53, 59]；
    //   c. 组字取消（提交的词等于组字前的词）：#50 仍展开（面板仍在、没有重发关系请求）、列表恢复为 dim_ 的 6 个 DIM；
    //   d. 组字结束后普通输入照常记录旧词（标记已清）。
    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-expand-aria-stuck（展开按钮 aria-expanded 恒为 false）
    console.log('W73 输入法组字标记');
    {
      const { page } = await open(adminN, 'W73a');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await page.fill('#searchKeyword', 'dim_');
      await toggleOf(page, 50);
      check('W73a 前置：搜 dim_ 后展开 #50 → loaded（关系请求恰 1 次）；当前画面所用的词 = dim_，组字标记为假', (await waitPane(page, 50, 'loaded')) && J(await expandedIdsDom(page)) === J([50]) && J(relIds) === J([50]) && (await page.evaluate(() => catalogRenderedQuery)) === 'dim_' && (await page.evaluate(() => catalogComposing)) === false);
      await page.evaluate(() => { const el = document.getElementById('searchKeyword'); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.value = 'dim_w01'; renderModelsPage(); });
      const mid = await page.evaluate(() => ({ rq: catalogRenderedQuery, comp: catalogComposing, ids: Array.from(document.querySelectorAll('#modelListBody [data-id]')).map((e) => Number(e.getAttribute('data-id'))) }));
      check('W73a 组字中模拟一次渲染：组字标记为真、当前画面所用的词仍是 dim_（不是组字文本 dim_w01）；列表照常按输入框当前值渲染（dim_w01 命中 [60, 58, 62, 65]）', mid.comp === true && mid.rq === 'dim_' && J(mid.ids) === J([60, 58, 62, 65]), mid);
      await page.evaluate(() => { document.getElementById('searchKeyword').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
      const end = await page.evaluate(() => ({ rq: catalogRenderedQuery, comp: catalogComposing, page: currentPage, ex: catalogEventState.expanded.map(String) }));
      check('W73a compositionend（提交 dim_w01，≠ 组字前的词 dim_）按「改搜索」处理：展开清空（状态展开集合空、DOM 无展开按钮为真、无面板）、回第 1 页；当前画面所用的词 = dim_w01、组字标记清除', J(end.ex) === J([]) && J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && end.page === 1 && end.rq === 'dim_w01' && end.comp === false && J(await domIds(page)) === J([60, 58, 62, 65]), end);
      await page.fill('#searchKeyword', 'dim_w0');
      check('W73d 组字结束后普通输入照常记录当前画面所用的词（标记已清）：dim_w0', (await page.evaluate(() => catalogRenderedQuery)) === 'dim_w0' && (await page.evaluate(() => catalogComposing)) === false);
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W73b');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await page.evaluate(() => goToPage(2));
      await toggleOf(page, 113);
      check('W73b 前置：第 2 页、展开 #113 → loaded', (await page.evaluate(() => currentPage)) === 2 && (await waitPane(page, 113, 'loaded')) && J(relIds) === J([113]));
      await page.evaluate(() => { const el = document.getElementById('searchKeyword'); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.value = 'dwd'; renderModelsPage(); });
      check('W73b 组字中模拟渲染：当前画面所用的词仍是空串（组字前没有搜索词），页码仍是 2', (await page.evaluate(() => catalogRenderedQuery)) === '' && (await page.evaluate(() => currentPage)) === 2);
      await page.evaluate(() => { document.getElementById('searchKeyword').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
      const e2 = await page.evaluate(() => ({ page: currentPage, ex: catalogEventState.expanded.map(String), rq: catalogRenderedQuery }));
      check('W73b compositionend（提交 dwd，≠ 空串）：回第 1 页、展开清空；列表 [52, 53, 59]；当前画面所用的词 = dwd', e2.page === 1 && J(e2.ex) === J([]) && J(await domIds(page)) === J([52, 53, 59]) && e2.rq === 'dwd', e2);
      await page.close();
    }
    {
      const { page } = await open(adminN, 'W73c');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      await page.fill('#searchKeyword', 'dim_');
      await toggleOf(page, 50);
      check('W73c 前置：搜 dim_ 后展开 #50 → loaded', (await waitPane(page, 50, 'loaded')) && J(relIds) === J([50]));
      await page.evaluate(() => { const el = document.getElementById('searchKeyword'); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.value = 'dim_x'; renderModelsPage(); });
      check('W73c 组字中模拟渲染（dim_x 无命中）：列表为空、当前画面所用的词仍是 dim_', J(await domIds(page)) === J([]) && (await page.evaluate(() => catalogRenderedQuery)) === 'dim_');
      await page.evaluate(() => { const el = document.getElementById('searchKeyword'); el.value = 'dim_'; el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
      const pi = await pInfo(page, 50);
      check('W73c 组字取消（提交的词 dim_ = 组字前的词）：不算改搜索——#50 仍展开且 loaded（沿用 g50_1）、状态展开集合仍为 [50]、没有重发关系请求（共 1 次）；列表恢复为 dim_ 的 6 个 DIM', J(await expandedIdsDom(page)) === J([50]) && pi.state === 'loaded' && pi.text.includes('g50_1') && J(await stateExpanded(page)) === J(['50']) && J(relIds) === J([50]) && J(await domIds(page)) === J([60, 50, 55, 58, 62, 65]), { pi, relIds, ids: await domIds(page) });
      await page.close();
    }

    // ===== W73e 输入法组字完整事件链（codex 41Tc-M3）=====
    // 它锁的是：W73a–c 只在外部直接设输入框的值并调 renderModelsPage()，没有派发组字期间真实会出现的 input 事件——oninput 在组字中误执行搜索（提前清空展开）的实现过得去。保留那些用例，另补完整链：
    //   compositionstart → 带 isComposing: true 的 input 事件（值变成 dim_x）→ 外部渲染（取消：值改回 dim_ 后渲染；提交：值设成 dim_w01 后渲染）→ compositionend → 结束后的普通 input（isComposing 为假）。
    //   取消（提交词 = 组字前的词 dim_）：整条链之后 #58 仍展开、面板文字逐字相同、状态展开集合仍 [58]、关系请求没有重发；
    //   提交（dim_w01 ≠ dim_）：组字中的 input 事件不执行搜索（展开仍在、列表仍是 dim_ 的 6 个）；compositionend 才执行（展开清空、回第 1 页、列表 [60, 58, 62, 65]）；重新展开后结束时的普通 input（同词）什么都不改变。
    console.log('W73e 输入法组字完整事件链');
    for (const mode of ['取消', '提交']) {
      const { page } = await open(adminN, 'W73e');
      const relIds = trackRel(page);
      await routeRel(page, async (id, n) => ({ json: tagRel(id, n) }));
      const compStart = () => page.evaluate(() => { document.getElementById('searchKeyword').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
      const compInput = (v) => page.evaluate((val) => { const el = document.getElementById('searchKeyword'); el.value = val; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true })); }, v);
      const compEnd = () => page.evaluate(() => { document.getElementById('searchKeyword').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
      const plainInput = () => page.evaluate(() => { document.getElementById('searchKeyword').dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: false })); });
      await page.fill('#searchKeyword', 'dim_');
      await toggleOf(page, 58);
      check('W73e（' + mode + '）前置：搜 dim_ 后展开 #58 → loaded（关系请求恰 1 次）', (await waitPane(page, 58, 'loaded')) && J(relIds) === J([58]));
      const base58 = await pInfo(page, 58);
      await compStart();
      await compInput('dim_x');
      check('W73e（' + mode + '）组字期间的 input 事件（isComposing）不执行搜索：#58 仍展开且面板文字不变、状态展开集合仍 [58]、列表仍是 dim_ 的 6 个、关系请求没有重发', J(await expandedIdsDom(page)) === J([58]) && (await pInfo(page, 58)).text === base58.text && J(await stateExpanded(page)) === J(['58']) && J(await domIds(page)) === J([60, 50, 55, 58, 62, 65]) && J(relIds) === J([58]), { exp: await expandedIdsDom(page), ids: await domIds(page), relIds });
      await page.evaluate((val) => { document.getElementById('searchKeyword').value = val; renderModelsPage(); }, mode === '取消' ? 'dim_' : 'dim_w01');
      await compEnd();
      if (mode === '取消') {
        check('W73e（取消）compositionend（提交词 dim_ = 组字前的词）：不算改搜索——#58 仍展开且面板文字逐字相同、状态展开集合仍 [58]、关系请求没有重发（共 1 次）、列表 dim_ 的 6 个', J(await expandedIdsDom(page)) === J([58]) && (await pInfo(page, 58)).text === base58.text && J(await stateExpanded(page)) === J(['58']) && J(relIds) === J([58]) && J(await domIds(page)) === J([60, 50, 55, 58, 62, 65]), { exp: await expandedIdsDom(page), relIds });
      } else {
        check('W73e（提交）compositionend（提交 dim_w01 ≠ dim_）才执行搜索：展开清空（状态展开集合空、无展开按钮为真、无面板）、回第 1 页、列表 [60, 58, 62, 65]', J(await stateExpanded(page)) === J([]) && J(await expandedIdsDom(page)) === J([]) && (await paneCount(page)) === 0 && (await page.evaluate(() => currentPage)) === 1 && J(await domIds(page)) === J([60, 58, 62, 65]), { st: await stateExpanded(page), ids: await domIds(page) });
        await toggleOf(page, 58);
        check('W73e（提交）前置：重新展开 #58 → loaded（第 2 次请求）', (await waitPane(page, 58, 'loaded')) && J(relIds) === J([58, 58]));
      }
      const baseAfter = await pInfo(page, 58);
      await plainInput();
      check('W73e（' + mode + '）结束后的普通 input（isComposing 为假、词不变）什么都不改变：#58 仍展开且面板文字逐字相同、状态展开集合仍 [58]、关系请求数不变', J(await expandedIdsDom(page)) === J([58]) && (await pInfo(page, 58)).text === baseAfter.text && J(await stateExpanded(page)) === J(['58']) && J(relIds) === J(mode === '取消' ? [58] : [58, 58]), { relIds });
      await page.close();
    }

    // ===== W74 ?focus= 先退出未归属模式（预筛 LOW-2）=====
    // 它锁的是：带 ?focus=65 打开、首次列表请求被扣住，此时用户先点未归属入口进入未归属模式；放行列表后 focusCatalogModel 先退出该模式——
    //   面板隐藏、入口 aria-pressed=false、列表区可见、目标 #65 可见且带 data-focus-highlight（高亮落在看得见的列表上，而不是被隐藏的列表）。
    console.log('W74 ?focus= 与未归属模式');
    {
      const un = { n: 0 }; const g = gate(); let hit = 0;
      const { page } = await open(adminN, 'W74', '?focus=65', { noRows: true, noIdle: true, beforeGoto: both(unRoute(un, async () => ({ json: UN_ROWS })), async (pg) => { await pg.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); hit++; await g.p; return route.continue(); }); }) });
      check('W74 前置：首次列表请求已到达路由（被扣住），未归属计数「5」', (await untilTrue(() => hit >= 1)) && (await waitUnCount(page, '5')));
      await clickC(page, '#catalogRailUnowned');
      check('W74 前置：进入未归属模式（入口 aria-pressed="true"、面板可见、表格 5 行）；列表数据还没到，列表体里没有条目', (await unBtn(page)).pressed === 'true' && (await unPanel(page)).vis === true && (await waitUnRows(page, 5)) && (await domIds(page)).length === 0);
      g.release();
      const hl = await page.waitForSelector('#modelListBody [data-id="65"][data-focus-highlight]', { state: 'attached', timeout: WAIT }).then(() => true, () => false);
      const lp = await listParts(page); const p = await unPanel(page); const b = await unBtn(page);
      check('W74 放行列表后 focusCatalogModel 先退出未归属模式：面板隐藏、入口 aria-pressed="false"、列表体 / 工具条 / 分页可见；目标 #65 在列表里可见且带高亮属性', hl && p.vis === false && b.pressed === 'false' && lp.body && lp.toolbar && lp.pager && (await page.locator('#modelListBody [data-id="65"]').first().isVisible()), { hl, p: p.vis, b, lp });
      check('W74 focus 的其余效果照旧：搜索框为空、第 1 页、筛选为空', (await page.inputValue('#searchKeyword')) === '' && (await page.evaluate(() => currentPage)) === 1 && J(await page.evaluate(() => catalogFilters)) === J({}));
      await page.close();
    }

    // ===== W75 未归属「刷新」（待裁 1）=====
    // 它锁的是：①ok 态（有表格 / 「没有未归属对象」）面板右上有「刷新」button[data-catalog-act="refresh-unowned"]（type=button，不带 data-act），顺序在「返回模型列表」之前；加载中 / 加载失败态没有刷新按钮；
    //   ②点刷新发一次请求（共 2 次），在途期间按钮置灰、表格仍是旧数据；在途时再点（DOM click + 直接调 catalogRetryUnowned()）都不发请求；③响应到达（UN_B）：表格与计数更新为 2 行 / 「2」，按钮恢复可点；
    //   ④刷新失败（500）：面板转「加载失败」+ 重试、没有刷新按钮、计数「—」，不弹 toast；⑤再点重试成功 → 表格 5 行、计数「5」、刷新按钮回来；⑥空数组时也有刷新按钮，刷新得到数据后换成表格。
    console.log('W75 未归属刷新');
    {
      expectErr('W75a', U_UNOWNED);
      const un = { n: 0 }; const g2 = gate(); const gL = gate();
      const { page } = await open(adminN, 'W75a', '', { noIdle: true, beforeGoto: both(initSpies([]), unRoute(un, async (n) => { if (n === 1) { await gL.p; return { json: UN_ROWS }; } if (n === 2) { await g2.p; return { json: UN_B }; } if (n === 3) return { status: 500, body: '{"error":"桩"}' }; return { json: UN_ROWS }; })) });
      check('W75 前置：初始化请求已到达路由（被扣住）', await untilTrue(() => un.n >= 1));
      await clickC(page, '#catalogRailUnowned');
      const ld = await unPanel(page);
      check('W75 加载中态：状态块「加载中…」，没有刷新按钮', ld.state === '加载中…' && (await page.locator('#catalogUnownedPanel [data-catalog-act="refresh-unowned"]').count()) === 0, ld);
      gL.release();
      check('W75 前置：初始响应到达 → 表格 5 行', await waitUnRows(page, 5));
      const acts0 = await page.evaluate(() => Array.from(document.querySelectorAll('#catalogUnownedPanel .catalog-unowned-actions > *')).map((b) => ({ tag: b.tagName, type: b.getAttribute('type'), act: b.getAttribute('data-catalog-act'), text: b.textContent, disabled: b.disabled, hasDataAct: b.hasAttribute('data-act') })));
      check('W75 ok 态面板右上的操作区依次为 [刷新, 返回模型列表]：都是 button（type=button）、刷新带 data-catalog-act="refresh-unowned" 且未置灰、都不带 data-act', J(acts0.map((a) => a.act)) === J(['refresh-unowned', 'unowned-back']) && J(acts0.map((a) => a.text)) === J(['刷新', '返回模型列表']) && acts0.every((a) => a.tag === 'BUTTON' && a.type === 'button' && a.hasDataAct === false) && !!acts0[0] && acts0[0].disabled === false, acts0);
      const snap0 = await unPanel(page);   // 刷新前的表头与全部行内容（codex 41Tc-M2：在途断言逐格比较，不只数行）
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="refresh-unowned"]', 'W75 刷新按钮存在且可见（第 1 处点击）');
      check('W75 点刷新：第 2 次请求已到达路由（被扣住）', await untilTrue(() => un.n === 2));
      const mid = await unPanel(page);
      const midBtn = await page.evaluate(() => { const r = document.querySelector('#catalogUnownedPanel [data-catalog-act="refresh-unowned"]'); return r ? { disabled: r.disabled } : null; });
      const midUn = await unBtn(page);
      check('W75 在途期间：刷新按钮置灰；面板可见、入口仍 aria-pressed="true"、入口计数仍「5」；表头与全部 5 行逐格等于刷新前（类型 / 名称 / 摘要 / 徽章文案·色调·悬停 / 核验时间）；没有「加载中…」或「加载失败」', !!midBtn && midBtn.disabled === true && mid.vis === true && midUn.pressed === 'true' && midUn.count === '5' && mid.state === null && snap0.rows.length === 5 && J(mid.heads) === J(snap0.heads) && J(mid.rows) === J(snap0.rows), { midBtn, midUn, mid, snap0 });
      await page.evaluate(() => { const rb = document.querySelector('#catalogUnownedPanel [data-catalog-act="refresh-unowned"]'); if (rb) rb.click(); catalogRetryUnowned(); });
      await stableCount(page, 400);
      check('W75 在途时再点（DOM click 一次 + 直接调 catalogRetryUnowned() 一次）都不发请求：路由收到的请求仍恰 2 次', un.n === 2 && un.reqs.length === 2, un);
      g2.release();
      check('W75 响应到达（UN_B）：表格 2 行（usp_new / v_new）、入口计数「2」、刷新按钮恢复可点、仍在未归属模式', (await waitUnRows(page, 2)) && (await waitUnCount(page, '2')) && J((await unPanel(page)).rows.map((r) => r.name)) === J(['dbo.usp_new', 'dbo.v_new']) && (await page.waitForFunction(() => { const r = document.querySelector('#catalogUnownedPanel [data-catalog-act="refresh-unowned"]'); return !!r && !r.disabled; }, null, { timeout: WAIT }).then(() => true, () => false)) && (await unBtn(page)).pressed === 'true');
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="refresh-unowned"]', 'W75 刷新按钮存在且可见（第 2 处点击）');
      check('W75 刷新失败（第 3 次请求 500）：面板转「加载失败」+ 重试按钮（未置灰）、没有刷新按钮、没有表格；入口计数「—」；不弹 toast', (await waitUnState(page, '加载失败')) && un.n === 3 && (await unBtn(page)).count === '—' && (await page.locator('#catalogUnownedPanel [data-catalog-act="refresh-unowned"]').count()) === 0 && (await unPanel(page)).retry !== null && (await unPanel(page)).retry.disabled === false && (await unPanel(page)).tables === 0 && (await page.evaluate(() => window.__toasts.length)) === 0, { n: un.n, p: await unPanel(page) });
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="retry-unowned"]', 'W75 重试按钮存在且可见');
      check('W75 点重试（第 4 次请求）成功：表格 5 行、计数「5」、刷新按钮回来；全程 showToast 0 次', (await waitUnRows(page, 5)) && (await waitUnCount(page, '5')) && (await page.locator('#catalogUnownedPanel [data-catalog-act="refresh-unowned"]').count()) === 1 && un.n === 4 && (await page.evaluate(() => window.__toasts.length)) === 0, { n: un.n });
      await page.close();
    }
    {
      const un = { n: 0 };
      const { page } = await open(adminN, 'W75b', '', { beforeGoto: unRoute(un, async (n) => (n === 1 ? { json: [] } : { json: UN_B })) });
      check('W75 前置（空数组）：计数「0」', await waitUnCount(page, '0'));
      await clickC(page, '#catalogRailUnowned');
      const p0 = await unPanel(page);
      check('W75 空数组（「没有未归属对象」）也有刷新按钮', p0.state === '没有未归属对象' && (await page.locator('#catalogUnownedPanel [data-catalog-act="refresh-unowned"]').count()) === 1, p0);
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="refresh-unowned"]', 'W75 空态刷新按钮存在且可见');
      check('W75 空态刷新得到 2 行：换成表格、计数「2」、不再有「没有未归属对象」', (await waitUnRows(page, 2)) && (await waitUnCount(page, '2')) && (await unPanel(page)).state === null && un.n === 2, { n: un.n });
      await page.close();
    }

    // ===== W76 左栏按键就地更新（待裁 2）=====
    // 它锁的是：mousedown 与 mouseup 之间左栏被重画（手动重画 / 列表数据到达 / 未归属请求完成）时，点击不丢——旧写法整栏 replaceChildren，原按钮脱离文档，浏览器不再派发 click；
    //   a. 左栏项（layer:DWD）、入口按钮（#catalogRailUnowned）、「清除 N 项」按钮三种目标 × 三种重画来源（catalogRenderRail() / loadModels 到达 / catalogLoadUnowned 完成），按下后重画、再抬起，点击效果都生效，且按钮节点还是原来那个；
    //   b. 数据不变时重画：每个 [data-rail] 节点、入口按钮节点逐个与重画前是同一个节点；数据变化（路由去掉全部 DIM 行）后：DIM 项被删除、其余节点（ODS / DWD / 「全部模型」）仍是同一个节点且计数就地更新，数据还原后 DIM 项插回原位置（data-rail 序列等于变化前）；
    //   c. 焦点在左栏项上时重画，焦点仍在同一个节点上。
    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-rail-pressed-false（左栏 aria-pressed 恒为 false）
    console.log('W76 左栏就地更新');
    {
      let dropDim = false;
      const un = { n: 0 };
      const { page } = await open(adminN, 'W76', '', { beforeGoto: both(unRoute(un, async () => ({ json: UN_ROWS })), rewriteList((rows) => (dropDim ? rows.filter((r) => String(r.layer).toLowerCase() !== 'dim') : rows))) });
      check('W76 前置：未归属计数「5」', await waitUnCount(page, '5'));
      await page.evaluate(() => { window.__pick = []; const o = catalogRailPick; window.catalogRailPick = function (s) { window.__pick.push(s); return o.apply(this, arguments); }; });
      const mark = (sel) => page.evaluate((s) => { window.__before = document.querySelector(s); return !!window.__before; }, sel);
      /** 悬停 → 按下 → 重画（fn）→ 抬起；目标不存在 = 判红并跳过（返回 false） */
      const pressAcross = async (sel, label, fn, opts) => {
        if ((await page.locator(sel).count()) < 1 || !(await page.locator(sel).first().isVisible())) { check(label + ' 前提：目标按钮存在且可见', false, sel); return false; }
        await mark(sel);
        await page.hover(sel);
        await page.mouse.down();
        let got;
        try { got = await fn(page); if (opts && opts.beforeUp) await opts.beforeUp(); } finally { await page.mouse.up(); }
        if (opts && opts.want !== undefined) check(label + '：重画来源完成且前提成立（期望返回 ' + J(opts.want) + '，实得 ' + J(got) + '）——来源失败 / 超时则「重画后点击仍生效」没有覆盖到目标重画（codex 41Tc-L2）', got === opts.want, got);
        return true;
      };
      const same = (sel) => page.evaluate((s) => window.__before === document.querySelector(s), sel);
      const failRoute = (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' });
      const rerender = {
        '手动 catalogRenderRail()': { fn: (pg) => pg.evaluate(() => catalogRenderRail()), want: undefined },
        'loadModels 到达（真实列表重载）': { fn: async (pg) => { if (MUT === 'w76-source-fails') await pg.route(isList, (route) => (route.request().method() !== 'GET' ? route.continue() : failRoute(route))); return loadBounded(pg); }, want: 'arrived' },
        'catalogLoadUnowned 完成（未归属请求结束）': { fn: async (pg) => { if (MUT === 'w76-source-fails') await pg.route(isUnowned, failRoute); return pageCallBounded(pg, 'catalogLoadUnowned()', 'W76 未归属请求'); }, want: 'ok' },
      };
      for (const [how, src] of Object.entries(rerender)) {
        const fn = src.fn; const want = src.want;
        // 左栏项：按下 layer:DWD → 重画 → 抬起
        await pressAcross('#catalogRail [data-rail="layer:DWD"]', 'W76 左栏项（' + how + '）', fn, { want });
        const a = await page.evaluate(() => ({ layer: catalogFilters.layer, pick: window.__pick.slice() }));
        check('W76 左栏项（' + how + '）：按下 → 重画 → 抬起，点击仍生效——catalogRailPick("layer:DWD") 被调用、筛选 layer=DWD、DWD 按下；按钮节点还是原来那个', a.layer === 'DWD' && a.pick[a.pick.length - 1] === 'layer:DWD' && (await same('#catalogRail [data-rail="layer:DWD"]')) && J(await railPressed(page)) === J(['view:', 'layer:DWD', 'status:', 'domain:']), a);
        // 「清除 1 项」
        await pressAcross('#catalogRail [data-catalog-act="rail-clear"]', 'W76 「清除 1 项」（' + how + '）', fn, { want, beforeUp: async () => { check('W76 「清除 1 项」（' + how + '）：重画完成、抬起之前按钮仍是原来的节点（codex 41Tc-L1）', await same('#catalogRail [data-catalog-act="rail-clear"]')); } });
        check('W76 「清除 1 项」（' + how + '）：按下 → 重画 → 抬起，点击仍生效——筛选清空、头部「筛选全部」、四组「全部」按下', (await page.evaluate(() => Object.keys(catalogFilters).filter((k) => catalogFilters[k] !== '' && catalogFilters[k] != null).length)) === 0 && (await railHead(page)) === '筛选全部' && J(await railPressed(page)) === J(D0));
        // 入口按钮：按下 → 重画 → 抬起 → 进入未归属模式
        await pressAcross('#catalogRailUnowned', 'W76 未归属入口（' + how + '）', fn, { want });
        check('W76 未归属入口（' + how + '）：按下 → 重画 → 抬起，点击仍生效——进入未归属模式（入口 aria-pressed="true"、面板可见）；按钮节点还是原来那个', (await unBtn(page)).pressed === 'true' && (await unPanel(page)).vis === true && (await same('#catalogRailUnowned')), await unBtn(page));
        await clickIf(page, '#catalogUnownedPanel [data-catalog-act="unowned-back"]', 'W76 返回按钮存在且可见（' + how + '）');
      }
      // b. 数据不变：节点逐个相同
      await page.evaluate(() => { window.__nodes = new Map(Array.from(document.querySelectorAll('#catalogRail [data-rail], #catalogRail #catalogRailUnowned')).map((e) => [e.getAttribute('data-rail') || e.id, e])); window.__specs0 = Array.from(document.querySelectorAll('#catalogRail [data-rail]')).map((e) => e.getAttribute('data-rail')); });
      await page.evaluate(() => catalogRefreshRail());
      const nodesSame = await page.evaluate(() => { const bad = []; document.querySelectorAll('#catalogRail [data-rail], #catalogRail #catalogRailUnowned').forEach((e) => { if (window.__nodes.get(e.getAttribute('data-rail') || e.id) !== e) bad.push(e.getAttribute('data-rail') || e.id); }); return { bad, n: window.__nodes.size, now: document.querySelectorAll('#catalogRail [data-rail], #catalogRail #catalogRailUnowned').length }; });
      check('W76 数据不变时重画（catalogRefreshRail）：每个 [data-rail] 项与入口按钮都还是重画前的同一个节点（共 ' + nodesSame.n + ' 个，节点数不变）', nodesSame.bad.length === 0 && nodesSame.n === nodesSame.now && nodesSame.n >= 10, nodesSame);
      // b. 数据变化：去掉全部 DIM 行
      const before = await railTexts(page, 'layer');
      dropDim = true;
      const r1 = await loadBounded(page);
      const after = await page.evaluate(() => ({ specs: Array.from(document.querySelectorAll('#catalogRail [data-rail]')).map((e) => e.getAttribute('data-rail')), keep: ['view:', 'layer:ODS', 'layer:DWD'].map((k) => window.__nodes.get(k) === document.querySelector('#catalogRail [data-rail="' + k + '"]')), txt: ['view:', 'layer:ODS', 'layer:DWD'].map((k) => document.querySelector('#catalogRail [data-rail="' + k + '"]').textContent) }));
      check("W76 数据变化（路由去掉 6 个 DIM 行，loadModels 返回 'arrived'）：DIM 项被删除；「全部模型」/ ODS / DWD 仍是同一个节点，计数就地更新（全部模型 30、ODS 27、DWD 3）", r1 === 'arrived' && !after.specs.includes('layer:DIM') && J(after.keep) === J([true, true, true]) && J(after.txt) === J(['全部模型30', 'ODS27', 'DWD3']), { r1, after, before });
      dropDim = false;
      const r2 = await loadBounded(page);
      const back = await page.evaluate(() => ({ specs: Array.from(document.querySelectorAll('#catalogRail [data-rail]')).map((e) => e.getAttribute('data-rail')), keep: window.__nodes.get('layer:ODS') === document.querySelector('#catalogRail [data-rail="layer:ODS"]') }));
      check("W76 数据还原（loadModels 返回 'arrived'）：DIM 项插回原位置——data-rail 序列等于变化前；ODS 仍是同一个节点", r2 === 'arrived' && J(back.specs) === J(await page.evaluate(() => window.__specs0)) && back.keep === true, back);
      // c. 焦点
      await page.locator('#catalogRail [data-rail="layer:DWD"]').first().focus({ timeout: WAIT });
      await page.evaluate(() => catalogRenderRail());
      check('W76 焦点在左栏项（layer:DWD）上时重画：焦点仍在该节点上', await page.evaluate(() => !!document.activeElement && document.activeElement.getAttribute('data-rail') === 'layer:DWD'));
      await page.close();
    }

    // ====================================================================================================================
    // C4c-4 codex 41 收口：W77 起（产品修复的行为用例）。约定同 W36 起：期望值全部手写，等待绑在被断言对象上且有界。
    // ====================================================================================================================

    // ===== W77 未归属面板就地更新（codex 41-M1）=====
    // 它锁的是：catalogRenderUnowned 在请求开始 / 完成时都会被调用。旧写法每次 panel.replaceChildren，连「返回模型列表」按钮也重建——在返回按钮上 mousedown →（刷新）响应到达、面板重画 → mouseup 时原按钮已脱离文档，
    //   浏览器不派发 click，点击丢失；键盘焦点也随按钮替换而丢。就地更新后：
    //   a. 刷新在途时在返回按钮上按下鼠标（焦点落在返回按钮）、放行响应并等面板更新（表格 5 行 → UN_B 的 2 行、刷新按钮恢复可用）、再抬起：点击生效（退出未归属模式）；
    //      返回按钮、刷新按钮（ok → ok）、标题区、操作区在请求开始与完成两次重画前后都是同一批节点，焦点始终在返回按钮上；
    //   b. 失败态：焦点在返回按钮上点重试（DOM click）→ 在途重试按钮置灰且是同一个节点；第 2 次失败后恢复可点，仍是同一个节点（error → error）；第 3 次成功换成表格，返回按钮仍是同一个节点、焦点未变。
    console.log('W77 未归属面板就地更新');
    {
      const un = { n: 0 }; const g2 = gate();
      const { page } = await open(adminN, 'W77a', '', { beforeGoto: unRoute(un, async (n) => { if (n === 2) { await g2.p; return { json: UN_B }; } return { json: UN_ROWS }; }) });
      check('W77a 前置：未归属计数「5」', await waitUnCount(page, '5'));
      await clickC(page, '#catalogRailUnowned');
      check('W77a 前置：进入后表格 5 行', await waitUnRows(page, 5));
      await page.evaluate(() => {
        const q = (a) => document.querySelector('#catalogUnownedPanel [data-catalog-act="' + a + '"]');
        const p = document.getElementById('catalogUnownedPanel');
        window.__un0 = { back: q('unowned-back'), refresh: q('refresh-unowned'), head: p.querySelector('.catalog-unowned-head'), actions: p.querySelector('.catalog-unowned-actions'), title: p.querySelector('.catalog-unowned-title') };
      });
      const sameNodes = () => page.evaluate(() => {
        const q = (a) => document.querySelector('#catalogUnownedPanel [data-catalog-act="' + a + '"]');
        const p = document.getElementById('catalogUnownedPanel'); const o = window.__un0;
        return { back: q('unowned-back') === o.back, refresh: q('refresh-unowned') === o.refresh, head: p.querySelector('.catalog-unowned-head') === o.head, actions: p.querySelector('.catalog-unowned-actions') === o.actions, title: p.querySelector('.catalog-unowned-title') === o.title, activeIsBack: document.activeElement === o.back };
      });
      await clickIf(page, '#catalogUnownedPanel [data-catalog-act="refresh-unowned"]', 'W77a 刷新按钮存在且可见');
      check('W77a 点刷新：第 2 次请求已到达路由（被扣住）', await untilTrue(() => un.n === 2));
      const mid = await sameNodes();
      check('W77a 刷新在途（请求开始时面板已重画过一次）：返回按钮、刷新按钮、标题区、操作区、标题都还是原来的节点；刷新按钮置灰', mid.back && mid.refresh && mid.head && mid.actions && mid.title && (await page.$eval('#catalogUnownedPanel [data-catalog-act="refresh-unowned"]', (b) => b.disabled)) === true, mid);
      let pressed = false;
      try {
        await page.hover('#catalogUnownedPanel [data-catalog-act="unowned-back"]');
        await page.mouse.down(); pressed = true;
        const act0 = await sameNodes();
        check('W77a 前置：在返回按钮上按下鼠标后，焦点在返回按钮上', act0.activeIsBack === true, act0);
        g2.release();
        const upd = (await waitUnRows(page, 2)) && (await page.waitForFunction(() => { const r = document.querySelector('#catalogUnownedPanel [data-catalog-act="refresh-unowned"]'); return !!r && !r.disabled; }, null, { timeout: WAIT }).then(() => true, () => false));
        const post = await sameNodes();
        check('W77a 响应到达、面板更新（表格 2 行、刷新按钮恢复可用）而鼠标仍按着：返回按钮仍是原来的节点、焦点仍在它上面；刷新按钮是同一个节点（ok → ok 就地更新，disabled 恢复）；标题区 / 操作区 / 标题仍是原节点', upd && post.back && post.refresh && post.head && post.actions && post.title && post.activeIsBack === true, post);
      } finally { if (pressed) await page.mouse.up(); }
      const after = await unBtn(page); const lp = await listParts(page); const pl = await unPanel(page);
      check('W77a 抬起鼠标：点击生效——退出未归属模式（入口 aria-pressed="false"、面板隐藏、工具条 / 列表体 / 分页恢复可见）', !!after && after.pressed === 'false' && !!pl && pl.vis === false && lp.body && lp.toolbar && lp.pager, { after, pl, lp });
      await page.close();
    }
    {
      expectErr('W77b', U_UNOWNED);
      const un = { n: 0 }; const g2 = gate();
      const { page } = await open(adminN, 'W77b', '', { beforeGoto: unRoute(un, async (n) => { if (n === 1) return { status: 500, body: '{"error":"桩"}' }; if (n === 2) { await g2.p; return { status: 500, body: '{"error":"桩"}' }; } return { json: UN_ROWS }; }) });
      await clickC(page, '#catalogRailUnowned');
      check('W77b 前置：初始化请求失败后进入 → 「加载失败」+ 重试（可点）', (await waitUnState(page, '加载失败')) && (await unPanel(page)).retry.disabled === false);
      await page.evaluate(() => {
        const q = (a) => document.querySelector('#catalogUnownedPanel [data-catalog-act="' + a + '"]');
        window.__un1 = { back: q('unowned-back'), retry: q('retry-unowned'), state: document.querySelector('#catalogUnownedPanel .catalog-unowned-state') };
        q('unowned-back').focus();
      });
      const same2 = () => page.evaluate(() => {
        const q = (a) => document.querySelector('#catalogUnownedPanel [data-catalog-act="' + a + '"]'); const o = window.__un1;
        return { back: q('unowned-back') === o.back, retry: q('retry-unowned') === o.retry, state: document.querySelector('#catalogUnownedPanel .catalog-unowned-state') === o.state, activeIsBack: document.activeElement === o.back, retryDisabled: q('retry-unowned') ? q('retry-unowned').disabled : null };
      });
      check('W77b 前置：焦点已放在返回按钮上', (await same2()).activeIsBack === true);
      await page.evaluate(() => document.querySelector('#catalogUnownedPanel [data-catalog-act="retry-unowned"]').click());
      check('W77b 点重试（DOM click，焦点留在返回按钮）：第 2 次请求已到达路由（被扣住）', await untilTrue(() => un.n === 2));
      const m1 = await same2();
      check('W77b 重试在途：重试按钮置灰且是同一个节点、返回按钮同一节点且焦点仍在它上面、状态块同一节点', m1.back && m1.retry && m1.state && m1.retryDisabled === true && m1.activeIsBack === true, m1);
      g2.release();
      const ok2 = await page.waitForFunction(() => { const r = document.querySelector('#catalogUnownedPanel [data-catalog-act="retry-unowned"]'); return !!r && !r.disabled; }, null, { timeout: WAIT }).then(() => true, () => false);
      const m2 = await same2();
      check('W77b 第 2 次也失败：重试按钮恢复可点且仍是同一个节点（error → error 就地更新）；返回按钮与焦点未变', ok2 && m2.back && m2.retry && m2.state && m2.retryDisabled === false && m2.activeIsBack === true, m2);
      await page.evaluate(() => document.querySelector('#catalogUnownedPanel [data-catalog-act="retry-unowned"]').click());
      check('W77b 第 3 次成功：就地换成表格（5 行）、计数「5」、请求恰 3 次', (await waitUnRows(page, 5)) && (await waitUnCount(page, '5')) && un.n === 3, { n: un.n });
      const m3 = await same2();
      check('W77b 成功后：返回按钮仍是同一个节点、焦点仍在它上面（失败 → 成功的跨状态重画也没把它换掉）', m3.back && m3.activeIsBack === true, m3);
      await page.close();
    }

    // ===== W78 左栏焦点（codex 41-L1）=====
    // 它锁的是：选中的业务域消失后补在末尾（计数 0），用户聚焦它；数据恢复使它回到排序位置时，reconcile 用 insertBefore 搬动这个按钮——节点身份保留了，但搬动即失焦。catalogRenderRail 对齐前记下焦点元素、
    //   对齐后归还。夹具 RAIL11（dom_b 的两行 #203 #204）：选中「域乙」→ 重载去掉这两行 → 业务域列表 = 全部 9 / 域甲 3 / 域丙 2 / dom_zzz 1 / 未设置 3 / 域乙 0（手写：总数 11-2=9；dom_a 201,202,209；dom_c 210,211；dom_zzz 205；空值 206,207,208）→
    //   聚焦末尾的「域乙 0」→ 数据恢复 → 业务域列表回到 RD（域乙回到第二位）；document.activeElement 仍是那个节点。
    console.log('W78 左栏：选中值消失又恢复后焦点仍在按钮上');
    {
      let dropB = false;
      const { page } = await open(adminN, 'W78', '', { beforeGoto: rewriteList((rows) => RAIL11(rows).filter((r) => !(dropB && r.domain === 'dom_b'))) });
      check('W78 前置：业务域映射到达', await waitRailDomains(page, RD));
      await railClick(page, 'domain:dom_b');
      check('W78 前置：选中「域乙」→ 列表 [203, 204]，域乙按下', J(await domIds(page)) === J([203, 204]) && J(await railPressed(page)) === J(['view:', 'layer:', 'status:', 'domain:dom_b']), { ids: await domIds(page), pressed: await railPressed(page) });
      dropB = true;
      const r1 = await loadBounded(page);
      check("W78 重载去掉 #203 #204（'arrived'）：业务域列表 = [全部 9, 域甲 3, 域丙 2, dom_zzz 1, 未设置 3, 域乙 0]（选中值消失，补在末尾、计数 0）", r1 === 'arrived' && J(await railTexts(page, 'domain')) === J(['全部9', '域甲3', '域丙2', 'dom_zzz1', '未设置3', '域乙0']), { r1, d: await railTexts(page, 'domain') });
      await page.locator('#catalogRail [data-rail="domain:dom_b"]').focus();
      await page.evaluate(() => { window.__b0 = document.querySelector('#catalogRail [data-rail="domain:dom_b"]'); });
      check('W78 前置：焦点在末尾的「域乙 0」按钮上', await page.evaluate(() => document.activeElement === window.__b0));
      dropB = false;
      const r2 = await loadBounded(page);
      const st = await page.evaluate(() => ({ active: document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-rail') : null, same: window.__b0 === document.querySelector('#catalogRail [data-rail="domain:dom_b"]'), isActive: document.activeElement === window.__b0 }));
      check("W78 数据恢复（'arrived'）：域乙回到排序位置 [全部 11, 域甲 3, 域乙 2, 域丙 2, dom_zzz 1, 未设置 3]（节点被 reconcile 搬动）；焦点仍在「域乙」按钮上（document.activeElement 就是那个节点——不是 body）", r2 === 'arrived' && J(await railTexts(page, 'domain')) === J(RD) && st.same && st.isActive && st.active === 'domain:dom_b', { r2, st, d: await railTexts(page, 'domain') });
      await page.close();
    }

    // ===== W79 未归属表类型列空值（codex 41-L2）=====
    // 它锁的是：形状校验允许 obj_type 缺失 / null / 空串（服务端恒非空，但前端校验放行），类型列与摘要、核验时间一样走「—」占位：空串、纯空白、null、缺失一律显示「—」；有值的原样。
    console.log('W79 未归属表类型列空值');
    {
      const noBadge = { doc: null, reg: null };
      const ROWS79 = [
        { id: 931, obj_type: '', schema_name: 'dbo', obj_name: 'o_empty', summary: 's', verified_at: null, badges: noBadge },
        { id: 932, obj_type: '   ', schema_name: null, obj_name: 'o_blank', summary: 's', verified_at: null, badges: noBadge },
        { id: 933, obj_type: null, schema_name: null, obj_name: 'o_null', summary: 's', verified_at: null, badges: noBadge },
        { id: 934, schema_name: null, obj_name: 'o_missing', summary: 's', verified_at: null, badges: noBadge },
        { id: 935, obj_type: 'VIEW', schema_name: null, obj_name: 'o_view', summary: 's', verified_at: null, badges: noBadge },
      ];
      const un = { n: 0 };
      const { page } = await open(adminN, 'W79', '', { beforeGoto: unRoute(un, async () => ({ json: ROWS79 })) });
      check('W79 前置：5 行合法响应（obj_type 为空串 / 纯空白 / null / 缺失 / 有值）通过形状校验：计数「5」', await waitUnCount(page, '5'));
      await clickC(page, '#catalogRailUnowned');
      check('W79 前置：表格 5 行', await waitUnRows(page, 5));
      const p79 = await unPanel(page);
      check('W79 类型列：空串 / 纯空白 / null / 缺失都显示「—」，有值的原样（VIEW）；名称列不受影响（dbo.o_empty / o_blank / o_null / o_missing / o_view）', J(p79.rows.map((r) => r.type)) === J(['—', '—', '—', '—', 'VIEW']) && J(p79.rows.map((r) => r.name)) === J(['dbo.o_empty', 'o_blank', 'o_null', 'o_missing', 'o_view']), p79.rows.map((r) => [r.type, r.name]));
      await page.close();
    }

    // ===== W81 未归属状态块转移后无残留文字节点（fix41b，预筛 LOW-2）=====
    // 它锁的是：catalogRailPatch 的「旧节点是纯文字叶子、新节点有子元素时先清旧文字」。状态块三态同键（t:DIV.catalog-unowned-state）就地对齐：
    //   a. 初始化请求在途时进入未归属模式（「加载中…」纯文字）→ 请求失败 → 「加载失败」+ 重试按钮；
    //   b. 空态「没有未归属对象」（纯文字）点刷新 → 刷新失败 → 同样。
    //   两例都断言状态块 childNodes 恰为 [SPAN, BUTTON]、没有残留文字节点，textContent 恰为「加载失败重试」（删掉清旧文字那一行会变成 #text + SPAN + BUTTON）。
    console.log('W81 未归属状态块转移后无残留文字节点');
    {
      const stateNodes = (page) => page.evaluate(() => { const s = document.querySelector('#catalogUnownedPanel .catalog-unowned-state'); return s ? { kids: Array.from(s.childNodes).map((n) => n.nodeType + ':' + (n.tagName || '')), text: s.textContent, err: s.classList.contains('is-error') } : null; });
      const WANT_NODES = { kids: ['1:SPAN', '1:BUTTON'], text: '加载失败重试', err: true };
      {
        expectErr('W81a', U_UNOWNED);
        const un = { n: 0 }; const g = gate();
        const { page } = await open(adminN, 'W81a', '', { noIdle: true, beforeGoto: unRoute(un, async () => { await g.p; return { status: 500, body: '{"error":"桩"}' }; }) });
        check('W81a 前置：初始化请求已到达路由（被扣住）', await untilTrue(() => un.n >= 1));
        await clickC(page, '#catalogRailUnowned');
        check('W81a 前置：进入未归属模式，状态块是纯文字「加载中…」（一个文字节点）', (await waitUnState(page, '加载中…')) && J((await stateNodes(page)).kids) === J(['3:']), await stateNodes(page));
        g.release();
        check('W81a 请求失败 → 状态块转「加载失败」+ 重试', await waitUnState(page, '加载失败'));
        const s1 = await stateNodes(page);
        check('W81a 状态块 childNodes 恰为 [SPAN, BUTTON]、textContent 恰为「加载失败重试」、带 is-error——旧的纯文字「加载中…」没有残留', J(s1) === J(WANT_NODES), s1);
        await page.close();
      }
      {
        expectErr('W81b', U_UNOWNED);
        const un = { n: 0 };
        const { page } = await open(adminN, 'W81b', '', { beforeGoto: unRoute(un, async (n) => (n === 1 ? { json: [] } : { status: 500, body: '{"error":"桩"}' })) });
        check('W81b 前置：空数组，计数「0」', await waitUnCount(page, '0'));
        await clickC(page, '#catalogRailUnowned');
        check('W81b 前置：空态「没有未归属对象」是纯文字（一个文字节点）', (await waitUnState(page, '没有未归属对象')) && J((await stateNodes(page)).kids) === J(['3:']), await stateNodes(page));
        await clickIf(page, '#catalogUnownedPanel [data-catalog-act="refresh-unowned"]', 'W81b 空态刷新按钮存在且可见');
        check('W81b 刷新失败（第 2 次请求 500）→ 状态块转「加载失败」+ 重试', (await waitUnState(page, '加载失败')) && un.n === 2, { n: un.n });
        const s2 = await stateNodes(page);
        check('W81b 状态块 childNodes 恰为 [SPAN, BUTTON]、textContent 恰为「加载失败重试」、带 is-error——旧的纯文字「没有未归属对象」没有残留', J(s2) === J(WANT_NODES), s2);
        await page.close();
      }
    }

    // ===== fix42b LOW-3：W82–W98 的用例段护栏与有界点击 / 聚焦助手 =====
    // segGuard：段内任何未捕获异常（点不到 / 读不到节点 / 页内调用超时）记一条 FAIL 并继续下一段，不让整个套件无结果行（改前 w84-no-toggle 在全量 W 里于 W84 段抛出、W89–W98 的结果全丢）。
    // clickB：点击一律有界——元素 3 秒内不可见 / 点不到 = 记一条 FAIL 并返回 false（不等默认 30 秒、不抛异常）；focusB 同。段内页内读取助手另按「缺节点返回可判定的缺失信息」判空加固。
    const segGuard = async (label, fn) => { try { await fn(); } catch (e) { check(label + '：用例段整段跑完、没有抛出未捕获异常（抛出 = 判红，不让整个套件无结果行）', false, String((e && e.stack) || e).split(String.fromCharCode(10)).slice(0, 3).join(' | ')); } };
    const clickB = async (page, sel, label, opts) => { try { await page.locator(sel).first().waitFor({ state: 'visible', timeout: 3000 }); await clickC(page, sel, Object.assign({ timeout: 3000 }, opts || {})); return true; } catch (e) { check((label || '点击 ' + sel) + '：可点击（点不到 = 判红）', false, String(e && e.message).split(String.fromCharCode(10))[0]); return false; } };
    const focusB = async (page, sel, label) => { try { await page.locator(sel).first().focus({ timeout: 3000 }); return true; } catch (e) { check((label || '聚焦 ' + sel) + '：可聚焦（聚焦不了 = 判红）', false, String(e && e.message).split(String.fromCharCode(10))[0]); return false; } };

    // ===== W82–W85 子批 C4d-a：窄屏两档断点（D-23）+ 桌面宽度不出横向滚动（D-25）=====
    // 它锁的是：①宽度 390 / 640 / 641 / 768 / 1024 / 1025 / 1280 / 1440 下 #modelListSection.scrollWidth ≤ clientWidth，且 main 内（.navbar 除外）所有可见元素的右沿 ≤ innerWidth + 0.5，
    //   首行 / 第二行 / 主列条目内元素互不重叠，列头与首行同一网格（可见列数相等、各列左沿误差 ≤ 0.5）；展开了一个面板（上游 / 下游 / 8 个实现对象）再量；
    //   ②>1024：左栏在左（208 宽、sticky）、负责人列可见、折叠按钮与第二行开头容器不可见、关系流五列并排；≤1024：左栏在列表区上方（static、与列表同宽）、横排换行（标题占一行、选项并排、未归属区占满一行）、始终展开、
    //   负责人列（列头与首行）隐藏但 button[data-sort-by] 仍是 8 个（7 个可见）、关系流单列且箭头转 90°；③≤640：折叠按钮可见、默认收起、点开后分区可见且筛选生效（落到 DOM 行）、首行只有 展开 / 分层 / 模型 / 操作 四列、
    //   状态 / 最近验收（以及负责人）在第二行最前且文案与宽屏首行一致（手写期望）、未归属表隐藏「摘要」「核验时间」两列；641 宽度下折叠按钮不可见也不可聚焦。抽屉宽度不改（D-24：不测 100vw）。
    // 预筛修复批 HIGH-1（W82 增加宽度 700 / 1040，并对第 1 页全部 21 个条目加三条判据）：[判据 a] row1 网格项内可见后代右沿 ≤ 网格项右沿 + 0.5 且主列 scrollWidth ≤ clientWidth + 1；[判据 b] 表名可见宽度 ≥ min(40, 内容宽度)；
    //   [判据 c] 无零尺寸可聚焦元素，并在 641 做 Tab 走查（走过 ≥ 3 个条目，每次落点可见宽高 > 0）。路由替身把 #59 改成「核心 + 自定义脚本 + ⓘ」、伴生 #53 改成「核心 + 自定义脚本 + ⓘ + 伴生」，让最拥挤的标签组合进入矩阵。
    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w82-no-1024-query（去 ≤1024 媒体查询） / w82-no-640-query（去 ≤640 媒体查询） / w82-owner-visible（负责人列不隐藏）
    //   w82-mobile-meta-wide（第二行容器宽屏也显示） / w82-main-fixed-220（模型列改回 minmax(220px, 1fr)） / w82-head-pad-12（列头内边距改回 12px，列头与首行差 1px） / w82-rail-sticky（≤1024 左栏仍 sticky）
    //   w82-flow-5col（≤1024 关系流不改单列） / w82-toggle-wide（折叠按钮宽屏显示） / w82-collapse-ignored（收起规则失效，折叠状态下分区仍显示） / w82-layout-two-col（≤1024 不改单列） / w82-objtable-cols（展开面板实现对象表与未归属表的第 3、5 列都不隐藏）
    //   w82-toggle-open（折叠默认展开） / w86-collapsed-rail-clip（收起的左栏改用 height:0 裁剪而不是 display:none） / w82-pre-fix-css（把主列换行 / 表名不收缩 / 评论基准 / 标签收缩四处恢复成修复前写法）
    //   w82-btn-shrinkable（表名恢复可收缩（已知等价变异：单独不判红，见 C4d_fix_report.md §1-2；它是 w82-main-nowrap-btn-shrink 的对照）） / w82-main-nowrap（主列不换行） / w82-main-nowrap-btn-shrink（主列不换行且表名可收缩）
    //   w82-tag-no-shrink（只删标签收缩） / w82-btn-hidden-1024（≤1024 隐藏表名按钮） / w82-objtable-th-only（对象表只隐藏表头） / w82-objtable-first-row-only（对象表只隐藏表头与第一条数据行） / w82-arrow-rot0（关系流箭头 rotate(0deg)）
    //   w82-arrow-rot180（关系流箭头 rotate(180deg)） / w82-arrow-second-unrotated（第二个箭头不旋转） / w84-no-toggle（不渲染折叠按钮）
    console.log('W82–W85 C4d-a 窄屏两档断点与桌面宽度');
    await segGuard('W82–W85', async () => {
      const W82_WIDTHS = [390, 640, 641, 700, 768, 1024, 1025, 1040, 1280, 1440];
      const REL82 = { upstream: [{ name: 'ods_w0001_df' }, { name: 'ods_w0001' }], downstream: [{ id: 50, table_name: 'dim_w0007_w0008', table_comment: '字段说明3' }, { id: 55, table_name: 'dim_w0037', table_comment: '字段说明236' }], objects: REL_LISTED.objects, objectState: 'listed' };
      const settleW = (page) => pageEvalBounded(page, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));   // 42Ta-M4：有界页内调用，超时记明确失败
      const setW = async (page, w) => { await page.setViewportSize({ width: w, height: 900 }); await settleW(page); };
      /** 页内一次读完几何：全部读法写在页内，返回纯 JSON（不依赖 node 侧变量） */
      const GEO82 = () => {
        const R = (e) => e.getBoundingClientRect();
        const vis = (e) => { if (!e) return false; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getClientRects().length > 0; };
        const desc = (e) => e.tagName + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '');
        const q = (s) => document.querySelector(s);
        const iw = window.innerWidth;
        const rail = q('#catalogRail'); const sec = q('#modelListSection');
        const over = [];
        document.querySelectorAll('main, main *').forEach((e) => { if (e.closest('.navbar')) return; if (!vis(e)) return; const r = R(e); if (r.width === 0 && r.height === 0) return; if (r.right > iw + 0.5) over.push(desc(e) + ' right=' + Math.round(r.right)); });
        const inter = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
        const overlaps = [];
        Array.from(document.querySelectorAll('#modelListBody .catalog-entry')).slice(0, 8).forEach((en) => {
          [en.querySelector('.catalog-row1'), en.querySelector('.catalog-row2'), en.querySelector('.catalog-main')].forEach((box) => {
            const kids = Array.from(box.children).filter(vis);
            for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) if (inter(R(kids[i]), R(kids[j]))) overlaps.push('#' + en.getAttribute('data-id') + ' ' + desc(box) + '：' + desc(kids[i]) + ' × ' + desc(kids[j]));
          });
        });
        const head = q('.catalog-head'); const row1 = q('#modelListBody [data-id="50"] .catalog-row1');   // 未展开的条目：展开按钮转 90° 的过渡中外接框会偏，不拿来量对齐
        const hk = Array.from(head ? head.children : []).filter(vis); const rk = Array.from(row1 ? row1.children : []).filter(vis);
        const align = { headN: hk.length, rowN: rk.length, maxDx: hk.length === rk.length ? Math.max(...hk.map((h, i) => Math.abs(R(h).left - R(rk[i]).left))) : null };
        // 预筛修复批 HIGH-1：第 1 页全部条目（含伴生缩进行与构造的「核心 + 自定义脚本 + ⓘ」条目，不只前 8 个）的三条判据
        //  (a) row1 每个网格项（主列 / 状态 / 最近验收 / 负责人 / 操作区）内每个可见后代的右沿 ≤ 该网格项右沿 + 0.5，且主列 scrollWidth ≤ clientWidth + 1；
        //  (b) 表名按钮可见宽度 ≥ min(40, 其内容宽度)；(c) #modelListBody 内可聚焦元素（button / a[href] / [tabindex≠-1]）凡有盒子且不在 hidden / inert 祖先下，宽高都 > 0
        const r1 = (x) => Math.round(x * 10) / 10;
        const bleed = []; const btnLow = []; const foc = [];
        const entriesAll = Array.from(document.querySelectorAll('#modelListBody .catalog-entry'));
        entriesAll.forEach((en) => {
          const eid = en.getAttribute('data-id'); const row1 = en.querySelector('.catalog-row1');
          ['.catalog-main', '.catalog-status', '.catalog-acc', '.catalog-owner', '.model-row-actions'].forEach((sel) => {
            const cell = row1.querySelector(':scope > ' + sel);
            if (!cell || !vis(cell)) return;
            const cr = R(cell);
            cell.querySelectorAll('*').forEach((d) => { if (!vis(d)) return; const dr = R(d); if (dr.width === 0 && dr.height === 0) return; if (dr.right > cr.right + 0.5) bleed.push('#' + eid + ' ' + sel + ' > ' + desc(d) + ' 右沿 ' + r1(dr.right) + ' > 网格项右沿 ' + r1(cr.right)); });
            if (sel === '.catalog-main' && cell.scrollWidth > cell.clientWidth + 1) bleed.push('#' + eid + ' .catalog-main scrollWidth ' + cell.scrollWidth + ' > clientWidth ' + cell.clientWidth);
          });
          // 42Ta-M1：先断言表名按钮存在、display 不为 none、visibility 为 visible、文本非空、宽高 > 0，再比宽度下限（按钮被整个隐藏时 scrollWidth 也是 0，只比宽度会假绿）
          const ob = en.querySelector('.model-open-btn');
          if (!ob) { btnLow.push('#' + eid + ' 没有表名按钮'); return; }
          const obs = getComputedStyle(ob); const obr = R(ob); const bw = obr.width; const need = Math.min(40, ob.scrollWidth);
          if (obs.display === 'none' || obs.visibility !== 'visible' || ob.textContent.trim() === '' || !(obr.width > 0 && obr.height > 0)) btnLow.push('#' + eid + ' 表名按钮不可见 / 无文本 / 零尺寸：display=' + obs.display + ' visibility=' + obs.visibility + ' 文本长 ' + ob.textContent.trim().length + ' 尺寸 ' + r1(obr.width) + 'x' + r1(obr.height));
          else if (bw < need - 1) btnLow.push('#' + eid + ' 表名可见宽 ' + r1(bw) + ' < ' + r1(need) + '（内容宽 ' + ob.scrollWidth + '）');
        });
        document.querySelectorAll('#modelListBody button, #modelListBody a[href], #modelListBody [tabindex]:not([tabindex="-1"])').forEach((e) => {
          if (e.disabled || getComputedStyle(e).display === 'none' || e.closest('[hidden], [inert]') || e.getClientRects().length === 0) return;
          const fr = R(e); if (!(fr.width > 0 && fr.height > 0)) { const en = e.closest('.catalog-entry'); foc.push((en ? '#' + en.getAttribute('data-id') + ' ' : '') + desc(e) + ' ' + r1(fr.width) + 'x' + r1(fr.height)); }
        });
        const nEntries = entriesAll.length;
        const first = q('#modelListBody .catalog-entry') || document.createElement('div');   // fix42b：没有任何条目时用空节点占位，下面的读取得到「缺失」而不是抛异常
        const toggle = q('.catalog-rail-toggle');
        const rr = R(rail); const sr = R(sec);
        const sortBtns = Array.from(document.querySelectorAll('button[data-sort-by]'));
        const h5s = Array.from(rail.querySelectorAll('h5'));
        const layerSec = Array.from(rail.querySelectorAll('.catalog-rail-sec')).find((s) => s.querySelector('h5') && s.querySelector('h5').textContent === '分层');
        const ZR = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; const RZ = (e) => (e ? R(e) : ZR);   // fix42b：缺节点给零矩形（对应判据判红），不抛异常
        const li = Array.from(layerSec ? layerSec.querySelectorAll('[data-rail]') : []); const l0 = RZ(li[0]); const l1 = RZ(li[1]); const lh = RZ(layerSec && layerSec.querySelector('h5'));
        const orphan = q('#catalogRail .catalog-rail-orphan'); const orR = RZ(orphan);
        const pane = first.querySelector('.pane'); const flow = pane ? pane.querySelector('.catalog-flow') : null;
        let fl = null;
        if (flow) { const cols = flow.querySelectorAll('.catalog-flow-col'); const me = flow.querySelector('.catalog-flow-me'); const ar0 = flow.querySelector('.catalog-flow-arrow'); const a = RZ(cols[0]); const m = RZ(me); const d = RZ(cols[1]); fl = { n: getComputedStyle(flow).gridTemplateColumns.split(' ').length, rowLike: !!cols[0] && !!me && !!cols[1] && Math.abs(a.top - m.top) < 30 && a.right <= m.left + 0.5 && m.right <= d.left + 0.5, stacked: !!cols[0] && !!me && !!cols[1] && a.bottom <= m.top + 0.5 && m.bottom <= d.top + 0.5, arrow: ar0 ? getComputedStyle(ar0).transform : null }; }
        // 42Ta-M3：读全部 .catalog-flow-arrow 的计算 transform，转成矩阵分量；42Ta-M2：读实现对象表全部行（含表头）每个单元格的可见性
        const arrows = flow ? Array.from(flow.querySelectorAll('.catalog-flow-arrow')).map((ar) => { const mx = new DOMMatrix(getComputedStyle(ar).transform); return { a: mx.a, b: mx.b, c: mx.c, d: mx.d }; }) : null;
        const objRows = pane ? Array.from(pane.querySelectorAll('.catalog-objtable tr')).map((tr) => Array.from(tr.children).map(vis)) : null;
        return {
          iw, secSW: sec.scrollWidth, secCW: sec.clientWidth, over, overlaps, align, bleed, btnLow, foc, nEntries,
          railLeft: rr.right <= sr.left + 0.5, railAbove: rr.bottom <= sr.top + 0.5, railW: Math.round(rr.width), secW: Math.round(sr.width), railLeftEdge: Math.round(rr.left), secLeftEdge: Math.round(sr.left),
          railPos: getComputedStyle(rail).position, railMaxH: getComputedStyle(rail).maxHeight,
          ownerHead: vis(q('.catalog-col-owner')), ownerCell: vis(first.querySelector('.catalog-owner')), toggleVis: vis(toggle), mobileVis: vis(first.querySelector('.catalog-mobile-meta')),
          sortTotal: sortBtns.length, sortVis: sortBtns.filter(vis).length, objTh: pane ? Array.from(pane.querySelectorAll('.catalog-objtable th')).map((e) => [e.textContent, vis(e)]) : null, ownerSortVis: vis(q('button[data-sort-by="tech_owner"]')),
          row1Vis: Array.from(row1 ? row1.children : []).filter(vis).length,
          h5Vis: h5s.map(vis), itemsVis: Array.from(rail.querySelectorAll('[data-rail]')).map(vis), orphanVis: vis(orphan),
          layerSide: Math.abs(l0.top - l1.top) < 3 && l1.left >= l0.right - 0.5, layerBelowTitle: l0.top >= lh.bottom - 0.5, itemAuto: !!layerSec && l0.width < R(layerSec).width - 20, orphanFull: orR.width >= rr.width - 24,
          fl, arrows, objRows,
        };
      };
      // 预筛修复批：路由替身（不改共享夹具）——#59 改成「核心 + 自定义脚本 + ⓘ」、伴生 #53 改成「核心 + 自定义脚本 + ⓘ + 伴生」，让最拥挤的标签组合进入第 1 页矩阵
      const P82 = { 59: { config_mode: 'custom', category: 'core', design_notes: 'W82 构造：核心 + 自定义脚本 + 设计说明' }, 53: { config_mode: 'custom', category: 'core', design_notes: 'W82 构造：伴生 + 自定义脚本 + 设计说明' } };
      const { page } = await open(adminN, 'W82', '', { beforeGoto: async (pg) => { await rewriteList(patchRows(P82))(pg); await pg.route(/\/api\/models\/\d+\/relations(\?.*)?$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REL82) })); } });
      check('W82 前置：首个条目是 #60，展开它（面板带 8 个实现对象 + 上游 2 + 下游 2）', J((await domIds(page)).slice(0, 1)) === J([60]));
      await clickB(page, '#modelListBody [data-id="60"] [data-expand-toggle]');
      await page.waitForSelector('#modelListBody [data-id="60"] > .pane.catalog-pane-loaded', { timeout: WAIT });
      // 42Ta-M2 / M3 的断言助手：全部行（含表头）逐格比对；全部箭头逐个比对 90° 旋转矩阵（a≈0、b≈1、c≈−1、d≈0，容差 0.01）/ 单位矩阵
      const rowsAre = (rows, pat) => !!rows && rows.length === 9 && rows.every((r) => J(r) === J(pat));   // 1 行表头 + 8 个实现对象
      const rot90 = (ar) => !!ar && ar.length >= 2 && ar.every((mx) => Math.abs(mx.a) < 0.01 && Math.abs(mx.b - 1) < 0.01 && Math.abs(mx.c + 1) < 0.01 && Math.abs(mx.d) < 0.01);
      const rot0 = (ar) => !!ar && ar.length >= 2 && ar.every((mx) => Math.abs(mx.a - 1) < 0.01 && Math.abs(mx.b) < 0.01 && Math.abs(mx.c) < 0.01 && Math.abs(mx.d - 1) < 0.01);
      const GEOS = {};
      for (const w of W82_WIDTHS) {
        await setW(page, w);
        const g = GEOS[w] = await page.evaluate(GEO82);
        check(`W82 ${w}：#modelListSection.scrollWidth ≤ clientWidth（无横向滚动）`, g.iw === w && g.secSW <= g.secCW, { iw: g.iw, sw: g.secSW, cw: g.secCW });
        check(`W82 ${w}：main 内（.navbar 除外）所有可见元素右沿 ≤ innerWidth + 0.5`, g.over.length === 0, g.over.slice(0, 10));
        check(`W82 ${w}：首行 / 第二行 / 主列里的可见元素互不重叠（前 8 个条目）`, g.overlaps.length === 0, g.overlaps.slice(0, 6));
        check(`W82 ${w}：列头与首行同一网格（可见列数相等、各列左沿误差 ≤ 0.5）`, g.align.headN === g.align.rowN && g.align.maxDx !== null && g.align.maxDx <= 0.5, g.align);
        check(`W82 ${w} [判据 a 不越界]：第 1 页全部 ${g.nEntries} 个条目（含伴生缩进行与构造的核心 + 自定义脚本 + ⓘ 条目）的 row1 网格项（主列 / 状态 / 最近验收 / 负责人 / 操作区）内可见后代右沿 ≤ 网格项右沿 + 0.5，主列 scrollWidth ≤ clientWidth + 1`, g.nEntries === 21 && g.bleed.length === 0, { n: g.nEntries, bleed: g.bleed.slice(0, 8) });
        check(`W82 ${w} [判据 b 表名下限]：全部条目的表名按钮存在、display 不为 none、visibility 为 visible、文本非空、宽高 > 0，且可见宽度 ≥ min(40, 其内容宽度)`, g.nEntries === 21 && g.btnLow.length === 0, { n: g.nEntries, low: g.btnLow.slice(0, 8) });
        check(`W82 ${w} [判据 c 无零尺寸可聚焦元素]：#modelListBody 内有盒子、不在 hidden / inert 祖先下的 button / a[href] / [tabindex≠-1] 宽与高都 > 0`, g.nEntries === 21 && g.foc.length === 0, { n: g.nEntries, zero: g.foc.slice(0, 8) });
        if (w === 641) {
          // [判据 c] 的 Tab 走查：从第 1 个条目的展开按钮起一路 Tab，直到走过 5 个不同条目（要求至少 3 个），每次落点元素的可见宽高都 > 0
          await page.evaluate(() => { const eb82 = document.querySelector('#modelListBody .catalog-entry .catalog-expand-btn'); if (eb82) eb82.focus(); });
          const seen641 = []; const zero641 = []; let tabs641 = 0; let left641 = false;
          for (; tabs641 < 120 && seen641.length < 5; tabs641++) {
            const s = await page.evaluate(() => { const a = document.activeElement; const en = a && a.closest ? a.closest('#modelListBody .catalog-entry') : null; if (!en) return { out: true, tag: a ? a.tagName : null }; const fr = a.getBoundingClientRect(); return { id: en.getAttribute('data-id'), w: Math.round(fr.width * 10) / 10, h: Math.round(fr.height * 10) / 10, d: a.tagName + '.' + String(a.className).split(' ')[0] }; });
            if (s.out) { left641 = true; break; }
            if (!seen641.includes(s.id)) seen641.push(s.id);
            if (!(s.w > 0 && s.h > 0)) zero641.push('#' + s.id + ' ' + s.d + ' ' + s.w + 'x' + s.h);
            await page.keyboard.press('Tab');
          }
          check('W82 641 [判据 c Tab 走查]：从第 1 个条目起 Tab 走过 ≥ 3 个条目（实走 ' + seen641.join('、') + '，用了 ' + tabs641 + ' 次 Tab），每次焦点所在元素的可见宽高都 > 0', seen641.length >= 3 && zero641.length === 0 && !left641, { seen: seen641, zero: zero641, tabs: tabs641, left: left641 });
        }
      }
      for (const w of [1025, 1280, 1440]) {
        const g = GEOS[w];
        check(`W83 ${w}（>1024）：左栏在列表区左侧、宽 208、sticky；负责人列（列头与首行）可见；折叠按钮与第二行开头容器不可见`, g.railLeft && !g.railAbove && g.railW === 208 && g.railPos === 'sticky' && g.ownerHead && g.ownerCell && !g.toggleVis && !g.mobileVis, g);
        check(`W83 ${w}（>1024）：首行 7 列可见、button[data-sort-by] 共 8 个且 8 个可见；关系流五列并排`, g.row1Vis === 7 && g.sortTotal === 8 && g.sortVis === 8 && g.fl && g.fl.n === 5 && g.fl.rowLike && !g.fl.stacked, { row1Vis: g.row1Vis, sort: [g.sortTotal, g.sortVis], fl: g.fl });
        check(`W83 ${w}（>1024）：关系流全部箭头（≥ 2 个）不旋转（计算 transform 是单位矩阵）`, rot0(g.arrows), g.arrows);
      }
      for (const w of [390, 640, 641, 768, 1024]) {
        const g = GEOS[w];
        check(`W83 ${w}（≤1024）：左栏在列表区上方（不 sticky、不限高）、与列表同左沿同宽；负责人列（列头与首行）隐藏；排序键仍是 8 个 button[data-sort-by]（在 DOM 里），可见数 641–1024 为 7（负责人那个不可见），≤640 为 5（状态 / 最近验收 / 负责人三个列头随列隐藏）`, g.railAbove && !g.railLeft && g.railPos === 'static' && g.railMaxH === 'none' && g.railLeftEdge === g.secLeftEdge && Math.abs(g.railW - g.secW) <= 1 && !g.ownerHead && !g.ownerCell && g.sortTotal === 8 && g.sortVis === (w <= 640 ? 5 : 7) && !g.ownerSortVis, g);
        check(`W83 ${w}（≤1024）：关系流单列、三块自上而下`, !!g.fl && g.fl.n === 1 && g.fl.stacked && !g.fl.rowLike, g.fl);
        check(`W83 ${w}（≤1024）：关系流全部箭头（≥ 2 个）的计算 transform 都是 90° 旋转矩阵（DOMMatrix：a≈0、b≈1、c≈−1、d≈0，容差 0.01）`, rot90(g.arrows), g.arrows);
      }
      for (const w of [641, 768, 1024, 1025, 1280, 1440]) {
        const g = GEOS[w];
        check(`W83 ${w}（>640）：展开面板里的实现对象表五列全部可见`, J(g.objTh) === J([['类型', true], ['对象', true], ['职责', true], ['三端一致性', true], ['核验', true]]), g.objTh);
        check(`W83 ${w}（>640）：实现对象表全部 9 行（表头 + 8 个对象）每个单元格五列都可见`, rowsAre(g.objRows, [true, true, true, true, true]), g.objRows);
      }
      for (const w of [641, 768, 1024]) {
        const g = GEOS[w];
        check(`W83 ${w}（641–1024）：左栏始终展开（四个标题与全部选项可见、不显示折叠按钮）；分区横排换行：标题占一行、「全部」与「ODS」并排、选项宽度自适应、未归属区占满一行；第二行开头容器不可见、首行 6 列`, g.h5Vis.length === 5 && g.h5Vis.every(Boolean) && g.itemsVis.every(Boolean) && g.orphanVis && !g.toggleVis && g.layerSide && g.layerBelowTitle && g.itemAuto && g.orphanFull && !g.mobileVis && g.row1Vis === 6, g);
      }
      for (const w of [390, 640]) {
        const g = GEOS[w];
        check(`W83 ${w}（≤640）：展开面板里的实现对象表隐藏第 3、5 列（职责、核验），类型 / 对象 / 三端一致性可见`, J(g.objTh) === J([['类型', true], ['对象', true], ['职责', false], ['三端一致性', true], ['核验', false]]), g.objTh);
        check(`W83 ${w}（≤640）：实现对象表全部 9 行（表头 + 8 个对象）逐格：第 3、5 列隐藏，其余三列可见`, rowsAre(g.objRows, [true, true, false, true, false]), g.objRows);
      check(`W83 ${w}（≤640）：折叠按钮可见、第二行开头容器可见、首行只有 4 列（展开 / 分层 / 模型 / 操作）、列头也是 4 列；分区默认收起（标题与选项都不可见）`, g.toggleVis && g.mobileVis && g.row1Vis === 4 && g.align.headN === 4 && g.h5Vis.every((v) => !v) && g.itemsVis.every((v) => !v) && !g.orphanVis, g);
      }
      await page.close();
    });

    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w82-toggle-stuck（点击不翻转） / w82-toggle-aria-false（aria-expanded 恒 false） / w82-meta-owner-blank（第二行负责人为空）
    //   w82-meta-no-status（第二行缺状态徽章） / w84-ctl-dup（aria-controls 重复同一 id） / w84-ctl-wrong（aria-controls 含错误 id） / w84-ctl-data-section（某区块的 id 属性改成 title）
    console.log('W84 ≤640 折叠按钮与第二行开头容器');
    await segGuard('W84', async () => {
      const { page } = await open(adminN, 'W84', '');
      const HAND84 = { 60: { st: '规划中', acc: '无验收', own: '管理员' }, 50: { st: '开发中', acc: '无验收', own: '测试负责人' }, 55: { st: '规划中', acc: '无验收', own: '管理员' }, 53: { st: '规划中', acc: '随主模型', own: '管理员' } };
      const sett = (pg) => pageEvalBounded(pg, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));   // 42Ta-M4：有界页内调用
      const vwset = async (w) => { await page.setViewportSize({ width: w, height: 900 }); await sett(page); };
      const secVis = () => page.evaluate(() => { const rail = document.getElementById('catalogRail'); const vis = (e) => { if (!e) return false; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getClientRects().length > 0; }; return { h5: Array.from(rail.querySelectorAll('h5')).filter(vis).length, items: Array.from(rail.querySelectorAll('[data-rail]')).filter(vis).length, itemsAll: rail.querySelectorAll('[data-rail]').length, head: vis(rail.querySelector('.catalog-rail-head')), orphan: vis(rail.querySelector('.catalog-rail-orphan')), isOpen: rail.classList.contains('is-open') }; });
      // 42Ta-L1 / 42Tc-M1：aria-controls 与预期 6 个区块 id 做集合相等（Set 大小 6、成员全等），并核每个目标元素真的存在于左栏内；缺节点 / 缺子节点返回可判定的缺失信息（不抛异常，42Ta-L2）
      const EXP84 = ['catalogRailHead', 'catalogRailSecView', 'catalogRailSecLayer', 'catalogRailSecStatus', 'catalogRailSecDomain', 'catalogRailOrphan'];
      const tg = () => page.evaluate((EXP) => { const t = document.querySelector('.catalog-rail-toggle'); const rail = document.getElementById('catalogRail'); if (!t) return { missing: 'toggle' }; const cs = getComputedStyle(t); const ids = (t.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean); return { first: rail.firstElementChild === t, tag: t.tagName, type: t.getAttribute('type'), exp: t.getAttribute('aria-expanded'), ctl: ids, ctlOk: ids.length === 6 && new Set(ids).size === 6 && JSON.stringify(ids.slice().sort()) === JSON.stringify(EXP.slice().sort()) && ids.every((i) => !!document.getElementById(i) && rail.contains(document.getElementById(i))), lbl: t.firstElementChild ? t.firstElementChild.textContent : null, n: t.lastElementChild ? t.lastElementChild.textContent : null, shown: cs.display !== 'none' && t.getClientRects().length > 0 }; }, EXP84);
      // —— 宽屏首行三格文案（手写期望对照）
      await vwset(1280);
      const wide = await page.evaluate(() => { const o = {}; document.querySelectorAll('#modelListBody .catalog-entry').forEach((e) => { const id = e.getAttribute('data-id'); const tx = (s) => { const x = e.querySelector(s); return x ? x.textContent : null; }; o[id] = { st: tx('.catalog-row1 > .catalog-status'), acc: tx('.catalog-row1 > .catalog-acc'), own: tx('.catalog-row1 > .catalog-owner') }; }); return o; });
      check('W84 前置（1280）：首行状态 / 最近验收 / 负责人文案等于手写期望（#60 / #50 / #55 / #53）', [60, 50, 55, 53].every((id) => J(wide[id]) === J(HAND84[id])), wide);
      // —— 390：折叠按钮
      await vwset(390);
      const t0 = await tg();
      check('W84 390：折叠按钮是左栏第一个子元素的 button[type=button]，aria-expanded="false"，aria-controls 指向左栏里 6 个存在的区块 id，文字「筛选 ▾」+「全部」，可见', !!t0 && t0.first && t0.tag === 'BUTTON' && t0.type === 'button' && t0.exp === 'false' && t0.ctlOk && t0.lbl === '筛选 ▾' && t0.n === '全部' && t0.shown, t0);
      const s0 = await secVis();
      check('W84 390：默认收起——分区标题 / 选项 / 头部 / 未归属区都不可见（只显示折叠按钮），rail 没有 is-open 类', s0.h5 === 0 && s0.items === 0 && s0.itemsAll === 16 && !s0.head && !s0.orphan && !s0.isOpen, s0);
      // 点击一律有界（元素不可见 / 点不到 = 判红，不等 30 秒默认超时、不让用例整体崩掉）
      const clickSafe = async (sel, label) => { try { await page.locator(sel).first().waitFor({ state: 'visible', timeout: 3000 }); await clickC(page, sel, { timeout: 3000 }); return true; } catch (e) { check(label + '：可点击（点不到 = 判红）', false, String(e && e.message).split(String.fromCharCode(10))[0]); return false; } };
      // 42Ta-L2：点击链——每一步点击成功才继续依赖它的后续步骤（点不到已由 clickSafe 记一条失败；这里不再让后续读取抛异常崩掉整个用例）；与点击无关的独立检查（第二行容器、640 / 641 边界、新开页面默认收起）照常进行
      let chain84 = await clickSafe('.catalog-rail-toggle', 'W84 点折叠按钮（展开）');
      if (!chain84) console.log('  （W84：折叠按钮点不到，依赖该点击的展开 / 筛选 / 收起 / 清除步骤已跳过，独立检查继续）');
      if (chain84) {
      const t1 = await tg(); const s1 = await secVis();
      check('W84 390：点折叠按钮 → aria-expanded="true"、文字「筛选 ▴」；分区全部可见（5 个标题 / 16 个选项 / 头部 / 未归属区）、rail 有 is-open 类', !!t1 && t1.exp === 'true' && t1.lbl === '筛选 ▴' && s1.h5 === 5 && s1.items === 16 && s1.head && s1.orphan && s1.isOpen, { t1, s1 });
      chain84 = await clickSafe('#catalogRail [data-rail="layer:DIM"]', 'W84 点 DIM 筛选项');
      }
      if (chain84) {
      const idsDim = await domIds(page); const t1b = await tg();
      check('W84 390：展开态下点「DIM」筛选项 → 列表只剩 DIM 的 6 个模型 [60, 50, 55, 58, 62, 65]（落到 DOM），折叠按钮右侧变「1 项」', J(idsDim) === J([60, 50, 55, 58, 62, 65]) && t1b.n === '1 项', { ids: idsDim, t: t1b });
      chain84 = await clickSafe('.catalog-rail-toggle', 'W84 点折叠按钮（收起）');
      }
      if (chain84) {
      const t2 = await tg(); const s2 = await secVis();
      check('W84 390：再点折叠按钮 → 收起（aria-expanded="false"、分区不可见），筛选仍在（列表仍是 DIM 的 6 个、按钮右侧仍是「1 项」）', t2.exp === 'false' && t2.lbl === '筛选 ▾' && t2.n === '1 项' && s2.h5 === 0 && s2.items === 0 && !s2.isOpen && J(await domIds(page)) === J([60, 50, 55, 58, 62, 65]), { t2, s2 });
      chain84 = await clickSafe('.catalog-rail-toggle', 'W84 点折叠按钮（再展开）');
      }
      if (chain84) chain84 = await clickSafe('#catalogRail [data-catalog-act="rail-clear"]', 'W84 点「清除 1 项」');
      if (chain84) {
      const idsClr = await domIds(page); const t1c = await tg();
      check('W84 390：展开后点「清除 1 项」→ 列表恢复（含 #53）、按钮右侧回「全部」', idsClr.includes(53) && idsClr.length > 6 && t1c.n === '全部', { ids: idsClr.slice(0, 10), t: t1c });
      }
      // —— 第二行最前：状态 / 最近验收 / 负责人（手写期望）
      const mob = await page.evaluate(() => { const o = {}; document.querySelectorAll('#modelListBody .catalog-entry').forEach((e) => { const id = e.getAttribute('data-id'); const r2 = e.querySelector('.catalog-row2'); const m = r2 && r2.querySelector('.catalog-mobile-meta'); if (!r2 || !m) { o[id] = { missing: true }; return; } const R = (x) => x.getBoundingClientRect(); const disp = (s) => { const x = e.querySelector(s); return x ? getComputedStyle(x).display : 'missing'; }; const others = Array.from(r2.children).filter((c) => c !== m && getComputedStyle(c).display !== 'none'); o[id] = { st: ((x) => (x ? x.textContent : null))(m.querySelector('.u-status-badge')), acc: ((x) => (x ? x.textContent : null))(m.querySelector('.catalog-acc-m')), own: ((x) => (x ? x.textContent : null))(m.querySelector('.catalog-owner-m')), firstChild: r2.firstElementChild === m, topMost: others.every((c) => R(m).top <= R(c).top + 0.5), leftMost: R(m).left <= Math.min(...others.map((c) => R(c).left)) + 0.5, below: R(m).top >= R(e.querySelector('.catalog-row1')).bottom - 0.5, rowSt: disp('.catalog-row1 > .catalog-status'), rowAcc: disp('.catalog-row1 > .catalog-acc'), rowOwn: disp('.catalog-row1 > .catalog-owner') }; }); return o; });
      check('W84 390：第二行最前的容器里 状态 / 最近验收 / 负责人 文案 = 宽屏首行文案（手写期望：#60 规划中·无验收·管理员 / #50 开发中·无验收·测试负责人 / #55 / #53 规划中·随主模型·管理员）', [60, 50, 55, 53].every((id) => mob[id] && mob[id].st === HAND84[id].st && mob[id].acc === HAND84[id].acc && mob[id].own === HAND84[id].own), mob);
      check('W84 390：该容器是第二行第一个子元素、位置在第二行其余内容的最上最左、在首行之下；首行里的状态 / 最近验收 / 负责人三格都是 display:none', Object.keys(mob).every((id) => mob[id].firstChild && mob[id].topMost && mob[id].leftMost && mob[id].below && mob[id].rowSt === 'none' && mob[id].rowAcc === 'none' && mob[id].rowOwn === 'none'), mob[60]);
      // —— 640 / 641 的边界
      await vwset(640);
      const t640 = await tg();
      check('W84 640（边界，≤640 含 640）：折叠按钮可见（折叠状态是页面变量，沿用本页前面展开过的值 true；默认收起见 W84b）', !!t640 && t640.shown && t640.exp === 'true' && t640.lbl === '筛选 ▴', t640);
      await vwset(641);
      const t641 = await tg();
      const f641 = await page.evaluate(() => { const t = document.querySelector('.catalog-rail-toggle'); if (!t) return null; t.focus(); return document.activeElement === t; });
      check('W84 641（>640）：折叠按钮不显示、不可聚焦（不进 Tab 序列）；分区可见（左栏始终展开）；首行状态 / 最近验收格可见', !!t641 && !t641.shown && f641 === false && (await secVis()).h5 === 5 && (await page.evaluate(() => { const e = document.querySelector('#modelListBody .catalog-entry'); const v = (x) => getComputedStyle(x).display !== 'none'; return v(e.querySelector('.catalog-row1 > .catalog-status')) && v(e.querySelector('.catalog-row1 > .catalog-acc')) && !v(e.querySelector('.catalog-mobile-meta')); })), { t641, f641 });
      await page.close();
      // 折叠状态不持久化：新页面 390 宽度打开 → 默认收起（即使上一个页面把它展开过）
      const p2 = await open(adminN, 'W84b', '', { beforeGoto: async (pg) => { await pg.setViewportSize({ width: 390, height: 900 }); } });
      const t2b = await p2.page.evaluate(() => { const t = document.querySelector('.catalog-rail-toggle'); if (!t) return { missing: 'toggle' }; return { exp: t.getAttribute('aria-expanded'), open: document.getElementById('catalogRail').classList.contains('is-open'), shown: getComputedStyle(t).display !== 'none' }; });
      check('W84b 新开页面（390 宽）：折叠按钮默认收起（页面变量，不持久化：aria-expanded="false"、无 is-open）', t2b.shown && t2b.exp === 'false' && !t2b.open, t2b);
      await p2.page.close();
      const p3 = await open(adminN, 'W84c', '', { beforeGoto: async (pg) => { await pg.setViewportSize({ width: 640, height: 900 }); } });
      const t3b = await p3.page.evaluate(() => { const t = document.querySelector('.catalog-rail-toggle'); const rail = document.getElementById('catalogRail'); if (!t) return { missing: 'toggle' }; const vis = (e) => getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; return { exp: t.getAttribute('aria-expanded'), shown: vis(t), h5: Array.from(rail.querySelectorAll('h5')).filter(vis).length }; });
      check('W84c 新开页面（640 宽，边界）：折叠按钮可见、默认收起（aria-expanded="false"、分区标题都不可见）', t3b.shown && t3b.exp === 'false' && t3b.h5 === 0, t3b);
      await p3.page.close();
    });

    console.log('W85 ≤640 未归属表隐藏「摘要」与「核验时间」');
    await segGuard('W85', async () => {
      const ROWS85 = [
        { id: 951, obj_type: 'PROC', schema_name: 'dbo', obj_name: 'usp_w85a', summary: '摘要甲', verified_at: '2026-03-01 08:00:00', badges: { doc: 'consistent', reg: 'consistent' } },
        { id: 952, obj_type: 'VIEW', schema_name: null, obj_name: 'v_w85b', summary: '摘要乙', verified_at: null, badges: { doc: null, reg: null } },
      ];
      const un = { n: 0 };
      const { page } = await open(adminN, 'W85', '', { beforeGoto: unRoute(un, async () => ({ json: ROWS85 })) });
      check('W85 前置：2 行合法响应，计数「2」', await waitUnCount(page, '2'));
      const colsVis = () => page.evaluate(() => { const t = document.querySelector('#catalogUnownedPanel table'); if (!t) return { th: [], tdAll: [], sw: false, missing: 'table' }; const vis = (e) => getComputedStyle(e).display !== 'none'; return { th: Array.from(t.querySelectorAll('th')).map((e) => [e.textContent, vis(e)]), tdAll: Array.from(t.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((e) => vis(e))), sw: document.getElementById('modelListSection').scrollWidth <= document.getElementById('modelListSection').clientWidth }; });
      await page.setViewportSize({ width: 641, height: 900 });
      await clickB(page, '.catalog-rail [data-catalog-act="unowned"]');
      check('W85 前置：表格 2 行', await waitUnRows(page, 2));
      const c641 = await colsVis();
      check('W85 641：未归属表五列（类型 / 名称 / 摘要 / 徽章 / 核验时间）表头与单元格全部可见', J(c641.th) === J([['类型', true], ['名称', true], ['摘要', true], ['徽章', true], ['核验时间', true]]) && c641.tdAll.length === 2 && c641.tdAll.every((r) => J(r) === J([true, true, true, true, true])), c641);
      await page.setViewportSize({ width: 390, height: 900 });
      await pageEvalBounded(page, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      const c390 = await colsVis();
      check('W85 390：「摘要」与「核验时间」两列（表头与单元格）隐藏，类型 / 名称 / 徽章三列可见；无横向滚动', J(c390.th) === J([['类型', true], ['名称', true], ['摘要', false], ['徽章', true], ['核验时间', false]]) && c390.tdAll.length === 2 && c390.tdAll.every((r) => J(r) === J([true, true, false, true, false])) && c390.sw === true, c390);
      await page.close();
    });

    // ===== W86–W94 子批 C4d-b：可访问性七条（D-26）+ LOW-9 + 带入项 ③（P40）⑤（highlightModel 退出未归属模式）=====
    // 每条 D-26 一个可 grep 的标签：A11Y-1（展开按钮 aria-expanded / aria-controls）/ A11Y-2（⋯ 与「验收 ▾」aria-haspopup + aria-expanded）/ A11Y-3（排序键 aria-sort）/ A11Y-4（左栏 aria-pressed 与折叠按钮）/
    //   A11Y-5（Tab 走查 + 焦点框 + 隐藏元素不得获得焦点）/ A11Y-6（Esc 层级 + 焦点移出菜单关闭）/ A11Y-7（展开面板重试是 button，键盘可达、回车重试）；LOW-9（列头去 row / columnheader、每组 role=listitem）；P40；⑤。
    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-menu-no-haspopup（菜单触发按钮去 aria-haspopup） / w86-menu-expanded-stale（菜单触发按钮 aria-expanded 恒为 false）
    console.log('W86 A11Y-1 / A11Y-2 展开按钮与菜单触发按钮');
    await segGuard('W86', async () => {
      const REL86 = { upstream: [{ name: 'dim_w0007_w0008' }], downstream: [{ id: 50, table_name: 'dim_w0007_w0008', table_comment: '字段说明3' }, { id: 55, table_name: 'dim_w0037', table_comment: '字段说明236' }], objects: REL_LISTED.objects, objectState: 'listed' };
      const relOk86 = (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REL86) });
      const { page } = await open(adminN, 'W86', '', { beforeGoto: async (pg) => { await pg.route(/\/api\/models\/\d+\/relations(\?.*)?$/, relOk86); } });
      const tgState = (id) => page.evaluate((id) => { const en = document.querySelector('#modelListBody [data-id="' + id + '"]'); const b = en && en.querySelector('[data-expand-toggle]'); if (!en || !b) return { tag: null, type: null, exp: null, ctl: null, pane: null, missing: en ? 'toggle' : 'entry' }; const ctl = b.getAttribute('aria-controls'); const pane = document.getElementById(ctl); return { tag: b.tagName, type: b.getAttribute('type'), exp: b.getAttribute('aria-expanded'), ctl, pane: pane ? { cls: pane.className.split(' ').slice(0, 2).join(' '), id: pane.id, inEntry: en.contains(pane), loaded: pane.classList.contains('catalog-pane-loaded') } : null }; }, id);
      for (const id of [60, 53]) {
        const s0 = await tgState(id);
        check(`A11Y-1 #${id}：展开按钮是 button[type=button]，aria-expanded="false"，aria-controls="pane-${id}"，收起时面板元素不存在`, s0.tag === 'BUTTON' && s0.type === 'button' && s0.exp === 'false' && s0.ctl === 'pane-' + id && s0.pane === null, s0);
        await clickB(page, `#modelListBody [data-id="${id}"] [data-expand-toggle]`);
        await page.waitForSelector(`#modelListBody [data-id="${id}"] > .pane.catalog-pane-loaded`, { timeout: WAIT });
        const s1 = await tgState(id);
        check(`A11Y-1 #${id}：点击展开后 aria-expanded="true"，aria-controls 指向的元素存在、id 一致、是该条目里的 .pane`, s1.exp === 'true' && s1.pane !== null && s1.pane.id === 'pane-' + id && s1.pane.inEntry && /pane/.test(s1.pane.cls), s1);
        await clickB(page, `#modelListBody [data-id="${id}"] [data-expand-toggle]`);
        const s2 = await tgState(id);
        check(`A11Y-1 #${id}：再点收起后 aria-expanded="false"，面板元素移除`, s2.exp === 'false' && s2.pane === null, s2);
      }
      // 键盘：回车展开、空格收起（原生 button 行为；不是 div 模拟）
      await focusB(page, '#modelListBody [data-id="55"] [data-expand-toggle]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#modelListBody [data-id="55"] > .pane.catalog-pane-loaded', { timeout: WAIT });
      const k1 = await tgState(55);
      await page.keyboard.press('Space');
      const k2 = await tgState(55);
      check('A11Y-1 #55：键盘聚焦展开按钮按回车 → 展开（aria-expanded="true"、面板在）；按空格 → 收起（"false"、面板移除）', k1.exp === 'true' && k1.pane !== null && k2.exp === 'false' && k2.pane === null, { k1, k2 });
      // A11Y-2
      const menuState = (id, kind) => page.evaluate(([id, kind]) => { const en = document.querySelector('#modelListBody [data-id="' + id + '"]'); const t = en && en.querySelector('[data-menu="' + kind + '"]'); if (!t) return null; const m = document.getElementById(t.getAttribute('aria-controls')); return { tag: t.tagName, hp: t.getAttribute('aria-haspopup'), exp: t.getAttribute('aria-expanded'), role: m && m.getAttribute('role'), hidden: m && m.hasAttribute('hidden'), shown: !!m && m.getClientRects().length > 0, ctlOk: !!m && m.id === t.getAttribute('aria-controls') && en.contains(m) }; }, [id, kind]);
      const kinds = await page.evaluate(() => Array.from(document.querySelectorAll('#modelListBody [data-menu]')).map((t) => t.closest('[data-id]').getAttribute('data-id') + ':' + t.getAttribute('data-menu')));
      check('A11Y-2 前置：页面上同时有 ⋯（more）与「验收 ▾」（validate）两种触发按钮', kinds.some((k) => /:more$/.test(k)) && kinds.some((k) => /:validate$/.test(k)), kinds.slice(0, 8));
      const vid = Number((kinds.find((k) => /:validate$/.test(k)) || '0:').split(':')[0]);
      for (const [id, kind, label] of [[vid, 'validate', '「验收 ▾」'], [vid, 'more', '⋯']]) {
        const m0 = await menuState(id, kind);
        check(`A11Y-2 ${label}（#${id}）：button，aria-haspopup="menu"、aria-expanded="false"，aria-controls 指向条目内 role="menu" 的元素，菜单 hidden（不可见）`, !!m0 && m0.tag === 'BUTTON' && m0.hp === 'menu' && m0.exp === 'false' && m0.role === 'menu' && m0.hidden === true && m0.shown === false && m0.ctlOk, m0);
        await clickB(page, `#modelListBody [data-id="${id}"] [data-menu="${kind}"]`);
        const m1 = await menuState(id, kind);
        check(`A11Y-2 ${label}（#${id}）：点开后 aria-expanded="true"、菜单可见（无 hidden）`, m1.exp === 'true' && m1.hidden === false && m1.shown === true, m1);
        await page.keyboard.press('Escape');
        const m2 = await menuState(id, kind);
        check(`A11Y-2 ${label}（#${id}）：Esc 关闭后 aria-expanded="false"、菜单 hidden`, m2.exp === 'false' && m2.hidden === true && m2.shown === false, m2);
      }
      await clickB(page, `#modelListBody [data-id="${vid}"] [data-menu="more"]`);
      await clickB(page, `#modelListBody [data-id="${vid}"] [data-menu="validate"]`);
      const all2 = await page.evaluate(() => Array.from(document.querySelectorAll('#modelListBody [data-menu]')).map((t) => { const m = document.getElementById(t.getAttribute('aria-controls')); return { k: t.getAttribute('data-menu'), hp: t.getAttribute('aria-haspopup'), exp: t.getAttribute('aria-expanded'), vis: !!m && !m.hasAttribute('hidden') && m.getClientRects().length > 0 }; }));
      check('A11Y-2 全页每个触发按钮：aria-haspopup="menu"，aria-expanded 恒等于其菜单的可见性（先开 ⋯ 再开「验收 ▾」：只有后者为 true，其余全 false）', all2.length > 10 && all2.every((x) => x.hp === 'menu' && (x.exp === 'true') === x.vis) && all2.filter((x) => x.exp === 'true').length === 1 && all2.find((x) => x.exp === 'true').k === 'validate', { n: all2.length, open: all2.filter((x) => x.exp === 'true') });
      await page.close();
    });

    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-sort-aria-leak（排序键不清 aria-sort） / w86-sort-aria-asc-only（aria-sort 恒为 ascending）
    console.log('W87 A11Y-3 排序键 aria-sort');
    await segGuard('W87', async () => {
      const { page } = await open(adminN, 'W87', '');
      const sortState = () => page.evaluate(() => ({ withAria: Array.from(document.querySelectorAll('[aria-sort]')).map((e) => e.tagName + ':' + (e.getAttribute('data-sort-by') || '-') + '=' + e.getAttribute('aria-sort')), tags: Array.from(document.querySelectorAll('[data-sort-by]')).map((e) => e.tagName).filter((t) => t !== 'BUTTON').length, n: document.querySelectorAll('button[data-sort-by]').length }));
      const s0 = await sortState();
      check('A11Y-3 初始：全页恰 8 个 button[data-sort-by]（列头 5 + 工具条 3），都是 button，没有任何元素带 aria-sort', s0.n === 8 && s0.tags === 0 && s0.withAria.length === 0, s0);
      for (const key of ['layer', 'table_name', 'status', 'acceptance_at', 'tech_owner', 'updated_at', 'domain', 'id']) {
        const sel = `button[data-sort-by="${key}"]`;
        await clickB(page, sel);
        const a = await sortState();
        check(`A11Y-3 ${key} 首击：恰这一个键带 aria-sort="descending"，其余 7 个键与其他元素都不带`, J(a.withAria) === J([`BUTTON:${key}=descending`]), a);
        await clickB(page, sel);
        const b = await sortState();
        check(`A11Y-3 ${key} 二击：恰这一个键带 aria-sort="ascending"`, J(b.withAria) === J([`BUTTON:${key}=ascending`]), b);
        await clickB(page, sel);
        const c = await sortState();
        check(`A11Y-3 ${key} 三击：清排序，没有任何元素带 aria-sort`, c.withAria.length === 0, c);
      }
      await page.close();
    });

    console.log('W88 A11Y-4 左栏 aria-pressed 与折叠按钮 aria-expanded');
    await segGuard('W88', async () => {
      const un = { n: 0 };
      const { page } = await open(adminN, 'W88', '', { beforeGoto: unRoute(un, async () => ({ json: [] })) });
      const pressed = () => page.evaluate(() => ({ p: Array.from(document.querySelectorAll('#catalogRail [data-rail]')).filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-rail')), bad: Array.from(document.querySelectorAll('#catalogRail [data-rail]')).filter((b) => ['true', 'false'].indexOf(b.getAttribute('aria-pressed')) < 0 || (b.getAttribute('aria-pressed') === 'true') !== b.classList.contains('is-on')).length, un: ((x) => (x ? x.getAttribute('aria-pressed') : 'missing'))(document.getElementById('catalogRailUnowned')) }));
      const p0 = await pressed();
      check('A11Y-4 初始：aria-pressed="true" 的只有四组「全部」（view: / layer: / status: / domain:），每个选项的 aria-pressed 都是 "true" / "false" 且与 .is-on 类一致；未归属入口 "false"', J(p0.p) === J(['view:', 'layer:', 'status:', 'domain:']) && p0.bad === 0 && p0.un === 'false', p0);
      await clickB(page, '#catalogRail [data-rail="layer:DIM"]');
      await clickB(page, '#catalogRail [data-rail="status:ONLINE"]');
      const p1 = await pressed();
      check('A11Y-4 点「DIM」「已上线」后：按下的是 view: / layer:DIM / status:ONLINE / domain:（同组单选，原「layer:」释放）', J(p1.p) === J(['view:', 'layer:DIM', 'status:ONLINE', 'domain:']) && p1.bad === 0, p1);
      await clickB(page, '#catalogRail [data-rail="layer:DIM"]');
      const p2 = await pressed();
      check('A11Y-4 再点已选中的「DIM」回到该组「全部」：按下的是 view: / layer: / status:ONLINE / domain:', J(p2.p) === J(['view:', 'layer:', 'status:ONLINE', 'domain:']) && p2.bad === 0, p2);
      await clickB(page, '#catalogRail [data-catalog-act="rail-clear"]');
      await clickB(page, '#catalogRailUnowned');
      const un1 = await page.evaluate(() => { const ub = document.getElementById('catalogRailUnowned'); const up = document.getElementById('catalogUnownedPanel'); return { pr: ub ? ub.getAttribute('aria-pressed') : 'missing', panel: !!up && !up.hidden && up.getClientRects().length > 0 }; });
      check('A11Y-4 未归属入口：点开后 aria-pressed="true" 且面板可见', un1.pr === 'true' && un1.panel, un1);
      await clickB(page, '#catalogRailUnowned');
      const un2 = await page.evaluate(() => { const ub = document.getElementById('catalogRailUnowned'); const up = document.getElementById('catalogUnownedPanel'); return { pr: ub ? ub.getAttribute('aria-pressed') : 'missing', panel: up ? !up.hidden : 'missing' }; });
      check('A11Y-4 未归属入口：再点回到列表后 aria-pressed="false" 且面板隐藏', un2.pr === 'false' && un2.panel === false, un2);
      // ≤640 折叠按钮：aria-expanded 与分区可见性一致
      await page.setViewportSize({ width: 390, height: 900 });
      await pageEvalBounded(page, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));   // 42Ta-M4：全文件扫出的无界双帧等待改有界
      const tg4 = () => page.evaluate(() => { const t = document.querySelector('.catalog-rail-toggle'); const sec = document.getElementById('catalogRailSecLayer'); if (!t || !sec) return { exp: null, vis: null, missing: t ? 'section' : 'toggle' }; return { exp: t.getAttribute('aria-expanded'), vis: sec.getClientRects().length > 0 }; });
      const c0 = await tg4();
      await clickB(page, '.catalog-rail-toggle');
      const c1 = await tg4();
      await clickB(page, '.catalog-rail-toggle');
      const c2 = await tg4();
      check('A11Y-4 ≤640 折叠按钮：aria-expanded 与它控制的分区可见性一致（收起 false / 不可见 → 展开 true / 可见 → 收起 false / 不可见）', J([c0, c1, c2]) === J([{ exp: 'false', vis: false }, { exp: 'true', vis: true }, { exp: 'false', vis: false }]), [c0, c1, c2]);
      await page.close();
    });

    // 42Tb-L1 的助手：计算后的 outline-color 不透明度（rgb(...) / rgba(...) / rgb(r g b / a) / transparent；识别不了按不透明处理）
    const alphaOf = (c) => { const s = String(c).trim(); if (s === 'transparent') return 0; const sl = /\/\s*([0-9.]+%?)\s*\)/.exec(s); if (sl) return sl[1].endsWith('%') ? parseFloat(sl[1]) / 100 : parseFloat(sl[1]); const m = /^rgba\(([^)]*)\)$/.exec(s); if (m) { const p = m[1].split(',').map((x) => x.trim()); if (p.length === 4) return parseFloat(p[3]); } return 1; };
    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-focus-rule-none（共用焦点框规则改 outline:none） / w86-focus-rule-1px（共用焦点框规则改 1px）
    //   w86-focus-rule-list-only（三个都改那一条共用的 :focus-visible 规则，作用到全部 8 个容器） / w86-pane-retry-div（重试改成 div） / w89-expand-tabindex-neg（某条目展开按钮 tabindex=-1）
    //   w86-focus-rule-transparent（焦点框颜色透明）
    console.log('W89 A11Y-5 Tab 走查 + 焦点框 + 隐藏元素不得获得焦点');
    await segGuard('W89', async () => {
      const CATS = { pagehead: '.catalog-pagehead button', search: '#searchKeyword', toolbarBtn: '.catalog-toolbar button:not(.catalog-sort-btn):not(.catalog-collapse-btn)', toolbarSort: '.catalog-toolbar .catalog-sort-btn', collapseAll: '.catalog-collapse-btn', railItem: '#catalogRail [data-rail]', railClear: '#catalogRail .catalog-rail-clear', railToggle: '#catalogRail .catalog-rail-toggle', railUnowned: '#catalogRailUnowned', headSort: '.catalog-head .catalog-sort-btn', openBtn: '#modelListBody .model-open-btn', expand: '#modelListBody .catalog-expand-btn', menuTrigger: '#modelListBody .catalog-menu-trigger', actBtn: '#modelListBody .catalog-act-btn', notes: '#modelListBody .catalog-notes-btn', paneLink: '#modelListBody .catalog-model-link', paneRetry: '#modelListBody .catalog-pane-retry', paging: '#paginationControls button', listRetry: '#catalogListNotice .catalog-list-notice-retry', unBack: '#catalogUnownedPanel .catalog-unowned-back', unRefresh: '#catalogUnownedPanel .catalog-unowned-refresh', unRetry: '#catalogUnownedPanel .catalog-unowned-retry' };
      /** 页内：严格可见（display / visibility / hidden / inert、有盒子、没有被 overflow:hidden 的祖先整个裁掉） */
      const STRICT_VIS = (e) => { if (!e.isConnected || e.getClientRects().length === 0) return false; for (let p = e; p; p = p.parentElement) { const c = getComputedStyle(p); if (c.display === 'none' || c.visibility === 'hidden' || p.hasAttribute('hidden') || p.hasAttribute('inert')) return false; if (p !== e && /(hidden|clip)/.test(c.overflowX + c.overflowY)) { const pr = p.getBoundingClientRect(); const er = e.getBoundingClientRect(); if (pr.width < 1 || pr.height < 1 || er.right <= pr.left || er.left >= pr.right || er.bottom <= pr.top + 0.5 || er.top >= pr.bottom - 0.5) return false; } } const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      // 起点：blur 不会重置「顺序焦点导航起点」（Chromium 保留上一次焦点 / 点击的位置）；在 body 最前面临时放一个 tabindex=-1 的节点、聚焦后移除，起点就落在文档开头
      const resetStart = (page) => page.evaluate(() => { window.scrollTo(0, 0); window.getSelection().removeAllRanges(); const s = document.createElement('span'); s.tabIndex = -1; document.body.prepend(s); s.focus(); s.remove(); window.__walkSeen = new Set(); });
      /** 从文档开头按 Tab 走完（上限 max 次）；每次记录获得焦点的元素：类别、outline、是否严格可见、是否在 main 内；走回 body / 绕回已走过的元素即结束。末尾算「该走到而没走到」的清单 */
      const walk = async (page, max = 400) => {
        await resetStart(page);
        const recs = []; let end = 'cap';
        for (let i = 0; i < max; i++) {
          await page.keyboard.press('Tab');
          const r = await page.evaluate(async ([cats, visSrc]) => {
            const vis = (0, eval)('(' + visSrc + ')');
            const e = document.activeElement;
            if (!e || e === document.body || e === document.documentElement) return { body: true };
            if (window.__walkSeen.has(e)) return { again: true };
            window.__walkSeen.add(e);
            // 有的按钮（.btn-secondary）带 transition: all 0.2s，焦点框的宽度会从 0 过渡到 2px：有界等到 ≥ 2px（最多 700ms，规则缺失时不会无限等）再读
            let stop = false; await Promise.race([new Promise((res) => { const tick = () => { if (stop) return; if (parseFloat(getComputedStyle(e).outlineWidth) >= 2) res(); else requestAnimationFrame(tick); }; tick(); }), new Promise((res) => setTimeout(res, 700))]); stop = true;
            const cs = getComputedStyle(e);
            return { tag: e.tagName, cls: String(e.className).split(' ')[0], id: e.id, text: (e.textContent || e.value || '').trim().slice(0, 14), cats: Object.keys(cats).filter((k) => e.matches(cats[k])), os: cs.outlineStyle, ow: parseFloat(cs.outlineWidth), oc: cs.outlineColor, oo: cs.outlineOffset, vis: vis(e), inMain: !!e.closest('main'), inNav: !!e.closest('nav, .navbar') };
          }, [CATS, STRICT_VIS.toString()]);
          if (r.body) { end = 'body'; break; }
          if (r.again) { end = 'wrap'; break; }
          recs.push(r);
        }
        // 42Tb-M1：预期集合 = 可见且未禁用的原生交互元素（button / a[href] / input / select / textarea），**不因 tabindex 为负而自动排除**；另加 tabindex ≥ 0 的非原生元素。显式白名单（确需排除的）：input[type=hidden]（不是交互元素，浏览器本来就不聚焦它）
        const missing = await page.evaluate(([visSrc]) => { const vis = (0, eval)('(' + visSrc + ')'); const WL = (e) => e.matches('input[type="hidden"]'); const want = Array.from(document.querySelectorAll('main button, main input, main a[href], main select, main textarea, main [tabindex]')).filter((e) => !e.disabled && (e.matches('button, input, a[href], select, textarea') || e.tabIndex >= 0) && !WL(e) && vis(e)); return want.filter((e) => !window.__walkSeen.has(e)).map((e) => e.tagName + '.' + String(e.className).split(' ')[0] + '#' + (e.id || e.getAttribute('data-rail') || (e.textContent || '').trim().slice(0, 8))); }, [STRICT_VIS.toString()]);
        return { recs, end, missing };
      };
      const reached = (w) => new Set([].concat(...w.recs.map((r) => r.cats)));
      const checkWalk = (label, w, required, forbidden = []) => {
        const got = reached(w); const lack = required.filter((k) => !got.has(k)); const bad = forbidden.filter((k) => got.has(k));
        const firstNav = w.recs.length > 0 && w.recs[0].inNav === true;
        const mainRecs = w.recs.filter((r) => r.inMain);
        const badOutline = mainRecs.filter((r) => !(r.os !== 'none' && r.ow >= 2 && alphaOf(r.oc) > 0 && r.oo === '2px')).map((r) => r.tag + '.' + r.cls + ' ' + r.os + ' ' + r.ow + ' ' + r.oc + ' offset ' + r.oo);   // 42Tb-L1：再核颜色不透明度 > 0、outline-offset = 2px
        const hidden = w.recs.filter((r) => !r.vis).map((r) => r.tag + '.' + r.cls + '#' + (r.id || r.text));
        check(`A11Y-5 ${label}：起点确认——从文档开头出发，第一个获得焦点的是页头导航里的元素（共走 ${w.recs.length} 个焦点，${w.end === 'cap' ? '撞上限 400' : '走完（' + w.end + '）'}）`, firstNav && w.end !== 'cap' && w.recs.length > 10, { first: w.recs[0], end: w.end, n: w.recs.length });
        check(`A11Y-5 ${label}：必到类别全部被 Tab 走到：${required.join(' / ')}`, lack.length === 0, { lack, got: Array.from(got) });
        if (forbidden.length) check(`A11Y-5 ${label}：不该被走到的类别没有获得焦点：${forbidden.join(' / ')}`, bad.length === 0, bad);
        check(`A11Y-5 ${label}：main 内每次获得焦点时计算样式 outline-style ≠ none、outline-width ≥ 2px、outline-color 不透明度 > 0、outline-offset = 2px（共 ${mainRecs.length} 次）`, mainRecs.length > 10 && badOutline.length === 0, badOutline.slice(0, 8));
        check(`A11Y-5 ${label}：没有焦点落进不可见 / 被裁掉的元素（共 ${w.recs.length} 次）`, hidden.length === 0, hidden.slice(0, 8));
        check(`A11Y-5 ${label}：main 内所有可见且未禁用的可聚焦元素都被走到了（没有 Tab 不可达的）`, w.missing.length === 0, w.missing.slice(0, 10));
      };
      const REL89 = { upstream: [{ name: 'dim_w0007_w0008' }], downstream: [{ id: 50, table_name: 'dim_w0007_w0008', table_comment: '字段说明3' }], objects: REL_LISTED.objects, objectState: 'listed' };
      const un = { n: 0 };
      expectErr('W89', U_REL);
      const { page } = await open(adminN, 'W89', '', { beforeGoto: both(unRoute(un, async () => ({ json: [] })), async (pg) => { await pg.route(/\/api\/models\/\d+\/relations(\?.*)?$/, (route) => { if (/\/models\/55\/relations/.test(route.request().url())) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' }); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REL89) }); }); }) });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => { catalogToggleExpand('60'); catalogToggleExpand('55'); });
      await page.waitForSelector('#modelListBody [data-id="60"] > .pane.catalog-pane-loaded', { timeout: WAIT });
      await page.waitForSelector('#modelListBody [data-id="55"] > .pane.catalog-pane-error', { timeout: WAIT });
      const w1 = await walk(page);
      checkWalk('1440 默认态（#60 展开出链接、#55 展开失败出重试）', w1, ['pagehead', 'search', 'toolbarBtn', 'toolbarSort', 'collapseAll', 'railItem', 'railUnowned', 'headSort', 'openBtn', 'expand', 'menuTrigger', 'actBtn', 'notes', 'paneLink', 'paneRetry', 'paging'], ['railToggle', 'railClear']);
      const rails = await page.evaluate(() => document.querySelectorAll('#catalogRail [data-rail]').length);
      check('A11Y-5 1440 默认态：左栏 16 个选项（[data-rail]）每一个都被 Tab 走到', w1.recs.filter((r) => r.cats.includes('railItem')).length === rails && rails === 16, { reached: w1.recs.filter((r) => r.cats.includes('railItem')).length, rails });
      // 有筛选时出现「清除 N 项」
      await page.evaluate(() => catalogRailPick('layer:DIM'));
      const w2 = await walk(page);
      checkWalk('1440 有筛选（「清除 1 项」出现）', w2, ['railClear', 'railItem', 'headSort', 'openBtn', 'expand'], ['railToggle']);
      await page.evaluate(() => catalogRailClear());
      // 列表刷新失败的提示与重试
      expectErr('W89', U_LIST);
      await page.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' }); });
      const lr = await pageCallBounded(page, 'loadModels()', 'W89 列表刷新失败');
      check('A11Y-5 前置：列表刷新失败（loadModels 返回 \'failed\'），失败提示 #catalogListNotice 可见且带重试按钮', lr === 'failed' && (await page.locator('#catalogListNotice .catalog-list-notice-retry').isVisible()), { lr });
      const w3 = await walk(page);
      checkWalk('1440 列表刷新失败态（失败提示的重试）', w3, ['listRetry', 'openBtn', 'railItem'], ['railToggle']);
      await page.unroute(isList);
      // 未归属模式：列表区整块隐藏，其中的元素不得获得焦点；面板里的返回 / 刷新可达
      await page.evaluate(() => catalogToggleUnowned());
      await page.waitForSelector('#catalogUnownedPanel .catalog-unowned-refresh', { timeout: WAIT });
      const w4 = await walk(page);
      checkWalk('1440 未归属模式（面板的返回 / 刷新；列表区被隐藏）', w4, ['unBack', 'unRefresh', 'railItem', 'railUnowned', 'pagehead'], ['openBtn', 'expand', 'menuTrigger', 'actBtn', 'headSort', 'toolbarSort', 'search', 'paging', 'paneLink', 'paneRetry']);
      await page.close();
      // 未归属加载失败：重试按钮可达
      {
        expectErr('W89b', U_UNOWNED);
        const unb = { n: 0 };
        const p2 = await open(adminN, 'W89b', '', { beforeGoto: unRoute(unb, async () => ({ status: 500, body: '{"error":"桩"}' })) });
        await p2.page.setViewportSize({ width: 1440, height: 900 });
        check('A11Y-5 前置：未归属计数「—」（请求失败）', await p2.page.waitForFunction(() => document.getElementById('catalogRailUnownedCount').textContent === '—', null, { timeout: WAIT }).then(() => true, () => false));
        await p2.page.evaluate(() => catalogToggleUnowned());
        check('A11Y-5 前置：未归属面板显示「加载失败」+ 重试', await waitUnState(p2.page, '加载失败'));
        const w5 = await walk(p2.page);
        checkWalk('1440 未归属加载失败（重试按钮）', w5, ['unRetry', 'unBack'], ['openBtn', 'paging']);
        await p2.page.close();
      }
      // 390 收起态：折叠的左栏里的元素不得获得焦点，折叠按钮可达
      {
        const p3 = await open(adminN, 'W89c', '', { beforeGoto: async (pg) => { await pg.setViewportSize({ width: 390, height: 900 }); } });
        const w6 = await walk(p3.page);
        checkWalk('390 左栏收起态（折叠按钮可达；收起的分区 / 选项 / 清除 / 未归属入口不得获得焦点）', w6, ['railToggle', 'openBtn', 'expand', 'menuTrigger', 'toolbarSort'], ['railItem', 'railClear', 'railUnowned']);
        await p3.page.evaluate(() => catalogToggleRail());
        const w7 = await walk(p3.page);
        checkWalk('390 左栏展开态（折叠按钮与全部选项都可达）', w7, ['railToggle', 'railItem', 'railUnowned', 'openBtn']);
        await p3.page.close();
      }
    });

    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-esc-no-focus（Esc 关菜单不还焦点） / w86-esc-propagates（Esc 不阻止冒泡） / w86-focusout-noop（焦点移出不关菜单）
    //   w86-focusout-always（焦点在菜单内移动也关菜单） / w86-focusin-menu-only（A11Y-6 两个方向） / w86-focusin-open-filter（focusin 里把打开的菜单集合误过滤为 hidden 菜单）
    console.log('W90 A11Y-5 菜单项焦点框 + A11Y-6 Esc 层级与焦点移出菜单关闭');
    await segGuard('W90', async () => {
      const { page } = await open(adminN, 'W90', '');
      const MENU = '#modelListBody [data-id="50"] [data-menu="more"]';
      const st = () => page.evaluate(() => { const t = document.querySelector('#modelListBody [data-id="50"] [data-menu="more"]'); const m = t && document.getElementById(t.getAttribute('aria-controls')); if (!t || !m) return { exp: null, hidden: null, inMenu: false, onTrigger: false, onBody: false, tag: null, os: null, ow: null, oc: null, oo: null, drawer: null, missing: t ? 'menu' : 'trigger' }; const a = document.activeElement; const cs = a ? getComputedStyle(a) : null; return { exp: t.getAttribute('aria-expanded'), hidden: m.hasAttribute('hidden'), inMenu: !!a && m.contains(a), onTrigger: a === t, onBody: a === document.body, tag: a ? a.tagName + '.' + String(a.className).split(' ')[0] : null, os: cs && cs.outlineStyle, ow: cs && parseFloat(cs.outlineWidth), oc: cs && cs.outlineColor, oo: cs && cs.outlineOffset, drawer: document.getElementById('modelDetailDrawer').classList.contains('open') }; });
      const enabledItems = await page.evaluate(() => { const t = document.querySelector('#modelListBody [data-id="50"] [data-menu="more"]'); const m = t && document.getElementById(t.getAttribute('aria-controls')); return m ? m.querySelectorAll('button.catalog-menu-item:not(:disabled)').length : 0; });
      check('A11Y-6 前置：#50 的 ⋯ 菜单有 ≥ 2 个可用菜单项', enabledItems >= 2, { enabledItems });
      // 键盘打开 → Tab 逐个走过菜单项（菜单不关；每个菜单项有焦点框）→ 走出最后一项 → 菜单关闭、不抢焦点
      await focusB(page, MENU);
      await page.keyboard.press('Enter');
      const o0 = await st();
      check('A11Y-6 键盘聚焦 ⋯ 按回车打开菜单（aria-expanded="true"、菜单可见），焦点仍在触发按钮', o0.exp === 'true' && o0.hidden === false && o0.onTrigger, o0);
      const inside = [];
      for (let i = 0; i < enabledItems; i++) { await page.keyboard.press('Tab'); inside.push(await st()); }
      check(`A11Y-6 / A11Y-5 在菜单项之间 Tab 移动（${enabledItems} 次）：每次焦点都在菜单内的菜单项上，菜单始终保持打开（不因焦点移动而关），每个菜单项聚焦时 outline-style ≠ none、outline-width ≥ 2px、outline-color 不透明度 > 0、outline-offset = 2px`, inside.every((s) => s.inMenu && s.exp === 'true' && s.hidden === false && s.tag === 'BUTTON.catalog-menu-item' && s.os !== 'none' && s.ow >= 2 && alphaOf(s.oc) > 0 && s.oo === '2px'), inside);   // 42Tb-L1：再核 outline-color 不透明度 > 0、outline-offset = 2px
      await page.keyboard.press('Tab');
      const out1 = await st();
      check('A11Y-6 走出最后一个菜单项（Tab）：菜单关闭（aria-expanded="false"、hidden），焦点不在菜单内、不在触发按钮上（不抢焦点）、没有落回 body', out1.exp === 'false' && out1.hidden === true && !out1.inMenu && !out1.onTrigger && !out1.onBody, out1);
      // Shift+Tab 从触发按钮往回走出去
      await focusB(page, MENU);
      await page.keyboard.press('Enter');
      const o1 = await st();
      await page.keyboard.press('Shift+Tab');
      const out2 = await st();
      check('A11Y-6 菜单打开时在触发按钮上按 Shift+Tab（走到触发按钮之前的元素）：菜单关闭，焦点不在触发按钮上', o1.exp === 'true' && out2.exp === 'false' && out2.hidden === true && !out2.onTrigger && !out2.onBody, { o1, out2 });
      // 触发按钮 → 第一个菜单项（Tab）不关
      await focusB(page, MENU);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      const in1 = await st();
      check('A11Y-6 触发按钮 → 第一个菜单项（Tab）：焦点进入菜单，菜单不关', in1.inMenu && in1.exp === 'true' && in1.hidden === false, in1);
      // 预筛修复 LOW-1：补两个方向
      // 步骤一：焦点在菜单第一项时 Shift+Tab → 焦点回到触发按钮，菜单仍开（触发按钮是菜单自己的触发按钮，不算「走出去」）
      await page.keyboard.press('Shift+Tab');
      const back1 = await st();
      check('A11Y-6 步骤一：焦点在菜单第一项时 Shift+Tab → 焦点回到触发按钮，菜单仍开（aria-expanded="true"、菜单不 hidden）', in1.inMenu && back1.onTrigger && back1.exp === 'true' && back1.hidden === false, { in1, back1 });
      // 步骤二：焦点在菜单项时点击触发按钮 → 结束态菜单关闭（focusin 落在触发按钮上不关，随后的 click 才把它翻成关闭；不能是 focusin 关了又被 click 重新打开）
      await page.keyboard.press('Tab');
      const in1b = await st();
      await clickB(page, MENU);
      const clk1 = await st();
      check('A11Y-6 步骤二：焦点在菜单项上时点击触发按钮 → 结束态菜单关闭（aria-expanded="false"、hidden）', in1b.inMenu && in1b.exp === 'true' && clk1.exp === 'false' && clk1.hidden === true, { in1b, clk1 });
      // 为下面的 Esc 检查恢复现场：键盘重新打开菜单，焦点移到第一项
      await focusB(page, MENU);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      // Esc：只关菜单，焦点回到触发按钮，抽屉不动
      await page.keyboard.press('Escape');
      const esc1 = await st();
      check('A11Y-6 菜单打开且焦点在菜单项上按 Esc：菜单关闭（aria-expanded="false"）、焦点回到触发按钮、抽屉没有被打开', esc1.exp === 'false' && esc1.hidden === true && esc1.onTrigger && esc1.drawer === false, esc1);
      // 抽屉打开时 Esc 关抽屉
      await clickB(page, '#modelListBody [data-id="50"] .catalog-row2 .catalog-id');
      await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
      await page.keyboard.press('Escape');
      const dr1 = await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT }).then(() => true, () => false);
      check('A11Y-6 抽屉打开（没有菜单）时按 Esc：抽屉关闭', dr1);
      // 抽屉与菜单同时打开：第一次 Esc 只关菜单、抽屉保持；第二次 Esc 关抽屉
      await clickB(page, '#modelListBody [data-id="50"] .catalog-row2 .catalog-id');
      await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
      await page.evaluate(() => catalogToggleMenu(document.querySelector('#modelListBody [data-id="50"] [data-menu="more"]')));
      const both0 = await st();
      await page.keyboard.press('Escape');
      const both1 = await st();
      await page.keyboard.press('Escape');
      const both2 = await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT }).then(() => true, () => false);
      check('A11Y-6 抽屉与菜单同时打开：第一次 Esc 只关菜单（aria-expanded="false"）、抽屉仍是 open；第二次 Esc 关抽屉', both0.exp === 'true' && both0.drawer === true && both1.exp === 'false' && both1.hidden === true && both1.drawer === true && both2 === true, { both0, both1, both2 });
      await page.close();
    });

    console.log('W91 A11Y-7 展开面板失败态的重试');
    await segGuard('W91', async () => {
      const REL91 = { upstream: [], downstream: [], objects: [], objectState: 'standard' };
      let mode = 'fail'; let n55 = 0;
      expectErr('W91', U_REL);
      const { page } = await open(adminN, 'W91', '', { beforeGoto: async (pg) => { await pg.route(/\/api\/models\/55\/relations(\?.*)?$/, (route) => { n55++; if (mode === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"桩"}' }); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REL91) }); }); } });
      await focusB(page, '#modelListBody [data-id="55"] [data-expand-toggle]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#modelListBody [data-id="55"] > .pane.catalog-pane-error', { timeout: WAIT });
      const r0 = await page.evaluate(() => { const b = document.querySelector('#modelListBody [data-id="55"] .catalog-pane-retry'); if (!b) return { tag: null, type: null, tab: -1, disabled: true, missing: true }; return { tag: b.tagName, type: b.getAttribute('type'), tab: b.tabIndex, disabled: b.disabled }; });
      check('A11Y-7 展开失败：面板里的「重试」是 button[type=button]、未禁用、tabIndex ≥ 0', r0.tag === 'BUTTON' && r0.type === 'button' && r0.tab >= 0 && r0.disabled === false, r0);
      let hit = false;
      for (let i = 0; i < 40 && !hit; i++) { await page.keyboard.press('Tab'); hit = await page.evaluate(() => document.activeElement.classList.contains('catalog-pane-retry') && !!document.activeElement.closest('[data-id="55"]')); }
      check('A11Y-7 从展开按钮出发按 Tab（≤ 40 次）能走到该条目面板里的「重试」', hit);
      const req0 = n55; mode = 'ok';
      await page.keyboard.press('Enter');
      const loaded = await page.waitForSelector('#modelListBody [data-id="55"] > .pane.catalog-pane-loaded', { timeout: WAIT }).then(() => true, () => false);
      check('A11Y-7 焦点在「重试」上按回车：恰多发 1 次 /models/55/relations 请求，面板变为已加载（重试成功）', hit && loaded && n55 === req0 + 1, { req0, n55, loaded });
      await page.close();
    });

    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-head-role-row（列头带回 role=row） / w86-group-no-role（组包装去 listitem） / w86-empty-no-role（空态去 listitem）
    console.log('W92 LOW-9 列头与列表角色');
    await segGuard('W92', async () => {
      const { page } = await open(adminN, 'W92', '');
      const roles = () => page.evaluate(() => { const list = document.getElementById('modelListBody'); const kids = Array.from(list.children); return { listTag: list.tagName, listRole: list.getAttribute('role'), nKids: kids.length, kidsOk: kids.every((c) => c.getAttribute('role') === 'listitem'), groups: kids.filter((c) => c.hasAttribute('data-group')).length, items: document.querySelectorAll('[role="listitem"]').length, nested: Array.from(document.querySelectorAll('[role="listitem"]')).filter((e) => e.parentElement !== list).length, headRole: ((x) => (x ? x.getAttribute('role') : 'missing'))(document.querySelector('.catalog-head')), rowCol: document.querySelectorAll('[role="row"], [role="columnheader"]').length, opHeader: !!document.getElementById('modelListOpHeader') }; });
      const r0 = await roles();
      check('LOW-9 列表：#modelListBody 仍是 div[role="list"]；每个直接子元素（组包装 [data-group]，共 ' + r0.nKids + ' 个）都是 role="listitem"，全页 listitem 恰这些、没有嵌套的', r0.listTag === 'DIV' && r0.listRole === 'list' && r0.nKids >= 20 && r0.kidsOk && r0.groups === r0.nKids && r0.items === r0.nKids && r0.nested === 0, r0);
      check('LOW-9 列头：div.catalog-head 没有 role 属性，全页没有 role="row" / role="columnheader"；#modelListOpHeader 仍在', r0.headRole === null && r0.rowCol === 0 && r0.opHeader, r0);
      await page.fill('#searchKeyword', 'zzz_no_such_model_zzz', { timeout: 3000 });
      const r1 = await roles();
      const emp = await page.evaluate(() => Array.from(document.getElementById('modelListBody').children).map((c) => c.className + '|' + c.getAttribute('role') + '|' + c.textContent));
      check('LOW-9 空态：搜索无结果时列表只有一个子元素「暂无模型数据」，它也是 role="listitem"', r1.nKids === 1 && r1.kidsOk && J(emp) === J(['catalog-empty|listitem|暂无模型数据']), emp);
      await page.close();
    });

    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-clear-no-focus（清除后不移焦点）
    console.log('W93 P40 点「清除 N 项」后焦点到「全部模型」');
    await segGuard('W93', async () => {
      const { page } = await open(adminN, 'W93', '');
      const foc = () => page.evaluate(() => { const a = document.activeElement; return { rail: a && a.getAttribute ? a.getAttribute('data-rail') : null, body: a === document.body, head: ((x) => (x ? x.textContent : null))(document.querySelector('#catalogRail .catalog-rail-head')) }; });
      await clickB(page, '#catalogRail [data-rail="layer:DIM"]');
      await clickB(page, '#catalogRail [data-catalog-act="rail-clear"]');
      const f1 = await foc();
      check('P40 鼠标点「清除 1 项」：焦点在左栏「全部模型」（data-rail="view:"）上，不在 body；头部变回「筛选全部」', f1.rail === 'view:' && !f1.body && f1.head === '筛选全部', f1);
      await page.evaluate(() => { catalogRailPick('layer:DIM'); catalogRailPick('status:ONLINE'); });
      check('P40 前置：两个筛选生效，头部按钮是「清除 2 项」', (await page.locator('#catalogRail .catalog-rail-clear').textContent({ timeout: 3000 })) === '清除 2 项');
      await focusB(page, '#catalogRail .catalog-rail-clear');
      await page.keyboard.press('Enter');
      const f2 = await foc();
      check('P40 键盘聚焦「清除 2 项」按回车：焦点在「全部模型」上、不在 body；两个筛选都清掉', f2.rail === 'view:' && !f2.body && f2.head === '筛选全部' && (await page.evaluate(() => Object.values(catalogFilters).filter((v) => v !== '' && v !== null && v !== undefined).length)) === 0, f2);
      await page.setViewportSize({ width: 390, height: 900 });
      await page.evaluate(() => { catalogRailPick('layer:DIM'); catalogToggleRail(); });
      await focusB(page, '#catalogRail .catalog-rail-clear');
      await page.keyboard.press('Enter');
      const f3 = await foc();
      const vis3 = await page.evaluate(() => { const x = document.querySelector('#catalogRail [data-rail="view:"]'); return !!x && x.getClientRects().length > 0; });
      check('P40 390 宽、折叠按钮展开态：键盘清除后焦点在可见的「全部模型」上', f3.rail === 'view:' && !f3.body && vis3, { f3, vis3 });
      await page.close();
    });

    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-highlight-no-exit（highlightModel 不先退出未归属模式）
    console.log('W94 ⑤ ?id=X / dev=1 高亮定位先退出未归属模式');
    await segGuard('W94', async () => {
      for (const [label, query, id] of [['W94a', '?id=65', 65], ['W94b', '?id=101&dev=1', 101]]) {
        const un = { n: 0 }; const g = gate(); let hit = 0;
        const { page } = await open(adminN, label, query, { noRows: true, noIdle: true, beforeGoto: both(unRoute(un, async () => ({ json: UN_ROWS })), async (pg) => { await pg.route(isList, async (route) => { if (route.request().method() !== 'GET') return route.continue(); hit++; await g.p; return route.continue(); }); }) });
        check(`${label} 前置：首次列表请求已到达路由（被扣住），未归属计数「5」`, (await untilTrue(() => hit >= 1)) && (await waitUnCount(page, '5')));
        await clickB(page, '#catalogRailUnowned');
        check(`${label} 前置：进入未归属模式（入口 aria-pressed="true"、面板可见、表格 5 行）；列表数据还没到`, (await unBtn(page)).pressed === 'true' && (await unPanel(page)).vis === true && (await waitUnRows(page, 5)) && (await domIds(page)).length === 0);
        g.release();
        const hl = await page.waitForSelector(`#modelListBody [data-id="${id}"][data-focus-highlight]`, { state: 'attached', timeout: WAIT }).then(() => true, () => false);
        const lp = await listParts(page); const p = await unPanel(page); const b = await unBtn(page);
        check(`${label} 放行列表后 highlightModel 先退出未归属模式：面板隐藏、入口 aria-pressed="false"、列表体 / 工具条 / 分页可见；目标 #${id} 在列表里可见且带高亮属性`, hl && p.vis === false && b.pressed === 'false' && lp.body && lp.toolbar && lp.pager && (await page.locator(`#modelListBody [data-id="${id}"]`).first().isVisible()), { hl, p: p.vis, b, lp });
        await page.close();
      }
    });

    // ===== W95–W97 C4d 预筛修复批：LOW-3 窄列余量与 title / LOW-4 返回焦点回退 / LOW-5 验收摘要只算一次 =====
    // W95 锁的是：①1440 下状态格 / 负责人格的 title 等于完整文字（状态显示文字；映射外原值原样；负责人全名；无负责人「-」不加 title），390 下第二行容器里的徽章与负责人同口径；
    //   ②768 / 1024（≤1024 档最近验收列 132px）以及 1025 / 1440 下，带「◐ 缺数据验收 / 缺结构验收 + MM-DD」的条目最近验收格 scrollWidth ≤ clientWidth（不截断日期）；
    // W96：≤640 左栏收起时「返回模型列表」把焦点放到折叠按钮（原入口在 display:none 祖先下，focus() 静默失败落回 body）；左栏展开时仍回到 #catalogRailUnowned；
    // W97：验收摘要无法识别的条目，一次渲染只出现 1 条 warn（首行与第二行容器共用一份结果）。
    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w82-acc-124（≤1024 最近验收列改回 124px） / w82-status-no-title（首行状态格去 title） / w82-badge-no-title（状态徽章去 title）
    //   w82-owner-no-title（首行负责人格去 title） / w82-owner-m-no-title（第二行负责人去 title） / w95-date-hidden（日期节点隐藏） / w95-date-clip（日期节点固定 20px 裁剪）
    console.log('W95 LOW-3 状态 / 负责人格 title 与最近验收列余量');
    await segGuard('W95', async () => {
      const acc95 = (state, at, extra) => Object.assign({ state, at, rows: 1, stages: { structure: 'pass', data: 'pass' }, prevResult: null }, extra || {});
      const OWN95 = '欧阳娜娜诸葛孔明司马懿';
      const P95 = {
        60: { status: 'ARCHIVED', tech_owner: OWN95 },
        50: { tech_owner: '' },
        55: { status: 'ONLINE' },
        58: { acceptance: acc95('partial', '2026-03-07 10:00:00', { stages: { structure: 'pass', data: null } }) },
        62: { acceptance: acc95('partial', '2026-03-08 10:00:00', { stages: { structure: null, data: 'pass' } }) },
      };
      const settle95 = (pg) => pageEvalBounded(pg, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      const { page } = await open(adminN, 'W95', '', { beforeGoto: rewriteList(patchRows(P95)) });
      await page.setViewportSize({ width: 1440, height: 900 }); await settle95(page);
      const T95 = await page.evaluate(() => { const o = {}; ['60', '50', '55'].forEach((id) => { const e = document.querySelector('#modelListBody [data-id="' + id + '"]'); const st = e && e.querySelector('.catalog-row1 > .catalog-status'); const ow = e && e.querySelector('.catalog-row1 > .catalog-owner'); const bg = st && st.querySelector('.u-status-badge'); if (!st || !ow || !bg) { o[id] = { missing: true }; return; } o[id] = { stText: st.textContent, stTitle: st.title, badgeTitle: bg.title, owText: ow.textContent, owTitle: ow.title }; }); return o; });
      check('W95 1440：#60（状态 ARCHIVED，映射外原值）状态格 title 与徽章 title 都是「ARCHIVED」，负责人格 title 是完整全名「' + OWN95 + '」', T95[60].stText === 'ARCHIVED' && T95[60].stTitle === 'ARCHIVED' && T95[60].badgeTitle === 'ARCHIVED' && T95[60].owText === OWN95 && T95[60].owTitle === OWN95, T95[60]);
      check('W95 1440：#55（ONLINE → 已上线）状态格 title「已上线」；#50 无负责人（显示「-」）不加 title', T95[55].stText === '已上线' && T95[55].stTitle === '已上线' && T95[55].badgeTitle === '已上线' && T95[50].owText === '-' && T95[50].owTitle === '', { t55: T95[55], t50: T95[50] });
      for (const w of [768, 1024, 1025, 1440]) {
        await page.setViewportSize({ width: w, height: 900 }); await settle95(page);
        const A = await page.evaluate(() => { const o = {}; ['58', '62'].forEach((id) => { const c = document.querySelector('#modelListBody [data-id="' + id + '"] .catalog-row1 > .catalog-acc'); if (!c) { o[id] = { text: '', sw: 0, cw: 0, missing: true }; return; } o[id] = { text: c.textContent, sw: c.scrollWidth, cw: c.clientWidth }; }); return o; });
        check(`W95 ${w}：#58「◐ 缺数据验收 03-07」/ #62「◐ 缺结构验收 03-08」的最近验收格 scrollWidth ≤ clientWidth（日期不被截断；格宽 ≥ 132）`, A[58].text.indexOf('◐ 缺数据验收') === 0 && A[58].text.indexOf('03-07') > 0 && A[62].text.indexOf('◐ 缺结构验收') === 0 && A[62].text.indexOf('03-08') > 0 && A[58].sw <= A[58].cw && A[62].sw <= A[62].cw && A[58].cw >= 131.5, A);
        // 42Tb-M2：日期节点自己的可见性 / 尺寸 / 不溢出 / 不越出验收格（父格 textContent 与 scrollWidth 挡不住「日期被隐藏」或「日期被固定宽度子节点截断」）；用 Range 量日期文本矩形
        const D95 = await page.evaluate(() => { const o = {}; ['58', '62'].forEach((id) => { const c = document.querySelector('#modelListBody [data-id="' + id + '"] .catalog-row1 > .catalog-acc'); const d = c && c.querySelector('.catalog-acc-date'); if (!d) { o[id] = { missing: true }; return; } const cs = getComputedStyle(d); const dr = d.getBoundingClientRect(); const cr = c.getBoundingClientRect(); const rg = document.createRange(); rg.selectNodeContents(d); const tr = rg.getBoundingClientRect(); o[id] = { text: d.textContent, disp: cs.display, vis: cs.visibility, w: Math.round(dr.width * 10) / 10, h: Math.round(dr.height * 10) / 10, sw: d.scrollWidth, cw: d.clientWidth, dRight: Math.round(dr.right * 10) / 10, tRight: Math.round(tr.right * 10) / 10, tW: Math.round(tr.width * 10) / 10, cRight: Math.round(cr.right * 10) / 10 }; }); return o; });
        const dateOk = (x, want) => !!x && !x.missing && x.text === want && x.disp !== 'none' && x.vis === 'visible' && x.w > 0 && x.h > 0 && x.sw <= x.cw + 1 && x.tW <= x.w + 0.5 && x.dRight <= x.cRight + 0.5 && x.tRight <= x.cRight + 0.5;
        check(`W95 ${w}：#58「03-07」/ #62「03-08」的日期节点（.catalog-acc-date）自己可见（display ≠ none、visibility = visible）、宽高 > 0、不溢出（scrollWidth ≤ clientWidth + 1、文本矩形宽 ≤ 节点宽）、右沿 ≤ 最近验收格右沿 + 0.5`, dateOk(D95[58], '03-07') && dateOk(D95[62], '03-08'), D95);
      }
      await page.setViewportSize({ width: 390, height: 900 }); await settle95(page);
      const M95 = await page.evaluate(() => { const o = {}; ['60', '50'].forEach((id) => { const m = document.querySelector('#modelListBody [data-id="' + id + '"] .catalog-mobile-meta'); const bg = m && m.querySelector('.u-status-badge'); const ow = m && m.querySelector('.catalog-owner-m'); if (!bg || !ow) { o[id] = { missing: true }; return; } o[id] = { badgeTitle: bg.title, ownText: ow.textContent, ownTitle: ow.title }; }); return o; });
      check('W95 390：第二行容器里 #60 的状态徽章 title「ARCHIVED」、负责人 title 是全名；#50 无负责人「-」不加 title（与首行同口径）', M95[60].badgeTitle === 'ARCHIVED' && M95[60].ownText === OWN95 && M95[60].ownTitle === OWN95 && M95[50].ownText === '-' && M95[50].ownTitle === '', M95);
      await page.close();
    });

    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w86-leave-no-toggle-fallback（W96）
    console.log('W96 LOW-4 ≤640 左栏收起时「返回模型列表」的焦点');
    await segGuard('W96', async () => {
      const ROWS96 = [
        { id: 961, obj_type: 'PROC', schema_name: 'dbo', obj_name: 'usp_w96a', summary: '摘要甲', verified_at: '2026-03-01 08:00:00', badges: { doc: 'consistent', reg: 'consistent' } },
        { id: 962, obj_type: 'VIEW', schema_name: null, obj_name: 'v_w96b', summary: '摘要乙', verified_at: null, badges: { doc: null, reg: null } },
      ];
      const un = { n: 0 };
      const { page } = await open(adminN, 'W96', '', { beforeGoto: both(unRoute(un, async () => ({ json: ROWS96 })), async (pg) => { await pg.setViewportSize({ width: 390, height: 900 }); }) });
      // 点击一律有界：元素 3 秒内不可见 / 点不到 = 记一条失败并返回 false，依赖它的后续点击跳过（不等默认 30 秒、不抛异常崩掉用例）
      const clk96 = async (sel, label) => { try { await page.locator(sel).first().waitFor({ state: 'visible', timeout: 3000 }); await clickC(page, sel, { timeout: 3000 }); return true; } catch (e) { check(label + '：可点击（点不到 = 判红）', false, String(e && e.message).split(String.fromCharCode(10))[0]); return false; } };
      const act96 = () => page.evaluate(() => { const a = document.activeElement; const un0 = document.getElementById('catalogRailUnowned'); return { onBody: a === document.body, onToggle: !!a && a.classList.contains('catalog-rail-toggle'), onUnowned: !!a && a.id === 'catalogRailUnowned', tag: a ? a.tagName + '#' + a.id + '.' + String(a.className).split(' ')[0] : null, unShown: !!un0 && un0.getClientRects().length > 0, mode: document.getElementById('modelListSection').classList.contains('is-unowned') }; });
      check('W96 前置：390 打开、未归属对象 2 行已到达', await waitUnCount(page, '2'));
      // 对照：左栏展开时返回 → 焦点仍在 #catalogRailUnowned
      let ok96 = await clk96('.catalog-rail-toggle', 'W96 点折叠按钮（展开）');
      if (ok96) ok96 = await clk96('#catalogRailUnowned', 'W96 点未归属入口（进入模式）');
      check('W96 前置：进入未归属模式（表格 2 行）', await waitUnRows(page, 2));
      if (ok96) ok96 = await clk96('#catalogUnownedPanel [data-catalog-act="unowned-back"]', 'W96 点「返回模型列表」（左栏展开）');
      const a1 = await act96();
      check('W96 对照：左栏展开时点「返回模型列表」→ 已退出未归属模式，焦点回到左栏入口 #catalogRailUnowned（不是 body）', a1.unShown && !a1.mode && a1.onUnowned && !a1.onBody, a1);
      // 目标场景：展开左栏 → 进入未归属模式 → 收起左栏 → 点「返回模型列表」
      if (ok96) ok96 = await clk96('#catalogRailUnowned', 'W96 点未归属入口（再次进入模式）');
      check('W96 前置：再次进入未归属模式', await waitUnRows(page, 2));
      if (ok96) ok96 = await clk96('.catalog-rail-toggle', 'W96 点折叠按钮（收起）');
      const pre = await act96();
      check('W96 前置：左栏已收起（#catalogRailUnowned 没有盒子）、仍在未归属模式', !pre.unShown && pre.mode, pre);
      if (ok96) ok96 = await clk96('#catalogUnownedPanel [data-catalog-act="unowned-back"]', 'W96 点「返回模型列表」（左栏收起）');
      const a2 = await act96();
      check('W96 ≤640 左栏收起时点「返回模型列表」→ 已退出未归属模式，document.activeElement 是左栏折叠按钮 .catalog-rail-toggle（不是 body）', !a2.mode && a2.onToggle && !a2.onBody, a2);
      await page.close();
    });

    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w82-acc-twice（第二行容器验收摘要再算一次）
    console.log('W97 LOW-5 验收摘要无法识别：一次渲染只记 1 条 warn');
    await segGuard('W97', async () => {
      const msgs97 = [];
      const settle97 = (pg) => pageEvalBounded(pg, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      const { page } = await open(adminN, 'W97', '', { beforeGoto: async (pg) => { pg.on('console', (m) => msgs97.push([m.type(), m.text()])); await rewriteList(patchRows({ 103: { acceptance: { state: 'bogus', at: null } } }))(pg); } });
      for (const w of [1440, 390]) {
        await page.setViewportSize({ width: w, height: 900 }); await settle97(page);
        msgs97.length = 0;
        await page.evaluate(() => { renderModelsPage(); });
        await settle97(page);
        const warnsAll = msgs97.filter((m) => m[0] === 'warning' && /验收摘要无法识别/.test(m[1]));
        const warns103 = warnsAll.filter((m) => /验收摘要无法识别（模型 103）/.test(m[1]));
        const titles = await page.evaluate(() => { const e = document.querySelector('#modelListBody [data-id="103"]'); const a1 = e && e.querySelector('.catalog-row1 > .catalog-acc'); const a2 = e && e.querySelector('.catalog-mobile-meta .catalog-acc-m'); return { row1: a1 ? a1.title : null, mobile: a2 ? a2.title : null }; });
        check(`W97 ${w}：#103 验收摘要无法识别——重画一次列表，「验收摘要无法识别（模型 103）」warn 恰 1 条（全部同类 warn 也恰 1 条）；首行与第二行容器的验收格都带 title「验收摘要无法识别」`, warns103.length === 1 && warnsAll.length === 1 && titles.row1 === '验收摘要无法识别' && titles.mobile === '验收摘要无法识别', { n103: warns103.length, nAll: warnsAll.length, titles });
      }
      await page.close();
    });

    // ===== W98 第二行长字符串不越界（codex 42-M1 + fix42b MED-1 / MED-2 / LOW-1）=====
    // 路由替身构造（不改共享夹具）：#50 负责人 = 40 个连续拉丁字符；#55 业务域 = 映射外的长代码；#58 状态 = 映射外的 40 字符长值；#62 三者同时长；
    //   伴生 #53 = 映射外长状态值 + 映射内长业务域（域名接口返回 22 个汉字的名称）；#65 = 映射内长业务域；#60 业务域空串（「未设置」）。
    // 宽度矩阵 320 / 360 / 390 / 640 / 641 / 768 / 1025（≤640 核第二行与第二行元数据容器；>640 核第二行）。每个宽度、每种业务域状态（映射到达前显示代码 / 到达后显示名称）都核：
    //   ①第二行与元数据容器的全部可见子项右沿 ≤ 各自容器右沿 + 0.5、容器不越出条目、条目不越出列表区；②整页（documentElement）与列表区（#modelListSection / #modelListBody）无横向滚动；
    //   ③前提：长业务域元素真的被截断（scrollWidth > clientWidth），否则这个宽度没有判别力。业务域 title 在映射到达前（= 代码）与到达后（= 名称）都等于当时的完整显示文字；空值「未设置」不加 title。
    // 页内变异（首红落在本段；逐个变异的首红见 fix42b 报告 §变异首红表与 mutlogs/sweep_*.log）：w98-owner-m-no-constraint（删 owner-m 约束） / w98-badge-no-constraint（删 .catalog-status-m 约束）
    //   w98-domain-no-constraint（删基础层 .catalog-domain 收缩规则） / w98-meta-no-min0（元数据容器去 min-width:0） / w98-badge-out-of-wrap（徽章挪出包装层） / w98-domain-no-title（首次渲染不写 title）
    //   w98-domain-title-stale（映射到达后不同步 title） / w98-domain-unset-title（「未设置」也写 title）
    //   w98-domain-title-rawcode（首次渲染把原始代码写进 title：只有映射到达后重渲染那条分得出） / w98-impl-auto（.catalog-impl 改回 1 1 auto：「未设置」在 641 及以上被挤出省略号）
    console.log('W98 第二行长字符串不越界（长负责人 / 长状态 / 映射内外长业务域；320–1025）');
    await segGuard('W98', async () => {
      const LONGOWN = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn';
      const LONGDOM = 'dom_unmapped_long_code_xxxxxxxxxxxxxxxxxxxx';   // 映射外的长代码
      const MAPCODE = 'dom_long_mapped';
      const LONGNAME = '这是一个非常非常长的业务域名称用来测试省略号显示效果';   // 映射内的长名称（22 个汉字）
      const LONGST = 'STATUSSTATUSSTATUSSTATUSSTATUSSTATUSSTAT';
      const IDS98 = ['50', '53', '55', '58', '60', '62', '65'];
      const P98 = { 50: { tech_owner: LONGOWN }, 53: { status: LONGST, domain: MAPCODE }, 55: { domain: LONGDOM }, 58: { status: LONGST }, 60: { domain: '' }, 62: { tech_owner: LONGOWN, domain: LONGDOM, status: LONGST }, 65: { domain: MAPCODE } };
      const g98 = gate();   // 扣住 /api/domains：先在「代码」状态下量一轮，放行后在「名称」状态下再量一轮
      const domStub = async (pg) => { await pg.route(isDomains, async (route) => { await g98.p; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ code: MAPCODE, name: LONGNAME }]) }); }); };
      const settle98 = (pg) => pageEvalBounded(pg, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      const { page } = await open(adminN, 'W98', '', { noIdle: true, beforeGoto: both(rewriteList(patchRows(P98)), domStub) });
      /** 页内一次读完几何（缺节点记 missing，不抛异常） */
      const GEO98 = (ids) => {
        const R = (e) => e.getBoundingClientRect();
        const vis = (e) => { const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden' && e.getClientRects().length > 0; };
        const desc = (e) => e.tagName + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : '');
        const bad = []; const seen = {}; const dom = {};
        const sec = document.getElementById('modelListSection'); const body = document.getElementById('modelListBody');
        const sr = R(sec);
        ids.forEach((id) => {
          const en = document.querySelector('#modelListBody [data-id="' + id + '"]'); const row2 = en && en.querySelector('.catalog-row2'); const meta = en && en.querySelector('.catalog-mobile-meta'); const dm = en && en.querySelector('.catalog-domain');
          if (!en || !row2 || !meta || !dm) { seen[id] = { missing: true }; return; }
          const er = R(en);
          if (er.right > sr.right + 0.5) bad.push('#' + id + ' 条目右沿 ' + Math.round(er.right * 10) / 10 + ' > 列表区右沿 ' + Math.round(sr.right * 10) / 10);
          seen[id] = { meta: vis(meta), kids2: Array.from(row2.children).filter(vis).length, kidsM: Array.from(meta.children).filter(vis).length };
          dom[id] = { sw: dm.scrollWidth, cw: dm.clientWidth };
          [[row2, 'row2'], [meta, 'meta']].forEach(([box, nm]) => {
            if (!vis(box)) return;
            const br = R(box);
            if (br.right > er.right + 0.5) bad.push('#' + id + ' ' + nm + ' 容器右沿 ' + Math.round(br.right * 10) / 10 + ' > 条目右沿 ' + Math.round(er.right * 10) / 10);
            Array.from(box.children).filter(vis).forEach((k) => { const kr = R(k); if (kr.right > br.right + 0.5) bad.push('#' + id + ' ' + nm + ' > ' + desc(k) + ' 右沿 ' + Math.round(kr.right * 10) / 10 + ' > 容器右沿 ' + Math.round(br.right * 10) / 10); });
          });
        });
        const de = document.documentElement;
        return { bad, seen, dom, secSW: sec.scrollWidth, secCW: sec.clientWidth, bodySW: body.scrollWidth, bodyCW: body.clientWidth, docSW: de.scrollWidth, docCW: de.clientWidth, iw: window.innerWidth };
      };
      const TIT98 = (ids) => { const o = {}; ids.forEach((id) => { const e = document.querySelector('#modelListBody [data-id="' + id + '"] .catalog-domain'); o[id] = e ? { text: e.textContent, title: e.getAttribute('title') } : { missing: true }; }); return o; };
      const WIDTHS98 = [320, 360, 390, 640, 641, 768, 1025];
      check('W98 前提：映射内名称 ≥ 18 个汉字（' + LONGNAME.length + '）、映射外代码 ≥ 40 字符（' + LONGDOM.length + '）、长负责人 / 长状态 40 个连续拉丁字符', LONGNAME.length >= 18 && LONGDOM.length >= 40 && LONGOWN.length === 40 && LONGST.length === 40, { name: LONGNAME.length, dom: LONGDOM.length });
      const widthLoop98 = async (state) => {
        const tag = state === 'pre' ? '映射到达前（显示代码）' : '映射到达后（显示名称）';
        for (const w of WIDTHS98) {
          await page.setViewportSize({ width: w, height: 900 }); await settle98(page);
          const g = await page.evaluate(GEO98, IDS98);
          const seenOk = g.iw === w && IDS98.every((id) => g.seen[id] && !g.seen[id].missing && g.seen[id].kids2 >= 4 && (w <= 640 ? g.seen[id].meta && g.seen[id].kidsM >= 3 : !g.seen[id].meta));
          check(`W98 ${w} ${tag}：第二行${w <= 640 ? '与第二行元数据容器' : ''}的每个可见子项右沿 ≤ 各自容器右沿 + 0.5，容器不越出条目、条目不越出列表区（#50 #53 #55 #58 #60 #62 #65）；前提：${w <= 640 ? '元数据容器可见、两层子项都有' : '元数据容器不显示、第二行有 ≥ 4 个可见子项'}`, seenOk && g.bad.length === 0, { iw: g.iw, seen: g.seen, bad: g.bad.slice(0, 8) });
          check(`W98 ${w} ${tag}：整页无横向滚动（documentElement / #modelListSection / #modelListBody 的 scrollWidth ≤ clientWidth）`, g.docSW <= g.docCW && g.secSW <= g.secCW && g.bodySW <= g.bodyCW, { doc: [g.docSW, g.docCW], sec: [g.secSW, g.secCW], body: [g.bodySW, g.bodyCW] });
          const trunc = ['55', '62'].concat(state === 'post' ? ['53', '65'] : []).filter((id) => !(g.dom[id] && g.dom[id].sw > g.dom[id].cw));
          check(`W98 ${w} ${tag}：前提——长业务域元素真的被截断（scrollWidth > clientWidth：${state === 'post' ? '#55 #62 #53 #65' : '#55 #62'}），这个宽度才有判别力`, trunc.length === 0, { notTruncated: trunc, dom: g.dom });
          // fix42b 复看 LOW-2：.catalog-impl 基准 0 保护的就是短域——「未设置」在 641 及以上不被挤出省略号（改回 1 1 auto 时 641 / 768 / 1025 会被截）
          if (w >= 641) check(`W98 ${w} ${tag}：「未设置」（#60）完整显示不被截（scrollWidth ≤ clientWidth）`, !!g.dom['60'] && g.dom['60'].sw <= g.dom['60'].cw, g.dom['60']);
        }
      };
      const exp98 = (state) => ({ 53: state === 'pre' ? { text: MAPCODE, title: MAPCODE } : { text: LONGNAME, title: LONGNAME }, 55: { text: LONGDOM, title: LONGDOM }, 60: { text: '未设置', title: null }, 62: { text: LONGDOM, title: LONGDOM }, 65: state === 'pre' ? { text: MAPCODE, title: MAPCODE } : { text: LONGNAME, title: LONGNAME } });
      const pickT = (t, ids) => { const o = {}; ids.forEach((id) => { o[id] = t[id]; }); return o; };
      await widthLoop98('pre');
      const t98a = await page.evaluate(TIT98, IDS98);
      check('W98 映射到达前：业务域 title = 当时的完整显示文字（映射外长代码 #55 #62 = 代码；映射内但还没到达的 #53 #65 = 代码「' + MAPCODE + '」）；「未设置」（#60）不加 title', J(pickT(t98a, ['53', '55', '60', '62', '65'])) === J(exp98('pre')), t98a);
      g98.release();
      check('W98 前置：域名映射放行后 #65 的业务域文字变为完整名称（22 个汉字）', await waitDomain(page, 65, LONGNAME));
      await widthLoop98('post');
      const t98b = await page.evaluate(TIT98, IDS98);
      check('W98 映射到达后（就地改写）：业务域 title 同步 = 完整显示文字（#53 #65 = 名称；映射外长代码 #55 #62 不变；「未设置」#60 仍不加 title）', J(pickT(t98b, ['53', '55', '60', '62', '65'])) === J(exp98('post')), t98b);
      // fix42b 复看 MED-1：映射到达后再渲染一次（排序 / 筛选 / 翻页 / 重载都走 catalogBuildEntry 的首次渲染写入点）——就地改写那条分不出「首渲把原始代码写进 title」，这一条分得出
      check('W98 前置：映射到达后同步重渲染一次列表（renderModelsPage）', await page.evaluate(() => { renderModelsPage(); return document.querySelectorAll('#modelListBody [data-id] .catalog-domain').length > 0; }));
      const t98c = await page.evaluate(TIT98, IDS98);
      check('W98 映射到达后重渲染：业务域 title 仍 = 完整显示文字（首次渲染写入点与就地改写同口径：#53 #65 = 名称不是代码；映射外长代码 #55 #62；「未设置」#60 不加 title）', J(pickT(t98c, ['53', '55', '60', '62', '65'])) === J(exp98('post')), t98c);
      const OWN98 = await page.evaluate(() => { const o = document.querySelector('#modelListBody [data-id="50"] .catalog-owner-m'); return o ? { title: o.title, text: o.textContent } : { missing: true }; });
      check('W98 长负责人的 title 仍是完整全名（省略号只影响显示）', OWN98.title === LONGOWN && OWN98.text === LONGOWN, OWN98);
      await page.close();
    });

    // ===== W99 子批 C4e-a：配色 E 的页面级断言 ①②④ + 语义色保持（方案 v0.11 §7.1「页面级配色」，口径按 D-30 / D-31；一律读计算样式 getComputedStyle，不读类名或样式源码）=====
    // 它锁的是：①导航不变——模型中心页与 Task_Pool.html 的 .navbar 背景 / 下边框、未高亮导航项文字色、下拉菜单底色与边框（及 logo 标题 / 分隔线 / 头像 / 用户名四个读 accent·border·text 变量的部位）逐项相等，各页自身高亮项 = rgb(217, 119, 6)；
    //   html 与 body 上读不到本页的自定义属性（--c-link / --row-* / --rail-* / --drawer-head-* / --catalog-focus 为空，--color-accent 仍是平台 #d97706），main 与抽屉上读到 E 值（作用域 token 没挂在根上）；
    //   ②E 取值——body 底 rgb(241, 245, 249)；左栏底 rgb(30, 41, 59)、默认项字 rgb(226, 232, 240)、计数胶囊 rgb(51, 65, 85) / rgb(203, 213, 225)；选中项（layer:DIM）底 rgb(51, 65, 85)、字 rgb(199, 210, 254)、色条（::before）rgb(129, 140, 248)、胶囊 rgb(67, 56, 202)；
    //   列表表名 rgb(55, 48, 163)；分页当前页底 / 边框 rgb(79, 70, 229)、非当前页底白；「＋ 注册新模型」底 rgb(79, 70, 229) 字白、悬停 rgb(67, 56, 202)；条目悬停底 rgb(247, 248, 255)；⋯ 菜单项悬停底 rgb(238, 242, 255)；
    //   展开面板：血缘本模型底 rgb(238, 242, 255) 边 rgb(199, 210, 254)、本模型表名与关联模型链接 rgb(55, 48, 163)；抽屉头底 rgb(30, 41, 59) 字白、副标题 rgb(199, 210, 254)、遮罩与抽屉根上 --color-accent = #4f46e5；
    //   ④配置台不变——Model_Workbench.html 的 #registerBtn 在 ods / dim / dwd / ads 四层的计算底色与 C4e 改动前逐值相等（改前值在基点 465f7d18 上采集落盘：E:/tmp/mc77-c4/c4e/capture_before.json，下面四个期望值逐字取自它）；
    //   语义色保持——DIM 分层徽章、自定义标签、验收「有警告」文字、「需复验」胶囊仍是原琥珀值（各取一个元素），过度替换时判红。
    // 页内变异（首红落在本段；另有两个变异的首红在 W5 与 W54，登记在那两段上方）：w99-scope-root（作用域选择器列表改成 :root） / w99-scope-no-drawer（抽屉从作用域清单删去）
    //   w99-drawer-head-no-override（.u-drawer-header 显式覆盖删去） / w99-body-bg-missing（body 底色规则删去） / w99-body-var-leak（body 上多定义一个自定义属性） / w99-rail-bg-white（左栏底改回白） / w99-rail-on-amber（左栏选中项改回琥珀）
    //   w99-link-amber（表名改回 #92400e） / w99-register-secondary（注册新模型按钮不加 accent） / w99-flow-me-amber（血缘本模型改回琥珀） / w99-metable-amber（本模型表名改回琥珀） / w99-model-link-amber（关联模型链接改回琥珀）
    //   w99-menu-hover-amber（菜单项悬停改回琥珀） / w99-row-hover-amber（条目悬停改回琥珀） / w99-sub-amber（抽屉副标题改回 #fef3c7） / w99-wb-accent（配置台 DIM 层主按钮被配成 accent）
    //   w99-dim-badge-accent / w99-custom-tag-accent / w99-acc-warn-accent / w99-recheck-accent（四个语义色被过度替换成 accent）
    //   w99-selected-bar-missing（列表选中条目没有 inset 3px accent 色条） / w99-selected-bg-old（列表选中条目底色回 #ebf5ff）
    //   w100-drawer-head-no-override（抽屉头显式覆盖删去；定义在 w100 区，完整 W 里首红在 W99 ② 抽屉头） / w100-rail-bg-low-contrast（左栏底色改成 #818cf8；首红在 W99 ② 左栏底色）
    //   fix43 新增 8 个（首红在 W99）：w99-selected-lowspec（选中条目规则去掉 id 与 !important，悬停色压过选中底色） / w99-selected-hover-wins（悬停规则加 id 与 !important，压过选中底色） / w99-body-row-open-leak（body 上多定义本页独有的 --row-open）
    //   w99-body-shared-leak（body 上多定义共享 --color-border-strong，值 = E 值） / w99-root-rail-leak（html 上多定义 --rail-on-pill） / w99-bar-content-none（左栏选中项色条 content:none） / w99-bar-display-none（色条 display:none） / w99-bar-zero-height（色条高度 0）
    //   等价变异（不判红，不计入上面任何数字）：eq99-selected-no-important——只去掉选中条目规则的 !important：该规则选择器是 #modelListBody .selected-row（1,1,0），悬停规则 .catalog-entry:hover 是（0,2,0），id 选择器本来就赢，!important 在现状下是冗余的，所以这个变异与原版行为相同；派单要的「去掉 !important 判红」做不到，改用上面 w99-selected-lowspec / w99-selected-hover-wins 两个真能改变层叠结果的变异
    console.log('W99 C4e-a 配色 E 页面级断言（① 导航不变 / ② E 取值 / ④ 配置台不变）与语义色保持');
    await segGuard('W99', async () => {
      /** 读导航各部位计算样式（取自 C40 的 NAV_PROBE_FN；缺节点返回 null） */
      const NAV99 = (hiSel) => {
        const cs = (sel, props) => { const e = document.querySelector(sel); if (!e) return null; const s = getComputedStyle(e); return Object.fromEntries(props.map((p) => [p, s[p]])); };
        return {
          navbar: cs('.navbar', ['backgroundColor', 'borderBottomWidth', 'borderBottomStyle', 'borderBottomColor']),
          plainItem: cs('a.nav-item[href="/Data_Collab.html"]', ['color', 'fontWeight']),
          dropdownTrigger: cs('.nav-dropdown-trigger', ['color', 'fontWeight']),
          dropdownMenu: cs('.nav-dropdown-menu', ['backgroundColor', 'borderTopColor']),
          menuPlainItem: cs('.nav-dropdown-menu a[href="/Dashboard.html"]', ['color', 'fontWeight']),
          highlightItem: cs(hiSel, ['color', 'fontWeight']),
          navTitle: cs('.nav-title', ['backgroundColor', 'backgroundImage']),
          navDivider: cs('.nav-divider', ['backgroundColor']),
          avatar: cs('.avatar-circle', ['backgroundColor']),
          profileName: cs('.profile-name', ['color']),
        };
      };
      /** 连续两次读数相等才算稳定（头像 / 用户名由 app.js 异步渲染；有界，不稳定也返回最后一次） */
      const stable99 = async (pg, hiSel) => { let prev = null; let cur = null; for (let i = 0; i < 12; i++) { cur = await pg.evaluate(NAV99, hiSel); if (prev !== null && J(prev) === J(cur)) return cur; prev = cur; await pageEvalBounded(pg, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))); } return cur; };
      /** 读一个元素的若干计算属性（缺节点返回 { missing }；pseudo 非空时读伪元素） */
      const cs99 = (pg, sel, props, pseudo) => pg.evaluate(([s, ps, pse]) => { const e = document.querySelector(s); if (!e) return { missing: s }; const c = getComputedStyle(e, pse || null); return Object.fromEntries(ps.map((p) => [p, c[p]])); }, [sel, props, pseudo || '']);
      /** 等一个元素的计算属性到位（悬停 / 选中带 CSS 过渡；有界等待绑被断言元素本身，超时返回 false） */
      const waitCs99 = (pg, sel, prop, want) => pg.waitForFunction(([s, p, w]) => { const e = document.querySelector(s); return !!e && getComputedStyle(e)[p] === w; }, [sel, prop, want], { timeout: WAIT }).then(() => true, () => false);
      const ACC = 'rgb(79, 70, 229)', ACC_H = 'rgb(67, 56, 202)', ACC_SOFT = 'rgb(238, 242, 255)', ACC_LINE = 'rgb(199, 210, 254)', LINK = 'rgb(55, 48, 163)', SLATE = 'rgb(30, 41, 59)', SLATE_ON = 'rgb(51, 65, 85)', WHITE = 'rgb(255, 255, 255)', AMBER = 'rgb(217, 119, 6)';
      const acc99 = (state, at, extra) => Object.assign({ state, at, rows: 1, stages: { structure: 'pass', data: 'pass' }, prevResult: null }, extra || {});
      /** fix43 M2（43Tb-L1）：本页作用域 token 清单不手写，从页面 CSSOM 解析——作用域选择器块（含 main.workbench-container 与 #modelDrawerOverlay 的那条规则）+ .catalog-rail 规则（--rail-*）+ #catalogRail 规则（--catalog-focus 局部覆盖）里声明的全部自定义属性 */
      const PARSE99 = () => {
        const names = (pick) => { const set = new Set(); for (const sh of Array.from(document.styleSheets)) { let rules; try { rules = sh.cssRules; } catch (e) { continue; } for (const r of Array.from(rules)) { if (r.selectorText !== undefined && r.style && pick(r.selectorText)) { for (let i = 0; i < r.style.length; i++) { if (r.style[i].startsWith('--')) set.add(r.style[i]); } } } } return Array.from(set).sort(); };
        return { scope: names((s) => s.includes('main.workbench-container') && s.includes('#modelDrawerOverlay')), rail: names((s) => s === '.catalog-rail'), railId: names((s) => s === '#catalogRail') };
      };
      /** 读一组自定义属性在 html / body / nav.navbar / main.workbench-container 上的计算值（缺节点为 null） */
      const TOK99 = (names) => {
        const g = (el, n) => (el ? getComputedStyle(el).getPropertyValue(n).trim() : null);
        const els = { html: document.documentElement, body: document.body, nav: document.querySelector('nav.navbar'), main: document.querySelector('main.workbench-container') };
        const out = { hasNav: !!els.nav, hasMain: !!els.main };
        Object.keys(els).forEach((k) => { out[k] = {}; names.forEach((n) => { out[k][n] = g(els[k], n); }); });
        return out;
      };
      const P99 = { 50: { acceptance: acc99('warn', '2026-03-05 10:00:00') }, 65: { acceptance: acc99('stale', '2026-03-09 10:00:00', { prevResult: 'pass' }) } };
      const { page } = await open(adminN, 'W99', '', { beforeGoto: rewriteList(patchRows(P99)) });
      await page.setViewportSize({ width: 1440, height: 900 });
      const okAv = await page.waitForSelector('.avatar-circle', { timeout: WAIT }).then(() => true, () => false);
      check('W99 前提：模型中心页导航头像已渲染（app.js 按角色显隐导航跑完）', okAv);

      // ---------- ① 导航不变 ----------
      const MC_HI = '.nav-dropdown-menu a[href="/Model_Center.html"]', TP_HI = 'a.nav-item[href="/Task_Pool.html"]';
      const navMC = await stable99(page, MC_HI);
      const parsed99 = await page.evaluate(PARSE99);
      const allTok99 = Array.from(new Set([].concat(parsed99.scope, parsed99.rail, parsed99.railId))).sort();
      const sharedTok99 = allTok99.filter((n) => n.startsWith('--color-'));
      const onlyTok99 = allTok99.filter((n) => !n.startsWith('--color-'));
      const tokMC = await page.evaluate(TOK99, allTok99);
      const tp = await adminN.newPage();
      await tp.goto(`${BASE}/Task_Pool.html`, { waitUntil: 'load' });
      const okTp = await tp.waitForSelector('.avatar-circle', { timeout: WAIT }).then(() => true, () => false);
      check('W99 前提：Task_Pool.html 导航头像已渲染', okTp);
      const navTP = await stable99(tp, TP_HI);
      const tokTP = await tp.evaluate(TOK99, allTok99);   // 平台基线：没有本页作用域块的 Task_Pool.html 上同一批 token 的取值
      await tp.close();
      const KEYS_EQ = ['navbar', 'plainItem', 'dropdownMenu', 'menuPlainItem', 'navTitle', 'navDivider', 'avatar', 'profileName'];
      const nonNull = (n) => Object.keys(n).every((k) => n[k] !== null);
      check('W99 ① 前提：两页的导航探针每个部位都读到了元素（没有 null），.navbar 底色不是透明', nonNull(navMC) && nonNull(navTP) && !!navMC.navbar && navMC.navbar.backgroundColor !== 'rgba(0, 0, 0, 0)' && !!navTP.navbar && navTP.navbar.backgroundColor !== 'rgba(0, 0, 0, 0)', { mcNull: Object.keys(navMC).filter((k) => navMC[k] === null), tpNull: Object.keys(navTP).filter((k) => navTP[k] === null) });
      for (const k of KEYS_EQ) check('W99 ① 导航不变：' + k + ' 在模型中心页与 Task_Pool.html 上逐项相等（计算样式）', !!navMC[k] && !!navTP[k] && J(navMC[k]) === J(navTP[k]), { mc: navMC[k], tp: navTP[k] });
      check('W99 ① 各页自身高亮项颜色 = rgb(217, 119, 6)：模型中心页下拉菜单里的「模型中心」链接与下拉触发按钮、Task_Pool 的顶层「数仓任务池」', !!navMC.highlightItem && navMC.highlightItem.color === AMBER && !!navMC.dropdownTrigger && navMC.dropdownTrigger.color === AMBER && !!navTP.highlightItem && navTP.highlightItem.color === AMBER, { mcHi: navMC.highlightItem, mcTrig: navMC.dropdownTrigger, tpHi: navTP.highlightItem });
      check('W99 ① 导航里读 accent 的头像仍是平台琥珀 rgb(217, 119, 6)（作用域没把 --color-accent 带进导航）', !!navMC.avatar && navMC.avatar.backgroundColor === AMBER, navMC.avatar);
      const leak = await page.evaluate(() => {
        const g = (el, n) => getComputedStyle(el).getPropertyValue(n).trim();
        return { main: g(document.querySelector('main.workbench-container'), '--color-accent'), overlay: g(document.getElementById('modelDrawerOverlay'), '--color-accent'), drawer: g(document.getElementById('modelDetailDrawer'), '--color-accent') };
      });
      // fix43 M2（43Tb-L1）：作用域不外溢改用「全量 token 清单」——清单从页面 CSS 解析（PARSE99：作用域块 + .catalog-rail + #catalogRail 三处声明的全部自定义属性），不手写
      const diffTok99 = sharedTok99.filter((n) => tokMC.main[n] !== tokTP.html[n]);   // E 值（main 上读到的）与平台基线（Task_Pool html）不同的共享 token
      check('W99 ① 前提：作用域 token 清单从页面 CSS 解析到——作用域块 ≥ 20 个且含 --c-link / --row-hover / --row-sel / --drawer-head-bg / --catalog-focus / --color-accent；.catalog-rail 上 ≥ 12 个 --rail-* 且含 --rail-bg（#catalogRail 上的 --catalog-focus 局部覆盖归 W101 锁，本条不查）；nav.navbar 与 main 都存在；与平台基线不同的共享 --color-* 至少 5 个且含 --color-accent（否则下面两条是空断言）',
        parsed99.scope.length >= 20 && ['--c-link', '--row-hover', '--row-sel', '--drawer-head-bg', '--catalog-focus', '--color-accent'].every((n) => parsed99.scope.includes(n)) && parsed99.rail.length >= 12 && parsed99.rail.every((n) => n.startsWith('--rail-')) && parsed99.rail.includes('--rail-bg') && tokMC.hasNav && tokTP.hasNav && tokMC.hasMain && diffTok99.length >= 5 && diffTok99.includes('--color-accent'),
        { scope: parsed99.scope, rail: parsed99.rail, railId: parsed99.railId, hasNav: [tokMC.hasNav, tokTP.hasNav], hasMain: tokMC.hasMain, diffTok99 });
      const leakOnly99 = []; ['html', 'body', 'nav'].forEach((k) => onlyTok99.forEach((n) => { if (tokMC[k][n] !== '') leakOnly99.push(k + ' ' + n + '=' + tokMC[k][n]); }));
      check('W99 ① 作用域不外溢（本页独有 token）：清单里全部 ' + onlyTok99.length + ' 个非 --color-* 的自定义属性（--c-link / --row-* / --drawer-head-* / --rail-* / --catalog-focus 等，全量，由页面 CSS 解析得到）在 html、body、nav.navbar 上都读不到（为空）', onlyTok99.length >= 20 && leakOnly99.length === 0, { n: onlyTok99.length, leak: leakOnly99 });
      const leakShared99 = []; ['html', 'body', 'nav'].forEach((k) => sharedTok99.forEach((n) => { if (tokMC[k][n] !== tokTP.html[n]) leakShared99.push(k + ' ' + n + '=' + tokMC[k][n] + '（基线 ' + tokTP.html[n] + '）'); else if (diffTok99.includes(n) && tokMC[k][n] === tokMC.main[n]) leakShared99.push(k + ' ' + n + ' = E 值 ' + tokMC.main[n]); }));
      check('W99 ① 作用域不外溢（共享 token）：清单里全部 ' + sharedTok99.length + ' 个共享 --color-* 在 html、body、nav.navbar 上的取值都 = 平台基线（Task_Pool.html 的 html 上的取值），且与 E 值不同的那些（' + diffTok99.length + ' 个）都不等于 E 值；--color-accent 仍是平台 #d97706', leakShared99.length === 0 && tokMC.html['--color-accent'] === '#d97706' && tokMC.body['--color-accent'] === '#d97706' && tokMC.nav['--color-accent'] === '#d97706', { leak: leakShared99, accentHtml: tokMC.html['--color-accent'], accentBody: tokMC.body['--color-accent'], accentNav: tokMC.nav['--color-accent'] });
      check('W99 ① 作用域生效：main.workbench-container 上 --color-accent = #4f46e5、抽屉遮罩与抽屉根上同为 #4f46e5', leak.main === '#4f46e5' && leak.overlay === '#4f46e5' && leak.drawer === '#4f46e5', { main: leak.main, overlay: leak.overlay, drawer: leak.drawer });

      // ---------- ② E 取值：页面静态部分（第 1 页、无筛选）----------
      const body99 = await cs99(page, 'body', ['backgroundColor']);
      check('W99 ② body 底色（两侧留白）= rgb(241, 245, 249)（读 body 的 backgroundColor）', body99.backgroundColor === 'rgb(241, 245, 249)', body99);
      const rail99 = await cs99(page, '#catalogRail', ['backgroundColor']);
      check('W99 ② 左栏底色 = rgb(30, 41, 59)（读 #catalogRail 的 backgroundColor）', rail99.backgroundColor === SLATE, rail99);
      const itemOff = await cs99(page, '#catalogRail [data-rail="layer:ODS"]', ['color', 'backgroundColor']);
      const pillOff = await cs99(page, '#catalogRail [data-rail="layer:ODS"] .catalog-rail-n', ['backgroundColor', 'color']);
      check('W99 ② 左栏未选中项（layer:ODS）字色 rgb(226, 232, 240)、底透明；其计数胶囊底 rgb(51, 65, 85) 字 rgb(203, 213, 225)', itemOff.color === 'rgb(226, 232, 240)' && itemOff.backgroundColor === 'rgba(0, 0, 0, 0)' && pillOff.backgroundColor === SLATE_ON && pillOff.color === 'rgb(203, 213, 225)', { itemOff, pillOff });
      const nm = await cs99(page, '#modelListBody [data-id="60"] .model-open-btn', ['color']);
      check('W99 ② 列表表名色 = rgb(55, 48, 163)（读 #60 的 .model-open-btn 的 color）', nm.color === LINK, nm);
      const pgBtn99 = (t) => page.evaluate((txt) => { const b = Array.from(document.querySelectorAll('#paginationControls button')).find((x) => x.textContent.trim() === txt); if (!b) return { missing: txt }; const c = getComputedStyle(b); return { backgroundColor: c.backgroundColor, borderTopColor: c.borderTopColor }; }, t);
      const pg1 = await pgBtn99('1');
      const pg2 = await pgBtn99('2');
      check('W99 ② 分页当前页（第 1 页的按钮「1」）底色与边框 = accent rgb(79, 70, 229)；非当前页「2」底白（读两个按钮的计算样式）', pg1.backgroundColor === ACC && pg1.borderTopColor === ACC && pg2.backgroundColor === WHITE, { pg1, pg2 });
      const reg = await cs99(page, '#registerNewModelBtn', ['backgroundColor', 'color', 'borderTopColor']);
      check('W99 ② 列表主按钮「＋ 注册新模型」（#registerNewModelBtn）底色 = accent rgb(79, 70, 229)、字白、边框 accent', reg.backgroundColor === ACC && reg.color === WHITE && reg.borderTopColor === ACC, reg);
      await page.hover('#registerNewModelBtn');
      check('W99 ② 「＋ 注册新模型」悬停底色 = accent-hover rgb(67, 56, 202)（等计算样式到位，.btn-secondary 带 0.2s 过渡）', await waitCs99(page, '#registerNewModelBtn', 'backgroundColor', ACC_H), await cs99(page, '#registerNewModelBtn', ['backgroundColor']));
      await page.mouse.move(1, 1);
      const rowBase = await cs99(page, '#modelListBody [data-id="60"]', ['backgroundColor']);
      await page.hover('#modelListBody [data-id="60"] .catalog-row2');
      check('W99 ② 条目悬停底色 = --row-hover rgb(247, 248, 255)（前提：悬停前不是该色；读 #60 条目自身 backgroundColor，等 0.15s 过渡到位）', rowBase.backgroundColor !== 'rgb(247, 248, 255)' && (await waitCs99(page, '#modelListBody [data-id="60"]', 'backgroundColor', 'rgb(247, 248, 255)')), { rowBase, now: await cs99(page, '#modelListBody [data-id="60"]', ['backgroundColor']) });
      await page.mouse.move(1, 1);

      // ---------- ② E 取值：左栏选中项（点 layer:DIM）----------
      await railClick(page, 'layer:DIM');
      const onSel = '#catalogRail [data-rail="layer:DIM"]';
      const selOk = await page.waitForSelector(onSel + '.is-on:not(.is-def)', { timeout: WAIT }).then(() => true, () => false);
      check('W99 ② 前提：点 layer:DIM 后该项带 is-on 且不是默认项', selOk);
      check('W99 ② 左栏选中项底色 rgb(51, 65, 85)（等过渡到位；读该按钮自身 backgroundColor）', await waitCs99(page, onSel, 'backgroundColor', SLATE_ON), await cs99(page, onSel, ['backgroundColor']));
      const sel99 = await cs99(page, onSel, ['color', 'fontWeight']);
      const bar99 = await cs99(page, onSel, ['backgroundColor', 'width'], '::before');
      const selPill = await cs99(page, onSel + ' .catalog-rail-n', ['backgroundColor', 'color']);
      check('W99 ② 左栏选中项字 rgb(199, 210, 254)、色条（::before）底 rgb(129, 140, 248) 宽 3px、胶囊底 rgb(67, 56, 202) 字 rgb(199, 210, 254)', sel99.color === ACC_LINE && bar99.backgroundColor === 'rgb(129, 140, 248)' && bar99.width === '3px' && selPill.backgroundColor === ACC_H && selPill.color === ACC_LINE, { sel99, bar99, selPill });

      // fix43 L2（43Tb-L2）：色条真的画出来——底色与宽度读对了不等于画得出来（content:none / display:none / 零高度时底色与 3px 宽度读数仍可能不变）
      const barPaint = await cs99(page, onSel, ['content', 'display', 'visibility', 'opacity', 'height', 'position'], '::before');
      check('W99 ② 左栏选中项色条（::before）真的画出来：content 不是 none / normal、display 不是 none、visibility = visible、opacity > 0、height > 0（读 layer:DIM 选中项 ::before 的计算样式）', !barPaint.missing && barPaint.content !== 'none' && barPaint.content !== 'normal' && barPaint.display !== 'none' && barPaint.visibility === 'visible' && Number(barPaint.opacity) > 0 && parseFloat(barPaint.height) > 0, barPaint);

      // ---------- 语义色保持（DIM 徽章 / 自定义标签 / 验收有警告 / 需复验）----------
      const sem = await page.evaluate(() => {
        const g = (sel, props) => { const e = document.querySelector(sel); if (!e) return { missing: sel }; const c = getComputedStyle(e); return Object.fromEntries(props.map((p) => [p, c[p]])); };
        return {
          dim: g('#modelListBody [data-id="60"] .catalog-layer-dim', ['backgroundColor', 'color', 'borderTopColor']),
          custom: g('#modelListBody [data-id="58"] .catalog-tag-custom', ['backgroundColor', 'color']),
          warn: g('#modelListBody [data-id="50"] .catalog-acc-warn', ['color']),
          recheck: g('#modelListBody [data-id="65"] .catalog-acc-recheck', ['backgroundColor', 'color']),
        };
      });
      const AMB_BG = 'rgb(254, 243, 199)', AMB_FG = 'rgb(180, 83, 9)', AMB_BD = 'rgb(252, 211, 77)';
      check('W99 语义色保持：DIM 分层徽章（#60 的 .catalog-layer-dim）底 rgb(254, 243, 199) 字 rgb(180, 83, 9) 边 rgb(252, 211, 77) 仍是原琥珀值', sem.dim.backgroundColor === AMB_BG && sem.dim.color === AMB_FG && sem.dim.borderTopColor === AMB_BD, sem.dim);
      check('W99 语义色保持：自定义标签（#58 的 .catalog-tag-custom）底 rgb(254, 243, 199) 字 rgb(180, 83, 9)', sem.custom.backgroundColor === AMB_BG && sem.custom.color === AMB_FG, sem.custom);
      check('W99 语义色保持：验收「有警告」（#50 的 .catalog-acc-warn）字 rgb(180, 83, 9)', sem.warn.color === AMB_FG, sem.warn);
      check('W99 语义色保持：需复验胶囊（#65 的 .catalog-acc-recheck）底 rgb(254, 243, 199) 字 rgb(180, 83, 9)', sem.recheck.backgroundColor === AMB_BG && sem.recheck.color === AMB_FG, sem.recheck);

      // ---------- ② E 取值：展开面板 ----------
      const REL99 = { upstream: [{ name: 'ods_w0001_df' }], downstream: [{ id: 55, table_name: 'dim_w0037', table_comment: '下游 55', layer: 'dim', status: 'ONLINE', config_mode: 'standard' }], objects: [], objectState: 'standard' };
      await routeRel(page, async () => ({ json: REL99 }));
      await toggleOf(page, 60);
      check('W99 前提：展开 #60 后面板 loaded', await waitPane(page, 60, 'loaded'));
      const paneSel = '#modelListBody [data-id="60"] > .pane.catalog-pane-loaded';
      const me = await cs99(page, paneSel + ' .catalog-flow-me', ['backgroundColor', 'borderTopColor']);
      const meT = await cs99(page, paneSel + ' .catalog-flow-metable', ['color']);
      const lk = await cs99(page, paneSel + ' .catalog-model-link', ['color']);
      check('W99 ② 血缘本模型（.catalog-flow-me）底 rgb(238, 242, 255) 边 rgb(199, 210, 254)；本模型表名（.catalog-flow-metable）与关联模型链接（.catalog-model-link，前提：面板里有该链接）字 rgb(55, 48, 163)', me.backgroundColor === ACC_SOFT && me.borderTopColor === ACC_LINE && meT.color === LINK && lk.color === LINK, { me, meT, lk });

      // ---------- ② E 取值：⋯ 菜单项悬停 ----------
      if (await clickB(page, '#modelListBody [data-id="60"] [data-menu="more"]', 'W99 点 #60 的 ⋯ 菜单触发按钮')) {
        const itemSel = '#catalog-menu-more-60 [data-act="etl"]';
        const dis = await page.evaluate((s) => { const e = document.querySelector(s); return e ? e.disabled : null; }, itemSel);
        const menuBase = await cs99(page, itemSel, ['backgroundColor']);
        await page.hover(itemSel);
        check('W99 ② ⋯ 菜单项悬停底色 = accent-soft rgb(238, 242, 255)（前提：菜单项存在且未禁用、悬停前底透明；读该菜单项自身 backgroundColor）', dis === false && menuBase.backgroundColor === 'rgba(0, 0, 0, 0)' && (await waitCs99(page, itemSel, 'backgroundColor', ACC_SOFT)), { dis, menuBase, now: await cs99(page, itemSel, ['backgroundColor']) });
        await page.mouse.move(1, 1);
        await page.keyboard.press('Escape');
      }

      // ---------- ② E 取值：列表选中条目（.selected-row；方案 §7.1 ②「选中行色条」，主会话裁定指列表选中条目，照 demo v0.4 :274 的 .item.sel）----------
      if (await clickB(page, '#modelListBody [data-id="60"] .catalog-row2', 'W99 点 #60 的第二行（选中该条目；随后用真实鼠标悬停回它，验证选中底色压过条目悬停色）')) {
        check('W99 ② 前提：点 #60 第二行后 #60 带 selected-row、全表只有它一个', await page.waitForSelector('#modelListBody [data-id="60"].selected-row', { timeout: WAIT }).then(() => true, () => false) && (await page.$$eval('#modelListBody .selected-row', (e) => e.length)) === 1);
        // fix43 M1（43Tb-M1）：点击可能打开详情抽屉 / 遮罩而夺走悬停——先收起（有界），移开鼠标，再用真实鼠标悬停回选中条目；等「selected-row 且 :hover 且底色 = --row-sel」同时成立，并把 :hover 写进断言
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT }).catch(() => {});
        await page.mouse.move(1, 1);
        await page.hover('#modelListBody [data-id="60"] .catalog-row2', { timeout: WAIT }).catch((e) => check('W99 悬停到 #60 的第二行：可悬停（悬停不了 = 判红）', false, String(e && e.message).split('\n')[0]));
        const selBg = await page.waitForFunction(() => { const e = document.querySelector('#modelListBody [data-id="60"]'); return !!e && e.classList.contains('selected-row') && e.matches(':hover') && getComputedStyle(e).backgroundColor === 'rgb(238, 240, 255)'; }, null, { timeout: WAIT }).then(() => true, () => false);
        const selState = await page.evaluate(() => { const e = document.querySelector('#modelListBody [data-id="60"]'); if (!e) return { missing: true }; const c = getComputedStyle(e); return { selected: e.classList.contains('selected-row'), hover: e.matches(':hover'), backgroundColor: c.backgroundColor, boxShadow: c.boxShadow }; });
        const selRow = selState;
        const othRow = await cs99(page, '#modelListBody [data-id="50"]', ['backgroundColor', 'boxShadow']);
        check('W99 ② 前提：读选中条目底色时 #60 同时是 selected-row 且 :hover（鼠标真悬停在它上；读 #60 条目自身 classList / matches(\':hover\')）', selState.selected === true && selState.hover === true, selState);
        check('W99 ② 列表选中条目（#60 .selected-row，且 :hover）底色 = --row-sel rgb(238, 240, 255)（压过悬停色 rgb(247, 248, 255)）、box-shadow 是 inset 3px accent 色条（含 rgb(79, 70, 229) 与 inset，偏移 3px 0px 0px 0px）（读该条目 backgroundColor / boxShadow；有界等 0.15s 过渡到位）', selBg && selRow.hover === true && selRow.backgroundColor === 'rgb(238, 240, 255)' && /rgb\(79, 70, 229\) 3px 0px 0px 0px inset/.test(selRow.boxShadow), selRow);
        check('W99 ② 另一个条目（#50 未选中）不带色条：box-shadow 不含 rgb(79, 70, 229)，底色不是 rgb(238, 240, 255)', othRow.boxShadow !== undefined && !String(othRow.boxShadow).includes('rgb(79, 70, 229)') && othRow.backgroundColor !== 'rgb(238, 240, 255)', othRow);
        await page.mouse.move(1, 1);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT }).catch(() => {});
      }

      // ---------- ② E 取值：抽屉 ----------
      await page.evaluate(() => openModelDrawer(60, document.querySelector('#modelListBody [data-id="60"] .model-open-btn')));
      const drOk = await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT }).then(() => true, () => false);
      check('W99 前提：#60 的详情抽屉已打开', drOk);
      const dh = await cs99(page, '#modelDetailDrawer .u-drawer-header', ['backgroundColor', 'color']);
      const dt = await cs99(page, '#modelDrawerTitle', ['color']);
      const ds = await cs99(page, '#modelDrawerSub', ['color']);
      check('W99 ② 抽屉头（.u-drawer-header）底 rgb(30, 41, 59) 字白；标题 h2 字白；副标题（.mdc-sub）字 rgb(199, 210, 254)', dh.backgroundColor === SLATE && dh.color === WHITE && dt.color === WHITE && ds.color === ACC_LINE, { dh, dt, ds });
      const dimB = await page.waitForSelector('#modelDrawerBody .b-layer-dim', { timeout: WAIT }).then(() => true, () => false);
      const dimC = dimB ? await cs99(page, '#modelDrawerBody .b-layer-dim', ['backgroundColor', 'color']) : { missing: '#modelDrawerBody .b-layer-dim' };
      check('W99 语义色保持：抽屉里 DIM 分层徽章（.b-layer-dim）底 rgb(254, 243, 199) 字 rgb(180, 83, 9)', dimB && dimC.backgroundColor === AMB_BG && dimC.color === AMB_FG, dimC);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT }).catch(() => {});
      await page.close();

      // ---------- ④ 配置台不变 ----------
      const wb = await adminN.newPage();
      wb.on('dialog', (d) => d.accept().catch(() => {}));
      await wb.goto(`${BASE}/Model_Workbench.html`, { waitUntil: 'load' });
      const wbOk = await wb.waitForSelector('#genLayer', { timeout: WAIT }).then(() => true, () => false);
      check('W99 ④ 前提：配置台页已加载（#genLayer 存在）', wbOk);
      if (wbOk) {
        await wb.waitForLoadState('networkidle').catch(() => {});
        const WB_BEFORE = { ods: 'rgb(37, 99, 235)', dim: 'rgb(217, 119, 6)', dwd: 'rgb(22, 163, 74)', ads: 'rgb(220, 38, 38)' };   // 逐字取自 capture_before.json 的 wbRegister.<层>.bg（基点 465f7d18 上采集）
        for (const layer of ['ods', 'dim', 'dwd', 'ads']) {
          await wb.evaluate((l) => { document.getElementById('genLayer').value = l; onLayerChange(); }, layer);
          const reached = await wb.waitForFunction((w) => getComputedStyle(document.getElementById('registerBtn')).backgroundColor === w, WB_BEFORE[layer], { timeout: WAIT }).then(() => true, () => false);
          await pageEvalBounded(wb, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
          const got = await wb.evaluate(() => ({ bg: getComputedStyle(document.getElementById('registerBtn')).backgroundColor, layer: document.getElementById('genLayer').value }));
          check('W99 ④ 配置台 #registerBtn 在 ' + layer + ' 层的计算底色 = 改动前 ' + WB_BEFORE[layer] + '（读 #registerBtn 的 backgroundColor；层选择器确实切到了 ' + layer + '）', reached && got.layer === layer && got.bg === WB_BEFORE[layer], got);
        }
      }
      await wb.close();
    });

    // ===== W100 子批 C4e-b：③ 作用域覆盖断言（详情抽屉 + 4 个声明式弹窗 + 9 个 JS 注入浮层根）+ P-U2 弹窗强调色 + SQL 高亮语义保持（方案 v0.11 §7.1「页面级配色」③ 与 P-U2；一律读计算样式，等待信号绑被断言的根元素）=====
    // 它锁的是：(a) 每个根元素（抽屉 #modelDetailDrawer、#registerModal / #batchImportModal / #ddlModal / #validationModal、JS 注入的 #dimDdlPreviewModal / #dimEtlPreviewModal / #dwdDdlModal / #dwdEtlPreviewModal /
    //   #modelDrawerTestModal / #iterationHistoryModal / #changeLogsModal / #scriptDiffModal / #designNotesPopover）打开后 getComputedStyle(根).getPropertyValue('--color-accent') = #4f46e5（作用域清单没漏根）；
    //   (b) 有 E 主按钮的弹窗，主按钮计算背景 = rgb(79, 70, 229)（批量导入「选择文件」/ DDL 弹窗「复制」/ 验收「重新验收」（静态与 ODS·DIM 两处渲染）/ 自定义 DDL「保存编辑」/ 自定义 ETL「保存全部」/ DIM DDL「复制到剪贴板」/ DWD DDL「复制当前脚本」），
    //   复制同步脚本按钮的成功态 = accent-hover、恢复 = accent；(c) 有标题渐变的弹窗（自定义 DDL / DIM DDL / DWD DDL），标题背景计算值 = accent-soft→accent-line 渐变、不含任何琥珀 rgb，标题字 = --c-link，标题图标 stroke = accent；
    //   P-U2 其余 E 行（注册弹窗数据来源区块、批量导入第二步框与说明框、DDL 信息条与表名、验收标题 / 检查项容器 / 六种段标题、DIM DDL 信息条、DWD DDL 胶囊、迭代历史版本号、编辑态切换按钮只在编辑态变 accent、激活页签 accent、添加页签、改名输入框）；
    //   语义色保持：注册弹窗 DIM 架构决策区块 / 导入提示 / ODS 使用说明 / 自定义徽章与模式条 / 验收有警告 / 迭代历史「修复」/ 变更历史「修改」/ SQL 字符串高亮 #fbbf24 仍为原值。
    //   不适用（原因）：#registerModal 的确认按钮 #confirmRegisterBtn 是灰 #6b7280（事实表无此行，不是琥珀），故 (b) 不适用；#modelDrawerTestModal / #iterationHistoryModal / #changeLogsModal / #scriptDiffModal / #designNotesPopover / #dwdEtlPreviewModal 没有 E 主按钮 / 标题渐变，只测 (a) 与各自的 E / 语义行。
    // 页内变异（首红落在本段）：见 CAT_MUTS 末尾 w100-* 条目（W100 的变异名在下面两行列全）
    // 变异名（82 个，定义见 CAT_MUTS 末尾；各自的首红见 b/out/mutlogs/q100_*.log 与 C4e-b 报告；另有 fix43 新增 18 个列在最后两行，本段合计 100 个）：
    //   w100-scope-no-registermodal / w100-scope-no-batchimportmodal / w100-scope-no-ddlmodal / w100-scope-no-validationmodal / w100-scope-no-dimddlpreviewmodal
    //   w100-scope-no-dimetlpreviewmodal / w100-scope-no-dwdddlmodal / w100-scope-no-dwdetlpreviewmodal / w100-scope-no-modeldrawertestmodal / w100-scope-no-iterationhistorymodal
    //   w100-scope-no-changelogsmodal / w100-scope-no-scriptdiffmodal / w100-scope-no-designnotespopover / w100-btn-batch-amber / w100-btn-ddlcopy-amber
    //   w100-btn-revalidate-static-amber / w100-btn-revalidate-ods-amber / w100-btn-revalidate-dim-amber / w100-btn-customsave-amber / w100-btn-etlsave-amber
    //   w100-btn-dimddlcopy-amber / w100-btn-dwdcopy-amber / w100-copysync-ok-amber / w100-copysync-restore-amber / w100-grad-customddl-amber
    //   w100-grad-dimddl-amber / w100-grad-dwdddl-amber / w100-h3-customddl-amber / w100-h3-dimddl-amber / w100-h3-dwdddl-amber
    //   w100-stroke-customddl-amber / w100-stroke-customeetl-amber / w100-stroke-dimddl-amber / w100-stroke-dwdddl-amber / w100-dwd-pill-amber
    //   w100-dwd-info-amber / w100-dimddl-bar-amber / w100-dimddl-tname-amber / w100-dimddl-desc-amber / w100-tabbar-active-amber
    //   w100-addtab-amber / w100-rename-amber / w100-switch-etl-tab-amber / w100-dwdtab-main-amber / w100-switch-dwdtab-amber
    //   w100-iter-version-edit-amber / w100-iter-version-view-amber / w100-val-name-js-amber / w100-val-sec-semantic-amber / w100-val-sec-dimstruct-amber
    //   w100-val-sec-dimdata-amber / w100-val-sec-dwdstruct-amber / w100-val-sec-dwddata-amber / w100-val-sec-ods-amber / w100-toggle-ddl-amber
    //   w100-toggle-etl-amber / w100-toggle-fdl-amber / w100-toggle-dimetl-amber / w100-toggle-ddl-border-amber / w100-toggle-ddl-off-changed
    //   w100-regsource-bg-amber / w100-regsource-title-amber / w100-batch-box-amber / w100-batch-title-amber / w100-batch-note-amber
    //   w100-ddl-infobar-amber / w100-ddl-name-amber / w100-val-name-static-amber / w100-val-checklist-amber / w100-sem-batch-tip-accent
    //   w100-sem-decision-accent / w100-sem-testwarn-accent / w100-sem-datafix-accent / w100-sem-update-accent / w100-sem-custombadge-accent
    //   w100-sem-customtip-accent / w100-sem-odstip-accent / w100-sql-accent / w100-reg-confirm-accent / w100-drawer-close-no-override
    //   w100-drawer-close-no-hover / w100-drawer-close-hover-dark
    //   fix43 新增 18 个：w100-save-ddl-shown-amber / w100-etl-exit-color-kept / w100-fdl-exit-bg-kept / w100-fdl-exit-color-kept / w100-fdl-exit-border-kept / w100-icon-child-customddl / w100-icon-child-custometl / w100-icon-child-dimddl / w100-icon-child-dwdddl
    //   w100-root-hidden-dimddl / w100-root-hidden-dimetl / w100-root-hidden-dwdddl / w100-root-hidden-dwdetl / w100-root-hidden-drawertest / w100-root-hidden-iteration / w100-root-hidden-changelogs / w100-root-hidden-scriptdiff / w100-root-hidden-designnotes
    console.log('W100 C4e-b ③ 作用域覆盖 + P-U2 弹窗强调色 + SQL 高亮语义保持（计算样式）');
    await segGuard('W100', async () => {
      const ACC = 'rgb(79, 70, 229)', ACC_H = 'rgb(67, 56, 202)', ACC_SOFT = 'rgb(238, 242, 255)', ACC_LINE = 'rgb(199, 210, 254)', LINK = 'rgb(55, 48, 163)', SLATE = 'rgb(30, 41, 59)', WHITE = 'rgb(255, 255, 255)', GRAY = 'rgb(107, 114, 128)', EDIT_OFF_BG = 'rgb(248, 250, 252)', EDIT_OFF_BD = 'rgb(209, 213, 219)', TRANSP = 'rgba(0, 0, 0, 0)';
      const AMBERS = ['rgb(217, 119, 6)', 'rgb(180, 83, 9)', 'rgb(146, 64, 14)', 'rgb(245, 158, 11)', 'rgb(252, 211, 77)', 'rgb(253, 230, 138)', 'rgb(254, 243, 199)', 'rgb(255, 251, 235)', 'rgb(251, 191, 36)', 'rgb(120, 53, 15)'];
      const hasAmber = (s) => AMBERS.some((a) => String(s).includes(a));
      const J2 = (v) => JSON.stringify(v);
      const T6 = [{ title: '迭代甲', category: 'DATA_FIX', owner: '负责人甲', done_at: '2026-03-02T10:00:00' }, { title: '迭代乙', category: 'DWD_DEV', owner: '负责人乙', done_at: '2026-03-01T10:00:00' }];
      const LOG60 = [{ id: 11, action: 'UPDATE', created_at: '2026-03-01 10:00:00', change_summary: 'W100 脚本改动', operator_name: '操作人甲', change_type: 'script_edit', before_value: J2({ fileName: 'w100.sql', content: 'select 1' }), after_value: J2({ fileName: 'w100.sql', content: 'select 2' }) }];
      const REC60 = [{ overall_result: 'warn', test_user: '验收人甲', total_rows: 3, test_time: '2026-03-01 10:00:00' }];
      const jsonRoute = (page, pat, body) => page.route(pat, (route) => (route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: J2(body) }) : route.continue()));
      const { page } = await open(adminN, 'W100', '', { beforeGoto: both(rewriteList(patchRows({ 60: { design_notes: 'W100 设计说明甲' } })), async (pg) => {
        await jsonRoute(pg, '**/api/models/60/archived-tasks*', T6);
        await jsonRoute(pg, '**/api/models/6/archived-tasks*', T6);
        await jsonRoute(pg, '**/api/models/60/test-records*', REC60);
        await jsonRoute(pg, '**/api/models/60/change-logs*', LOG60);
      }) });
      await page.setViewportSize({ width: 1440, height: 900 });
      const cs = (sel, props, pseudo) => page.evaluate(([s, ps, pse]) => { const e = document.querySelector(s); if (!e) return { missing: s }; const c = getComputedStyle(e, pse || null); return Object.fromEntries(ps.map((p) => [p, c[p]])); }, [sel, props, pseudo || '']);
      const accOf = (rootSel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).getPropertyValue('--color-accent').trim() : '(无根元素：' + s + ')'; }, rootSel);
      const waitRoot = (sel) => page.waitForSelector(sel, { state: 'attached', timeout: WAIT }).then(() => true, () => false);
      /** fix43 M4（43Tc-M4）：动态浮层「已打开 / 已出现」的前提改用它——根元素存在且真的可见（display 不是 none、visibility 不是 hidden、有非零尺寸），可再带一个根内元素选择器（也必须存在）；有界（WAIT），等待绑被断言的根元素本身。waitRoot（state: 'attached'）只留给「非浮层根」的内部节点 */
      const waitShown = (rootSel, innerSel) => page.waitForFunction(([r, i]) => { const e = document.querySelector(r); if (!e) return false; const c = getComputedStyle(e); const b = e.getBoundingClientRect(); return c.display !== 'none' && c.visibility !== 'hidden' && b.width > 0 && b.height > 0 && (!i || !!e.querySelector(i)); }, [rootSel, innerSel || ''], { timeout: WAIT }).then(() => true, () => false);
      const waitFlex = (id) => page.waitForFunction((i) => { const e = document.getElementById(i); return !!e && getComputedStyle(e).display === 'flex'; }, id, { timeout: WAIT }).then(() => true, () => false);
      const waitCs = (sel, prop, want) => page.waitForFunction(([s, p, w]) => { const e = document.querySelector(s); return !!e && getComputedStyle(e)[p] === w; }, [sel, prop, want], { timeout: WAIT }).then(() => true, () => false);
      const aCheck = async (zh, rootSel) => { const v = await accOf(rootSel); check('W100 ③(a) ' + zh + ' 根 ' + rootSel + ' 的 --color-accent = #4f46e5（读根元素 getComputedStyle 的自定义属性）', v === '#4f46e5', v); };
      const sub = async (name, fn) => { try { await fn(); } catch (e) { check('W100 小节「' + name + '」跑完、没有未捕获异常（抛出 = 判红）', false, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); } };
      /** 一个标题条（渐变）的 (c) 读法：head = h3 的父元素 */
      const headOf = (pg, rootSel) => pg.evaluate((s) => { const m = document.querySelector(s); const h3 = m && m.querySelector('h3'); if (!h3) return { missing: s + ' h3' }; const head = h3.parentElement; const svg = h3.querySelector('svg'); const hc = getComputedStyle(head); return { headBg: hc.backgroundImage, headBgColor: hc.backgroundColor, h3Color: getComputedStyle(h3).color, svgStroke: svg ? getComputedStyle(svg).stroke : null }; }, rootSel);
      const GRAD = 'linear-gradient(135deg, ' + ACC_SOFT + ', ' + ACC_LINE + ')';
      const cCheck = (zh, h) => check('W100 ③(c) ' + zh + ' 标题条背景 = ' + GRAD + '（不含任何琥珀 rgb）、标题字 rgb(55, 48, 163)、标题图标 stroke = accent（读标题条 backgroundImage / h3 color / svg stroke）', !h.missing && h.headBg === GRAD && !hasAmber(h.headBg + h.headBgColor + h.h3Color + h.svgStroke) && h.h3Color === LINK && h.svgStroke === ACC, h);
      /** fix43 M3（43Tc-M3）：标题图标的描边除父 svg 外还要读实际承担描边的子图形（path / line / rect / circle 等）——父 svg 已是 accent、某个 path 自己带 stroke="#d97706" 时，父元素读数仍对、图标实际仍是琥珀 */
      const iconOf = (pg, rootSel) => pg.evaluate((s) => { const m = document.querySelector(s); const h3 = m && m.querySelector('h3'); const svg = h3 && h3.querySelector('svg'); if (!svg) return { missing: s + ' h3 svg' }; const kids = Array.from(svg.querySelectorAll('path, line, rect, circle, ellipse, polyline, polygon')).map((k) => ({ tag: k.tagName.toLowerCase(), attr: k.getAttribute('stroke'), stroke: getComputedStyle(k).stroke })); return { svgStroke: getComputedStyle(svg).stroke, kids }; }, rootSel);
      const sCheck = (zh, ic) => { const drawn = ic.kids ? ic.kids.filter((k) => k.attr !== 'none') : []; check('W100 ③(c) ' + zh + ' 标题图标子图形：父 svg 与每个承担描边的子图形（path / line / rect / circle 等，排除明确 stroke="none" 的；至少 1 个）计算 stroke 都 = accent rgb(79, 70, 229)', !ic.missing && ic.svgStroke === ACC && drawn.length >= 1 && drawn.every((k) => k.stroke === ACC), ic); };
      const rgbOf = (s) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(s)); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
      const lumOf = (c) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const ratio = (a, b) => { const l1 = lumOf(a), l2 = lumOf(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
      const btnBg = (sel) => cs(sel, ['backgroundColor']);

      // ---------- 详情抽屉 ----------
      await sub('详情抽屉', async () => {
        await page.evaluate(() => openModelDrawer(60, document.querySelector('#modelListBody [data-id="60"] .model-open-btn')));
        check('W100 前提：#60 的详情抽屉已打开（#modelDetailDrawer.open）', await waitRoot('#modelDetailDrawer.open'));
        await aCheck('详情抽屉', '#modelDetailDrawer');
        const dh = await cs('#modelDetailDrawer .u-drawer-header', ['backgroundColor', 'backgroundImage', 'color']);
        check('W100 ③(c) 详情抽屉头底 rgb(30, 41, 59)、不含琥珀 rgb（读 .u-drawer-header 的 backgroundColor / backgroundImage / color）', dh.backgroundColor === SLATE && !hasAmber(J2(dh)), dh);
        // C4e 预筛修复：共享层 .u-drawer-close 悬停色 #111827 压在深色头上只剩 1.21:1——常态 / 悬停都要与抽屉头底色对比度 ≥ 3:1
        const closeSel = '#modelDetailDrawer .u-drawer-close';
        const cl0 = await cs(closeSel, ['color', 'backgroundColor']);
        check('W100 ③(c) 抽屉关闭按钮常态字色 rgb(203, 213, 225)，与抽屉头底色（.u-drawer-header 的 backgroundColor）对比度 ≥ 3:1（读 .u-drawer-close 的 color）', cl0.color === 'rgb(203, 213, 225)' && !!rgbOf(cl0.color) && !!rgbOf(dh.backgroundColor) && ratio(rgbOf(cl0.color), rgbOf(dh.backgroundColor)) >= 3, { cl0, dh });
        await page.hover(closeSel);
        const clHov = await waitCs(closeSel, 'color', WHITE);
        const cl1 = await cs(closeSel, ['color', 'backgroundColor']);
        check('W100 ③(c) 抽屉关闭按钮悬停（hover 后等计算色变化）字色 = rgb(255, 255, 255)、底 = rgba(255, 255, 255, 0.18)，字色与抽屉头底色对比度 ≥ 3:1', clHov && cl1.color === WHITE && cl1.backgroundColor === 'rgba(255, 255, 255, 0.18)' && ratio(rgbOf(cl1.color), rgbOf(dh.backgroundColor)) >= 3, { cl1, dh });
        await page.mouse.move(1, 1);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT }).catch(() => {});
      });

      // ---------- #registerModal（编辑信息入口；ODS #6 才显示「数据来源信息」区块）----------
      await sub('注册弹窗 ODS', async () => {
        await pageCallBounded(page, 'openEditModal(allModelsData.find((m) => m.id === 6))');
        check('W100 前提：#registerModal 已显示（display:flex）', await waitFlex('registerModal'));
        const hist = await page.waitForFunction(() => document.querySelectorAll('#iterationHistoryList span').length > 0, null, { timeout: WAIT }).then(() => true, () => false);
        check('W100 前提：#6 的迭代历史（路由替身 2 条）已渲染进 #iterationHistoryList', hist);
        await aCheck('注册弹窗', '#registerModal');
        const rg = await page.evaluate(() => { const sec = document.getElementById('regSourceSection'); const t = sec && sec.firstElementChild; const ver = Array.from(document.querySelectorAll('#iterationHistoryList span')).find((x) => /^v\d+$/.test(x.textContent.trim())); const g = (e) => { if (!e) return null; const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; }; return { shown: sec ? getComputedStyle(sec).display : null, sec: g(sec), title: g(t), ver: g(ver), verText: ver ? ver.textContent.trim() : null }; });
        check('W100 P-U2 注册弹窗「数据来源信息」区块可见（ODS）、底 rgb(238, 242, 255)、标题 rgb(55, 48, 163)（读 #regSourceSection 与其首个子元素）', rg.shown === 'block' && !!rg.sec && rg.sec.bg === ACC_SOFT && !!rg.title && rg.title.color === LINK, rg);
        check('W100 P-U2 注册弹窗迭代历史版本号（#iterationHistoryList 里的 v2）字色 rgb(55, 48, 163)', rg.verText === 'v2' && !!rg.ver && rg.ver.color === LINK, rg);
        const cf = await btnBg('#confirmRegisterBtn');
        check('W100 ③(b) 不适用核对：注册弹窗确认按钮 #confirmRegisterBtn 背景是灰 rgb(107, 114, 128)（不是琥珀也不是 accent，事实表无此行）', cf.backgroundColor === GRAY, cf);
        await page.evaluate(() => { document.getElementById('registerModal').style.display = 'none'; });
        // 语义色保持：DIM 架构决策区块仍是琥珀底 / 琥珀标题
        await pageCallBounded(page, 'openEditModal(allModelsData.find((m) => m.id === 60))');
        check('W100 前提：#60（DIM）的编辑弹窗显示、DIM 架构决策区块可见', await page.waitForFunction(() => getComputedStyle(document.getElementById('registerModal')).display === 'flex' && getComputedStyle(document.getElementById('regDecisionSection')).display === 'block', null, { timeout: WAIT }).then(() => true, () => false));
        const dec = await page.evaluate(() => { const s = document.getElementById('regDecisionSection'); const t = document.getElementById('regDecisionTitle'); return { bg: getComputedStyle(s).backgroundColor, bd: getComputedStyle(s).borderTopColor, title: getComputedStyle(t).color }; });
        check('W100 语义色保持：DIM 架构决策区块（#regDecisionSection）底 rgb(255, 251, 235) 边 rgb(252, 211, 77) 标题 rgb(146, 64, 14) 仍是原琥珀值', dec.bg === 'rgb(255, 251, 235)' && dec.bd === 'rgb(252, 211, 77)' && dec.title === 'rgb(146, 64, 14)', dec);
        await page.evaluate(() => { document.getElementById('registerModal').style.display = 'none'; });
      });

      // ---------- #batchImportModal ----------
      await sub('批量导入弹窗', async () => {
        await page.evaluate(() => { openBatchImportModal(); });
        check('W100 前提：#batchImportModal 已显示（display:flex）', await waitFlex('batchImportModal'));
        await aCheck('批量导入弹窗', '#batchImportModal');
        const bi = await page.evaluate(() => {
          const m = document.getElementById('batchImportModal');
          const st = (e) => { if (!e) return null; const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color, bd: c.borderTopColor }; };
          const h4 = Array.from(m.querySelectorAll('h4')).find((h) => h.textContent.includes('第二步'));
          const box = h4 && h4.parentElement;
          const strong = Array.from(m.querySelectorAll('strong')).find((s) => s.textContent.includes('模板说明'));
          const tip = Array.from(m.querySelectorAll('p')).find((p) => p.textContent.includes('批量导入的模型状态'));
          return { h4: st(h4), box: st(box), btn: st(box && box.querySelector('button')), note: st(strong && strong.parentElement), tip: st(tip) };
        });
        check('W100 ③(b) 批量导入「选择文件」按钮（第二步框里的 button）背景 = rgb(79, 70, 229)', !!bi.btn && bi.btn.bg === ACC, bi.btn);
        check('W100 P-U2 批量导入第二步框：底 rgb(238, 242, 255)、边 rgb(199, 210, 254)、标题 rgb(55, 48, 163)；模板说明框底 rgb(238, 242, 255) 字 rgb(55, 48, 163)', !!bi.box && bi.box.bg === ACC_SOFT && bi.box.bd === ACC_LINE && !!bi.h4 && bi.h4.color === LINK && !!bi.note && bi.note.bg === ACC_SOFT && bi.note.color === LINK, bi);
        check('W100 语义色保持：导入提示段（「提示：批量导入的模型状态…」）字色 rgb(180, 83, 9) 仍是原值', !!bi.tip && bi.tip.color === 'rgb(180, 83, 9)', bi.tip);
        await page.evaluate(() => { document.getElementById('batchImportModal').style.display = 'none'; });
      });

      // ---------- #ddlModal（ODS DDL）----------
      await sub('DDL 弹窗', async () => {
        await page.evaluate(() => { window.copyToClipboard = () => Promise.resolve(); });
        await page.evaluate(() => { openDDLModal(allModelsData.find((m) => m.id === 6)); });
        check('W100 前提：#ddlModal 已显示（display:flex）', await waitFlex('ddlModal'));
        await aCheck('DDL 弹窗', '#ddlModal');
        const dd = await page.evaluate(() => { const nm = document.getElementById('ddlTableName'); const bar = nm.closest('div[style*="margin-bottom:20px"]'); const tip = document.querySelector('#ddlModal [style*="#fefce8"]'); const g = (e) => { if (!e) return null; const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; }; return { name: g(nm), bar: g(bar), tip: g(tip) }; });
        check('W100 P-U2 DDL 弹窗信息条底 rgb(238, 242, 255)、表名（#ddlTableName）字 rgb(55, 48, 163)', !!dd.bar && dd.bar.bg === ACC_SOFT && !!dd.name && dd.name.color === LINK, dd);
        check('W100 语义色保持：ODS 使用说明框（#fefce8 那块）底 rgb(254, 252, 232) 字 rgb(133, 77, 14) 仍是原黄系', !!dd.tip && dd.tip.bg === 'rgb(254, 252, 232)' && dd.tip.color === 'rgb(133, 77, 14)', dd.tip);
        check('W100 ③(b) DDL 弹窗「复制同步脚本」按钮（#copySyncScriptBtn）背景 = rgb(79, 70, 229)', (await btnBg('#copySyncScriptBtn')).backgroundColor === ACC);
        if (await clickB(page, '#copySyncScriptBtn', 'W100 点「复制同步脚本」')) {
          const okTxt = await page.waitForFunction(() => document.getElementById('copySyncScriptBtn').textContent.includes('已复制'), null, { timeout: WAIT }).then(() => true, () => false);
          check('W100 复制同步脚本成功态：按钮文字变「已复制!」且背景 = accent-hover rgb(67, 56, 202)（读 #copySyncScriptBtn；2 秒后恢复）', okTxt && (await waitCs('#copySyncScriptBtn', 'backgroundColor', ACC_H)), await btnBg('#copySyncScriptBtn'));
          const back = await page.waitForFunction((w) => { const b = document.getElementById('copySyncScriptBtn'); return !b.textContent.includes('已复制') && getComputedStyle(b).backgroundColor === w; }, ACC, { timeout: WAIT }).then(() => true, () => false);
          check('W100 复制同步脚本恢复态：文字恢复、背景回到 accent rgb(79, 70, 229)', back, await btnBg('#copySyncScriptBtn'));
        }
        await page.evaluate(() => { document.getElementById('ddlModal').style.display = 'none'; });
      });

      // ---------- #validationModal ----------
      await sub('验收弹窗', async () => {
        const VAR = [['ODS', 6, 'ods_w0001_df', 'ONLINE', 'ODS', undefined, '验收检查项：'], ['DIM 语义', 50, 'dim_w0007_w0008', 'DEVELOPING', 'DIM', 'semantic', '语义审查内容：'], ['DIM 结构', 50, 'dim_w0007_w0008', 'DEVELOPING', 'DIM', 'structure', '结构验收检查项（10 项）：'], ['DIM 数据', 50, 'dim_w0007_w0008', 'DEVELOPING', 'DIM', 'data', '数据验收检查项（5 项）：'], ['DWD 结构', 52, 'dwd_w0001_w0060_df', 'ONLINE', 'DWD', 'structure', '结构验收检查项（7~8 项）：'], ['DWD 数据', 52, 'dwd_w0001_w0060_df', 'ONLINE', 'DWD', 'data', '数据验收检查项（6 项）：']];
        const stat = await cs('#validationTableName', ['color']);
        check('W100 P-U2 验收弹窗静态标题里的表名占位（#validationTableName，弹窗未打开前读计算样式）字 rgb(55, 48, 163)', stat.color === LINK, stat);
        for (const [label, id, tn, st, layer, phase, title] of VAR) {
          await page.evaluate(([a, b, c, d, e]) => { openValidationModal(a, b, c, d, e); }, [id, tn, st, layer, phase]);
          check('W100 前提：验收弹窗（' + label + '）已显示（display:flex）', await waitFlex('validationModal'));
          const v = await page.evaluate(() => { const box = document.getElementById('validationChecklistBox'); const t = box.querySelector('div'); const bc = getComputedStyle(box); const ttl = document.querySelector('#validationModalTitle span'); return { text: t ? t.textContent.trim() : null, color: t ? getComputedStyle(t).color : null, boxBg: bc.backgroundColor, boxBd: bc.borderTopColor, nameColor: ttl ? getComputedStyle(ttl).color : null, name: ttl ? ttl.textContent : null }; });
          check('W100 P-U2 验收弹窗（' + label + '）检查项容器底 rgb(238, 242, 255) 边 rgb(199, 210, 254)、段标题「' + title + '」字 rgb(55, 48, 163)、标题里的表名「' + tn + '」字 rgb(55, 48, 163)', v.text === title && v.color === LINK && v.boxBg === ACC_SOFT && v.boxBd === ACC_LINE && v.name === tn && v.nameColor === LINK, v);
          if (label === 'ODS') {
            await aCheck('验收弹窗', '#validationModal');
            check('W100 ③(b) 验收弹窗静态「重新验收」按钮（#validationResultButtons 里 onclick=runValidation() 的那个）背景 = rgb(79, 70, 229)', (await btnBg('#validationResultButtons button[onclick="runValidation()"]')).backgroundColor === ACC);
            const dn = await pageCallBounded(page, 'runValidation()');
            const shown = await page.waitForFunction(() => getComputedStyle(document.getElementById('validationResult')).display !== 'none', null, { timeout: WAIT }).then(() => true, () => false);
            check('W100 前提：ODS 验收执行完成、结果区显示（路由替身返回 pass）', shown && dn !== '__timeout__' && dn !== '__threw__');
            check('W100 ③(b) ODS 验收结果渲染后的「重新验收」按钮（renderValidationResult 重建的）背景 = rgb(79, 70, 229)', (await btnBg('#validationResultButtons button[onclick="runValidation()"]')).backgroundColor === ACC);
          }
          if (label === 'DIM 结构') {
            await page.route('**/api/models/50/validate', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: J2({ phase: 'structure', overall_result: 'fail', total_rows: 0, execution_time_ms: 3, structure: [{ id: 'S1', name: '桩', status: 'fail', detail: 'x' }], data: [] }) }));
            const dn = await pageCallBounded(page, 'runValidation()');
            const shown = await page.waitForFunction(() => getComputedStyle(document.getElementById('validationResult')).display !== 'none', null, { timeout: WAIT }).then(() => true, () => false);
            check('W100 前提：DIM 结构验收执行完成、结果区显示（路由替身返回 fail）', shown && dn !== '__timeout__' && dn !== '__threw__');
            check('W100 ③(b) DIM 验收结果渲染后的「重新验收」按钮（renderDimValidationResult 重建的）背景 = rgb(79, 70, 229)', (await btnBg('#validationResultButtons button[onclick="runValidation()"]')).backgroundColor === ACC);
          }
        }
        await page.evaluate(() => { closeValidationModal(); });
      });

      // ---------- #dimDdlPreviewModal：DIM 标准（预览）----------
      await sub('DIM DDL 预览', async () => {
        await pageCallBounded(page, 'openDimDDLModal(50)');
        check('W100 前提：#dimDdlPreviewModal（DIM #50 标准 DDL 预览）已出现且根可见（display 不是 none、有非零尺寸）', await waitShown('#dimDdlPreviewModal'));
        await aCheck('DIM DDL 预览', '#dimDdlPreviewModal');
        cCheck('DIM DDL 预览', await headOf(page, '#dimDdlPreviewModal'));
        sCheck('DIM DDL 预览', await iconOf(page, '#dimDdlPreviewModal'));
        const dd = await page.evaluate(() => { const m = document.getElementById('dimDdlPreviewModal'); const sp = m.querySelector('span > strong'); const bar = sp && sp.parentElement.parentElement; const spans = bar ? Array.from(bar.querySelectorAll(':scope > span')) : []; return { bar: bar ? getComputedStyle(bar).backgroundColor : null, spans: spans.map((s) => getComputedStyle(s).color), btn: getComputedStyle(m.querySelector('button[onclick="copyDimDdlToClipboard()"]')).backgroundColor }; });
        check('W100 P-U2 DIM DDL 预览信息条底 rgb(238, 242, 255)、「表名」「描述」两段字 rgb(55, 48, 163)', dd.bar === ACC_SOFT && dd.spans.length === 2 && dd.spans.every((c) => c === LINK), dd);
        check('W100 ③(b) DIM DDL 预览「复制到剪贴板」按钮背景 = rgb(79, 70, 229)', dd.btn === ACC, dd);
        await page.evaluate(() => closeDimDdlPreviewModal());
      });

      // ---------- #dimDdlPreviewModal：DIM 自定义（DDL 编辑器）----------
      await sub('自定义 DDL 编辑器', async () => {
        await pageCallBounded(page, 'openDimDDLModal(58)');
        check('W100 前提：自定义 DDL 编辑器已出现（#dimDdlPreviewModal 根可见且含 #customDdlEditBtn）', await waitShown('#dimDdlPreviewModal', '#customDdlEditBtn'));
        await aCheck('自定义 DDL 编辑器', '#dimDdlPreviewModal');
        cCheck('自定义 DDL 编辑器', await headOf(page, '#dimDdlPreviewModal'));
        sCheck('自定义 DDL 编辑器', await iconOf(page, '#dimDdlPreviewModal'));
        check('W100 ③(b) 自定义 DDL「保存编辑」按钮（#customDdlSaveBtn，进入编辑前隐藏，计算样式照读）背景 = rgb(79, 70, 229)', (await btnBg('#customDdlSaveBtn')).backgroundColor === ACC);
        const sem = await page.evaluate(() => { const m = document.getElementById('dimDdlPreviewModal'); const badge = Array.from(m.querySelectorAll('h3 span')).find((s) => s.textContent.trim() === '自定义'); const tip = Array.from(m.querySelectorAll('div')).find((d) => d.textContent.trim().startsWith('自定义模式：') && d.children.length === 0); const g = (e) => { if (!e) return null; const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; }; return { badge: g(badge), tip: g(tip) }; });
        check('W100 语义色保持：「自定义」徽章底 rgb(245, 158, 11)、自定义模式提示条底 rgb(254, 243, 199) 字 rgb(146, 64, 14) 仍是原琥珀值', !!sem.badge && sem.badge.bg === 'rgb(245, 158, 11)' && !!sem.tip && sem.tip.bg === 'rgb(254, 243, 199)' && sem.tip.color === 'rgb(146, 64, 14)', sem);
        const off = await cs('#customDdlEditBtn', ['backgroundColor', 'color', 'borderTopColor']);
        check('W100 编辑态切换（非编辑态原值不动）：「进入编辑」按钮底 rgb(248, 250, 252) 字 rgb(107, 114, 128) 边 rgb(209, 213, 219)', off.backgroundColor === EDIT_OFF_BG && off.color === GRAY && off.borderTopColor === EDIT_OFF_BD, off);
        if (await clickB(page, '#customDdlEditBtn', 'W100 点自定义 DDL「进入编辑」')) {
          const on = await cs('#customDdlEditBtn', ['backgroundColor', 'color', 'borderTopColor']);
          check('W100 编辑态切换（编辑态）：按钮底 = accent rgb(79, 70, 229)、字白、边 accent；「保存编辑」显示', on.backgroundColor === ACC && on.color === WHITE && on.borderTopColor === ACC && (await cs('#customDdlSaveBtn', ['display'])).display !== 'none', on);
          // fix43 M2（43Tc-M2）：进入编辑后「保存编辑」按钮显示了——对这个可见的按钮读计算背景（隐藏态那条读数单独保留在上面，两者都要）
          const sv = await cs('#customDdlSaveBtn', ['display', 'visibility', 'backgroundColor', 'color']);
          check('W100 编辑态切换：自定义 DDL 进入编辑后可见的「保存编辑」按钮（display 不是 none、visibility visible）计算背景 = accent rgb(79, 70, 229)、字白（读 #customDdlSaveBtn 的计算样式）', !sv.missing && sv.display !== 'none' && sv.visibility === 'visible' && sv.backgroundColor === ACC && sv.color === WHITE, sv);
          if (await clickB(page, '#customDdlEditBtn', 'W100 点自定义 DDL「退出编辑」')) {
            const off2 = await cs('#customDdlEditBtn', ['backgroundColor', 'color', 'borderTopColor']);
            check('W100 编辑态切换（退出后回到原值）：底 rgb(248, 250, 252) 字 rgb(107, 114, 128) 边 rgb(209, 213, 219)', off2.backgroundColor === EDIT_OFF_BG && off2.color === GRAY && off2.borderTopColor === EDIT_OFF_BD, off2);
          }
        }
        await page.evaluate(() => closeDimDdlPreviewModal());
      });

      // ---------- #dimEtlPreviewModal：DIM 标准（预览）----------
      await sub('DIM ETL 预览', async () => {
        await pageCallBounded(page, 'openDimETLModal(50)');
        check('W100 前提：#dimEtlPreviewModal（DIM #50 标准 ETL 预览）已出现且根可见（含 #etlTab_init）', await waitShown('#dimEtlPreviewModal', '#etlTab_init'));
        await aCheck('DIM ETL 预览', '#dimEtlPreviewModal');
        // toggleEtlEditMode(prefix, tabKey) 读的按钮 id 是 ${prefix}TabEditBtn_${tabKey}，但页面模板里没有任何元素带这个 id（该分支现场不可达的死分支）：页内注入一个同 id 按钮来构造
        await page.evaluate(() => { const b = document.createElement('button'); b.id = 'dimTabEditBtn_init'; document.getElementById('dimEtlPreviewModal').appendChild(b); toggleEtlEditMode('dim', 'init'); });
        const te1 = await cs('#dimTabEditBtn_init', ['backgroundColor', 'color', 'borderTopColor']);
        check('W100 编辑态切换（toggleEtlEditMode，页内注入同 id 按钮构造，编辑态）：底 accent rgb(79, 70, 229)、字白、边 accent', te1.backgroundColor === ACC && te1.color === WHITE && te1.borderTopColor === ACC, te1);
        await page.evaluate(() => { toggleEtlEditMode('dim', 'init'); });
        const te2 = await cs('#dimTabEditBtn_init', ['backgroundColor', 'color', 'borderTopColor']);
        check('W100 编辑态切换（toggleEtlEditMode，退出后回到原值）：底 rgb(248, 250, 252) 字 rgb(107, 114, 128) 边 rgb(209, 213, 219)', te2.backgroundColor === EDIT_OFF_BG && te2.color === GRAY && te2.borderTopColor === EDIT_OFF_BD, te2);
        await page.evaluate(() => closeDimEtlPreviewModal());
      });

      // ---------- #dimEtlPreviewModal：DIM 自定义（多页签 ETL 编辑器）----------
      await sub('自定义 ETL 编辑器', async () => {
        await pageCallBounded(page, 'openDimETLModal(58)');
        check('W100 前提：自定义 ETL 编辑器已出现（#dimEtlPreviewModal 根可见且含 #customEtlTabBar）', await waitShown('#dimEtlPreviewModal', '#customEtlTabBar'));
        await aCheck('自定义 ETL 编辑器', '#dimEtlPreviewModal');
        sCheck('自定义 ETL 编辑器', await iconOf(page, '#dimEtlPreviewModal'));
        const e0 = await page.evaluate(() => { const m = document.getElementById('dimEtlPreviewModal'); const g = (e) => { const c = getComputedStyle(e); return { color: c.color, bd: c.borderBottomColor }; }; const svg = m.querySelector('h3 svg'); return { init: g(document.getElementById('customEtlTab_init')), incr: g(document.getElementById('customEtlTab_incr')), add: g(m.querySelector('#customEtlTabBar > button:last-child')), save: getComputedStyle(m.querySelector('button[onclick^="saveAllCustomETL"]')).backgroundColor, stroke: svg ? getComputedStyle(svg).stroke : null }; });
        check('W100 P-U2 自定义 ETL 激活页签「全量初始化」字与下边线 = accent、未激活页签「增量更新」字 rgb(107, 114, 128) 下边线透明；「+ 添加脚本」字 accent；标题图标 stroke accent', e0.init.color === ACC && e0.init.bd === ACC && e0.incr.color === GRAY && e0.incr.bd === TRANSP && e0.add.color === ACC && e0.stroke === ACC, e0);
        check('W100 ③(b) 自定义 ETL「保存全部」按钮背景 = rgb(79, 70, 229)', e0.save === ACC, e0);
        if (await clickB(page, '#customEtlTab_incr', 'W100 点「增量更新」页签')) {
          const e1 = await page.evaluate(() => { const g = (e) => { const c = getComputedStyle(e); return { color: c.color, bd: c.borderBottomColor }; }; return { init: g(document.getElementById('customEtlTab_init')), incr: g(document.getElementById('customEtlTab_incr')) }; });
          check('W100 P-U2 切到「增量更新」后（switchCustomEtlTab）：增量更新页签字与下边线 = accent、全量初始化页签回灰 rgb(107, 114, 128) 下边线透明', e1.incr.color === ACC && e1.incr.bd === ACC && e1.init.color === GRAY && e1.init.bd === TRANSP, e1);
          const eb0 = await cs('#customEtlEditBtn_incr', ['backgroundColor', 'color', 'borderTopColor']);
          check('W100 编辑态切换（ETL 页签，非编辑态原值不动）：底 rgb(248, 250, 252) 字 rgb(107, 114, 128) 边 rgb(209, 213, 219)', eb0.backgroundColor === EDIT_OFF_BG && eb0.color === GRAY && eb0.borderTopColor === EDIT_OFF_BD, eb0);
          if (await clickB(page, '#customEtlEditBtn_incr', 'W100 点 ETL「进入编辑」')) {
            const eb1 = await cs('#customEtlEditBtn_incr', ['backgroundColor', 'color', 'borderTopColor']);
            check('W100 编辑态切换（ETL 页签，编辑态）：底 accent、字白、边 accent', eb1.backgroundColor === ACC && eb1.color === WHITE && eb1.borderTopColor === ACC, eb1);
            if (await clickB(page, '#customEtlEditBtn_incr', 'W100 点 ETL「退出编辑」')) {
              const eb2 = await cs('#customEtlEditBtn_incr', ['backgroundColor', 'color', 'borderTopColor']);
              check('W100 编辑态切换（ETL 页签，退出后回到原值）：底 rgb(248, 250, 252) 字 rgb(107, 114, 128) 边 rgb(209, 213, 219)（fix43 补字色）', eb2.backgroundColor === EDIT_OFF_BG && eb2.color === GRAY && eb2.borderTopColor === EDIT_OFF_BD, eb2);
            }
          }
        }
        if (await clickB(page, '#customEtlTab_fdl', 'W100 点「FDL 节点配置」页签')) {
          const fb0 = await cs('#fdlEditBtn_1', ['backgroundColor', 'color', 'borderTopColor']);
          check('W100 编辑态切换（FDL 节点，非编辑态原值不动）：底 rgb(248, 250, 252) 字 rgb(107, 114, 128) 边 rgb(209, 213, 219)（fix43 补字色）', fb0.backgroundColor === EDIT_OFF_BG && fb0.color === GRAY && fb0.borderTopColor === EDIT_OFF_BD, fb0);
          if (await clickB(page, '#fdlEditBtn_1', 'W100 点 FDL「进入编辑」')) {
            const fb1 = await cs('#fdlEditBtn_1', ['backgroundColor', 'color', 'borderTopColor']);
            check('W100 编辑态切换（FDL 节点，编辑态）：底 accent、字白、边 accent', fb1.backgroundColor === ACC && fb1.color === WHITE && fb1.borderTopColor === ACC, fb1);
            // fix43 M2（43Tc-M2）：FDL 退出编辑——底 / 字 / 边都回到非编辑态原值（退出仍保留 accent 判红）
            if (await clickB(page, '#fdlEditBtn_1', 'W100 点 FDL「退出编辑」')) {
              const fb2 = await cs('#fdlEditBtn_1', ['backgroundColor', 'color', 'borderTopColor']);
              check('W100 编辑态切换（FDL 节点，退出后回到原值）：底 rgb(248, 250, 252) 字 rgb(107, 114, 128) 边 rgb(209, 213, 219)', fb2.backgroundColor === EDIT_OFF_BG && fb2.color === GRAY && fb2.borderTopColor === EDIT_OFF_BD, fb2);
            }
          }
        }
        // 添加页签 + 改名输入框
        page.removeAllListeners('dialog');
        page.once('dialog', (d) => d.accept('页签甲').catch(() => {}));
        if (await clickB(page, '#customEtlTabBar > button:last-child', 'W100 点「+ 添加脚本」')) {
          check('W100 前提：新页签 extra_1 已加入', await waitRoot('#customEtlTab_extra_1'));
          await page.evaluate(() => { renameCustomEtlTab('extra_1'); });
          const okIn = await waitRoot('#customEtlLabel_extra_1 input');
          const ib = okIn ? await cs('#customEtlLabel_extra_1 input', ['borderTopColor']) : { missing: 'input' };
          check('W100 P-U2 改名输入框（renameCustomEtlTab 建的 input）边框色 = accent rgb(79, 70, 229)', okIn && ib.borderTopColor === ACC, ib);
        }
        page.on('dialog', (d) => d.dismiss().catch(() => {}));
        await page.evaluate(() => closeDimEtlPreviewModal());
      });

      // ---------- #dwdDdlModal ----------
      await sub('DWD DDL', async () => {
        await pageCallBounded(page, 'openDwdDDLModal(52)');
        check('W100 前提：#dwdDdlModal（DWD #52 DDL）已出现且根可见（含 #dwdDdlContent）', await waitShown('#dwdDdlModal', '#dwdDdlContent'));
        await aCheck('DWD DDL', '#dwdDdlModal');
        cCheck('DWD DDL', await headOf(page, '#dwdDdlModal'));
        sCheck('DWD DDL', await iconOf(page, '#dwdDdlModal'));
        const dw = await page.evaluate(() => { const m = document.getElementById('dwdDdlModal'); const lbl = document.getElementById('dwdDdlInfoLabel'); const pill = m.querySelector('h3 > span'); const g = (e) => { if (!e) return null; const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color, text: e.textContent.trim().slice(0, 12) }; }; const tabMain = document.getElementById('dwdDdlTab_main'); const tabComp = document.getElementById('dwdDdlTab_companion'); const tc = (e) => (e ? { color: getComputedStyle(e).color, bd: getComputedStyle(e).borderBottomColor } : null); return { btn: getComputedStyle(m.querySelector('button[onclick="copyDwdDdl()"]')).backgroundColor, lbl: g(lbl), pill: g(pill), tabMain: tc(tabMain), tabComp: tc(tabComp) }; });
        check('W100 ③(b) DWD DDL「复制当前脚本」按钮背景 = rgb(79, 70, 229)', dw.btn === ACC, dw);
        check('W100 P-U2 DWD DDL 标题里的更新策略胶囊、信息胶囊（表注释 / 主键）：底 rgb(238, 242, 255) 字 rgb(55, 48, 163)', !!dw.pill && dw.pill.bg === ACC_SOFT && dw.pill.color === LINK && !!dw.lbl && dw.lbl.bg === ACC_SOFT && dw.lbl.color === LINK, dw);
        check('W100 前提：#52 带伴生表（页签栏 #dwdDdlTab_main / #dwdDdlTab_companion 都在）', !!dw.tabMain && !!dw.tabComp, dw);
        check('W100 P-U2 DWD DDL 激活页签「主表 DDL」字与下边线 = accent、「伴生表 DDL」字 rgb(107, 114, 128) 下边线透明', !!dw.tabMain && dw.tabMain.color === ACC && dw.tabMain.bd === ACC && !!dw.tabComp && dw.tabComp.color === GRAY && dw.tabComp.bd === TRANSP, dw);
        // SQL 高亮语义（必须在切到伴生页签之前读：switchDwdDdlTab 用 textContent 整体替换，伴生页签内容不带高亮 span，既有行为）：字符串字面量（以 ' 开头的 token）仍是 #fbbf24
        const sq = await page.evaluate(() => { const pre = document.getElementById('dwdDdlContent'); const spans = Array.from(pre.querySelectorAll('span')).filter((s) => s.textContent.startsWith("'")); return { n: spans.length, colors: Array.from(new Set(spans.map((s) => getComputedStyle(s).color))), nSpan: pre.querySelectorAll('span').length, hl: pre.dataset.highlighted || null, head: pre.innerHTML.slice(0, 300) }; });
        check('W100 语义色保持：SQL 高亮的字符串字面量（#dwdDdlContent 里以单引号开头的 span，至少 1 个）计算字色全是 rgb(251, 191, 36)', sq.n >= 1 && sq.colors.length === 1 && sq.colors[0] === 'rgb(251, 191, 36)', sq);
        if (await clickB(page, '#dwdDdlTab_companion', 'W100 点「伴生表 DDL」页签')) {
          const t2 = await page.evaluate(() => { const tc = (e) => ({ color: getComputedStyle(e).color, bd: getComputedStyle(e).borderBottomColor }); return { main: tc(document.getElementById('dwdDdlTab_main')), comp: tc(document.getElementById('dwdDdlTab_companion')) }; });
          check('W100 P-U2 切到「伴生表 DDL」后（switchDwdDdlTab）：伴生页签字与下边线 = accent、主表页签回灰 rgb(107, 114, 128) 下边线透明', t2.comp.color === ACC && t2.comp.bd === ACC && t2.main.color === GRAY && t2.main.bd === TRANSP, t2);
        }
        await page.evaluate(() => closeDwdDdlModal());
      });

      // ---------- #dwdEtlPreviewModal ----------
      await sub('DWD ETL 预览', async () => {
        await pageCallBounded(page, 'openDwdScriptModal(52)');
        check('W100 前提：#dwdEtlPreviewModal（DWD #52 ETL）已出现且根可见', await waitShown('#dwdEtlPreviewModal'));
        await aCheck('DWD ETL 预览', '#dwdEtlPreviewModal');
        await page.evaluate(() => closeDwdEtlPreviewModal());
      });

      // ---------- #modelDrawerTestModal ----------
      await sub('验收记录弹窗', async () => {
        await pageCallBounded(page, 'viewTestRecordsReadOnly(60)');
        check('W100 前提：#modelDrawerTestModal 已出现且记录已渲染（路由替身 1 条 warn）', await page.waitForFunction(() => document.querySelectorAll('#modelDrawerTestList span').length > 0, null, { timeout: WAIT }).then(() => true, () => false));
        check('W100 前提：#modelDrawerTestModal 根可见（display 不是 none、有非零尺寸）', await waitShown('#modelDrawerTestModal'));
        await aCheck('验收记录弹窗', '#modelDrawerTestModal');
        const w = await page.evaluate(() => { const s = Array.from(document.querySelectorAll('#modelDrawerTestList span')).find((x) => x.textContent.includes('有警告')); return s ? getComputedStyle(s).color : null; });
        check('W100 语义色保持：验收记录里「通过（有警告）」字色 rgb(217, 119, 6) 仍是原琥珀值', w === 'rgb(217, 119, 6)', w);
        await page.evaluate(() => document.getElementById('modelDrawerTestModal').remove());
      });

      // ---------- #iterationHistoryModal ----------
      await sub('迭代历史弹窗', async () => {
        await pageCallBounded(page, 'viewIterationHistory(60)');
        check('W100 前提：#iterationHistoryModal 已出现且根可见', await waitShown('#iterationHistoryModal'));
        await aCheck('迭代历史弹窗', '#iterationHistoryModal');
        const it = await page.evaluate(() => { const m = document.getElementById('iterationHistoryModal'); const ver = Array.from(m.querySelectorAll('span')).filter((x) => /^v\d+$/.test(x.textContent.trim())); const fix = Array.from(m.querySelectorAll('span')).find((x) => x.children.length === 0 && x.textContent.trim() === '修复'); return { vers: ver.map((x) => x.textContent.trim() + ':' + getComputedStyle(x).color), fix: fix ? getComputedStyle(fix).color : null }; });
        check('W100 P-U2 迭代历史版本号（v2 / v1）字色 rgb(55, 48, 163)', it.vers.length === 2 && it.vers.every((s) => s.endsWith(':' + LINK)), it);
        check('W100 语义色保持：迭代历史「修复」（DATA_FIX）字色 rgb(249, 115, 22) 仍是原值', it.fix === 'rgb(249, 115, 22)', it);
        await page.evaluate(() => document.getElementById('iterationHistoryModal').remove());
      });

      // ---------- #changeLogsModal → #scriptDiffModal ----------
      await sub('变更历史弹窗与脚本对比弹窗', async () => {
        await pageCallBounded(page, 'viewModelChangeLogs(60, { readOnly: true })');
        check('W100 前提：#changeLogsModal 已出现且根可见', await waitShown('#changeLogsModal'));
        await aCheck('变更历史弹窗', '#changeLogsModal');
        const ch = await page.evaluate(() => { const m = document.getElementById('changeLogsModal'); const up = Array.from(m.querySelectorAll('span')).find((x) => x.children.length === 0 && x.textContent.trim() === '修改'); return { up: up ? getComputedStyle(up).color : null }; });
        check('W100 语义色保持：变更历史「修改」（UPDATE）字色 rgb(245, 158, 11) 仍是原值', ch.up === 'rgb(245, 158, 11)', ch);
        if (await clickB(page, '#changeLogsModal button:has-text("查看变更")', 'W100 点「查看变更」')) {
          check('W100 前提：#scriptDiffModal 已出现且根可见', await waitShown('#scriptDiffModal'));
          await aCheck('脚本对比弹窗', '#scriptDiffModal');
          await page.evaluate(() => { const d = document.getElementById('scriptDiffModal'); if (d) d.remove(); });
        }
        await page.evaluate(() => { const d = document.getElementById('changeLogsModal'); if (d) d.remove(); });
      });

      // ---------- #designNotesPopover ----------
      await sub('设计说明气泡', async () => {
        if (await clickB(page, '#modelListBody [data-id="60"] [data-entry="design-notes"]', 'W100 点 #60 的设计说明 ⓘ')) {
          check('W100 前提：#designNotesPopover 已出现且根可见', await waitShown('#designNotesPopover'));
          await aCheck('设计说明气泡', '#designNotesPopover');
          await page.evaluate(() => closeDesignNotesPopover());
        }
      });
      await page.close();
    });

    // ===== W101 子批 C4e-b：左栏焦点框对比度（C4e-a 待裁 2；accent #4f46e5 对深色左栏 #1e293b 只有 2.33:1，左栏内改用 --rail-bar #818cf8 约 4.90:1）=====
    // 它锁的是：键盘聚焦（先按一下 Shift 把输入方式切到键盘，再聚焦；前提断言 :focus-visible 成立）左栏里的一个筛选项（layer:ODS）与「未归属对象」入口，计算 outline-color = rgb(129, 140, 248)，
    //   与左栏底色（读 #catalogRail 的 backgroundColor）的 WCAG 对比度（脚本里按相对亮度公式算）≥ 3:1；390 宽折叠态聚焦折叠按钮、展开后聚焦一个筛选项，同样 rgb(129, 140, 248) 且 ≥ 3:1；
    //   列表区（表名按钮、分页按钮）与工具条搜索框聚焦仍是 accent rgb(79, 70, 229)（左栏覆盖不外溢）。焦点规则本身（C4d-b 的 var(--catalog-focus, #d97706) 那一条）不动。
    // 页内变异（首红落在本段，共 5 个）：w100-rail-focus-var-missing / w100-focus-var-on-main / w100-rail-focus-wrong-color（定义见 CAT_MUTS 末尾）；fix43 新增 2 个：w100-focus-width-rail-0（左栏内 :focus-visible 的 outline-width 写成 0） / w100-focus-width-list-0（列表区 :focus-visible 的 outline-width 写成 0）
    console.log('W101 C4e-b 左栏焦点框对比度（深色左栏内 outline = --rail-bar，列表区仍 accent）');
    await segGuard('W101', async () => {
      const RAIL_BAR = 'rgb(129, 140, 248)', ACC = 'rgb(79, 70, 229)';
      const rgbOf = (s) => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(s)); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
      const lumOf = (c) => { const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const ratio = (a, b) => { const l1 = lumOf(a), l2 = lumOf(b); const hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
      const { page } = await open(adminN, 'W101', '');
      await page.setViewportSize({ width: 1440, height: 900 });
      const readFocus = (expectSel) => page.evaluate((s) => { const a = document.activeElement; const e = document.querySelector(s); const c = a ? getComputedStyle(a) : null; const rail = document.getElementById('catalogRail'); return { same: !!e && a === e, fv: !!a && a.matches(':focus-visible'), oc: c && c.outlineColor, ow: c && c.outlineWidth, os: c && c.outlineStyle, railBg: getComputedStyle(rail).backgroundColor }; }, expectSel);
      const focusKey = async (sel, label) => { await page.keyboard.press('Shift'); const ok = await focusB(page, sel, label); return ok ? readFocus(sel) : null; };
      const railCheck = (label, f) => {
        const ok = !!f && f.same && f.fv && f.os === 'solid' && f.oc === RAIL_BAR;
        const r = f && rgbOf(f.oc) && rgbOf(f.railBg) ? ratio(rgbOf(f.oc), rgbOf(f.railBg)) : 0;
        check('W101 ' + label + '：聚焦后计算 outline-color = rgb(129, 140, 248)（前提：焦点确实在该元素上且 :focus-visible 成立、outline-style solid）', ok, f);
        check('W101 ' + label + '：焦点框色与左栏底色（读 #catalogRail 的 backgroundColor）的对比度 ≥ 3:1（WCAG 相对亮度公式）', r >= 3, { ratio: Number(r.toFixed(2)), f });
        // fix43 M1（43Tc-M1）：颜色与对比度都对、宽度被写成 0 时界面上没有可见焦点框——焦点规则写死 2px，计算 outline-width 必须 = 2px
        check('W101 ' + label + '：聚焦后计算 outline-width = 2px（焦点规则 outline: 2px solid …；前提：焦点在该元素上）', !!f && f.same && f.ow === '2px', f);
      };
      railCheck('左栏筛选项（layer:ODS）', await focusKey('#catalogRail [data-rail="layer:ODS"]', 'W101 聚焦左栏 layer:ODS'));
      railCheck('左栏「未归属对象」入口', await focusKey('#catalogRailUnowned', 'W101 聚焦未归属入口'));
      // 真实 Tab 键：从页头「＋ 注册新模型」起一路 Tab（上限 80 次，有界）走到左栏里的第一个元素，读它聚焦时的 outline-color
      await focusB(page, '#registerNewModelBtn', 'W101 聚焦页头「＋ 注册新模型」（Tab 起点）');
      let tabHit = null;
      for (let i = 0; i < 80 && !tabHit; i++) {
        await page.keyboard.press('Tab');
        tabHit = await page.evaluate(() => { const a = document.activeElement; if (!a || !a.closest || !a.closest('#catalogRail')) return null; const c = getComputedStyle(a); return { tag: a.tagName + '[' + (a.getAttribute('data-rail') || a.id || a.className) + ']', fv: a.matches(':focus-visible'), oc: c.outlineColor, ow: c.outlineWidth, os: c.outlineStyle, railBg: getComputedStyle(document.getElementById('catalogRail')).backgroundColor }; });
      }
      check('W101 真实 Tab 键：从页头「＋ 注册新模型」起连续 Tab（上限 80 次）走到左栏里的第一个元素，:focus-visible 成立、计算 outline-color = rgb(129, 140, 248)、与左栏底色对比度 ≥ 3:1', !!tabHit && tabHit.fv && tabHit.os === 'solid' && tabHit.oc === RAIL_BAR && ratio(rgbOf(tabHit.oc), rgbOf(tabHit.railBg)) >= 3, tabHit);
      check('W101 真实 Tab 键：走到的左栏第一个元素聚焦时计算 outline-width = 2px（fix43 M1）', !!tabHit && tabHit.fv && tabHit.ow === '2px', tabHit);
      // 列表区仍是 accent
      for (const [label, sel] of [['列表区表名按钮（#60 .model-open-btn）', '#modelListBody [data-id="60"] .model-open-btn'], ['分页区按钮（第 2 页）', '#paginationControls [data-w101="p2"]'], ['工具条搜索框（#searchKeyword）', '#searchKeyword']]) {
        if (sel.includes('data-w101')) await page.evaluate(() => { const b = Array.from(document.querySelectorAll('#paginationControls button')).find((x) => x.textContent.trim() === '2'); if (b) b.setAttribute('data-w101', 'p2'); });   // 测试自己打的标记（分页按钮没有稳定的 id）
        const f = await focusKey(sel, 'W101 聚焦' + label);
        check('W101 ' + label + '：聚焦后 outline-color 仍是 accent rgb(79, 70, 229)（左栏覆盖不外溢；前提：焦点在该元素上且 :focus-visible 成立）', !!f && f.same && f.fv && f.os === 'solid' && f.oc === ACC, f);
        check('W101 ' + label + '：聚焦后计算 outline-width = 2px（焦点规则写死 2px；fix43 M1）', !!f && f.same && f.ow === '2px', f);
      }
      // 390 宽：折叠按钮与展开后的筛选项
      await page.setViewportSize({ width: 390, height: 900 });
      const tg = await focusKey('.catalog-rail-toggle', 'W101 聚焦折叠按钮');
      railCheck('390 宽折叠按钮（.catalog-rail-toggle）', tg);
      await page.evaluate(() => { catalogToggleRail(); });
      const opened = await page.waitForFunction(() => document.querySelector('.catalog-rail-toggle').getAttribute('aria-expanded') === 'true', null, { timeout: WAIT }).then(() => true, () => false);
      check('W101 前提：390 宽折叠按钮点开后 aria-expanded = true', opened);
      railCheck('390 宽展开后的左栏筛选项（layer:ODS）', await focusKey('#catalogRail [data-rail="layer:ODS"]', 'W101 聚焦展开后的 layer:ODS'));
      await page.close();
    });

    // ====================================================================================================================
    // 子批 C5（W102 起）：抽屉概览补「最近验收 / 实现说明 / 设计说明」，时间线标「验收后」。
    //   后端：GET /api/models/:id 追加 acceptance { state, at, rows, stages, prevResult, reason }（逐 state 的手写期望在 verify-model-list-extras.js 的「六」里）；
    //   前端：概览 kv 末尾三行——「最近验收」按 ModelCatalogCore.acceptanceView 的 kind / text 渲染（与列表同源），后接完整时间（YYYY-MM-DD HH:MM）、stale 加「需复验」、后端 reason 另起一行、
    //   null / 缺失 / 无法识别显示「验收状态暂不可用」（不是「无验收」）；「实现说明」「设计说明」全文保留换行、一律 textContent、空显示弱字占位；companion 的「最近验收」= 随主模型、两段说明有值才显示。
    //   时间线：acceptance 的 state ∈ {pass, warn, fail, partial, stale} 且 at 可解析时，created_at 严格晚于 at 的行加「验收后」标签（同一秒不标；两边都规范化成 YYYY-MM-DD HH:MM:SS 再比），title 只说事实。
    //   判别力：每条「某状态下的样式 / 内容」断言都同时断言状态前提（抽屉属于目标模型、kv 顺序、类名 / 可见）并与值一起读（codex 43 教训）。
    // ====================================================================================================================
    const c5Rwdb = async (fn) => { const rdb = await new Promise((res, rej) => { const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (e) => (e ? rej(e) : res(d))); }); try { rdb.configure('busyTimeout', 5000); await fn(rdb); } finally { rdb.close(); } };
    const c5Wait = async (fn, ms = WAIT) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50); } return false; };
    /** 抽屉两个请求的受控替身：详情（GET /api/models/:id）按 ctl.detail[id] 补丁（函数 = 返回整对象；对象 = 合并）、变更日志（GET …/change-logs）按 ctl.logs[id] 整体替换；
     *  gateD / gateL[id] = gate()：请求到达后扣住，放行后才响应；nD / nL = 到达次数，doneD / doneL = 路由替身把响应交给页面的次数（只表示路由侧完成：页面此刻未必读完正文、更未必处理完；页面放弃请求时 fulfill 会抛错，吞掉并照样记完成） */
    const c5Stub = () => {
      const ctl = { detail: {}, logs: {}, gateD: {}, gateL: {}, nD: {}, nL: {}, doneD: {}, doneL: {} };
      const bump = (m, id) => { m[id] = (m[id] || 0) + 1; };
      const install = async (pg) => {
        await pg.route(/\/api\/models\/\d+(\?.*)?$/, async (route) => {
          const req = route.request();
          if (req.method() !== 'GET') return route.continue();
          const id = Number(new URL(req.url()).pathname.split('/').pop());
          bump(ctl.nD, id);
          if (ctl.gateD[id]) await ctl.gateD[id].p;
          try {
            const resp = await route.fetch(); const j = await resp.json();
            const p = ctl.detail[id];
            await route.fulfill({ response: resp, body: JSON.stringify(p ? (typeof p === 'function' ? p(j) : Object.assign({}, j, p)) : j) });
          } catch (e) { /* 页面已放弃该请求（导航取消）：忽略 */ }
          bump(ctl.doneD, id);
        });
        await pg.route(/\/api\/models\/\d+\/change-logs(\?.*)?$/, async (route) => {
          const req = route.request();
          if (req.method() !== 'GET') return route.continue();
          const id = Number(new URL(req.url()).pathname.split('/')[3]);
          bump(ctl.nL, id);
          if (ctl.gateL[id]) await ctl.gateL[id].p;
          try {
            if (ctl.logs[id] !== undefined) await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ctl.logs[id]) });
            else await route.continue();
          } catch (e) { /* 同上 */ }
          bump(ctl.doneL, id);
        });
      };
      return { ctl, install };
    };
    const c5Settle = (pg) => pageEvalBounded(pg, () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const c5Rendered = (page, id) => page.waitForFunction((id) => { const s = document.getElementById('modelDrawerSub'); return document.getElementById('modelDetailDrawer').classList.contains('open') && !!s && new RegExp('#' + id + '(?!\\d)').test(s.textContent) && !!document.querySelector('#modelDrawerBody .foot-links'); }, id, { timeout: WAIT }).then(() => true, () => false);
    /** 打开抽屉（先清空副标题与正文，免读到上一个抽屉的残留）；前提不成立（超时）记一条 FAIL 并返回 false */
    const c5Open = async (page, id, label) => {
      await page.evaluate(() => { const s = document.getElementById('modelDrawerSub'); if (s) s.textContent = ''; const b = document.getElementById('modelDrawerBody'); while (b && b.firstChild) b.removeChild(b.firstChild); });
      await page.evaluate((id) => { openModelDrawer(id, null); }, id);
      const ok = await c5Rendered(page, id);
      if (!ok) check(label + '：抽屉渲染到 #' + id + '（前提；超时 = 判红）', false);
      return ok;
    };
    const c5Close = async (page) => { await page.evaluate(() => { closeModelDrawer(); }); await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT }).catch(() => {}); };
    /** 读抽屉：kv 标签序列、「最近验收」行（文字 / 类名 / 计算色 / 完整时间 / 需复验徽标 / reason）、两段说明、时间线行（文字 / 验收后标签 / title）与时间线占位、危险元素计数 */
    const c5Read = (page) => page.evaluate(() => {
      const body = document.getElementById('modelDrawerBody');
      const kv0 = body.querySelector('.kv');   // 概览段的 kv（第一个）；DIM / DWD 后面的分段里还有别的 .kv，不能一起读
      const ks = kv0 ? Array.from(kv0.querySelectorAll('.k')) : [];
      const labels = ks.map((k) => k.textContent);
      const val = (label) => { const k = ks.find((e) => e.textContent === label); return k ? k.nextElementSibling : null; };
      const vis = (e) => { if (!e) return false; const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden'; };
      const accV = val('最近验收');
      let acc = null;
      if (accV) {
        const t = accV.querySelector('.mdc-acc-text'), d = accV.querySelector('.mdc-acc-date'), r = accV.querySelector('.mdc-acc-recheck'), re = accV.querySelector('.mdc-acc-reason');
        acc = { text: t ? t.textContent : null, textVisible: vis(t), cls: t ? t.className : null, color: t ? getComputedStyle(t).color : null, date: d ? d.textContent : null, dateVisible: vis(d), dateColor: d ? getComputedStyle(d).color : null, recheck: r ? r.textContent : null, recheckVisible: vis(r), recheckBg: r ? getComputedStyle(r).backgroundColor : null, recheckColor: r ? getComputedStyle(r).color : null, reason: re ? re.textContent : null, reasonVisible: vis(re), visible: vis(accV), all: accV.textContent };
      }
      const prose = (label) => {
        const v = val(label); if (!v) return null;
        const p = v.querySelector('.mdc-prose');
        if (!p) return { noProse: true, text: v.textContent };
        const c = getComputedStyle(p);
        return { text: p.textContent, inner: p.innerText, ws: c.whiteSpace, color: c.color, empty: p.classList.contains('mdc-prose-empty'), kids: p.children.length, visible: vis(p) };
      };
      const foot = body.querySelector('.foot-row');
      const host = foot ? foot.previousElementSibling : null;
      const rows = Array.from(body.querySelectorAll('.mdc-tl-row')).map((r) => { const a = r.querySelector('.mdc-tl-after'); const st = a ? getComputedStyle(a) : null; return { text: (r.querySelector('.mdc-tl-text') || {}).textContent || null, after: !!a, title: a ? a.title : null, afterText: a ? a.textContent : null, afterVisible: vis(a), afterStyle: st ? { color: st.color, bg: st.backgroundColor, bw: st.borderTopWidth, bc: st.borderTopColor } : null }; });
      const note = body.querySelector('.mdc-note');
      return { sub: (document.getElementById('modelDrawerSub') || {}).textContent, labels, acc, impl: prose('实现说明'), design: prose('设计说明'), rows, hostText: host && !host.classList.contains('mdc-timeline') ? host.textContent : null, hasTimeline: !!body.querySelector('.mdc-timeline'), note: note ? note.textContent : null, imgs: body.querySelectorAll('img').length, scripts: body.querySelectorAll('script').length, bolds: body.querySelectorAll('b').length, open: document.getElementById('modelDetailDrawer').classList.contains('open'), bodyText: body.textContent };
    });
    const C5_COLOR = { pass: 'rgb(21, 128, 61)', amber: 'rgb(180, 83, 9)', fail: 'rgb(185, 28, 28)', weak: 'rgb(148, 163, 184)', ink: 'rgb(17, 24, 39)', secondary: 'rgb(71, 85, 105)', neutralBg: 'rgb(241, 245, 249)', neutralBorder: 'rgb(226, 232, 240)' };   // 语义色（与列表同族）/ E 弱字 --color-text-muted / kv 正文色 / E --color-text-secondary（完整验收时间、「验收后」字）/ E --color-bg-elevated 与 --color-border（「验收后」底与边）
    const C5_STALE_REASON = '模型配置在最近一次验收之后已变更，请重新验收';
    const c5Acc = (state, at, extra) => Object.assign({ state, at, rows: null, stages: null, prevResult: null, reason: '' }, extra || {});
    /** 「最近验收」行逐项比对（want：text / cls / color / date / recheck（bool）/ reason）；a 缺失返回说明。codex 44Ta M1：状态文字、需复验徽标、reason 各自必须可见（计算样式 display / visibility 与非零尺寸，同一次快照读出）；期望无徽标时徽标节点必须不存在（不是「文字不等于需复验」） */
    const c5AccOk = (a, w) => !!a && a.visible && a.textVisible === true && a.text === w.text && (a.cls || '').split(' ').includes(w.cls) && a.color === w.color && a.date === w.date
      && (w.recheck ? (a.recheck === '需复验' && a.recheckVisible === true) : a.recheck === null) && a.reason === w.reason && (w.reason === null || a.reasonVisible === true)
      && (!w.recheck || (a.recheckBg === 'rgb(254, 243, 199)' && a.recheckColor === C5_COLOR.amber)) && (w.date === null || (a.dateVisible && a.dateColor === C5_COLOR.secondary));

    // ===== W102 真实服务端往返：库里写验收记录 / 配置版本 / 说明，打开抽屉，「最近验收」读后端 GET /api/models/:id 的 acceptance =====
    // 它锁的是：①抽屉的「最近验收」来自后端详情接口（不是列表数据：列表接口的 acceptance 没有 reason，所以 reason 行只有读详情才出得来），九个模型覆盖 pass / partial 缺数据 / partial 缺结构 / fail / warn / stale（上次 pass、上次 warn 各一）/ none（custom）/ companion；
    //   ②完整时间 YYYY-MM-DD HH:MM（不是 MM-DD），读次要文字色 rgb(71, 85, 105)（修复批 L5）；③三行接在现有 kv 之后（标签序列末尾）；④实现说明 / 设计说明全文取自库里真值（含换行）、空值显示占位；⑤custom 与 companion 分支同样有「最近验收」，companion 无说明时不出现两段说明行；
    //   ⑦可见性（codex 44Ta M1）：每条「最近验收」断言都读同一次快照里状态文字、需复验徽标、reason 各自的可见性（计算样式 display / visibility 与非零尺寸）；期望无徽标时徽标节点必须不存在。
    //   ⑥stale 的前缀是「上次通过」（pass → 上次通过 ✓，warn → 上次通过（有警告）!；修复批待裁 1），并补「旧版本通过 → 之后版本失败 → 再改配置」一例（#62 加一条版本 2 的失败记录并升到版本 3）：显示的是更早那条通过记录的时间，不是之后的失败。
    // 页内变异（首红落在本段）：w102-drawer-uses-list（最近验收改读列表数据）/ w102-date-mmdd（日期只显示 MM-DD）/ w102-no-reason（不显示后端 reason）/ w102-companion-no-acc（companion 不显示最近验收）/ w102-custom-no-rows（custom 不加三行）/
    //   w102-prose-no-prewrap（说明不保留换行）/ w102-no-placeholder（空实现说明不显示占位）/ w102-companion-always-notes（companion 说明为空也显示两行）/ w102-stale-no-badge（stale 不显示需复验）/ w102-stale-text-plain（stale 不加「上次通过」前缀）/ w102-recheck-accent（需复验徽标改用 accent 色）/
    //   w102-stale-old-wording（stale 前缀改回「上次结果」）/ w102-stale-warn-no-note（上次 warn 不带「（有警告）」）/ w102-date-weak（完整验收时间改回弱字灰）/ w102-recheck-hidden（需复验徽标 display:none：文字与颜色都还在，只有可见性断言能判红）/ w102-reason-hidden（reason display:none）
    console.log('W102 C5 抽屉概览三行（真实服务端往返）');
    await segGuard('W102', async () => {
      const IMPL50 = '第一步：清洗来源。\n第二步：合并；去重';
      const DES50 = '设计要点一\n设计要点二';
      const IMPL52 = '只写了实现说明';
      await c5Rwdb(async (db) => {
        const rec = (mid, time, result, phase, rev) => dbRun(db, 'INSERT INTO model_test_records (model_id, table_name, test_time, test_user, overall_result, total_rows, detail_json, invalidated, config_rev) SELECT id, table_name, ?, ?, ?, 10, ?, 0, ? FROM data_models WHERE id = ?', [time, 'w102_tester', result, JSON.stringify({ phase }), rev, mid]);
        await rec(50, '2026-10-01 09:00:00', 'pass', 'structure', 1); await rec(50, '2026-10-01 10:30:15', 'pass', 'data', 1);   // pass：最新决定记录 10:30:15
        await rec(55, '2026-10-01 09:00:00', 'pass', 'structure', 1);                                                             // partial：只有结构阶段 → 缺数据验收
        await rec(60, '2026-10-01 11:11:11', 'warn', 'data', 1);                                                                  // partial：只有数据阶段 → 缺结构验收
        await rec(52, '2026-10-03 08:00:00', 'fail', 'structure', 1); await rec(52, '2026-10-03 08:30:00', 'pass', 'data', 1);     // fail（失败优先于缺失；决定记录里最新的是 08:30:00）
        await rec(59, '2026-10-03 12:00:00', 'warn', 'all', 1);                                                                   // warn
        await dbRun(db, 'UPDATE data_models SET config_rev = 2 WHERE id IN (62, 65)');                                              // 配置版本升到 2，验收记录停在版本 1 → stale
        await rec(62, '2026-09-20 08:05:00', 'pass', 'all', 1);                                                                   // 上次结果 pass
        await rec(65, '2026-09-21 09:15:00', 'warn', 'all', 1);                                                                   // 上次结果 warn
        await dbRun(db, 'UPDATE data_models SET impl_note = ?, design_notes = ? WHERE id = 50', [IMPL50, DES50]);
        await dbRun(db, 'UPDATE data_models SET impl_note = ? WHERE id = 52', [IMPL52]);
      });
      const { page } = await open(adminN, 'W102', '');
      const CASES = [
        { id: 50, tag: 'DIM 标准 pass', tail: ['最近验收', '实现说明', '设计说明'], w: { text: '✓ 通过', cls: 'mdc-acc-pass', color: C5_COLOR.pass, date: '2026-10-01 10:30', recheck: false, reason: null }, impl: IMPL50, design: DES50 },
        { id: 55, tag: 'DIM partial 缺数据验收', tail: ['最近验收', '实现说明', '设计说明'], w: { text: '◐ 缺数据验收', cls: 'mdc-acc-partial', color: C5_COLOR.amber, date: '2026-10-01 09:00', recheck: false, reason: '缺少数据阶段验收' }, impl: null, design: null },
        { id: 60, tag: 'DIM partial 缺结构验收', tail: ['最近验收', '实现说明', '设计说明'], w: { text: '◐ 缺结构验收', cls: 'mdc-acc-partial', color: C5_COLOR.amber, date: '2026-10-01 11:11', recheck: false, reason: '缺少结构阶段验收' }, impl: null, design: null },
        { id: 52, tag: 'DWD fail', tail: ['最近验收', '实现说明', '设计说明'], w: { text: '✕ 未通过', cls: 'mdc-acc-fail', color: C5_COLOR.fail, date: '2026-10-03 08:30', recheck: false, reason: '最近一次验收未通过' }, impl: IMPL52, design: null },
        { id: 59, tag: 'DWD warn', tail: ['最近验收', '实现说明', '设计说明'], w: { text: '! 有警告', cls: 'mdc-acc-warn', color: C5_COLOR.amber, date: '2026-10-03 12:00', recheck: false, reason: null }, impl: null, design: null },
        { id: 62, tag: 'DIM stale（上次 pass）', tail: ['最近验收', '实现说明', '设计说明'], w: { text: '上次通过 ✓', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: '2026-09-20 08:05', recheck: true, reason: C5_STALE_REASON }, impl: null, design: null },
        { id: 65, tag: 'DIM stale（上次 warn）', tail: ['最近验收', '实现说明', '设计说明'], w: { text: '上次通过（有警告）!', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: '2026-09-21 09:15', recheck: true, reason: C5_STALE_REASON }, impl: null, design: null },
        { id: 58, tag: 'custom（手工脚本）none', tail: ['最近验收', '实现说明', '设计说明'], note: '手工脚本模式', w: { text: '无验收', cls: 'mdc-acc-none', color: C5_COLOR.weak, date: null, recheck: false, reason: '尚无验收记录' }, impl: null, design: '123' },
        { id: 53, tag: 'companion（无说明）', tail: ['最近验收'], note: '变更追踪伴生表', w: { text: '随主模型', cls: 'mdc-acc-companion', color: C5_COLOR.weak, date: null, recheck: false, reason: '伴生表不独立验收' }, impl: undefined, design: undefined },
      ];
      for (const c of CASES) {
        if (!(await c5Open(page, c.id, 'W102 #' + c.id))) continue;
        const r = await c5Read(page);
        const lbl = r.labels;
        check(`W102 #${c.id}（${c.tag}）：前提——抽屉属于 #${c.id}、${c.note ? '分支提示含「' + c.note + '」、' : ''}kv 末尾 ${c.tail.length} 个标签依次为 ${J(c.tail)}、且它们之前还有原有的行（接在现有 kv 之后）`,
          new RegExp('#' + c.id + '(?!\\d)').test(r.sub || '') && r.open && (!c.note || (r.note || '').includes(c.note)) && J(lbl.slice(-c.tail.length)) === J(c.tail) && lbl.length > c.tail.length && !lbl.slice(0, -c.tail.length).includes('最近验收'), { sub: r.sub, labels: lbl, note: r.note });
        check(`W102 #${c.id}（${c.tag}）：「最近验收」文字 = ${c.w.text}、类名含 ${c.w.cls}、计算色 ${c.w.color}、完整时间 = ${c.w.date}、需复验 = ${c.w.recheck}、reason = ${J(c.w.reason)}（逐项手写期望；reason 只有读后端详情才有）`, c5AccOk(r.acc, c.w), r.acc);
        if (c.impl === undefined) {
          check(`W102 #${c.id}（${c.tag}）：两段说明都为空 → 不出现「实现说明」「设计说明」两行（伴生）`, r.impl === null && r.design === null, { impl: r.impl, design: r.design });
        } else {
          const okImpl = c.impl === null ? (!!r.impl && r.impl.empty && r.impl.text === '（未填写实现说明）') : (!!r.impl && !r.impl.empty && r.impl.text === c.impl && r.impl.inner === c.impl && r.impl.ws === 'pre-wrap');
          const okDes = c.design === null ? (!!r.design && r.design.empty && r.design.text === '（未填写设计说明）') : (!!r.design && !r.design.empty && r.design.text === c.design && r.design.inner === c.design && r.design.ws === 'pre-wrap');
          check(`W102 #${c.id}（${c.tag}）：「实现说明」= ${J(c.impl === null ? '（未填写实现说明）' : c.impl)}、「设计说明」= ${J(c.design === null ? '（未填写设计说明）' : c.design)}（库里真值全文，换行原样；空值是弱字占位）`, okImpl && okDes, { impl: r.impl, design: r.design });
        }
        await c5Close(page);
      }
      // 修复批待裁 1：旧版本（1）通过 → 之后版本（2）失败 → 再改配置（3）。后端 stale 的 at / prevResult 取更早版本里最后一条通过记录（09-20 08:05 · pass），其后的失败（09-25）不能被说成「上次结果」；
      //   抽屉要显示「上次通过 ✓」与通过那条的时间，整行文字里没有失败记录的日期。库里给 #62 加一条版本 2 的 fail 记录并把配置版本升到 3。
      await c5Rwdb(async (db) => {
        await dbRun(db, 'INSERT INTO model_test_records (model_id, table_name, test_time, test_user, overall_result, total_rows, detail_json, invalidated, config_rev) SELECT id, table_name, ?, ?, ?, 10, ?, 0, ? FROM data_models WHERE id = ?', ['2026-09-25 10:00:00', 'w102_tester', 'fail', JSON.stringify({ phase: 'all' }), 2, 62]);
        await dbRun(db, 'UPDATE data_models SET config_rev = 3 WHERE id = 62');
      });
      if (await c5Open(page, 62, 'W102 #62（通过后又失败再改配置）')) {
        const r = await c5Read(page);
        const TL = ['最近验收', '实现说明', '设计说明'];
        check('W102 #62（通过后又失败再改配置）：前提——抽屉属于 #62、kv 末尾依次 ' + J(TL) + '、「最近验收」行可见', /#62(?!\d)/.test(r.sub || '') && r.open && J(r.labels.slice(-3)) === J(TL) && !!r.acc && r.acc.visible, { sub: r.sub, labels: r.labels });
        check('W102 #62（通过后又失败再改配置）：「最近验收」= 上次通过 ✓、类名含 mdc-acc-stale、完整时间 = 2026-09-20 08:05（更早那条通过记录，不是 09-25 的失败）、需复验、reason = 后端 stale 文案；整行文字里没有「09-25」', c5AccOk(r.acc, { text: '上次通过 ✓', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: '2026-09-20 08:05', recheck: true, reason: C5_STALE_REASON }) && !r.acc.all.includes('09-25'), r.acc);
        await c5Close(page);
      }
      await page.close();
    });

    // ===== W103 逐 state 的「最近验收」行（路由替身给详情的 acceptance；列表是真实数据（#55 在 W102 里被写成 partial·缺数据，时间 09:00），与替身给的详情逐态不同）=====
    // 它锁的是：每种 state（pass / warn / fail / partial 缺数据·缺结构 / stale 上次 pass·warn·无 / none / none 带 at / companion / null / 键缺失 / 无法识别的 state）下，「最近验收」行的文字、类名、计算色、完整时间、需复验徽标（语义琥珀底，不是 accent）、reason；
    //   null / 缺失 / 无法识别显示「验收状态暂不可用」（不是「无验收」）；none 与 companion 不显示时间。每条都先断言前提（抽屉属于 #55、kv 末尾三行顺序、行可见）。
    //   末例（修复批 2 LOW-5）：stale 但 prevResult = fail（acceptanceView 识别不了、抽屉显示「验收状态暂不可用」）时，时间线也不标「验收后」——两处口径一致（markAt 跟随 acceptanceView）。
    // 页内变异（首红落在本段）：w103-null-as-none（null 显示成「无验收」）/ w103-unknown-throws（无法识别的 state 抛出，抽屉渲染失败）/ w103-none-shows-date（none 带 at 也显示时间）/ w103-markat-ignores-view（markAt 不看 acceptanceView 能否识别）
    console.log('W103 C5 逐 state 的最近验收行');
    await segGuard('W103', async () => {
      const stub = c5Stub();
      const { page } = await open(adminN, 'W103', '', { beforeGoto: stub.install });
      const TAIL = ['最近验收', '实现说明', '设计说明'];
      const DATE = '2026-10-01 10:30'; const AT = '2026-10-01 10:30:15';
      const CASES = [
        { tag: 'pass', acc: c5Acc('pass', AT, { rows: 10, stages: { structure: 'pass', data: 'pass' } }), w: { text: '✓ 通过', cls: 'mdc-acc-pass', color: C5_COLOR.pass, date: DATE, recheck: false, reason: null } },
        { tag: 'warn', acc: c5Acc('warn', AT, { rows: 10, stages: { structure: 'pass', data: 'warn' } }), w: { text: '! 有警告', cls: 'mdc-acc-warn', color: C5_COLOR.amber, date: DATE, recheck: false, reason: null } },
        { tag: 'fail', acc: c5Acc('fail', AT, { stages: { structure: 'fail', data: 'pass' }, reason: '最近一次验收未通过' }), w: { text: '✕ 未通过', cls: 'mdc-acc-fail', color: C5_COLOR.fail, date: DATE, recheck: false, reason: '最近一次验收未通过' } },
        { tag: 'partial 缺数据', acc: c5Acc('partial', AT, { stages: { structure: 'pass', data: null }, reason: '缺少数据阶段验收' }), w: { text: '◐ 缺数据验收', cls: 'mdc-acc-partial', color: C5_COLOR.amber, date: DATE, recheck: false, reason: '缺少数据阶段验收' } },
        { tag: 'partial 缺结构', acc: c5Acc('partial', AT, { stages: { structure: null, data: 'warn' }, reason: '缺少结构阶段验收' }), w: { text: '◐ 缺结构验收', cls: 'mdc-acc-partial', color: C5_COLOR.amber, date: DATE, recheck: false, reason: '缺少结构阶段验收' } },
        { tag: 'stale 上次 pass', acc: c5Acc('stale', AT, { prevResult: 'pass', reason: C5_STALE_REASON }), w: { text: '上次通过 ✓', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: DATE, recheck: true, reason: C5_STALE_REASON } },
        { tag: 'stale 上次 warn', acc: c5Acc('stale', AT, { prevResult: 'warn', reason: C5_STALE_REASON }), w: { text: '上次通过（有警告）!', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: DATE, recheck: true, reason: C5_STALE_REASON } },
        { tag: 'stale 上次结果缺失', acc: c5Acc('stale', AT, { prevResult: null, reason: C5_STALE_REASON }), w: { text: '上次通过 —', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: DATE, recheck: true, reason: C5_STALE_REASON } },
        { tag: 'none', acc: c5Acc('none', null, { reason: '尚无验收记录' }), w: { text: '无验收', cls: 'mdc-acc-none', color: C5_COLOR.weak, date: null, recheck: false, reason: '尚无验收记录' } },
        { tag: 'none 但带 at（不显示时间）', acc: c5Acc('none', AT, { reason: '该分层暂无验收判定规则' }), w: { text: '无验收', cls: 'mdc-acc-none', color: C5_COLOR.weak, date: null, recheck: false, reason: '该分层暂无验收判定规则' } },
        { tag: 'companion', acc: c5Acc('companion', AT, { reason: '伴生表不独立验收' }), w: { text: '随主模型', cls: 'mdc-acc-companion', color: C5_COLOR.weak, date: null, recheck: false, reason: '伴生表不独立验收' } },
        { tag: 'acceptance = null', acc: null, w: { text: '验收状态暂不可用', cls: 'mdc-acc-unknown', color: C5_COLOR.weak, date: null, recheck: false, reason: null } },
        { tag: 'acceptance 键缺失', acc: undefined, w: { text: '验收状态暂不可用', cls: 'mdc-acc-unknown', color: C5_COLOR.weak, date: null, recheck: false, reason: null } },
        { tag: '无法识别的 state', acc: c5Acc('bogus', AT, { reason: '桩' }), w: { text: '验收状态暂不可用', cls: 'mdc-acc-unknown', color: C5_COLOR.weak, date: null, recheck: false, reason: null } },
      ];
      for (const c of CASES) {
        stub.ctl.detail[55] = c.acc === undefined ? (j) => { const o = Object.assign({}, j); delete o.acceptance; return o; } : { acceptance: c.acc };
        if (!(await c5Open(page, 55, 'W103 ' + c.tag))) continue;
        const r = await c5Read(page);
        check(`W103 ${c.tag}：前提——抽屉属于 #55、kv 末尾依次 ${J(TAIL)}、「最近验收」行可见（改用列表数据的实现读到的是库里的 partial·09:00，与替身给的详情不同）`, new RegExp('#55(?!\\d)').test(r.sub || '') && r.open && J(r.labels.slice(-3)) === J(TAIL) && !!r.acc && r.acc.visible, { sub: r.sub, labels: r.labels, acc: r.acc && r.acc.visible });
        check(`W103 ${c.tag}：文字 = ${c.w.text}、类名含 ${c.w.cls}、计算色 ${c.w.color}、完整时间 = ${c.w.date}、需复验 = ${c.w.recheck}${c.w.recheck ? '（底 rgb(254, 243, 199)、字 rgb(180, 83, 9)，不是 accent）' : ''}、reason = ${J(c.w.reason)}`, c5AccOk(r.acc, c.w), r.acc);
        if (c.tag === 'acceptance = null' || c.tag === 'acceptance 键缺失' || c.tag === '无法识别的 state') check(`W103 ${c.tag}：显示「验收状态暂不可用」而不是「无验收」（整行文字里没有「无验收」）`, !!r.acc && !r.acc.all.includes('无验收'), r.acc);
        await c5Close(page);
      }
      // 修复批 2 LOW-5：stale 且 prevResult = fail（脏数据）→ acceptanceView 抛错 → 抽屉「验收状态暂不可用」；时间线（有一条晚于 at 的变更日志）也不能标「验收后」
      {
        stub.ctl.detail[55] = { acceptance: c5Acc('stale', AT, { prevResult: 'fail', reason: C5_STALE_REASON }) };
        stub.ctl.logs[55] = [{ id: 501, model_id: 55, change_type: 'dim_config', change_summary: 'W103 晚于验收的日志', operator_name: '甲', created_at: '2026-10-02 00:00:00' }];
        const nL0 = stub.ctl.nL[55] || 0;
        if (await c5Open(page, 55, 'W103 stale 且 prevResult = fail')) {
          const got = await page.waitForFunction(() => document.querySelectorAll('#modelDrawerBody .mdc-tl-row').length === 1, null, { timeout: WAIT }).then(() => true, () => false);
          const r = await c5Read(page);
          check('W103 stale 且 prevResult = fail：前提——抽屉属于 #55、变更日志请求发出过、时间线 1 行（日志时间晚于 at）、「最近验收」行可见且 = 验收状态暂不可用（类名含 mdc-acc-unknown）', new RegExp('#55(?!\\d)').test(r.sub || '') && (stub.ctl.nL[55] || 0) > nL0 && got && !!r.acc && r.acc.visible && r.acc.text === '验收状态暂不可用' && (r.acc.cls || '').split(' ').includes('mdc-acc-unknown'), { sub: r.sub, got, acc: r.acc });
          check('W103 stale 且 prevResult = fail：时间线那一行没有「验收后」标签（markAt 与「最近验收」同口径：识别不了就不标；晚于 at 的日志在 state = stale 且识别得了时是会标的）', r.rows.length === 1 && r.rows[0].after === false, r.rows);
          await c5Close(page);
        }
      }
      await page.close();
    });

    // ===== W104 实现说明 / 设计说明：全文换行、空占位、三个分支 =====
    // 它锁的是：说明全文原样显示（textContent 与 innerText 都 = 原文，含空行；计算样式 white-space = pre-wrap）；空 / null / 纯空白显示弱字占位（（未填写实现说明）/（未填写设计说明），计算色 = E 弱字 rgb(148, 163, 184)，有值时是正文色 rgb(17, 24, 39)）；
    //   主模型（DIM #50）、custom（#58）、DWD（#52）、ODS（#6）都有三行；companion（#53）说明全空 → 只有「最近验收」，只有实现说明 → 加实现说明，只有设计说明 → 加设计说明，都有 → 三行。每条先断言抽屉属于目标模型与分支提示。
    // 页内变异（首红落在本段）：w104-empty-not-weak（空占位不是弱字色）/ w104-companion-never-notes（companion 有说明也不显示）/ w104-ods-no-rows（ODS 不加三行）/ w104-prose-trimmed（非空说明显示 trim 后的字符串：首尾空白丢失）
    console.log('W104 C5 实现说明 / 设计说明（全文换行、空占位、三个分支）');
    await segGuard('W104', async () => {
      const stub = c5Stub();
      const { page } = await open(adminN, 'W104', '', { beforeGoto: async (pg) => { await stub.install(pg); await pg.route('**/api/models/6/metadata*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })); } });
      const RAW_I = '第一行：清洗来源\n第二行；合并，\n\n第四行（空一行之后）';
      const RAW_D = '设计一\n设计二';
      const nodeOf = (c, r) => (c.layerNote ? (r.note || '').includes(c.layerNote) : true);
      const CASES = [
        { id: 50, tag: 'DIM 主模型', patch: { impl_note: RAW_I, design_notes: RAW_D }, tail: ['最近验收', '实现说明', '设计说明'], impl: RAW_I, design: RAW_D },
        { id: 55, tag: 'DIM 主模型：impl = null、design = 空串', patch: { impl_note: null, design_notes: '' }, tail: ['最近验收', '实现说明', '设计说明'], impl: null, design: null },
        { id: 55, tag: 'DIM 主模型：impl = 纯空白、design = null', patch: { impl_note: '   \n ', design_notes: null }, tail: ['最近验收', '实现说明', '设计说明'], impl: null, design: null },
        { id: 58, tag: 'custom 分支', patch: { impl_note: RAW_I, design_notes: RAW_D }, tail: ['最近验收', '实现说明', '设计说明'], impl: RAW_I, design: RAW_D, layerNote: '手工脚本模式' },
        { id: 52, tag: 'DWD 主模型', patch: { impl_note: '只有实现说明', design_notes: null }, tail: ['最近验收', '实现说明', '设计说明'], impl: '只有实现说明', design: null },
        { id: 6, tag: 'ODS 主模型', patch: { impl_note: RAW_I, design_notes: RAW_D }, tail: ['最近验收', '实现说明', '设计说明'], impl: RAW_I, design: RAW_D },
        { id: 53, tag: 'companion：两段都空', patch: { impl_note: null, design_notes: '' }, tail: ['最近验收'], impl: undefined, design: undefined, layerNote: '变更追踪伴生表' },
        { id: 53, tag: 'companion：只有实现说明', patch: { impl_note: RAW_I, design_notes: null }, tail: ['最近验收', '实现说明'], impl: RAW_I, design: undefined, layerNote: '变更追踪伴生表' },
        { id: 53, tag: 'companion：只有设计说明', patch: { impl_note: '  ', design_notes: RAW_D }, tail: ['最近验收', '设计说明'], impl: undefined, design: RAW_D, layerNote: '变更追踪伴生表' },
        { id: 53, tag: 'companion：两段都有', patch: { impl_note: RAW_I, design_notes: RAW_D }, tail: ['最近验收', '实现说明', '设计说明'], impl: RAW_I, design: RAW_D, layerNote: '变更追踪伴生表' },
        // —— codex 44Ta L1：非空说明带前导空格 / 首尾换行 / 末尾空格时原样保留（trim 只用于判空，不用于显示）；textContent 逐字等于原文（innerText 对首尾空白的折叠随浏览器，不比）
        { id: 50, tag: 'DIM 主模型：前导空格 + 末尾空格', patch: { impl_note: '   前导三个空格的实现说明', design_notes: '末尾两个空格的设计说明  ' }, tail: ['最近验收', '实现说明', '设计说明'], impl: '   前导三个空格的实现说明', design: '末尾两个空格的设计说明  ', skipInner: true },
        { id: 52, tag: 'DWD 主模型：首尾换行', patch: { impl_note: '\n首尾换行的实现说明\n', design_notes: '\n\n前有两个换行的设计说明' }, tail: ['最近验收', '实现说明', '设计说明'], impl: '\n首尾换行的实现说明\n', design: '\n\n前有两个换行的设计说明', skipInner: true },
        { id: 53, tag: 'companion：前导空白 / 首尾换行 / 末尾空格（两段都有）', patch: { impl_note: '  \t前导空白后才有字\n', design_notes: '\n首尾换行与末尾空格 \n' }, tail: ['最近验收', '实现说明', '设计说明'], impl: '  \t前导空白后才有字\n', design: '\n首尾换行与末尾空格 \n', layerNote: '变更追踪伴生表', skipInner: true },
      ];
      const proseOk = (p, want, emptyText, skipInner) => {
        if (want === undefined) return p === null;
        if (want === null) return !!p && p.empty && p.text === emptyText && p.color === C5_COLOR.weak && p.visible && p.kids === 0;
        return !!p && !p.empty && p.text === want && (skipInner || p.inner === want) && p.ws === 'pre-wrap' && p.color === C5_COLOR.ink && p.visible && p.kids === 0;
      };
      for (const c of CASES) {
        stub.ctl.detail[c.id] = c.patch;
        if (!(await c5Open(page, c.id, 'W104 ' + c.tag))) continue;
        const r = await c5Read(page);
        check(`W104 #${c.id} ${c.tag}：前提——抽屉属于 #${c.id}${c.layerNote ? '、分支提示含「' + c.layerNote + '」' : ''}、kv 末尾标签 = ${J(c.tail)}`, new RegExp('#' + c.id + '(?!\\d)').test(r.sub || '') && r.open && nodeOf(c, r) && J(r.labels.slice(-c.tail.length)) === J(c.tail) && !r.labels.slice(0, -c.tail.length).includes('最近验收'), { sub: r.sub, labels: r.labels, note: r.note });
        check(`W104 #${c.id} ${c.tag}：「实现说明」${c.impl === undefined ? '不显示' : c.impl === null ? '显示弱字占位（（未填写实现说明）、rgb(148, 163, 184)）' : '全文原样（textContent 等于原文；首尾空白用例以外 innerText 也等于原文；white-space: pre-wrap、正文色 rgb(17, 24, 39)）'}；「设计说明」${c.design === undefined ? '不显示' : c.design === null ? '显示弱字占位（（未填写设计说明））' : '全文原样'}`,
          proseOk(r.impl, c.impl, '（未填写实现说明）', c.skipInner) && proseOk(r.design, c.design, '（未填写设计说明）', c.skipInner), { impl: r.impl, design: r.design });
        await c5Close(page);
      }
      await page.close();
    });

    // ===== W105 说明与 reason 里的 HTML 载荷以字面文本显示、不执行（方案 §4.3 / §7.1 抽屉）=====
    // 它锁的是：实现说明 / 设计说明 / 后端 reason 含 <img src=x onerror=…>、<script>、<b> 时，抽屉里显示的是字面文本，没有产生 img / script / b 元素，onerror 没有执行（window.__xss 保持 undefined）；
    //   主模型（#50，含 reason）、custom（#58）、companion（#53）三个分支各一份。前提：抽屉属于目标模型、载荷文本确实出现在抽屉里（否则「没有 img 元素」是空断言）。
    // 页内变异（首红落在本段）：w105-prose-innerhtml（说明全文改用 innerHTML）/ w105-reason-innerhtml（reason 改用 innerHTML）
    console.log('W105 C5 说明 / reason 的 HTML 载荷');
    await segGuard('W105', async () => {
      const stub = c5Stub();
      const { page } = await open(adminN, 'W105', '', { beforeGoto: stub.install });
      const P_IMG = '<img src=x onerror="window.__xss=1">';
      const P_DES = '<script>window.__xss=2</script><b>粗体</b>';
      const P_REASON = '<img src=x onerror="window.__xss=3">&lt;i&gt;';
      const CASES = [
        { id: 50, tag: '主模型（含 reason 载荷）', patch: { impl_note: P_IMG, design_notes: P_DES, acceptance: c5Acc('fail', '2026-10-01 10:30:15', { stages: { structure: 'fail', data: 'pass' }, reason: P_REASON }) }, wantReason: P_REASON, tail: ['最近验收', '实现说明', '设计说明'] },
        { id: 58, tag: 'custom', patch: { impl_note: P_IMG, design_notes: P_DES }, wantReason: null, tail: ['最近验收', '实现说明', '设计说明'] },
        { id: 53, tag: 'companion', patch: { impl_note: P_IMG, design_notes: P_DES }, wantReason: null, tail: ['最近验收', '实现说明', '设计说明'] },
      ];
      for (const c of CASES) {
        stub.ctl.detail[c.id] = c.patch;
        await page.evaluate(() => { delete window.__xss; });   // 修复批 L2：每个用例开始前重置标记，否则上一用例留下的 __xss 会让本用例的失败记到错误的归因上
        if (!(await c5Open(page, c.id, 'W105 ' + c.tag))) continue;
        await c5Settle(page);
        await page.waitForTimeout(400);   // 「不应发生」的断言只能等一小段：<img onerror> 的失败回调是异步的，没有可等的正向信号（W105 的 img 在正确实现里根本不存在）；窗口 400ms 只用来抬高变异版（img 存在）漏判的门槛，变异版的判红另有 imgs / scripts / bolds 元素计数这条不依赖时间的断言兜底
        const r = await c5Read(page);
        const xss = await page.evaluate(() => (typeof window.__xss === 'undefined' ? null : window.__xss));
        check(`W105 #${c.id} ${c.tag}：前提——抽屉属于 #${c.id}、kv 末尾 = ${J(c.tail)}、载荷文本确实在抽屉里（说明两段与${c.wantReason ? ' reason' : '（无 reason）'}）`, new RegExp('#' + c.id + '(?!\\d)').test(r.sub || '') && J(r.labels.slice(-3)) === J(c.tail) && !!r.impl && r.impl.text === P_IMG && !!r.design && r.design.text === P_DES && (c.wantReason === null || (!!r.acc && r.acc.reason === c.wantReason)), { sub: r.sub, impl: r.impl && r.impl.text, design: r.design && r.design.text, reason: r.acc && r.acc.reason });
        check(`W105 #${c.id} ${c.tag}：字面文本显示（textContent 原样）、抽屉里没有 img / script / b 元素、onerror 没有执行（window.__xss 仍未定义）`, r.imgs === 0 && r.scripts === 0 && r.bolds === 0 && xss === null, { imgs: r.imgs, scripts: r.scripts, bolds: r.bolds, xss });
        await c5Close(page);
      }
      await page.close();
    });

    // ===== W106 时间线「验收后」标记 =====
    // 它锁的是：acceptance 的 state ∈ {pass, warn, fail, partial, stale} 且 at 可解析时，created_at **严格晚于** at 的变更日志行加「验收后」标签（title =「发生在最近一次验收（YYYY-MM-DD HH:MM）之后」，stale 时是「发生在上次通过的验收（…）之后」，不写「配置变更」；标签是中性样式：E 的 --color-bg-elevated 底 + --color-text-secondary 字 + 1px --color-border 边，不是警示琥珀；修复批待裁 1 / 3），
    //   早于 / 同一秒的不标；none（含带 at 的 none）/ companion（含真实 #53）/ null / 无法识别的 state / at 为空或乱串时不标；stale 的 at 是更早版本那条记录的时间，它之后的日志都标；
    //   created_at 用 'T' 分隔、缺失、乱串时先规范化再比、解析不了不标（两边规范化后才可比）。codex 44：规范化是整串严格解析 + 范围校验——2026-02-30 / 25 点 / 垃圾后缀 / 非闰年 2 月 29 日在日志侧与验收侧都不可比、不标；闰年 2024-02-29 合法；验收侧也覆盖 T / 小数秒 / Z / 偏移量（墙上时间相同，覆盖同秒 / 早一秒 / 晚一秒，后缀不换算）；
    //   CASES 循环的前提断言同时读同一次 c5Read 的「最近验收」，等于手写展示期望（null / 无法识别 = 暂不可用，companion = 随主模型）。每条先断言前提（抽屉属于目标模型、时间线行已到齐且行文字与手写序一致）。
    //   末段「请求顺序」：扣住 #50 详情请求时变更日志请求次数为 0（时间线只在详情渲染里发起），放行详情之后才出现且只发一次——防将来改成两者并行发起时，标记在详情到达前就被画（修复批待裁 2；原派单「不等两个请求都到就画标记」的变异在现有结构里做不出来，改成这条顺序约束）。
    // 页内变异（首红落在本段）：w106-tl-ge（改成 >=，同一秒也标）/ w106-mark-all-states（不看 state，none 带 at 也标）/ w106-no-normalize（不规范化直接比原串）/ w106-tl-title-config（title 写成「配置变更」）/
    //   w106-tl-title-stale-recent（stale 时 title 仍说「最近一次验收」）/ w106-after-amber（「验收后」改回警示琥珀）/ w106-parallel-timeline（详情请求发出的同时并行发起变更日志请求）/
    //   codex 44：w106-normtime-prefix-only（规范化恢复前缀匹配：垃圾后缀被当成可比较时间）/ w106-normtime-no-range（去掉日期 / 时分秒范围校验：2026-02-30、25 点被当成可比较时间）/ w106-normtime-convert-zone（把 Z / 偏移量后缀按时区换算，而不是直接丢掉）
    console.log('W106 C5 时间线「验收后」标记');
    await segGuard('W106', async () => {
      const stub = c5Stub();
      const { page } = await open(adminN, 'W106', '', { beforeGoto: stub.install });
      const LOG = (id, at, type, text, op) => ({ id, model_id: 50, model_name: 'x', action: 'UPDATE', change_type: type, before_value: null, after_value: null, change_summary: text, operator_id: 1, operator_name: op, created_at: at });
      const LOGS = [LOG(105, '2026-10-02 00:00:00', 'basic_info', '次日变更', '甲'), LOG(104, '2026-10-01 10:00:01', 'dim_config', '晚一秒', '乙'), LOG(103, '2026-10-01 10:00:00', 'dim_config', '同一秒', '丙'), LOG(102, '2026-10-01 09:59:59', 'basic_info', '早一秒', '丁'), LOG(101, '2026-09-30 23:59:59', 'script_edit', '前一天', '戊')];
      const TXT = ['次日变更（甲）', '晚一秒（乙）', '同一秒（丙）', '早一秒（丁）', '前一天（戊）'];
      const LOGS_T = [LOG(204, '2026-10-01T10:00:05', 'dim_config', '晚五秒T', '甲'), LOG(203, '2026-10-01T09:00:00', 'dim_config', '早一小时T', '乙'), LOG(202, null, 'basic_info', '无时间', '丙'), LOG(201, 'not-a-time', 'basic_info', '乱串', '丁')];
      const TXT_T = ['晚五秒T（甲）', '早一小时T（乙）', '无时间（丙）', '乱串（丁）'];
      const AT = '2026-10-01 10:00:00';
      const T_AFTER = (at) => '发生在最近一次验收（' + at.slice(0, 16) + '）之后';
      const T_AFTER_STALE = (at) => '发生在上次通过的验收（' + at.slice(0, 16) + '）之后';   // stale 的 at 是更早版本里最后一条通过 / 有警告记录的时间，其后可能还有失败记录
      // —— codex 44（M1 / 44Tb M1）新增的日志夹具：非法时间（日志侧）、闰年、验收侧的各种时间格式（两侧墙上时间相同，覆盖同秒 / 早一秒 / 晚一秒）。期望全部手写，不复用被测的规范化逻辑
      const AT_B = '2025-02-28 00:00:00';
      const LOGS_BAD = [LOG(705, '2025-03-01 00:00:00', 'basic_info', '合法晚于验收', '甲'), LOG(704, '2025-02-29 08:00:00', 'dim_config', '非闰年2月29日', '乙'), LOG(703, '2026-10-11 12:00:00垃圾', 'dim_config', '垃圾后缀', '丙'), LOG(702, '2026-10-11 25:00:00', 'basic_info', '时25点', '丁'), LOG(701, '2026-02-30 12:00:00', 'script_edit', '2月30日', '戊')];
      const TXT_BAD = ['合法晚于验收（甲）', '非闰年2月29日（乙）', '垃圾后缀（丙）', '时25点（丁）', '2月30日（戊）'];
      const AT_L = '2024-02-29 08:00:00';
      const LOGS_L = [LOG(804, '2024-03-01 00:00:00', 'basic_info', '闰年次日', '甲'), LOG(803, '2024-02-29 08:00:01', 'dim_config', '闰年晚一秒', '乙'), LOG(802, '2024-02-29 08:00:00', 'dim_config', '闰年同一秒', '丙'), LOG(801, '2024-02-29 07:59:59', 'basic_info', '闰年早一秒', '丁')];
      const TXT_L = ['闰年次日（甲）', '闰年晚一秒（乙）', '闰年同一秒（丙）', '闰年早一秒（丁）'];
      const LOGS_LATE = [LOG(601, '2027-06-01 00:00:00', 'basic_info', '远晚于验收', '甲')];   // 验收侧非法时间的用例用：日志合法且远晚于任何「前缀可解析」的验收时间，前缀匹配 / 无范围校验的实现会标「验收后」
      const TXT_LATE = ['远晚于验收（甲）'];
      const LOGS_F = [LOG(903, '2026-10-01 10:00:01', 'dim_config', '晚一秒F', '甲'), LOG(902, '2026-10-01 10:00:00', 'dim_config', '同一秒F', '乙'), LOG(901, '2026-10-01 09:59:59', 'basic_info', '早一秒F', '丙')];
      const TXT_F = ['晚一秒F（甲）', '同一秒F（乙）', '早一秒F（丙）'];
      const LOGS_FS = [LOG(913, '2026-10-01T10:00:01.5Z', 'dim_config', '晚一秒FS', '甲'), LOG(912, '2026-10-01 10:00:00+09:00', 'dim_config', '同一秒FS', '乙'), LOG(911, '2026-10-01T09:59:59-0700', 'basic_info', '早一秒FS', '丙')];   // 日志侧也带 T / 小数秒 / Z / 偏移量：墙上时间与 LOGS_F 相同
      const TXT_FS = ['晚一秒FS（甲）', '同一秒FS（乙）', '早一秒FS（丙）'];
      // 手写的验收展示期望（codex 44Tb L2：CASES 的前提断言要读同一次 c5Read 的「最近验收」，证明用例确实处在它声称的验收状态）
      const WPASS = (date) => ({ text: '✓ 通过', cls: 'mdc-acc-pass', color: C5_COLOR.pass, date, recheck: false, reason: null });
      const WUNK = { text: '验收状态暂不可用', cls: 'mdc-acc-unknown', color: C5_COLOR.weak, date: null, recheck: false, reason: null };
      const CASES = [
        { id: 50, tag: 'pass：只标次日 / 晚一秒（同一秒、早一秒、前一天不标）', acc: c5Acc('pass', AT), w: WPASS('2026-10-01 10:00'), logs: LOGS, txt: TXT, marked: { '次日变更（甲）': T_AFTER(AT), '晚一秒（乙）': T_AFTER(AT) } },
        { id: 50, tag: 'warn 同口径', acc: c5Acc('warn', AT), w: { text: '! 有警告', cls: 'mdc-acc-warn', color: C5_COLOR.amber, date: '2026-10-01 10:00', recheck: false, reason: null }, logs: LOGS, txt: TXT, marked: { '次日变更（甲）': T_AFTER(AT), '晚一秒（乙）': T_AFTER(AT) } },
        { id: 50, tag: 'fail 同口径', acc: c5Acc('fail', AT, { stages: { structure: 'fail', data: 'pass' }, reason: '最近一次验收未通过' }), w: { text: '✕ 未通过', cls: 'mdc-acc-fail', color: C5_COLOR.fail, date: '2026-10-01 10:00', recheck: false, reason: '最近一次验收未通过' }, logs: LOGS, txt: TXT, marked: { '次日变更（甲）': T_AFTER(AT), '晚一秒（乙）': T_AFTER(AT) } },
        { id: 50, tag: 'partial 同口径', acc: c5Acc('partial', AT, { stages: { structure: 'pass', data: null }, reason: '缺少数据阶段验收' }), w: { text: '◐ 缺数据验收', cls: 'mdc-acc-partial', color: C5_COLOR.amber, date: '2026-10-01 10:00', recheck: false, reason: '缺少数据阶段验收' }, logs: LOGS, txt: TXT, marked: { '次日变更（甲）': T_AFTER(AT), '晚一秒（乙）': T_AFTER(AT) } },
        { id: 50, tag: 'stale：at 是更早版本那条记录的时间（09-30 00:00:00），它之后的五条全标', acc: c5Acc('stale', '2026-09-30 00:00:00', { prevResult: 'pass', reason: C5_STALE_REASON }), w: { text: '上次通过 ✓', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: '2026-09-30 00:00', recheck: true, reason: C5_STALE_REASON }, logs: LOGS, txt: TXT, marked: Object.fromEntries(TXT.map((t) => [t, T_AFTER_STALE('2026-09-30 00:00:00')])) },
        { id: 50, tag: 'pass + 日志时间用 T 分隔 / 缺失 / 乱串：只有「晚五秒T」标（T 先规范化再比；缺失与乱串不标）', acc: c5Acc('pass', AT), w: WPASS('2026-10-01 10:00'), logs: LOGS_T, txt: TXT_T, marked: { '晚五秒T（甲）': T_AFTER(AT) } },
        { id: 50, tag: 'none 带 at：不标', acc: c5Acc('none', AT, { reason: '尚无验收记录' }), w: { text: '无验收', cls: 'mdc-acc-none', color: C5_COLOR.weak, date: null, recheck: false, reason: '尚无验收记录' }, logs: LOGS, txt: TXT, marked: {} },
        { id: 50, tag: 'companion 状态带 at：不标', acc: c5Acc('companion', AT, { reason: '伴生表不独立验收' }), w: { text: '随主模型', cls: 'mdc-acc-companion', color: C5_COLOR.weak, date: null, recheck: false, reason: '伴生表不独立验收' }, logs: LOGS, txt: TXT, marked: {} },
        { id: 50, tag: 'acceptance = null：不标', acc: null, w: WUNK, logs: LOGS, txt: TXT, marked: {} },
        { id: 50, tag: '无法识别的 state：不标', acc: c5Acc('bogus', AT), w: WUNK, logs: LOGS, txt: TXT, marked: {} },
        { id: 50, tag: 'pass 但 at = null：不标', acc: c5Acc('pass', null), w: WPASS(null), logs: LOGS, txt: TXT, marked: {} },
        { id: 50, tag: 'pass 但 at 是乱串：不标', acc: c5Acc('pass', 'garbage'), w: WPASS('garbage'), logs: LOGS, txt: TXT, marked: {} },
        { id: 53, tag: '真实 companion #53（后端 state = companion）：不标', acc: undefined, w: { text: '随主模型', cls: 'mdc-acc-companion', color: C5_COLOR.weak, date: null, recheck: false, reason: '伴生表不独立验收' }, logs: LOGS.map((l) => Object.assign({}, l, { model_id: 53 })), txt: TXT, marked: {} },
        // —— codex 44 M1：日志侧非法时间（月 / 日 / 时越界、垃圾后缀、非闰年 2 月 29 日）都不标「验收后」，只有合法且晚于验收的才标；验收 at = 2025-02-28 00:00:00，使这些非法串按字符串都「晚于」它
        { id: 50, tag: '日志侧非法时间：2026-02-30 / 25 点 / 垃圾后缀 / 2025-02-29 都不标，只有合法的 2025-03-01 标', acc: c5Acc('pass', AT_B), w: WPASS('2025-02-28 00:00'), logs: LOGS_BAD, txt: TXT_BAD, marked: { '合法晚于验收（甲）': T_AFTER(AT_B) } },
        // —— 闰年 2024-02-29 合法：严格大于才标（晚一秒 / 次日标，同一秒 / 早一秒不标）
        { id: 50, tag: '闰年 2024-02-29 08:00:00 合法：晚一秒 / 次日标，同一秒 / 早一秒不标', acc: c5Acc('pass', AT_L), w: WPASS('2024-02-29 08:00'), logs: LOGS_L, txt: TXT_L, marked: { '闰年次日（甲）': T_AFTER(AT_L), '闰年晚一秒（乙）': T_AFTER(AT_L) } },
        // —— codex 44 M1：验收侧非法时间（同样的四种）：整条验收时间不可比 → 日志（合法、远晚于）不标；「最近验收」的完整时间退回显示原串
        { id: 50, tag: '验收侧非法时间 2026-02-30 12:00:00：不标', acc: c5Acc('pass', '2026-02-30 12:00:00'), w: WPASS('2026-02-30 12:00:00'), logs: LOGS_LATE, txt: TXT_LATE, marked: {} },
        { id: 50, tag: '验收侧非法时间 2026-10-11 25:00:00：不标', acc: c5Acc('pass', '2026-10-11 25:00:00'), w: WPASS('2026-10-11 25:00:00'), logs: LOGS_LATE, txt: TXT_LATE, marked: {} },
        { id: 50, tag: '验收侧非法时间 2026-10-11 12:00:00垃圾：不标', acc: c5Acc('pass', '2026-10-11 12:00:00垃圾'), w: WPASS('2026-10-11 12:00:00垃圾'), logs: LOGS_LATE, txt: TXT_LATE, marked: {} },
        { id: 50, tag: '验收侧非法时间 2025-02-29 08:00:00（非闰年）：不标', acc: c5Acc('pass', '2025-02-29 08:00:00'), w: WPASS('2025-02-29 08:00:00'), logs: LOGS_LATE, txt: TXT_LATE, marked: {} },
        // —— codex 44Tb M1：验收侧也带 T / 小数秒 / Z / 偏移量（墙上时间都是 2026-10-01 10:00:00，后缀不换算）：同一秒 / 早一秒不标，只有晚一秒标
        { id: 50, tag: '验收侧 T 分隔：只标晚一秒', acc: c5Acc('pass', '2026-10-01T10:00:00'), w: WPASS('2026-10-01 10:00'), logs: LOGS_F, txt: TXT_F, marked: { '晚一秒F（甲）': T_AFTER(AT) } },
        { id: 50, tag: '验收侧小数秒：只标晚一秒', acc: c5Acc('pass', '2026-10-01 10:00:00.789'), w: WPASS('2026-10-01 10:00'), logs: LOGS_F, txt: TXT_F, marked: { '晚一秒F（甲）': T_AFTER(AT) } },
        { id: 50, tag: '验收侧 Z 后缀：只标晚一秒', acc: c5Acc('pass', '2026-10-01 10:00:00Z'), w: WPASS('2026-10-01 10:00'), logs: LOGS_F, txt: TXT_F, marked: { '晚一秒F（甲）': T_AFTER(AT) } },
        { id: 50, tag: '验收侧 +08:00 偏移量（不换算）：只标晚一秒', acc: c5Acc('pass', '2026-10-01 10:00:00+08:00'), w: WPASS('2026-10-01 10:00'), logs: LOGS_F, txt: TXT_F, marked: { '晚一秒F（甲）': T_AFTER(AT) } },
        { id: 50, tag: '验收侧 T + 小数秒 + -0530 紧凑偏移量：只标晚一秒', acc: c5Acc('pass', '2026-10-01T10:00:00.5-0530'), w: WPASS('2026-10-01 10:00'), logs: LOGS_F, txt: TXT_F, marked: { '晚一秒F（甲）': T_AFTER(AT) } },
        { id: 50, tag: '两侧都带后缀（验收 -08:00，日志 T·小数秒·Z / +09:00 / -0700）：只标晚一秒', acc: c5Acc('pass', '2026-10-01 10:00:00-08:00'), w: WPASS('2026-10-01 10:00'), logs: LOGS_FS, txt: TXT_FS, marked: { '晚一秒FS（甲）': T_AFTER(AT) } },
      ];
      for (const c of CASES) {
        stub.ctl.detail[c.id] = c.acc === undefined ? {} : { acceptance: c.acc };
        stub.ctl.logs[c.id] = c.logs;
        const nBefore = stub.ctl.nL[c.id] || 0;
        if (!(await c5Open(page, c.id, 'W106 ' + c.tag))) continue;
        const got = await page.waitForFunction((n) => document.querySelectorAll('#modelDrawerBody .mdc-tl-row').length === n, c.txt.length, { timeout: WAIT }).then(() => true, () => false);
        const r = await c5Read(page);
        check(`W106 ${c.tag}：前提——抽屉属于 #${c.id}、变更日志请求发出过、时间线行已到齐（${c.txt.length} 行）且行文字与手写序一致`, new RegExp('#' + c.id + '(?!\\d)').test(r.sub || '') && (stub.ctl.nL[c.id] || 0) > nBefore && got && J(r.rows.map((x) => x.text)) === J(c.txt), { sub: r.sub, texts: r.rows.map((x) => x.text) });
        check(`W106 ${c.tag}：前提——同一次读到的「最近验收」= 手写展示期望（文字 ${c.w.text}、类名含 ${c.w.cls}、完整时间 ${J(c.w.date)}；证明这条用例确实处在它声称的验收状态，下面的标签结论才算数）`, c5AccOk(r.acc, c.w), r.acc);
        const wantRows = c.txt.map((t) => ({ text: t, after: Object.prototype.hasOwnProperty.call(c.marked, t), title: Object.prototype.hasOwnProperty.call(c.marked, t) ? c.marked[t] : null }));
        const gotRows = r.rows.map((x) => ({ text: x.text, after: x.after && x.afterText === '验收后' && x.afterVisible, title: x.after ? x.title : null }));
        check(`W106 ${c.tag}：逐行「验收后」标签与 title 等于手写期望（${J(Object.keys(c.marked))}）`, J(gotRows) === J(wantRows), { got: gotRows, want: wantRows });
        const styled = r.rows.filter((x) => x.after);
        if (Object.keys(c.marked).length > 0) check(`W106 ${c.tag}：${Object.keys(c.marked).length} 个「验收后」标签都是中性样式（字 ${C5_COLOR.secondary}、底 ${C5_COLOR.neutralBg}、边 1px ${C5_COLOR.neutralBorder}；不是警示琥珀）——标签数先对上，再逐个读计算样式`, styled.length === Object.keys(c.marked).length && styled.every((x) => !!x.afterStyle && x.afterStyle.color === C5_COLOR.secondary && x.afterStyle.bg === C5_COLOR.neutralBg && x.afterStyle.bw === '1px' && x.afterStyle.bc === C5_COLOR.neutralBorder), styled.map((x) => x.afterStyle));
        await c5Close(page);
      }
      // 请求顺序（修复批待裁 2）：时间线只在详情渲染里发起——扣住 #50 的详情请求时，变更日志请求次数为 0；放行详情后才出现，且恰 1 次、画出 5 行并标 2 条「验收后」。
      {
        const gD = gate();
        stub.ctl.gateD[50] = gD; stub.ctl.detail[50] = { acceptance: c5Acc('pass', AT) }; stub.ctl.logs[50] = LOGS;
        const nD0 = stub.ctl.nD[50] || 0, nL0 = stub.ctl.nL[50] || 0;
        await page.evaluate(() => { openModelDrawer(50, null); });
        const held = await c5Wait(() => (stub.ctl.nD[50] || 0) === nD0 + 1);
        await c5Settle(page);
        const rHeld = await c5Read(page);
        check('W106 请求顺序：前提——#50 的详情请求已发出并被扣住（到达次数 +1）、抽屉正文还是加载态（没有 kv、没有「最近验收」）；此刻变更日志请求次数 = 0', held && !rHeld.acc && rHeld.labels.length === 0 && (stub.ctl.nL[50] || 0) - nL0 === 0, { held, labels: rHeld.labels, nL: (stub.ctl.nL[50] || 0) - nL0 });
        gD.release();
        const okR = await c5Rendered(page, 50);
        const rowsReady = await page.waitForFunction(() => document.querySelectorAll('#modelDrawerBody .mdc-tl-row').length === 5, null, { timeout: WAIT }).then(() => true, () => false);
        const rAfter = await c5Read(page);
        check('W106 请求顺序：放行详情后抽屉渲染完、变更日志请求恰发出 1 次（不是并行发起也不重复）、时间线 5 行且恰 2 行带「验收后」（次日变更 / 晚一秒）', okR && rowsReady && (stub.ctl.nL[50] || 0) - nL0 === 1 && J(rAfter.rows.filter((x) => x.after).map((x) => x.text)) === J(['次日变更（甲）', '晚一秒（乙）']), { okR, rowsReady, nL: (stub.ctl.nL[50] || 0) - nL0, marked: rAfter.rows.filter((x) => x.after).map((x) => x.text) });
        await c5Close(page);
      }
      await page.close();
    });

    // ===== W107 迟到响应不落到新抽屉 =====
    // 它锁的是：抽屉打开后快速切到另一个模型，旧模型迟到的变更日志 / 详情响应不把旧模型的时间线（含「验收后」标记）/ 验收 / 说明画到新抽屉上；新模型自己的响应到达后画出自己的内容与标记。
    //   前提都成立才算：旧请求确实发出并被扣住、新抽屉已渲染（副标题含新 id）、新抽屉的时间线仍在加载态（旧响应放行时新抽屉里有一个待替换的位置——能被误替换才有意义）、旧响应确实被放行并处理完。
    //   切换步骤直接调 openModelDrawer(新 id)，不先清空抽屉正文与副标题（修复批 L1：先清空等于测试工具自带一层「旧节点脱离」，将来改成局部更新不重建正文时会掩盖问题）。
    //   页面的防线：详情两层——切换时 navAborter 取消旧请求、落 DOM 前 mdcGuard；时间线三层——再加闭包里的 host 已脱离文档（切换时正文被清空，旧 host 随之脱离，往里写不可见）。
    //   取消监听只覆盖「响应头到达之前」：mdcRequest 在响应头到达时就 cleanup() 移除了导航取消监听，之后 res.json() 未完成时切换模型，旧响应只靠 res.json() 之后的 mdcGuard 挡（codex 44Ta M2，主会话亲核成立）。
    //   W107a / W107b：旧请求在响应头到达之前被扣住（路由层扣住）；W107c / W107d：响应头已到页面、res.json() 被扣住（页内包一层 Response.prototype.json，只对指定路径返回由测试控制的 Promise，产品代码不动）——旧响应在两个阶段都要挡住。
    //   w107-guards-only-off（去掉全部落 DOM 前的 mdcGuard、保留取消）：W107a / W107b 看不出（响应头之前取消生效），W107c 判红——详情的 res.json() 之后没有 guard 时，旧详情把新抽屉整个重画；它曾被误登记为等价变异，codex 44Ta M2 后撤回并改用 w107 前缀的名字。
    //   等价变异（不判红）：eq107-abort-only-off（去掉取消、保留全部 guard）——在任何时序都不可观察：切换时 ctx.dead 已置真，之后每个 await 之后都有 mdcGuard，取消只是省带宽；
    //     eq107-all-off-host-kept（时间线的取消 + guard 都去掉、host 不改）——切换时 renderDrawerState 同步清空正文，旧 host 随即脱离文档，之后任何时刻（含 W107d 的响应头已到、正文未解析时序）旧响应都只会写进已脱离文档的旧 host，新抽屉里什么都没变。
    //   只有把防线全去掉并让时间线改写「当前抽屉里的那个位置」（w107-race-timeline）、或详情侧取消 + guard 都去掉（w107-race-detail，详情渲染会清空并重画整个正文）才会让迟到响应落到新抽屉。
    //   页内记录器（MutationObserver 观察抽屉正文）只在回调执行时读 body.textContent：同一同步段内「插入又删除」的旧内容它看不到。威胁模型是诚实写错——把旧内容写进新抽屉并留在那里，记录器与随后的读取都能看到；同一同步段内插入又删除不属于诚实写错（codex 44Tb L1，不改记录器）。
    //   负向断言不靠固定等待（修复批 L7）：页内记录器记下旧内容是否「曾经出现过」，等新模型自己的内容渲染完成（正向信号）之后再读；旧响应早于新响应放行，晚到的画法即使随后被覆盖也已被记录。
    // 页内变异（首红落在本段）：w107-race-timeline（旧时间线迟到响应替换新抽屉的加载占位）/ w107-race-detail（旧详情迟到响应覆盖新抽屉）/ w107-guards-only-off（去掉落 DOM 前的全部 guard：响应头已到、正文未解析时切换才可观察）；等价变异（不判红）：eq107-abort-only-off / eq107-all-off-host-kept
    console.log('W107 C5 迟到响应不落到新抽屉');
    await segGuard('W107', async () => {
      const ACC_A = c5Acc('pass', '2026-10-01 10:00:00');
      const ACC_B = c5Acc('fail', '2026-10-05 08:00:00', { stages: { structure: 'fail', data: 'pass' }, reason: '最近一次验收未通过' });
      const LOGS_A = [{ id: 301, model_id: 50, change_type: 'dim_config', change_summary: 'A迟到日志', operator_name: '甲', created_at: '2026-10-02 00:00:00' }];
      const LOGS_B = [{ id: 302, model_id: 55, change_type: 'dim_config', change_summary: 'B验收后日志', operator_name: '乙', created_at: '2026-10-06 00:00:00' }, { id: 303, model_id: 55, change_type: 'basic_info', change_summary: 'B验收前日志', operator_name: '丙', created_at: '2026-10-04 00:00:00' }];
      /** 页内记录器：抽屉正文里出现过 marks 里任一串（哪怕一瞬）就记下，读取见 c5Seen */
      const c5Recorder = (pg, marks) => pg.evaluate((marks) => {
        window.__w107seen = [];
        const body = document.getElementById('modelDrawerBody');
        const scan = () => { const t = body.textContent; marks.forEach((m) => { if (t.includes(m) && !window.__w107seen.includes(m)) window.__w107seen.push(m); }); };
        if (window.__w107obs) window.__w107obs.disconnect();
        window.__w107obs = new MutationObserver(scan);
        window.__w107obs.observe(body, { childList: true, subtree: true, characterData: true });
        scan();
      }, marks);
      const c5Seen = (pg) => pg.evaluate(() => (window.__w107seen || []).slice());
      // —— 情形 1：旧模型（#50）的变更日志迟到
      {
        const stub = c5Stub();
        stub.ctl.detail[50] = { acceptance: ACC_A, impl_note: 'A-说明' }; stub.ctl.detail[55] = { acceptance: ACC_B, impl_note: 'B-说明' };
        stub.ctl.logs[50] = LOGS_A; stub.ctl.logs[55] = LOGS_B;
        const gA = gate(), gB = gate(); stub.ctl.gateL[50] = gA; stub.ctl.gateL[55] = gB;
        const { page } = await open(adminN, 'W107a', '', { beforeGoto: stub.install });
        const okA = await c5Open(page, 50, 'W107a 旧抽屉 #50');
        const arrA = await c5Wait(() => (stub.ctl.nL[50] || 0) === 1);
        await page.evaluate(() => { openModelDrawer(55, null); });   // 直接切换：不清空抽屉
        const okB = await c5Rendered(page, 55);
        const arrB = await c5Wait(() => (stub.ctl.nL[55] || 0) === 1);
        const r0 = await c5Read(page);
        check('W107a 前提：旧抽屉 #50 渲染过、其变更日志请求已发出并被扣住；直接切到 #55 后新抽屉已渲染（副标题含 #55）、#55 的变更日志请求也已发出并被扣住、新抽屉的时间线仍是加载态「加载最近变更…」且没有任何时间线行',
          okA && arrA && okB && arrB && new RegExp('#55(?!\\d)').test(r0.sub || '') && r0.hostText === '加载最近变更…' && r0.rows.length === 0 && !r0.hasTimeline && !!r0.acc && r0.acc.text === '✕ 未通过', { okA, arrA, okB, arrB, sub: r0.sub, host: r0.hostText, rows: r0.rows.length, acc: r0.acc && r0.acc.text });
        await c5Recorder(page, ['A迟到日志']);
        gA.release();
        const doneA = await c5Wait(() => (stub.ctl.doneL[50] || 0) === 1);
        await c5Settle(page);
        const r1 = await c5Read(page);
        check('W107a 旧模型的变更日志迟到：前提——旧响应确实被放行并处理完（doneL[50] = 1）、抽屉仍是 #55；新抽屉的时间线仍在加载态、没有「A迟到日志」、没有任何「验收后」标签',
          doneA && new RegExp('#55(?!\\d)').test(r1.sub || '') && r1.hostText === '加载最近变更…' && r1.rows.length === 0 && !r1.hasTimeline && !r1.bodyText.includes('A迟到日志') && !r1.bodyText.includes('验收后'), { doneA, sub: r1.sub, host: r1.hostText, rows: r1.rows, hasTl: r1.hasTimeline });
        gB.release();
        const rowsOk = await page.waitForFunction(() => document.querySelectorAll('#modelDrawerBody .mdc-tl-row').length === 2, null, { timeout: WAIT }).then(() => true, () => false);
        const r2 = await c5Read(page);
        const seenA = await c5Seen(page);
        check('W107a 新模型自己的变更日志到达后：恰 2 行（B验收后日志 / B验收前日志），只有「B验收后日志」带「验收后」（#55 的 at = 2026-10-05 08:00:00），title 用 #55 自己的验收时间，没有 A 的内容',
          rowsOk && J(r2.rows.map((x) => [x.text, x.after, x.title])) === J([['B验收后日志（乙）', true, '发生在最近一次验收（2026-10-05 08:00）之后'], ['B验收前日志（丙）', false, null]]) && !r2.bodyText.includes('A迟到日志'), r2.rows);
        check('W107a 旧模型的变更日志在任何时刻都没有出现在新抽屉里（页内记录器：从旧响应放行前到 #55 自己的时间线渲染完成，「A迟到日志」一次都没出现过；读取发生在新模型内容渲染完成之后，不靠固定等待）', rowsOk && seenA.length === 0, seenA);
        await c5Close(page);
        await page.close();
      }
      /** 页内：对指定路径的响应，让 Response.prototype.json 返回一个由测试控制的 Promise——响应头已到页面、正文解析被扣住（codex 44Ta M2）；只改测试页里的内建原型，不改产品代码。
       *  window.__jsonHeld = 被扣住的 json() 调用次数（正向信号：响应头已到、页面已调 res.json()）；window.__jsonRelease() 放行（真正解析正文）；window.__jsonDone = 放行后解析完成并交还给页面代码的次数（交还那一刻同步，页面里 await res.json() 之后的代码紧接着在微任务里跑） */
      const holdJson = (pg, pathRe) => pg.evaluate((src) => {
        const re = new RegExp(src);
        if (!window.__origJson) window.__origJson = Response.prototype.json;
        window.__jsonHeld = 0; window.__jsonDone = 0; window.__jsonRelease = null;
        Response.prototype.json = function () {
          let p = ''; try { p = new URL(this.url).pathname; } catch (e) { /* ignore */ }
          if (!re.test(p)) return window.__origJson.call(this);
          window.__jsonHeld++;
          const self = this;
          return new Promise((resolve, reject) => { window.__jsonRelease = () => { window.__origJson.call(self).then((v) => { window.__jsonDone++; resolve(v); }, (e) => { window.__jsonDone++; reject(e); }); }; });
        };
      }, pathRe.source);
      const unholdJson = (pg) => pg.evaluate(() => { if (window.__origJson) { Response.prototype.json = window.__origJson; window.__origJson = null; } });
      const jsonHeld = (pg) => pg.waitForFunction(() => window.__jsonHeld === 1, null, { timeout: WAIT }).then(() => true, () => false);
      const jsonReleased = async (pg) => { await pg.evaluate(() => { window.__jsonRelease(); }); return pg.waitForFunction(() => window.__jsonDone === 1, null, { timeout: WAIT }).then(() => true, () => false); };
      // —— 情形 2：旧模型（#50）的详情迟到（响应头之前扣住）。codex 44Tb M2：c5Stub 的 doneD 只表示路由替身把响应交给了页面，页面此刻未必处理完；
      //   所以先扣住新模型 #55 的变更日志，放行旧详情后再放行 #55 的日志，以 #55 自己的时间线渲染完成为正向信号（它排在旧详情之后），再断言
      {
        const stub = c5Stub();
        stub.ctl.detail[50] = { acceptance: ACC_A, impl_note: 'A-说明' }; stub.ctl.detail[55] = { acceptance: ACC_B, impl_note: 'B-说明' };
        stub.ctl.logs[50] = LOGS_A; stub.ctl.logs[55] = LOGS_B;
        const gD = gate(); stub.ctl.gateD[50] = gD;
        const gLB = gate(); stub.ctl.gateL[55] = gLB;
        const { page } = await open(adminN, 'W107b', '', { beforeGoto: stub.install });
        await page.evaluate(() => { openModelDrawer(50, null); });
        const arrA = await c5Wait(() => (stub.ctl.nD[50] || 0) === 1);
        await page.evaluate(() => { openModelDrawer(55, null); });   // 直接切换：不清空抽屉
        const okB = await c5Rendered(page, 55);
        const arrLB = await c5Wait(() => (stub.ctl.nL[55] || 0) === 1);
        const r0 = await c5Read(page);
        check('W107b 前提：旧模型 #50 的详情请求已发出并被扣住；直接切到 #55 后新抽屉已渲染（副标题含 #55）、#55 的变更日志请求已发出并被扣住（时间线仍在加载态）、最近验收 = ✕ 未通过、实现说明 = B-说明',
          arrA && okB && arrLB && new RegExp('#55(?!\\d)').test(r0.sub || '') && r0.hostText === '加载最近变更…' && !!r0.acc && r0.acc.text === '✕ 未通过' && !!r0.impl && r0.impl.text === 'B-说明', { arrA, okB, arrLB, sub: r0.sub, host: r0.hostText, acc: r0.acc && r0.acc.text, impl: r0.impl && r0.impl.text });
        await c5Recorder(page, ['A-说明']);
        gD.release();
        const doneD = await c5Wait(() => (stub.ctl.doneD[50] || 0) === 1);   // 路由替身已把旧详情响应交给页面（只是路由侧完成）
        await c5Settle(page);
        gLB.release();   // 再放行 #55 的变更日志：它排在旧详情之后，#55 时间线渲染完成才是「旧详情已被页面处理过」的正向信号
        const rowsOk = await page.waitForFunction(() => document.querySelectorAll('#modelDrawerBody .mdc-tl-row').length === 2, null, { timeout: WAIT }).then(() => true, () => false);   // 正向信号：新模型自己的时间线渲染完成
        const r1 = await c5Read(page);
        const seenA = await c5Seen(page);
        check('W107b 旧模型的详情迟到：前提——旧响应已被路由放行、#55 的变更日志在旧详情之后才放行且 #55 自己的时间线渲染完成；抽屉仍是 #55：副标题含 #55 且不含 #50、最近验收仍 = ✕ 未通过、实现说明仍 = B-说明、全文没有「A-说明」',
          doneD && rowsOk && new RegExp('#55(?!\\d)').test(r1.sub || '') && !/#50(?!\d)/.test(r1.sub || '') && !!r1.acc && r1.acc.text === '✕ 未通过' && !!r1.impl && r1.impl.text === 'B-说明' && !r1.bodyText.includes('A-说明'), { doneD, rowsOk, sub: r1.sub, acc: r1.acc && r1.acc.text, impl: r1.impl && r1.impl.text });
        check('W107b 旧模型的详情在任何时刻都没有画到新抽屉上（页内记录器：「A-说明」一次都没出现过）', doneD && rowsOk && seenA.length === 0, seenA);
        await c5Close(page);
        await page.close();
      }
      // —— 情形 3（codex 44Ta M2）：旧模型（#50）的详情响应头已到页面、res.json() 被扣住时切换——mdcRequest 在响应头到达时就 cleanup() 移除了导航取消监听，
      //   此刻只靠 res.json() 之后的 mdcGuard 挡。扣住的是页内的正文解析（holdJson），不是网络请求
      {
        const stub = c5Stub();
        stub.ctl.detail[50] = { acceptance: ACC_A, impl_note: 'A-说明' }; stub.ctl.detail[55] = { acceptance: ACC_B, impl_note: 'B-说明' };
        stub.ctl.logs[50] = LOGS_A; stub.ctl.logs[55] = LOGS_B;
        const { page } = await open(adminN, 'W107c', '', { beforeGoto: stub.install });
        await holdJson(page, /^\/api\/models\/50$/);
        await page.evaluate(() => { openModelDrawer(50, null); });
        const held = await jsonHeld(page);   // 响应头已到、页面已调 res.json() 并被扣住
        await page.evaluate(() => { openModelDrawer(55, null); });   // 直接切换：不清空抽屉
        const okB = await c5Rendered(page, 55);
        const rowsB = await page.waitForFunction(() => document.querySelectorAll('#modelDrawerBody .mdc-tl-row').length === 2, null, { timeout: WAIT }).then(() => true, () => false);   // 正向信号：新模型自己的内容与时间线都渲染完成
        const r0 = await c5Read(page);
        check('W107c 前提：旧模型 #50 的详情响应头已到、res.json() 被扣住（页内 json() 调用被扣住 1 次）；直接切到 #55 后新抽屉已渲染完成（副标题含 #55、时间线 2 行）、最近验收 = ✕ 未通过、实现说明 = B-说明；#50 的详情只发过 1 次、#50 的变更日志一次都没发',
          held && okB && rowsB && new RegExp('#55(?!\\d)').test(r0.sub || '') && !!r0.acc && r0.acc.text === '✕ 未通过' && !!r0.impl && r0.impl.text === 'B-说明' && (stub.ctl.nD[50] || 0) === 1 && (stub.ctl.nL[50] || 0) === 0, { held, okB, rowsB, sub: r0.sub, acc: r0.acc && r0.acc.text, impl: r0.impl && r0.impl.text, nD50: stub.ctl.nD[50] || 0, nL50: stub.ctl.nL[50] || 0 });
        await c5Recorder(page, ['A-说明']);
        const released = await jsonReleased(page);   // 放行：旧详情正文解析完成并交还给页面代码
        await c5Settle(page);
        const r1 = await c5Read(page);
        const seenA = await c5Seen(page);
        check('W107c 旧详情的正文在被切换之后才解析完：前提——放行后旧正文确实解析完并交还页面（页内完成计数 = 1，等两帧后读）；抽屉仍是 #55：副标题含 #55 且不含 #50、最近验收仍 = ✕ 未通过、实现说明仍 = B-说明、全文没有「A-说明」、#50 的变更日志仍然没发（旧详情没有继续往下走）',
          released && new RegExp('#55(?!\\d)').test(r1.sub || '') && !/#50(?!\d)/.test(r1.sub || '') && !!r1.acc && r1.acc.text === '✕ 未通过' && !!r1.impl && r1.impl.text === 'B-说明' && !r1.bodyText.includes('A-说明') && (stub.ctl.nL[50] || 0) === 0, { released, sub: r1.sub, acc: r1.acc && r1.acc.text, impl: r1.impl && r1.impl.text, nL50: stub.ctl.nL[50] || 0 });
        check('W107c 旧模型的详情在任何时刻都没有画到新抽屉上（页内记录器：「A-说明」一次都没出现过）', released && seenA.length === 0, seenA);
        await unholdJson(page);
        await c5Close(page);
        await page.close();
      }
      // —— 情形 4（codex 44Ta M2）：旧模型（#50）的变更日志响应头已到页面、res.json() 被扣住时切换
      {
        const stub = c5Stub();
        stub.ctl.detail[50] = { acceptance: ACC_A, impl_note: 'A-说明' }; stub.ctl.detail[55] = { acceptance: ACC_B, impl_note: 'B-说明' };
        stub.ctl.logs[50] = LOGS_A; stub.ctl.logs[55] = LOGS_B;
        const { page } = await open(adminN, 'W107d', '', { beforeGoto: stub.install });
        await holdJson(page, /^\/api\/models\/50\/change-logs$/);
        const okA = await c5Open(page, 50, 'W107d 旧抽屉 #50');
        const held = await jsonHeld(page);   // #50 的变更日志响应头已到、页面已调 res.json() 并被扣住
        await page.evaluate(() => { openModelDrawer(55, null); });   // 直接切换：不清空抽屉
        const okB = await c5Rendered(page, 55);
        const rowsB = await page.waitForFunction(() => document.querySelectorAll('#modelDrawerBody .mdc-tl-row').length === 2, null, { timeout: WAIT }).then(() => true, () => false);   // 正向信号：#55 自己的时间线渲染完成（#55 的日志没被扣）
        const r0 = await c5Read(page);
        check('W107d 前提：旧模型 #50 渲染过、其变更日志响应头已到且 res.json() 被扣住；直接切到 #55 后新抽屉已渲染完成（副标题含 #55、时间线恰 2 行：B验收后日志 / B验收前日志）、没有「A迟到日志」',
          okA && held && okB && rowsB && new RegExp('#55(?!\\d)').test(r0.sub || '') && J(r0.rows.map((x) => x.text)) === J(['B验收后日志（乙）', 'B验收前日志（丙）']) && !r0.bodyText.includes('A迟到日志'), { okA, held, okB, rowsB, sub: r0.sub, rows: r0.rows.map((x) => x.text) });
        await c5Recorder(page, ['A迟到日志']);
        const released = await jsonReleased(page);
        await c5Settle(page);
        const r1 = await c5Read(page);
        const seenA = await c5Seen(page);
        check('W107d 旧变更日志的正文在被切换之后才解析完：前提——放行后旧正文确实解析完并交还页面；抽屉仍是 #55、时间线仍恰 2 行（B 的两条，只有「B验收后日志」带「验收后」）、没有「A迟到日志」',
          released && new RegExp('#55(?!\\d)').test(r1.sub || '') && J(r1.rows.map((x) => [x.text, x.after])) === J([['B验收后日志（乙）', true], ['B验收前日志（丙）', false]]) && !r1.bodyText.includes('A迟到日志'), { released, sub: r1.sub, rows: r1.rows.map((x) => [x.text, x.after]) });
        check('W107d 旧模型的变更日志在任何时刻都没有出现在新抽屉里（页内记录器：「A迟到日志」一次都没出现过）', released && seenA.length === 0, seenA);
        await unholdJson(page);
        await c5Close(page);
        await page.close();
      }
    });

    // ===== W108 抽屉内写操作后抽屉刷新（C5 预筛修复批 MED-1；修复批 2 补钩子闸 / 写结束时点；修复批 3 口径收窄：抽屉只为「它自己发起的保存」刷新；修复批 4：hookSeen 按证据记录）=====
    // 它锁的是：抽屉打开期间，从抽屉里打开的 DDL 编辑器（custom 模型 #58 的「查看 DDL →」）里保存过脚本（edit-script 写请求成功），关闭编辑器后抽屉对当前模型重新加载——
    //   详情请求次数 +1、变更日志请求次数 +1，「最近验收」变成「上次通过 ✓」+「需复验」、时间线多出新的一行并带「验收后」（title「发生在上次通过的验收…之后」），焦点回到重建后的同一个「查看 DDL →」按钮（不落到 body）。
    //   前提（修复批 2）：页内先断言 MC 依赖的三个 CAT 全局名都在（typeof catalogWritesDone / catalogWritesInFlight 是 number、catalogHookModalOpen 是 function，任一改名即红），并预先弹一次 toast 让 #toast-container 先存在。
    //   「自己发起」判据（修复批 4）：ctx.hookSeen——这个抽屉点过自己的「查看 DDL →」（该按钮的 click 处理里直接置真；只增不减，重载 / 换模型换新 ctx 后从 false 起步，不继承）；不再观察弹窗是否开着（观察式会被外来的钩子弹窗触发，也容易被放宽）；
    //     重载条件 = 可交互 + ctx 有效 + 无在途写 + 无钩子弹窗开着 + 计数增长 + hookSeen 为真。
    //   a 写过 → 刷新（edit-script 替身成功的同时把详情 / 变更日志替身切成 stale 与新日志；保存后、关闭前抽屉不动：详情请求数不变）；
    //     a 还钉住「带钩子的弹窗开着时不重载」这道闸：编辑器开着、写已结束，往 body 显式 append 再 remove 一个 textarea（模拟 HTTP 下「复制」的回退路径）→ 触发 sync，但不重载（请求数不变、打标节点还在、焦点不在抽屉关闭按钮上）；
    //     toast 容器已预先存在，所以判红不靠「第一次 toast 创建容器」这个与被测性质无关的副作用（预筛 MED-1：原先去掉这道闸只会在第一次 toast 时偶然判红）；
    //   b 没写过就关闭 → 不重载（页内先给「查看 DDL →」按钮打标，关闭后同一个节点还在 = 抽屉没有重建；另开「验收记录 →」只读弹窗再用 Esc 关掉同样不重载）；
    //   c 编辑器打开期间抽屉被关掉（Esc）→ 关闭编辑器后不重开抽屉；
    //   d 编辑器打开期间抽屉换了模型（#58 → #55）→ 换到 #55 之后在编辑器里再保存一次、关闭编辑器，也不重载 #55、不串到 #58（修复批 4 新口径：那两次保存都是 #58 的，#55 的 ctx 没点过自己的「查看 DDL →」；#55 的正文节点还在、两个模型的详情请求数都不变）；
    //   d2 修复批 5（预筛 MED-1）：写入基数按 ctx 重置——#50 打开期间有一个无关写结束（#50 不重载）→ 不关抽屉换到 #58 → 点「查看 DDL →」、编辑器挂上后不写就关 → #58 不重载（基数若沿用 #50 的，计数已比它大、hookSeen 又为真，就会重载）；d 里 #55 的 hookSeen 从 false 起步，先于基数挡住，看不出基数，所以另设这一腿；
    //   e 在途写（修复批 2）：第一次保存已结束（计数已增长），第二次保存的 PUT 在 route 里被扣住 → 关闭编辑器 → 此刻不重载（在途判断；详情 / 变更日志请求数不变）→ 放行（成功 / route.abort 失败各一腿）→ 恰好重载一次（写结束时点：CAT 的 'modelcatalog:write-settled' 事件；成败都算）；
    //     成功腿还要读到「需复验」（这一次才由 PUT 成功把详情替身切成 stale，证明重载发生在写结束之后，不是之前）；
    //   e3 修复批 3（预筛待裁 2）：前面不先保存，只有被扣住的这一次写：打开编辑器 → 保存（扣住 PUT）→ 关闭编辑器 → 此刻不重载 → 放行 → 恰好重载一次。e1 / e2 里前面已保存过一次，计数早已大于基数，看不见「事件派发早于计数 +1」；e3 里计数在这次写结束之前 = 基数，这个错误在 e 段就判红；
    //   f 无关的在途写（修复批 3 改期望，主会话改判）：抽屉打开前页内发起一个在途写（catalogTrackWrite 一个由测试控制何时 resolve 的 Promise）→ 打开非 custom 的 #50 抽屉、字段搜索框里输入文字（打标）→ 放行 → 写结束时不重载：详情 / 变更日志请求数不变、搜索框节点还在、文字仍在、焦点仍在搜索框；之后 body 增删也不重载；
    //     修复批 4（预筛 MED-1）：放行之前先开关一次只读弹窗「验收记录 →」（不带钩子，不置 hookSeen），再把焦点放回搜索框——放行后仍不重载；钉住「保存类弹窗 vs 其他子弹窗」的边界；
    //   f2 已登记的残余（钉住现状，不是理想行为）：同一个抽屉里点过「查看 DDL →」、编辑器开过又关了但没写，之后有任何写结束（与这个抽屉无关的写也算）→ 重载一次；将来想「顺手修」须先改这一条的期望；
    //     修复批 4（预筛 LOW-1）：重载换新 ctx、hookSeen 归零，所以至多一次——重载完成后给新节点打标，再来一个无关写，不再重载；
    //   g 修复批 3（预筛 LOW-1）：写在途时先关闭编辑器、再打开只读弹窗「验收记录 →」→ 放行：弹窗还开着时不重载（打标节点在、详情请求数不变）→ Esc 关闭只读弹窗 → 恰好重载一次、焦点回到「验收记录 →」。
    //   h 修复批 5（预筛 LOW-1）：外来编辑器竞态——列表「DDL」动作（openDimDDLModal(58)）的请求被 stub.ctl.gateD[58] 扣住 → 打开 #50 抽屉、搜索框输入 → 放行，外来编辑器挂在 #50 上 → 关掉 → 放行一个无关写 → #50 不重载（搜索框节点 / 文字 / 焦点保留、详情请求数不变）；钉住「hookSeen 不能挪到编辑器挂载处置真」；
    //   每条「没有发生」的断言都是同步可判的：重载在弹窗被移除 / 写结束的同一个同步段里清空并重画抽屉正文（节点标记 / 抽屉 open 状态当场可读），不依赖固定等待；d / d2 / f / g / h 的「写已结束」用页内写入计数增长做正向信号；b / c / e 的前提用正向信号（编辑器节点已移除、写请求已到达被扣住、重载后的新节点已出现）。
    // 页内变异（首红落在本段）：w108-no-reload（关闭弹窗后不刷新）/ w108-reload-without-write（没写过也刷新）/ w108-reload-wrong-model（刷新到错误模型）/ w108-no-refocus（重载后不归还焦点）/ w108-reopen-closed（抽屉已关也重开）/ w108-base-not-per-ctx（写入基数不随新抽屉重置：首红落在 d2；修复批 4 曾误登记为等价，修复批 5 撤回——d 里新 ctx 的 hookSeen 从 false 起步先挡住，只有 d2 能看出基数；w108-reload-without-write 守的是「计数比较在不在」，不是「基数按 ctx 重置」）/
    //   w108-sync-no-hook-check（只有 body 增删 / 弹窗关闭这条 sync 路径没有钩子闸：首红落在 a 的「body 子节点增删」断言）/ w108-no-hook-check（两条路径共用的判断整个去掉：写结束事件在编辑器开着时就重载，首红落在 a 的「保存后、编辑器还开着」，不靠 toast）/ w108-reload-while-inflight（去掉在途判断）/ w108-no-settle-listener（去掉写结束事件的监听）/ w108-settle-before-count（CAT：事件派发挪到 catalogWritesDone++ 之前：首红落在 e3）/
    //   修复批 3：w108-ignore-hookseen（重载条件去掉 hookSeen：首红落在 d——换到 #55 后再保存一次，#55 被重载；f 也判红：无关写结束后抽屉重载）/ w108-settle-ignores-modal（监听里 interactive 不排除浮层：首红落在 g）/ w108-settle-only-on-success（CAT：失败的写不派发事件：首红落在 e2）/
    //   修复批 4：w108-hookseen-not-set-on-click（点击处理里不置 hookSeen：首红落在 a「关闭编辑器后」）/ w108-hookseen-on-readonly（只读弹窗「验收记录 →」的打开处理里也置 hookSeen：首红落在 f）/ w108-hookseen-carry-on-reload（写后重载时新 ctx 继承旧 hookSeen：首红落在 f2「至多一次」）/ w108-hookseen-carry-on-switch（任何新 ctx 都继承旧 hookSeen：首红落在 d）/
    //   修复批 5：w108-hookseen-at-mount（在共享的 custom DDL 打开函数里、编辑器挂上时置真：外来编辑器会把 #50 的 hookSeen 置真，首红落在 h）
    //   （修复批 4 删去修复批 3 里变异「观察式记录」两个记录点的两个变异：记录点随观察式记录一起删除，变异已无对象）
    console.log('W108 C5 修复批 抽屉内写操作后抽屉刷新');
    expectErr('W108', /\/api\/models\/58\/edit-script(\?.*)?$/);   // e 的失败腿：PUT 被 route.abort，浏览器自己记一条 Failed to load resource
    await segGuard('W108', async () => {
      const ACC_PASS = c5Acc('pass', '2026-10-01 10:30:15', { rows: 10, stages: { structure: 'pass', data: 'pass' } });
      const ACC_STALE = c5Acc('stale', '2026-10-01 10:30:15', { prevResult: 'pass', reason: C5_STALE_REASON });
      const LG = (id, at, type, text, op) => ({ id, model_id: 58, model_name: 'x', action: 'UPDATE', change_type: type, before_value: null, after_value: null, change_summary: text, operator_id: 1, operator_name: op, created_at: at });
      const LOGS1 = [LG(401, '2026-09-30 09:00:00', 'basic_info', 'W108 旧日志', '甲')];
      const LOGS2 = [LG(402, '2026-10-05 09:00:00', 'script_edit', 'W108 脚本编辑', '丁'), LOGS1[0]];
      const stub = c5Stub();
      stub.ctl.detail[58] = { acceptance: ACC_PASS }; stub.ctl.logs[58] = LOGS1;
      let nPut = 0; let putHold = null; let putMode = 'ok'; let flip = true;   // putHold：扣住 PUT 的 gate；putMode：ok / abort；flip：PUT 成功时是否把详情 / 变更日志替身切到「写入之后」
      const { page } = await open(adminN, 'W108', '', { beforeGoto: async (pg) => {
        await stub.install(pg);
        await pg.route(/\/api\/models\/58\/edit-script(\?.*)?$/, async (route) => {
          if (route.request().method() !== 'PUT') return route.continue();
          nPut++;
          if (putHold) await putHold.p;
          if (putMode === 'abort') { await route.abort('failed'); return; }
          if (flip) { stub.ctl.detail[58] = { acceptance: ACC_STALE }; stub.ctl.logs[58] = LOGS2; }   // 写成功的同时，详情与变更日志替身切到「写入之后」的样子
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
        });
      } });
      const TIMELINE_N = (n) => page.waitForFunction((n) => document.querySelectorAll('#modelDrawerBody .mdc-tl-row').length === n, n, { timeout: WAIT }).then(() => true, () => false);
      const markDdlBtn = (attr) => page.evaluate((attr) => { const b = Array.from(document.querySelectorAll('#modelDrawerBody button')).find((x) => x.textContent.trim() === '查看 DDL →'); if (b) b.setAttribute(attr, '1'); return !!b; }, attr);
      const hasMark = (attr) => page.evaluate((attr) => !!document.querySelector('#modelDrawerBody [' + attr + ']'), attr);
      const openEditor = async () => { await page.locator('#modelDrawerBody button', { hasText: '查看 DDL' }).click(); return page.waitForSelector('#dimDdlPreviewModal #customDdlEditBtn', { timeout: WAIT }).then(() => true, () => false); };
      const saveInEditor = async () => { const w0 = await page.evaluate(() => catalogWritesDone); const p0 = nPut; await page.click('#customDdlEditBtn'); await page.click('#customDdlSaveBtn'); const a = await c5Wait(() => nPut === p0 + 1); const b = await page.waitForFunction((w0) => catalogWritesDone > w0, w0, { timeout: WAIT }).then(() => true, () => false); return a && b; };
      /** 开始一次保存但不等它结束：点进入编辑、点保存，等 PUT 到达 route（被 putHold 扣住） */
      const startSave = async () => { const p0 = nPut; await page.click('#customDdlEditBtn'); await page.click('#customDdlSaveBtn'); return c5Wait(() => nPut === p0 + 1); };
      const closeEditor = async () => { await page.locator('#dimDdlPreviewModal button').filter({ hasText: /^\s*关闭\s*$/ }).click(); return page.waitForSelector('#dimDdlPreviewModal', { state: 'detached', timeout: WAIT }).then(() => true, () => false); };
      const focusInfo = () => page.evaluate(() => { const a = document.activeElement; const d = document.getElementById('modelDetailDrawer'); return { isBody: a === document.body, isClose: !!a && a.id === 'modelDrawerCloseBtn', inDrawer: !!(a && d && d.contains(a)), tag: a ? a.tagName : null, text: a ? (a.textContent || '').trim().slice(0, 24) : null }; });
      const waitFocusText = (t) => page.waitForFunction((t) => { const a = document.activeElement; return !!a && a.tagName === 'BUTTON' && (a.textContent || '').trim() === t; }, t, { timeout: WAIT }).then(() => true, () => false);
      /** 模拟 HTTP 非安全上下文下「复制」的回退路径：往 body 追加再移除一个 textarea（body childList 变化 → 触发 syncModelDrawerInert） */
      const churn = async () => { await page.evaluate(() => { const t = document.createElement('textarea'); document.body.appendChild(t); t.remove(); }); await c5Settle(page); };
      const ensureToast = async () => { const has = () => page.evaluate(() => !!document.getElementById('toast-container')); if (!(await has())) { await page.evaluate(() => { showToast('W108 预热', 'info'); }); await page.waitForFunction(() => !!document.getElementById('toast-container'), null, { timeout: WAIT }).catch(() => {}); } return has(); };

      // —— 前提：MC 依赖的三个 CAT 全局名都在；toast 容器已存在
      const names = await page.evaluate(() => ({ done: typeof catalogWritesDone, inflight: typeof catalogWritesInFlight, hook: typeof catalogHookModalOpen }));
      check('W108 前提：MC 依赖的三个 CAT 全局名都在——catalogWritesDone 是 number、catalogWritesInFlight 是 number、catalogHookModalOpen 是 function（任一被改名即判红；MC 里有 typeof 守卫，改名后会静默失效，只有这条能看见）', names.done === 'number' && names.inflight === 'number' && names.hook === 'function', names);
      const toast0 = await ensureToast();
      check('W108 前提：#toast-container 已存在（后面的 body 增删断言不靠「第一次 toast 创建容器」这个副作用来触发 sync）', toast0, { toast0 });

      // —— a：写过 → 刷新
      {
        const okOpen = await c5Open(page, 58, 'W108a');
        const tl1 = await TIMELINE_N(1);
        const r0 = await c5Read(page);
        check('W108a 前提：抽屉属于 #58（custom：分支提示「手工脚本模式」）、「最近验收」= ✓ 通过、没有需复验徽标、时间线 1 行（W108 旧日志）且没有「验收后」',
          okOpen && tl1 && new RegExp('#58(?!\\d)').test(r0.sub || '') && (r0.note || '').includes('手工脚本模式') && !!r0.acc && r0.acc.text === '✓ 通过' && r0.acc.recheck === null && J(r0.rows.map((x) => [x.text, x.after])) === J([['W108 旧日志（甲）', false]]), { sub: r0.sub, acc: r0.acc && r0.acc.text, recheck: r0.acc && r0.acc.recheck, rows: r0.rows });
        const marked = await markDdlBtn('data-w108-old');
        const edOk = await openEditor();
        const nD0 = stub.ctl.nD[58] || 0, nL0 = stub.ctl.nL[58] || 0;
        const saved = await saveInEditor();
        await c5Settle(page);
        const rMid = await c5Read(page);
        check('W108a 保存后、编辑器还开着：前提——「查看 DDL →」按钮已打标、编辑器已出现、edit-script 写请求已发出且目录页写入计数 +1；此刻抽屉还没刷新（详情 / 变更日志请求数不变、「最近验收」仍 = ✓ 通过）',
          marked && edOk && saved && (stub.ctl.nD[58] || 0) === nD0 && (stub.ctl.nL[58] || 0) === nL0 && !!rMid.acc && rMid.acc.text === '✓ 通过', { marked, edOk, saved, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0, acc: rMid.acc && rMid.acc.text });
        // 钩子闸：编辑器开着（带钩子的弹窗开着）、写已结束，body 子节点增删触发 sync，不能重载（也不能把焦点抢到抽屉关闭按钮）
        const toastA = await ensureToast();
        await churn();
        const keptMid = await hasMark('data-w108-old');
        const fiMid = await focusInfo();
        check('W108a 编辑器开着时 body 子节点增删（模拟 HTTP 下复制回退的 textarea 增删）：前提——toast 容器已存在、本次写已结束（目录页写入计数已增长）、编辑器仍开着；sync 跑过但不重载——详情 / 变更日志请求数都不变、打标的按钮节点还在、焦点不在抽屉关闭按钮上（带钩子的弹窗开着这道闸）',
          toastA && saved && (stub.ctl.nD[58] || 0) === nD0 && (stub.ctl.nL[58] || 0) === nL0 && keptMid && !fiMid.isClose, { toastA, saved, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0, keptMid, fiMid });
        const closed = await closeEditor();
        const reloaded = await page.waitForFunction(() => !!document.querySelector('#modelDrawerBody .mdc-acc-recheck'), null, { timeout: WAIT }).then(() => true, () => false);
        const tl2 = await TIMELINE_N(2);
        const focused = await waitFocusText('查看 DDL →');
        const r1 = await c5Read(page);
        const fi = await focusInfo();
        const oldGone = !(await hasMark('data-w108-old'));
        check('W108a 关闭编辑器后：前提——编辑器已移除、抽屉重载完成（出现需复验徽标）、时间线重画为 2 行、副标题仍含 #58；详情请求次数 +1、变更日志请求次数 +1（各恰 1 次，不重复）',
          closed && reloaded && tl2 && new RegExp('#58(?!\\d)').test(r1.sub || '') && (stub.ctl.nD[58] || 0) === nD0 + 1 && (stub.ctl.nL[58] || 0) === nL0 + 1, { closed, reloaded, tl2, sub: r1.sub, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        check('W108a 刷新后的「最近验收」= 上次通过 ✓、类名含 mdc-acc-stale、完整时间 2026-10-01 10:30、需复验（语义琥珀）、reason = 后端 stale 文案（切成 stale 的是详情替身，没刷新就读不到）',
          c5AccOk(r1.acc, { text: '上次通过 ✓', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: '2026-10-01 10:30', recheck: true, reason: C5_STALE_REASON }), r1.acc);
        check('W108a 刷新后的时间线：2 行——新增的「W108 脚本编辑」带「验收后」且 title =「发生在上次通过的验收（2026-10-01 10:30）之后」，原有的「W108 旧日志」不带',
          J(r1.rows.map((x) => [x.text, x.after, x.title])) === J([['W108 脚本编辑（丁）', true, '发生在上次通过的验收（2026-10-01 10:30）之后'], ['W108 旧日志（甲）', false, null]]), r1.rows);
        check('W108a 焦点：重载后落在重建出来的「查看 DDL →」按钮上（旧按钮节点已随抽屉重建而消失；焦点不在 body、在抽屉内）',
          focused && oldGone && !fi.isBody && fi.inDrawer && fi.tag === 'BUTTON' && fi.text === '查看 DDL →', { focused, oldGone, fi });
        await c5Close(page);
      }
      // —— b：没写过就关闭 → 不重载
      {
        const okOpen = await c5Open(page, 58, 'W108b');
        const tl2 = await TIMELINE_N(2);
        const marked = await markDdlBtn('data-w108-keep');
        const edOk = await openEditor();
        const nD0 = stub.ctl.nD[58] || 0, nL0 = stub.ctl.nL[58] || 0;
        const closed = await closeEditor();
        await c5Settle(page);
        const kept = await hasMark('data-w108-keep');
        check('W108b 没写过就关闭编辑器：前提——抽屉属于 #58 且时间线 2 行、按钮已打标、编辑器开过又移除（移除后再等两帧：弹窗关闭的处理在移除的同一个微任务里同步跑完，重载会当场清空并重画正文）；抽屉没有重建（打标的按钮节点还在）、详情与变更日志请求数都不变',
          okOpen && tl2 && marked && edOk && closed && kept && (stub.ctl.nD[58] || 0) === nD0 && (stub.ctl.nL[58] || 0) === nL0, { okOpen, tl2, marked, edOk, closed, kept, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        // 只读弹窗「验收记录 →」：打开再 Esc 关掉，同样不重载（它不写；节点仍在）
        await page.locator('#modelDrawerBody button', { hasText: '验收记录' }).click();
        const tmOk = await page.waitForSelector('#modelDrawerTestModal', { timeout: WAIT }).then(() => true, () => false);
        await page.keyboard.press('Escape');
        const tmGone = await page.waitForSelector('#modelDrawerTestModal', { state: 'detached', timeout: WAIT }).then(() => true, () => false);
        const focused2 = await waitFocusText('验收记录 →');
        await c5Settle(page);
        const kept2 = await hasMark('data-w108-keep');
        const nOpen = await page.evaluate(() => document.getElementById('modelDetailDrawer').classList.contains('open'));
        check('W108b 只读弹窗「验收记录 →」打开后用 Esc 关掉：前提——弹窗出现过又移除、抽屉仍开着、焦点归还到「验收记录 →」；抽屉没有重建（打标节点还在）、详情请求数不变', tmOk && tmGone && focused2 && nOpen && kept2 && (stub.ctl.nD[58] || 0) === nD0, { tmOk, tmGone, focused2, nOpen, kept2, nD: (stub.ctl.nD[58] || 0) - nD0 });
        await c5Close(page);
      }
      // —— c：编辑器打开期间抽屉被关掉 → 关闭编辑器后不重开
      {
        const okOpen = await c5Open(page, 58, 'W108c');
        const edOk = await openEditor();
        const saved = await saveInEditor();
        await page.keyboard.press('Escape');   // 非派生弹窗（DDL 编辑器）不在 Esc 层级里，Esc 直接关抽屉
        const drawerClosed = await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT }).then(() => true, () => false);
        const nD0 = stub.ctl.nD[58] || 0, nL0 = stub.ctl.nL[58] || 0;
        const closed = await closeEditor();
        await c5Settle(page);
        const st = await page.evaluate(() => ({ open: document.getElementById('modelDetailDrawer').classList.contains('open'), overlay: document.getElementById('modelDrawerOverlay').classList.contains('open'), ctxNull: mdcCtx === null }));
        check('W108c 编辑器打开期间抽屉被关掉：前提——抽屉已开过并保存过（写入计数涨过）、Esc 后抽屉已关、编辑器随后被关闭；关闭编辑器后抽屉仍是关闭状态（不重开：.open 与遮罩都没有、当前导航 ctx 为空）、详情 / 变更日志请求数不变',
          okOpen && edOk && saved && drawerClosed && closed && !st.open && !st.overlay && st.ctxNull && (stub.ctl.nD[58] || 0) === nD0 && (stub.ctl.nL[58] || 0) === nL0, { okOpen, edOk, saved, drawerClosed, closed, st, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
      }
      // —— d：编辑器打开期间抽屉换了模型 → 不重载、不串到 #58；换到 #55 之后在编辑器里再保存一次、关闭编辑器，也不重载 #55（修复批 4：那两次保存都是 #58 的，#55 的 ctx 没点过自己的「查看 DDL →」，hookSeen 从 false 起步、不继承）
      {
        const okOpen = await c5Open(page, 58, 'W108d');
        const edOk = await openEditor();
        const saved = await saveInEditor();
        await page.evaluate(() => { openModelDrawer(55, null); });   // 编辑器仍开着，抽屉换到 #55（程序化切换；界面上抽屉被编辑器盖着点不到）
        const ok55 = await c5Rendered(page, 55);
        await page.evaluate(() => { const k = document.querySelector('#modelDrawerBody .kv'); if (k) k.setAttribute('data-w108-55', '1'); });
        const saved2 = await saveInEditor();   // 换了模型之后，在还开着的编辑器里再保存一次（#58 的第二次写，写入计数再涨）
        const nD58 = stub.ctl.nD[58] || 0, nD55 = stub.ctl.nD[55] || 0;
        const closed = await closeEditor();
        await c5Settle(page);
        const r = await c5Read(page);
        const kept = await hasMark('data-w108-55');
        check('W108d 编辑器打开期间抽屉换了模型（#58 → #55）：前提——写过（写入计数涨过）、#55 已渲染且正文打标、换模型之后在编辑器里又保存了一次（写入计数再涨）、编辑器随后被关闭；关闭后抽屉仍是 #55（副标题含 #55、不含 #58）、#55 的正文节点还在（没有重载：这两次保存都是 #58 的）、#58 与 #55 的详情请求数都不变',
          okOpen && edOk && saved && ok55 && saved2 && closed && kept && new RegExp('#55(?!\\d)').test(r.sub || '') && !/#58(?!\d)/.test(r.sub || '') && (stub.ctl.nD[58] || 0) === nD58 && (stub.ctl.nD[55] || 0) === nD55, { okOpen, edOk, saved, ok55, saved2, closed, kept, sub: r.sub, d58: (stub.ctl.nD[58] || 0) - nD58, d55: (stub.ctl.nD[55] || 0) - nD55 });
        await c5Close(page);
      }
      // —— d2（修复批 5，预筛 MED-1）：写入基数按 ctx 重置——#50 打开期间有一个无关写结束（#50 不重载，计数增长）→ 不关抽屉、换到 #58（下游引用项 / 主模型链接的做法）→ 点「查看 DDL →」、编辑器挂上后不写就关 → #58 不重载
      //   基数若沿用 #50 的（计数已比它大）而 hookSeen 又为真，关闭编辑器就会重载 #58；d 里 #55 的 hookSeen 从 false 起步，这道闸先挡住，看不出基数，所以另设这一腿
      {
        stub.ctl.detail[58] = { acceptance: ACC_PASS }; stub.ctl.logs[58] = LOGS1;
        flip = true; putMode = 'ok'; putHold = null;
        const okOpen = await c5Open(page, 50, 'W108d2');
        const w0 = await page.evaluate(() => catalogWritesDone);
        await page.evaluate(() => { window.__w108d2P = new Promise((r) => { window.__w108d2Res = r; }); catalogTrackWrite(window.__w108d2P); });   // 与 #50 无关的写
        const inflight = await page.evaluate(() => catalogWritesInFlight);
        await page.evaluate(() => { window.__w108d2Res(); });
        const settled = await page.waitForFunction((w0) => catalogWritesInFlight === 0 && catalogWritesDone > w0, w0, { timeout: WAIT }).then(() => true, () => false);   // 正向信号：写已结束（#50 没点过「查看 DDL →」，不重载）
        await c5Settle(page);
        await page.evaluate(() => { openModelDrawer(58, null); });   // 不关抽屉，直接换模型
        const ok58 = await c5Rendered(page, 58);
        const tl1 = await TIMELINE_N(1);
        const ctx = await page.evaluate(() => ({ id: mdcCtx && mdcCtx.modelId, base: mdcCtx && mdcCtx.writesBase, done: catalogWritesDone }));
        const marked = await markDdlBtn('data-w108-d2');
        const edOk = await openEditor();
        const nD0 = stub.ctl.nD[58] || 0, nL0 = stub.ctl.nL[58] || 0;
        const closed = await closeEditor();   // 没有写
        await c5Settle(page);
        const kept = await hasMark('data-w108-d2');
        check('W108d2 #50 打开期间有无关写结束后换到 #58、点「查看 DDL →」不写就关编辑器：前提——#50 抽屉已渲染、无关写已发起（在途数 = 1）并结束（写入计数增长）、#58 已渲染（时间线 1 行）且它的写入基数 = 换模型那一刻的计数（不沿用 #50 的）、按钮已打标、编辑器开过并已关闭；#58 不重载——打标的按钮节点还在、详情 / 变更日志请求数不变',
          okOpen && inflight === 1 && settled && ok58 && tl1 && ctx.id === 58 && ctx.base === ctx.done && marked && edOk && closed && kept && (stub.ctl.nD[58] || 0) === nD0 && (stub.ctl.nL[58] || 0) === nL0, { okOpen, inflight, settled, ok58, tl1, ctx, marked, edOk, closed, kept, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        await c5Close(page);
      }
      // —— e：写请求在途时关闭编辑器 → 此刻不重载；写结束（成功 / 失败）后恰好重载一次
      for (const mode of ['ok', 'abort']) {
        const tag = mode === 'ok' ? 'e1 成功' : 'e2 失败（route.abort）';
        stub.ctl.detail[58] = { acceptance: ACC_PASS }; stub.ctl.logs[58] = LOGS1;
        flip = false; putMode = 'ok'; putHold = null;   // 第一次保存：成功、不切替身（只为让「计数已增长」成立）
        const okOpen = await c5Open(page, 58, 'W108' + tag);
        const tl1 = await TIMELINE_N(1);
        const marked = await markDdlBtn('data-w108-e');
        const edOk = await openEditor();
        const saved1 = await saveInEditor();
        flip = (mode === 'ok'); putMode = mode; putHold = gate();   // 第二次保存：PUT 被扣住；成功腿放行时才把替身切到「写入之后」
        const started = await startSave();
        const nD0 = stub.ctl.nD[58] || 0, nL0 = stub.ctl.nL[58] || 0;
        const closed = await closeEditor();
        await c5Settle(page);
        const kept = await hasMark('data-w108-e');
        const inflight = await page.evaluate(() => catalogWritesInFlight);
        const rBefore = await c5Read(page);
        check(`W108${tag} 在途时关闭编辑器：前提——抽屉属于 #58 且时间线 1 行、按钮已打标、第一次保存已结束（计数已增长）、第二次 PUT 已发出并被扣住（在途数 = 1）、编辑器已移除；此刻不重载——详情 / 变更日志请求数不变、打标的按钮节点还在、「最近验收」仍 = ✓ 通过`,
          okOpen && tl1 && marked && edOk && saved1 && started && closed && inflight === 1 && kept && (stub.ctl.nD[58] || 0) === nD0 && (stub.ctl.nL[58] || 0) === nL0 && !!rBefore.acc && rBefore.acc.text === '✓ 通过', { okOpen, tl1, marked, edOk, saved1, started, closed, inflight, kept, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0, acc: rBefore.acc && rBefore.acc.text });
        putHold.release();
        const reloaded = await page.waitForFunction(() => !document.querySelector('#modelDrawerBody [data-w108-e]') && !!document.querySelector('#modelDrawerBody .foot-links'), null, { timeout: WAIT }).then(() => true, () => false);
        const tlN = await TIMELINE_N(mode === 'ok' ? 2 : 1);
        await c5Settle(page);
        const rAfter = await c5Read(page);
        const nDone = await page.evaluate(() => ({ inflight: catalogWritesInFlight }));
        check(`W108${tag} 放行后：前提——被扣住的 PUT 已${mode === 'ok' ? '成功返回' : '被 route.abort（请求失败）'}、在途数归零、抽屉已重载（打标节点已消失）；恰好重载一次——详情请求 +1、变更日志请求 +1（写结束的因果时点，成败都算；不是 0 次也不是 2 次）`,
          reloaded && tlN && nDone.inflight === 0 && (stub.ctl.nD[58] || 0) === nD0 + 1 && (stub.ctl.nL[58] || 0) === nL0 + 1 && new RegExp('#58(?!\\d)').test(rAfter.sub || ''), { reloaded, tlN, nDone, sub: rAfter.sub, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        if (mode === 'ok') check('W108e1 成功腿重载读到的是写入之后的状态：「最近验收」= 上次通过 ✓ + 需复验（这一次才由第二次 PUT 成功把详情替身切成 stale，证明重载发生在写结束之后）、时间线新行「W108 脚本编辑」带「验收后」',
          c5AccOk(rAfter.acc, { text: '上次通过 ✓', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: '2026-10-01 10:30', recheck: true, reason: C5_STALE_REASON }) && rAfter.rows.length === 2 && rAfter.rows[0].text === 'W108 脚本编辑（丁）' && rAfter.rows[0].after === true, { acc: rAfter.acc, rows: rAfter.rows });
        else check('W108e2 失败腿重载读到的仍是未变的状态：「最近验收」= ✓ 通过（写入失败，替身没切 stale）、时间线 1 行', !!rAfter.acc && rAfter.acc.text === '✓ 通过' && rAfter.acc.recheck === null && rAfter.rows.length === 1, { acc: rAfter.acc && rAfter.acc.text, rows: rAfter.rows });
        putHold = null; putMode = 'ok'; flip = true;
        await c5Close(page);
      }
      // —— e3（修复批 3，预筛待裁 2）：前面不先保存——只有被扣住的这一次写：打开编辑器 → 保存（扣住 PUT）→ 关闭编辑器 → 此刻不重载 → 放行 → 恰好重载一次
      //   e1 / e2 里前面已经保存过一次，计数早已大于基数，看不见「事件派发早于计数 +1」；这里计数在这次写结束之前 = 基数，只有「事件在计数 +1 之后派发」才会重载
      {
        stub.ctl.detail[58] = { acceptance: ACC_PASS }; stub.ctl.logs[58] = LOGS1;
        flip = true; putMode = 'ok'; putHold = null;
        const okOpen = await c5Open(page, 58, 'W108e3');
        const tl1 = await TIMELINE_N(1);
        const marked = await markDdlBtn('data-w108-e3');
        const edOk = await openEditor();
        const w0 = await page.evaluate(() => catalogWritesDone);   // 这个抽屉打开以来还没有任何写结束
        putHold = gate();
        const started = await startSave();
        const nD0 = stub.ctl.nD[58] || 0, nL0 = stub.ctl.nL[58] || 0;
        const closed = await closeEditor();
        await c5Settle(page);
        const kept = await hasMark('data-w108-e3');
        const st = await page.evaluate(() => ({ inflight: catalogWritesInFlight, done: catalogWritesDone }));
        const rBefore = await c5Read(page);
        check('W108e3 只有被扣住的这一次写、关闭编辑器：前提——抽屉属于 #58 且时间线 1 行、按钮已打标、编辑器开过、PUT 已发出并被扣住（在途数 = 1）、此刻没有任何写结束（写入计数 = 打开抽屉后读到的 w0）、编辑器已移除；此刻不重载——详情 / 变更日志请求数不变、打标的按钮节点还在、「最近验收」仍 = ✓ 通过',
          okOpen && tl1 && marked && edOk && started && closed && st.inflight === 1 && st.done === w0 && kept && (stub.ctl.nD[58] || 0) === nD0 && (stub.ctl.nL[58] || 0) === nL0 && !!rBefore.acc && rBefore.acc.text === '✓ 通过', { okOpen, tl1, marked, edOk, started, closed, st, w0, kept, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0, acc: rBefore.acc && rBefore.acc.text });
        putHold.release();
        const reloaded = await page.waitForFunction(() => !document.querySelector('#modelDrawerBody [data-w108-e3]') && !!document.querySelector('#modelDrawerBody .foot-links'), null, { timeout: WAIT }).then(() => true, () => false);
        const tl2 = await TIMELINE_N(2);
        await c5Settle(page);
        const rAfter = await c5Read(page);
        const st2 = await page.evaluate(() => ({ inflight: catalogWritesInFlight, done: catalogWritesDone }));
        check('W108e3 放行后：前提——被扣住的 PUT 已成功返回、在途数归零、写入计数 = w0 + 1、抽屉已重载（打标节点已消失、时间线 2 行）；恰好重载一次——详情请求 +1、变更日志请求 +1（写结束的因果时点；事件必须在计数 +1 之后派发，否则这里读到的计数 = 基数、不重载）',
          reloaded && tl2 && st2.inflight === 0 && st2.done === w0 + 1 && (stub.ctl.nD[58] || 0) === nD0 + 1 && (stub.ctl.nL[58] || 0) === nL0 + 1 && new RegExp('#58(?!\\d)').test(rAfter.sub || ''), { reloaded, tl2, st2, w0, sub: rAfter.sub, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        check('W108e3 重载读到的是写入之后的状态：「最近验收」= 上次通过 ✓ + 需复验（由这一次 PUT 成功把详情替身切成 stale，证明重载发生在写结束之后）、时间线新行「W108 脚本编辑」带「验收后」',
          c5AccOk(rAfter.acc, { text: '上次通过 ✓', cls: 'mdc-acc-stale', color: C5_COLOR.ink, date: '2026-10-01 10:30', recheck: true, reason: C5_STALE_REASON }) && rAfter.rows.length === 2 && rAfter.rows[0].text === 'W108 脚本编辑（丁）' && rAfter.rows[0].after === true, { acc: rAfter.acc, rows: rAfter.rows });
        putHold = null;
        await c5Close(page);
      }
      // —— f（修复批 3 改期望，主会话改判）：无关的在途写——抽屉打开前已在途、打开后才结束的写（不是这个抽屉发起的：它没点过「查看 DDL →」）：结束时不重载
      //   修复批 4（预筛 MED-1）：输入搜索词之后、放行之前，开关一次只读弹窗「验收记录 →」（不带钩子、不置 hookSeen），放行后仍不重载——钉住「保存类弹窗 vs 其他子弹窗」的边界
      {
        stub.ctl.detail[50] = undefined; stub.ctl.logs[50] = undefined;
        await page.evaluate(() => { window.__w108fP = new Promise((r) => { window.__w108fRes = r; }); catalogTrackWrite(window.__w108fP); });
        const inflight1 = await page.evaluate(() => catalogWritesInFlight);
        const w0 = await page.evaluate(() => catalogWritesDone);
        const okOpen = await c5Open(page, 50, 'W108f');
        const tlOk = await page.waitForFunction(() => !!document.querySelector('#modelDrawerBody .mdc-timeline') && !!document.querySelector('#modelDrawerBody .field-search'), null, { timeout: WAIT }).then(() => true, () => false);
        await page.fill('#modelDrawerBody .field-search', 'w108f-search');
        await page.evaluate(() => { document.querySelector('#modelDrawerBody .field-search').setAttribute('data-w108-f', '1'); });
        const nD0 = stub.ctl.nD[50] || 0, nL0 = stub.ctl.nL[50] || 0;
        await churn();
        const keptIn = await hasMark('data-w108-f');
        const inflight2 = await page.evaluate(() => catalogWritesInFlight);
        check('W108f 前提：打开抽屉前页内已发起一个在途写（在途数 = 1，由测试控制何时 resolve）、非 custom 的 #50 抽屉已渲染、字段搜索框里输入了文字并打标；在途期间 body 增删（sync）不重载——详情 / 变更日志请求数不变、打标的搜索框节点还在',
          inflight1 === 1 && okOpen && tlOk && inflight2 === 1 && keptIn && (stub.ctl.nD[50] || 0) === nD0 && (stub.ctl.nL[50] || 0) === nL0, { inflight1, okOpen, tlOk, inflight2, keptIn, nD: (stub.ctl.nD[50] || 0) - nD0, nL: (stub.ctl.nL[50] || 0) - nL0 });
        // 开关一次只读弹窗「验收记录 →」（无关的写仍在途），再把焦点放回搜索框
        await page.locator('#modelDrawerBody button', { hasText: '验收记录' }).click();
        const tmOk = await page.waitForSelector('#modelDrawerTestModal', { timeout: WAIT }).then(() => true, () => false);
        await page.keyboard.press('Escape');
        const tmGone = await page.waitForSelector('#modelDrawerTestModal', { state: 'detached', timeout: WAIT }).then(() => true, () => false);
        const refocused = await waitFocusText('验收记录 →');
        await page.focus('#modelDrawerBody .field-search');
        await c5Settle(page);
        const keptRo = await hasMark('data-w108-f');
        const valRo = await page.evaluate(() => { const e = document.querySelector('#modelDrawerBody .field-search'); return e ? e.value : null; });
        check('W108f 开关一次只读弹窗「验收记录 →」：前提——弹窗出现过又移除、焦点曾归还到「验收记录 →」、此刻已把焦点放回搜索框；抽屉没有重建——打标的搜索框节点还在、文字仍是 w108f-search、详情 / 变更日志请求数不变（只读弹窗不是保存类弹窗，不置 hookSeen）',
          tmOk && tmGone && refocused && keptRo && valRo === 'w108f-search' && (stub.ctl.nD[50] || 0) === nD0 && (stub.ctl.nL[50] || 0) === nL0, { tmOk, tmGone, refocused, keptRo, valRo, nD: (stub.ctl.nD[50] || 0) - nD0, nL: (stub.ctl.nL[50] || 0) - nL0 });
        await page.evaluate(() => { window.__w108fRes(); });
        const settled = await page.waitForFunction((w0) => catalogWritesInFlight === 0 && catalogWritesDone > w0, w0, { timeout: WAIT }).then(() => true, () => false);   // 正向信号：写已结束（事件在同一同步段里派发完，重载若发生会当场清空并重画正文）
        await c5Settle(page);
        const kept = await hasMark('data-w108-f');
        const val = await page.evaluate(() => { const e = document.querySelector('#modelDrawerBody .field-search'); return e ? e.value : null; });
        const fi = await page.evaluate(() => { const a = document.activeElement; return { isMark: !!a && a.getAttribute('data-w108-f') === '1', isClose: !!a && a.id === 'modelDrawerCloseBtn', isBody: a === document.body }; });
        const r1 = await c5Read(page);
        check('W108f 放行无关的写之后（修复批 3 口径：不是这个抽屉发起的写，结束时不重载；修复批 4：中间开关过一次只读弹窗也一样）：前提——写已结束（在途数归零、写入计数增长）；抽屉没有重建——打标的搜索框节点还在、搜索框里的文字仍是 w108f-search、焦点仍在这个搜索框上（不在关闭按钮、不在 body）、详情请求数不变、变更日志请求数不变、副标题仍含 #50',
          settled && kept && val === 'w108f-search' && fi.isMark && !fi.isClose && !fi.isBody && (stub.ctl.nD[50] || 0) === nD0 && (stub.ctl.nL[50] || 0) === nL0 && new RegExp('#50(?!\\d)').test(r1.sub || ''), { settled, kept, val, fi, nD: (stub.ctl.nD[50] || 0) - nD0, nL: (stub.ctl.nL[50] || 0) - nL0, sub: r1.sub });
        await churn();
        const kept2 = await hasMark('data-w108-f');
        check('W108f 写结束之后再对 body 做一次增删（sync）：仍不重载——打标的搜索框节点还在、详情 / 变更日志请求数不变（没有任何时刻会因这个无关的写重载）', kept2 && (stub.ctl.nD[50] || 0) === nD0 && (stub.ctl.nL[50] || 0) === nL0, { kept2, nD: (stub.ctl.nD[50] || 0) - nD0, nL: (stub.ctl.nL[50] || 0) - nL0 });
        await c5Close(page);
      }
      // —— f2（已登记的残余，钉住现状；不是理想行为，将来想「顺手修」须先改这一条的期望）：同一个抽屉里点过「查看 DDL →」、编辑器开过又关了但没写，之后有任何写结束（与这个抽屉无关的写也算）→ 重载一次；
      //   修复批 4（预筛 LOW-1）：重载换新 ctx、hookSeen 归零，所以至多一次——重载完成后再来一个无关写，不再重载
      {
        stub.ctl.detail[58] = { acceptance: ACC_PASS }; stub.ctl.logs[58] = LOGS1;
        flip = true; putMode = 'ok'; putHold = null;
        const okOpen = await c5Open(page, 58, 'W108f2');
        const tl1 = await TIMELINE_N(1);
        const marked = await markDdlBtn('data-w108-f2');
        const edOk = await openEditor();
        const closed = await closeEditor();   // 编辑器开过又关了，没有写
        await c5Settle(page);
        const keptA = await hasMark('data-w108-f2');
        const nD0 = stub.ctl.nD[58] || 0, nL0 = stub.ctl.nL[58] || 0;
        const w0 = await page.evaluate(() => catalogWritesDone);
        await page.evaluate(() => { window.__w108f2P = new Promise((r) => { window.__w108f2Res = r; }); catalogTrackWrite(window.__w108f2P); });   // 与这个抽屉无关的写
        const inflight = await page.evaluate(() => catalogWritesInFlight);
        await c5Settle(page);
        const keptB = await hasMark('data-w108-f2');
        check('W108f2 前提：抽屉属于 #58 且时间线 1 行、按钮已打标、编辑器开过又关了（没有写）、此刻抽屉没有重建（打标节点还在、详情 / 变更日志请求数不变）；随后页内发起的无关写在途（在途数 = 1）期间同样不重载',
          okOpen && tl1 && marked && edOk && closed && keptA && inflight === 1 && keptB && (stub.ctl.nD[58] || 0) === nD0 && (stub.ctl.nL[58] || 0) === nL0, { okOpen, tl1, marked, edOk, closed, keptA, inflight, keptB, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        await page.evaluate(() => { window.__w108f2Res(); });
        const reloaded = await page.waitForFunction(() => !document.querySelector('#modelDrawerBody [data-w108-f2]') && !!document.querySelector('#modelDrawerBody .foot-links'), null, { timeout: WAIT }).then(() => true, () => false);
        const tlN = await TIMELINE_N(1);
        await c5Settle(page);
        const st = await page.evaluate(() => ({ inflight: catalogWritesInFlight, done: catalogWritesDone }));
        const r1 = await c5Read(page);
        check('W108f2 放行无关的写之后（登记的残余现状：hookSeen 不区分这次写是不是这个抽屉发起的）：前提——在途数归零、写入计数 = w0 + 1、抽屉已重载（打标节点消失、时间线 1 行、副标题仍含 #58）；恰好重载一次——详情请求 +1、变更日志请求 +1',
          reloaded && tlN && st.inflight === 0 && st.done === w0 + 1 && (stub.ctl.nD[58] || 0) === nD0 + 1 && (stub.ctl.nL[58] || 0) === nL0 + 1 && new RegExp('#58(?!\\d)').test(r1.sub || ''), { reloaded, tlN, st, w0, sub: r1.sub, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        // 至多一次：重载换了新 ctx（hookSeen 从 false 起步），给新节点打标，再发起并放行一个无关写 → 不再重载
        const marked2 = await markDdlBtn('data-w108-f2b');
        const w1 = await page.evaluate(() => catalogWritesDone);
        await page.evaluate(() => { window.__w108f2bP = new Promise((r) => { window.__w108f2bRes = r; }); catalogTrackWrite(window.__w108f2bP); });
        const inflightB = await page.evaluate(() => catalogWritesInFlight);
        await page.evaluate(() => { window.__w108f2bRes(); });
        const settledB = await page.waitForFunction((w1) => catalogWritesInFlight === 0 && catalogWritesDone > w1, w1, { timeout: WAIT }).then(() => true, () => false);   // 正向信号：这个无关写已结束
        await c5Settle(page);
        const keptC = await hasMark('data-w108-f2b');
        check('W108f2 至多一次：前提——重载后的新节点已打标、第二个无关写已发起（在途数 = 1）并结束（在途数归零、写入计数 = w1 + 1）；新 ctx 的 hookSeen 从 false 起步，不再重载——打标节点还在、详情 / 变更日志请求数仍是上一步之后的值',
          marked2 && inflightB === 1 && settledB && keptC && (stub.ctl.nD[58] || 0) === nD0 + 1 && (stub.ctl.nL[58] || 0) === nL0 + 1, { marked2, inflightB, settledB, keptC, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        await c5Close(page);
      }
      // —— g（修复批 3，预筛 LOW-1）：写在途时先关闭编辑器、再打开只读弹窗「验收记录 →」→ 放行：弹窗还开着时不重载（抽屉在弹窗底下重载会让触发按钮脱离文档、焦点丢）→ Esc 关闭只读弹窗 → 恰好重载一次、焦点回到「验收记录 →」
      {
        stub.ctl.detail[58] = { acceptance: ACC_PASS }; stub.ctl.logs[58] = LOGS1;
        flip = true; putMode = 'ok'; putHold = null;
        const okOpen = await c5Open(page, 58, 'W108g');
        const tl1 = await TIMELINE_N(1);
        const marked = await markDdlBtn('data-w108-g');
        const edOk = await openEditor();
        const w0 = await page.evaluate(() => catalogWritesDone);
        putHold = gate();
        const started = await startSave();
        const closed = await closeEditor();
        await c5Settle(page);
        await page.locator('#modelDrawerBody button', { hasText: '验收记录' }).click();
        const tmOk = await page.waitForSelector('#modelDrawerTestModal', { timeout: WAIT }).then(() => true, () => false);
        const nD0 = stub.ctl.nD[58] || 0, nL0 = stub.ctl.nL[58] || 0;
        const inflight = await page.evaluate(() => catalogWritesInFlight);
        putHold.release();
        const settled = await page.waitForFunction((w0) => catalogWritesInFlight === 0 && catalogWritesDone > w0, w0, { timeout: WAIT }).then(() => true, () => false);   // 正向信号：被扣住的写已结束（事件已同步派发完）
        await c5Settle(page);
        const keptG = await hasMark('data-w108-g');
        const modalStill = await page.evaluate(() => !!document.getElementById('modelDrawerTestModal'));
        check('W108g 只读弹窗开着时写结束：前提——抽屉属于 #58、按钮已打标、编辑器开过并已关闭、PUT 被扣住（在途数 = 1）、「验收记录 →」弹窗已打开；放行后写已结束（在途数归零、写入计数增长）、弹窗仍开着，此刻不重载——打标的按钮节点还在、详情 / 变更日志请求数不变',
          okOpen && tl1 && marked && edOk && started && closed && tmOk && inflight === 1 && settled && modalStill && keptG && (stub.ctl.nD[58] || 0) === nD0 && (stub.ctl.nL[58] || 0) === nL0, { okOpen, tl1, marked, edOk, started, closed, tmOk, inflight, settled, modalStill, keptG, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        await page.keyboard.press('Escape');
        const tmGone = await page.waitForSelector('#modelDrawerTestModal', { state: 'detached', timeout: WAIT }).then(() => true, () => false);
        const reloaded = await page.waitForFunction(() => !document.querySelector('#modelDrawerBody [data-w108-g]') && !!document.querySelector('#modelDrawerBody .foot-links'), null, { timeout: WAIT }).then(() => true, () => false);
        const tl2 = await TIMELINE_N(2);
        const focused = await waitFocusText('验收记录 →');
        await c5Settle(page);
        const fi = await focusInfo();
        const r1 = await c5Read(page);
        check('W108g Esc 关闭只读弹窗后：前提——弹窗已移除、抽屉已重载（打标节点消失、时间线 2 行、副标题仍含 #58）；恰好重载一次——详情请求 +1、变更日志请求 +1；焦点回到重建后的「验收记录 →」按钮（在抽屉内、不在 body）',
          tmGone && reloaded && tl2 && new RegExp('#58(?!\\d)').test(r1.sub || '') && (stub.ctl.nD[58] || 0) === nD0 + 1 && (stub.ctl.nL[58] || 0) === nL0 + 1 && focused && !fi.isBody && fi.inDrawer && fi.tag === 'BUTTON' && fi.text === '验收记录 →', { tmGone, reloaded, tl2, sub: r1.sub, focused, fi, nD: (stub.ctl.nD[58] || 0) - nD0, nL: (stub.ctl.nL[58] || 0) - nL0 });
        putHold = null;
        await c5Close(page);
      }
      // —— h（修复批 5，预筛 LOW-1）：外来编辑器竞态——列表「DDL」动作（openDimDDLModal(58)）的请求被扣住 → 打开非 custom 的 #50 抽屉、字段搜索框里输入文字 → 放行 → 外来的编辑器挂在 #50 抽屉上 → 关掉编辑器 → 放行一个无关写 → #50 不重载（外来编辑器不能把 #50 的 hookSeen 置真）
      //   钉住「hookSeen 只在抽屉自己的「查看 DDL →」点击处置真、不能挪到编辑器挂载处」（挪过去会让这条竞态回来）；残余④（点击到挂载之间有无关写）不改实现的理由也在这里
      {
        stub.ctl.detail[50] = undefined; stub.ctl.logs[50] = undefined;
        stub.ctl.detail[58] = { acceptance: ACC_PASS }; stub.ctl.logs[58] = LOGS1;
        flip = true; putMode = 'ok'; putHold = null;
        const nDa = stub.ctl.nD[58] || 0;
        stub.ctl.gateD[58] = gate();
        await page.evaluate(() => { window.__w108hOpen = openDimDDLModal(58); });   // 列表「DDL」动作走的函数；第一个请求（#58 详情）被扣住，编辑器还没挂上
        const arrived = await c5Wait(() => (stub.ctl.nD[58] || 0) > nDa);
        const okOpen = await c5Open(page, 50, 'W108h');
        const fsOk = await page.waitForFunction(() => !!document.querySelector('#modelDrawerBody .field-search'), null, { timeout: WAIT }).then(() => true, () => false);
        await page.fill('#modelDrawerBody .field-search', 'w108h-search');
        await page.evaluate(() => { document.querySelector('#modelDrawerBody .field-search').setAttribute('data-w108-h', '1'); });
        stub.ctl.gateD[58].release(); stub.ctl.gateD[58] = null;
        const modalUp = await page.waitForSelector('#dimDdlPreviewModal #customDdlEditBtn', { timeout: WAIT }).then(() => true, () => false);   // 外来编辑器挂到 #50 抽屉上
        await c5Settle(page);
        const hs = await page.evaluate(() => ({ id: mdcCtx && mdcCtx.modelId, hookSeen: mdcCtx && mdcCtx.hookSeen }));
        const gone = await closeEditor();
        await c5Settle(page);
        await page.focus('#modelDrawerBody .field-search');   // 编辑器开关过程中焦点去向不是被测对象，先放回搜索框，再看无关写结束时有没有被抢走
        const nD0 = stub.ctl.nD[50] || 0, nL0 = stub.ctl.nL[50] || 0;
        const w0 = await page.evaluate(() => catalogWritesDone);
        await page.evaluate(() => { window.__w108hP = new Promise((r) => { window.__w108hRes = r; }); catalogTrackWrite(window.__w108hP); });   // 无关写
        const inflight = await page.evaluate(() => catalogWritesInFlight);
        await page.evaluate(() => { window.__w108hRes(); });
        const settled = await page.waitForFunction((w0) => catalogWritesInFlight === 0 && catalogWritesDone > w0, w0, { timeout: WAIT }).then(() => true, () => false);   // 正向信号：写已结束
        await c5Settle(page);
        const st = await page.evaluate(() => { const e = document.querySelector('#modelDrawerBody .field-search'); const a = document.activeElement; return { marked: !!document.querySelector('#modelDrawerBody [data-w108-h]'), val: e ? e.value : null, focusMark: !!a && a.getAttribute('data-w108-h') === '1', focusClose: !!a && a.id === 'modelDrawerCloseBtn' }; });
        check('W108h 外来编辑器竞态：前提——列表「DDL」动作的请求已被扣住、#50 抽屉已渲染且搜索框输入并打标、放行后外来编辑器挂在 #50 上、此刻 #50 的 hookSeen 仍为 false、编辑器已关闭、无关写已发起（在途数 = 1）并结束（写入计数增长）；#50 不重载——打标的搜索框节点还在、文字仍是 w108h-search、焦点仍在搜索框（不在关闭按钮）、详情请求数不变',
          arrived && okOpen && fsOk && modalUp && hs.id === 50 && hs.hookSeen === false && gone && inflight === 1 && settled && st.marked && st.val === 'w108h-search' && st.focusMark && !st.focusClose && (stub.ctl.nD[50] || 0) === nD0 && (stub.ctl.nL[50] || 0) === nL0, { arrived, okOpen, fsOk, modalUp, hs, gone, inflight, settled, st, nD: (stub.ctl.nD[50] || 0) - nD0, nL: (stub.ctl.nL[50] || 0) - nL0 });
        await c5Close(page);
      }
      await page.close();
    });

    // ===== W109 / W110（末次合并审 M8 / H2）：目录页「编辑信息」保存 =====
    // W109（M8）：DIM 行「编辑信息」保存带回的 dim_config——只有 SCD 类型确实变化才带，且基于 GET /api/models/:id 取回的最新行（不是列表缓存里可能已过期的那份）。
    //   路由替身：GET /api/models/50 在 stub.latest 为真时把返回的 dim_config 加上标记 w109Marker='w109-latest'（模拟「别人在配置台改过配置」的最新行）；PUT /api/models/50 记录请求体并回 200（不落库）；
    //   弹窗打开后把列表缓存行（allModelsData 里的 #50）的 dim_config 换成带 w109Marker='w109-stale' 的旧副本（模拟本页标签一直开着、缓存过期）。
    //   ① 只改实现说明、SCD 不变 → 请求体不含 dim_config 键（让服务端保留现值）、也不会为此多发 GET /api/models/50；② 改 SCD 类型 → 恰 1 次 GET /api/models/50，PUT 的 dim_config 带 w109-latest（不含 w109-stale）、scdType = 新选的值；缓存行对象没被原地改写。
    //   变异（MC_MUT，Model_Center.html 源码替换，探针确认装上）：m8-always-dim（条件改恒真 → SCD 没变也带 dim_config）→ ① 判红；m8-from-cache（最新行改取列表缓存）→ ② 判红。
    //   收口批 2 MED-1：update_cycle / config_mode 也按弹窗打开时的基线判断是否发送——① 增断言「最新行的 SCD / update_cycle / 配置方式都被别人改过、本页只改说明 → 请求体不含 dim_config / update_cycle / config_mode」，③ 只改配置方式 → 只带 config_mode；
    //   变异 m8-uc-always（update_cycle 恒发送）→ ① 判红；m8-cm-always（config_mode 恒发送）→ ① 与 ② 判红；m8-no-scd-overwrite（改 SCD 后漏写回 dim_config.scdType）→ ② 判红（② 的替身最新行取第三个 SCD 值）。
    //   复审 47B MED-3：替身最新配置带两个哨兵（scdConfig.w109Keep、顶层 w109KeepTop 嵌套对象）；② 断言 PUT 的 dim_config 除 scdType 外与 GET 返回的配置深度相等（含两个哨兵）。
    //   变异 m8-scdconfig-replace（scdConfig 整体换成只有 scdType 的新对象）→ ② 判红；m8-drop-top-level（只回传 scdConfig、丢顶层其他配置）→ ② 判红。
    console.log('W109 M8 编辑信息：dim_config 只在 SCD 类型变化时带、且取最新行');
    {
      const { page } = await open(adminN, 'W109');
      const w109 = { latest: false, puts: [], gets: 0 };
      await page.route((u) => /^\/api\/models\/50$/.test(u.pathname), async (route) => {
        const req = route.request();
        if (req.method() === 'PUT') { w109.puts.push(JSON.parse(req.postData() || '{}')); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"模型更新成功"}' }); }
        if (req.method() === 'GET' && w109.latest) {
          w109.gets++;
          const resp = await route.fetch();
          const j = await resp.json();
          const cfg = typeof j.dim_config === 'string' ? JSON.parse(j.dim_config) : (j.dim_config || {});
          cfg.w109Marker = 'w109-latest';
          // 收口批 2 MED-1：模拟「别人已在配置台把 SCD 类型 / update_cycle / 配置方式都改掉」的最新行（w109.latestDiff 为真时与弹窗打开时的回填值全部不同）
          const diff = w109.latestDiff ? { update_cycle: w109.latestDiff.update_cycle, config_mode: w109.latestDiff.config_mode } : {};
          if (w109.latestDiff) cfg.scdConfig = Object.assign({}, cfg.scdConfig || {}, { scdType: w109.latestDiff.scdType });
          // 复审 47B MED-3：最新配置里放两个独立哨兵——scdConfig 内的 w109Keep（页面不得丢掉 scdConfig 里 scdType 之外的子配置）与顶层嵌套对象 w109KeepTop（页面不得丢掉顶层其他配置）；
          //   并把本次返回的完整配置存下来（w109.lastCfg），供 ② 断言「PUT 的 dim_config 除 scdType 外与 GET 返回的配置深度相等」
          cfg.scdConfig = Object.assign({}, cfg.scdConfig || {}, { w109Keep: 'keep' });
          cfg.w109KeepTop = { nested: { keep: ['k', 1, { z: true }] } };
          w109.lastCfg = JSON.parse(JSON.stringify(cfg));
          return route.fulfill({ response: resp, json: Object.assign({}, j, { dim_config: cfg }, diff) });
        }
        return route.continue();
      });
      const openEdit = async () => {
        const btn = page.locator('#modelListBody [data-id="50"] [data-menu="more"]').first();
        await btn.evaluate((e) => e.scrollIntoView({ block: 'center' }));
        await btn.click();
        await page.locator('#catalog-menu-more-50 [data-act="edit-info"]').click();
        await page.waitForFunction(() => document.getElementById('registerModal').style.display === 'flex' && editScdTypeBaseline !== null, null, { timeout: WAIT });
      };
      const staleCache = () => page.evaluate(() => {
        const row = allModelsData.find((m) => m.id == 50);
        const c = typeof row.dim_config === 'string' ? JSON.parse(row.dim_config) : (row.dim_config || {});
        c.w109Marker = 'w109-stale';
        row.dim_config = c;
        window.__w109row = row;
        return JSON.stringify(row.dim_config);
      });
      const save = async () => {
        const reqP = page.waitForRequest((r) => { try { return new URL(r.url()).pathname === '/api/models/50' && r.method() === 'PUT'; } catch (_) { return false; } }, { timeout: WAIT }).then(() => true, () => false);
        await page.click('#confirmRegisterBtn');
        const sent = await reqP;
        await page.waitForFunction(() => document.getElementById('registerModal').style.display === 'none', null, { timeout: WAIT }).catch(() => {});
        return sent;
      };
      // ① 只改实现说明（SCD 不变）
      await openEdit();
      const cacheBefore1 = await staleCache();
      const base1 = await page.evaluate(() => ({ baseline: editScdTypeBaseline, scd: document.getElementById('regScdType').value, cmBaseline: editConfigModeBaseline, cm: document.getElementById('regConfigMode').value, layer: allModelsData.find((m) => m.id == 50).layer }));
      await page.fill('#regImplNote', 'w109 只改实现说明');
      w109.latest = true; w109.puts.length = 0; w109.gets = 0;
      // 最新行：SCD 类型 / update_cycle / 配置方式全部与弹窗回填值不同（别人已在配置台改过；本页没动这些下拉）
      const latestScd1 = base1.baseline === 'SCD2' ? 'SCD1' : 'SCD2';
      w109.latestDiff = { scdType: latestScd1, update_cycle: latestScd1 === 'SCD1' ? 'df' : 'di', config_mode: base1.cm === 'custom' ? 'standard' : 'custom' };
      const sent1 = await save();
      const cacheAfter1 = await page.evaluate(() => JSON.stringify(window.__w109row.dim_config));
      check('W109① 前提：#50 是 DIM、弹窗回填的 SCD 类型 = 记下的基线（' + J(base1) + '）；只改实现说明点保存 → 恰发出 1 个 PUT /api/models/50（impl_note = 新值）',
        sent1 && String(base1.layer).toUpperCase() === 'DIM' && base1.baseline === base1.scd && w109.puts.length === 1 && w109.puts[0].impl_note === 'w109 只改实现说明', { sent1, base1, puts: w109.puts });
      check('W109① 只改实现说明（SCD 类型不变）：请求体不含 dim_config 键（列表缓存里的 dim_config 是旧的也不回传，让服务端保留现值），也没为此多发 GET /api/models/50', w109.puts.length === 1 && !Object.prototype.hasOwnProperty.call(w109.puts[0], 'dim_config') && w109.gets === 0, { keys: w109.puts.map((p) => Object.keys(p)), gets: w109.gets });
      check('W109① 缓存行对象没被原地改写（dim_config 与保存前逐字相同）', cacheAfter1 === cacheBefore1, { cacheBefore1, cacheAfter1 });
      // 收口批 2 MED-1：耦合字段与 dim_config 同一套基线——SCD 类型 / 配置方式都没动时，update_cycle 与 config_mode 也不回传（最新行里它们已被别人改过）
      check('W109① 前提：弹窗回填时记下了配置方式基线，且与下拉当前值相同（' + J({ cmBaseline: base1.cmBaseline, cm: base1.cm }) + '）', base1.cmBaseline !== null && base1.cmBaseline === base1.cm, base1);
      check('W109① 最新行的 SCD 类型 / update_cycle / 配置方式都已被别人改过、本页只改实现说明：请求体不含 dim_config、update_cycle、config_mode（一个耦合字段都不回传，服务端保留现值，不写出半新半旧组合）',
        w109.puts.length === 1 && ['dim_config', 'update_cycle', 'config_mode'].every((k) => !Object.prototype.hasOwnProperty.call(w109.puts[0], k)), { keys: w109.puts.map((p) => Object.keys(p)) });
      // ② 改 SCD 类型
      await openEdit();
      const cacheBefore2 = await staleCache();
      const base2 = await page.evaluate(() => ({ baseline: editScdTypeBaseline, scd: document.getElementById('regScdType').value }));
      const nextScd = base2.baseline === 'SCD2' ? 'SCD1' : 'SCD2';
      await page.selectOption('#regScdType', nextScd);
      // 预筛复看 MED-A：替身最新行的 SCD 类型取第三个值（既不等于基线也不等于改选值），update_cycle 取与改选值相反的方向——
      // 否则沿用 ① 的 latestDiff 时最新行恰为 nextScd，「改 SCD 后漏写回 dim_config」也能通过下方断言
      const thirdScd = ['SCD1', 'SCD2', 'HYBRID'].find((s) => s !== base2.baseline && s !== nextScd);
      w109.latest = true; w109.puts.length = 0; w109.gets = 0;
      w109.latestDiff = { scdType: thirdScd, update_cycle: nextScd === 'SCD1' ? 'di' : 'df', config_mode: 'w109-latest-cm' };
      const sent2 = await save();
      const cacheAfter2 = await page.evaluate(() => JSON.stringify(window.__w109row.dim_config));
      const body2 = w109.puts[0] || {};
      const cfg2 = body2.dim_config || null;
      check('W109② 前提：第二次打开弹窗回填的 SCD 类型 = 基线，改选 ' + nextScd + ' 后保存 → 恰发出 1 个 PUT /api/models/50', sent2 && base2.baseline === base2.scd && w109.puts.length === 1, { sent2, base2, puts: w109.puts.length });
      check('W109② 前提：替身最新行的 SCD 类型（' + thirdScd + '）既不等于基线也不等于改选值，update_cycle 与改选值反向', !!thirdScd && thirdScd !== base2.baseline && thirdScd !== nextScd, { thirdScd, base2, nextScd });
      check('W109② 改 SCD 类型：保存前先 GET 最新行恰 1 次，请求体带 dim_config 且基于最新行（带 w109-latest、不含列表缓存里的 w109-stale），scdType = ' + nextScd + '，update_cycle 与之同向',
        w109.gets === 1 && !!cfg2 && cfg2.w109Marker === 'w109-latest' && !JSON.stringify(cfg2).includes('w109-stale') && !!cfg2.scdConfig && cfg2.scdConfig.scdType === nextScd && body2.update_cycle === (nextScd === 'SCD1' ? 'df' : 'di'), { gets: w109.gets, cfg2, uc: body2.update_cycle });
      // 复审 47B MED-3：保留其余配置——PUT 的 dim_config 除 scdType 外与 GET 返回的最新配置深度相等（键序无关）；两个独立哨兵手写期望
      const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.keys(x).sort().reduce((o, kk) => { o[kk] = x[kk]; return o; }, {}) : x);
      const expCfg2 = w109.lastCfg ? JSON.parse(JSON.stringify(w109.lastCfg)) : null;
      if (expCfg2 && expCfg2.scdConfig) expCfg2.scdConfig.scdType = nextScd;
      check('W109② 前提：GET 替身返回的最新配置里带两个哨兵（scdConfig.w109Keep = keep、顶层 w109KeepTop.nested.keep），且 scdType = 第三个值（' + thirdScd + '）',
        !!w109.lastCfg && !!w109.lastCfg.scdConfig && w109.lastCfg.scdConfig.w109Keep === 'keep' && canon(w109.lastCfg.w109KeepTop) === canon({ nested: { keep: ['k', 1, { z: true }] } }) && w109.lastCfg.scdConfig.scdType === thirdScd, { lastCfg: w109.lastCfg });
      check('W109② 保留其余配置：PUT 的 dim_config 带 scdConfig 内的哨兵 w109Keep = keep（不得把 scdConfig 整体换成只有 scdType 的新对象）',
        !!cfg2 && !!cfg2.scdConfig && cfg2.scdConfig.w109Keep === 'keep', { scdConfig: cfg2 && cfg2.scdConfig });
      check('W109② 保留其余配置：PUT 的 dim_config 带顶层哨兵 w109KeepTop.nested.keep = ["k", 1, {"z": true}]（不得丢掉顶层其他配置）',
        !!cfg2 && canon(cfg2.w109KeepTop) === canon({ nested: { keep: ['k', 1, { z: true }] } }), { top: cfg2 && cfg2.w109KeepTop });
      check('W109② 保留其余配置：PUT 的 dim_config 除 scdType 外与 GET 返回的最新配置深度相等（含两个哨兵）',
        !!cfg2 && !!expCfg2 && canon(cfg2) === canon(expCfg2), { cfg2, expCfg2 });
      check('W109② 缓存行对象没被原地改写（dim_config 与保存前逐字相同，仍是 w109-stale 副本且 scdType 未被改）', cacheAfter2 === cacheBefore2, { cacheBefore2, cacheAfter2 });
      check('W109② 改 SCD 类型但没动配置方式：请求体带 update_cycle（与新 SCD 同向）、不含 config_mode', Object.prototype.hasOwnProperty.call(body2, 'update_cycle') && !Object.prototype.hasOwnProperty.call(body2, 'config_mode'), { keys: Object.keys(body2) });
      // ③ 只改配置方式（SCD 类型不动）→ 只带 config_mode；不带 dim_config / update_cycle，也不为此发 GET
      await openEdit();
      await staleCache();
      const base3 = await page.evaluate(() => ({ cmBaseline: editConfigModeBaseline, cm: document.getElementById('regConfigMode').value }));
      const nextCm = base3.cmBaseline === 'custom' ? 'standard' : 'custom';
      await page.selectOption('#regConfigMode', nextCm);
      w109.latest = true; w109.puts.length = 0; w109.gets = 0;
      w109.latestDiff = { scdType: 'SCD1', update_cycle: 'df', config_mode: base3.cmBaseline };
      const sent3 = await save();
      const body3 = w109.puts[0] || {};
      check('W109③ 前提：第三次打开回填的配置方式 = 基线，改选 ' + nextCm + ' 后保存 → 恰发出 1 个 PUT /api/models/50', sent3 && base3.cmBaseline === base3.cm && w109.puts.length === 1, { sent3, base3, puts: w109.puts.length });
      check('W109③ 只改配置方式：请求体带 config_mode = ' + nextCm + '，不含 dim_config、update_cycle，也没为此发 GET', body3.config_mode === nextCm && !Object.prototype.hasOwnProperty.call(body3, 'dim_config') && !Object.prototype.hasOwnProperty.call(body3, 'update_cycle') && w109.gets === 0, { keys: Object.keys(body3), config_mode: body3.config_mode, gets: w109.gets });
      await page.close();
    }

    // W110（H2）：PUT /api/models/:id 版本条件写冲突（服务端 409「该模型已被他人修改，请刷新后重试」）时，目录页「编辑信息」给出提示并提供刷新：
    //   toast 显示服务端文案 + confirm 对话框（含该文案与「刷新」）；点「取消」留在弹窗、列表不重载；点「确定」关闭弹窗并重载列表（GET /api/models +1）。
    //   路由替身：PUT /api/models/50 回 409。变异 m409-off（Model_Center.html 源码替换：409 分支条件改恒假 → 落到通用 alert「操作失败」）→ 两条都判红（对话框类型 / 文案不对）。
    console.log('W110 H2 编辑信息保存遇 409：提示并提供刷新');
    {
      const { page } = await open(adminN, 'W110');
      expectErr('W110', /\/api\/models\/50(\?.*)?$/);
      const MSG409 = '该模型已被他人修改，请刷新后重试';
      let decision = 'dismiss';
      const dialogs = [];
      let onDialog = null;
      page.removeAllListeners('dialog');
      page.on('dialog', async (d) => { dialogs.push({ type: d.type(), message: d.message() }); if (onDialog) onDialog(); try { if (decision === 'accept') await d.accept(); else await d.dismiss(); } catch (_) { /* ignore */ } });
      let n409 = 0;
      await page.route((u) => /^\/api\/models\/50$/.test(u.pathname), async (route) => {
        if (route.request().method() === 'PUT') { n409++; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: MSG409 }) }); }
        return route.continue();
      });
      let listGets = 0;
      page.on('request', (r) => { try { const u = new URL(r.url()); if (u.pathname === '/api/models' && r.method() === 'GET') listGets++; } catch (_) { /* ignore */ } });
      const openEdit = async () => {
        const btn = page.locator('#modelListBody [data-id="50"] [data-menu="more"]').first();
        await btn.evaluate((e) => e.scrollIntoView({ block: 'center' }));
        await btn.click();
        await page.locator('#catalog-menu-more-50 [data-act="edit-info"]').click();
        await page.waitForFunction(() => document.getElementById('registerModal').style.display === 'flex', null, { timeout: WAIT });
      };
      for (const [choice, label] of [['dismiss', '取消'], ['accept', '确定']]) {
        decision = choice;
        dialogs.length = 0;
        await openEdit();
        await page.fill('#regImplNote', 'w110 ' + choice);
        const arrived = new Promise((res) => { onDialog = res; });
        const n0 = n409; const g0 = listGets;
        await page.click('#confirmRegisterBtn');
        const got = await Promise.race([arrived.then(() => true), new Promise((r) => setTimeout(() => r(false), WAIT))]);
        if (choice === 'accept') await page.waitForFunction(() => document.getElementById('registerModal').style.display === 'none', null, { timeout: WAIT }).catch(() => {});
        else await page.waitForTimeout(600);   // 「取消」路径没有可等的正向事件：只等一小段确认弹窗仍开着、列表没有重载（负向窗口）
        const st = await page.evaluate(() => ({ modal: document.getElementById('registerModal').style.display, toast: (document.getElementById('toast-container') || { textContent: '' }).textContent }));
        if (choice === 'accept') { const t0 = Date.now(); while (listGets === g0 && Date.now() - t0 < WAIT) await new Promise((r) => setTimeout(r, 50)); }   // 正向信号：列表重载请求（有界轮询）
        check(`W110 点「${label}」：前提——PUT 收到 409（恰 1 次）、出现恰 1 个对话框，类型是 confirm、文案含服务端提示与「刷新」`, got && n409 === n0 + 1 && dialogs.length === 1 && dialogs[0].type === 'confirm' && dialogs[0].message.includes(MSG409) && dialogs[0].message.includes('刷新'), { got, n: n409 - n0, dialogs });
        check(`W110 点「${label}」：toast 显示服务端提示；${choice === 'accept' ? '弹窗关闭、列表重载（GET /api/models +1）' : '弹窗仍开着、列表没有重载（GET /api/models +0）'}`,
          st.toast.includes(MSG409) && (choice === 'accept' ? st.modal === 'none' && listGets === g0 + 1 : st.modal === 'flex' && listGets === g0), { st, listGets: listGets - g0 });
        if (choice === 'dismiss') { await page.evaluate(() => { document.getElementById('registerModal').style.display = 'none'; }); }
      }
      await page.close();
    }

    await adminN.close();
    const unexpectedErrs = errors.filter((e) => !isExpectedErr(e));
    check('全程零 console error / pageerror（目录页）：pageerror 一律不豁免；console error 只豁免登记过的页面标签上、文本是浏览器自己记的「Failed to load resource…」的那几条（W4b / W10c / W14 / W16 / W17 / W22b / W40 / W45 / W46 / W52a / W60 / W64c0·c3 / W67 / W68b·c / W69 / W75a / W77b / W81a·b 故意制造 500 / 连接失败），以及 W34 期望的那条「[catalog] 处理函数不存在：…」', unexpectedErrs.length === 0, unexpectedErrs.slice(0, 5));
    const unusedPairs = []; expectedErr.forEach((pats, l) => pats.forEach((p) => { if (!errors.some((e) => e.label === l && e.kind === 'console' && BROWSER_NET_ERR.test(e.text) && p.test(e.url || ''))) unusedPairs.push(l + ' ~ ' + String(p)); }));
    check('豁免登记没有空挂：登记的（页面标签 + 预期失败请求地址模式）每一对都真的出现过「Failed to load resource」且 location().url 命中该模式（没有产生浏览器错误的页面 / 模式不得留在豁免表里）', unusedPairs.length === 0, unusedPairs);
  } finally {
    await admin.close();
    await browser.close();
  }
}

(async () => {
  const dbPath = path.join(WORKDIR, 'catalog-pw.db');
  fs.mkdirSync(WORKDIR, { recursive: true });
  removeDbFiles(dbPath);
  const cleanupSync = () => { killServer(); try { removeDbFiles(dbPath); } catch (_) { /* 库副本被占用时留给下次启动清理 */ } };
  process.on('exit', cleanupSync);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanupSync(); process.exit(130); });
  let code = 1;
  try {
    await main(dbPath);
    console.log(`\n结果：${nPass} PASS / ${nFail} FAIL${MUT ? '（变异 ' + MUT + '）' : ''}`);
    code = nFail ? 1 : 0;
  } catch (e) {
    console.error(e && e.stack || e);
  } finally {
    await stopServerAndCleanup(dbPath);
  }
  process.exit(code);
})();
