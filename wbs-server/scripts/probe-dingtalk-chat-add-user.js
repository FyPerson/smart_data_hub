/**
 * 钉钉 chat/update 加人接口能力探针（一次性，跑完可删）
 *
 * 目的：v1.71.0 三级转发场景下，数据导出人触发拉群时如果群已存在，
 *      需要调 chat/update 把导出人加进旧群。本探针验证：
 *        1. chat/update endpoint 是否真支持 add_useridlist 参数
 *        2. qyapi_chat_manage 权限是否覆盖加人操作（已申请用于建群）
 *        3. 各类边界场景的 errcode（已在群幂等性 / 无效 userid / 企业群限制 / 限流）
 *        4. 加人失败时 DB 端如何处理（接 v1.1 codex #11/#12 errcode 精细化分类需求）
 *
 * 探针清单（8 项，按 v1.1 章节 2.6 + codex #7 #12 补充）：
 *   1. gettoken 拿 access_token + qyapi_chat_manage 权限验证（DRY 模式即可）
 *   2. chat/update add_useridlist 单人添加（生产场景）
 *   3. chat/update add_useridlist 多人批量添加（仅验证可行性，生产场景固定单人）
 *   4. chat/update 添加已在群的人（幂等性 = 软成功 vs 报错）
 *   5. chat/update 添加无效 userId（非企业成员）行为
 *   6. chat/update 企业群限制（群上限多少人、加成员是否需要群主权限）
 *   7. chat/update errcode 全谱收集（无权限/无效 userid/chatid 无效/超限）
 *   8. chat/update 加人失败时 errcode 分类（hard_fail / soft_success / retry）
 *
 * 用法：
 *   1) DRY_RUN（默认）：只跑 gettoken，验证凭证可达，不真改群
 *      node scripts/probe-dingtalk-chat-add-user.js
 *
 *   2) REAL_RUN：真的加人到已存在的测试群
 *      需先在 probe-dingtalk-chat-create.js 探针中建好测试群，把 chatid 填到这里
 *      MODE=real CHATID=xxx ADD_USERID=xxx node scripts/probe-dingtalk-chat-add-user.js
 *
 *      可选环境变量：
 *      INVALID_USERID=xxx          → 测试探针 5（无效 userid 行为）
 *      ALREADY_IN_USERID=xxx       → 测试探针 4（已在群幂等性）
 *      BATCH_USERIDS=a,b,c         → 测试探针 3（批量加人）
 *
 * 关联：
 *   - 方案 v1.1: docs/local/数据协作模块_v3.0/容错与三级转发_合并方案_20260522_v1.1.md §2.6
 *   - codex 一审 #7 / 二审 #1 #11 #12
 *   - 钉钉官方文档: https://open.dingtalk.com/document/orgapp/modify-a-group-chat（codex 一审主动查证字段名 add_useridlist）
 *
 * 归档：探针结果保存到 docs/local/数据协作模块_v3.0/F1_chat_add_user_探针_YYYYMMDD.md
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db');
const MODE = (process.env.MODE || 'dry').toLowerCase();  // 'dry' | 'real'
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';

const GETTOKEN_URL = 'https://oapi.dingtalk.com/gettoken';
const CHAT_UPDATE_URL = 'https://oapi.dingtalk.com/chat/update';
const CHAT_GET_URL = 'https://oapi.dingtalk.com/chat/get';

// REAL_RUN 模式参数
const CHATID = process.env.CHATID || '';
const ADD_USERID = process.env.ADD_USERID || '';  // 探针 2 + 探针 4（如未设单独 ALREADY_IN_USERID 时复用）
const INVALID_USERID = process.env.INVALID_USERID || 'invalid_userid_does_not_exist_99999';
const ALREADY_IN_USERID = process.env.ALREADY_IN_USERID || '';  // 探针 4：已在群的 userid
const BATCH_USERIDS = (process.env.BATCH_USERIDS || '').split(',').map(s => s.trim()).filter(Boolean);

// 探针结果收集（用于归档）
const probeResults = [];

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

async function probeAddUsers(accessToken, label, chatid, useridlist) {
    const url = `${CHAT_UPDATE_URL}?access_token=${encodeURIComponent(accessToken)}`;
    const body = { chatid, add_useridlist: useridlist };

    console.log('');
    console.log(`--- 探针 [${label}] ---`);
    console.log(`请求: chat/update`);
    console.log(`参数: chatid=${chatid.slice(0, 10)}... add_useridlist=${JSON.stringify(useridlist)}`);

    const resp = await httpJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    console.log(`响应 HTTP=${resp.status}:`);
    console.log(JSON.stringify(resp.body, null, 2));

    // 分类
    const errcode = resp.body.errcode;
    let verdict;
    if (errcode === 0) verdict = '✅ 成功';
    else if (errcode === 60011) verdict = '❌ 无权限（应用未开通 qyapi_chat_manage）';
    else if (errcode === 88) verdict = '⚠️ 鉴权失败';
    else if (errcode === 60020) verdict = '⚠️ 调用频率超限（可重试）';
    else if (errcode === 40035 || errcode === 40089) verdict = '⚠️ 无效 userid（用户不存在/已离职）';
    else if (errcode === 90002 || errcode === 90003) verdict = '⚠️ 群上限/群不可见';
    else if (errcode === 400013 || errcode === 90100) verdict = '⚠️ chatid 不存在';
    else verdict = `⚠️ 其他 errcode=${errcode} errmsg=${resp.body.errmsg}`;

    console.log(`判定: ${verdict}`);

    probeResults.push({
        probe: label,
        request: { chatid: chatid.slice(0, 10) + '...', add_useridlist: useridlist },
        response: resp.body,
        verdict
    });

    return resp.body;
}

async function probeChatGet(accessToken, chatid, label = '群信息查询') {
    const url = `${CHAT_GET_URL}?access_token=${encodeURIComponent(accessToken)}&chatid=${encodeURIComponent(chatid)}`;
    console.log('');
    console.log(`--- 探针 [${label}] ---`);
    console.log(`请求: chat/get  chatid=${chatid.slice(0, 10)}...`);

    const resp = await httpJson(url);
    console.log(`响应 HTTP=${resp.status}:`);
    console.log(JSON.stringify(resp.body, null, 2));

    probeResults.push({
        probe: label,
        request: { chatid: chatid.slice(0, 10) + '...' },
        response: resp.body,
    });

    return resp.body;
}

function writeArchive() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const archivePath = path.resolve(__dirname, '../../docs/local/数据协作模块_v3.0/',
        `F1_chat_add_user_探针_${today}.md`);

    const lines = [
        `# F1 钉钉 chat/update 加人探针报告`,
        ``,
        `**探针日期**：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
        `**模式**：${MODE.toUpperCase()}`,
        `**探针清单**：8 项（按 v1.1 §2.6 + codex 二审 #1 #11 #12）`,
        ``,
        `---`,
        ``
    ];

    probeResults.forEach((r, i) => {
        lines.push(`## 探针 ${i + 1}: ${r.probe}`);
        lines.push('');
        if (r.request) {
            lines.push('**请求**：');
            lines.push('```json');
            lines.push(JSON.stringify(r.request, null, 2));
            lines.push('```');
        }
        lines.push('**响应**：');
        lines.push('```json');
        lines.push(JSON.stringify(r.response, null, 2));
        lines.push('```');
        if (r.verdict) {
            lines.push(`**判定**：${r.verdict}`);
        }
        lines.push('');
    });

    lines.push(`---`);
    lines.push('');
    lines.push(`## 结论（人工填写）`);
    lines.push('');
    lines.push('- [ ] chat/update endpoint 支持 add_useridlist 参数: yes/no');
    lines.push('- [ ] qyapi_chat_manage 权限覆盖加人操作: yes/no');
    lines.push('- [ ] 已在群幂等性: errcode=0 / errcode=非0（请填实际）');
    lines.push('- [ ] 无效 userid 行为: 整批拒 / 部分成功');
    lines.push('- [ ] 加人是否触发钉钉新成员通知: yes/no');
    lines.push('- [ ] errcode 全谱分类表（hard_fail / soft_success / retry / other）:');
    lines.push('  - 成功 = errcode=0');
    lines.push('  - soft_success（已在群） = errcode=?');
    lines.push('  - retry（限流） = errcode=60020');
    lines.push('  - retry（token 过期） = errcode=88 / 40014');
    lines.push('  - hard_fail（无权限） = errcode=60011');
    lines.push('  - hard_fail（无效用户） = errcode=40035 / 40089');
    lines.push('  - hard_fail（chatid 无效） = errcode=400013 / 90100');
    lines.push('');
    lines.push(`## 落地到 v1.71.0 设计建议`);
    lines.push('');
    lines.push('（根据探针结果填写，例如"已在群按 soft_success 处理，errcode=XXX 直接返 added_to_chat"）');
    lines.push('');

    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, lines.join('\n'), 'utf8');
    console.log('');
    console.log(`[ARCHIVE] 探针报告已生成: ${archivePath}`);
    console.log(`           请补充"结论"和"落地建议"段后归档到 v1.71.0 方案`);
}

(async () => {
    console.log('='.repeat(70));
    console.log(`钉钉 chat/update 加人能力探针  MODE=${MODE}  DB=${DB_PATH}`);
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
    console.log(`[OK]   读到凭证 appKey=${appKey.slice(0, 4)}***${appKey.slice(-3)}`);

    // 探针 1: gettoken（DRY 模式核心）
    const tokenUrl = `${GETTOKEN_URL}?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
    const tk = await httpJson(tokenUrl);
    if (tk.body.errcode !== 0) {
        console.error(`[FAIL] 探针 1: gettoken 失败 errcode=${tk.body.errcode} errmsg=${tk.body.errmsg}`);
        process.exit(3);
    }
    const accessToken = tk.body.access_token;
    console.log(`[OK]   探针 1: gettoken 成功 access_token=${accessToken.slice(0, 8)}...`);

    probeResults.push({
        probe: '1. gettoken 验证凭证',
        request: { appKey: appKey.slice(0, 4) + '***' },
        response: { errcode: 0, access_token_preview: accessToken.slice(0, 8) + '...' },
        verdict: '✅ 凭证可达，access_token 拿到'
    });

    if (MODE === 'dry') {
        console.log('');
        console.log('[DRY]  当前为 DRY_RUN 模式，不真改群。');
        console.log('       要真探测 chat/update 加人能力，请：');
        console.log('       1) 先跑 probe-dingtalk-chat-create.js 建一个测试群拿 chatid');
        console.log('       2) 从生产 users 表查 1 个有 dingtalk_user_id 的 active 账号（作为 ADD_USERID）');
        console.log('       3) 可选：查 1 个已经在测试群里的 userid（作为 ALREADY_IN_USERID 测探针 4）');
        console.log('       4) 设置环境变量后重跑：');
        console.log('          MODE=real CHATID=xxx ADD_USERID=xxx \\');
        console.log('            [ALREADY_IN_USERID=xxx] [INVALID_USERID=xxx] [BATCH_USERIDS=a,b] \\');
        console.log('            node scripts/probe-dingtalk-chat-add-user.js');
        console.log('');
        console.log('[HINT] DRY_RUN 已验证凭证可达，下一步只需 REAL_RUN 一次即可拿到 8 项探针结果。');
        writeArchive();  // DRY 模式也写一次归档（仅含探针 1）方便看格式
        return;
    }

    // REAL_RUN 前置校验
    if (!CHATID) {
        console.error('[FAIL] REAL_RUN 需 CHATID 环境变量');
        process.exit(4);
    }
    if (!ADD_USERID) {
        console.error('[FAIL] REAL_RUN 需 ADD_USERID 环境变量');
        process.exit(5);
    }

    // 探针前置：查群信息（确认 chatid 有效 + 当前成员）
    await probeChatGet(accessToken, CHATID, '群信息查询（确认 chatid 有效 + 列当前成员）');

    // 探针 2: 单人添加（生产场景）
    await probeAddUsers(accessToken, '2. 单人添加（生产场景）', CHATID, [ADD_USERID]);

    // 探针 3: 多人批量添加（仅验证可行性）
    if (BATCH_USERIDS.length >= 2) {
        await probeAddUsers(accessToken, '3. 多人批量添加（验证可行性）', CHATID, BATCH_USERIDS);
    } else {
        console.log('');
        console.log('[SKIP] 探针 3: 未设 BATCH_USERIDS 跳过（生产场景固定单人加，可不测）');
    }

    // 探针 4: 添加已在群的人（幂等性）
    const alreadyInUserid = ALREADY_IN_USERID || ADD_USERID;  // 默认复用 ADD_USERID（探针 2 已加过）
    await probeAddUsers(accessToken, '4. 添加已在群的人（幂等性 - 软成功还是报错？）', CHATID, [alreadyInUserid]);

    // 探针 5: 无效 userId
    await probeAddUsers(accessToken, '5. 添加无效 userId（非企业成员）', CHATID, [INVALID_USERID]);

    // 探针 6: 企业群限制（通过查 chat/get 看群信息推断）
    await probeChatGet(accessToken, CHATID, '6. 企业群限制（查 chat/get 看 useridlist 成员上限/类型）');

    // 探针 7: errcode 收集（前面已收集，写到 archive）
    console.log('');
    console.log('--- 探针 7: errcode 全谱收集 ---');
    console.log('已通过探针 2/3/4/5 收集，详见归档报告 errcode 分类表');

    // 探针 8: DB 端如何处理（业务层设计，靠探针结果反推）
    console.log('');
    console.log('--- 探针 8: DB 端如何记录（业务层设计） ---');
    console.log('需要业务层根据 errcode 分类决策，详见归档报告"落地建议"段');

    writeArchive();

    console.log('');
    console.log('='.repeat(70));
    console.log('[DONE] REAL_RUN 完成，共收集 7 个真实响应数据');
    console.log('       请检查归档报告并填写"结论"和"落地建议"段');
    console.log('       重要：探针 2 已把 ADD_USERID 加进群，若需清理请群主手动移除');
    console.log('='.repeat(70));
})().catch(err => {
    console.error('[FATAL]', err.message);
    console.error(err.stack);
    process.exit(1);
});
