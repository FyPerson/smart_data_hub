/**
 * verify-notify-requester-recipient.js
 *
 * 2026-06-09 通知业务方收件人修复（codex 78 审）—— resolveRequesterDingUserId helper 分支验证。
 *
 * 背景：collab "通知业务方并发送数据" 收件人从 contact_person_id 改为 requester_phone 反查钉钉
 *   （生产 #9 admin 直派单 contact_person_id=0 致发送失败）。helper 通过 deps 注入 mock，
 *   不发真实钉钉请求（codex 78 M-3：helper 是有网络副作用的 async helper，verify 必须 mock）。
 *
 * 覆盖分支：
 *   1. phone 空（null / '' / 空白串）→ requester_phone_empty，且不调 lookup（fail-fast）
 *   2. lookup 抛 errcode=88（user_invalid）→ 翻译为 requester_invalid
 *   3. lookup 抛 errcode=88002（user_invalid）→ 翻译为 requester_invalid
 *   4. lookup 抛 errcode=42001（token_expired）→ reason 原样透传（不翻译、不重试，codex 78 M-4）
 *   5. lookup 抛 TypeError（网络错）→ reason='network' 透传
 *   6. lookup 返回 null / 空串 → requester_invalid
 *   7. lookup 返回带空白 userid → trim 后 ok:true
 *   8. 正常 userid → ok:true
 *   9. 隐私（codex 78 M-2）：所有失败返回值不携带手机号明文
 *
 * 权限矩阵（admin / 本单 exporter / 无关用户）为 endpoint 内联逻辑无法 require，
 * 不在本脚本造"逻辑复制"假测试——由 e2e + 浏览器实测覆盖（与 codex 59 H-1 假绿教训一致）。
 *
 * 运行：node scripts/verify-notify-requester-recipient.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const dingtalkNotify = require(path.join(__dirname, '..', 'utils', 'dingtalk-notify.js'));

const { resolveRequesterDingUserId } = dingtalkNotify;

let passed = 0;
let failed = 0;

async function t(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
    }
}

// 构造带 errcode 的 Error（模拟 getUserIdByMobile 的抛错形态，见 dingtalk-notify.js getUserIdByMobile）
function dingErr(errcode, errmsg) {
    const err = new Error(`get_by_mobile failed: errcode=${errcode} errmsg=${errmsg}`);
    err.errcode = errcode;
    err.errmsg = errmsg;
    return err;
}

(async () => {
    console.log('=== resolveRequesterDingUserId 分支验证 ===');

    // --- 1. phone 空：requester_phone_empty 且不调 lookup ---
    for (const emptyVal of [null, undefined, '', '   ', '\t']) {
        await t(`phone 空（${JSON.stringify(emptyVal)}）→ requester_phone_empty 且不调 lookup`, async () => {
            let lookupCalled = false;
            const r = await resolveRequesterDingUserId('tok', emptyVal, {
                getUserIdByMobile: async () => { lookupCalled = true; return 'x'; }
            });
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.reason, 'requester_phone_empty');
            assert.strictEqual(lookupCalled, false, 'phone 空不应调钉钉');
        });
    }

    // --- 2/3. errcode 88 / 88002（user_invalid）→ requester_invalid ---
    for (const code of [88, 88002]) {
        await t(`lookup 抛 errcode=${code} → requester_invalid`, async () => {
            const r = await resolveRequesterDingUserId('tok', '13800000000', {
                getUserIdByMobile: async () => { throw dingErr(code, 'user not found'); }
            });
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.reason, 'requester_invalid');
            assert.strictEqual(r.errcode, code);
        });
    }

    // --- 4. token_expired 原样透传（不翻译不重试，codex 78 M-4）---
    await t('lookup 抛 errcode=42001 → reason=token_expired 透传', async () => {
        const r = await resolveRequesterDingUserId('tok', '13800000000', {
            getUserIdByMobile: async () => { throw dingErr(42001, 'token expired'); }
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'token_expired');
    });

    // --- 5. 网络错（TypeError，fetch 失败形态）→ network ---
    await t('lookup 抛 TypeError → reason=network', async () => {
        const r = await resolveRequesterDingUserId('tok', '13800000000', {
            getUserIdByMobile: async () => { throw new TypeError('fetch failed'); }
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'network');
    });

    // --- 6. lookup 返回 null / 空串 → requester_invalid ---
    for (const emptyRet of [null, undefined, '', '   ']) {
        await t(`lookup 返回 ${JSON.stringify(emptyRet)} → requester_invalid`, async () => {
            const r = await resolveRequesterDingUserId('tok', '13800000000', {
                getUserIdByMobile: async () => emptyRet
            });
            assert.strictEqual(r.ok, false);
            assert.strictEqual(r.reason, 'requester_invalid');
        });
    }

    // --- 7. userid 带空白 → trim 后 ok ---
    await t('lookup 返回 "  uid123  " → trim 后 ok:true userid=uid123', async () => {
        const r = await resolveRequesterDingUserId('tok', '13800000000', {
            getUserIdByMobile: async () => '  uid123  '
        });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.userid, 'uid123');
    });

    // --- 8. 正常 userid → ok ---
    await t('lookup 返回正常 userid → ok:true', async () => {
        const r = await resolveRequesterDingUserId('tok', '13800000000', {
            getUserIdByMobile: async () => '012806693237824134'
        });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.userid, '012806693237824134');
    });

    // --- 9. 隐私（codex 78 M-2 + 79 M-1）：失败返回值【完整对象】不携带手机号明文 ---
    //   79 M-1 修复后 helper 不再返回 hint（钉钉 errmsg 可能回显手机号），
    //   故可对完整返回对象做断言（不再只断言自有字段）
    await t('失败返回值完整对象（全分支）不携带手机号明文 + 无 hint 字段', async () => {
        const PHONE = '13912345678';
        const results = [];
        results.push(await resolveRequesterDingUserId('tok', PHONE, {
            getUserIdByMobile: async () => { throw dingErr(88, `mobile ${PHONE} not found`); }
        }));
        results.push(await resolveRequesterDingUserId('tok', PHONE, {
            getUserIdByMobile: async () => { throw dingErr(42001, `token expired for ${PHONE}`); }
        }));
        results.push(await resolveRequesterDingUserId('tok', PHONE, {
            getUserIdByMobile: async () => null
        }));
        results.push(await resolveRequesterDingUserId('tok', '', {}));
        for (const r of results) {
            const whole = JSON.stringify(r);
            assert.ok(!whole.includes(PHONE), `完整返回对象携带了手机号: ${whole}`);
            assert.ok(!('hint' in r), `返回对象不应含 hint 字段（codex 79 M-1）: ${whole}`);
        }
    });

    console.log(`\n结果：${passed} passed / ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
    console.error('脚本异常:', e);
    process.exit(1);
});
