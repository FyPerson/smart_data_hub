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

  w.UnifyHelpers = w.UnifyHelpers || {};
  w.UnifyHelpers.statusBadge = statusBadge;
  w.UnifyHelpers.typeTag = typeTag;
})(window);
