// scripts/lib/sql-select-boundary.js — SQL 文本边界定位共享工具（S13 收口批 MED-2 新抽）
//
// 抽出背景：verify-sys-list-badge-fields.js 与 verify-sys-prerelease-flags.js 各自逐字维护了一份
//   "括号深度感知扫描找外层 FROM sys_issues" 实现——用来跳过 SELECT 列清单里子查询（如 B1 的
//   post_derive_root_id/post_derive_seq 两条标量子查询 `(SELECT d.derive_root_id FROM sys_issues d
//   WHERE ...)`）内部同字面量 "FROM sys_issues"，只认真正属于外层列表查询自己的那个。两份实现逐字
//   相同却各自维护，属于 codex 246 MED-1 教训同款"两端各自处理同一份数据会悄悄漂移"——本模块单点
//   实现，两文件改 require 同一份，未来同类扫描第三个消费点出现时也径直复用（不必再等第二次撞见
//   才决定要不要抽，见 verify-sys-delete-audit.js 相邻的『待第二处再抽』纪律：那条纪律管的是"要不要
//   抽"的决策时机，本次两个真实消费点已经摆在这里，决策条件早已满足）。
//
// fail-closed 加固（本次抽取新增，S13 收口 MED-2）：原两份实现允许扫描窗口内 depth 计数变负——比如
//   窗口上界恰好把某个只有右括号、左括号已在窗口外的表达式切在中间，或未来 SQL 文本里出现不配对的
//   单个括号字面量。depth 变负后只要后续再遇到一个 `(`，depth 会被重新算回 0——这个"重新回到 0"是假的
//   top-level（真实嵌套关系已经错乱），一旦此时紧跟着别的 SQL 语句块里同名的 needle 字面量，扫描器会
//   把它误判成本条语句自己的外层边界，静默把选中范围换成"混了另一段 SQL 的超集/错位集合"——不会报错，
//   比直接报错更危险（下游列对拍要等具体字段核对不上才会被发现，正常状态下守卫仍显示全绿）。
//   本版一旦观测到 depth<0 立即返回 fail-closed 结果（不再继续扫描、不给"重新归零"制造假 top-level 的
//   机会），调用方必须显式检查 wentNegative 并单独判红——不能只看 index>0 就放行。
'use strict';

/**
 * 在给定文本片段内定位「括号深度=0 时的第一个 needle」——用于跳过子查询/嵌套括号内部同字面量的
 * 干扰，只认真正的外层边界（如某条 SELECT 自己的 "FROM <table>"，非子查询内同名 FROM）。
 *
 * @param {string} strippedText 已剥注释的文本（调用方负责剥 SQL `--` 行注释/JS 块注释+行注释，本函数
 *   本身不做任何剥离——剥离规则随宿主语言不同而不同，属调用方职责，不应该在通用边界定位器里假设）。
 * @param {string} needle 要定位的字面量（如 'FROM sys_issues'）
 * @returns {{ index: number, wentNegative: boolean }}
 *   index：找到的位置，-1 表示未找到或 fail-closed 提前终止；
 *   wentNegative：扫描过程中括号深度是否曾变负——一旦为 true，index 恒为 -1（fail-closed：不信任
 *   "变负之后又凑巧归零"这种假 top-level 命中，宁可报"没找到"也不返回一个可能错位的边界）。
 */
function findOuterBoundary(strippedText, needle) {
  let depth = 0;
  for (let i = 0; i < strippedText.length; i++) {
    const ch = strippedText[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return { index: -1, wentNegative: true };   // fail-closed：括号计数一旦不自洽，立即停，不继续找
    }
    if (depth === 0 && strippedText.startsWith(needle, i)) return { index: i, wentNegative: false };
  }
  return { index: -1, wentNegative: false };
}

module.exports = { findOuterBoundary };
