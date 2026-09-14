/**
 * 钉钉待办（Todo）接口权限探针（一次性，跑完可删）
 *
 * 目的：和 probe-dingtalk-ding-send.js 配套 —— DING 已探明缺 Premium.Ding.Write，
 *      既然要走一次 0.5-1 天审批，顺手把待办的权限点名称也探出来，一并申请。
 *
 * 手法：钉钉的权限校验发生在参数校验之前（DING 探针实证：403 权限错误先于参数错误返回），
 *      所以用一个占位 unionId 试调即可拿到确切的 requiredScopes，不会真创建待办。
 *
 * 接口：POST /v1.0/todo/users/{unionId}/tasks
 *      官方要求「待办应用中待办写权限」，2024-02 起 detailUrl 必填（只能创建工作待办）。
 *
 * 判读：
 *   - 403 + requiredScopes  → 权限未开，按返回的 scope 名去申请（预期结果）
 *   - 400 参数错误          → 权限已开，只是占位 unionId 不合法（说明可以直接用）
 *   - 其他                  → 打印原始响应人工判断
 *
 * 用法：node scripts/probe-dingtalk-todo-permission.js
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch (_) { /* 靠外部 env */ }

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db');
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || '';   // 不留默认回退值（2026-08-26 凭证泄露闭环·与 server.js 同 fail-closed 口径）
const PLACEHOLDER_UNION_ID = 'probeOnlyPlaceholderUnionId';

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
    const cfg = {};
    for (const k of ['dingtalk_app_key', 'dingtalk_app_secret']) {
        const row = await get('SELECT config_value_encrypted FROM system_configs WHERE config_key = ?', [k]);
        try { cfg[k] = row && row.config_value_encrypted ? decrypt(row.config_value_encrypted) : null; } catch (_) { cfg[k] = null; }
    }
    if (!cfg.dingtalk_app_key || !cfg.dingtalk_app_secret) {
        console.error('[ABORT] 钉钉凭证读取失败');
        process.exit(2);
    }

    const dingtalk = require(path.resolve(__dirname, '..', 'utils', 'dingtalk-notify.js'));
    const token = await dingtalk.getAccessToken(cfg.dingtalk_app_key, cfg.dingtalk_app_secret);
    console.log('gettoken OK，开始试调待办创建接口（占位 unionId，不会真建待办）…\n');

    const url = 'https://api.dingtalk.com/v1.0/todo/users/' + PLACEHOLDER_UNION_ID + '/tasks';
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            subject: '【探针】权限校验，不会真建',
            detailUrl: { appUrl: 'https://example.invalid/probe', pcUrl: 'https://example.invalid/probe' }
        })
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 原样打印 */ }

    console.log('HTTP ' + resp.status);
    console.log('响应：' + text.slice(0, 800) + '\n');

    const scopes = json && json.accessdenieddetail && json.accessdenieddetail.requiredScopes;
    if (resp.status === 403 && scopes) {
        console.log('[结论] 待办权限未开，需申请的权限点：' + JSON.stringify(scopes));
        if (json.message) console.log('  钉钉给的申请入口：' + json.message);
    } else if (resp.status === 400) {
        console.log('[结论] 权限看起来已开（返回的是参数错误而非权限错误）——真正实施时只差 unionId 映射。');
    } else {
        console.log('[结论] 响应未识别，人工判断上方原始响应。');
    }
    db.close();
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
