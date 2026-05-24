// 一次性脚本：验证 v1.71.0 Commit A 三级转发 helper
//   - utils/dingtalk-notify.js: safeParseUserIdList / classifyAddUserErrcode（addUserToChat 真实 HTTP 已 5/23 F1 真跑验证）
//   - utils/collab-submit-helpers.js: checkAttachmentOwnerOrAdmin
//
// 跑法：node scripts/verify-add-user-helpers.js
'use strict';

const assert = require('assert');
const { safeParseUserIdList, classifyAddUserErrcode, addUserToChat } = require('../utils/dingtalk-notify');
const { checkAttachmentOwnerOrAdmin } = require('../utils/collab-submit-helpers');

let pass = 0;
let fail = 0;

function eq(label, actual, expected) {
    try {
        assert.deepStrictEqual(actual, expected);
        console.log(`  PASS  ${label}`);
        pass++;
    } catch (e) {
        console.log(`  FAIL  ${label}`);
        console.log(`        actual=  ${JSON.stringify(actual)}`);
        console.log(`        expected=${JSON.stringify(expected)}`);
        fail++;
    }
}

async function throwsAsync(label, fn, expectedMsgFragment) {
    try {
        await fn();
        console.log(`  FAIL  ${label}（未抛错）`);
        fail++;
    } catch (e) {
        if (e.message && e.message.includes(expectedMsgFragment)) {
            console.log(`  PASS  ${label}`);
            pass++;
        } else {
            console.log(`  FAIL  ${label}`);
            console.log(`        actual msg=  ${e.message}`);
            console.log(`        expected contains=${expectedMsgFragment}`);
            fail++;
        }
    }
}

console.log('\n== safeParseUserIdList ==');
eq('数组直通',           safeParseUserIdList(['u1', 'u2']),       ['u1', 'u2']);
eq('JSON 数组字符串',    safeParseUserIdList('["u1","u2"]'),       ['u1', 'u2']);
eq('普通字符串包成单元素', safeParseUserIdList('u1'),                ['u1']);
eq('非法 JSON 包成单元素', safeParseUserIdList('{not-json'),         ['{not-json']);
eq('null 直通',           safeParseUserIdList(null),                null);
eq('undefined 直通',      safeParseUserIdList(undefined),           null);
// codex 34 审 L-1：补 JSON 空数组 + JSON 对象退回 [raw]
eq('JSON 空数组返空数组（H-1 判断条件 length>0 据此锁定）',
    safeParseUserIdList('[]'),                                     []);
eq('JSON 对象退回 [raw]',
    safeParseUserIdList('{"a":1}'),                                ['{"a":1}']);

console.log('\n== classifyAddUserErrcode ==');
eq('errcode=0 + errorUserIds=null 软成功',
    classifyAddUserErrcode(0, null),
    { kind: 'soft_success', action: 'added_to_chat' });
// codex 34 审 L-2：F1 真跑软失败子集——errcode=0 + errorUserIds 非空 = hard_fail（H-1 修复后）
eq('errcode=0 + errorUserIds 非空 = F1 软失败子集（H-1 关键路径）',
    classifyAddUserErrcode(0, ['bad_uid']),
    {
        kind: 'hard_fail',
        action: 'mark_userid_invalid',
        detail: '钉钉返回 errcode=0 但 errorUserIds 非空（部分失败子集）：bad_uid（检查 users.dingtalk_user_id 是否过期/离职）'
    });
eq('errcode=0 + errorUserIds=[] 空数组仍走软成功（L-1 锁定语义）',
    classifyAddUserErrcode(0, []),
    { kind: 'soft_success', action: 'added_to_chat' });
eq('errcode=49016 userid 非法',
    classifyAddUserErrcode(49016, ['bad_uid']),
    { kind: 'hard_fail', action: 'mark_userid_invalid', detail: '钉钉员工不存在：bad_uid（检查 users.dingtalk_user_id 是否过期/离职）' });
eq('errcode=60011 权限被回收',
    classifyAddUserErrcode(60011, null),
    { kind: 'hard_fail', action: 'alert_admin_permission_revoked' });
// codex 34 审 M-1：errcode=88 改判 hard_fail（对齐 classifyError）
eq('errcode=88 user_invalid（M-1 对齐 classifyError）',
    classifyAddUserErrcode(88, null),
    { kind: 'hard_fail', action: 'mark_userid_invalid', detail: '钉钉用户不存在（errcode=88，对齐 classifyError 语义）' });
eq('errcode=40014 仍走 refresh_token_retry',
    classifyAddUserErrcode(40014, null),
    { kind: 'retry', action: 'refresh_token_retry' });
eq('errcode=400013 chatid 失效',
    classifyAddUserErrcode(400013, null),
    { kind: 'hard_fail', action: 'mark_chatid_invalid' });
eq('errcode=99999 未分类',
    classifyAddUserErrcode(99999, null),
    { kind: 'other', action: 'log_and_alert', detail: '未分类 errcode=99999' });

(async () => {
console.log('\n== addUserToChat 形态校验（M-2，不发起真实 HTTP） ==');
// codex 34 审 M-2：基础形态校验（空数组 / 非数组）→ 抛 Error
await throwsAsync('空数组抛 Error',
    () => addUserToChat('fake_token', 'fake_chatid', []),
    'useridList 必须是非空数组');
await throwsAsync('非数组（字符串）抛 Error',
    () => addUserToChat('fake_token', 'fake_chatid', 'u1'),
    'useridList 必须是非空数组');
await throwsAsync('非数组（null）抛 Error',
    () => addUserToChat('fake_token', 'fake_chatid', null),
    'useridList 必须是非空数组');

console.log('\n== checkAttachmentOwnerOrAdmin ==');
const ATT = { id: 1, uploaded_by: 100 };
eq('admin 越权 OK',
    checkAttachmentOwnerOrAdmin(ATT, { id: 999, role: 'admin' }),
    { ok: true });
eq('上传人本人 OK',
    checkAttachmentOwnerOrAdmin(ATT, { id: 100, role: 'developer' }),
    { ok: true });
eq('非 admin 他人 BLOCK',
    checkAttachmentOwnerOrAdmin(ATT, { id: 200, role: 'developer' }),
    { ok: false, reason: '只有上传人本人或 admin 可操作此附件', code: 'ATTACHMENT_OWNER_LOCKED' });
eq('attachment 缺失 BLOCK',
    checkAttachmentOwnerOrAdmin(null, { id: 100, role: 'admin' }),
    { ok: false, reason: '附件信息缺失或 uploaded_by 异常', code: 'ATTACHMENT_INVALID' });
eq('uploaded_by 非 number BLOCK',
    checkAttachmentOwnerOrAdmin({ id: 1, uploaded_by: '100' }, { id: 100, role: 'admin' }),
    { ok: false, reason: '附件信息缺失或 uploaded_by 异常', code: 'ATTACHMENT_INVALID' });
eq('reqUser 缺失 BLOCK',
    checkAttachmentOwnerOrAdmin(ATT, null),
    { ok: false, reason: '请求用户信息缺失', code: 'REQ_USER_INVALID' });
eq('reqUser.id 非 number BLOCK',
    checkAttachmentOwnerOrAdmin(ATT, { id: '100', role: 'admin' }),
    { ok: false, reason: '请求用户信息缺失', code: 'REQ_USER_INVALID' });

console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
process.exit(fail === 0 ? 0 : 1);
})();
