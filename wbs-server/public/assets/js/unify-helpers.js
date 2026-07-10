/* unify-helpers.js — 前端统一 C0 共享 JS 层
   命名空间：window.UnifyHelpers.*（禁止新增裸全局函数名）。
   依赖页面已有的全局 escapeHtml（app.js 提供）——本文件必须在 app.js 之后加载。
   最小抽象原则（方案 D2 / C0 任务书 §5）：只抽"明确跨页复用 + 能字节级复现当前输出"的纯展示函数，
   禁止把各页专属派生逻辑（如 correction 的分组/返工树、si 的通知状态文字化）塞进共享层。
   —— 前端统一实施方案 20260708 v1.2 §五；C0 任务书 20260708 v1.0 §5 ——
*/
;(function (w) {
  'use strict';

  // 状态徽章（base class 见 components.css .u-status-badge；各页 s-* 修饰色页面自带）
  // 与基准页（Data_Correction.html）renderTable/renderDrawer 原内联模板串逐字节一致（除根类加 u- 前缀）。
  function statusBadge(statusKey, label) {
    return '<span class="u-status-badge s-' + statusKey + '">' + w.escapeHtml(label) + '</span>';
  }

  // 类型标签（base class 见 components.css .u-type-tag；各页 t-* 修饰色页面自带）
  // 与基准页（Data_Correction.html）renderTable 原内联模板串逐字节一致（除根类加 u- 前缀）
  // （原字面量"批量"/"单"未 escape，escapeHtml 对无特殊字符的字面量输出不变，故安全）。
  function typeTag(typeKey, label) {
    return '<span class="u-type-tag t-' + typeKey + '">' + w.escapeHtml(label) + '</span>';
  }

  // ===== 可排序表头（前端统一 排序机制升共享层，通用化自 Data_Collab.html v1.72.1 sortByField/
  //   initListSorting/updateSortIcons 四件套）=====
  //   与原 Data_Collab 实现逐字节一致的比较规则：number/date/statusOrder/labelMap(原 targetDb 特例
  //   通用化)/string(zh-Hans-CN collator) 五类；null/undefined/空字符串统一排末尾（不论 asc/desc）。

  // 单值比较（不含空值判定，空值判定见 compareRow）。
  //   type: 'number' | 'date' | 'statusOrder' | 'labelMap' | 'string'（缺省 string）
  //   opts: { statusOrder, labelMaps }（labelMaps 是 { field: {value: label} } 的映射表）
  function compareByType(type, field, va, vb, opts) {
    opts = opts || {};
    if (type === 'number') {
      return Number(va) - Number(vb);
    }
    if (type === 'date') {
      return new Date(va).getTime() - new Date(vb).getTime();
    }
    if (type === 'statusOrder') {
      const raw = opts.statusOrder || {};
      // 兼容两种形状：① 整页只有一个枚举字段用 statusOrder（Data_Collab 单 status 字段场景，raw 本身
      //   就是 flat { value: order } 映射）② 多个枚举字段各自独立序（如 Issue_Tracker 的 priority/
      //   notify_status/status 三个字段），按字段名分命名空间传 { field: { value: order } }。
      //   自动判别：raw[field] 存在且是对象 → 视为①的嵌套形状；否则退回 raw 本身当 flat 映射，
      //   与既有单枚举调用方（Data_Collab）零改动兼容。
      const order = (raw[field] && typeof raw[field] === 'object') ? raw[field] : raw;
      const oa = order[va] !== undefined ? order[va] : 99;
      const ob = order[vb] !== undefined ? order[vb] : 99;
      return oa - ob;
    }
    if (type === 'labelMap') {
      // codex 审 MED-1：labelMaps[field] 支持传 getter 函数（比较时现取）——页面若用 `let map = {}`
      // 声明、异步加载回调里 `map = {...}` 整体重绑，传对象字面量引用会让共享层永远持旧空对象
      // （排序退化为 '#id' 兜底字典序）；传 `() => map` 现取，防页面重绑变量导致引用失效。
      const rawMap = opts.labelMaps && opts.labelMaps[field];
      const map = (typeof rawMap === 'function' ? rawMap() : rawMap) || {};
      const la = map[va] != null ? String(map[va]) : ('#' + va);
      const lb = map[vb] != null ? String(map[vb]) : ('#' + vb);
      return la.localeCompare(lb, 'zh-Hans-CN');
    }
    // string：中文 locale collator，支持中文/英文混排
    return String(va).localeCompare(String(vb), 'zh-Hans-CN');
  }

  // 两行按 field 比较（含空值判定）。fieldTypes: { field: type }；dir: 'asc'|'desc'。
  function compareRow(a, b, field, dir, fieldTypes, opts) {
    const type = (fieldTypes && fieldTypes[field]) || 'string';
    const mult = dir === 'asc' ? 1 : -1;
    const va = a[field];
    const vb = b[field];
    const aEmpty = va === null || va === undefined || va === '';
    const bEmpty = vb === null || vb === undefined || vb === '';
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    return compareByType(type, field, va, vb, opts) * mult;
  }

  // 按 field+dir 对 list 排序（不修改原数组）。
  //   config: { fieldTypes, statusOrder, labelMaps }（与 attachTableSort 的同名字段语义一致）
  //   暴露为独立工具函数：多数页直接用 attachTableSort 即可；结构非"平铺行数组"的页面
  //   （如 Data_Correction 的分组聚类树）用它自行实现"块级排序"，保留分组可视结构不受影响。
  function sortByField(list, field, dir, config) {
    config = config || {};
    return list.slice().sort((a, b) => compareRow(a, b, field, dir, config.fieldTypes, config));
  }

  // ===== 分页（四页列表统一前端分页，固定每页 25 条：全量拉取→筛选→排序→切片渲染，不改任何后端接口）=====
  //   独立暴露为 UnifyHelpers.attachPagination：多数页通过 attachTableSort 的 config.pagination 间接用
  //   （见下方组合）；结构非"平铺行数组"的页面（Data_Correction 分组聚类树，排序在块级、不走
  //   attachTableSort 的 getList/render 通用契约）直接调用本函数，对 clusterItems() 输出的最终展示
  //   行数组做分页——用户视角"每页 25 条"按可见行计，与树形结构（含灰显补显行）语义一致。
  //   config:
  //     containerSelector  页码条容器选择器（如 '#collabPagination'），挂列表表格 wrap 之后
  //     pageSize           可选，默认 25
  //     render             (pageSlice) => void，页面自身的行模板渲染函数（只渲染当前页切片）
  //     packPages          可选（codex 审 MED-3），(fullList, pageSize) => pages —— 自定义分页边界：
  //                        返回"页数组"（每页已是最终交给 render 的行数组）。供"不可从中间硬切"的结构
  //                        （如 Data_Correction 关联组块：块内 root/子行/连接线是一个渲染语义单元，
  //                        页边界切在块中间会让第 2 页从 xsys/rework 子行开头、树语义断裂）做块装箱。
  //                        提供时 fullList 可以是任意形状（如块数组），默认硬切片不再参与。
  //     countTotal         可选（配合 packPages），(fullList) => number —— 页码条"共 N 条"显示的总数
  //                        （装箱模式下 fullList 是块数组，总数应按行数计非块数）。缺省 fullList.length。
  //   返回：{ render, goToPage, getState }
  //     render(fullList)   传入排序后的全量数组（或 packPages 模式下的块数组）：回第 1 页 + 重新分页 +
  //                        渲染 + 同步页码条（筛选变化/排序变化/统计卡点击 → 调 render() 即天然回第 1 页）
  //     goToPage(n)         翻页（不重置为第 1 页，复用最近一次 render() 的分页结果）
  //     getState()          { page, pageSize, total }
  function attachPagination(config) {
    const containerSelector = config.containerSelector;
    const pageSize = config.pageSize || 25;
    const renderPageRows = config.render;
    const packPages = config.packPages || null;
    const countTotal = config.countTotal || ((list) => list.length);

    let currentPage = 1;
    let lastFull = [];
    let pages = [[]];   // 分页结果缓存（render() 时重算；goToPage 只切页不重算）

    function computePages() {
      if (packPages) {
        const packed = packPages(lastFull, pageSize);
        return (packed && packed.length) ? packed : [[]];
      }
      const out = [];
      for (let i = 0; i < lastFull.length; i += pageSize) out.push(lastFull.slice(i, i + pageSize));
      return out.length ? out : [[]];
    }

    function renderUI() {
      const container = containerSelector ? document.querySelector(containerSelector) : null;
      if (!container) return;
      const total = countTotal(lastFull);
      const totalPages = pages.length;
      container.innerHTML =
        '<span class="u-page-info">第 ' + currentPage + ' / ' + totalPages + ' 页 · 共 ' + total + ' 条</span>' +
        '<button type="button" class="u-btn-secondary u-page-btn" data-page-nav="prev"' + (currentPage <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<button type="button" class="u-btn-secondary u-page-btn" data-page-nav="next"' + (currentPage >= totalPages ? ' disabled' : '') + '>下一页</button>';
      const prevBtn = container.querySelector('[data-page-nav="prev"]');
      const nextBtn = container.querySelector('[data-page-nav="next"]');
      if (prevBtn) prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
      if (nextBtn) nextBtn.addEventListener('click', () => goToPage(currentPage + 1));
    }

    function renderCurrentSlice() {
      const totalPages = pages.length;
      if (currentPage > totalPages) currentPage = totalPages;
      if (currentPage < 1) currentPage = 1;
      renderPageRows(pages[currentPage - 1]);
      renderUI();
    }

    function render(fullList) {
      lastFull = fullList || [];
      pages = computePages();
      currentPage = 1;   // 契约：数据/筛选/排序变化 → 回第 1 页
      renderCurrentSlice();
    }

    function goToPage(page) {
      currentPage = page;
      renderCurrentSlice();
    }

    return {
      render: render,
      goToPage: goToPage,
      getState: () => ({ page: currentPage, pageSize: pageSize, total: countTotal(lastFull) }),
    };
  }

  // 通用可排序表头绑定：三态点击（新列 desc → asc → 清排序回 defaultSort）+ 图标/active 同步 +
  //   排序状态私有管理（各页不再自持 currentSortBy/currentSortDir 变量）+ 可选分页组合。
  //   config:
  //     tableSelector  表格根选择器（如 '#collabListTable'），表头行内 th.u-sortable 靠此定位
  //     fieldTypes     { field: 'number'|'date'|'statusOrder'|'labelMap'|'string' }
  //     statusOrder    可选，{ statusValue: number } —— type='statusOrder' 时用
  //     labelMaps      可选，{ field: { value: label } 或 field: () => map } —— type='labelMap' 时用；
  //                    映射对象若在页面里会被异步重绑（let map = {} → map = {...}），必须传 getter 现取（MED-1）
  //     getList        () => Array，返回待排序的当前数据（各页自行处理其余客户端筛选后的结果）
  //     render         (pageRows) => void，页面自身的行模板渲染函数（不含排序/分页逻辑；有 pagination
  //                    配置时收到的是当前页切片，否则是排序后的全量）
  //     defaultSort    可选，{ field, dir }，缺省 { field: 'id', dir: 'desc' }（清排序时的回落态）；
  //                    显式传 null（codex 审 LOW-1）= "默认态无单列排序"语义——适用于默认序不属于任何
  //                    单列的页面（如 Data_Correction 的 maxId 块序）：默认态不点亮任何表头弱指示
  //                    （全部 ⇅，防"ID ↓"误导用户已按 ID 排序），且默认态不做 flat 排序（getList()
  //                    原序透传；用 getState() 自行做块级排序的页面本就忽略 flat 结果，不受影响）
  //     pagination     可选，{ containerSelector, pageSize? } —— 提供则内部组合 attachPagination，
  //                    排序结果先分页切片再交给 config.render
  //   返回：{ init, render, getState, sortByField }
  //     init()      绑定表头点击事件 + 首次同步图标（DOMContentLoaded 后、首次 render 前后均可调）
  //     render()    重新取 getList() → 排序 →（有分页则切片，回第 1 页）→ 调用 config.render(rows) → 同步图标
  //     getState()  { sortBy, sortDir, page? }，供页面需要读当前状态时用（如 Data_Correction 块级排序）
  function attachTableSort(config) {
    const tableSelector = config.tableSelector;
    const fieldTypes = config.fieldTypes || {};
    const statusOrder = config.statusOrder || null;
    const labelMaps = config.labelMaps || {};
    const getList = config.getList;
    const doRenderRows = config.render;
    // LOW-1：null 是合法显式值（默认态无排序指示），仅 undefined 回落 id desc
    const defaultSort = config.defaultSort === null ? null : (config.defaultSort || { field: 'id', dir: 'desc' });

    let currentSortBy = null;
    let currentSortDir = 'desc';

    const sortConfig = { fieldTypes: fieldTypes, statusOrder: statusOrder, labelMaps: labelMaps };

    const pager = config.pagination
      ? attachPagination({
          containerSelector: config.pagination.containerSelector,
          pageSize: config.pagination.pageSize,
          render: doRenderRows,
        })
      : null;

    function thList() {
      return document.querySelectorAll(tableSelector + ' th.u-sortable');
    }

    function updateIcons() {
      thList().forEach((th) => {
        const field = th.dataset.sortBy;
        const icon = th.querySelector('.u-sort-icon');
        if (currentSortBy === field) {
          th.classList.add('active');
          if (icon) icon.textContent = currentSortDir === 'asc' ? '↑' : '↓';
        } else if (currentSortBy === null && defaultSort && field === defaultSort.field) {
          // 默认态弱指示（生产 Data_Collab updateSortIcons 原有行为：默认列显示方向、不加 active
          // 高亮以区别用户主动点击）；defaultSort:null 页（Correction）无此分支——交回核对恢复，
          // codex 接力版曾随图标隐藏一并删除，经核对生产原版（374b2b2 L2058-2061）确认应保留
          th.classList.remove('active');
          if (icon) icon.textContent = defaultSort.dir === 'asc' ? '↑' : '↓';
        } else {
          th.classList.remove('active');
          if (icon) icon.textContent = '⇅';
        }
      });
    }

    function doRender() {
      const list = (typeof getList === 'function' ? getList() : []) || [];
      let sorted;
      if (currentSortBy) {
        sorted = sortByField(list, currentSortBy, currentSortDir, sortConfig);
      } else if (defaultSort) {
        sorted = sortByField(list, defaultSort.field, defaultSort.dir, sortConfig);
      } else {
        sorted = list;   // LOW-1：defaultSort:null 默认态不做 flat 排序，getList() 原序透传
      }
      if (pager) {
        pager.render(sorted);
      } else {
        doRenderRows(sorted);
      }
      updateIcons();
    }

    function init() {
      thList().forEach((th) => {
        th.addEventListener('click', () => {
          const field = th.dataset.sortBy;
          if (currentSortBy !== field) {
            currentSortBy = field;
            currentSortDir = 'desc';
          } else if (currentSortDir === 'desc') {
            currentSortDir = 'asc';
          } else {
            currentSortBy = null;
            currentSortDir = 'desc';
          }
          doRender();
        });
      });
      updateIcons();
    }

    return {
      init: init,
      render: doRender,
      getState: () => Object.assign({ sortBy: currentSortBy, sortDir: currentSortDir }, pager ? pager.getState() : {}),
      sortByField: (list, field, dir) => sortByField(list, field, dir, sortConfig),
      pager: pager,
    };
  }

  w.UnifyHelpers = w.UnifyHelpers || {};
  w.UnifyHelpers.statusBadge = statusBadge;
  w.UnifyHelpers.typeTag = typeTag;
  w.UnifyHelpers.sortByField = sortByField;
  w.UnifyHelpers.attachTableSort = attachTableSort;
  w.UnifyHelpers.attachPagination = attachPagination;
})(window);
