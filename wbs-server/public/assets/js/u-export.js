/* u-export.js — 三模块列表导出（Excel）+ 创建日期范围筛选 共享层（前端统一，暂缓与列表导出方案 v1.1 §3.1，编码任务 S4）
   命名空间：window.UnifyHelpers.*（挂载对齐 unify-helpers.js:332-341 尾部挂载形态，与其共存——本文件是独立
   新文件，S0 裁定不改 unify-helpers.js 本体、不连带其既有 6 个引用页）。

   UMD 头对齐 u-paste.js（非 unify-helpers.js 的裸 IIFE）：本文件的纯函数面（fallbackVal/isValidDatePrefix，
   §3.1.1 末尾"共享工具函数"）需要 Node 直接 require 做 verify-export-content.js 的文件内容测试（公式注入
   归一化逻辑走真实 attachExport 代码路径 + 同版 SheetJS 生成 buffer 回读断言），UMD 才能同时喂浏览器
   window 挂载和 Node module.exports。

   版本印记：必须与各引用页面 `?v=..._<KIT_VERSION>` 后缀一致——checkVersion 范式逐字照抄 u-paste.js:30-42
   （KIT_VERSION 常量 + 页面 src ?v= 尾缀比对 + console.error 文案风格），改本文件须同时 bump 这里与所有
   引用页的缓存串 + 版本比对常量（对齐 model-detail-normalize.js KIT_VERSION 踩坑教训）。

   依赖：浏览器场景下 attachExport 运行时依赖全局 XLSX（vendor/xlsx.mini.min.js，须先于本文件加载）；
   attachDateRangeFilter 依赖 DOM。两者仅在被调用时才触碰这些运行时依赖，本文件加载/解析阶段不依赖它们
   （Node require 时 window/document 均不存在，纯函数面与 UMD 挂载逻辑均不触碰）。

   UI 口径：attachDateRangeFilter 生成的胶囊+浮层结构/交互对齐 public/Export_DateFilter_Demo.html（用户
   确认过的口径，本文件只读参照复刻其 DOM 结构/class 命名/配色字面量，不 import 该文件代码）。
*/
;(function (root, factory) {
    'use strict';
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (root) {
        root.UnifyHelpers = root.UnifyHelpers || {};
        root.UnifyHelpers.attachExport = api.attachExport;
        root.UnifyHelpers.attachDateRangeFilter = api.attachDateRangeFilter;
        root.UnifyHelpers.fallbackVal = api.fallbackVal;
        root.UnifyHelpers.isValidDatePrefix = api.isValidDatePrefix;
        // 预筛 C4 H1：命名 uexportCheckVersion（不用裸 checkVersion）——UnifyHelpers 是跨文件共享命名空间，
        //   裸名将来其他 u-*.js 若也想挂一个"版本比对"函数会直接撞名互相覆盖；供页面调用 checkVersion 的场景
        //   一律走这个前缀名。UEXPORT_KIT_VERSION 供页面/守卫脚本只读当前版本号，不必解析源码正则。
        root.UnifyHelpers.uexportCheckVersion = api.checkVersion;
        root.UnifyHelpers.UEXPORT_KIT_VERSION = api.KIT_VERSION;
    }
}(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    var KIT_VERSION = 'uexport1';

    // codex S4 复审同款范式（u-paste.js:39-47）：页面侧保留 `<PREFIX>_UEXPORT_KIT_EXPECTED` 常量 +
    //   调用本函数一行；"未加载"分支仍留页面侧（调用本函数之前的前置判断）。
    function checkVersion(expected, pageName) {
        if (KIT_VERSION !== expected) {
            console.error('[导出共享层] u-export.js 版本不匹配：期望 ' + expected + '，实际 ' + KIT_VERSION +
                '。多半是浏览器缓存了旧版 JS —— 请硬刷新（Ctrl+F5）；若是开发期，检查 ' + (pageName || '本页') +
                ' 里 u-export.js 的 ?v= 缓存串是否已 bump。');
            return false;
        }
        return true;
    }

    // ============================================================
    // 共享工具函数（方案 §3.1.1 末尾"共享工具函数"，三页 overdueRule 复用；必须 Node 可 require 直测）
    // ============================================================

    // fallbackVal(a,b)：null/undefined/空串/纯空白归一为"空"后回退到 b（完成锚禁裸 ??——??
    //   只认 null/undefined，不认空串/空白，超时列/完成锚等字段常见"空串"这类假非空，故需本函数）。
    function fallbackVal(a, b) {
        var av = (a === null || a === undefined) ? '' : String(a).trim();
        return av !== '' ? a : b;
    }

    // isValidDatePrefix(s)：^\d{4}-\d{2}-\d{2} 前缀 + 日历合法性（月 01-12 / 日按月末含闰年）。
    //   通过返回前 10 位（'YYYY-MM-DD'），否则 null——供创建日期范围筛选（§3.1.3）与超时列日期纪律共用。
    //   预筛 C4 L2：非字符串仍直接 return null（类型判定不动）；字符串先 trim 再验——容忍前后空白，
    //   对齐入库脏值现实（历史数据 created_at 等字段偶见首尾多余空格属已知脏值形态，属于本函数"能验就验"
    //   的职责范围）。⚠️ 与 fallbackVal 语义刻意不同：fallbackVal 判"是否算空"时 trim 只用于判定、
    //   返回值仍是原始未 trim 的 a——本函数返回值就是"验证后规范化的 10 位前缀"本身，trim 后的结果
    //   即最终产出，两者场景不同，不是同一套返回值语义矛盾。
    function isValidDatePrefix(s) {
        if (typeof s !== 'string') return null;
        var trimmed = s.trim();
        var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
        if (!m) return null;
        var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
        if (mo < 1 || mo > 12) return null;
        var isLeap = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0));
        var dim = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (d < 1 || d > dim[mo - 1]) return null;
        return trimmed.slice(0, 10);
    }

    // ============================================================
    // attachExport（方案 §3.1.1）
    // ============================================================

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    // N3：Date 实例格式化为本地 'YYYY-MM-DD HH:mm'（本地分量拼接，禁 toISOString——那是 UTC 表示，
    //   非 UTC+0 时区的用户打开导出文件会看到与页面显示相差数小时的错误时间）。
    function formatDateCell(d) {
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    var CELL_MAX_LEN = 32760;   // M2：Excel 单元格文本上限 32767 字符，留出「…（超长截断）」标记的余量

    // L1（预筛 C6b）：方案 §3.1.1"所有值导出为字符串 cell...平台展示格式 YYYY-MM-DD HH:mm"——此前只有
    //   Date 实例走 formatDateCell 归一，字符串日期（后端 SQLite datetime('now','localtime') 产出的
    //   'YYYY-MM-DD HH:mm:ss'，绝大多数列的真实存储形态）从未裁过秒，字面承诺没兑现。锚定 HH:mm 后
    //   紧跟可选 :ss（秒可有可无，均归一到无秒），非此形态一律不匹配、原样直通（不误伤非日期文本）。
    var DATETIME_SEC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;

    // 所有值导出为字符串 cell（t:'s'，含日期）；null/undefined/空串统一空串——json_to_sheet 按 typeof
    //   推断 cell 类型，本函数把一切值提前转成 JS 字符串，天然让产出全为 t:'s'（间接满足"不做公式前缀
    //   转义仍不被 Excel 当公式执行"：字符串 cell 本就是文本，SheetJS 不会因内容形似公式而改写 t/f）。
    //   colKeyForWarn：仅用于超长截断时的 console.warn 定位是哪一列，不参与值本身的计算。
    function toCellString(v, colKeyForWarn) {
        var fv = fallbackVal(v, '');
        var s;
        if (fv === null || fv === undefined) {
            s = '';
        } else if (typeof fv === 'string') {
            // L1：'YYYY-MM-DD HH:mm[:ss]' 形态裁秒归一——纯文本切割（string.slice，非 Date 往返），
            //   命中即截前 16 字符（'YYYY-MM-DD HH:mm' 恰 16 字节，正则已锚定该前缀，slice 天然精确）；
            //   本就无秒（已 16 字符）时 slice(0,16) 等于原样直通，不是二次判断。
            // codex 442 L2：候选值 trim 后再匹配（对齐 isValidDatePrefix 对首尾空白的容忍——历史脏值
            //   ' 2026-08-19 10:20:30 ' 也应归一到无秒展示格式）；未命中日期形态仍输出原 fv 保留空白策略。
            var tv = fv.trim();
            s = DATETIME_SEC_RE.test(tv) ? tv.slice(0, 16) : fv;
        } else if (fv instanceof Date) {
            s = formatDateCell(fv);
        } else {
            // N3：数字/布尔等兜底走 String()——列 value() 层应负责语义化（如布尔转"是/否"、金额转千分位），
            //   这里只是防止裸对象输出 "[object Object]" 之类无意义文本的最后一道兜底，不替列做业务判断。
            s = String(fv);
        }
        if (s.length > CELL_MAX_LEN) {
            console.warn('[导出共享层] 列 "' + (colKeyForWarn || '(未知列)') + '" 值超长（' + s.length + ' 字符），已截断至 ' + CELL_MAX_LEN + ' 字符');
            s = s.slice(0, CELL_MAX_LEN) + '…（超长截断）';
        }
        return s;
    }

    /**
     * attachExport(config) — 三模块列表导出（Excel）共享 helper。
     * config = { buttonSelector, getViewRows, columns, filename, overdueRule, onError }
     *   buttonSelector：导出按钮的 CSS 选择器（页面已有按钮，本函数只挂点击行为，不创建按钮元素）。
     *   getViewRows()：返回"当前筛选全量 + 当前视图排序"的行数组（契约必须，helper 不自行排序）。
     *   columns：[{ key, label, value?, deps? }, ...]——无 value 的列 key 兼作字段名（须 ∈ 数据源）；
     *     有 value 的列 deps 必填（供静态守卫 ⊆ 数据源断言，value() 实际读取哪些字段自报）。
     *   filename：string 或 () => string（不含扩展名，本函数补 .xlsx）。
     *   overdueRule(row, now)：三页各自实现；attachExport 每次点击现取一次 exportNow 绑定后经
     *     ctx.overdueRule(row) 转交给 value()（ctx.now 同步暴露）——同一次导出全部行共用同一判定基准。
     *   onError(err)：可选，页面自定义失败通知；不传则尝试 window.showToast('导出失败','error')，
     *     再退化 alert。事实核对（预筛 C4 N1）：全站 showToast 实为唯一定义（assets/js/app.js:40，
     *     `function showToast(message, type='info', duration=3000)`），三页签名并不分裂——本 helper
     *     仍保留 onError 可选回调是为了让页面能自定义"最薄的通知方式"（如替换文案/加时长），非规避
     *     不存在的签名分裂问题。
     */
    // buildExportRows(rows, columns, ctx) —— 归一化逻辑纯函数段（DOM/XLSX 无关，Node 可直接 require 直测）。
    //   attachExport 的浏览器点击流程与 verify-export-content.js 的文件内容测试**共用同一个函数**——
    //   后者测的是"实际导出路径的最终产物"（方案 §3.1.1 公式注入处置段原话），而非另起一份复刻实现。
    //   空值/空串 → fallbackVal 归一为 ''；value() 抛异常 → 该格 '#ERR'（不中断整行/整文件）。
    function buildExportRows(rows, columns, ctx) {
        return (rows || []).map(function (r) {
            var out = {};
            for (var i = 0; i < columns.length; i++) {
                var col = columns[i];
                var val;
                try {
                    val = (typeof col.value === 'function') ? col.value(r, ctx) : r[col.key];
                } catch (e) {
                    // N4：非 Error 抛出物兜底——value() 里若 throw 'xxx'/throw {} 这类非 Error 值，e.message
                    //   是 undefined，直接拼接会打印 "undefined"；对齐 corrections.js 同款写法。
                    console.warn('[导出共享层] 列 "' + (col.key || col.label) + '" value() 抛异常：' + String(e && e.message || e));
                    val = '#ERR';
                }
                // N4：去掉原先 (val==='#ERR')?'#ERR':toCellString(val) 的冗余分支——toCellString('#ERR') 本就
                //   原样返回 '#ERR'（fallbackVal 视为非空直通，typeof 是字符串直通），两条路径结果恒等，
                //   三元判断只是重复了一遍已有语义，删掉不改变任何行为。
                out[col.label] = toCellString(val, col.key || col.label);
            }
            return out;
        });
    }

    // buildExportHeader(columns) —— 按 columns 顺序映射 label 表头（json_to_sheet 的 header 选项参数）。
    function buildExportHeader(columns) {
        return (columns || []).map(function (c) { return c.label; });
    }

    // buildExportWorkbook(rows, columns, ctx, xlsxRef) —— M3：下沉的工作簿构建函数，attachExport 的浏览器
    //   点击流程与 verify-export-content.js 的文件内容测试共用同一份（消除此前两处各自重复 json_to_sheet/
    //   book_new/book_append_sheet 三行胶水代码的"sheet 构建层双实现"）。
    //   xlsxRef：Node 测试场景显式传入 require 来的 XLSX 模块；浏览器场景不传，回落全局 XLSX
    //   （vendor/xlsx.mini.min.js 挂的 window.XLSX）。两处调用方各自负责按各自环境提供正确的引用。
    function buildExportWorkbook(rows, columns, ctx, xlsxRef) {
        var X = xlsxRef || (typeof XLSX !== 'undefined' ? XLSX : undefined);
        if (!X) throw new Error('XLSX 未提供（浏览器场景缺 vendor/xlsx.mini.min.js，或 Node 调用方未传 xlsxRef）');
        var sheetRows = buildExportRows(rows, columns, ctx);
        var headerOrder = buildExportHeader(columns);
        var ws = X.utils.json_to_sheet(sheetRows, { header: headerOrder });
        var wb = X.utils.book_new();
        X.utils.book_append_sheet(wb, ws, 'Sheet1');
        return wb;
    }

    function attachExport(config) {
        config = config || {};
        var buttonSelector = config.buttonSelector;
        var filenameCfg = config.filename;
        var overdueRule = (typeof config.overdueRule === 'function') ? config.overdueRule : function () { return {}; };
        var onError = config.onError;

        var btn = (typeof buttonSelector === 'string') ? document.querySelector(buttonSelector) : buttonSelector;
        if (!btn) {
            console.error('[导出共享层] u-export.js attachExport：按钮选择器未命中 ' + buttonSelector);
            return;
        }

        function notifyError(err) {
            console.error('[导出共享层] u-export.js 导出失败：' + (err && err.message));
            if (typeof onError === 'function') { onError(err); return; }
            if (typeof window !== 'undefined' && typeof window.showToast === 'function') { window.showToast('导出失败', 'error'); return; }
            if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert('导出失败');
        }

        btn.addEventListener('click', function () {
            var originalHtml = btn.innerHTML;
            var originalDisabled = btn.disabled;
            // L4（登记接受）：XLSX.writeFile 是同步调用，下面两行设置的"导出中…"disabled 态在同步执行期间
            //   浏览器不会重绘/不可见（要等本次事件循环让出主线程才会 paint），用户实际看不到这个中间态；
            //   数据量百级时同步耗时是瞬时（毫秒级），本行为已知且可接受，不做 setTimeout(0)/异步分片等
            //   兜底改造（R6 兜底性质：真出现大数据量卡顿再处理，非本批范围）。
            btn.disabled = true;
            btn.textContent = '导出中…';
            try {
                // L3：入口误配（columns 非数组 / getViewRows 非函数）throw 进本 catch 走 notifyError，
                //   不再静默退化为空数组产出一个"看起来正常但没数据"的空文件。
                if (!Array.isArray(config.columns)) throw new Error('attachExport: config.columns 必须是数组');
                if (typeof config.getViewRows !== 'function') throw new Error('attachExport: config.getViewRows 必须是函数');
                if (typeof XLSX === 'undefined') { throw new Error('XLSX 未加载（vendor/xlsx.mini.min.js 缺失或加载顺序在本文件之后）'); }
                var columns = config.columns;
                var rows = config.getViewRows() || [];
                // now 通道（S5 交底缺口收口）：一次导出会话现取一次、全部行共用同一判定基准；
                //   ctx.overdueRule 已绑定 now——页面 value() 写 ctx.overdueRule(r) 即可，无需自管时间闭包。
                var exportNow = new Date();
                var ctx = { now: exportNow, overdueRule: function (row) { return overdueRule(row, exportNow); } };
                var wb = buildExportWorkbook(rows, columns, ctx);
                var fname = (typeof filenameCfg === 'function') ? filenameCfg() : (filenameCfg || 'export');
                XLSX.writeFile(wb, fname + '.xlsx');
                btn.disabled = originalDisabled;
                btn.innerHTML = originalHtml;
            } catch (err) {
                btn.disabled = originalDisabled;
                btn.innerHTML = originalHtml;
                notifyError(err);
            }
        });
    }

    // ============================================================
    // attachDateRangeFilter（方案 §3.1.3，D13，codex 434 五条已吸收）
    // ============================================================

    var DR_STYLE_ID = 'u-export-daterange-style';
    // 配色/结构逐字对齐 Export_DateFilter_Demo.html（用户确认过的胶囊三态口径）——只读参照复刻，非 import。
    var DR_STYLE_CSS =
        '.u-daterange{position:relative;display:inline-block;}' +
        '.u-daterange-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:#fff;color:#374151;cursor:pointer;transition:border-color .2s;white-space:nowrap;}' +
        '.u-daterange-btn:hover{border-color:#d97706;}' +
        '.u-daterange-btn svg{flex-shrink:0;}' +
        '.u-daterange-btn .chev{color:#9ca3af;font-size:10px;}' +
        '.u-daterange.filled .u-daterange-btn{border-color:#d97706;background:#fffbeb;color:#92400e;}' +
        '.u-daterange .clear-x{display:none;margin-left:2px;color:#b45309;font-weight:600;padding:0 2px;}' +
        '.u-daterange.filled .clear-x{display:inline;}' +
        '.u-daterange.filled .chev{display:none;}' +
        '.u-daterange-pop{display:none;position:absolute;top:calc(100% + 6px);left:0;z-index:50;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.12);padding:14px 16px;width:272px;}' +
        '.u-daterange.open .u-daterange-pop{display:block;}' +
        '.u-daterange-pop .row{display:flex;align-items:center;gap:8px;margin-bottom:10px;}' +
        '.u-daterange-pop .row span{font-size:12px;color:#6b7280;width:24px;flex-shrink:0;}' +
        '.u-daterange-pop input[type="date"]{flex:1;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;color:#374151;outline:none;}' +
        '.u-daterange-pop input[type="date"]:focus{border-color:#d97706;}' +
        '.u-daterange-pop-err{display:none;color:#dc2626;font-size:12px;margin:-2px 0 10px;line-height:1.5;}' +
        '.u-daterange-pop .quick{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;}' +
        '.u-daterange-pop .quick button{padding:4px 10px;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;font-size:12px;color:#475569;cursor:pointer;}' +
        '.u-daterange-pop .quick button:hover{border-color:#d97706;color:#d97706;}' +
        '.u-daterange-pop .acts{display:flex;justify-content:flex-end;gap:8px;}' +
        '.u-daterange-pop .acts .ghost{padding:5px 12px;border:none;background:none;font-size:12px;color:#94a3b8;cursor:pointer;}' +
        '.u-daterange-pop .acts .apply{padding:5px 14px;border:none;background:#d97706;color:#fff;border-radius:6px;font-size:12px;cursor:pointer;}';

    function ensureDateRangeStyleInjected() {
        if (document.getElementById(DR_STYLE_ID)) return;
        var styleEl = document.createElement('style');
        styleEl.id = DR_STYLE_ID;
        styleEl.textContent = DR_STYLE_CSS;
        document.head.appendChild(styleEl);
    }

    // pad2 复用上方 toCellString 段已定义的同名函数（本文件全域函数声明，非重复定义）。
    function fmtMD(s) { return s ? s.slice(5) : ''; }

    /**
     * attachDateRangeFilter(config) — 创建日期范围筛选胶囊（方案 §3.1.3）。
     * config = { containerSelector, label, onChange }
     * 返回 { getRange() }；range 恒 {start:'', end:''}（空串=不限，无 null 变体）。
     * onChange(range) 在应用/快捷项/清除时各触发一次，初始化不触发。
     * start>end 拒绝应用：浮层内提示，不关浮层不触发 onChange。
     * 快捷项固化：本月=当月1日~末日；上月=上月1日~末日；近30天=今天−29~今天（闭区间）。
     * 过滤本身不在本函数内做——本函数只管 UI + range 状态 + onChange 触发。
     */
    function attachDateRangeFilter(config) {
        config = config || {};
        var containerSelector = config.containerSelector;
        var label = config.label || '创建日期';
        var onChange = (typeof config.onChange === 'function') ? config.onChange : function () {};
        var state = { start: '', end: '' };
        var noop = { getRange: function () { return { start: state.start, end: state.end }; } };

        var root = (typeof containerSelector === 'string') ? document.querySelector(containerSelector) : containerSelector;
        if (!root) {
            console.error('[导出共享层] u-export.js attachDateRangeFilter：容器选择器未命中 ' + containerSelector);
            return noop;
        }
        // codex 442 L1：同一容器重复 attach 去重——每次 attach 都会加一个 document click 监听（关浮层用），
        //   页面局部重初始化/重复调用会累积残留监听引用旧 root。已绑定过的容器直接拒绝二次绑定（三页
        //   现状各一次调用，本判定是结构性防御非现症修复）。
        if (root.__uDateRangeAttached) {
            console.warn('[导出共享层] attachDateRangeFilter：容器已绑定过，忽略重复调用（防 document 监听累积）');
            return root.__uDateRangeAttached;
        }

        ensureDateRangeStyleInjected();
        root.classList.add('u-daterange');
        root.innerHTML =
            '<button class="u-daterange-btn" type="button">' +
                '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
                '<span class="lbl"></span><span class="chev">▾</span><span class="clear-x" title="清除">×</span>' +
            '</button>' +
            '<div class="u-daterange-pop">' +
                '<div class="row"><span>从</span><input type="date" class="d-start"></div>' +
                '<div class="row"><span>至</span><input type="date" class="d-end"></div>' +
                '<div class="u-daterange-pop-err"></div>' +
                '<div class="quick">' +
                    '<button type="button" data-q="thisM">本月</button>' +
                    '<button type="button" data-q="lastM">上月</button>' +
                    '<button type="button" data-q="d30">近 30 天</button>' +
                '</div>' +
                '<div class="acts"><button type="button" class="ghost">清除</button><button type="button" class="apply">应用</button></div>' +
            '</div>';

        var btn = root.querySelector('.u-daterange-btn');
        var lbl = root.querySelector('.lbl');
        var clearX = root.querySelector('.clear-x');
        var si = root.querySelector('.d-start');
        var ei = root.querySelector('.d-end');
        var errBox = root.querySelector('.u-daterange-pop-err');

        function render() {
            var filled = !!(state.start || state.end);
            root.classList.toggle('filled', filled);
            lbl.textContent = filled ? (label + ' ' + (fmtMD(state.start) || '…') + '~' + (fmtMD(state.end) || '…')) : label;
        }

        function clearErr() { errBox.style.display = 'none'; errBox.textContent = ''; }

        function closePop() { root.classList.remove('open'); clearErr(); }

        // doApply：校验 start<=end（起止反转拒绝，§3.1.3 契约）→ 写状态 → 渲染 → 关浮层 → 触发 onChange。
        //   校验失败：浮层内提示，直接 return，不碰 state/不关浮层/不触发 onChange。
        function doApply(s, e) {
            if (s && e && s > e) {
                errBox.textContent = '起始日期不能晚于结束日期';
                errBox.style.display = 'block';
                return;
            }
            clearErr();
            state.start = s || '';
            state.end = e || '';
            si.value = state.start;
            ei.value = state.end;
            render();
            closePop();
            onChange({ start: state.start, end: state.end });
        }

        btn.addEventListener('click', function (ev) {
            if (ev.target === clearX || clearX.contains(ev.target)) {
                ev.stopPropagation();
                doApply('', '');
                return;
            }
            var wasOpen = root.classList.contains('open');
            document.querySelectorAll('.u-daterange.open').forEach(function (o) { if (o !== root) o.classList.remove('open'); });
            root.classList.toggle('open', !wasOpen);
            if (!wasOpen) {
                clearErr();
                // L1：开浮层时把输入框显示同步回已生效的 state（而非保留 DOM 里可能残留的上次输入）——
                //   起止反转被拒绝那次，si/ei 的值仍是用户刚才打的（未生效的）脏值；用户当时不管它、关掉
                //   浮层再重新点开时，若不重置会看到与实际生效 range 不一致的显示，误以为那组脏值已经生效。
                si.value = state.start;
                ei.value = state.end;
            }
        });
        root.querySelector('.apply').addEventListener('click', function () { doApply(si.value, ei.value); });
        root.querySelector('.ghost').addEventListener('click', function () { doApply('', ''); });
        root.querySelectorAll('[data-q]').forEach(function (q) {
            q.addEventListener('click', function () {
                var now = new Date(), y = now.getFullYear(), m = now.getMonth();
                if (q.getAttribute('data-q') === 'thisM') {
                    doApply(y + '-' + pad2(m + 1) + '-01', y + '-' + pad2(m + 1) + '-' + pad2(new Date(y, m + 1, 0).getDate()));
                } else if (q.getAttribute('data-q') === 'lastM') {
                    var lm = new Date(y, m - 1, 1);
                    doApply(lm.getFullYear() + '-' + pad2(lm.getMonth() + 1) + '-01',
                            lm.getFullYear() + '-' + pad2(lm.getMonth() + 1) + '-' + pad2(new Date(lm.getFullYear(), lm.getMonth() + 1, 0).getDate()));
                } else if (q.getAttribute('data-q') === 'd30') {
                    // 修1（预筛 C4c）：原用毫秒减法 now.getTime()-29*86400000，隐含"一天恒等于 86400000ms"
                    // 假设——有夏令时（DST）切换的时区里，跨越切换日那天不是 24 小时，减 29*86400000 毫秒
                    // 会落在错误的日历天上。改为日历减法：先复制今天的日历日期（年月日，不带时分秒），
                    // 再用 setDate(getDate()-29)——setDate/getDate 按本地日历语义运算，由 Date 对象自己
                    // 处理跨月/跨年/跨 DST 边界，不依赖"一天=固定毫秒数"这个不成立的假设。
                    var today = new Date(y, m, now.getDate());
                    today.setDate(today.getDate() - 29);
                    doApply(today.getFullYear() + '-' + pad2(today.getMonth() + 1) + '-' + pad2(today.getDate()),
                            y + '-' + pad2(m + 1) + '-' + pad2(now.getDate()));
                }
            });
        });
        document.addEventListener('click', function (ev) { if (!root.contains(ev.target)) closePop(); });

        render();   // 初始渲染，不算"应用"——不触发 onChange（契约"初始化不触发"）

        var api = { getRange: function () { return { start: state.start, end: state.end }; } };
        root.__uDateRangeAttached = api;   // codex 442 L1：绑定标记（重复 attach 时复用本 api，见函数头去重判定）
        return api;
    }

    return {
        KIT_VERSION: KIT_VERSION,
        checkVersion: checkVersion,
        fallbackVal: fallbackVal,
        isValidDatePrefix: isValidDatePrefix,
        toCellString: toCellString,
        buildExportRows: buildExportRows,
        buildExportHeader: buildExportHeader,
        buildExportWorkbook: buildExportWorkbook,
        attachExport: attachExport,
        attachDateRangeFilter: attachDateRangeFilter,
    };
}));
