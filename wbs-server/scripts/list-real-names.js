// list-real-names.js — 输出 users 表全量真实姓名 + 手机号（JSON / UTF-8）
//
// 用途：sync-to-github.ps1 脱敏「完整性预检」的真相源。
//   users 表是平台所有真名/真实手机号的权威来源；任一真名/手机号若未在
//   sync-to-github.ps1 的 $nameMap / $phoneMap 配置脱敏规则，预检即 fail-fast 报警，
//   根治「新员工入职→真名/手机号硬编码进代码→漏脱敏泄漏」的反复（2026-06-17 建立）。
//
// 输出（stdout，单行 JSON，UTF-8）：
//   {"names":["..."],"phones":["..."]}
//   · names  = display_name（去重、TRIM、非空、排除内置 admin 的「管理员」角色名）
//   · phones = username 或 phone 列中符合 11 位手机格式 1[3-9]\d{9} 的去重集合
//
// 本脚本只读取真名/手机号、自身不含任何真名，可安全进公开镜像。
//
// 用法：node list-real-names.js [dbPath]
//   dbPath 缺省 = 同级上层 task_pool.db（wbs-server/task_pool.db）
// 退出码：0 正常 / 2 打开或查询失败（PS 侧据此 fail-fast 或按 -SkipNameAudit 降级）

const path = require('path');
const sqlite3 = require('sqlite3');

const dbPath = process.argv[2] || path.join(__dirname, '..', 'task_pool.db');
const PHONE_RE = /^1[3-9]\d{9}$/;   // 中国大陆 11 位手机号

const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('[list-real-names] 打开数据库失败:', err.message);
    process.exit(2);
  }
});

// 稳健排除内置 admin：按 id=1 或 username='admin'（不靠 display_name='管理员' 文本匹配，
// 避免空格/角色名变体误判）；真实员工无论角色都保留。
db.all(
  "SELECT id, username, display_name, phone FROM users WHERE NOT (id = 1 OR username = 'admin')",
  (err, rows) => {
    if (err) {
      console.error('[list-real-names] 查询失败:', err.message);
      process.exit(2);
    }
    const names = new Set();
    const phones = new Set();
    for (const r of rows) {
      const dn = (r.display_name == null ? '' : String(r.display_name)).trim();
      if (dn && dn !== '管理员') names.add(dn);   // 双保险：再挡一道角色名
      for (const v of [r.username, r.phone]) {
        const s = (v == null ? '' : String(v)).trim();
        if (PHONE_RE.test(s)) phones.add(s);
      }
    }
    process.stdout.write(JSON.stringify({
      names: Array.from(names),
      phones: Array.from(phones),
    }));
    db.close();
  }
);
