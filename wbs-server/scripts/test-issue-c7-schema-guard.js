/**
 * v1.74.0 C7 — T1 schema 重建硬门槛判定单测（纯函数，零 server 依赖）
 * v1.74.5 更新：新增"表已建好且有数据 → 列校验放行"分支（修生产 503：模块正常使用后首次重启被误判中止）。
 *
 * 用法：node scripts/test-issue-c7-schema-guard.js（无需 server / 无需 db）
 *
 * 背景：C1 schema 重建前置硬门槛（server.js C1 启动 IIFE）——对 ISSUE_TABLES 四表逐表 COUNT(*)：
 *   - 任一表计数遇未知错误 (c<0) → 拒绝重建 + 503（真异常）
 *   - 任一表有数据 (c>0) → 【v1.74.5】校验 issues 表关键列：齐 → 放行（不重建，数据照用）/ 缺 → 503（疑似旧 schema）
 *   - 全部 0 行（或表不存在）→ 安全 DROP 重建
 *
 * 为何复刻而非 require（用户 2026-06-01 拍板）：门槛判定逻辑内联在 C1 启动 IIFE 的局部作用域里，无法 require。
 *   ⚠️ 维护约束：本函数是 server.js C1 门槛逻辑的镜像，C1 逻辑变更须同步本文件。
 *
 * ⚠️ 安全约束：纯函数对内存数组断言，不碰任何 db / server，绝不在主 server 造含数据的 issues 表。
 */
'use strict';

const ISSUE_TABLES = ['issues', 'issue_comments', 'issue_attachments', 'issue_status_history'];
// v1.74.5：与 server.js ISSUE_REQUIRED_COLS 同源——issues 表关键列白名单（缺任一视为旧 schema）
const ISSUE_REQUIRED_COLS = ['raw_requirement', 'data_domain', 'priority_reviewed_at', 'acceptance_url', 'notify_status'];

/**
 * 复刻 server.js C1 门槛判定（纯函数）。
 * @param {number[]} counts  四表 COUNT(*)（与 ISSUE_TABLES 同序）；表不存在/计数失败约定为 -1
 * @param {string[]|null} issueCols  issues 表实际列名数组；null 表示读列失败（仅 hasData 分支用到）
 * @returns {{ action: 'rebuild'|'pass'|'abort', reason: 'ok'|'schemaReady'|'hasData'|'unknownErr'|'missingCols', error: string|null }}
 */
function evaluateSchemaGuard(counts, issueCols) {
    const unknownErr = counts.some(c => c < 0);
    const hasData = counts.some(c => c > 0);
    const detail = ISSUE_TABLES.map((t, i) => `${t}=${counts[i] < 0 ? 'ERR' : counts[i]}`).join(' / ');

    if (unknownErr) {
        return { action: 'abort', reason: 'unknownErr', error: `需求跟踪 schema 计数遇未知错误，拒绝重建（${detail}）` };
    }
    if (hasData) {
        // v1.74.5 核心：表已建好且有数据 → 校验关键列，齐则放行不重建，缺则拒放行（疑似旧 schema）
        const missing = issueCols === null ? ['<读列失败>'] : ISSUE_REQUIRED_COLS.filter(c => !issueCols.includes(c));
        if (missing.length) {
            return { action: 'abort', reason: 'missingCols', error: `需求跟踪 issues 表已有数据但结构不完整（缺列：${missing.join(',')}），需人工迁移后放行（${detail}）` };
        }
        return { action: 'pass', reason: 'schemaReady', error: null };
    }
    return { action: 'rebuild', reason: 'ok', error: null };
}

// 完整列集（模拟 v1.74.x 正确结构，含所有必需列）
const FULL_COLS = ['id', 'title', ...ISSUE_REQUIRED_COLS, 'status', 'created_at'];

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; } }
function must(cond, msg) { if (!cond) throw new Error(msg); }

