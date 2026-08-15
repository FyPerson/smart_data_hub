'use strict';
// [codex 382-M3] sys_fast_release_executors「残缺库活体探针」——供 verify-sys-fastlane-two-phase.js
//   新增分组 execFile 调用。为什么需要它：verify-sys-fastlane-two-phase.js [1g] 只做**源码文本断言**
//   （读 index.js 源码，正则核对 `const checks = [...]` 数组字面量里含本表登记条目），这条断言测的是
//   "源码里写了没写"，不是"跑起来对不对"——codex 382-M3 指出这是运行时盲区：若后续改动把 checks
//   循环体改成 `checks.slice(0, -1)` 之类（漏跑数组最后一项，本表恰是最后一项），源码文本里那行数组
//   字面量原封不动、[1g] 正则照样匹配成功、误判"登记齐全"，但运行时该表的列级完整性检查根本不会被
//   执行——一张列缺失的残缺表会被 readiness 放行为 ready=true，sys-* 写入口在生产上正常对外提供服务，
//   直到真正写入 exec_status 列时才会以运行时 SQLITE 报错的形式炸穿，而不是启动期就挡下来。
//   本探针补的正是这层：不测"源码写了没写"，测"PRAGMA 复查这一步是否真的对本表执行了"。
//
//   为什么走子进程（同 _probe-fastlane-gate-disabled.js 头部注释同款理由）：routes/sys-iteration 工厂
//   在同一进程内二次实例化会 init 挂起（进程级单例状态·测试基建限制），干净进程单实例=与全部 verify
//   套件同构的已证可行路径，故不在 verify-sys-fastlane-two-phase.js 主进程里второй require。
//
//   手法：在同一个 :memory: db 连接上，**先于**工厂 initSchema() 之前，手工建一张"看起来是
//   sys_fast_release_executors 但故意漏了 exec_status 列"的残缺表。工厂 DDL 用的是
//   `CREATE TABLE IF NOT EXISTS`——遇到已存在的同名表是无操作（不会报错、也不会补列），所以这张残缺表
//   会原样存活到 checks 循环那一步。若 checks 循环真的对本表跑了 PRAGMA table_info 比对，会发现
//   exec_status 缺失，设 SYS_SCHEMA_STATE.error 并 return（ready 保持 false）；若循环被改坏成
//   "跳过最后一项不跑"，本表的缺列不会被发现，readiness 会一路推进到 ready=true——这正是本探针要拦的
//   回归。结果以单行 JSON 写 stdout，断言留在父套件做（探针只采集事实，同 gate-disabled 探针范式）。
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);

async function main() {
  // 手工建残缺表——比真实 DDL 少 exec_status 一列，其余列名/类型齐全（不影响其余表/其余列的正常建表，
  // 只污染这一张表本身，验证的是"这张表被检出"而非"其它表也遭殃"）。
  await run(`CREATE TABLE sys_fast_release_executors (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id          INTEGER NOT NULL,
    user_id           INTEGER NOT NULL,
    user_name         TEXT    NOT NULL,
    executed_at       DATETIME,
    added_by          INTEGER NOT NULL,
    added_by_name     TEXT    NOT NULL,
    created_at        DATETIME,
    removed_at        DATETIME,
    removed_by        INTEGER,
    removed_by_name   TEXT
  )`);   // exec_status 故意缺失（JS 行注释，非 SQL 注释——不写进模板字符串内部），本探针唯一的人为破坏点

  const mod = require('../routes/sys-iteration')({
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass,
    ...require('./_sys-attach-test-deps'),
  });

  mod.initSchema();

  // readiness 是异步收口的（同全部 verify 套件的 waitReady 范式），轮询到 ready 或 error 任一置位即止。
  await new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      const st = mod._internals.SYS_SCHEMA_STATE;
      if (st.ready || st.error) { clearInterval(t); resolve(); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时（探针本体，非父套件断言）')); }
    }, 10);
  });

  const st = mod._internals.SYS_SCHEMA_STATE;
  process.stdout.write(JSON.stringify({ ready: st.ready, error: st.error }));
  process.exit(0);
}

main().catch(e => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
