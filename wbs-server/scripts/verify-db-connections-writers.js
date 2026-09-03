// verify-db-connections-writers.js — G4：db_connections 语句级直写清单静态守卫（C3，数据协作
// 接入外部源「小程序-智荟人力」方案 v1.6 §5.2 G4，D21）
//
// 覆盖面：
//   ① 登记表 REGISTERED_WRITE_POINTS——R4〔12a-H7〕扫描面 = 仓根全量递归发现的 .js/.cjs/.mjs
//      （排除 EXCLUDED_DIRS 白名单：node_modules / public/assets/vendor / test-screenshots /
//      uploads / archive / periodic-results，+ 守卫自身）每一条直接 `INSERT INTO db_connections` /
//      `UPDATE db_connections` / `DELETE FROM db_connections` 语句的 {文件, 所属函数/端点作用域,
//      操作类型, 归一化 SQL 指纹}，与实际扫描结果**双向相等**（多一条/少一条/指纹变化均判红）。
//   ② 变异自证——分别在 server.js、种子脚本（_seed-collab-external-source.js）、一个测试脚本
//      （G2，verify-collab-external-source.js）内存中临时新增一处直写，三处应各自判红；对照组
//      （原文不变）应全绿；再加一组：改动一处已登记语句的列清单（指纹变）→ 判红。
//
// 身份键 = `${file}|${scope}|${ordinal}`（scope+ordinal 命名/结构照 verify-collab-validation-
// status-coverage.js（G1）的既有范式——scope 取"该语句所属的、离它最近的一个零缩进锚点"
// （路由注册 app./router.METHOD(...) 或顶层 function/const-arrow 声明或 module.exports 工厂），
// ordinal 是同一 scope 内按出现顺序的第几条，不含行号（防不相关改动导致行号漂移误判）。
// op（操作类型）与 fingerprint（归一化 SQL 指纹）是登记项的"内容"，与身份键分开比较——同一身份键
// 若 op/fingerprint 变了，判"内容不匹配"（语句被静默改动），而不是判"少了一条+多了一条"。
//
// SELECT 与 sqlite_sequence 不算——本文件的扫描正则只匹配 INSERT INTO / UPDATE / DELETE FROM
// 后紧跟 `db_connections` 的语句，天然不命中 SELECT，也不会命中 `sqlite_sequence`（后者是完全
// 不同的表名字面量，不会被 `\bdb_connections\b` 命中）。
//
// 运行：node scripts/verify-db-connections-writers.js
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const ok = (m, cond, d) => {
    if (cond) { pass++; console.log(`  [OK] ${m}`); }
    else { fail++; console.log(`  [FAIL] ${m}${d ? '\n         ' + d : ''}`); }
};

// R6〔12a-M2 部分〕规则 ID 精确断言辅助——从失败消息里的 `[Qx]` 前缀提取规则 ID（与 G1 的
// verify-collab-validation-status-coverage.js 同款写法，独立复制一份，各 verify-*.js 脚本历来
// 互不 require，保持每个静态守卫自包含）。
const RULE_ID_RE_G4 = /^\[([A-Z]\d+)\]/;
function ruleIdOfG4(msg) { const m = RULE_ID_RE_G4.exec(msg); return m ? m[1] : null; }
function idsExactlyG4(failedRuleIds, expectedIds) {
    return failedRuleIds.size === expectedIds.length && expectedIds.every((id) => failedRuleIds.has(id));
}
// 收集一次 evaluateWritersCoverage 运行里所有失败消息，返回 {problems, failedRuleIds}——变异
// 自证里既有的"局部计数器"写法（`(m, cond) => { if (!cond) localFail++; }`）只统计数量，
// 精确断言需要消息文本本身来提取规则 ID，改用这个收集器。
function collectWritersProblems(fileTexts, registeredPoints) {
    const problems = [];
    evaluateWritersCoverage(fileTexts, registeredPoints, (m, cond, d) => { if (!cond) problems.push(m); });
    return { problems, failedRuleIds: new Set(problems.map(ruleIdOfG4).filter(Boolean)) };
}

const ROOT = path.join(__dirname, '..');

