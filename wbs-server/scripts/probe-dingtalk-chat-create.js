/**
 * 钉钉 chat/create 接口权限探针（一次性，跑完可删）
 *
 * 目的：判断当前钉钉企业内部应用是否已开放"创建群会话"接口权限，
 *      避免提交申请走 0.5-1 天审核流程后才发现是否可用。
 *
 * 判断逻辑：
 *   - errcode = 0          → 权限已开放，群已建（脚本会同时返回 chatid/openConversationId，但不留群——
 *                            钉钉无解散 API，只能群主手动退出/转让，所以默认 DRY_RUN 模式只到 gettoken 为止）
 *   - errcode = 60011      → 没有调用权限（最常见，需要去开放平台后台申请）
 *   - errcode = 88         → 鉴权失败/未授权
 *   - errcode = 33333 等   → 业务参数错误（说明权限已通，只是 owner/useridlist 不合法）
 *   - 其他                  → 打印 errcode + errmsg 由人工判断
 *
 * 用法：
 *   1) DRY_RUN（默认）：只跑 gettoken，验证凭证可达，不真的建群
 *      node scripts/probe-dingtalk-chat-create.js
 *
 *   2) REAL_RUN：真的建一个测试群（小心：会真的发生建群，群名 [PROBE]_test_chat_xxxx）
 *      需先在脚本里填 OWNER_USERID 和 MEMBER_USERIDS（至少 2 个钉钉 userid，群主必须在成员里）
 *      MODE=real node scripts/probe-dingtalk-chat-create.js
 *
 * 关联：docs/local/数据协作模块_v2.0.md（拉起群聊功能调研，2026-05-20）
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db');
const MODE = (process.env.MODE || 'dry').toLowerCase();  // 'dry' | 'real'
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';  // 跟 server.js 保持一致

const GETTOKEN_URL = 'https://oapi.dingtalk.com/gettoken';
const CHAT_CREATE_URL = 'https://oapi.dingtalk.com/chat/create';

// REAL_RUN 模式下需填这两个（钉钉 userid，从 users 表 dingtalk_user_id 列取已知有效的）
const OWNER_USERID = process.env.OWNER_USERID || '';  // 群主，必须在 MEMBER_USERIDS 里
const MEMBER_USERIDS = (process.env.MEMBER_USERIDS || '').split(',').map(s => s.trim()).filter(Boolean);

function decryptPassword(encryptedPassword) {
    const parts = encryptedPassword.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

async function readConfig(db, key) {
    return new Promise((resolve, reject) => {
        db.get('SELECT config_value_encrypted FROM system_configs WHERE config_key = ?', [key], (err, row) => {
            if (err) return reject(err);
            if (!row || !row.config_value_encrypted) return resolve(null);
            try {
                resolve(decryptPassword(row.config_value_encrypted));
            } catch (e) {
                reject(new Error(`decrypt ${key} failed: ${e.message}（DB_ENCRYPTION_KEY 是否与生产一致？）`));
            }
        });
    });
}

async function httpJson(url, init) {
    const resp = await fetch(url, init);
    const text = await resp.text();
    try {
        return { status: resp.status, body: JSON.parse(text) };
    } catch {
        return { status: resp.status, body: { raw: text } };
    }
}

(async () => {
    console.log('='.repeat(70));
    console.log(`钉钉 chat/create 权限探针  MODE=${MODE}  DB=${DB_PATH}`);
    console.log('='.repeat(70));

    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

    let appKey, appSecret;
    try {
        appKey = await readConfig(db, 'dingtalk_app_key');
        appSecret = await readConfig(db, 'dingtalk_app_secret');
    } finally {
        db.close();
    }

    if (!appKey || !appSecret) {
        console.error('[FAIL] system_configs 缺 dingtalk_app_key / dingtalk_app_secret');
        process.exit(2);
    }
    console.log(`[OK]   读到凭证 appKey=${appKey.slice(0, 4)}***${appKey.slice(-3)}  (secret 隐藏)`);

    // Step 1: gettoken
    const tokenUrl = `${GETTOKEN_URL}?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
    const tk = await httpJson(tokenUrl);
    if (tk.body.errcode !== 0) {
        console.error(`[FAIL] gettoken 失败 errcode=${tk.body.errcode} errmsg=${tk.body.errmsg}`);
        process.exit(3);
    }
    const accessToken = tk.body.access_token;
    console.log(`[OK]   gettoken 成功 access_token=${accessToken.slice(0, 8)}...`);

    if (MODE === 'dry') {
        console.log('');
        console.log('[DRY]  当前为 DRY_RUN 模式，不真的建群。');
        console.log('       要真的探测 chat/create 权限，请：');
        console.log('       1) 从生产 users 表查 2-3 个有 dingtalk_user_id 的账号');
        console.log('       2) 设置环境变量后重跑：');
        console.log('          MODE=real OWNER_USERID=xxx MEMBER_USERIDS=xxx,yyy node scripts/probe-dingtalk-chat-create.js');
        console.log('');
        console.log('[HINT] DRY_RUN 已验证凭证可达，下一步只需 REAL_RUN 一次即可拿到权限判断。');
        return;
    }

    // Step 2: chat/create（REAL_RUN）
    if (!OWNER_USERID || MEMBER_USERIDS.length < 2) {
        console.error('[FAIL] REAL_RUN 需 OWNER_USERID + 至少 2 个 MEMBER_USERIDS（含 OWNER）');
        process.exit(4);
    }
    if (!MEMBER_USERIDS.includes(OWNER_USERID)) {
        console.error('[FAIL] OWNER_USERID 必须在 MEMBER_USERIDS 里（钉钉硬约束）');
        process.exit(5);
    }

    const groupName = `[PROBE]_test_chat_${Date.now()}`;
    console.log(`[INFO] 准备调 chat/create  name=${groupName}  owner=${OWNER_USERID}  members=${MEMBER_USERIDS.length}`);

    const createUrl = `${CHAT_CREATE_URL}?access_token=${encodeURIComponent(accessToken)}`;
    const cc = await httpJson(createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: groupName,
            owner: OWNER_USERID,
            useridlist: MEMBER_USERIDS,
            validationType: '0',
            searchable: 0
        })
    });

    console.log('');
    console.log('=== chat/create 返回 ===');
    console.log(JSON.stringify(cc.body, null, 2));
    console.log('');

    const errcode = cc.body.errcode;
    if (errcode === 0) {
        console.log('[VERDICT] ✅ 权限已开放 —— 群已创建');
        console.log(`           chatid=${cc.body.chatid}`);
        console.log(`           openConversationId=${cc.body.openConversationId || '(未返回)'}`);

        // Step 3: 立即调 disband 验证解散能力
        const openConvId = cc.body.openConversationId;
        if (!openConvId) {
            console.log('');
            console.log('[WARN] openConversationId 未返回，跳过 disband 测试');
            return;
        }
        console.log('');
        console.log('[INFO] 立即测试 chat/disband 接口...');
        // 钉钉 topapi 系列要求 access_token 在 query string
        const disbandUrl = `https://oapi.dingtalk.com/topapi/chat/disband?access_token=${encodeURIComponent(accessToken)}`;
        const dis = await httpJson(disbandUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                open_conversation_id: openConvId
            })
        });
        console.log('');
        console.log('=== chat/disband 返回 ===');
        console.log(JSON.stringify(dis.body, null, 2));
        console.log('');
        if (dis.body.errcode === 0) {
            console.log('[VERDICT] ✅ 解散成功 —— 群已自动清理');
        } else if (dis.body.errcode === 60011) {
            console.log(`[VERDICT] ⚠️  解散接口缺权限 errcode=60011 errmsg=${dis.body.errmsg}`);
            console.log('           （建群权限通了不代表解散权限也通，需要单独申请）');
            console.log(`           ⚠️  当前群仍存在，需 OWNER 手动在钉钉客户端解散：openConversationId=${openConvId}`);
        } else {
            console.log(`[VERDICT] ⚠️  解散失败 errcode=${dis.body.errcode} errmsg=${dis.body.errmsg}`);
            console.log(`           ⚠️  当前群可能仍存在，请检查 openConversationId=${openConvId}`);
        }
    } else if (errcode === 60011) {
        console.log('[VERDICT] ❌ 没有调用权限（errcode=60011）—— 需要去钉钉开放平台后台申请');
        console.log('           申请路径：开放平台 → 应用开发 → 当前应用 → 接口权限 → "通讯录管理 / 群管理" 类目');
    } else if (errcode === 88) {
        console.log('[VERDICT] ⚠️  鉴权失败或未授权 errcode=88 —— 通常也是未开通权限');
    } else if (errcode === 60020) {
        console.log('[VERDICT] ⚠️  调用频率超限（errcode=60020）—— 稍后重试');
    } else {
        console.log(`[VERDICT] ⚠️  其他错误 errcode=${errcode} errmsg=${cc.body.errmsg}`);
        console.log('           参考钉钉错误码表：https://open.dingtalk.com/document/orgapp/server-api-error-code');
    }
})().catch(err => {
    console.error('[FATAL]', err.message);
    console.error(err.stack);
    process.exit(1);
});
