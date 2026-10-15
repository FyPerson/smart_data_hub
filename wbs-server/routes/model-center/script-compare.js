'use strict';

/**
 * save-scripts 的脚本「内容是否实质变化」比较（#77 C1a，从 server.js 抽出）。
 *
 * 只剔脚本「头部生成信息行」里随生成时刻 / 配置版本变化的值，不碰业务 SQL。
 * 头部行清单（全部来自 public/assets/js/model-script-gen.js 的脚本生成器，按函数名定位；#77 C3a 前在 Model_Center.html 内联）：
 *   创建日期: YYYY-MM-DD     DIM/DWD DDL·ETL·全量·增量·伴生表头注释（generateDimDDLFromConfig / generateDimDDL / generateDwdDDL / generateCompanionDDL / generateDwd{FullLoad,Incremental,Fdl}Script / generateDwdQualityRules）
 *   生成日期: YYYY-MM-DD     DIM/DWD 脚本尾部头注释（generateFullLoadScript / generateIncrementalScript / generateFdlNodeScript）
 *   生成时间: <formatDateTimeUnified(new Date())>   ODS DDL（基础 / 带字段两种）的 `-- 生成时间: …` 行（generateODSDDL / generateODSDDLWithColumns）
 *   配置版本: <dwdConfig.version>   DWD 头注释（generateDwdDDL / generateDwd{FullLoad,Incremental,Fdl}Script / generateDwdQualityRules）
 *   最后同步: …              历史头部行（原规则保留）
 */

// 全部规则只认「行首（可带空白与 `--` 注释前缀）+ 标签」，整行取值剔除、保留前缀。
// 行首锚定是为了不吞业务 SQL 里恰好含这些字样的字符串（如 `SET remark='创建日期: …'`）；
// 生成器写出的这五种头部行实测全部位于行首（主会话 2026-10-01 grep 生成器源码核过；C3a 后源码在 model-script-gen.js）。
// 旧文件里若有不在行首的历史形态，只会被判「内容变了」而多递增一次（fail-closed），不会漏记。
const HEADER_RULES = [
    /^([ \t]*(?:--[ \t]*)?)创建日期:[^\n]*/gm,
    /^([ \t]*(?:--[ \t]*)?)生成日期:[^\n]*/gm,
    /^([ \t]*(?:--[ \t]*)?)生成时间:[^\n]*/gm,
    /^([ \t]*(?:--[ \t]*)?)配置版本:[^\n]*/gm,
    /^([ \t]*(?:--[ \t]*)?)最后同步:[^\n]*/gm
];

function normalizeForCompare(content) {
    let s = String(content == null ? '' : content).replace(/\r\n/g, '\n');
    for (const rule of HEADER_RULES) {
        s = s.replace(rule, (m, prefix) => (typeof prefix === 'string' ? prefix : ''));
    }
    return s.trim();
}

module.exports = { normalizeForCompare, HEADER_RULES };
