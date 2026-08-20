/* u-paste.js — Ctrl+V 贴图共享层（前端统一，S3 抽取）
   命名空间：window.UPaste.*（对齐 model-detail-normalize.js 的 UMD + KIT_VERSION 范式，非 unify-helpers.js
   的裸 IIFE——本文件的纯函数面（MIME 映射/文件名合成/拦截判定）需要 Node 直接 require 做静态断言，
   UMD 才能同时喂浏览器 window 挂载和 Node module.exports）。

   抽取源：Sys_Iteration.html v1.133 建单优化批 C4（方案 20260801_v1.3 §5，codex 215-221 八轮审打磨）。
   决策真相源：docs/local/前端统一/贴图粘贴扩展_四页_方案_20260801_v0.1.md §二。
   本文件含"三件可直接复用"：
     1. 文本粘贴保护判定链（shouldIntercept）
     2. MIME→扩展名映射 + 文件名合成（extFromMime / buildFileName，前缀参数化）
     3. 可见性判定（isVisible，getClientRects 口径）
   加一层"参数化注册接口"（register）把原来写死在 Sys_Iteration 内的 siPasteResolveTargetKey 目标判定
   逻辑泛化：页面注册 { scopeResolver, selector, keyOf, isImageArea, collect }，共享层做候选收集/可见性
   过滤判定，粘贴产生的 File 交还页面注册的 collect 回调——共享层自己不落任何页面专属逻辑（不知道
   siPickerFiles/siPickerCollect 这些名字，也不知道 quick-log 的 ql-* key）。

   S6·A1 点击记忆归属（2026-08-19 用户拍板，真相源 memory paste_defect_leads.md 第四缺陷修法）：原
   "恰好 1 个候选才收，0 或 ≥2 律拒"的判定已改造——新增 document 级 click 捕获监听，记住最后一次点击
   命中的候选区 key；多候选（≥2）粘贴时若记忆项在当前候选中则归它，单候选场景恒归唯一候选、不查
   记忆、零行为变化（四页既有场景回归面最小），不预置任何默认区。0 候选与"多候选无记忆"两种拒绝场景
   改用各自如实的引导文案（不再共用一句"请先点击"却不生效判定的旧文案）。归属选择逻辑抽成纯函数
   chooseCandidate（见 exports），供 Node 静态断言直接覆盖矩阵，语义详见该函数上方注释。

   版本印记：必须与各引用页面 `?v=..._<KIT_VERSION>` 后缀一致。改本文件 → 同时改这里和所有引用页的
   缓存串 + 版本比对常量。页面启动时会比对，不一致直接在 console 报错（对齐 model-detail-normalize.js
   KIT_VERSION 踩坑教训：改共享 JS 忘了 bump 缓存串，用户拿到旧版却不报错，界面表现"看起来正常但字段
   缺失/行为不对"，比直接报错更难查）。
*/
;(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (root) { root.UPaste = api; }
}(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    var KIT_VERSION = 'upaste3';   // S6：A1 点击记忆归属改造（拍板出处见文件头注释），upaste2→upaste3
    var DEFAULT_PREFIX = '粘贴截图_';
    // S6：原单一 MSG_NO_TARGET 拆两条——0 候选与"多候选无记忆"是两种不同真相，不再共用一句不兑现的文案。
    // S1b·R5 预筛修复：文案改中性版——原"没有可见的附件粘贴区"在 isImageArea 剔除场景下失真（区确实
    //   可见，只是被业务判据显式排除出候选池，如 Issue_Lite 只读态的 attList），改为不预设"可见"这个
    //   具体原因的中性表述，同时涵盖"真没有候选区"与"候选区被剔除"两种真相。
    var MSG_NO_CANDIDATE = '当前没有可接收贴图的附件区';
    var MSG_MULTI_NO_MEMORY = '有多个附件区，请先点击要贴入的附件区，再按 Ctrl+V';
    var MSG_READ_FAILED = '无法读取剪贴板图片，请用文件选择方式上传';
    // S2b·R1 dual 反馈体系重构（预筛三轮 M1+M2 合并处置）：dual 路径"多候选无记忆未投递"改用中性
    //   文案——区别于 intercept 路径 MSG_MULTI_NO_MEMORY 的"请先点击...再按 Ctrl+V"祈使句。intercept
    //   路径的用户是主动贴图，"贴图是本次操作目的"这个预设成立；dual 路径的用户本意是打字，图片只是
    //   剪贴板里恰好带着的副作用内容，不该被反问"你怎么不点目标区"——文案只陈述事实（本次粘贴含图片
    //   +未投递）+ 中性条件式引导（"如需贴图"，不预设这就是本次操作的目的），不用祈使句默认贴图是
    //   用户诉求。级别也从 error 降为 info（见 deliverImages 调用处），呼应"三态反馈全部改为非红色"。
    var MSG_DUAL_NOT_DELIVERED = '本次粘贴包含图片，未投递到附件区——如需贴图，请先点击目标附件区';
    // S2b·R1：dual 路径成功投递提示文案生成器——含动态张数，不是固定字符串常量，故导出函数而非
    //   MSG_* 常量，供 Playwright 断言同源生成期望字符串（同 MSG_* 常量"同源引用防漂移"用意一致）。
    function dualDeliveredMsg(n) { return '已粘贴 ' + n + ' 张图片到附件区'; }

    // codex S4 复审 LOW-2 采纳（S5 落地）：三个既有页（Sys_Iteration/Data_Correction/Issue_Lite）各自
    // 维护一份逐字雷同的"比对 KIT_VERSION + console.error 文案"函数，达到"三处重复"抽象阈值，收进共享层。
    // 页面侧只需保留 `<PREFIX>_UPASTE_KIT_EXPECTED` 常量 + 调用本函数一行（"未加载"分支仍留页面侧——
    // 那是调用本函数之前的前置判断，方法本身不可能在宿主对象都不存在时被调用到）。
    function checkVersion(expected, pageName) {
        if (KIT_VERSION !== expected) {
            console.error('[贴图共享层] u-paste.js 版本不匹配：期望 ' + expected + '，实际 ' + KIT_VERSION +
                '。多半是浏览器缓存了旧版 JS —— 请硬刷新（Ctrl+F5）；若是开发期，检查 ' + (pageName || '本页') +
                ' 里 u-paste.js 的 ?v= 缓存串是否已 bump。');
            return false;
        }
        return true;
    }

    // ===== 1. MIME → 扩展名映射（逐字照抄 Sys_Iteration SI_PASTE_MIME_EXT_MAP，codex 220 M-3 收口）=====
    var MIME_EXT_MAP = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/png': 'png' };
    function extFromMime(mimeType) { return MIME_EXT_MAP[mimeType] || 'png'; }

    // 文件名序号状态：按 key 独立递增（原 siPasteSeqByKey，逻辑从页面搬进共享层——页面自己的
    // 组件重置函数（如 siPickerReset）需要调 resetSeq(key) 通知本层清零，语义与原实现一致："同一
    // 实例生命周期内文件名单调不重复，不依赖毫秒不撞车的运气"）。
    // S1b·R4 预筛修复：resetSeq 同时清点击记忆（见下方 clearClickMemory 定义与调用）——双动作合一，
    // 理由：防同 key 区关弹窗重开后记忆复活导致零点击静默归属，违背"不预置默认区"的 A1 拍板意图
    // （若不清，用户关闭弹窗前点过的候选区 key 会一直挂在 lastClickedKey 上，下次重开同 key 弹窗
    // 哪怕这次一次没点，粘贴仍会按上次点击记忆归属，等价于给这个 key 长期"预置了默认区"）。
    // S1c·L2 预筛旁注：本 API 已双职责（清序号+清同 key 点击记忆），调用点应限于"实例重开"语义；
    // "操作成功后清空"语义的调用点若出现在多候选页需单独评估（SI:6811/7354、QL:607 现为单候选页零影响）。
    var seqByKey = {};
    function resetSeq(key) {
        delete seqByKey[key];
        clearClickMemory(key);
    }

    // ===== 2. 文件名合成（前缀参数化，默认「粘贴截图_」；其余格式逐字照抄 siPasteBuildFileName）=====
    function buildFileName(key, mimeType, prefix) {
        var p = (typeof prefix === 'string' && prefix) ? prefix : DEFAULT_PREFIX;
        var d = new Date();
        var p2 = function (n) { return String(n).padStart(2, '0'); };
        var p3 = function (n) { return String(n).padStart(3, '0'); };
        var stamp = String(d.getFullYear()) + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' +
            p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '_' + p3(d.getMilliseconds());
        seqByKey[key] = (seqByKey[key] || 0) + 1;
        return p + stamp + '_' + seqByKey[key] + '.' + extFromMime(mimeType);
    }

    // ===== 3. 可见性判定（逐字照抄 siPasteVisible：getClientRects 口径，非 offsetParent）=====
    //   仅浏览器可用（Node 静态断言不测这条——需要真实 DOM 布局引擎，见文件末尾 exports 注释）。
    function isVisible(el) { return !!(el && typeof el.getClientRects === 'function' && el.getClientRects().length > 0); }

    // ===== 文本粘贴保护判定链（逐字照抄 paste 监听器里的判定分支，抽成纯函数供浏览器与 Node 共用）=====
    // classifyClipboardItems：items 形如 [{kind:'file'|'string', type:string}, ...]（真实 DataTransferItem
    //   数组或测试用的等价 plain object 数组均可，本函数只读 kind/type 两个字段）。
    function classifyClipboardItems(items) {
        var arr = items || [];
        var imageItems = [];
        var hasText = false;
        for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            if (it && it.kind === 'file' && it.type && it.type.indexOf('image/') === 0) imageItems.push(it);
            if (it && it.kind === 'string') hasText = true;
        }
        return { imageItems: imageItems, hasText: hasText, hasImage: imageItems.length > 0 };
    }
    // deliveryMode(classified, editableFocus) —— S2 第三缺陷修复：图文混合"静默丢图"双通道投递判定
    //   纯函数（拍板出处 memory paste_defect_leads.md 2026-08-20 用户决策之二，不得偏离）。矩阵：
    //     - !classified.hasImage                     → 'none'      无图片：纯文本粘贴，永不拦截/不投递
    //     - hasImage && hasText && editableFocus      → 'dual'      图文混合+可编辑焦点：**不拦截事件**
    //                                                                （文本照常流入输入框），**同时**在
    //                                                                同一事件期内同步读图投递到目标区——
    //                                                                图文各得其所，不再是"丢图换文本"
    //                                                                的旧取舍（旧版此分支等价 shouldIntercept
    //                                                                =false，图片被浏览器原生粘贴直接吞掉，
    //                                                                无任何投递尝试，即"静默丢图"第三缺陷）。
    //     - 其余含图场景（纯图片 / 图+文但焦点不可编辑）  → 'intercept'  拦截，走既有归属+投递链，行为
    //                                                                与本次改造前完全一致，零变化。
    function deliveryMode(classified, editableFocus) {
        if (!classified || !classified.hasImage) return 'none';
        if (classified.hasText && editableFocus) return 'dual';
        return 'intercept';
    }
    // shouldIntercept：保留导出兼容（六页/既有测试仍可能直调），改由 deliveryMode 派生——
    //   === 'intercept' 才拦截，'dual'/'none' 均不拦截。除 dual 分支的"下游是否投递"语义外，判定矩阵
    //   本身与改造前逐字一致（原实现：无图片=false；图+文+可编辑焦点=false；其余=true）。
    function shouldIntercept(classified, editableFocus) {
        return deliveryMode(classified, editableFocus) === 'intercept';
    }
    // isEditableFocus：INPUT/TEXTAREA/isContentEditable 三项穷举（逐字照抄，含原注释里的适用边界说明：
    //   isContentEditable 属性本身覆盖嵌套 contenteditable 链，本层不额外处理 shadow DOM/自定义富文本控件）。
    function isEditableFocus(el) {
        return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
    }

    // ===== 参数化注册接口 =====
    // register(config) —— config:
    //   scopeResolver?: () => Element|null|{querySelectorAll}   可选。契约（codex S3 复审 M1 收口）：
    //                    - 返回 null/undefined/其余 falsy 值 → 回落 document（对齐原逻辑"未开弹窗则
    //                      全文档找候选"，也是"页面没有可打开容器"这种正常态的缺省行为）。
    //                    - 返回一个带 querySelectorAll 方法的对象（哪怕是 `{querySelectorAll:()=>[]}`
    //                      这种空实现）→ 显式限定作用域，即使该对象扫描出 0 个候选也**不会**回落
    //                      document 去扩大范围。这条是为了堵一类真实语义漂移：调用方判定"应该有个
    //                      限定容器（比如弹窗正开着）但容器元素本身缺失（理论异常态）"时，必须显式
    //                      返回空作用域哨兵，而不是返回 null——返回 null 在本契约里等价于"我没有限定
    //                      作用域的意图"，会被解释成回落全文档，可能误命中作用域外的可见候选。
    //   selector: string                      必填。CSS 选择器，在 scope 内找候选容器元素
    //                    （Sys_Iteration 传 '[id^="siPreview_"]'，未来其他页可以是自己的命名前缀）。
    //   keyOf?: (el) => string                可选。从候选元素提取"实例 key"（文件名序号 + collect
    //                    回调的第一个参数）；缺省用 el.id。
    //   isImageArea?: (key, el) => boolean    可选。返回 false 时该候选被剔除出候选池（不参与判定，
    //                    也不占"恰好 1 个"的名额）——供非图片上传区显式排除（方案 §二"非图片区可显式
    //                    排除"，如 Data_Collab 的 .sql/.xlsx 专用区未来接入时用）。缺省恒 true。
    //   collect: (key, files) => void|number   必填。恰好命中该候选时调用，files=已合成好的 File[]
    //                    （命名/MIME 已处理好，页面只需要把它们交给自己的收集链，走既有校验闸门）。
    //                    返回值可选（S2c·R1 新增契约，S2d·R1 收紧，仅影响 dual 路径的成功提示，intercept
    //                    路径不消费这个返回值）：不返回/返回 undefined＝旧行为，dual 成功提示按 files.length
    //                    （即"尝试投递了这么多张"）；返回数字＝页面如实报告的实际接收数（闸门可能因数量
    //                    上限/扩展名/大小/去重拒收部分或全部而不抛异常，此时若仍按 files.length 报"已
    //                    粘贴成功"就是谎报——闸门自己已经 showToast 过拒收原因）——**合法值须是 0..
    //                    files.length 闭区间内的整数**（Number.isInteger 且 0<=n<=files.length）：合法且
    //                    0（或非正数不存在，因已限定 >=0）时共享层静默不追加提示，合法且 >0 时按这个实数
    //                    提示。非法值（NaN/Infinity/负数/浮点/超 files.length 越界）会被共享层判定为契约
    //                    违反——console.error 留痕（不炸整条 paste 处理链）+ 按未返回处理回退到 files.length
    //                    提示（S2d·R1，codex 445 M1 采纳：此前只判 typeof==='number'+>0，NaN 被静默吞掉、
    //                    Infinity/浮点/越界会生成误导性的"已粘贴成功"提示）。只有 collect 内部真有"拒收
    //                    但不抛异常"路径的页面才需要接这个契约；纯追加无校验闸门的页面维持不传，undefined
    //                    语义就是为它们设计的默认值，不强制所有页面都返回。
    //   namePrefix?: string                    可选，文件名前缀，缺省「粘贴截图_」。
    //   clickScopeOf?: (el) => Element|null    可选（S1b·R1 预筛修复新增）。点击记忆归属判定用——
    //                    候选元素本身常是零高度空 chip 预览 div（真实点击落在其兄弟 label/input/hint
    //                    上，不落在候选元素内），只用 el.contains(target) 会让 lastClickedKey 永不写入。
    //                    本回调把"点击命中面"从候选元素扩到它的宿主容器：传入候选元素 el，返回该元素
    //                    应该响应点击的宿主 Element。返回 null/undefined 时回落 el.parentElement；
    //                    parentElement 本身也取不到时（理论异常态）回落候选元素自身。六页已实测：
    //                    默认 el.parentElement（即候选各自所在的 .u-form-group）已覆盖全部候选区，
    //                    暂无页面需要显式传本字段——保留口子供未来结构不同的页面覆盖。
    //   allowDual?: boolean                    可选（S2b·R2 预筛修复新增，缺省 true）。控制本候选区
    //                    是否参与 dual 路径（图文混合+可编辑焦点、不拦截事件的被动同步投递，见
    //                    deliveryMode/deliverImages）的归属候选池——传 false 时，本候选区只在用户
    //                    主动贴图的 intercept 路径可被归属，dual 路径的候选收集会把它剔除（剔除发生
    //                    在 chooseCandidate 之前，只影响 dual 调用；intercept 路径不受影响，候选池
    //                    照旧含它）。用途：单文件"替换"语义的候选区（如 Data_Collab 的
    //                    f_export_screenshot，collect 回调直接覆盖已选文件而非追加）不适合被动
    //                    dual 投递静默覆盖用户已选内容——那种覆盖只应该由用户主动贴图（intercept）
    //                    触发，不该被"顺手打字时剪贴板恰好带图"这种副作用动作触发。多文件 append
    //                    语义的候选区（如 filePreview）无此风险，不传即可（缺省 true，dual 可投）。
    // 返回：unregister() —— 调用后从候选池里移除本次注册（当前页面用不到，供未来场景保留）。
    //   已知限制（S1b·R5 补记，不修）：unregister 不清 lastClickedKey——若被移除的候选区 key 恰好是
    //   当前记忆值，粘贴记忆不会跟着失效，要等 chooseCandidate 下次按 key 匹配候选池才会自然落空
    //   （key 不在新候选池里 = 等价"无记忆"，见 chooseCandidate 注释）。六页均不调用 unregister，无实际影响。
    // 一个页面可以多次调用 register()（如不同弹窗各自不同 scopeResolver），候选池在粘贴时跨所有
    // registration 聚合判定——语义等价于原实现"全局只有一套候选池，不区分来源"。
    var registrations = [];
    // codex S3 复审 L1 采纳：可选入参类型校验——scopeResolver/keyOf/isImageArea 传了就必须是
    // function，namePrefix 传了就必须是 string，否则带字段名抛异常（防止调用方手滑传错类型时
    // 静默生效成"永远不匹配"这种更难查的行为，改成建单时就炸给你看）。
    function assertOptionalType(config, field, expectedType) {
        var v = config[field];
        if (v === undefined) return;
        var actual = typeof v;
        if (actual !== expectedType) {
            throw new Error('UPaste.register: config.' + field + ' 须为 ' + expectedType + ' 或不传，实得 ' + actual);
        }
    }
    function register(config) {
        if (!config || typeof config.selector !== 'string' || typeof config.collect !== 'function') {
            throw new Error('UPaste.register: 缺 selector 或 collect');
        }
        assertOptionalType(config, 'scopeResolver', 'function');
        assertOptionalType(config, 'keyOf', 'function');
        assertOptionalType(config, 'isImageArea', 'function');
        assertOptionalType(config, 'namePrefix', 'string');
        assertOptionalType(config, 'clickScopeOf', 'function');
        assertOptionalType(config, 'allowDual', 'boolean');
        registrations.push(config);
        return function unregister() {
            var idx = registrations.indexOf(config);
            if (idx >= 0) registrations.splice(idx, 1);
        };
    }

    // 候选收集单源实现（S1c·M2 结构重构）：resolveCandidates（paste 路径，判可见性）与
    //   resolveCandidatesRaw（click 路径，跳过可见性）此前是两份逐字雷同、只差一个 isVisible 判断的
    //   独立实现——同一份"scope→selector→(可见性)→isImageArea"过滤规则维护两处，任何口径调整都要
    //   改两遍、极易漏改一处（guard_static_analysis_gotchas 坑表"同规则禁双实现"）。现收敛成单源
    //   resolveCandidatesImpl(doc, skipVisible)，两个原名各自只做一行薄包装，导出面（_resolveCandidates）
    //   与外部行为完全不变。
    //   S1c·M2 顺带修复（=预筛 L4）：keyOf(el) 与 isImageArea(key, el) 原来是裸调用——resolveCandidatesRaw
    //   现在被 click 监听器每次点击都调用一次（见 attachClickListener），页面注册的这两个回调理论上可能
    //   抛异常（比如页面后续改动引入 bug），裸调用会让每次点击都在 console 炸一次，变成高频噪声。改为
    //   try/catch 隔离：keyOf 抛异常时回落 el.id（与"未传 keyOf"缺省行为一致，候选仍参与判定，只是用
    //   兜底 key）；isImageArea 抛异常时视为"判定失败，保守剔除该候选"（不参与——不能因为业务判据本身
    //   坏了就放行一个未经确认的候选区）。两者都只影响"该候选"，不中断整个循环、不影响其余候选判定。
    function resolveCandidatesImpl(doc, skipVisible) {
        var d = doc || (typeof document !== 'undefined' ? document : null);
        if (!d) return [];
        var out = [];
        for (var i = 0; i < registrations.length; i++) {
            var reg = registrations[i];
            var scope = null;
            try { scope = (typeof reg.scopeResolver === 'function') ? reg.scopeResolver() : null; } catch (e) { scope = null; }
            if (!scope) scope = d;
            var nodes;
            try { nodes = scope.querySelectorAll(reg.selector); } catch (e) { nodes = []; }
            for (var j = 0; j < nodes.length; j++) {
                var el = nodes[j];
                if (!skipVisible && !isVisible(el)) continue;
                var key;
                try { key = (typeof reg.keyOf === 'function') ? reg.keyOf(el) : el.id; } catch (e) { key = el.id; }
                var imageAreaOk = true;
                if (typeof reg.isImageArea === 'function') {
                    try { imageAreaOk = reg.isImageArea(key, el); } catch (e) { imageAreaOk = false; }
                }
                if (!imageAreaOk) continue;
                out.push({ reg: reg, el: el, key: key });
            }
        }
        // S2c·R2（codex 合并轮 L1）：候选池重复 key 运行时防护——keyOf 契约要求"按候选实例唯一派生"
        //   （见 chooseCandidate 注释），若违反（比如动态多实例组件忘了给独立 keyOf，或 keyOf 实现本身
        //   有 bug），chooseCandidate 会按"数组顺序取第一个同 key 项"的既定契约静默工作——不炸、不改变
        //   任何归属结果（改行为会引入未经验证的新分支风险，且生产六页现有 id 派生方式实测不可达这个
        //   分支，属防御性巡检非真实修复），但对排查这类隐蔽 bug 完全零信号。检测只留痕（console.error），
        //   不改变本函数的返回值/归属行为；放在这个单源出口而不是各调用方各查一遍——同一份候选池数据
        //   只该有一处"合规性巡检"逻辑（同规则禁双实现）。
        // S2d·R2（codex 445 L1 采纳）：seenKeys 改用 Object.create(null)——普通对象字面量 {} 继承
        //   Object.prototype，key='__proto__' 时 seenKeys['__proto__'] = true 会触发 Object.prototype
        //   上的 __proto__ accessor setter 而非创建自有属性（赋值非对象/null 值时该 setter 静默忽略），
        //   导致 hasOwnProperty.call 永远查不到这条"已见过的 key"，重复 key 检测对这一个特定 key 值
        //   漏报（原型污染式漏检）。无原型对象没有继承的 __proto__ accessor，'__proto__' 退化成普通
        //   自有属性名，检测对它和其余任意 key 一视同仁。
        var seenKeys = Object.create(null);
        for (var m = 0; m < out.length; m++) {
            var dupKey = out[m].key;
            if (Object.prototype.hasOwnProperty.call(seenKeys, dupKey)) {
                console.error('[u-paste] 候选池存在重复 key：' + dupKey + '——keyOf 契约要求按实例唯一派生，归属将按数组顺序取第一个，请检查页面注册');
            } else {
                seenKeys[dupKey] = true;
            }
        }
        return out;
    }

    // 候选收集：跨所有 registration 聚合，逐个按 scope→selector→可见性→isImageArea 过滤（paste 路径）。
    //   浏览器专用（querySelectorAll 依赖真实 DOM），Node 静态断言不测这条。薄包装：resolveCandidatesImpl(doc, false)。
    function resolveCandidates(doc) { return resolveCandidatesImpl(doc, false); }

    // S1b·R1 预筛修复：候选收集（click 专用），跳过 isVisible 判定。
    //   理由：resolveCandidates 的 isVisible 依赖 getClientRects()，每次 document 级 click 都跑一次会
    //   强制触发布局 reflow（预筛 MEDIUM-3）。click 监听改走宿主容器判定 contains()（见 candidateHost）
    //   后，isVisible 在这条路径上不再是安全性所需——display:none 的候选宿主本来就点不到（浏览器不会
    //   把 click 事件派发到不可见元素上），contains() 判定天然安全，不需要额外可见性过滤兜底。
    //   isImageArea 过滤仍保留：防止记忆指向被业务显式剔除出候选池的非图片区（如 Issue_Lite 的
    //   attList 在只读态会被 isImageArea 拒绝，不应该被点击记住）。scope→selector→isImageArea，
    //   跳过可见性——浏览器专用，Node 静态断言不测这条（同 resolveCandidates 的适用边界）。薄包装：
    //   resolveCandidatesImpl(doc, true)。
    function resolveCandidatesRaw(doc) { return resolveCandidatesImpl(doc, true); }

    // candidateHost(c) —— S1b·R1 预筛修复核心：算出候选 c 应该响应点击的宿主 Element。
    //   三级回落，严格对齐 register() 文档契约：① clickScopeOf(el) 有返回值（非 null/undefined）就用它；
    //   ② clickScopeOf 未传、或传了但返回 null/undefined、或调用抛异常 —— 都回落 el.parentElement
    //   （S1c·M1 预筛修复：原实现用三元把这一级短路掉了——clickScopeOf 存在但返回 null/抛异常时会直接
    //   落到 c.el 本身，跳过 parentElement，与 register() 契约"返回 null 回落 el.parentElement"矛盾）；
    //   ③ parentElement 本身也取不到（理论异常态）—— 兜底回落候选元素自身，等价于改造前"只认候选
    //   元素本身"的行为。c/c.el 缺失时返回 null（调用侧已有 `hostEl &&` 空值容错，见 attachClickListener）。
    function candidateHost(c) {
        if (!c || !c.el) return null;
        var host = null;
        try { if (c.reg && typeof c.reg.clickScopeOf === 'function') host = c.reg.clickScopeOf(c.el); }
        catch (e) { host = null; }
        if (!host) host = c.el.parentElement;
        return host || c.el;
    }

    // ===== A1 点击记忆归属（S6）=====
    // 模块级状态：记最后一次点击命中的候选区 key（不记元素引用——元素跨弹窗开关会被重建，key 稳定；
    // 记忆失效路径天然安全：key 匹配不上当前候选池里的任何一项就等价于"无记忆"，见 chooseCandidate）。
    var lastClickedKey = null;

    // S1b·R4 预筛修复：resetSeq(key) 会调用本函数清记忆（见上方 resetSeq 定义与旁注）。
    function clearClickMemory(key) {
        if (lastClickedKey === key) lastClickedKey = null;
    }

    // chooseCandidate(candidates, lastKey) —— 归属选择纯函数，供 Node 静态断言直接覆盖矩阵。
    //   candidates：resolveCandidates() 的返回值（[{reg, el, key}, ...]）；lastKey：lastClickedKey。
    //   矩阵（严格对齐 A1 拍板）：
    //     - candidates.length === 0            → null（上层走"0 候选"文案分支）
    //     - candidates.length === 1             → 恒返回该项，无视 lastKey（单候选零行为变化，
    //                                              不查记忆——四页既有场景回归面最小）
    //     - candidates.length >= 2 且 lastKey 命中其中一项的 key → 返回该项
    //     - candidates.length >= 2 且 lastKey 为空/不在候选中     → null（上层走"多候选无记忆"文案分支）
    //   契约（S1b·R5 补记）：candidates 内 key 须唯一；若调用方传入重复 key 的候选池（理论不该发生——
    //   keyOf 约定按候选实例唯一派生），本函数按数组顺序匹配到第一个同 key 项即返回，不做去重/报错。
    function chooseCandidate(candidates, lastKey) {
        if (!candidates || candidates.length === 0) return null;
        if (candidates.length === 1) return candidates[0];
        if (!lastKey) return null;
        for (var i = 0; i < candidates.length; i++) {
            if (candidates[i].key === lastKey) return candidates[i];
        }
        return null;
    }

    // ===== document 级 click 监听（capture 捕获阶段，浏览器专用；模块加载时自动挂一次）=====
    //   用 capture=true 是为了不依赖候选区本身是否可获得焦点/带 tabindex——只要点击事件的目标元素落
    //   在某个候选区的宿主内，就算"点过这个区"。挂载模式对齐 attachDocumentListener：Node 环境静默
    //   跳过、防重复挂载。
    //   S1b·R1 预筛修复（HIGH-1）：判定面从"候选元素本身"扩到"候选宿主"（candidateHost，默认
    //   el.parentElement）——候选元素常是零高度空 chip 预览 div，真实点击落在其兄弟 label/input/hint
    //   上，只认候选元素本身会让 lastClickedKey 主场景永不写入（预筛实锤：Data_Correction 六个
    //   picker 区皆此形态）。候选收集改用 resolveCandidatesRaw（跳过 isVisible，见其注释）。
    //   歧义守卫：先收集本次点击命中的全部候选（按 key 去重），命中数恰 1 → 写记忆；0 或 ≥2 → 不写
    //   （0 = 点在候选区之外，记忆是"最后一次有效点击"不因点别处清空；≥2 = 多个候选共享同一宿主导致
    //   无法区分具体点的是哪个区，宁可保留原记忆不动也不猜——静默误归属比"这次不生效"更危险）。
    var clickListenerAttached = false;
    function attachClickListener(win, doc) {
        if (clickListenerAttached) return;   // 防重复挂载
        var w = win || (typeof window !== 'undefined' ? window : null);
        var d = doc || (typeof document !== 'undefined' ? document : null);
        if (!w || !d || typeof d.addEventListener !== 'function') return;   // Node 环境静默跳过
        clickListenerAttached = true;
        d.addEventListener('click', function (e) {
            if (!registrations.length) return;   // 零注册 fail-safe，对齐 paste 监听器同款前置判断
            var candidates = resolveCandidatesRaw(d);
            var matchedKeys = [];
            for (var i = 0; i < candidates.length; i++) {
                var hostEl = candidateHost(candidates[i]);
                var hit = false;
                try { hit = !!(hostEl && typeof hostEl.contains === 'function' && hostEl.contains(e.target)); } catch (err) { hit = false; }
                if (hit && matchedKeys.indexOf(candidates[i].key) < 0) matchedKeys.push(candidates[i].key);
            }
            if (matchedKeys.length === 1) {
                lastClickedKey = matchedKeys[0];
            }
            // matchedKeys.length === 0：点击落在候选区之外——不清空 lastClickedKey，记忆是"最后一次
            //   有效点击"，不是"当前是否还站在某个区里"；失效判定交给 chooseCandidate 的 key 匹配
            //   （点别处不代表放弃已点过的区）。
            // matchedKeys.length >= 2：歧义命中（不同候选共宿主），保留原记忆不动，不猜。
            //   S2c·R3（codex 合并轮 L2）语义明确化，不改行为：歧义点击**保留**旧记忆（不清空）——本次
            //   点击没有产生新的、无歧义的归属信息，但更早的有效点击（若有）仍然算数，不因这次点歧义区
            //   就被判定"失效"。若产品语义需要"歧义即清空"（比如认为歧义点击暗示用户当前意图不明确，
            //   连旧记忆一起作废更安全），需用户裁定后再改，本批不动（锚点 P7）。
        }, true);
    }
    attachClickListener();

    // ===== 图片归属+投递（S2 单源共用，intercept/dual 两条路径调用同一份实现，禁复制第二份投递实现，
    //   S1c·M2"同规则禁双实现"教训）=====
    // deliverImages(d, w, classified, opts) —— opts.mode: 'intercept'|'dual'（缺省 'intercept'）。
    //   归属（resolveCandidates+chooseCandidate+lastClickedKey，dual 模式先按 allowDual 过滤候选池，
    //   见下方 R2 说明）→ 归属成功则 buildFileName+collect 投递；归属失败按候选数分两种真相：
    //     - candidates.length === 0（0 候选）：dual 模式静默不投、不 toast（P3 主会话自决：纯文本
    //       粘贴是这条路径的主场景，不该因为页面上恰好没打开任何候选区就弹提示打断正在打字的用户）；
    //       intercept 模式提示 MSG_NO_CANDIDATE（error）。
    //     - candidates.length >= 2 且无记忆命中（多候选无记忆）：S2b·R1 反馈体系重构——intercept 模式
    //       提示 MSG_MULTI_NO_MEMORY（error，用户是主动贴图被拒，红色合理）；dual 模式改提示
    //       MSG_DUAL_NOT_DELIVERED（info，中性陈述+条件式引导，不预设贴图是本次操作目的，见该常量
    //       上方注释）。归属判定逻辑本身（chooseCandidate/lastClickedKey）两条路径完全同源，只是
    //       "无记忆"这一结果的呈现方式分叉，不影响判定是否单源。
    //   归属成功但 getAsFile() 全空（named.length===0，有明确目标区却读不出）：两条路径统一提示
    //   MSG_READ_FAILED（error）——这是真错误，不受 mode 影响。
    //   归属成功且投递完成：S2b·R1 新增——dual 模式额外提示"已粘贴 N 张图片到附件区"（info）。dual 是
    //   用户打字时的被动副作用投递，零反馈会让用户对"服务端已落库/预览区加了 chip"这件事完全无感知；
    //   intercept 模式维持改造前零反馈（用户主动贴图，看得到候选区里新增的 chip 即是确认，不加冗余
    //   toast）。仅在 collect 未抛异常时才提示——collect 真失败时不该谎报"已粘贴成功"。
    //   S2c·R1（codex 合并轮 M）：collect 返回契约——上面这条"仅未抛异常就提示成功"仍不够：页面
    //   collect 可能把文件交给自己的校验闸门（大小/扩展名/数量上限/去重），闸门**拒收但不抛异常**
    //   （闸门自己 showToast 拒收原因，是页面既有行为，不该被共享层动），此时共享层若仍按 named.length
    //   报"已粘贴 N 张"就是谎报成功——两条矛盾 toast 同时出现（页面的"不支持的格式"+ 共享层的"已粘贴
    //   成功"）。收紧契约：`collect` 可选返回值——不返回（undefined）＝旧行为，按 named.length 提示
    //   （向后兼容未按本次收紧改造的页面，语义仍是"我们尝试投递了这么多张"）；返回数值＝页面如实报告
    //   的实际接收数——0（或任何非正数）时共享层**静默**（页面的闸门已经自己 toast 过拒收原因，不
    //   叠加噪音）；>0 时按这个实数提示，不再照抄 named.length。intercept 路径不消费这个返回值（本就
    //   无成功 toast，见上一段）。逐页核实结论见 register() 文档 collect 字段旁注 + 各页 collect 实现
    //   落点注释（哪页真有拒收路径才改一行 return，无拒收路径的页维持 undefined 不动）。
    //   collect 回调异常隔离沿用改造前既有逻辑（codex S3 复审 L2 采纳）：页面收集闸门理论上可能抛异常，
    //   不应让 paste 监听器被一次页面侧异常整体打挂；buildFileName 已递增的序号不回滚，无害"跳号"。
    function deliverImages(d, w, classified, opts) {
        var mode = (opts && opts.mode) || 'intercept';
        var isDual = mode === 'dual';
        var candidates = resolveCandidates(d);
        // S2b·R2：dual 路径归属前剔除 allowDual===false 的注册区——单文件"替换"语义的候选区（如
        //   Data_Collab 的 f_export_screenshot）不适合被动 dual 投递静默覆盖用户已选内容，只应由用户
        //   主动贴图（intercept）触发。剔除必须在 chooseCandidate 之前做（剔除后候选数变化会连带影响
        //   0 候选/多候选分支判定，这是有意为之——被 allowDual:false 排除的候选区在 dual 视角下本就
        //   "不存在"），且只在 dual 模式做（intercept 路径的候选池不受影响，照旧含它，用户主动贴图
        //   仍能命中）。
        if (isDual) {
            candidates = candidates.filter(function (c) { return c.reg.allowDual !== false; });
        }
        var chosen = chooseCandidate(candidates, lastClickedKey);
        if (!chosen) {
            // S6：0 候选与"多候选无记忆"是两种不同真相，文案分开——后者现在是兑现的承诺
            // （点击候选区后再粘贴真的会归属，不再是"点了也没用"的旧行为）。
            if (candidates.length === 0) {
                if (!isDual && typeof w.showToast === 'function') w.showToast(MSG_NO_CANDIDATE, 'error');
                return;
            }
            if (typeof w.showToast === 'function') {
                if (isDual) w.showToast(MSG_DUAL_NOT_DELIVERED, 'info');
                else w.showToast(MSG_MULTI_NO_MEMORY, 'error');
            }
            return;
        }
        var named = classified.imageItems.map(function (it) { return it.getAsFile(); }).filter(Boolean)
            .map(function (f) {
                return new File([f], buildFileName(chosen.key, f.type, chosen.reg.namePrefix), { type: f.type || 'image/png', lastModified: Date.now() });
            });
        if (!named.length) {
            if (typeof w.showToast === 'function') w.showToast(MSG_READ_FAILED, 'error');
            return;
        }
        try {
            var accepted = chosen.reg.collect(chosen.key, named);
            if (isDual && typeof w.showToast === 'function') {
                // S2d·R1（codex 445 M1）+S2e（codex 446 M）三段式契约：
                //   ① undefined（未返回）＝旧行为兼容分支，按尝试投递的张数提示——纯追加无闸门页面的设计默认值；
                //   ② 合法值＝0..named.length 闭区间内的整数（Number.isInteger·此前只判 typeof number+>0：
                //      NaN 被静默吞掉、Infinity/浮点/越界被当合法正数生成误导提示）：0 静默，>0 按实数提示；
                //   ③ 其余一切返回值（数字坏值 NaN/Infinity/负数/浮点/越界，以及非数字非 undefined 的
                //      null/false/'1'/对象等——446 轮指出这批此前静默溜进兼容分支不留痕，实现比契约注释宽松）
                //      ＝契约违反：console.error 留痕（不炸整条 paste 链）+ 回退到兼容分支同款提示。
                if (accepted === undefined) {
                    w.showToast(dualDeliveredMsg(named.length), 'info');
                } else if (Number.isInteger(accepted) && accepted >= 0 && accepted <= named.length) {
                    if (accepted > 0) w.showToast(dualDeliveredMsg(accepted), 'info');
                } else {
                    // S2f（codex 447 LOW 吸收）：两参形式不做字符串拼接——String(accepted) 对自定义
                    //   toString 抛错的对象会二次异常（落进 collect 的 catch 造成语义混淆的"回调异常"日志）；
                    //   console.error 多参传值由控制台自行安全序列化，任意坏值不炸留痕逻辑。
                    console.error('[u-paste] collect 返回值非法（应为 0..N 整数或 undefined）——按未返回处理：', accepted);
                    w.showToast(dualDeliveredMsg(named.length), 'info');
                }
            }
        } catch (collectErr) {
            console.error('[u-paste] collect 回调异常：', collectErr);
        }
    }

    // ===== document 级 paste 监听（浏览器专用，模块加载时自动挂一次；对齐原实现"整页只有一个监听器"）=====
    var listenerAttached = false;
    function attachDocumentListener(win, doc) {
        if (listenerAttached) return;   // 防重复挂载（脚本被 include 两次等异常场景）
        var w = win || (typeof window !== 'undefined' ? window : null);
        var d = doc || (typeof document !== 'undefined' ? document : null);
        if (!w || !d || typeof d.addEventListener !== 'function') return;   // Node 环境静默跳过
        listenerAttached = true;
        d.addEventListener('paste', function (e) {
            // codex S3 复审 M2 采纳：零注册 fail-safe——未调用过 register() 的页面（或页面已加载
            // 本文件但注册时机还没到，如脚本执行顺序异常）不应吞掉任何原生粘贴行为。必须放在**任何
            // preventDefault 之前**判断：本层完全没有登记目标区，谈不上"拦截去哪"，此时保持沉默、
            // 把浏览器原生粘贴处理权原样让出去，比"拦下但哪都不去"更安全。
            if (!registrations.length) return;
            var cd = e.clipboardData;
            if (!cd || !cd.items) return;
            var items = Array.prototype.slice.call(cd.items);
            var classified = classifyClipboardItems(items);
            if (!classified.hasImage) return;   // 无图片：纯文本粘贴，永不拦截（deliveryMode 的 'none' 分支）
            var editableFocus = isEditableFocus(d.activeElement);
            var mode = deliveryMode(classified, editableFocus);
            if (mode === 'intercept') {
                // 拦截路径：与本次 S2 改造前完全一致——preventDefault 后走归属+投递，零行为变化。
                e.preventDefault();
                deliverImages(d, w, classified, { mode: 'intercept' });
                return;
            }
            // mode === 'dual'（S2 第三缺陷修复，拍板出处 memory paste_defect_leads.md 2026-08-20 用户
            // 决策之二）：**不 preventDefault**——文本照常流入可编辑焦点（浏览器原生粘贴行为不受影响），
            // 同时在同一事件期内同步读取 clipboardData 投递图片到目标区，图文各得其所，不再是旧版
            // "丢图换文本"的静默丢图。0 候选静默不投；多候选无记忆改用 info 级中性文案；成功投递额外
            // 提示——S2b·R1 反馈体系重构，均见 deliverImages 注释（单源共用，归属判定逻辑不因反馈
            // 呈现方式分叉而分叉）。
            deliverImages(d, w, classified, { mode: 'dual' });
        });
    }
    attachDocumentListener();

    return {
        KIT_VERSION: KIT_VERSION,
        checkVersion: checkVersion,
        DEFAULT_PREFIX: DEFAULT_PREFIX,
        // S1b·R2 预筛修复：0 候选 / 多候选无记忆两条拒绝文案导出为只读常量——Playwright 套件断言应
        // 同源引用（page.evaluate(() => UPaste.MSG_*)）而非硬编码字符串，根治文案漂移。
        MSG_NO_CANDIDATE: MSG_NO_CANDIDATE,
        MSG_MULTI_NO_MEMORY: MSG_MULTI_NO_MEMORY,
        // S2b·R1 dual 反馈体系重构：dual 路径专用的"多候选无记忆未投递"中性文案（info 级）+ 成功投递
        // 提示文案生成器（含动态张数，导出函数而非固定常量）——同源引用防漂移，用法同上面两条 MSG_*。
        MSG_DUAL_NOT_DELIVERED: MSG_DUAL_NOT_DELIVERED,
        dualDeliveredMsg: dualDeliveredMsg,
        MIME_EXT_MAP: MIME_EXT_MAP,
        extFromMime: extFromMime,
        buildFileName: buildFileName,
        resetSeq: resetSeq,
        isVisible: isVisible,
        classifyClipboardItems: classifyClipboardItems,
        // S2 第三缺陷修复：deliveryMode 导出——shouldIntercept 保留兼容但已改由它派生，Node 静态断言
        // 应直接覆盖 deliveryMode 的三分支矩阵（'none'/'dual'/'intercept'），拍板出处见函数上方注释。
        deliveryMode: deliveryMode,
        shouldIntercept: shouldIntercept,
        isEditableFocus: isEditableFocus,
        chooseCandidate: chooseCandidate,
        register: register,
        // 以下几个仅供页面调试/测试直调，不是常规业务 API：
        _resolveCandidates: resolveCandidates,
        _attachDocumentListener: attachDocumentListener,
        _attachClickListener: attachClickListener,
        // S1b·R3 预筛修复（MEDIUM-1）：供 verify-u-paste 断言点击监听确实写入了 lastClickedKey——
        // 原实现无任何出口能观察这个模块级状态，接线只能靠"读代码相信"，加一条只读 getter 落成可断言。
        _getLastClickedKey: function () { return lastClickedKey; },
        // codex S3 复审 M2 采纳：供 verify-u-paste 静态断言"零注册"这个前置状态可达（真实 paste 事件
        // 驱动的 preventDefault 行为需要真 DOM ClipboardEvent，留给浏览器 Playwright 套件——本层只
        // 证明"没调用过 register() 时 registrations 数组确实是空的"这个纯状态事实）。
        _registrationCount: function () { return registrations.length; },
    };
}));
