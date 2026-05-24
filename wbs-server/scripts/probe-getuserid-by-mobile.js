/**
 * F1 真跑辅助：通过手机号反查钉钉 userid（一次性临时脚本，跑完可删）
 *
 * 用途：v1.71.0 F1 加人探针需要沈倩静的钉钉 userid（DB 里没存）
 *      通过钉钉 topapi/v2/user/getbymobile 接口反查
 *
 * 用法：
 *   MOBILE=15088670435 node e:/tmp/probe-getuserid-by-mobile.js
 *
 * 输出：钉钉 userid（或失败原因）
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const DB_PATH = process.env.DB_PATH || 'e:/数据开发与治理规范手册/wbs-server/task_pool.db';
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';
const MOBILE = process.env.MOBILE || '';

if (!MOBILE) {
    console.error('[FAIL] 需 MOBILE 环境变量');
    process.exit(1);
}

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
            try { resolve(decryptPassword(row.config_value_encrypted)); }
            catch (e) { reject(new Error(`decrypt ${key} failed: ${e.message}`)); }
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
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
    let appKey, appSecret;
    try {
        appKey = await readConfig(db, 'dingtalk_app_key');
        appSecret = await readConfig(db, 'dingtalk_app_secret');
    } finally { db.close(); }

    if (!appKey || !appSecret) {
        console.error('[FAIL] 缺凭证');
        process.exit(2);
    }

    const tkUrl = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`;
    const tk = await httpJson(tkUrl);
    if (tk.body.errcode !== 0) {
        console.error(`[FAIL] gettoken: ${tk.body.errcode} ${tk.body.errmsg}`);
        process.exit(3);
    }
    const accessToken = tk.body.access_token;
    console.log(`[OK] access_token=${accessToken.slice(0, 8)}...`);

    // 调 getbymobile（新版 topapi/v2）
    const url = `https://oapi.dingtalk.com/topapi/v2/user/getbymobile?access_token=${encodeURIComponent(accessToken)}`;
    console.log(`[INFO] 查询手机号 ${MOBILE.slice(0, 3)}****${MOBILE.slice(-4)}`);
    const resp = await httpJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile: MOBILE })
    });
    console.log(`HTTP=${resp.status}`);
    console.log(JSON.stringify(resp.body, null, 2));

    if (resp.body.errcode === 0 && resp.body.result && resp.body.result.userid) {
        console.log('');
        console.log(`[OK]   钉钉 userid = ${resp.body.result.userid}`);
    } else {
        console.error('');
        console.error(`[FAIL] errcode=${resp.body.errcode} errmsg=${resp.body.errmsg}`);
        console.error('       可能：① 该手机号不在企业通讯录 ② 应用未开通 通讯录管理 权限');
    }
})().catch(err => {
    console.error('[FATAL]', err.message);
    process.exit(1);
});
