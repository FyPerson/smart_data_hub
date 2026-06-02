/**
 * v1.74.1 L-1 — 业务方完成通知"完成确认人"显示真正关闭人，验证脚本（纯函数单测）
 *
 * 背景：issues 表无 closed_by 列，buildIssueCompletedMarkdownForRequester 的 fallback 链是
 *   `closed_by_name || created_by_name || '管理员'`。修复前 endpoint 传给 builder 的 issue 永远
 *   没有 closed_by_name → 永远落到 created_by_name（录入人），"管理员"分支是死分支。
 *
 * 修复（server.js notify-requester-done endpoint）：调 builder 前查 issue_status_history 最后一条
 *   to_status='已关闭' 的 operator_name 注入 issue.closed_by_name，builder 一行不改。
 *
 * 本脚本验证 builder 层 fallback 行为（零依赖纯函数，不起 server、不碰 DB）——
 *   证明"endpoint 一旦注入 closed_by_name，渲染出的就是关闭人；不注入则 fallback 录入人；
 *   两者都缺才到管理员"。endpoint 的查询注入逻辑由 code-review + 浏览器实测覆盖。
 *
 * 运行：node scripts/test-issue-v1741-completed-builder.js
 */
'use strict';

const issueNotify = require('../utils/issue-notify');

let exitCode = 0;
const results = [];

function assert(cond, name, detail) {
    if (cond) results.push(`✅ ${name}`);
    else { results.push(`❌ ${name}${detail ? ' — ' + detail : ''}`); exitCode = 1; }
}

// 抽取 markdown 里"完成确认：XXX"那一行的人名
function extractConfirmer(md) {
    const m = md.match(/完成确认：(.+)/);
    return m ? m[1].trim() : null;
}

const baseIssue = {
    id: 101,
    title: '客户合同金额口径修复',
    type: '数据质量',
    requester_dept: '市场营销部',
    requester_name: '示例用户A',
    acceptance_url: '',          // 无链接，聚焦确认人逻辑
    created_by_name: '录入人小李',
};

// ── T1：注入 closed_by_name（endpoint 查到真正关闭人）→ 显示关闭人，不是录入人 ──
{
    const issue = { ...baseIssue, closed_by_name: '关闭人老张' };
    const md = issueNotify.buildIssueCompletedMarkdownForRequester(issue);
    const who = extractConfirmer(md);
    assert(who === '关闭人老张', 'T1 注入 closed_by_name → 完成确认显示关闭人', `实际「${who}」`);
    assert(who !== '录入人小李', 'T1b 关闭人 ≠ 录入人（L-1 核心：不再串台）', `实际「${who}」`);
}

// ── T2：未注入 closed_by_name（history 缺失，如旧数据/直接 SQL 改状态）→ fallback 录入人 ──
{
    const issue = { ...baseIssue };  // 不带 closed_by_name
    const md = issueNotify.buildIssueCompletedMarkdownForRequester(issue);
    const who = extractConfirmer(md);
    assert(who === '录入人小李', 'T2 无 closed_by_name → fallback 录入人（兼容旧数据不报错）', `实际「${who}」`);
}

// ── T3：closed_by_name 与 created_by_name 都缺 → 兜底"管理员"（修复后此分支才真正可达）──
{
    const issue = { ...baseIssue, created_by_name: '' };  // 两者都空
    const md = issueNotify.buildIssueCompletedMarkdownForRequester(issue);
    const who = extractConfirmer(md);
    assert(who === '管理员', 'T3 两者皆空 → 兜底"管理员"', `实际「${who}」`);
}

// ── T4：closed_by_name 为空串 → 视为缺失，fallback 录入人（|| 对空串成立）──
{
    const issue = { ...baseIssue, closed_by_name: '' };
    const md = issueNotify.buildIssueCompletedMarkdownForRequester(issue);
    const who = extractConfirmer(md);
    assert(who === '录入人小李', 'T4 closed_by_name 空串 → fallback 录入人', `实际「${who}」`);
}

// ── T5：安全回归——closed_by_name 含 markdown 特殊字符须经 issueSafeText 转义（不破坏渲染/注入）──
{
    const issue = { ...baseIssue, closed_by_name: '老*张_[x]' };
    const md = issueNotify.buildIssueCompletedMarkdownForRequester(issue);
    // 原始未转义的 [x]( 之类不应原样出现；至少验证渲染未抛错且该行存在
    assert(/完成确认：/.test(md), 'T5 含特殊字符的关闭人名渲染不抛错', md.slice(0, 80));
    assert(!md.includes('完成确认：老*张_[x]') || md.includes('\\'),
        'T5b 特殊字符经 issueSafeText 处理（非原样裸出）');
}

// ── 输出 ──
console.log('\n══════ v1.74.1 L-1 完成通知确认人 builder 单测 ══════');
results.forEach(r => console.log('  ' + r));
const pass = results.filter(r => r.startsWith('✅')).length;
const fail = results.filter(r => r.startsWith('❌')).length;
console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
console.log(exitCode === 0 ? '  🎉 L-1 builder fallback 全部通过\n' : '  🚫 存在失败项\n');
process.exit(exitCode);
