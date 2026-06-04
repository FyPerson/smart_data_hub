/**
 * v1.75.0 commit C — C4 create-chat 纯决策逻辑镜像（零 server / 零 db / 零钉钉）
 *
 * 用法：node scripts/test-issue-v1750-c4-chat-logic.js
 *
 * 覆盖 endpoint 中不依赖外部的纯函数决策（钉钉真连/前置校验路径走进程内 e2e + 真机）：
 *   P  权限判定：admin/publisher 任意单 / user 仅本单 assigned_to|created_by / viewer 已被中间件挡
 *   N  群名裁剪：[需求]{title}-讨论，Unicode 码点 ≤20 截断（中文/emoji 不截半）
 *   M  最小成群：去重后真实钉钉号 < 2 → 不可建群
 *   D  业务方降级判定：requester_phone 空/非法/反查未命中 → requester_degraded
 *
 * ⚠️ 维护约束：本镜像复刻 server.js create-chat endpoint 的纯决策段，endpoint 变更须同步本文件。
 */
'use strict';

const COLLAB_CHAT_ADMIN_ID = 3;

// 镜像权限判定（server.js create-chat：admin/publisher 任意 / user 本单关系 / viewer 中间件已挡）
function canCreateChat(userRole, userId, issue) {
    const isAdminOrPublisher = userRole === 'admin' || userRole === 'publisher';
    const isAssignee = Number(issue.assigned_to) > 0 && Number(issue.assigned_to) === userId;
    const isCreator = Number(issue.created_by) > 0 && Number(issue.created_by) === userId;
    return isAdminOrPublisher || isAssignee || isCreator;
}

// 镜像群名裁剪（[需求]{title}-讨论，Array.from 按码点 ≤20）
function buildChatName(title, id) {
    const rawTitle = String(title || `需求${id}`);
    const PREFIX = '[需求]', SUFFIX = '-讨论';
    let chatName = `${PREFIX}${rawTitle}${SUFFIX}`;
    if (Array.from(chatName).length > 20) {
        const budget = 20 - Array.from(PREFIX).length - Array.from(SUFFIX).length;
        const clippedTitle = Array.from(rawTitle).slice(0, Math.max(budget, 0)).join('');
        chatName = `${PREFIX}${clippedTitle}${SUFFIX}`;
    }
    return chatName;
}

// 镜像最小成群（去重后真实钉钉号 < 2 → false）
function hasEnoughMembers(dingUids) {
    const uniq = new Set(dingUids.filter(Boolean));
    return uniq.size >= 2;
}

// 镜像业务方降级判定（phone 空/非法/未命中 → degraded）
function isRequesterDegraded(phone, lookupResult) {
    if (!phone) return true;
    if (!/^1\d{10}$/.test(phone)) return true;
    return !lookupResult;  // 反查未命中（null/空）
}

let pass = 0, fail = 0;
function check(name, fn) { try { fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; } }
function must(cond, msg) { if (!cond) throw new Error(msg); }

function main() {
    console.log('\n══════ v1.75.0 commit C — C4 create-chat 纯决策逻辑镜像 ══════');

    console.log('\n【P 权限判定】');
    check('P1 admin 任意单可拉群', () => must(canCreateChat('admin', 99, { assigned_to: 5, created_by: 1 }) === true, '应允许'));
    check('P2 publisher 任意单可拉群', () => must(canCreateChat('publisher', 99, { assigned_to: 5, created_by: 1 }) === true, '应允许'));
    check('P3 user 是本单 assigned_to → 可拉群', () => must(canCreateChat('user', 5, { assigned_to: 5, created_by: 1 }) === true, '负责人应允许'));
    check('P4 user 是本单 created_by → 可拉群', () => must(canCreateChat('user', 7, { assigned_to: 5, created_by: 7 }) === true, '创建人应允许'));
    check('P5 user 非本单关系人 → 禁止', () => must(canCreateChat('user', 99, { assigned_to: 5, created_by: 1 }) === false, '路人 user 应禁止'));
    check('P6 user + assigned_to=0 占位（非真实）→ 禁止', () => must(canCreateChat('user', 0, { assigned_to: 0, created_by: 1 }) === false, '0 占位不算负责人'));
    check('P7 user + created_by=0 占位 → 禁止', () => must(canCreateChat('user', 0, { assigned_to: 5, created_by: 0 }) === false, '0 占位不算创建人'));

    console.log('\n【N 群名裁剪】');
    check('N1 短标题 → [需求]{title}-讨论 完整', () => {
        const n = buildChatName('客户分析', 1);
        must(n === '[需求]客户分析-讨论', `实际 ${n}`);
        must(Array.from(n).length <= 20, '应 ≤20 码点');
    });
    check('N2 超长中文标题 → 截断保前后缀 ≤20 码点', () => {
        const n = buildChatName('这是一个超级长的需求标题用来测试裁剪逻辑是否正确', 1);
        must(Array.from(n).length <= 20, `应 ≤20 码点，实际 ${Array.from(n).length}`);
        must(n.startsWith('[需求]') && n.endsWith('-讨论'), `前后缀应保留，实际 ${n}`);
    });
    check('N3 emoji 标题不截半（按码点切）', () => {
        const n = buildChatName('🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯', 1);
        must(Array.from(n).length <= 20, `应 ≤20 码点，实际 ${Array.from(n).length}`);
        // 不应出现半个 emoji（surrogate 残留）——Array.from 按码点切保证
        must(!/\uD800-\uDBFF$/.test(n.replace('-讨论', '')), 'emoji 不应被截半');
    });
    check('N4 空标题 → 用 需求{id} 兜底', () => {
        const n = buildChatName('', 42);
        must(n === '[需求]需求42-讨论', `实际 ${n}`);
    });

    console.log('\n【M 最小成群】');
    check('M1 仅 1 个钉钉号 → 不足', () => must(hasEnoughMembers(['ding_a']) === false, '1 人应不足'));
    check('M2 2 个钉钉号 → 足够', () => must(hasEnoughMembers(['ding_a', 'ding_b']) === true, '2 人应足够'));
    check('M3 2 个但重复 → 去重后 1 人不足', () => must(hasEnoughMembers(['ding_a', 'ding_a']) === false, '去重后 1 人应不足'));
    check('M4 含空串去重 → 只算真实号', () => must(hasEnoughMembers(['ding_a', '', null, 'ding_b']) === true, '2 真实号应足够'));
    check('M5 全空 → 不足', () => must(hasEnoughMembers(['', null, undefined]) === false, '全空应不足'));

    console.log('\n【D 业务方降级判定】');
    check('D1 phone 空 → degraded', () => must(isRequesterDegraded('', null) === true, '无手机号应降级'));
    check('D2 phone 非法格式 → degraded', () => must(isRequesterDegraded('123', null) === true, '非法格式应降级'));
    check('D3 phone 合法但反查未命中 → degraded', () => must(isRequesterDegraded('13800138000', null) === true, '未命中应降级'));
    check('D4 phone 合法 + 反查命中 → 不降级', () => must(isRequesterDegraded('13800138000', 'ding_requester') === false, '命中不应降级'));

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 v1.75.0 commit C C4 纯决策逻辑镜像全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}

main();
