'use strict';

/**
 * 实现对象三端核验的 SQL 定义规范化（#77 C2b-2，方案 v0.9 §4.4，算法版本 norm_v1）。
 *
 * 规范化只在平台做这一处：文档端提交原文、登记端提交原文、生产端读 sys.sql_modules 定义，三者都经本函数后求哈希。
 * 六步（与方案原文一一对应）：
 *   1. 去掉开头的 BOM（U+FEFF）；
 *   2. CRLF 与单独的 CR 统一为 LF；
 *   3. 每行去掉行尾空白（空格与制表符）；
 *   4. 去掉开头与结尾的空行；
 *   5. 只改对象头：跳过开头的注释（连续的 -- 行注释与块注释，及其间空白），在第一个非注释位置，
 *      若匹配 CREATE OR ALTER 或 CREATE，且其后紧跟 PROCEDURE|PROC|VIEW|TRIGGER|FUNCTION，
 *      把这段前缀替换为 `CREATE ` + 该关键字的大写形式。正文（含正文里的 CREATE 字样、字符串、注释）一律不动，也不做大小写归一；
 *   6. 对结果按 UTF-8 求 SHA-256，小写十六进制。
 *
 * 纯函数、无 IO。
 */

const crypto = require('crypto');

const ALGO = 'norm_v1';
const BOM = String.fromCharCode(0xFEFF);

// 对象头：CREATE [OR ALTER] 之后紧跟的关键字（PROCEDURE 排在 PROC 前，\b 保证不吃进标识符）
const HEADER_RE = /CREATE\s+(?:OR\s+ALTER\s+)?(PROCEDURE|PROC|VIEW|TRIGGER|FUNCTION)\b/iy;

/** 跳过开头的注释与空白，返回第一个非注释位置；块注释未闭合时返回 -1（不改头，原样处理） */
function skipLeadingComments(text) {
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
        if (text.startsWith('--', i)) {
            const nl = text.indexOf('\n', i);
            if (nl < 0) return n;
            i = nl + 1;
            continue;
        }
        if (text.startsWith('/*', i)) {
            // SQL Server 的块注释可以嵌套：按嵌套深度计数，深度回到 0 才算结束
            let depth = 1;
            let j = i + 2;
            while (j < n && depth > 0) {
                if (text.startsWith('/*', j)) { depth++; j += 2; } else if (text.startsWith('*/', j)) { depth--; j += 2; } else j++;
            }
            if (depth > 0) return -1;
            i = j;
            continue;
        }
        break;
    }
    return i;
}

/**
 * @param {string} text 定义原文
 * @returns {{ normalized: string, hash: string }} hash 为小写十六进制 SHA-256（对 normalized 的 UTF-8 字节）
 */
function normalizeSqlDefinition(text) {
    if (typeof text !== 'string') throw new TypeError('normalizeSqlDefinition：入参必须是字符串');
    let s = text;
    if (s.startsWith(BOM)) s = s.slice(1);                                   // 1
    s = s.replace(/\r\n?/g, '\n');                                           // 2
    const lines = s.split('\n').map((l) => l.replace(/[ \t]+$/, ''));        // 3
    let a = 0;
    let b = lines.length;
    while (a < b && lines[a] === '') a++;                                    // 4
    while (b > a && lines[b - 1] === '') b--;
    s = lines.slice(a, b).join('\n');
    const p = skipLeadingComments(s);                                        // 5
    if (p >= 0 && p < s.length) {
        HEADER_RE.lastIndex = p;
        const m = HEADER_RE.exec(s);
        if (m) s = s.slice(0, p) + 'CREATE ' + m[1].toUpperCase() + s.slice(p + m[0].length);
    }
    const hash = crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');   // 6
    return { normalized: s, hash };
}

/**
 * 文档 / 登记源码提交的批次检查（方案 §4.4「文档端约定」）：出现独占一行的 GO（不区分大小写、行首尾空白不计）即命中。
 * 这是有意的保守规则：按行判断，不做词法分析。返回命中的行号（从 1 起）或 0。
 */
// 空白 = 空格 / 制表符 / NBSP（U+00A0，用码点构造，不在源码里写转义）。命中形态（保守）：GO、GO 5（带计数）、GO;、GO -- 注释、GO /* 注释；
// 不命中：GOTO、--GO、GO_x、GOx（go 后面必须是空白 / 数字计数 / 分号 / 注释起点 / 行尾）。
const WS = '[ \\t' + String.fromCharCode(0xA0) + ']';
const GO_LINE_RE = new RegExp('^' + WS + '*go(?:' + WS + '+\\d+)?' + WS + '*;?' + WS + '*(?:(?:--|\\/\\*).*)?$', 'i');
function findGoSeparatorLine(text) {
    const lines = String(text).split(/\r\n?|\n/);
    for (let i = 0; i < lines.length; i++) {
        if (GO_LINE_RE.test(lines[i])) return i + 1;
    }
    return 0;
}

const GO_REJECT_MESSAGE = '只提交对象所在批次；注释或字符串里也不能有单独一行的 GO';

module.exports = { normalizeSqlDefinition, findGoSeparatorLine, GO_REJECT_MESSAGE, ALGO };
