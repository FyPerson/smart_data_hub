/**
 * verify-builtin-admin-chat-member.js（v1.79.x）
 *
 * 验证「拉起讨论群」群成员构造中，内置 admin 占位账号(id=1)触发时的替换逻辑：
 *   - 触发人 = 内置 admin(id=1) → 不把 id=1 加入群（无钉钉号会拉群失败）；
 *     平台方由固定群成员示例用户A(COLLAB_CHAT_ADMIN_ID=3)代表 → 群成员里有 3、无 1。
 *   - 触发人 = 其他任何人（含其他 admin 账号、对接人、开发、示例用户A本人）→ 照常加入。
 *
 * 复刻 server.js collab/issue create-chat 的群成员构造契约（纯逻辑，不碰钉钉/db）。
 * 真实建群链路（钉钉 API）按项目惯例（钉钉真连不进 e2e）走浏览器/生产实测。
 *
 * 跑法：node scripts/verify-builtin-admin-chat-member.js
 */

'use strict';

const COLLAB_CHAT_ADMIN_ID = 3;   // 示例用户A（固定群成员/平台方代表）
const BUILTIN_ADMIN_USER_ID = 1;  // 内置 admin 占位账号（无真人/无钉钉号）

// —— 复刻 server.js addRealChatMember（codex 审 medium-1）——
//   排除内置 admin + 无效/占位 id；所有成员来源统一走它（触发人/对接人/开发/assigned_to）
function addRealChatMember(memberSet, rawId) {
    const uid = Number(rawId);
    if (Number.isSafeInteger(uid) && uid > 0 && uid !== BUILTIN_ADMIN_USER_ID) {
        memberSet.add(uid);
    }
}

// —— 复刻 collab create-chat 群成员构造（server.js ~12871）——
function buildCollabChatMembers({ contactPersonId, developerId, triggerUserId }) {
    const members = new Set();
    addRealChatMember(members, COLLAB_CHAT_ADMIN_ID);
    addRealChatMember(members, contactPersonId);
    addRealChatMember(members, developerId);
    addRealChatMember(members, triggerUserId);
    return members;
}

// —— 复刻 issue create-chat 群成员构造（server.js ~11263）——
function buildIssueChatMembers({ assignedTo, triggerUserId }) {
    const members = new Set();
    addRealChatMember(members, COLLAB_CHAT_ADMIN_ID);
    addRealChatMember(members, assignedTo);
    addRealChatMember(members, triggerUserId);
    return members;
}

let pass = 0, fail = 0;
function check(label, actualSet, { mustHave = [], mustNotHave = [] }) {
    const arr = [...actualSet];
    const okHave = mustHave.every(x => actualSet.has(x));
    const okNot = mustNotHave.every(x => !actualSet.has(x));
    const ok = okHave && okNot;
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(46), '成员={' + arr.join(',') + '}',
        ok ? '' : `（须含 [${mustHave}] 须无 [${mustNotHave}]）`);
}

console.log('=== collab create-chat 群成员 ===');
// 内置 admin(id=1) 触发：不含 1，含示例用户A 3
check('内置 admin(1) 触发 → 无 1、有示例用户A 3', buildCollabChatMembers({ contactPersonId: 10, developerId: 11, triggerUserId: 1 }),
    { mustHave: [3, 10, 11], mustNotHave: [1] });
// 示例用户A本人(id=3) 触发：含 3（与固定成员去重）
check('示例用户A本人(3) 触发 → 有 3', buildCollabChatMembers({ contactPersonId: 10, developerId: 11, triggerUserId: 3 }),
    { mustHave: [3, 10, 11] });
// 其他 admin(如示例客服A id=2) 触发：本人照常入群
check('其他 admin(2) 触发 → 含本人 2 + 示例用户A 3', buildCollabChatMembers({ contactPersonId: 10, developerId: 11, triggerUserId: 2 }),
    { mustHave: [2, 3, 10, 11], mustNotHave: [1] });
// 对接人(id=10) 触发：本人照常
check('对接人(10) 触发 → 含本人 10', buildCollabChatMembers({ contactPersonId: 10, developerId: 11, triggerUserId: 10 }),
    { mustHave: [3, 10, 11] });
// 开发(id=11) 触发：本人照常
check('开发(11) 触发 → 含本人 11', buildCollabChatMembers({ contactPersonId: 10, developerId: 0, triggerUserId: 11 }),
    { mustHave: [3, 10, 11] });
// codex medium-1：id=1 被指派为对接人 → 仍排除（不只拦触发人那一路）
check('id=1 作对接人 → 排除 1', buildCollabChatMembers({ contactPersonId: 1, developerId: 11, triggerUserId: 10 }),
    { mustHave: [3, 10, 11], mustNotHave: [1] });
// codex medium-1：id=1 被指派为开发 → 仍排除
check('id=1 作开发 → 排除 1', buildCollabChatMembers({ contactPersonId: 10, developerId: 1, triggerUserId: 10 }),
    { mustHave: [3, 10], mustNotHave: [1] });
// 0 占位（developer_id=0 / contact=0）→ 不入群
check('developer_id=0 占位 → 不加 0', buildCollabChatMembers({ contactPersonId: 10, developerId: 0, triggerUserId: 10 }),
    { mustHave: [3, 10], mustNotHave: [0] });

console.log('\n=== issue create-chat 群成员 ===');
check('内置 admin(1) 触发 → 无 1、有示例用户A 3', buildIssueChatMembers({ assignedTo: 12, triggerUserId: 1 }),
    { mustHave: [3, 12], mustNotHave: [1] });
check('其他 admin(2) 触发 → 含本人 2 + 示例用户A 3', buildIssueChatMembers({ assignedTo: 12, triggerUserId: 2 }),
    { mustHave: [2, 3, 12], mustNotHave: [1] });
check('负责人(12) 触发 → 含本人 12', buildIssueChatMembers({ assignedTo: 12, triggerUserId: 12 }),
    { mustHave: [3, 12] });
check('无 assigned_to + 内置 admin(1) 触发 → 仅示例用户A 3', buildIssueChatMembers({ assignedTo: 0, triggerUserId: 1 }),
    { mustHave: [3], mustNotHave: [1] });
// codex medium-1：id=1 被指派为 assigned_to → 仍排除
check('id=1 作 assigned_to → 排除 1', buildIssueChatMembers({ assignedTo: 1, triggerUserId: 12 }),
    { mustHave: [3, 12], mustNotHave: [1] });

console.log('---');
console.log('结果:', pass + '/' + (pass + fail), fail === 0 ? '全绿' : '有失败');
if (fail > 0) process.exit(1);
