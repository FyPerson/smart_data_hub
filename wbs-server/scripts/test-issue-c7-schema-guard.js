/**
 * v1.74.0 C7 — T1 schema 重建硬门槛判定单测（纯函数，零 server 依赖）
 *
 * 用法：node scripts/test-issue-c7-schema-guard.js（无需 server / 无需 db）
 *
 * 背景：C1 schema 重建前置硬门槛（server.js:1230-1244）——
 *   对 ISSUE_TABLES 四表逐表 COUNT(*)，任一表「有数据」(c>0) 或「计数遇未知错误」(c<0)
 *   都拒绝 DROP 重建，并把错误标记写入 ISSUE_SCHEMA_STATE.error（endpoint 据此返 503）。
 *   全部 0 行才安全放行重建。
 *
 * 为何复刻而非 require（用户 2026-06-01 拍板）：
 *   门槛判定逻辑（unknownErr=some(c<0) / hasData=some(c>0)）当前内联在 C1 启动 IIFE 的
 *   局部作用域里（countIssueTable/ISSUE_TABLES 均为函数内局部变量，无法 require）。
 *   抽成可 export 的纯函数要改已上线就绪、codex 06/07 审过的 C1 启动闸门代码——为测试动
 *   已验证生产逻辑不划算。判定本质是两个一行表达式，复刻到此处对三态直接断言，零风险不碰 C1。
 *   ⚠️ 维护约束：本函数是 server.js:1231-1244 的镜像，C1 门槛逻辑若变更，须同步本文件
 *   （但门槛语义已冻结，预期不会动）。
 *
 * ⚠️ 安全约束（踩坑预防）：本测试**绝不**在主 server 上造含数据的 issues 表触发硬门槛——
 *   那正是「测试残留污染 4 表 → 503」的踩坑场景。纯函数对内存数组断言，不碰任何 db / server。
 */
'use strict';

const ISSUE_TABLES = ['issues', 'issue_comments', 'issue_attachments', 'issue_status_history'];

/**
 * 复刻 server.js:1231-1244 的硬门槛判定（纯函数）。
 * @param {number[]} counts  四表 COUNT(*) 结果（与 ISSUE_TABLES 同序）；表不存在/计数失败约定为 -1（对齐 countIssueTable resolve(-1)）
 * @returns {{ action: 'rebuild'|'abort', reason: 'ok'|'hasData'|'unknownErr', error: string|null }}
 */
function evaluateSchemaGuard(counts) {
    const unknownErr = counts.some(c => c < 0);
    const hasData = counts.some(c => c > 0);

    if (unknownErr || hasData) {
        const detail = ISSUE_TABLES.map((t, i) => `${t}=${counts[i] < 0 ? 'ERR' : counts[i]}`).join(' / ');
        const error = unknownErr
            ? `需求跟踪 schema 计数遇未知错误，拒绝重建（${detail}）`
            : `需求跟踪目标表非空，拒绝 DROP 重建（${detail}）`;
        // unknownErr 优先级高于 hasData（与 server.js 三元判定一致：先看 unknownErr）
        return { action: 'abort', reason: unknownErr ? 'unknownErr' : 'hasData', error };
    }
    return { action: 'rebuild', reason: 'ok', error: null };
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; } }
function must(cond, msg) { if (!cond) throw new Error(msg); }

function main() {
    console.log('\n══════ v1.74.0 C7 T1 schema 硬门槛判定单测（纯函数）══════');

    check('G1 全 0 行 [0,0,0,0] → 放行重建（rebuild / ok / error=null）', () => {
        const r = evaluateSchemaGuard([0, 0, 0, 0]);
        must(r.action === 'rebuild', `应放行，实际 ${r.action}`);
        must(r.reason === 'ok', `reason 应 ok，实际 ${r.reason}`);
        must(r.error === null, 'error 应 null');
    });

    check('G2 issues 表有数据 [1,0,0,0] → 中止（abort / hasData）', () => {
        const r = evaluateSchemaGuard([1, 0, 0, 0]);
        must(r.action === 'abort', `有数据应中止，实际 ${r.action}`);
        must(r.reason === 'hasData', `reason 应 hasData，实际 ${r.reason}`);
        must(/目标表非空，拒绝 DROP 重建/.test(r.error), `error 文案应含"目标表非空"，实际 "${r.error}"`);
        must(/issues=1/.test(r.error), 'error detail 应含 issues=1');
    });

    check('G3 子表（非首表）有数据 [0,0,3,0] → 中止（some 命中任一表）', () => {
        const r = evaluateSchemaGuard([0, 0, 3, 0]);
        must(r.action === 'abort' && r.reason === 'hasData', `任一表非空都应中止，实际 ${r.action}/${r.reason}`);
        must(/issue_attachments=3/.test(r.error), 'error detail 应含 issue_attachments=3');
    });

    check('G4 计数遇未知错误 [-1,0,0,0] → 中止（abort / unknownErr）', () => {
        const r = evaluateSchemaGuard([-1, 0, 0, 0]);
        must(r.action === 'abort', `未知错误应中止，实际 ${r.action}`);
        must(r.reason === 'unknownErr', `reason 应 unknownErr，实际 ${r.reason}`);
        must(/计数遇未知错误，拒绝重建/.test(r.error), `error 文案应含"计数遇未知错误"，实际 "${r.error}"`);
        must(/issues=ERR/.test(r.error), 'error detail 应把 -1 渲染为 ERR');
    });

    check('G5 unknownErr 优先于 hasData [-1,2,0,0] → reason=unknownErr（与 server 三元一致）', () => {
        // 既有未知错误又有数据时，server.js 三元先判 unknownErr → 文案走"未知错误"分支
        const r = evaluateSchemaGuard([-1, 2, 0, 0]);
        must(r.action === 'abort', '应中止');
        must(r.reason === 'unknownErr', `unknownErr 应优先，实际 ${r.reason}`);
        must(/计数遇未知错误/.test(r.error), 'error 应走未知错误文案（非"目标表非空"）');
    });

    check('G6 detail 渲染完整四表（[2,0,-1,5]）→ 每表都列出 + ERR 标记', () => {
        const r = evaluateSchemaGuard([2, 0, -1, 5]);
        must(r.reason === 'unknownErr', '含 -1 应判 unknownErr');
        must(/issues=2/.test(r.error), 'issues=2');
        must(/issue_comments=0/.test(r.error), 'issue_comments=0');
        must(/issue_attachments=ERR/.test(r.error), 'issue_attachments=ERR（-1→ERR）');
        must(/issue_status_history=5/.test(r.error), 'issue_status_history=5');
    });

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C7 T1 硬门槛判定单测全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}

main();
