/* model-catalog-core.js — 模型中心目录页纯函数核心（#77 C4b）
   命名空间：window.ModelCatalogCore.*（不产生任何顶层名；禁止新增裸全局）。
   内容：分组（主模型 + 伴生表 = 一组，落单伴生自成一组）/ 命中（字段表 + #id 规则）/ 排序（作用于主模型）/ 分页（按组）/
         上游名（与后端 routes/model-center/model-relations.js 的 upstreamOfModel 同源）/ 事件顺序（重载 / 改条件 / 翻页 / 排序 / focus / 展开令牌）。
         C4c-0a 扩展：排序键 acceptance_at / domain（EXTRA_SORT_FIELDS）、筛选键 view / status / domain、左栏计数 railCounts、列表重载失败事件 listFailed、
         显示映射（firstSentence / acceptanceView / IMPL_BADGE_LABELS / IMPL_BADGE_TONE）。
   UMD：浏览器挂 window.ModelCatalogCore；Node 走 module.exports（scripts/verify-model-catalog-core.js 与 verify-model-catalog-core-ext.js 两种方式都跑）。
   纯函数：不读写 DOM / 全局状态，所有状态从参数进、从返回值出，不修改入参；工厂内没有模块级可变状态。
   依赖：仅 ModelDetailKit.normalizeModelDetail——Node 侧 require('./model-detail-normalize.js')，浏览器侧取 root.ModelDetailKit
         （页面须先加载 model-detail-normalize.js 再加载本文件）；缺失时在「调用 upstreamNames / matchRow」时抛带说明的 Error，加载时不抛。
   搬入件：SORT_FIELD_TYPES / STATUS_SORT_ORDER / parseSqliteTs / sortByField 自 model-catalog.js 逐字搬入（函数体不改；
         C4b-2 删 model-catalog.js 里的原件）。sortByField 只是与页面原函数逐字相同的搬入件（供对拍与底层使用）：
         目录排序必须经 computeView / toggleSort（显式输入序号只在 computeView 里生效），接线层不得直接用它排组。
   接线契约（C4b-2 照此写）：
     · 每次状态变化都重新调用 computeView，把它返回的 groups / pageGroups 作为唯一渲染源；不缓存、不手动重排、不自行实现组命中。
     · 初始状态用 createState()；所有事件的前置条件见「事件函数」一节的注释。
     · 每页组数固定 PAGE_SIZE，事件函数不收 pageSize 参数（传了即抛错）。
     · effects 里的 id 保持调用方传入的原值；页面不得建按原始类型区分的关系缓存，一律经 state.relations[String(id)] 读取，
       关系数据按不可变对待（核心只保存引用、不深拷贝，页面不得修改）。
     · 排序键只能取 SORT_KEYS 的子集（SORT_KEYS = 核心接受的排序键全集；页面排序按钮恰为 DOM 契约 §B.3 第 12 条的 8 个键，不得由 SORT_KEYS 生成，测试驱动也不得读它定期望）；筛选键只能取 FILTER_PREDICATES 的键；左栏计数只能用 railCounts，不得在页面里自行统计。
     · 列表请求失败调用 listFailed({ token })（保留旧数据，把等不到响应的展开项置为可重试）；显示文案经 firstSentence / acceptanceView / IMPL_BADGE_* 映射。
   改本文件须同时改目录页引用处的 ?v=..._<CORE_VERSION> 与 scripts/verify-shared-css-cache-bust.js 里的登记。
*/
;(function (root, factory) {
    var api = factory(root);
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    if (root) { root.ModelCatalogCore = api; }
}(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    // 版本印记：必须与 Model_Center.html 引用本文件的 ?v=..._<CORE_VERSION> 后缀一致。
    var CORE_VERSION = 'mcc3';

    // 每页固定 20 组（方案 §3.4）：computeView / 全部事件只接受这个值，页面层须传 ModelCatalogCore.PAGE_SIZE
    var PAGE_SIZE = 20;

    // 组命中口径（P23）：当前采用 'same-member'，这是用户裁定前的暂定值；改动点只此一处（computeView 里标注 P23 的那一行）。
    //   'same-member'（当前）：组内必须有「同一个成员」同时命中搜索并通过全部筛选，整组才保留。
    //   'independent'（另一读法）：组内有成员命中搜索、且（可能是另一个）成员通过筛选，即保留。
    // 接线层不得自行实现组命中，一律调用 computeView；GROUP_HIT_RULE 仅供诊断 / 测试读取，页面不得据它分支。
    var GROUP_HIT_RULE = 'same-member';

    // ==================== 自 model-catalog.js 逐字搬入 ====================

        // 字段类型分派（数字 / 日期 / 字符串 / 状态自定义优先级）
        const SORT_FIELD_TYPES = {
            id: 'number',
            layer: 'string',
            table_name: 'string',
            table_comment: 'string',
            tech_owner: 'string',
            biz_owner: 'string',
            update_cycle: 'string',
            status: 'statusOrder',
            archived_task_count: 'number',
            updated_at: 'date',
        };

        // 状态业务优先级（按模型生命周期先后排：规划中→开发中→待验收→已上线→已下线）
        const STATUS_SORT_ORDER = {
            CREATED: 0,
            DEVELOPING: 1,
            REVIEWING: 2,
            ONLINE: 3,
            OFFLINE: 4,
        };

        function parseSqliteTs(s) {
            const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s));
            if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
            const t = new Date(s).getTime();
            return isNaN(t) ? 0 : t;
        }

        function sortByField(list, field, dir) {
            const type = SORT_FIELD_TYPES[field] || 'string';
            const mult = dir === 'asc' ? 1 : -1;

            return list.slice().sort((a, b) => {
                const va = a[field];
                const vb = b[field];

                // null/undefined/空字符串统一排末尾
                const aEmpty = va === null || va === undefined || va === '';
                const bEmpty = vb === null || vb === undefined || vb === '';
                if (aEmpty && bEmpty) return 0;
                if (aEmpty) return 1;
                if (bEmpty) return -1;

                let cmp = 0;
                if (type === 'number') {
                    cmp = Number(va) - Number(vb);
                } else if (type === 'date') {
                    cmp = parseSqliteTs(va) - parseSqliteTs(vb);
                } else if (type === 'statusOrder') {
                    // codex 审 MEDIUM 修：未知/非标准状态恒排末尾（不随 asc/desc 翻转）——
                    //   原 fallback=99 + 末尾 cmp*mult 会让未知态在 desc 首击时翻到最前（潜在 bug；
                    //   现 data_models.status 全为 5 个英文码、NULL 已被上方空值检查兜末尾，故不触发，防御性修）
                    const ka = STATUS_SORT_ORDER[va];
                    const kb = STATUS_SORT_ORDER[vb];
                    if (ka === undefined && kb === undefined) return 0;
                    if (ka === undefined) return 1;
                    if (kb === undefined) return -1;
                    cmp = ka - kb;
                } else {
                    // string：用中文 locale collator 支持中文/英文混排
                    cmp = String(va).localeCompare(String(vb), 'zh-Hans-CN');
                }
                return cmp * mult;
            });
        }

    // ==================== 以下为 C4b 新增 ====================

    // ---- C4c-0a 扩展：排序键 ----
    // 搬入件 SORT_FIELD_TYPES 不能加键（七节按 token 冻结），新键单独登记在 EXTRA_SORT_FIELDS（值 = 比较类型）。
    // 比较时把两行投影成「同类型的已登记键」的对象（date 借 updated_at、string 借 table_name）再交给 sortByField，
    // 所以空值排末尾 / 三态 / 并列按输入序这些规则与旧键完全相同。
    //   acceptance_at：取 row.acceptance.at（acceptance 为 null 或没有 at → 空值）；domain：取 row.domain 的原始代码（不是显示名，Q10；null / 空串 / 纯空白都是空值）。
    var EXTRA_SORT_FIELDS = { acceptance_at: 'date', domain: 'string' };
    // 核心「接受」的排序键全集（computeView / toggleSort 只接受这里的键）：SORT_FIELD_TYPES 的 10 个 + 扩展 2 个 = 12 个。
    //   其中 table_comment / biz_owner / update_cycle / archived_task_count 按方案 §3.4 已无界面入口，保留只因搬入件不能删键。
    //   页面排序按钮恰为 DOM 契约 §B.3 第 12 条的 8 个键（layer, table_name, status, acceptance_at, tech_owner, updated_at, domain, id）：
    //   不得由 SORT_KEYS 生成；测试驱动里的期望也不得读本常量（否则同义反复）。核心不导出 8 键清单。
    var SORT_KEYS = Object.keys(SORT_FIELD_TYPES).concat(Object.keys(EXTRA_SORT_FIELDS));
    // 业务域筛选里「未设置」的取值（domain 为 null / 空串 / 纯空白）
    var DOMAIN_NONE = '__none__';
    // 左栏视图的全部取值（FILTER_PREDICATES.view 只认这四个；setFilter 对其它非空值立即抛错；railCounts 遍历它）
    var VIEW_VALUES = ['all', 'stale', 'pending', 'custom'];


    /**
     * 复用 sortByField 的比较器做两两比较：-1 = a 在前，1 = b 在前，0 = 并列。
     * 并列判定：[a,b] 与 [b,a] 两次都保持输入次序即并列。computeView 再用输入序号作最终次序，不依赖引擎的排序稳定性。
     */
    function compareByField(a, b, field, dir) {
        var x = a, y = b, f = field;
        if (hasOwn.call(EXTRA_SORT_FIELDS, field)) {
            x = projectExtraSort(a, field);
            y = projectExtraSort(b, field);
            f = EXTRA_SORT_FIELDS[field] === 'date' ? 'updated_at' : 'table_name';
        }
        var xy = sortByField([x, y], f, dir);
        var yx = sortByField([y, x], f, dir);
        if (xy[0] === x && yx[0] === x) return -1;
        if (xy[0] === y && yx[0] === y) return 1;
        return 0;
    }

    /** 扩展排序键的投影：返回只带一个「借用键」的对象（acceptance_at → updated_at；domain → table_name） */
    function projectExtraSort(row, field) {
        if (field === 'acceptance_at') return { updated_at: row.acceptance ? row.acceptance.at : null };
        // 纯空白按空值处理（与左栏 / 筛选的 DOMAIN_NONE 口径一致 → 排末尾）
        return { table_name: isBlankDomain(row.domain) ? null : row.domain };
    }

    /** 无原型字典（id 字符串键如 "__proto__" 也不会触发原型语义） */
    function dict(src) {
        var d = Object.create(null);
        if (src) Object.keys(src).forEach(function (k) { d[k] = src[k]; });
        return d;
    }

    function assertPositiveInteger(n, what) {
        if (!(typeof n === 'number' && Number.isInteger(n) && n >= 1)) {
            throw new Error('model-catalog-core：' + what + ' 必须是正整数（实得 ' + String(n) + '）；字符串页码须先 Number() 并校验');
        }
    }

    var hasOwn = Object.prototype.hasOwnProperty;

    /** 仅 ASCII 字母转小写（与后端 model-relations.js 的 asciiLower 同口径；不用 toLowerCase，它会改动非 ASCII 字符） */
    function asciiLower(s) {
        return String(s).replace(/[A-Z]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 32); });
    }

    function isBlankLink(v) { return v === null || v === undefined || v === ''; }

    function getKit() {
        var kit = (root && root.ModelDetailKit) || null;
        if (!kit && typeof require === 'function') {
            try { kit = require('./model-detail-normalize.js'); } catch (e) { kit = null; }
        }
        if (!kit || typeof kit.normalizeModelDetail !== 'function') {
            throw new Error('model-catalog-core：缺少 ModelDetailKit.normalizeModelDetail（浏览器侧须先加载 model-detail-normalize.js，再加载本文件）');
        }
        return kit;
    }

    /** dim_config 文本 → 对象（兼容双重 JSON 编码）；不可解析一律 null（照 routes/model-center/model-relations.js 的 parseDimConfig） */
    function parseDimConfig(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        if (typeof raw === 'object') return raw;
        try {
            var v = JSON.parse(raw);
            if (typeof v === 'string') v = JSON.parse(v);
            return v;
        } catch (e) { return null; }
    }

    function trimmedNonEmpty(v) {
        if (v === null || v === undefined) return null;
        var s = String(v).trim();
        return s === '' ? null : s;
    }

    /** 上游名（与后端 upstreamOfModel 逐项同义，拍平成名字）：ODS → [source_system, source_table] 非空项；其余 → normalizeModelDetail().sources 的非空 name */
    function upstreamNames(row) {
        var layer = String((row && row.layer) || '').toUpperCase();
        var out = [];
        if (layer === 'ODS') {
            var sys = trimmedNonEmpty(row.source_system);
            var tbl = trimmedNonEmpty(row.source_table);
            if (sys !== null) out.push(sys);
            if (tbl !== null) out.push(tbl);
            return out;
        }
        var sources = getKit().normalizeModelDetail({
            layer: row.layer, config_mode: row.config_mode, companion_of: row.companion_of,
            dim_config: parseDimConfig(row.dim_config),
        }).sources;
        for (var i = 0; i < sources.length; i++) {
            var n = sources[i] && sources[i].name;
            if (n !== null && n !== undefined && n !== '') out.push(n);
        }
        return out;
    }

    /** 表头三态：新列 → field / desc；同列 desc → asc；同列 asc → 清除 */
    function nextSort(sortBy, sortDir, field) {
        if (sortBy !== field) return { sortBy: field, sortDir: 'desc' };
        if (sortDir === 'desc') return { sortBy: sortBy, sortDir: 'asc' };
        return { sortBy: null, sortDir: 'desc' };
    }

    /**
     * 分组：主模型 + 其伴生表 = 一组。组按主模型在输入里的位置排；伴生按输入顺序；
     * companion_of 指向的 id 不在输入里（或指向的行本身也是伴生 / 指向自己）→ 该伴生自成一组（orphan: true，D-15）。
     */
    function buildGroups(rows) {
        var primaryIds = new Map();
        var i, r;
        for (i = 0; i < rows.length; i++) {
            r = rows[i];
            if (isBlankLink(r.companion_of) && !primaryIds.has(String(r.id))) primaryIds.set(String(r.id), true);
        }
        var groups = [];
        var groupOfPrimary = new Map();
        for (i = 0; i < rows.length; i++) {
            r = rows[i];
            var isPrimary = isBlankLink(r.companion_of);
            var parentKey = isPrimary ? null : String(r.companion_of);
            var attached = !isPrimary && parentKey !== String(r.id) && primaryIds.has(parentKey);
            if (isPrimary || !attached) {
                var g = { id: r.id, primary: r, members: [r], orphan: !isPrimary };
                groups.push(g);
                if (isPrimary && !groupOfPrimary.has(String(r.id))) groupOfPrimary.set(String(r.id), g);
            }
        }
        for (i = 0; i < rows.length; i++) {
            r = rows[i];
            if (isBlankLink(r.companion_of)) continue;
            var pk = String(r.companion_of);
            if (pk !== String(r.id) && groupOfPrimary.has(pk)) groupOfPrimary.get(pk).members.push(r);
        }
        return groups;
    }

    /** 搜索命中：字段表 + #id 规则；ASCII 大小写折叠、去首尾空白；% _ 只当字面量 */
    function matchRow(row, query) {
        var q = String(query === null || query === undefined ? '' : query).trim();
        if (q === '') return true;
        var idm = /^#?(\d+)$/.exec(q);
        if (idm && idm[1] === String(row.id)) return true;
        var needle = asciiLower(q);
        var fields = [row.table_name, row.table_comment, row.impl_note, row.source_table, row.source_system];
        fields = fields.concat(upstreamNames(row));
        if (Array.isArray(row.impl_obj_names)) fields = fields.concat(row.impl_obj_names);
        for (var i = 0; i < fields.length; i++) {
            var v = fields[i];
            if (v === null || v === undefined) continue;
            if (asciiLower(String(v)).indexOf(needle) !== -1) return true;
        }
        return false;
    }

    /** 筛选槽位：layer（C4b）+ view / status / domain（C4c-0a）；值为 null / '' 不筛（见 passesFilters） */
    var FILTER_PREDICATES = {
        layer: function (row, v) { return String(row.layer || '').toUpperCase() === String(v).toUpperCase(); },
        // 视图（左栏）：all 恒真；stale ⇔ 验收摘要为陈旧；pending ⇔ 自定义模型且实现对象数为 0（rel 为 null = 关系加载失败，不算）；custom ⇔ 自定义模型；其他取值抛错
        view: function (row, v) {
            if (v === 'all') return true;
            if (v === 'stale') return !!row.acceptance && row.acceptance.state === 'stale';
            if (v === 'pending') return row.config_mode === 'custom' && !!row.rel && row.rel.obj === 0;
            if (v === 'custom') return row.config_mode === 'custom';
            throw new Error('model-catalog-core：未登记的视图取值 ' + String(v));
        },
        status: function (row, v) { return row.status === v; },
        // 业务域：DOMAIN_NONE ⇔ 未设置（null / undefined / 空串 / 纯空白）；其余按代码严格相等
        domain: function (row, v) {
            if (v === DOMAIN_NONE) return isBlankDomain(row.domain);
            return row.domain === v;
        },
    };

    function isBlankDomain(d) { return d === null || d === undefined || String(d).trim() === ''; }

    /** 成员是否通过全部筛选；值为 null / '' 不筛；未登记的键一律抛错（fail-closed，哪怕值为空） */
    function passesFilters(row, filters) {
        var keys = Object.keys(filters || {});
        var ok = true;
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (!hasOwn.call(FILTER_PREDICATES, k)) throw new Error('model-catalog-core：未登记的筛选键 ' + k);
            var v = filters[k];
            if (v === null || v === undefined || v === '') continue;
            if (!FILTER_PREDICATES[k](row, v)) ok = false;
        }
        return ok;
    }

    function flatIds(groups) {
        var ids = [];
        for (var i = 0; i < groups.length; i++) for (var j = 0; j < groups[i].members.length; j++) ids.push(groups[i].members[j].id);
        return ids;
    }

    /**
     * 目录视图：分组 → 组命中（P23，见 GROUP_HIT_RULE）→ 按主模型对组排序（显式带输入序号作最终次序）→ 按组切页。
     * pageSize 必填且只能是 PAGE_SIZE（20）；page 必须是正整数，原样返回、不夹紧（夹紧只在事件里做）；
     * sortBy 为 null / undefined 表示未排序；否则必须是 SORT_KEYS 里的键（SORT_FIELD_TYPES ∪ EXTRA_SORT_FIELDS；空字符串也抛错）、sortDir 必须是 'asc' / 'desc'，否则抛错（fail-closed）。
     */
    function computeView(rows, opts) {
        var o = opts || {};
        var pageSize = o.pageSize;
        if (pageSize !== PAGE_SIZE) throw new Error('model-catalog-core：每页固定 ' + PAGE_SIZE + ' 组（实得 pageSize ' + String(pageSize) + '）');
        var page = o.page;
        assertPositiveInteger(page, 'page');
        // 只有 null / undefined 表示「未排序」；空字符串与其他未登记值一律抛错
        var sorting = o.sortBy !== null && o.sortBy !== undefined;
        if (sorting) {
            if (!hasOwn.call(EXTRA_SORT_FIELDS, o.sortBy)) {
                if (!hasOwn.call(SORT_FIELD_TYPES, o.sortBy)) throw new Error('model-catalog-core：未登记的排序字段 ' + String(o.sortBy));
            }
            if (o.sortDir !== 'asc' && o.sortDir !== 'desc') throw new Error('model-catalog-core：sortDir 必须是 asc / desc（实得 ' + String(o.sortDir) + '）');
        }
        var all = buildGroups(rows);
        var kept = [];
        var i, j;
        for (i = 0; i < all.length; i++) {
            var hit = false;
            // P23（组命中口径，当前 'same-member'）：同一个成员须同时命中搜索并通过全部筛选；改口径只改下面这一行
            for (j = 0; j < all[i].members.length && !hit; j++) {
                hit = matchRow(all[i].members[j], o.query) && passesFilters(all[i].members[j], o.filters);
            }
            if (hit) kept.push(all[i]);
        }
        var groups = kept;
        if (sorting) {
            var primaries = kept.map(function (g) { return g.primary; });
            var order = new Map();
            primaries.forEach(function (p, ix) { order.set(p, ix); });
            var sortedPrimaries = primaries.slice().sort(function (a, b) {
                return compareByField(a, b, o.sortBy, o.sortDir) || (order.get(a) - order.get(b));
            });
            var groupOf = new Map();
            kept.forEach(function (g) { groupOf.set(g.primary, g); });
            groups = sortedPrimaries.map(function (p) { return groupOf.get(p); });
        }
        var totalGroups = groups.length;
        var pageGroups = groups.slice((page - 1) * pageSize, page * pageSize);
        return {
            groups: groups,
            totalGroups: totalGroups,
            totalModels: flatIds(groups).length,
            totalPages: Math.ceil(totalGroups / pageSize),
            page: page,
            pageSize: pageSize,
            pageGroups: pageGroups,
            pageIds: flatIds(pageGroups),
            orderedIds: flatIds(groups),
        };
    }

    function clampPage(page, totalPages) {
        if (totalPages <= 0) return 1;
        var p = Number(page);
        if (!(p >= 1)) return 1;
        return p > totalPages ? totalPages : Math.floor(p);
    }

    /** id（主或伴生）所在的页号与页内组序号（均 1 起）；找不到 → null */
    function locate(view, id) {
        var key = String(id);
        for (var gi = 0; gi < view.groups.length; gi++) {
            var ms = view.groups[gi].members;
            for (var mi = 0; mi < ms.length; mi++) {
                if (String(ms[mi].id) === key) {
                    return { page: Math.floor(gi / view.pageSize) + 1, index: (gi % view.pageSize) + 1 };
                }
            }
        }
        return null;
    }

    // ==================== C4c-0a 扩展：左栏计数 / 显示映射 ====================

    var LAYER_ORDER = ['ODS', 'DIM', 'DWD', 'DWS', 'ADS'];

    /** 按 UTF-16 码元比较（不依赖 ICU / locale，保证各环境同序） */
    function codeCmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

    /**
     * 左栏计数（D-8）：计数单位是模型（含伴生），只看传入的 rows，不受任何筛选 / 搜索影响。
     * 返回 { total, view: { all, stale, pending, custom }, layer: [{ value, count }], status: [...], domain: [...] }：
     *   · view 的口径直接取 FILTER_PREDICATES.view（计数与筛选谓词同源 = 命中的模型数；列表按组显示，点开后可能带出未命中的同组成员，故列表模型数可以大于计数）；
     *   · layer：value 大写归一；ODS, DIM, DWD, DWS, ADS 在前，其余按码元序；只含出现过的值；layer 为空的行只计入 total；
     *   · status：按 STATUS_SORT_ORDER，未知状态按码元序排在后面；只含出现过的值；status 为空的行不进列表（空值不能当筛选值）；
     *   · domain：代码原样、按码元序；未设置（null / 空串 / 纯空白）合并为 DOMAIN_NONE 放最后；只含出现过的值。
     * 已知行为：左栏各列表用码元序（codeCmp），列表按业务域排序走 sortByField（localeCompare），两者顺序可能不同。
     * 左栏各区「全部」项的计数一律取 total（= view.all），不得对分区列表求和（layer / status 为空的行只计入 total，不在分区列表里）。
     */
    function railCounts(rows) {
        if (!Array.isArray(rows)) throw new Error('model-catalog-core：railCounts 需要行数组（实得 ' + String(rows) + '）');
        var out = { total: 0, view: { all: 0, stale: 0, pending: 0, custom: 0 }, layer: [], status: [], domain: [] };
        var layers = dict(), statuses = dict(), domains = dict();
        var noneCount = 0;
        rows.forEach(function (row) {
            out.total += 1;
            VIEW_VALUES.forEach(function (k) { if (FILTER_PREDICATES.view(row, k)) out.view[k] += 1; });
            var lv = String(row.layer === null || row.layer === undefined ? '' : row.layer).toUpperCase();
            if (lv !== '') layers[lv] = (layers[lv] || 0) + 1;
            if (row.status !== null && row.status !== undefined && row.status !== '') statuses[row.status] = (statuses[row.status] || 0) + 1;
            if (isBlankDomain(row.domain)) noneCount += 1;
            else domains[row.domain] = (domains[row.domain] || 0) + 1;
        });
        var pairs = function (d, keys) { return keys.map(function (k) { return { value: k, count: d[k] }; }); };
        var layerKeys = Object.keys(layers);
        out.layer = pairs(layers, LAYER_ORDER.filter(function (k) { return k in layers; })
            .concat(layerKeys.filter(function (k) { return LAYER_ORDER.indexOf(k) === -1; }).sort(codeCmp)));
        var statusKeys = Object.keys(statuses);
        out.status = pairs(statuses, statusKeys.filter(function (k) { return hasOwn.call(STATUS_SORT_ORDER, k); })
            .sort(function (a, b) { return STATUS_SORT_ORDER[a] - STATUS_SORT_ORDER[b]; })
            .concat(statusKeys.filter(function (k) { return !hasOwn.call(STATUS_SORT_ORDER, k); }).sort(codeCmp)));
        out.domain = pairs(domains, Object.keys(domains).sort(codeCmp));
        if (noneCount > 0) out.domain.push({ value: DOMAIN_NONE, count: noneCount });
        return out;
    }

    /** 实现说明首句（方案 §3.1）：trim → 取第一个「。」或「；」之前的部分再 trim；空返回 ''（页面显示「（未填写实现说明）」）。以分隔符开头也返回 ''。 */
    function firstSentence(implNote) {
        if (implNote === null || implNote === undefined) return '';
        var s = String(implNote).trim();
        if (s === '') return '';
        var cut = s.length;
        var i1 = s.indexOf('。'), i2 = s.indexOf('；');
        if (i1 !== -1 && i1 < cut) cut = i1;
        if (i2 !== -1 && i2 < cut) cut = i2;
        return s.slice(0, cut).trim();
    }

    /** MM-DD：取 at 的第 6–10 个字符；at 缺失为 '' */
    function monthDay(at) { return at === null || at === undefined ? '' : String(at).slice(5, 10); }

    /**
     * 验收摘要 → 显示要素 { kind, mark, text, date, staleBadge, title }（方案 §3.2 六态 + D-6 第七态）：
     *   kind：pass | warn | fail | partial | stale | none | companion | unknown；mark 是前缀符号（可为 ''）；text 是不含日期的完整标签；
     *   date 是 MM-DD（none / companion / unknown 恒为 ''）；staleBadge 仅 stale 为 true；title 仅 unknown 非空。
     *   acc 为 null / undefined → unknown；state 不在六态内 → 抛错（分类表的兜底分支，不静默落入某一态）。
     */
    function acceptanceView(acc) {
        var mk = function (kind, mark, text, date, stale) { return { kind: kind, mark: mark, text: text, date: date, staleBadge: stale, title: '' }; };
        if (acc === null || acc === undefined) return { kind: 'unknown', mark: '', text: '—', date: '', staleBadge: false, title: '验收摘要加载失败' };
        var at = monthDay(acc.at);
        switch (acc.state) {
            case 'pass': return mk('pass', '✓', '✓ 通过', at, false);
            case 'warn': return mk('warn', '!', '! 有警告', at, false);
            case 'fail': return mk('fail', '✕', '✕ 未通过', at, false);
            case 'partial':
                var missData = !!acc.stages && acc.stages.structure !== null && acc.stages.structure !== undefined && (acc.stages.data === null || acc.stages.data === undefined);
                var ptext = missData ? '◐ 缺数据验收' : '◐ 缺结构验收';
                return mk('partial', '◐', ptext, at, false);
            case 'stale':
                var prev = acc.prevResult;
                var pm = prev === 'pass' ? '✓' : (prev === 'warn' ? '!' : ((prev === null || prev === undefined) ? '—' : null));
                if (pm === null) throw new Error('model-catalog-core：未知的陈旧前验收结果 ' + String(prev));
                return mk('stale', pm, pm, at, true);
            case 'none': return mk('none', '', '无验收', '', false);
            case 'companion': return mk('companion', '', '随主模型', '', false);
            default: throw new Error('model-catalog-core：未知的验收状态 ' + String(acc.state));
        }
    }

    // 实现对象徽章：code → 文案（抄自后端 routes/model-center/impl-verify.js 的 BADGE_LABELS，node 用例逐项对拍）与色调（D-35）
    var IMPL_BADGE_LABELS = Object.freeze({
        unverified: '未核验',
        verify_failed: '核验失败',
        stale: '待重核',
        prod_missing: '生产缺失',
        unregistered: '未登记',
        consistent: '一致',
        inconsistent: '不一致',
    });
    var IMPL_BADGE_TONE = Object.freeze({
        consistent: 'ok',
        inconsistent: 'bad',
        prod_missing: 'bad',
        stale: 'warn',
        verify_failed: 'warn',
        unverified: 'muted',
        unregistered: 'muted',
    });

    // ==================== 事件函数：(state, args) → { state, effects } ====================

    // 状态形如：
    //   { page, sortBy, sortDir, query, filters, expanded: [id…], listToken, seq,
    //     expandTokens: { [String(id)]: token }, expandStatus: { [String(id)]: 'loading'|'loaded'|'error' },
    //     relations: { [String(id)]: 校验通过后收到的关系数据（原样保存，结构由 C4-api 的 /relations 定）} }
    // 按 id 存取的字典一律以 String(id) 为键；expanded 数组保留调用方传入的 id 原值，比较一律 String(id)。
    // 关系数据的所有权在核心：只在令牌校验通过且 ok 时写入；收起 / 翻页 / 改条件 / 列表重载到达时清除；页面只从状态读取。
    // 「改」指实际变化：搜索词 trim 后与当前相同、翻到当前页，都不收起展开、不回第 1 页、不作废令牌（P36，用户 10-09 同意在 C4c-4 修）。
    //
    // 重载窗口的关系数据语义：reloadStart → listArrived 之间保留旧的 expandStatus / relations（页面可继续显示旧内容，但在途展开令牌已作废）；
    //   listArrived 到达后，对仍保留展开的行清掉旧数据、置 loading、重新请求——即方案 §3.4「旧展开内容先显示加载态，不沿用旧数据」的读法。
    //
    // 事件前置条件（均不改入参，返回 { state, effects }）：
    //   · 状态须是 createState() 的形状（page 正整数；sortBy 为 null 或已登记键且 sortDir 为 asc / desc；query 字符串；filters 的键均已登记；seq 非负整数）。
    //   · rows 是列表接口返回的全量行数组；不收 pageSize 参数（args 里带 pageSize 属性即抛错）。
    //   · reloadStart(S)：无参数。
    //   · listArrived(S, { token, rows })：token 须与 S.listToken 相等且非 0，否则丢弃（discard-list）。
    //   · setQuery(S, q)、setFilter(S, key, value)：key 须已登记（FILTER_PREDICATES），否则抛错。
    //   · gotoPage(S, { page, totalPages })：page 正整数、totalPages 非负整数，否则抛错；page > totalPages 状态原样。
    //   · toggleSort(S, field)：field 须是 SORT_KEYS 里的键，否则抛错。
    //   · listFailed(S, { token })：列表请求失败；token 须与 S.listToken 相等且非 0，否则丢弃（discard-list）。
    //   · focus(S, { id, rows })、toggleExpand(S, { id })、relationsArrived(S, { id, token, ok, data })、retryExpand(S, { id })。
    //   · id 可以是数字或字符串，一律按 String(id) 比较与存取；effects 里的 id 保持调用方原值。
    function assertNoPageSize(a) {
        if (a && hasOwn.call(a, 'pageSize')) throw new Error('model-catalog-core：事件函数不接收 pageSize（每页固定 PAGE_SIZE = ' + PAGE_SIZE + '）');
    }
    /** 一份合法的初始状态：第 1 页、无排序 / 搜索 / 筛选、无展开、令牌与序号为 0、各字典为空 */
    function createState() {
        return {
            page: 1, sortBy: null, sortDir: 'desc', query: '', filters: {}, expanded: [],
            listToken: 0, seq: 0, expandTokens: dict(), expandStatus: dict(), relations: dict(),
        };
    }
    function copyState(S) {
        var c = {};
        Object.keys(S).forEach(function (k) { c[k] = S[k]; });
        c.filters = Object.assign({}, S.filters);
        c.expanded = (S.expanded || []).slice();
        c.expandTokens = dict(S.expandTokens);
        c.expandStatus = dict(S.expandStatus);
        c.relations = dict(S.relations);
        return c;
    }
    function clearExpand(c) { c.expanded = []; c.expandTokens = dict(); c.expandStatus = dict(); c.relations = dict(); }

    function viewOf(c, rows, page) {
        return computeView(rows, { query: c.query, filters: c.filters, sortBy: c.sortBy, sortDir: c.sortDir, page: page, pageSize: PAGE_SIZE });
    }

    /** 开始一次数据重载：发新列表令牌，作废全部在途展开令牌；旧的 expandStatus / relations 保留到新列表到达（页面可继续显示旧内容） */
    function reloadStart(S) {
        var c = copyState(S);
        c.seq = S.seq + 1;
        c.listToken = c.seq;
        c.expandTokens = dict();
        return { state: c, effects: [{ type: 'fetch-list', token: c.listToken }] };
    }

    /** 列表响应到达：令牌不符丢弃；否则按当前条件重算，页码夹到末页（D-13），展开只留仍在新当前页的 id、清掉全部旧关系数据并重新请求 */
    function listArrived(S, a) {
        assertNoPageSize(a);
        if (!a.token || a.token !== S.listToken) {
            return { state: copyState(S), effects: [{ type: 'discard-list', token: a.token }] };
        }
        var c = copyState(S);
        var v = viewOf(c, a.rows, S.page);
        c.page = clampPage(S.page, v.totalPages);
        var onPage = new Map();
        viewOf(c, a.rows, c.page).pageIds.forEach(function (id) { onPage.set(String(id), true); });
        var effects = [];
        c.expanded = S.expanded.filter(function (id) { return onPage.get(String(id)) === true; });
        c.expandTokens = dict();
        c.expandStatus = dict();
        c.relations = dict();
        c.expanded.forEach(function (id) {
            c.seq += 1;
            c.expandTokens[String(id)] = c.seq;
            c.expandStatus[String(id)] = 'loading';
            effects.push({ type: 'fetch-relations', id: id, token: c.seq });
        });
        c.listToken = 0;
        return { state: c, effects: effects };
    }

    /** 改搜索：与当前搜索词 trim 后的原文完全相同 → 状态原样、无 effects（P36：条件没变就不回第 1 页、不收起展开、不作废令牌）；
        只比较 trim 后的原文，不做大小写折叠（大小写不同按「改搜索」处理）。 */
    function setQuery(S, q) {
        var c = copyState(S);
        if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {
            return { state: c, effects: [] };
        }
        c.query = q;
        c.page = 1;
        clearExpand(c);
        return { state: c, effects: [] };
    }

    function setFilter(S, key, value) {
        if (key === 'view' && value !== null && value !== undefined && value !== '' && VIEW_VALUES.indexOf(value) === -1) throw new Error('model-catalog-core：未登记的视图取值 ' + String(value));
        if (!hasOwn.call(FILTER_PREDICATES, key)) throw new Error('model-catalog-core：未登记的筛选键 ' + key);
        var c = copyState(S);
        c.filters[key] = value;
        c.page = 1;
        clearExpand(c);
        return { state: c, effects: [] };
    }

    /** 翻页：page 与 totalPages 必须是整数（page ≥ 1、totalPages ≥ 0），否则抛错；page > totalPages 或 page 等于当前页 → 状态原样（P36）；否则换页并清空展开与令牌 */
    function gotoPage(S, a) {
        var c = copyState(S);
        var p = a.page;
        assertPositiveInteger(p, 'page');
        var t = a.totalPages;
        if (!(typeof t === 'number' && Number.isInteger(t) && t >= 0)) throw new Error('model-catalog-core：totalPages 必须是非负整数（实得 ' + String(t) + '）');
        if (p > t) return { state: c, effects: [] };
        if (p === S.page) return { state: c, effects: [] };
        c.page = p;
        clearExpand(c);
        return { state: c, effects: [] };
    }

    /** 排序：字段须是已登记的排序键；三态 → 回第 1 页；展开集合与令牌不动 */
    function toggleSort(S, field) {
        if (!hasOwn.call(EXTRA_SORT_FIELDS, field)) {
            if (!hasOwn.call(SORT_FIELD_TYPES, field)) throw new Error('model-catalog-core：未登记的排序字段 ' + String(field));
        }
        var c = copyState(S);
        var n = nextSort(S.sortBy, S.sortDir, field);
        c.sortBy = n.sortBy;
        c.sortDir = n.sortDir;
        c.page = 1;
        return { state: c, effects: [] };
    }

    /** ?focus：清空搜索与筛选（视同改条件）、定位目标所在页并高亮 3 秒；不自动展开；找不到 → 第 1 页 + 提示 */
    function focus(S, a) {
        assertNoPageSize(a);
        var c = copyState(S);
        c.query = '';
        c.filters = {};
        clearExpand(c);
        var v = viewOf(c, a.rows, 1);
        var loc = locate(v, a.id);
        if (loc) {
            c.page = loc.page;
            return { state: c, effects: [{ type: 'highlight', id: a.id, ms: 3000 }] };
        }
        c.page = 1;
        return { state: c, effects: [{ type: 'toast', text: '模型不存在或已删除', level: 'warning' }] };
    }

    function toggleExpand(S, a) {
        var c = copyState(S);
        var key = String(a.id);
        var at = -1;
        c.expanded.forEach(function (x, i) { if (String(x) === key) at = i; });
        if (at !== -1) {
            c.expanded.splice(at, 1);
            delete c.expandTokens[key];
            delete c.expandStatus[key];
            delete c.relations[key];
            return { state: c, effects: [] };
        }
        c.expanded.push(a.id);
        c.seq += 1;
        c.expandTokens[key] = c.seq;
        c.expandStatus[key] = 'loading';
        delete c.relations[key];
        return { state: c, effects: [{ type: 'fetch-relations', id: a.id, token: c.seq }] };
    }

    /**
     * relations 响应到达 { id, token, ok, data }：令牌不符（含已收起 / 已翻页 / 已重载）丢弃且不写入数据；
     * 通过后 ok → 状态 loaded 并把 data 存进 state.relations[String(id)]；失败 → 状态 error、清掉该 id 的旧数据；失败不产生 toast 类 effect。
     */
    function relationsArrived(S, a) {
        var c = copyState(S);
        var key = String(a.id);
        var cur = S.expandTokens ? S.expandTokens[key] : undefined;
        if (cur === undefined || a.token !== cur) return { state: c, effects: [{ type: 'discard-relations', id: a.id, token: a.token }] };
        if (a.ok) {
            c.expandStatus[key] = 'loaded';
            c.relations[key] = a.data === undefined ? null : a.data;
        } else {
            c.expandStatus[key] = 'error';
            delete c.relations[key];
        }
        return { state: c, effects: [] };
    }

    function retryExpand(S, a) {
        var c = copyState(S);
        var key = String(a.id);
        if (c.expandStatus[key] !== 'error') return { state: c, effects: [] };
        c.seq += 1;
        c.expandTokens[key] = c.seq;
        c.expandStatus[key] = 'loading';
        delete c.relations[key];
        return { state: c, effects: [{ type: 'fetch-relations', id: a.id, token: c.seq }] };
    }

    /**
     * 列表重载失败 { token }（C4b-1 预筛 M6）：令牌为 0 / 缺失 / 不等于 S.listToken → 丢弃（discard-list）；
     * 否则 listToken 置 0，页码 / 数据 / 搜索 / 筛选 / 排序原样（保留旧数据）；展开项里「令牌已作废」的 loading（reloadStart 时被作废、
     * 等不到响应的那些）改为 error，之后可 retryExpand；已 loaded 的保留旧关系数据（列表没变）；reloadStart 之后才展开的 loading
     * 还带着有效令牌、请求仍在途，保持 loading（它会自己落到 loaded / error）。effects 恒为 []。
     */
    function listFailed(S, a) {
        assertNoPageSize(a);
        var tk = a ? a.token : undefined;
        if (!tk || tk !== S.listToken) {
            return { state: copyState(S), effects: [{ type: 'discard-list', token: tk }] };
        }
        var c = copyState(S);
        c.listToken = 0;
        Object.keys(c.expandStatus).forEach(function (k) {
            if (c.expandStatus[k] === 'loading' && c.expandTokens[k] === undefined) {
                c.expandStatus[k] = 'error';
                delete c.relations[k];
            }
        });
        return { state: c, effects: [] };
    }

    // 导出的表冻结：页面代码改不了核心内部使用的同一份对象
    Object.freeze(SORT_FIELD_TYPES);
    Object.freeze(STATUS_SORT_ORDER);
    Object.freeze(EXTRA_SORT_FIELDS);
    Object.freeze(SORT_KEYS);
    Object.freeze(VIEW_VALUES);
    Object.freeze(FILTER_PREDICATES);

    return {
        CORE_VERSION: CORE_VERSION,
        PAGE_SIZE: PAGE_SIZE,
        createState: createState,
        GROUP_HIT_RULE: GROUP_HIT_RULE,
        SORT_FIELD_TYPES: SORT_FIELD_TYPES,
        EXTRA_SORT_FIELDS: EXTRA_SORT_FIELDS,
        SORT_KEYS: SORT_KEYS,
        DOMAIN_NONE: DOMAIN_NONE,
        STATUS_SORT_ORDER: STATUS_SORT_ORDER,
        parseSqliteTs: parseSqliteTs,
        sortByField: sortByField,
        nextSort: nextSort,
        buildGroups: buildGroups,
        upstreamNames: upstreamNames,
        matchRow: matchRow,
        FILTER_PREDICATES: FILTER_PREDICATES,
        computeView: computeView,
        clampPage: clampPage,
        locate: locate,
        reloadStart: reloadStart,
        listArrived: listArrived,
        setQuery: setQuery,
        setFilter: setFilter,
        gotoPage: gotoPage,
        toggleSort: toggleSort,
        focus: focus,
        toggleExpand: toggleExpand,
        relationsArrived: relationsArrived,
        retryExpand: retryExpand,
        listFailed: listFailed,
        VIEW_VALUES: VIEW_VALUES,
        railCounts: railCounts,
        firstSentence: firstSentence,
        acceptanceView: acceptanceView,
        IMPL_BADGE_LABELS: IMPL_BADGE_LABELS,
        IMPL_BADGE_TONE: IMPL_BADGE_TONE,
    };
}));
