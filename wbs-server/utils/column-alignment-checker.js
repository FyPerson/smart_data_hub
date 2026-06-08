/**
 * 列对齐比对 helper（取数交付质量记录 v3.0 Commit B）
 *
 * 设计来源：docs/local/数据协作模块_v3.0/取数交付质量记录_方案_20260605_v3.0.md §5
 * codex 67 开发计划审 M-2：列名归一化规则写死 + 单测锁住，防误报缺列
 * codex 69 B 审 M-1/L-1：归一化补不可见脏字符清理 + missing 回显可见化
 *
 * 核心口径（用户拍板）：
 *   记 T = 需求模板列集合，S = SQL 结果列集合
 *   - T ⊆ S（需求列都在）→ 齐全，is_columns_complete=1
 *   - T ⊄ S（缺了需求列）→ 缺列，is_columns_complete=0，missing = T \ S
 *   - 多列放行：S \ T（SQL 多查的）不报警、不记录为问题
 *
 * 提供 3 个工具函数：
 *   - normalizeColumnName(name)              单列名归一化
 *   - buildColumnSet(cols)                    归一化去重为 Set
 *   - compareColumns(templateCols, sqlCols)   比对，返回 { complete, missing, ... }
 */

'use strict';

// 不可见字符正则（用 \u 转义，不写字面字符——字面零宽/BOM 肉眼不可见，易被编辑器/工具破坏）：
//   U+200B 零宽空格 / U+200C 零宽非连接 / U+200D 零宽连接 / U+FEFF BOM
const ZERO_WIDTH_RE = /[​-‍﻿]/g;
//   全角 ASCII 区 U+FF01–U+FF5E（减 0xFEE0 映射到半角 U+0021–U+007E）
const FULLWIDTH_ASCII_RE = /[！-～]/g;
//   空白归一：\s（半角空格/制表/换行/回车等）+ NBSP(U+00A0) + 全角空格(U+3000) → 单个半角空格
const WHITESPACE_RE = /[\s 　]+/g;

/**
 * 列名归一化规则（M-1/M-2 硬约束，单测锁住，不可随意改动）：
 *   1. 转字符串
 *   2. 去不可见字符（codex 69 M-1）：零宽字符 + BOM 直接删除——肉眼不可见，
 *      从网页/PDF 复制表头时极易带入，不删会"看不出原因地误报缺列"
 *   3. 全角 ASCII → 半角（中文输入法下 ＩＤ／（ 等全角字符统一）
 *   4. 空白归一（codex 69 M-1）：NBSP / 全角空格 / 制表 / 换行 / 连续空白 → 单个半角空格
 *      （'客户  ID' 与 '客户 ID' 视为同列；但 '客户ID' 与 '客户 ID' 仍不同列，保留单空格语义）
 *   5. trim 首尾空格 + lowercase（大小写不敏感，用户拍板：模板 'ID' 与 SQL 'id' 视为同列）
 *   返回归一化后的字符串；空/null/纯空白/纯不可见字符 → 返回空串（调用方过滤）
 *
 * @param {*} name 原始列名（可能是 string / number / null）
 * @returns {string} 归一化后的列名（空串表示该列应被忽略）
 */
function normalizeColumnName(name) {
    if (name == null) return '';
    let s = String(name);
    s = s.replace(ZERO_WIDTH_RE, '');                                          // 2
    s = s.replace(FULLWIDTH_ASCII_RE, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)); // 3
    s = s.replace(WHITESPACE_RE, ' ');                                         // 4
    return s.trim().toLowerCase();                                             // 5
}

/**
 * 可见化原始列名（L-1）：用于 missing 回显，去不可见字符 + 空白归一 + trim，
 * 但**保留原始大小写和中文**（不 lowercase）——让用户看到接近原样、可读、可对照的列名，
 * 而不是带零宽字符"看着和 SQL 列一模一样却报缺列"的困惑串。
 *
 * @param {*} raw 原始列名
 * @returns {string} 可见化后的列名
 */
function toDisplayName(raw) {
    if (raw == null) return '';
    let s = String(raw);
    s = s.replace(ZERO_WIDTH_RE, '');
    s = s.replace(WHITESPACE_RE, ' ');
    return s.trim();
}

/**
 * 把列名数组归一化为去重后的 Set（忽略空列名）。
 * @param {Array} cols 原始列名数组
 * @returns {{ set: Set<string>, normMap: Map<string,string> }}
 *   set     = 归一化后去重的列名集合（比对用）
 *   normMap = 归一化值 → 首个原始列名的可见化版本（用于 missing 回显，可读）
 */
function buildColumnSet(cols) {
    const set = new Set();
    const normMap = new Map();
    if (!Array.isArray(cols)) return { set, normMap };
    for (const raw of cols) {
        const norm = normalizeColumnName(raw);
        if (norm === '') continue;               // 空列名忽略
        if (!set.has(norm)) {
            set.add(norm);
            normMap.set(norm, toDisplayName(raw)); // 记首个原始名的可见化版本（L-1）
        }
    }
    return { set, normMap };
}

/**
 * 比对需求模板列 T 与 SQL 结果列 S，判定 T ⊆ S。
 *
 * @param {Array} templateCols 需求模板列（T，来自 xlsx 表头）
 * @param {Array} sqlCols      SQL 结果列（S，来自 runRealSmokeTest 列名）
 * @returns {{ complete: boolean, missing: string[], templateCount: number, sqlCount: number }}
 *   complete = T ⊆ S（需求列齐全）
 *   missing  = T \ S 的可见化列名数组（缺哪几列）；齐全时为 []
 *   templateCount / sqlCount = 归一化去重后的列数（便于诊断）
 *
 * 边界：
 *   - 模板列为空（空数组/全空列名）→ T 为空集，空集是任何集合的子集 → complete=true（不报缺列）。
 *     注意（codex 69 M-4）：本函数只表达"能比对时的 0/1"。"模板缺失/读取失败/没法比对"这第三态
 *     由调用方（C2）处理——读模板抛错时 C2 写 is_columns_complete=NULL（未比对），不调本函数当齐全。
 *     compareColumns 自身的"模板空→complete=true"仅用于"模板存在但恰好 0 有效列"的退化场景。
 *   - SQL 列为空 + 模板非空 → 全部缺列。
 */
function compareColumns(templateCols, sqlCols) {
    const { set: tSet, normMap: tMap } = buildColumnSet(templateCols);
    const { set: sSet } = buildColumnSet(sqlCols);

    const missing = [];
    for (const tNorm of tSet) {
        if (!sSet.has(tNorm)) {
            missing.push(tMap.get(tNorm));  // 回显可见化模板列名
        }
    }

    return {
        complete: missing.length === 0,
        missing,
        templateCount: tSet.size,
        sqlCount: sSet.size,
    };
}

module.exports = {
    normalizeColumnName,
    toDisplayName,
    buildColumnSet,
    compareColumns,
};
