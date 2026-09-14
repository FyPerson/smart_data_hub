/**
 * 钉钉 userId → unionId 映射可行性探针（一次性，跑完可删）
 *
 * 背景：待办接口 POST /v1.0/todo/users/{unionId}/tasks 用 unionId 定位人，
 *      而本平台 users 表只存 dingtalk_user_id（由 user/get_by_mobile 拿到，该接口不返回 unionid）。
 *      在写「派单建待办」之前，先确认能不能用现有权限把 userId 换成 unionId，
 *      免得实施到一半才发现又要走一轮权限审批（同 DING/待办 权限探针的教训）。
 *
 * 试两条路：
 *   A. 老 TOP API   POST /topapi/v2/user/get         （access_token 在 query，body 传 userid）
 *   B. 新版通讯录   GET  /v1.0/contact/users/{userId}（token 在 header）
 *
 * 判读：任一条返回 unionId → 映射可行，实施时补一层缓存即可；
 *      两条都 403 → 需要再申请通讯录读取类权限。
 *
 * 只读调用，无副作用。
 * 用法：node scripts/probe-dingtalk-unionid.js [显示名，默认 示例用户A]
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch (_) { /* 靠外部 env */ }

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db');
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || '';   // 不留默认回退值（2026-08-26 凭证泄露闭环·与 server.js 同 fail-closed 口径）
const TARGET_NAME = process.argv[2] || '示例用户A';

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

// unionId 是人员标识，打印时只留末 4 位，避免整串落进日志
const mask = v => v ? '…' + String(v).slice(-4) : '(空)';

(async () => {
    const cfg = {};
    for (const k of ['dingtalk_app_key', 'dingtalk_app_secret']) {
        const row = await get('SELECT config_value_encrypted FROM system_configs WHERE config_key = ?', [k]);
        try { cfg[k] = row && row.config_value_encrypted ? decrypt(row.config_value_encrypted) : null; } catch (_) { cfg[k] = null; }
    }
    if (!cfg.dingtalk_app_key || !cfg.dingtalk_app_secret) {
        console.error('[ABORT] 钉钉凭证读取失败');
        process.exit(2);
    }

    const user = await get('SELECT display_name, dingtalk_user_id FROM users WHERE display_name = ?', [TARGET_NAME]);
    if (!user || !user.dingtalk_user_id) {
        console.error(`[ABORT] 用户「${TARGET_NAME}」不存在或无 dingtalk_user_id`);
        process.exit(2);
    }
    const userId = user.dingtalk_user_id;
    console.log(`目标：${user.display_name}（userId ${mask(userId)}）\n`);

    const dingtalk = require(path.resolve(__dirname, '..', 'utils', 'dingtalk-notify.js'));
    const token = await dingtalk.getAccessToken(cfg.dingtalk_app_key, cfg.dingtalk_app_secret);

    let unionId = null;

    // ---- 路 A：老 TOP API ----
    console.log('[A] POST /topapi/v2/user/get');
    try {
        const respA = await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userid: userId })
        });
        const a = await respA.json();
        if (a.errcode === 0 && a.result) {
            unionId = a.result.unionid || null;
            console.log('    OK errcode=0  unionid=' + mask(unionId) + '  name=' + (a.result.name || '-'));
        } else {
            console.log('    失败 errcode=' + a.errcode + ' errmsg=' + (a.errmsg || ''));
        }
    } catch (e) { console.log('    异常 ' + e.message); }

    // ---- 路 B：新版通讯录 ----
    console.log('\n[B] GET /v1.0/contact/users/{userId}');
    try {
        const respB = await fetch('https://api.dingtalk.com/v1.0/contact/users/' + encodeURIComponent(userId), {
            headers: { 'x-acs-dingtalk-access-token': token }
        });
        const textB = await respB.text();
        let b = null;
        try { b = JSON.parse(textB); } catch (_) { /* 原样 */ }
        console.log('    HTTP ' + respB.status);
        if (b && b.unionId) {
            console.log('    OK unionId=' + mask(b.unionId));
            if (!unionId) unionId = b.unionId;
        } else if (b && b.accessdenieddetail && b.accessdenieddetail.requiredScopes) {
            console.log('    权限不足，需要：' + JSON.stringify(b.accessdenieddetail.requiredScopes));
        } else {
            console.log('    响应：' + textB.slice(0, 300));
        }
    } catch (e) { console.log('    异常 ' + e.message); }

    console.log('\n[结论] ' + (unionId
        ? 'userId → unionId 映射可行，现有权限够用，实施时加一层缓存即可。'
        : '两条路都没拿到 unionId —— 需要再申请通讯录读取类权限，见上方 requiredScopes。'));
    db.close();
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
