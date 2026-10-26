/**
 * 口令 / 凭证 AES-256-CBC 加解密（可传键的纯函数）。
 *
 * 抽自 server.js 的 encryptPassword / decryptPassword（#106 S1a · 偏差 B1）：算法、密钥派生、IV 规则与原实现逐字节一致——
 *   key  = Buffer.from(KEY.padEnd(32).slice(0, 32))
 *   iv   = crypto.randomBytes(16)
 *   密文 = iv(hex) + ':' + aes-256-cbc(utf8 → hex)
 * 正常模式下 server.js 传进程的 DB_ENCRYPTION_KEY；隔离模式传下面的固定隔离专用键。
 * 隔离库的虚拟凭证（钉钉四项）由 S1b 的建库助手用 encryptWithKey(ISOLATED_ENCRYPTION_KEY, …) 写入，
 * 外部库口令（db_connections）保持真键密文——隔离键解不出原文（换键解密多数情况抛错，但 CBC 下约 1/256 的概率恰好
 * 通过填充校验而「解出」一串乱码，所以只能说解不出原文，不保证抛错），且外部库创建点在隔离模式先抛 EXTERNAL_DISABLED。
 */
'use strict';

const crypto = require('crypto');

const IV_LENGTH = 16;

// 隔离模式专用固定键：不是机密（隔离库里只有虚拟凭证），故意写成代码常量，保证「隔离实例不依赖进程的 DB_ENCRYPTION_KEY」。
// 长度 ≥ 32 字节；派生口径与 server.js 的 ENCRYPTION_KEY 相同（padEnd(32).slice(0, 32)）。
const ISOLATED_ENCRYPTION_KEY = 'sdh-isolated-instance-key-not-a-secret-v1';

function deriveKey(key) {
    return Buffer.from(String(key).padEnd(32).slice(0, 32));
}

function encryptWithKey(key, plain) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(key), iv);
    let encrypted = cipher.update(plain, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decryptWithKey(key, encryptedText) {
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(key), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

module.exports = { IV_LENGTH, ISOLATED_ENCRYPTION_KEY, encryptWithKey, decryptWithKey };
