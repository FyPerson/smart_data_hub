/**
 * 钉钉解散群 API 探针（一次性，跑完可删）
 *
 * 在已有 chat/create 权限的前提下，依次试 3 个候选端点找出哪个能解散通过 chat/create 创建的群。
 *
 * 用法：
 *   1) 先建一个测试群，拿 chatid + openConversationId（运行 probe-dingtalk-chat-create.js 的 REAL_RUN）
 *   2) 设置环境变量后跑：
 *      CHATID=xxx OPEN_CONV_ID=xxx node scripts/probe-dingtalk-disband.js
 *
 * 候选端点：
 *   A) https://oapi.dingtalk.com/chat/dismiss  （和 chat/create 同级，最大可能）
 *   B) https://api.dingtalk.com/v1.0/im/chat/scenegroups/dismiss  （场景群新版 OpenAPI）
 *   C) https://api.dingtalk.com/v1.0/im/sceneGroups（POST DELETE method）
 *
 * 关联：docs/local/数据协作模块_方案_v2.0.md（拉起群聊功能调研，2026-05-20）
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db');
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';
const GETTOKEN_URL = 'https://oapi.dingtalk.com/gettoken';

const CHATID = process.env.CHATID || '';
const OPEN_CONV_ID = process.env.OPEN_CONV_ID || '';

function decryptPassword(encryptedPassword) {
    const parts = encryptedPassword.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

async function readConfig(db, key) {
    return new Promise((resolve, reject) => {
        db.get('SELECT config_value_encrypted FROM system_configs WHERE config_key = ?', [key], (err, row) => {
            if (err) return reject(err);
            if (!row || !row.config_value_encrypted) return resolve(null);
            try { resolve(decryptPassword(row.config_value_encrypted)); }
            catch (e) { reject(e); }
        });
    });
}

async function httpJson(url, init) {
    const resp = await fetch(url, init);
    const text = await resp.text();
    try { return { status: resp.status, body: JSON.parse(text) }; }
    catch { return { status: resp.status, body: { raw: text } }; }
}

(async () => {
    console.log('='.repeat(70));
    console.log('钉钉解散群 API 探针');
    console.log('='.repeat(70));

    if (!CHATID && !OPEN_CONV_ID) {
        console.error('[FAIL] 需提供 CHATID 和/或 OPEN_CONV_ID 环境变量');
        console.error('       请先跑 probe-dingtalk-chat-create.js REAL_RUN 创建测试群拿到 id');
        process.exit(1);
    }

    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
    let appKey, appSecret;
    try {
        appKey = await readConfig(db, 'dingtalk_app_key');
        appSecret = await readConfig(db, 'dingtalk_app_secret');
    } finally { db.close(); }

    const tk = await httpJson(`${GETTOKEN_URL}?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`);
    if (tk.body.errcode !== 0) {
        console.error('[FAIL] gettoken 失败:', tk.body);
        process.exit(2);
    }
    const accessToken = tk.body.access_token;
    console.log(`[OK] access_token=${accessToken.slice(0, 8)}...`);
    console.log(`[INFO] CHATID=${CHATID || '(未提供)'}`);
    console.log(`[INFO] OPEN_CONV_ID=${OPEN_CONV_ID || '(未提供)'}`);
    console.log('');

    // ====== 候选 A: oapi.dingtalk.com/chat/dismiss ======
    if (CHATID) {
        console.log('--- 候选 A: POST oapi.dingtalk.com/chat/dismiss ---');
        const a = await httpJson(`https://oapi.dingtalk.com/chat/dismiss?access_token=${encodeURIComponent(accessToken)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatid: CHATID })
        });
        console.log(JSON.stringify(a.body, null, 2));
        if (a.body.errcode === 0) {
            console.log('[VERDICT-A] ✅ 端点 A 解散成功');
            return;
        }
        console.log('');
    }

    // ====== 候选 B: api.dingtalk.com/v1.0/im/chat/scenegroups/dismiss ======
    if (OPEN_CONV_ID) {
        console.log('--- 候选 B: POST api.dingtalk.com/v1.0/im/chat/scenegroups/dismiss ---');
        const b = await httpJson(`https://api.dingtalk.com/v1.0/im/chat/scenegroups/dismiss`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-acs-dingtalk-access-token': accessToken
            },
            body: JSON.stringify({ openConversationId: OPEN_CONV_ID })
        });
        console.log(JSON.stringify(b.body, null, 2));
        if (b.status === 200 && !b.body.code) {
            console.log('[VERDICT-B] ✅ 端点 B 解散成功');
            return;
        }
        console.log('');
    }

    // ====== 候选 C: api.dingtalk.com/v1.0/im/sceneGroups (POST disband) ======
    if (OPEN_CONV_ID) {
        console.log('--- 候选 C: POST api.dingtalk.com/v1.0/im/sceneGroups/disband ---');
        const c = await httpJson(`https://api.dingtalk.com/v1.0/im/sceneGroups/disband`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-acs-dingtalk-access-token': accessToken
            },
            body: JSON.stringify({ openConversationId: OPEN_CONV_ID })
        });
        console.log(JSON.stringify(c.body, null, 2));
        if (c.status === 200 && !c.body.code) {
            console.log('[VERDICT-C] ✅ 端点 C 解散成功');
            return;
        }
        console.log('');
    }

    console.log('[VERDICT] ⚠️  所有候选端点都没成功 —— 群可能需手动解散');
    console.log('           OPEN_CONV_ID =', OPEN_CONV_ID);
    console.log('           CHATID       =', CHATID);
})().catch(err => {
    console.error('[FATAL]', err.message);
    process.exit(1);
});
