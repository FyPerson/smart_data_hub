/* u-paste.js — Ctrl+V 贴图共享层（前端统一，S3 抽取）
   命名空间：window.UPaste.*（对齐 model-detail-normalize.js 的 UMD + KIT_VERSION 范式，非 unify-helpers.js
   的裸 IIFE——本文件的纯函数面（MIME 映射/文件名合成/拦截判定）需要 Node 直接 require 做静态断言，
   UMD 才能同时喂浏览器 window 挂载和 Node module.exports）。

   抽取源：Sys_Iteration.html v1.133 建单优化批 C4（方案 20260801_v1.3 §5，codex 215-221 八轮审打磨）。
   决策真相源：docs/local/前端统一/贴图粘贴扩展_四页_方案_20260801_v0.1.md §二。
   本文件只含"三件可直接复用"（语义逐字保留，未改动任何判定分支/文案/边界条件）：
     1. 文本粘贴保护判定链（shouldIntercept）
     2. MIME→扩展名映射 + 文件名合成（extFromMime / buildFileName，前缀参数化）
     3. 可见性判定（isVisible，getClientRects 口径）
   加一层"参数化注册接口"（register）把原来写死在 Sys_Iteration 内的 siPasteResolveTargetKey 目标判定
   逻辑泛化：页面注册 { scopeResolver, selector, keyOf, isImageArea, collect }，共享层做候选收集/可见性
   过滤/"恰好 1 个才收，0 或 ≥2 不猜" 判定，粘贴产生的 File 交还页面注册的 collect 回调——共享层自己
   不落任何页面专属逻辑（不知道 siPickerFiles/siPickerCollect 这些名字，也不知道 quick-log 的 ql-* key）。

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

    var KIT_VERSION = 'upaste2';   // S5：codex 226 LOW-2 采纳，checkVersion 下沉本体，upaste1→upaste2
    var DEFAULT_PREFIX = '粘贴截图_';
    var MSG_NO_TARGET = '请先点击目标附件区再粘贴';
    var MSG_READ_FAILED = '无法读取剪贴板图片，请用文件选择方式上传';

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
    var seqByKey = {};
    function resetSeq(key) { delete seqByKey[key]; }

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
    // shouldIntercept：口径逐字照抄——无图片 item 永不拦截；图片+任意文本型 item（不限 text/plain）+
    //   可编辑焦点 = 放行默认粘贴；纯图片（或图片+文本但焦点不可编辑）= 拦截（收附件）。
    function shouldIntercept(classified, editableFocus) {
        if (!classified || !classified.hasImage) return false;
        if (classified.hasText && editableFocus) return false;
        return true;
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
    //   collect: (key, files) => void         必填。恰好命中该候选时调用，files=已合成好的 File[]
    //                    （命名/MIME 已处理好，页面只需要把它们交给自己的收集链，走既有校验闸门）。
    //   namePrefix?: string                    可选，文件名前缀，缺省「粘贴截图_」。
    // 返回：unregister() —— 调用后从候选池里移除本次注册（当前页面用不到，供未来场景保留）。
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
        registrations.push(config);
        return function unregister() {
            var idx = registrations.indexOf(config);
            if (idx >= 0) registrations.splice(idx, 1);
        };
    }

    // 候选收集：跨所有 registration 聚合，逐个按 scope→selector→可见性→isImageArea 过滤。
    //   浏览器专用（querySelectorAll 依赖真实 DOM），Node 静态断言不测这条。
    function resolveCandidates(doc) {
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
                if (!isVisible(el)) continue;
                var key = (typeof reg.keyOf === 'function') ? reg.keyOf(el) : el.id;
                if (typeof reg.isImageArea === 'function' && !reg.isImageArea(key, el)) continue;
                out.push({ reg: reg, el: el, key: key });
            }
        }
        return out;
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
            if (!classified.hasImage) return;   // 无图片：纯文本粘贴，永不拦截
            var editableFocus = isEditableFocus(d.activeElement);
            if (!shouldIntercept(classified, editableFocus)) return;   // 图片+文本混合+可编辑焦点：放行
            e.preventDefault();
            var candidates = resolveCandidates(d);
            if (candidates.length !== 1) {
                if (typeof w.showToast === 'function') w.showToast(MSG_NO_TARGET, 'error');
                return;
            }
            var chosen = candidates[0];
            var named = classified.imageItems.map(function (it) { return it.getAsFile(); }).filter(Boolean)
                .map(function (f) {
                    return new File([f], buildFileName(chosen.key, f.type, chosen.reg.namePrefix), { type: f.type || 'image/png', lastModified: Date.now() });
                });
            if (!named.length) {
                if (typeof w.showToast === 'function') w.showToast(MSG_READ_FAILED, 'error');
                return;
            }
            // codex S3 复审 L2 采纳：collect 回调异常隔离——页面自己的收集闸门（如 siPickerCollect）
            // 理论上可能抛异常（比如页面后续改动引入 bug），不应让共享层的 paste 监听器被一次页面侧
            // 异常整体打挂（后续粘贴/其他候选判定都会受影响）。此处 buildFileName 已经把序号递增过——
            // 若 collect 随后抛异常，序号不回滚（下一次粘贴的文件名序号会跳过这一号），这是无害的
            // "跳号"而非"撞号"，不影响文件名唯一性，不值得为此引入回滚逻辑。不引入页面 toast 依赖
            // （异常文案交由页面自己在 collect 内部处理更合适，本层只保证不整体挂掉，打 console.error
            // 留痕即可）。
            try {
                chosen.reg.collect(chosen.key, named);
            } catch (collectErr) {
                console.error('[u-paste] collect 回调异常：', collectErr);
            }
        });
    }
    attachDocumentListener();

    return {
        KIT_VERSION: KIT_VERSION,
        checkVersion: checkVersion,
        DEFAULT_PREFIX: DEFAULT_PREFIX,
        MIME_EXT_MAP: MIME_EXT_MAP,
        extFromMime: extFromMime,
        buildFileName: buildFileName,
        resetSeq: resetSeq,
        isVisible: isVisible,
        classifyClipboardItems: classifyClipboardItems,
        shouldIntercept: shouldIntercept,
        isEditableFocus: isEditableFocus,
        register: register,
        // 以下几个仅供页面调试/测试直调，不是常规业务 API：
        _resolveCandidates: resolveCandidates,
        _attachDocumentListener: attachDocumentListener,
        // codex S3 复审 M2 采纳：供 verify-u-paste 静态断言"零注册"这个前置状态可达（真实 paste 事件
        // 驱动的 preventDefault 行为需要真 DOM ClipboardEvent，留给浏览器 Playwright 套件——本层只
        // 证明"没调用过 register() 时 registrations 数组确实是空的"这个纯状态事实）。
        _registrationCount: function () { return registrations.length; },
    };
}));
