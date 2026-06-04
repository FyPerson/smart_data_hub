/**
 * v1.75.0 commit B — C2 改人守卫分流判定 + v1.75.0 schema readiness 判定（纯函数镜像，零 server 依赖）
 *
 * 用法：node scripts/test-issue-v1750-c2-branch.js（无需 server / 无需 db）
 *
 * 背景：
 *   C2 改人守卫（server.js PUT /api/issues/:id/assign）按"是否改派 + 是否已通知"分流：
 *     - needResetGuard = isReassign(原负责人非空) && wasNotified(notify_status==='sent')
 *     - true  → 重置链路（重置开发侧 notify_* + 清 pending + 写 is_system 系统评论，同一事务）
 *     - false → 现有 pending_reassign 写入逻辑不动（首派 / 改派但未通知）
 *   方案四象限"取消指派 / 空转"在 endpoint 层被 400 拦截不可达，本脚本只覆盖 3 个可达分支。
 *
 *   v1.75.0 schema readiness（server.js runIssueV1750Migration）：ALTER 后 PRAGMA 复查两表新列全到位才 ready。
 *
 * 为何复刻而非 require（对齐 C7 schema-guard 范式，用户 2026-06-01 拍板）：判定逻辑内联在 endpoint /
 *   migration 局部作用域，无法 require。⚠️ 维护约束：server.js 对应逻辑变更须同步本文件。
 */
'use strict';

const ISSUE_V1750_ISSUES_COLS = ['dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at', 'dingtalk_chat_created_by', 'dingtalk_chat_name'];
const ISSUE_V1750_COMMENTS_COLS = ['is_system'];

/**
 * 镜像 C2 分流判定（server.js assign endpoint，codex 39 H-1/M-1/L-1 修订后）。
 * 修订要点：
 *   - L-1：hasRealAssignee = Number(oldAssignedTo) > 0（排除 NULL/0 占位，0 非合法 user_id）
 *   - 未变判定用 hasRealAssignee 口径（避免 0 占位被当"已指派"误判幂等）
 *   - needResetGuard 只看 wasNotified（已通知 + 负责人将变 → 必重置）：
 *       hasRealAssignee 时是正常"通知后改人"；!hasRealAssignee 时是脏状态（空/0 却 sent，§8 兜底纳入重置）
 * @param {number|null} oldAssignedTo 原负责人 user_id（null/0/'' 视为未指派）
 * @param {string} notifyStatus 当前 notify_status（'not_sent'|'sent'|'failed'）
 * @param {number} newAssignedTo 新负责人 user_id
 * @returns {{ branch:'unchanged'|'reset'|'pending', needResetGuard:boolean, dirty:boolean }}
 */
function evaluateC2Branch(oldAssignedTo, notifyStatus, newAssignedTo) {
    const hasRealAssignee = Number(oldAssignedTo) > 0;   // L-1：排除 NULL/0 占位
    // ③ 未变（真实负责人 + 相同 id）→ 幂等
    if (hasRealAssignee && Number(oldAssignedTo) === Number(newAssignedTo)) {
        return { branch: 'unchanged', needResetGuard: false, dirty: false };
    }
    const wasNotified = notifyStatus === 'sent';         // 已成功通知开发过
    const needResetGuard = wasNotified;                  // 已通知 + 负责人将变 → 必重置（含脏状态兜底）
    const dirty = !hasRealAssignee && wasNotified;       // 脏状态：无真实负责人却已通知
    return { branch: needResetGuard ? 'reset' : 'pending', needResetGuard, dirty };
}

/**
 * 镜像 v1.75.0 migration readiness 判定（server.js runIssueV1750Migration 的 PRAGMA 复查段）。
 * @param {string[]|null} issuesCols issues 表实际列；null=读列失败
 * @param {string[]|null} commentsCols issue_comments 表实际列；null=读列失败
 * @returns {{ ready:boolean, missIssues:string[], missComments:string[] }}
 */
function evaluateV1750Readiness(issuesCols, commentsCols) {
    const missIssues = issuesCols === null ? ['<读列失败>'] : ISSUE_V1750_ISSUES_COLS.filter(c => !issuesCols.includes(c));
    const missComments = commentsCols === null ? ['<读列失败>'] : ISSUE_V1750_COMMENTS_COLS.filter(c => !commentsCols.includes(c));
    const ready = missIssues.length === 0 && missComments.length === 0;
    return { ready, missIssues, missComments };
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; } }
function must(cond, msg) { if (!cond) throw new Error(msg); }

