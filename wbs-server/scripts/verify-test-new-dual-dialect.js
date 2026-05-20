// 一次性脚本：验证 v1.69.1 admin /db-connections/test-new 双方言分派
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB = path.join(__dirname, '..', 'task_pool.db');
const SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';

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