function main() {
    console.log('\n══════ v1.74.0 C7 T1 schema 硬门槛判定单测（纯函数，v1.74.5 含放行分支）══════');

    check('G1 全 0 行 [0,0,0,0] → 放行重建（rebuild / ok）', () => {
        const r = evaluateSchemaGuard([0, 0, 0, 0], null);
        must(r.action === 'rebuild', `应放行重建，实际 ${r.action}`);
        must(r.reason === 'ok', `reason 应 ok，实际 ${r.reason}`);
        must(r.error === null, 'error 应 null');
    });

    check('G2 有数据 + 列完整 [1,0,0,0] → 放行不重建（pass / schemaReady）【v1.74.5 修复核心】', () => {
        const r = evaluateSchemaGuard([1, 0, 0, 0], FULL_COLS);
        must(r.action === 'pass', `表已建好有数据应放行不重建，实际 ${r.action}（原 bug 在此被误判 abort→503）`);
        must(r.reason === 'schemaReady', `reason 应 schemaReady，实际 ${r.reason}`);
        must(r.error === null, 'error 应 null（放行不报错）');
    });

    check('G2b 子表有数据 + issues 列完整 [0,0,3,0] → 放行不重建', () => {
        const r = evaluateSchemaGuard([0, 0, 3, 0], FULL_COLS);
        must(r.action === 'pass' && r.reason === 'schemaReady', `任一表有数据 + 列全应放行，实际 ${r.action}/${r.reason}`);
    });

    check('G2c 有数据 + 缺关键列 [1,0,0,0] → 中止（abort / missingCols，疑似旧 schema）', () => {
        const oldCols = ['id', 'title', 'status'];  // 缺 raw_requirement/data_domain 等新列
        const r = evaluateSchemaGuard([1, 0, 0, 0], oldCols);
        must(r.action === 'abort', `缺列应中止，实际 ${r.action}`);
        must(r.reason === 'missingCols', `reason 应 missingCols，实际 ${r.reason}`);
        must(/结构不完整/.test(r.error), `error 应含"结构不完整"，实际 "${r.error}"`);
        must(/raw_requirement/.test(r.error), 'error 应列出缺失列 raw_requirement');
    });

    check('G2d 有数据 + 读列失败（cols=null）→ 中止（missingCols / <读列失败>）', () => {
        const r = evaluateSchemaGuard([1, 0, 0, 0], null);
        must(r.action === 'abort' && r.reason === 'missingCols', `读列失败应中止，实际 ${r.action}/${r.reason}`);
        must(/<读列失败>/.test(r.error), 'error 应标记读列失败');
    });

    check('G3 部分必需列缺失 → 只报缺的那几列', () => {
        const partialCols = ['id', 'title', 'raw_requirement', 'data_domain', 'status'];  // 缺 priority_reviewed_at/acceptance_url/notify_status
        const r = evaluateSchemaGuard([5, 0, 0, 0], partialCols);
        must(r.action === 'abort', '缺列应中止');
        must(/priority_reviewed_at/.test(r.error) && /acceptance_url/.test(r.error) && /notify_status/.test(r.error), 'error 应列出全部 3 个缺失列');
        must(!/raw_requirement/.test(r.error.split('缺列：')[1]), '已有的列不应出现在缺列清单');
    });

    check('G4 计数遇未知错误 [-1,0,0,0] → 中止（abort / unknownErr）', () => {
        const r = evaluateSchemaGuard([-1, 0, 0, 0], FULL_COLS);
        must(r.action === 'abort', `未知错误应中止，实际 ${r.action}`);
        must(r.reason === 'unknownErr', `reason 应 unknownErr，实际 ${r.reason}`);
        must(/计数遇未知错误，拒绝重建/.test(r.error), `error 文案应含"计数遇未知错误"`);
        must(/issues=ERR/.test(r.error), 'error detail 应把 -1 渲染为 ERR');
    });

    check('G5 unknownErr 优先于 hasData [-1,2,0,0] → reason=unknownErr（不进列校验分支）', () => {
        const r = evaluateSchemaGuard([-1, 2, 0, 0], FULL_COLS);
        must(r.action === 'abort', '应中止');
        must(r.reason === 'unknownErr', `unknownErr 应优先，实际 ${r.reason}`);
        must(/计数遇未知错误/.test(r.error), 'error 应走未知错误文案');
    });

    check('G6 detail 渲染完整四表（[2,0,-1,5]）→ 每表都列出 + ERR 标记', () => {
        const r = evaluateSchemaGuard([2, 0, -1, 5], FULL_COLS);
        must(r.reason === 'unknownErr', '含 -1 应判 unknownErr');
        must(/issues=2/.test(r.error) && /issue_comments=0/.test(r.error) && /issue_attachments=ERR/.test(r.error) && /issue_status_history=5/.test(r.error), 'detail 应完整渲染四表');
    });

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C7 T1 硬门槛判定单测全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}

main();