// ============================================================
// 通用文本工具（与 verify-collab-validation-status-coverage.js 同款实现，独立复制一份——
// 各 verify-*.js 脚本历来互不 require，保持每个静态守卫自包含）
// ============================================================
function stripJsCommentsStrict(source) {
    const acorn = require('acorn');
    const comments = [];
    // 〔G4 独有坑，G1 未踩过〕本文件扫描面含 scripts/** 全量，部分脚本（如 run-verify-family.js）
    // 以 `#!/usr/bin/env node` shebang 开头——G1 的三个固定扫描文件都没有 shebang，从未需要这个
    // 选项；不加 allowHashBang 会在 shebang 行的 `#!` 处直接抛语法错误。
    acorn.parse(source, {
        ecmaVersion: 2022, sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true,
        onComment: (block, text, start, end) => comments.push([start, end]),
    });
    if (!comments.length) return source;
    comments.sort((a, b) => a[0] - b[0]);
    let out = '', last = 0;
    for (const [start, end] of comments) {
        if (start < last) continue;
        out += source.slice(last, start);
        out += source.slice(start, end).replace(/[^\n\r]/g, ' ');
        last = end;
    }
    return out + source.slice(last);
}
// 转义感知的引号跳过——从开引号位置 i 出发，返回闭合引号的位置（找不到则返回文本末尾）。
function skipStringLiteral(src, i) {
    const quote = src[i];
    i++;
    while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) return i;
        i++;
    }
    return i;
}
function lineOf(text, idx) { return text.slice(0, idx).split('\n').length; }

// ============================================================
// 扫描面：R4〔12a-H7，主会话末次合并审②a〕从"固定四个顶层目录"扩到**仓根全量递归**发现
// .js/.cjs/.mjs 文件（本仓目前没有 .cjs/.mjs，前瞻性一并支持），排除下面这份可审计的白名单
// 目录 + 守卫自身——旧版固定数组意味着仓根新增的顶层目录（如本次新纳入的 public/assets/js/**）
// 永远不会被扫到，是比判红更隐蔽的"看不见"。
// ============================================================
// 排除白名单——逐条给理由，任何新增排除项都要在这里落一行说明，不允许"顺手加个目录"：
//   node_modules            第三方依赖，非本仓代码
//   public/assets/vendor    第三方前端库（如 xlsx.mini.min.js），非本仓代码
//   test-screenshots        Playwright 截图产物目录（图片，非代码）
//   uploads                 用户上传的附件物理存储目录（业务数据，非代码；含大量运行期生成的
//                           测试残留子目录）
//   archive                 历史归档目录（旧版本代码快照，不代表当前生产行为）
//   periodic-results        周期取数任务的运行结果存档（数据产物，非代码）
const EXCLUDED_DIRS = Object.freeze([
    'node_modules',
    'public/assets/vendor',
    'test-screenshots',
    'uploads',
    'archive',
    'periodic-results',
]);
const SCAN_EXTENSIONS = Object.freeze(['.js', '.cjs', '.mjs']);
function relPath(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }
function isExcludedRelDir(relDirPath) {
    return EXCLUDED_DIRS.some((ex) => relDirPath === ex || relDirPath.startsWith(ex + '/'));
}
function listSourceFilesRecursive(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (isExcludedRelDir(relPath(full))) continue;
            out.push(...listSourceFilesRecursive(full));
        } else if (entry.isFile() && SCAN_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
            out.push(full);
        }
    }
    return out;
}
// 本文件自身路径（相对 ROOT）——见下方排除说明。
const SELF_REL_PATH = relPath(__filename);
function collectScanFiles() {
    const files = listSourceFilesRecursive(ROOT);
    // 排除本文件自身：②变异自证的三个"内存新增探针"字符串（及⑤"改动列清单"用到的原文/变异文
    // 两段字面量）本身就是 `INSERT/UPDATE/DELETE ... db_connections` 形态的字符串常量，若不排除
    // 会被①的真实扫描误当成"又一处生产直写"收进结果——这是纯粹的自指假阳性（本文件从不真的执行
    // 任何数据库写操作，是静态分析器本体，不是登记对象）。
    return [...new Set(files.map(relPath))].filter((f) => f !== SELF_REL_PATH).sort();
}

