// 一次性脚本：验证 v1.69.1 admin /db-connections/test-new 双方言分派
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB = path.join(__dirname, '..', 'task_pool.db');
const SECRET = process.env.JWT_SECRET;   // [#82 2026-09-16] 原硬编码回退值已删（字面量不复述）；本脚本已加载 .env，该回退值本就是死代码
// [#76 2026-09-16] DB_ENCRYPTION_KEY fail-closed，逐字复刻 server.js:2784-2790 约定：**不留任何
//   默认回退值**。原硬编码回退值已删（字面量刻意不在注释里复述——复述等于再留一份坏样板，
//   让后来者 grep 到还以为在用）。2026-08-26 凭证泄露闭环当时
//   只改了 server.js，scripts/ 整目录漏扫（[[feedback_pattern_sweep_not_symptom_list]] 同款复发）。
const KEY = process.env.DB_ENCRYPTION_KEY;
if (!KEY || KEY.length < 32) {
  console.error('[FATAL] 环境变量 DB_ENCRYPTION_KEY 未设置或长度不足 32 字节。');
  console.error('        ⚠️ 本脚本读写的是既有加密数据：请恢复该库对应的密钥，不要随手生成新值');
  console.error('           （新密钥解不开既有密文，还会在同一个库里混入用不同密钥加密的值）。');
  console.error('        仅首次初始化独立测试库时才生成: openssl rand -base64 32 | cut -c1-32');
  process.exit(1);
}
// [codex 571-M2] 上面的 .length 是 UTF-16 字符数、不是字节数——含非 ASCII 的密钥可能凑够 32 个
//   "字符"却通不过 createCipheriv 的真实字节要求。派生逻辑（padEnd(32).slice(0,32)）保持与
//   server.js 逐字同款不动，这里只在校验层追加一道防线，与 _set-sys-single-commit-group.js 同口径。
if (!/^[!-~]+$/.test(KEY) || Buffer.byteLength(KEY, 'utf8') < 32) {
  console.error('[FATAL] DB_ENCRYPTION_KEY 须为 ≥32 字节的 ASCII 可打印字符（与 server.js 同一派生口径）');
  process.exit(1);
}

function dec(s) {
    const p = s.split(':');
    const iv = Buffer.from(p[0], 'hex');
    const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(KEY.padEnd(32).slice(0, 32)), iv);
    let r = d.update(p[1], 'hex', 'utf8');
    return r + d.final('utf8');
}

function dbGet(sql, params = []) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB, sqlite3.OPEN_READONLY);
        db.get(sql, params, (e, r) => { db.close(); e ? rej(e) : res(r); });
    });
}

async function call(token, body) {
    const r = await fetch('http://localhost:3000/api/db-connections/test-new', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
}

(async () => {
    const u = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=1');
    const token = jwt.sign(u, SECRET, { expiresIn: '1h' });
    console.log('admin token ready, id=' + u.id);

    // BMS sqlserver 凭证
    const bms = await dbGet('SELECT username, password, host, port, database FROM db_connections WHERE id=2');
    const bmsPw = dec(bms.password);
    console.log('\n--- T1: type=sqlserver, BMS 凭证（应成功）---');
    let r1 = await call(token, { type: 'sqlserver', host: bms.host, port: bms.port, database: bms.database, username: bms.username, password: bmsPw });
    console.log(`status=${r1.status} body=${JSON.stringify(r1.body)}`);

    // HRD mysql 凭证
    const hrdCfgPath = path.join(__dirname, '..', '..', 'mcp-hrd', 'config.json');
    if (!fs.existsSync(hrdCfgPath)) {
        console.log('\n[SKIP] HRD config not found at ' + hrdCfgPath);
    } else {
        const hrdRaw = JSON.parse(fs.readFileSync(hrdCfgPath, 'utf8'));
        const hrd = hrdRaw.hrd || hrdRaw;  // 兼容嵌套 { hrd: {...} } 和扁平结构
        console.log('\n--- T2: type=mysql, HRD 凭证 host=' + hrd.host + ' port=' + hrd.port + '（应成功）---');
        let r2 = await call(token, { type: 'mysql', host: hrd.host, port: hrd.port, database: hrd.database, username: hrd.user, password: hrd.password });
        console.log(`status=${r2.status} body=${JSON.stringify(r2.body)}`);

        console.log('\n--- T3: type=mysql, 故意端口错（应失败）---');
        let r3 = await call(token, { type: 'mysql', host: hrd.host, port: 9999, database: hrd.database, username: hrd.user, password: hrd.password });
        console.log(`status=${r3.status} body=${JSON.stringify(r3.body)}`);
    }

    console.log('\n--- T4: type 缺省（应走 sqlserver 兼容老前端）---');
    let r4 = await call(token, { host: bms.host, port: bms.port, database: bms.database, username: bms.username, password: bmsPw });
    console.log(`status=${r4.status} body=${JSON.stringify(r4.body)}`);
})().catch(e => { console.error(e); process.exit(1); });
