/**
 * 钉钉 DING 消息接口权限探针（一次性，跑完可删）
 *
 * 目的：在设计「迭代单派单未读升级」方案之前，先确认 /v1.0/robot/ding/send 能不能调，
 *      避免设计完才发现权限没开或版本不支持（同 probe-dingtalk-chat-create.js 的教训）。
 *
 * 官方约束（2026-09-04 查证 open.dingtalk.com）：
 *   - 仅企业内部应用可调用（我们正是）；第三方企业应用 / 个人应用不支持
 *   - 仅限钉钉专业版和专属版客户使用（用户已确认公司是专业版）
 *   - remindType：1=应用内DING、2=短信DING、3=电话DING
 *   - 应用内 DING 每次接收人 ≤ 200；短信/电话 DING ≤ 20
 *   - OpenAPI 发 DING 有额度，可增购
 *
 * 判断逻辑：
 *   - 返回 openDingId          → 权限已开放，DING 真的发出去了
 *   - errcode 60011 / 88       → 无调用权限 / 鉴权失败，需去开放平台后台申请
 *   - 提示额度不足             → 权限有但配额用尽，需增购
 *   - 其他                     → 打印原始响应人工判断
 *
 * 用法：
 *   1) DRY（默认）：只跑 gettoken + 组装请求体并打印，不真发
 *        node scripts/probe-dingtalk-ding-send.js
 *
 *   2) REAL：真发一条应用内 DING（会在接收人钉钉上弹出，请只发给自己）
 *        MODE=real TARGET_NAME=示例用户A node scripts/probe-dingtalk-ding-send.js
 *
 * 安全约束：只支持 remindType=1（应用内），短信/电话 DING 本探针一律不发。
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch (_) { /* 靠外部 env */ }

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db');
const MODE = (process.env.MODE || 'dry').toLowerCase();
const TARGET_NAME = process.env.TARGET_NAME || '示例用户A';
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || '';   // 不留默认回退值（2026-08-26 凭证泄露闭环·与 server.js 同 fail-closed 口径）
const DING_SEND_URL = 'https://api.dingtalk.com/v1.0/robot/ding/send';

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

function decrypt(enc) {

    if (Buffer.byteLength(ENCRYPTION_KEY, 'utf8') < 32) {

        console.error('[ABORT] 未设 DB_ENCRYPTION_KEY 或不足 32 字节。本脚本不提供默认回退值'

            + '（2026-08-26 凭证泄露闭环后与 server.js 同口径 fail-closed）。'

            + '请带与目标库一致的密钥执行：DB_ENCRYPTION_KEY=xxx node scripts/<本脚本>');

        process.exit(2);

    }
    const parts = enc.split(':');
    const dec = crypto.createDecipheriv('aes-256-cbc',
        Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), Buffer.from(parts[0], 'hex'));
    return dec.update(parts[1], 'hex', 'utf8') + dec.final('utf8');
}

(async () => {
    // 1. 凭证
    const cfg = {};
    for (const k of ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code']) {
        const row = await get('SELECT config_value_encrypted FROM system_configs WHERE config_key = ?', [k]);
        try { cfg[k] = row && row.config_value_encrypted ? decrypt(row.config_value_encrypted) : null; } catch (_) { cfg[k] = null; }
    }
    if (!cfg.dingtalk_app_key || !cfg.dingtalk_app_secret || !cfg.dingtalk_robot_code) {
        console.error('[ABORT] 钉钉凭证读取失败（DB_ENCRYPTION_KEY 与本库不匹配？）');
        process.exit(2);
    }
    console.log('凭证读取 OK（appKey/appSecret/robotCode 均已配置，值不打印）');

    // 2. 接收人
    const user = await get('SELECT id, display_name, dingtalk_user_id FROM users WHERE display_name = ?', [TARGET_NAME]);
    if (!user || !user.dingtalk_user_id) {
        console.error(`[ABORT] 用户「${TARGET_NAME}」不存在或没有 dingtalk_user_id`);
        process.exit(2);
    }
    console.log(`接收人：${user.display_name}（钉钉 userId 末 4 位 …${String(user.dingtalk_user_id).slice(-4)}）`);

    // 3. token
    const dingtalk = require(path.resolve(__dirname, '..', 'utils', 'dingtalk-notify.js'));
    const token = await dingtalk.getAccessToken(cfg.dingtalk_app_key, cfg.dingtalk_app_secret);
    console.log('gettoken OK');

    const body = {
        robotCode: cfg.dingtalk_robot_code,
        remindType: 1,                                   // 只发应用内 DING
        receiverUserIdList: [user.dingtalk_user_id],
        content: `【探针】迭代单派单提醒机制验证 —— 收到这条说明 DING 接口可用，无需处理。`
    };

    if (MODE !== 'real') {
        console.log('\n[DRY] 请求体（未发送，标识类字段已脱敏）：');
        console.log(JSON.stringify({ ...body, robotCode: '<robotCode>', receiverUserIdList: ['<userId>'] }, null, 2));
        console.log('\n真发请用：MODE=real node scripts/probe-dingtalk-ding-send.js');
        db.close();
        return;
    }

    // 4. 真发
    console.log('\n[REAL] 正在发送应用内 DING…');
    const resp = await fetch(DING_SEND_URL, {
        method: 'POST',
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 非 JSON 原样打印 */ }

    console.log('HTTP ' + resp.status);
    console.log('响应：' + text.slice(0, 800));

    if (json && json.openDingId) {
        console.log('\n[结论] DING 接口可用 —— openDingId=' + json.openDingId);
        if (Array.isArray(json.failedList) && json.failedList.length) {
            console.log('  但有失败接收人：' + JSON.stringify(json.failedList));
        }
    } else if (json && (json.code || json.errcode)) {
        const code = json.code || json.errcode;
        console.log('\n[结论] 调用被拒 —— code=' + code + ' message=' + (json.message || json.errmsg || ''));
        console.log('  60011/88/Forbidden 类 → 权限点未开，去开放平台后台申请「企业内机器人发送消息」相关权限');
        console.log('  额度/quota 类       → 权限有但 OpenAPI 发 DING 配额用尽，需增购');
    } else {
        console.log('\n[结论] 响应格式未识别，需人工判断（见上方原始响应）');
    }
    db.close();
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