// ============================================================
// 作用域锚点——**零缩进（行首）**的路由注册 / 顶层函数声明 / module.exports 工厂。
// 只认列首锚点的理由同 G1：本仓路由处理函数体内部大量嵌套局部 `const xxx = () => ...` 均有缩进，
// 不加列首限定会被这些嵌套局部抢先命中，反而比不加锚点更不稳定。
// 方言比 G1 多两条（本文件扫描面含 routes/**，G1 只扫 server.js 等 3 个固定文件）：
//   ① `router.METHOD(`——routes/** 下 Express Router 工厂模式的路由注册写法；
//   ② `module.exports = (deps) => {`——routes/** 常见的"工厂函数导出"顶层结构，工厂体内的
//      `router.METHOD(` 调用本身是缩进的（不会被零缩进锚点单独捕获），落在这层"工厂"粒度即可
//      （本仓 routes/** 目前没有任何 db_connections 直写，这层锚点是前瞻性兜底，不影响当前登记）。
// ============================================================
const ROUTE_ANCHOR_RE = /^(?:app|router)\.(get|post|put|delete|patch|listen)\(\s*(?:['"]([^'"]+)['"])?/gm;
const FN_ANCHOR_RE = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
const CONST_FN_ANCHOR_RE = /^const\s+(\w+)\s*=\s*(?:async\s*)?\(/gm;
const MODULE_EXPORTS_FACTORY_RE = /^module\.exports\s*=\s*(?:async\s*)?\(/gm;

function computeScopeAnchors(strippedSource) {
    const anchors = [];
    let m;
    ROUTE_ANCHOR_RE.lastIndex = 0;
    while ((m = ROUTE_ANCHOR_RE.exec(strippedSource))) {
        const method = m[1];
        const label = method === 'listen' ? 'app.listen(startup)' : `${method.toUpperCase()} ${m[2] || '(unknown path)'}`;
        anchors.push({ index: m.index, label });
    }
    FN_ANCHOR_RE.lastIndex = 0;
    while ((m = FN_ANCHOR_RE.exec(strippedSource))) anchors.push({ index: m.index, label: `function ${m[1]}` });
    CONST_FN_ANCHOR_RE.lastIndex = 0;
    while ((m = CONST_FN_ANCHOR_RE.exec(strippedSource))) anchors.push({ index: m.index, label: `const ${m[1]}` });
    MODULE_EXPORTS_FACTORY_RE.lastIndex = 0;
    while ((m = MODULE_EXPORTS_FACTORY_RE.exec(strippedSource))) anchors.push({ index: m.index, label: 'module.exports(factory)' });
    anchors.sort((a, b) => a.index - b.index);
    return anchors;
}
function scopeForIndex(anchors, index) {
    let label = '(module top-level)';
    for (const a of anchors) { if (a.index <= index) label = a.label; else break; }
    return label;
}

// ============================================================
// 提取匹配点所在的完整字符串/模板字面量内容——本仓约定 SQL 关键字恒紧跟在开引号之后（无字符串
// 拼接构造 SQL 的写法），从匹配点向前跳过空白即应命中引号字符；找不到判"异常"（fail-closed，
// 不静默放行——字符串拼接构造 SQL 需要人工核实，本扫描器不猜测拼接边界）。
// ============================================================
function extractEnclosingLiteral(stripped, matchIndex) {
    let i = matchIndex - 1;
    while (i >= 0 && /\s/.test(stripped[i])) i--;
    if (i < 0 || !"'\"`".includes(stripped[i])) return null;
    const quoteIdx = i;
    const endIdx = skipStringLiteral(stripped, quoteIdx);
    if (endIdx >= stripped.length || stripped[endIdx] !== stripped[quoteIdx]) return null;
    return { start: quoteIdx, end: endIdx, content: stripped.slice(quoteIdx + 1, endIdx) };
}

// ============================================================
// 归一化 SQL 指纹：剥注释（外层已做）→ 去掉 ?/${...} 占位差异 → 折叠空白 → 小写 → sha1 前 12 位
// ============================================================
function normalizeSqlFingerprint(sqlText) {
    const withoutPlaceholders = sqlText
        .replace(/\$\{[^}]*\}/g, '') // 模板插值（如 `SET ${col} = ?` 的列名插值）归一成同一占位符
        .replace(/\?/g, '');          // 参数占位符 ? 同样归一
    const collapsed = withoutPlaceholders.replace(/\s+/g, ' ').trim().toLowerCase();
    return crypto.createHash('sha1').update(collapsed, 'utf8').digest('hex').slice(0, 12);
}

// ============================================================
// 单文件扫描：返回该文件内全部 INSERT/UPDATE/DELETE db_connections 语句 + 异常清单
// ============================================================
// 〔R2·Opus 预筛，2026-09-02〕原正则漏四类真实会出现在 sqlite3 语句里的形态：
//   ① `REPLACE INTO db_connections`（sqlite 的 REPLACE 是 INSERT OR REPLACE 简写，独立关键字）；
//   ② `UPDATE OR IGNORE/REPLACE/ROLLBACK db_connections`（sqlite 冲突处理子句可直接跟在 UPDATE 后，
//      不像 INSERT 那样必须有 INTO 分隔，旧正则对 UPDATE 完全没建这条支路）；
//   ③/④ 表名被引号/方括号/schema 前缀包裹——`"db_connections"`（双引号标识符）/
//      `[db_connections]`（MSSQL 方括号）/ `` `db_connections` ``（MySQL 反引号）/
//      `main.db_connections`（schema 限定）。旧正则要求 `db_connections` 前必须恰好一个空格，
//      这四种形态都会被漏扫。
// 关键字段：INSERT/REPLACE INTO（可选 OR 子句）｜UPDATE（可选 OR 子句，无需 INTO）｜DELETE FROM。
// 表名段：可选 `schema.` 前缀 + 可选一个引号/方括号/反引号字符 + `db_connections`。
const STMT_RE = /\b((?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:\w+\.)?["'\[\x60]?db_connections\b/gi;
function scanFileText(relFile, rawText) {
    const stripped = stripJsCommentsStrict(rawText);
    const anchors = computeScopeAnchors(stripped);
    const results = [];
    const anomalies = [];
    const ordinalCounters = {};
    STMT_RE.lastIndex = 0;
    let m;
    while ((m = STMT_RE.exec(stripped))) {
        const kw = m[1].toUpperCase();
        // REPLACE INTO 语义上是 INSERT（sqlite「INSERT OR REPLACE」的简写关键字），归为 INSERT。
        const op = /^(INSERT|REPLACE)/.test(kw) ? 'INSERT' : /^UPDATE/.test(kw) ? 'UPDATE' : 'DELETE';
        const literal = extractEnclosingLiteral(stripped, m.index);
        if (!literal) {
            anomalies.push(`${relFile}:${lineOf(stripped, m.index)} 命中 db_connections ${op} 但未能提取所在字符串/模板字面量（非常规写法，可能是字符串拼接构造 SQL，需人工核实）`);
            continue;
        }
        const scope = scopeForIndex(anchors, m.index);
        ordinalCounters[scope] = (ordinalCounters[scope] || 0) + 1;
        results.push({
            file: relFile, scope, ordinal: ordinalCounters[scope], op,
            fingerprint: normalizeSqlFingerprint(literal.content),
            line: lineOf(stripped, m.index),
        });
    }
    return { results, anomalies };
}
function scanAllFiles(fileTexts) {
    const results = [];
    const anomalies = [];
    for (const file of Object.keys(fileTexts)) {
        const r = scanFileText(file, fileTexts[file]);
        results.push(...r.results);
        anomalies.push(...r.anomalies);
    }
    return { results, anomalies };
}
function keyOf(w) { return `${w.file}|${w.scope}|${w.ordinal}`; }

// ============================================================
// ① 登记表——身份键 = file|scope|ordinal，op/fingerprint 是内容字段。
// 本表由 scanAllFiles() 对当前真实文件的扫描结果直接生成（见文件底部 main() 的
// `--dump` 用法说明），人工核对后固化于此；后续任何一处直写增/删/改，扫描结果与本表
// 不再逐项相等，判红。
// ============================================================
const REGISTERED_WRITE_POINTS = [
    // scripts/_seed-collab-external-source.js（C3 种子脚本）—— 1 条：runApply 里唯一的 INSERT
    { file: 'scripts/_seed-collab-external-source.js', scope: 'function runApply', ordinal: 1, op: 'INSERT', fingerprint: '5c96e5e6b60b' }, // line 292
    // scripts/test-collab-mysql-smoke-e2e.js —— 2 条：建/删一条 e2e 专用测试连接
    { file: 'scripts/test-collab-mysql-smoke-e2e.js', scope: 'function setupMysqlConnection', ordinal: 1, op: 'INSERT', fingerprint: '746cca3a8116' }, // line 92
    { file: 'scripts/test-collab-mysql-smoke-e2e.js', scope: 'function teardownMysqlConnection', ordinal: 1, op: 'DELETE', fingerprint: '97666d4df244' }, // line 102
    // scripts/verify-collab-external-source.js（G2）—— 10 条：种子行 insertConn（顶层，08-H1 前置重构）+
    // S 组夹具直写（sInsertRawConn/sCorruptColumn）+ H1b/H4/H9/H8 共 7 条内联在 runHttpTests 里的直写
    { file: 'scripts/verify-collab-external-source.js', scope: 'function insertConn', ordinal: 1, op: 'INSERT', fingerprint: 'ebbabcbbbfb0' }, // line 450
    { file: 'scripts/verify-collab-external-source.js', scope: 'function sInsertRawConn', ordinal: 1, op: 'INSERT', fingerprint: '5c96e5e6b60b' }, // line 630
    { file: 'scripts/verify-collab-external-source.js', scope: 'function sCorruptColumn', ordinal: 1, op: 'UPDATE', fingerprint: '053fddf9aa5a' }, // line 647
    { file: 'scripts/verify-collab-external-source.js', scope: 'function runHttpTests', ordinal: 1, op: 'UPDATE', fingerprint: '742da7bee6d3' }, // line 1291 H1b：注入非法密文（external）
    { file: 'scripts/verify-collab-external-source.js', scope: 'function runHttpTests', ordinal: 2, op: 'UPDATE', fingerprint: '07f771b014d0' }, // line 1296 H1b：恢复合法密文（external）
    { file: 'scripts/verify-collab-external-source.js', scope: 'function runHttpTests', ordinal: 3, op: 'UPDATE', fingerprint: '742da7bee6d3' }, // line 1298 H4：注入非法密文（relational）
    { file: 'scripts/verify-collab-external-source.js', scope: 'function runHttpTests', ordinal: 4, op: 'UPDATE', fingerprint: '07f771b014d0' }, // line 1303 H4：恢复合法密文（relational）
    { file: 'scripts/verify-collab-external-source.js', scope: 'function runHttpTests', ordinal: 5, op: 'UPDATE', fingerprint: '8031e494ff85' }, // line 1578 H9：撤销 source_system_code
    { file: 'scripts/verify-collab-external-source.js', scope: 'function runHttpTests', ordinal: 6, op: 'UPDATE', fingerprint: '8031e494ff85' }, // line 1596 H9：恢复 source_system_code
    { file: 'scripts/verify-collab-external-source.js', scope: 'function runHttpTests', ordinal: 7, op: 'DELETE', fingerprint: 'f77e89da7d82' }, // line 1843 08-H1：删 PX_DUP2 关系型行，闭环回 422 对照
    // scripts/test-collab-external-source-playwright.js（G3 Playwright 贯穿，C5）—— 1 条：
    // insertConn（顶层种子函数，与 G2 insertConn 同款 SQL/同一列清单，指纹相同不是巧合）
    { file: 'scripts/test-collab-external-source-playwright.js', scope: 'function insertConn', ordinal: 1, op: 'INSERT', fingerprint: 'ebbabcbbbfb0' }, // line 386
    // scripts/verify-periodic-run.js —— 2 条（既有周期取数套件，与本批业务无关，登记表仍需覆盖全仓）
    { file: 'scripts/verify-periodic-run.js', scope: 'function seedSourceConnections', ordinal: 1, op: 'INSERT', fingerprint: 'c22b72d60940' }, // line 292
    { file: 'scripts/verify-periodic-run.js', scope: 'function endpointTests', ordinal: 1, op: 'DELETE', fingerprint: '6e08ecf3cdc1' }, // line 384
    // scripts/verify-periodic-task-crud.js —— 3 条（硬字面量 INSERT，非 `?` 参数化，逐条列不同值→逐条不同指纹）
    { file: 'scripts/verify-periodic-task-crud.js', scope: 'function main', ordinal: 1, op: 'INSERT', fingerprint: 'a903128629a6' }, // line 98
    { file: 'scripts/verify-periodic-task-crud.js', scope: 'function main', ordinal: 2, op: 'INSERT', fingerprint: '35c40292869a' }, // line 99
    { file: 'scripts/verify-periodic-task-crud.js', scope: 'function main', ordinal: 3, op: 'INSERT', fingerprint: 'cf95d0260736' }, // line 100
    // server.js —— 7 条：连接管理五端点里的全部直写（POST 两支 INSERT + 清默认位 UPDATE；PUT 两种
    // 分支 + 清默认位；DELETE）
    { file: 'server.js', scope: 'POST /api/db-connections', ordinal: 1, op: 'INSERT', fingerprint: '1834517bb972' }, // line 8440 D14 原子去重分支
    { file: 'server.js', scope: 'POST /api/db-connections', ordinal: 2, op: 'INSERT', fingerprint: '5c96e5e6b60b' }, // line 8452 code 为空不去重分支
    { file: 'server.js', scope: 'POST /api/db-connections', ordinal: 3, op: 'UPDATE', fingerprint: '823a97cf11f6' }, // line 8466 清其他 warehouse 默认位
    // 〔2026-09-03 同步·11-M2 纵深防御条件写〕另一 agent 给下面四条语句加了 `AND type <> 'external'`
    // 纵深防御条件（PUT 清默认位 UPDATE + 两支主 UPDATE、DELETE），SQL 文本变化 → 指纹随之变化，
    // 身份键（file|scope|ordinal）不变，按 G4 自身 `--dump` 输出重新固化。
    { file: 'server.js', scope: 'PUT /api/db-connections/:id', ordinal: 1, op: 'UPDATE', fingerprint: 'a8bd374b2b5b', desc: '11-M2 纵深防御条件写：清其他默认位（+ AND type <> \'external\'）' }, // line 8556
    { file: 'server.js', scope: 'PUT /api/db-connections/:id', ordinal: 2, op: 'UPDATE', fingerprint: '2e9536d18246', desc: '11-M2 纵深防御条件写：更新密码分支主 UPDATE（+ AND type <> \'external\'）' }, // line 8560
    { file: 'server.js', scope: 'PUT /api/db-connections/:id', ordinal: 3, op: 'UPDATE', fingerprint: 'a81d510361b4', desc: '11-M2 纵深防御条件写：不更新密码分支主 UPDATE（+ AND type <> \'external\'）' }, // line 8572
    { file: 'server.js', scope: 'DELETE /api/db-connections/:id', ordinal: 1, op: 'DELETE', fingerprint: '8f473179f4ba', desc: '11-M2 纵深防御条件写（+ AND type <> \'external\'）' }, // line 8617
];

// ============================================================
// 核心判定——纯函数，供①真实扫描和②变异自证共用
// ============================================================
function evaluateWritersCoverage(fileTexts, registeredPoints, report) {
    const { results: scanned, anomalies } = scanAllFiles(fileTexts);

    // R6〔12a-M2 部分，主会话末次合并审②a〕规则 ID 精确断言——三类断言各分配稳定 ID：
    //   Q1 = 双向相等（missingInRegistry ∪ missingInScan，两个方向同属"集合不相等"这一条规则）
    //   Q2 = 指纹/操作类型内容匹配（同身份键但内容被静默改动）
    //   Q3 = 异常（扫描到疑似字符串拼接构造 SQL、无法提取字面量边界）
    // ID 标注前缀 `[Qx]` 与 ok(m, cond, d) 的第一个参数 m 拼接，供变异自证用 ruleIdsOfG4() 精确
    // 核对"这组变异应该且只应该命中哪条规则"（见 f/g/h 变异）。
    report('[Q3] 扫描无法提取字符串边界的异常写法数 = 0（未发现疑似字符串拼接构造 SQL）', anomalies.length === 0,
        anomalies.length ? anomalies.join(' | ') : '');

    const scannedMap = new Map(scanned.map((s) => [keyOf(s), s]));
    const registeredMap = new Map(registeredPoints.map((r) => [keyOf(r), r]));

    const missingInRegistry = [...scannedMap.keys()].filter((k) => !registeredMap.has(k));
    report('[Q1] 扫描到的每一处直写都已登记（无"扫到但未登记"）', missingInRegistry.length === 0,
        missingInRegistry.length ? missingInRegistry.join(' | ') : '');

    const missingInScan = [...registeredMap.keys()].filter((k) => !scannedMap.has(k));
    report('[Q1] 登记的每一处都能在当前代码里扫到（无"登记但代码已被删除/挪走却未同步"）', missingInScan.length === 0,
        missingInScan.length ? missingInScan.join(' | ') : '');

    const contentMismatch = [];
    for (const k of scannedMap.keys()) {
        if (!registeredMap.has(k)) continue;
        const s = scannedMap.get(k), r = registeredMap.get(k);
        if (s.op !== r.op || s.fingerprint !== r.fingerprint) {
            contentMismatch.push(`${k}: 扫描{op=${s.op},fp=${s.fingerprint}} vs 登记{op=${r.op},fp=${r.fingerprint}}`);
        }
    }
    report('[Q2] 同身份键的操作类型/SQL 指纹逐一匹配（无被静默改动的语句）', contentMismatch.length === 0,
        contentMismatch.length ? contentMismatch.join(' | ') : '');

    return { scanned, anomalies, missingInRegistry, missingInScan, contentMismatch };
}

// ============================================================
// main
// ============================================================
function readAllScanFileTexts() {
    const files = collectScanFiles();
    const texts = {};
    for (const f of files) texts[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return texts;
}

function main() {
    console.log('=== G4：db_connections 语句级直写清单静态守卫（C3，D21）===');

    const realFileTexts = readAllScanFileTexts();
    console.log(`扫描文件数：${Object.keys(realFileTexts).length}（仓根全量递归 .js/.cjs/.mjs，排除 ${EXCLUDED_DIRS.join(' / ')} + 守卫自身）`);

    if (process.argv.includes('--dump')) {
        // 开发期一次性用法：打印真实扫描结果（file/scope/ordinal/op/fingerprint/line），供人工核对
        // 后固化进 REGISTERED_WRITE_POINTS——不是本脚本的常规运行路径。
        const { results, anomalies } = scanAllFiles(realFileTexts);
        for (const r of results) {
            console.log(`{ file: '${r.file}', scope: '${r.scope}', ordinal: ${r.ordinal}, op: '${r.op}', fingerprint: '${r.fingerprint}' }, // line ${r.line}`);
        }
        if (anomalies.length) { console.log('异常：'); anomalies.forEach((a) => console.log('  ' + a)); }
        console.log(`共 ${results.length} 条，${anomalies.length} 处异常`);
        return;
    }

    console.log('\n--- ① 登记表 vs 真实扫描 ---');
    evaluateWritersCoverage(realFileTexts, REGISTERED_WRITE_POINTS, ok);

    console.log('\n--- ② 变异自证 ---');

    // a) 对照组：真实文件原文不变 → 应全绿（已在①验证过，这里再跑一次确认"评估函数本身"在
    //    "真实输入"下判绿，为下面几组变异的"判红"提供基线对照）
    {
        let localPass = 0, localFail = 0;
        const collect = (m, cond) => (cond ? localPass++ : localFail++);
        evaluateWritersCoverage(realFileTexts, REGISTERED_WRITE_POINTS, collect);
        ok('★a) 对照组：真实文件原文（未变异）→ 全绿', localFail === 0, `fail=${localFail}`);
    }

    // b) server.js 内存中临时新增一处直写（INSERT）→ 应判红（多出一条未登记的扫描结果）
    {
        const marker = "\nconst __G4_MUTATION_PROBE__ = 'x'; db.run(`INSERT INTO db_connections (name) VALUES ('probe')`);\n";
        const mutated = { ...realFileTexts, 'server.js': realFileTexts['server.js'] + marker };
        let localFail = 0;
        evaluateWritersCoverage(mutated, REGISTERED_WRITE_POINTS, (m, cond) => { if (!cond) localFail++; });
        ok('★b) server.js 内存新增一处直写 INSERT → 判红（坏法：新增写点未被扫描到/未被判"未登记"）', localFail > 0, `fail=${localFail}`);
    }

    // c) 种子脚本内存中临时新增一处直写（UPDATE）→ 应判红
    {
        const marker = "\nfunction __g4MutationProbe__() { return db.run(`UPDATE db_connections SET name = 'probe' WHERE id = 1`); }\n";
        const seedFile = 'scripts/_seed-collab-external-source.js';
        const mutated = { ...realFileTexts, [seedFile]: realFileTexts[seedFile] + marker };
        let localFail = 0;
        evaluateWritersCoverage(mutated, REGISTERED_WRITE_POINTS, (m, cond) => { if (!cond) localFail++; });
        ok('★c) 种子脚本内存新增一处直写 UPDATE → 判红', localFail > 0, `fail=${localFail}`);
    }

    // d) G2（测试脚本）内存中临时新增一处直写（DELETE）→ 应判红
    {
        const marker = "\nfunction __g4MutationProbe__() { return tdbRun(`DELETE FROM db_connections WHERE id = 999999`); }\n";
        const g2File = 'scripts/verify-collab-external-source.js';
        const mutated = { ...realFileTexts, [g2File]: realFileTexts[g2File] + marker };
        let localFail = 0;
        evaluateWritersCoverage(mutated, REGISTERED_WRITE_POINTS, (m, cond) => { if (!cond) localFail++; });
        ok('★d) G2 测试脚本内存新增一处直写 DELETE → 判红', localFail > 0, `fail=${localFail}`);
    }

    // e) 改动已登记语句的列清单（指纹变）→ 判红：把种子脚本 INSERT 语句的列清单动一个字（去掉
    //    一列），身份键（file|scope|ordinal）不变，但指纹应变化，判"内容不匹配"。
    {
        const seedFile = 'scripts/_seed-collab-external-source.js';
        const original = 'INSERT INTO db_connections (name, type, host, port, database, default_schema, username, password, is_default, connection_type, source_system_code)';
        const mutatedText = 'INSERT INTO db_connections (name, type, host, port, database, default_schema, username, password, is_default, connection_type)'; // 去掉 source_system_code 一列
        const srcText = realFileTexts[seedFile];
        ok('★e) 自检：种子脚本原文含预期的 INSERT 列清单写法（前置条件）', srcText.includes(original));
        if (srcText.includes(original)) {
            const mutated = { ...realFileTexts, [seedFile]: srcText.split(original).join(mutatedText) };
            let localFail = 0, localMismatch = [];
            evaluateWritersCoverage(mutated, REGISTERED_WRITE_POINTS, (m, cond, d) => { if (!cond) { localFail++; if (/指纹/.test(m)) localMismatch.push(d); } });
            ok('★e) 改动已登记语句的列清单（去掉一列，指纹变）→ 判红（身份键不变但内容不匹配）', localFail > 0 && localMismatch.length > 0, `fail=${localFail} mismatch=${JSON.stringify(localMismatch)}`);
        }
    }

    // f/g/h)〔R2·Opus 预筛，精确断言=R6·12a-M2〕STMT_RE 扩四类形态后的专属回归——分别验证
    //    REPLACE INTO / UPDATE OR 子句 / 引号包裹表名三种此前会被漏扫的写法，注入后均应被扫描到
    //    （判"未登记"红），证明扩容后的正则确实覆盖了这三类，不是只在理论上扩了字符类却实际扫
    //    不到。三组都只应命中 [Q1]（双向相等——新写点未登记）：不应连带触发 [Q2]（这是全新身份键，
    //    根本不存在同键可比较内容）或 [Q3]（三种注入文本的字符串边界均可正常提取，不构成异常）。
    {
        const marker = "\nfunction __g4MutationProbeF__() { return db.run(`REPLACE INTO db_connections (id, name) VALUES (1, 'probe')`); }\n";
        const mutated = { ...realFileTexts, 'server.js': realFileTexts['server.js'] + marker };
        const { problems, failedRuleIds } = collectWritersProblems(mutated, REGISTERED_WRITE_POINTS);
        ok('★f) 内存注入 REPLACE INTO db_connections → 判红（R2：REPLACE 关键字此前不在扫描面内）', problems.length > 0, `fail=${problems.length}`);
        ok(`★f) 精确断言：仅 [Q1] 判红（实得 IDs={${[...failedRuleIds].join(', ')}}）`, idsExactlyG4(failedRuleIds, ['Q1']));
    }
    {
        const marker = "\nfunction __g4MutationProbeG__() { return db.run(`UPDATE OR IGNORE db_connections SET name = 'probe' WHERE id = 1`); }\n";
        const mutated = { ...realFileTexts, 'server.js': realFileTexts['server.js'] + marker };
        const { problems, failedRuleIds } = collectWritersProblems(mutated, REGISTERED_WRITE_POINTS);
        ok('★g) 内存注入 UPDATE OR IGNORE db_connections → 判红（R2：UPDATE 后带 OR 子句、无 INTO 分隔此前不在扫描面内）', problems.length > 0, `fail=${problems.length}`);
        ok(`★g) 精确断言：仅 [Q1] 判红（实得 IDs={${[...failedRuleIds].join(', ')}}）`, idsExactlyG4(failedRuleIds, ['Q1']));
    }
    {
        const marker = "\nfunction __g4MutationProbeH__() { return db.run(`INSERT INTO \"db_connections\" (id, name) VALUES (1, 'probe')`); }\n";
        const mutated = { ...realFileTexts, 'server.js': realFileTexts['server.js'] + marker };
        const { problems, failedRuleIds } = collectWritersProblems(mutated, REGISTERED_WRITE_POINTS);
        ok('★h) 内存注入 INSERT INTO "db_connections"（双引号包裹表名）→ 判红（R2：引号/方括号/反引号包裹表名此前不在扫描面内）', problems.length > 0, `fail=${problems.length}`);
        ok(`★h) 精确断言：仅 [Q1] 判红（实得 IDs={${[...failedRuleIds].join(', ')}}）`, idsExactlyG4(failedRuleIds, ['Q1']));
    }

    console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 ===`);
    process.exit(fail === 0 ? 0 : 1);
}

main();
