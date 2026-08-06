// _set-sys-notify-dry-run.js（工期对接测试与风险等级拆分 方案 v1.1 §6·D16·C4b）
//
// 一次性本地 db 写入脚本：把 system_configs.sys_notify_dry_run 置为 'on'（加密存，逐字对齐
// server.js writeSystemConfig 的既有约定——本项目 system_configs 值一律走 encryptPassword 加密，
// 即便像本开关这种非密钥语义的布尔值也不例外，防止 readSystemConfig 读到未加密串时 decryptPassword
// 抛错→静默 catch 归 null→误判"关"）。
//
// 用法：node scripts/_set-sys-notify-dry-run.js [on|off]（缺省 on）
//
// ⚠️ 本地/生产观察期共用同一个开关键——生产库如临时开启做观察，观察结束务必手动跑
//   `node scripts/_set-sys-notify-dry-run.js off` 关闭，否则该通道会静默吞掉全部真实钉钉通知
//   （见 routes/sys-iteration/index.js notify-liaison-test 端点注释）。

'use strict';
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

// 逐字复刻 server.js:2696-2705（ENCRYPTION_KEY 同源 env 或同一默认值——本地/生产用同一份约定）。
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';
const IV_LENGTH = 16;
function encryptPassword(password) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

const desired = (process.argv[2] || 'on').trim().toLowerCase();
const dbPath = path.join(__dirname, '..', 'task_pool.db');
const db = new sqlite3.Database(dbPath);

const encrypted = encryptPassword(desired);
db.run(
  `INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name, updated_at)
   VALUES ('sys_notify_dry_run', ?, NULL, '_set-sys-notify-dry-run.js', datetime('now','localtime'))
   ON CONFLICT(config_key) DO UPDATE SET
     config_value_encrypted = excluded.config_value_encrypted,
     updated_by = excluded.updated_by,
     updated_by_name = excluded.updated_by_name,
     updated_at = excluded.updated_at`,
  [encrypted],
  function (err) {
    if (err) { console.error('写入失败:', err.message); db.close(); process.exit(1); }
    console.log(`system_configs.sys_notify_dry_run 已写入 = '${desired}'（changes=${this.changes}）`);
    db.close();
  }
);