function main() {
    console.log('\n══════ v1.75.0 commit B — C2 分流 + readiness 判定（纯函数镜像）══════');

    console.log('\n【C2 改人守卫分流】');
    check('B1 首派 null→5（notify=not_sent）→ pending 分支，不重置', () => {
        const r = evaluateC2Branch(null, 'not_sent', 5);
        must(r.branch === 'pending', `首派应走 pending 分支，实际 ${r.branch}`);
        must(r.needResetGuard === false, '首派不应触发重置');
    });

    check('B2 改派 3→5 + 已通知（notify=sent）→ reset 分支【守卫核心】', () => {
        const r = evaluateC2Branch(3, 'sent', 5);
        must(r.branch === 'reset', `已通知后改派应走 reset 分支，实际 ${r.branch}`);
        must(r.needResetGuard === true, '已通知后改派应触发重置');
    });

    check('B3 改派 3→5 + 未通知（notify=not_sent）→ pending 分支，不重置', () => {
        const r = evaluateC2Branch(3, 'not_sent', 5);
        must(r.branch === 'pending', `未通知改派应走 pending（维持现有 notify-reassign 链路），实际 ${r.branch}`);
        must(r.needResetGuard === false, '未通知改派不应重置（pending 锚点照常给 notify-reassign）');
    });

    check('B4 改派 3→5 + 通知失败（notify=failed）→ pending 分支，不重置', () => {
        const r = evaluateC2Branch(3, 'failed', 5);
        must(r.branch === 'pending', `failed（未成功通知）应走 pending，实际 ${r.branch}`);
        must(r.needResetGuard === false, 'failed 非 sent，不触发重置');
    });

    check('B5 未变 5→5（即使 notify=sent）→ unchanged 幂等，不重置', () => {
        const r = evaluateC2Branch(5, 'sent', 5);
        must(r.branch === 'unchanged', `相同 id 应幂等 unchanged，实际 ${r.branch}`);
        must(r.needResetGuard === false, '未变不触发任何重置');
        must(r.dirty === false, '未变非脏状态');
    });

    // ── codex 39 M-1/L-1：脏状态兜底用例 ──
    check('B6【脏状态·M-1】oldAssignedTo=null + notify=sent → reset 兜底（无真实负责人却已通知）', () => {
        const r = evaluateC2Branch(null, 'sent', 5);
        must(r.branch === 'reset', `脏状态(空+sent)应纳入 reset 兜底清理，实际 ${r.branch}`);
        must(r.needResetGuard === true && r.dirty === true, '应标记 dirty 并触发重置');
    });

    check('B7【脏状态·L-1】oldAssignedTo=0 占位 + notify=sent → reset 兜底（0 非真实负责人）', () => {
        const r = evaluateC2Branch(0, 'sent', 5);
        must(r.branch === 'reset', `0 占位+sent 属脏状态应 reset 兜底，实际 ${r.branch}`);
        must(r.dirty === true, '0 占位无真实负责人 + sent = 脏状态');
    });

    check('B8 oldAssignedTo=0 占位 + notify=not_sent → pending（无脏，首派语义）', () => {
        const r = evaluateC2Branch(0, 'not_sent', 5);
        must(r.branch === 'pending', `0 占位未通知 → 首派 pending，实际 ${r.branch}`);
        must(r.needResetGuard === false && r.dirty === false, '未通知不重置、非脏');
    });

    check('B9 oldAssignedTo=null + notify=not_sent → pending（正常首派）', () => {
        const r = evaluateC2Branch(null, 'not_sent', 5);
        must(r.branch === 'pending' && r.dirty === false, '正常首派 pending 非脏');
    });

    console.log('\n【v1.75.0 schema readiness】');
    const FULL_ISSUES = ['id', 'title', ...ISSUE_V1750_ISSUES_COLS, 'status'];
    const FULL_COMMENTS = ['id', 'issue_id', 'content', ...ISSUE_V1750_COMMENTS_COLS];

    check('R1 两表新列全到位 → ready=true', () => {
        const r = evaluateV1750Readiness(FULL_ISSUES, FULL_COMMENTS);
        must(r.ready === true, `列全应 ready，实际 ${r.ready}`);
        must(r.missIssues.length === 0 && r.missComments.length === 0, '不应有缺列');
    });

    check('R2 issues 缺 1 列（dingtalk_chat_name）→ ready=false，只报缺的', () => {
        const partial = FULL_ISSUES.filter(c => c !== 'dingtalk_chat_name');
        const r = evaluateV1750Readiness(partial, FULL_COMMENTS);
        must(r.ready === false, '缺列应 not ready');
        must(r.missIssues.length === 1 && r.missIssues[0] === 'dingtalk_chat_name', `应只报 dingtalk_chat_name，实际 ${r.missIssues.join(',')}`);
        must(r.missComments.length === 0, 'comments 不应缺列');
    });

    check('R3 issue_comments 缺 is_system → ready=false', () => {
        const r = evaluateV1750Readiness(FULL_ISSUES, ['id', 'issue_id', 'content']);
        must(r.ready === false, 'comments 缺 is_system 应 not ready');
        must(r.missComments.length === 1 && r.missComments[0] === 'is_system', `应报 is_system，实际 ${r.missComments.join(',')}`);
    });

    check('R4 issues 读列失败（null）→ ready=false，标 <读列失败>', () => {
        const r = evaluateV1750Readiness(null, FULL_COMMENTS);
        must(r.ready === false, '读列失败应 not ready');
        must(r.missIssues[0] === '<读列失败>', '应标记读列失败');
    });

    check('R5 两表都缺多列 → ready=false，分别列出', () => {
        const r = evaluateV1750Readiness(['id', 'title'], ['id', 'content']);
        must(r.ready === false, '应 not ready');
        must(r.missIssues.length === ISSUE_V1750_ISSUES_COLS.length, 'issues 应报全部 5 列缺失');
        must(r.missComments.length === 1, 'comments 应报 is_system 缺失');
    });

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 v1.75.0 commit B 分流+readiness 纯函数镜像全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}

main();
