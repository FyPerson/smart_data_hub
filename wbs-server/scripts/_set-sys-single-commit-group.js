// _set-sys-single-commit-group.js（上线执行人多选与双确认 方案 v1.7 §10.3·C11·HRD 单组版本号）
//
// 一次性本地/生产 db 写入脚本：把 system_configs.sys_single_commit_group_systems 置为「不分前后端·单组
// 版本号」的系统清单（逗号串，例：'HRD' 或 'HRD,某系统'）。加密存，逐字对齐 server.js writeSystemConfig
// 的既有约定（本项目 system_configs 值一律走 encryptPassword 加密，即便像本清单这种非密钥语义的值也不
// 例外——防止 readSystemConfig 读到未加密串时 decryptPassword 抛错→静默 catch 归 null→误判"无命中系统"）。
//
// 用法：node scripts/_set-sys-single-commit-group.js "HRD"          （默认值即 HRD）
//       node scripts/_set-sys-single-commit-group.js "HRD,某系统"   （扩清单·admin 若要保留 HRD 须显式含 HRD）
//
// ⚠️ **本脚本非必须**：后端 loadSingleCommitGroupSystemSet 在 config 未写/为空时**回落代码默认 ['HRD']**，
//   即「初始值 HRD」无需部署日手工写库即生效。仅当需要**扩展清单**（HRD 之外再加系统）或显式改口径时才跑。
//   config 一旦写入即以 config 为准（replace 语义），故扩清单时务必把 HRD 一并写进去。
// ⚠️ 判定源单一：后端 isSingleCommitGroupSystem / loadSingleCommitGroupSystemSet 是唯一权威，前端只按
//   issue DTO（single_commit_group / group_label / allowed_components）渲染，改本 config 后前端自动跟随。

'use strict';
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

// 逐字复刻 server.js encryptPassword（ENCRYPTION_KEY 同源 env 或同一默认值——本地/生产用同一份约定）。
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';
const IV_LENGTH = 16;
function encryptPassword(password) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

const desired = (process.argv[2] || 'HRD').trim();
const dbPath = path.join(__dirname, '..', 'task_pool.db');
const db = new sqlite3.Database(dbPath);

const encrypted = encryptPassword(desired);
db.run(
  `INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name, updated_at)
   VALUES ('sys_single_commit_group_systems', ?, NULL, '_set-sys-single-commit-group.js', datetime('now','localtime'))
   ON CONFLICT(config_key) DO UPDATE SET
     config_value_encrypted = excluded.config_value_encrypted,
     updated_by = excluded.updated_by,
     updated_by_name = excluded.updated_by_name,
     updated_at = excluded.updated_at`,
  [encrypted],
  function (err) {
    if (err) { console.error('写入失败:', err.message); db.close(); process.exit(1); }
    console.log(`system_configs.sys_single_commit_group_systems 已写入 = '${desired}'（changes=${this.changes}）`);
    db.close();
  }
);
