/**
 * 钉钉待办「派单提醒」端到端效果探针（一次性，跑完可删）
 *
 * 目的：权限已开通，unionId 映射也已验证可行。本探针真建一条待办给指定的人（默认发给自己），
 *      让人亲眼看到「迭代单派单 → 钉钉待办」在客户端的实际形态与打扰程度，
 *      再决定方案里「待办为主、DING 为辅」的判断是否成立。
 *
 * 链路（全部已用探针验证过）：
 *   users.dingtalk_user_id
 *     → POST /topapi/v2/user/get            取 unionId（现有权限即可，无需 Contact.User.Read）
 *     → POST /v1.0/todo/users/{unionId}/tasks  建待办（需 Todo.Todo.Write，已开通）
 *
 * 关键字段按真实派单场景填：
 *   subject      —— 待办标题，模拟「迭代单指派」
 *   dueTime      —— 截止时间（毫秒时间戳），钉钉会自己在到期前提醒
 *   detailUrl    —— 点待办跳回平台单据页；2024-02 起为必填
 *   priority     —— 30 = 紧急
 *   notifyConfigs.dingNotify = '1'  —— 建待办时附带一次应用内 DING
 *
 * 用法：
 *   预览（不建）：node scripts/probe-dingtalk-todo-create.js
 *   真建：       MODE=real node scripts/probe-dingtalk-todo-create.js [显示名] [单据ID]
 *   删除：       MODE=delete TASK_ID=xxx node scripts/probe-dingtalk-todo-create.js [显示名]
 *
 * 注意：dingNotify=1 会额外触发一次应用内 DING，真建时会同时收到待办和 DING 各一条。
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch (_) { /* 靠外部 env */ }

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db');
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || '';   // 不留默认回退值（2026-08-26 凭证泄露闭环·与 server.js 同 fail-closed 口径）
const MODE = (process.env.MODE || 'dry').toLowerCase();
const TASK_ID = process.env.TASK_ID || '';
const TARGET_NAME = process.argv[2] || '示例用户A';
const ISSUE_ID = process.argv[3] || '';

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
const mask = v => v ? '…' + String(v).slice(-4) : '(空)';

(async () => {
    const cfg = {};
    for (const k of ['dingtalk_app_key', 'dingtalk_app_secret', 'platform_base_url']) {
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

    const dingtalk = require(path.resolve(__dirname, '..', 'utils', 'dingtalk-notify.js'));
    const token = await dingtalk.getAccessToken(cfg.dingtalk_app_key, cfg.dingtalk_app_secret);

    // 1. userId → unionId
    const uResp = await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userid: user.dingtalk_user_id })
    });
    const uJson = await uResp.json();
    if (uJson.errcode !== 0 || !uJson.result || !uJson.result.unionid) {
        console.error('[ABORT] 取 unionId 失败：errcode=' + uJson.errcode + ' ' + (uJson.errmsg || ''));
        process.exit(2);
    }
    const unionId = uJson.result.unionid;
    console.log(`目标：${user.display_name}（unionId ${mask(unionId)}）`);

    // 删除模式：清理探针留下的待办
    if (MODE === 'delete') {
        if (!TASK_ID) { console.error('[ABORT] 删除需传 TASK_ID=xxx'); process.exit(2); }
        const delResp = await fetch(
            'https://api.dingtalk.com/v1.0/todo/users/' + encodeURIComponent(unionId) + '/tasks/' + encodeURIComponent(TASK_ID),
            { method: 'DELETE', headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' } });
        console.log('删除 HTTP ' + delResp.status + '：' + (await delResp.text()).slice(0, 300));
        db.close();
        return;
    }

    // 2. 组装待办（模拟真实派单）
    const base = cfg.platform_base_url || '';
    const detail = base
        ? base + '/Sys_Iteration.html' + (ISSUE_ID ? '?issue=' + encodeURIComponent(ISSUE_ID) : '')
        : 'https://example.invalid/no-base-url';
    const due = new Date();
    due.setDate(due.getDate() + 1);
    due.setHours(18, 0, 0, 0);                                   // 明天 18:00 截止

    const body = {
        subject: '【探针】迭代单指派：请回填预计完成时间' + (ISSUE_ID ? '（单号 ' + ISSUE_ID + '）' : ''),
        description: '这是「派单未读升级」方案的效果预览，收到后可直接完成或删除，无需真的处理。\n'
            + '真实场景下这里会写单号、类型、系统、标题。',
        dueTime: due.getTime(),
        priority: 30,                                            // 30=紧急
        detailUrl: { appUrl: detail, pcUrl: detail },
        notifyConfigs: { dingNotify: '1' }                       // 建待办时附带应用内 DING
    };

    if (MODE !== 'real') {
        console.log('\n[DRY] 将要创建的待办（未发送）：');
        console.log(JSON.stringify(body, null, 2));
        console.log('\n截止时间解析：' + due.toLocaleString('zh-CN'));
        console.log('真建请用：MODE=real node scripts/probe-dingtalk-todo-create.js');
        db.close();
        return;
    }

    // 3. 真建
    console.log('\n[REAL] 正在创建待办…');
    const resp = await fetch('https://api.dingtalk.com/v1.0/todo/users/' + encodeURIComponent(unionId) + '/tasks', {
        method: 'POST',
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* 原样 */ }
    console.log('HTTP ' + resp.status);
    console.log('响应：' + text.slice(0, 600));

    if (json && json.id) {
        console.log('\n[结论] 待办创建成功，taskId=' + json.id);
        console.log('  看完效果后可删除：');
        console.log('  MODE=delete TASK_ID=' + json.id + ' node scripts/probe-dingtalk-todo-create.js ' + TARGET_NAME);
    } else if (json && json.accessdenieddetail) {
        console.log('\n[结论] 权限不足：' + JSON.stringify(json.accessdenieddetail.requiredScopes || []));
    } else {
        console.log('\n[结论] 未识别响应，人工判断上方内容。');
    }
    db.close();
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
