/**
 * R1 对账表结构 verify · 信息化资产轻量台账 P10 对账族（长任务 D）
 * 方案 docs/local/信息化资产_轻量版/信息化资产轻量台账_方案_20260918_v0.7.md
 *   §2.8/§2.9/§2.9.1（约束归属）/§6「P10 结构增量（幂等+原子）」/§7b.0 normalizeReconcileKey/
 *   §7b.1 result 十值/§7b.2 四种字段形态/§13「verify-it-reconcile.js 初始化（2 组）」
 * 执行 agent spec docs/local/信息化资产_轻量版/_agent_specs/R1_对账表结构_spec.md §3
 *
 * 本 commit 只交付「初始化 2 组」（幂等 / 结构事务原子性）+ 列级对拍 + CHECK 正负向 +
 * normalizeReconcileKey 七步 + 索引存在性核验——不实现任何对账端点，不做匹配/分类/状态机测试
 * （那些留给 R2/R3 各自的 verify 落地）。
 *
 * 写法照 verify-it-ledger.js：临时 db 文件、enableTestHooks:true、结构化判据、try/finally、
 * withTimeout/awaitSettle 统一超时出口（禁裸 await、禁 sleep 猜时序）。
 *
 * 用法：node scripts/verify-it-reconcile.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const TEST_DB = path.join(os.tmpdir(), `it-reconcile-verify-${Date.now()}-${process.pid}.db`);
const TEST_DB2 = path.join(os.tmpdir(), `it-reconcile-verify2-${Date.now()}-${process.pid}.db`);
const TEST_DB3 = path.join(os.tmpdir(), `it-reconcile-verify3-${Date.now()}-${process.pid}.db`);

let pass = 0, fail = 0;
const results = [];
const observations = [];
function check(name, cond, detail) {
  observations.push({name,ok:!!cond});
  if (cond) { pass++; results.push(`[OK] ${name}`); }
  else { fail++; results.push(`[FAIL] ${name}${detail ? ' · ' + String(detail) : ''}`); }
}

// 同 verify-it-ledger.js T5：致命退出前打印当前 PASS/FAIL 汇总与临时库路径，不留痕。
function fatalExit(label, detail) {
  check(label, false, detail);
  console.error(`[FATAL] ${label}${detail ? ' · ' + String(detail) : ''}——终止 verify 进程`);
  console.error(`[FATAL] 当前汇总 PASS=${pass} FAIL=${fail}`);
  console.error(`[FATAL] TEST_DB=${TEST_DB} TEST_DB2=${TEST_DB2}（临时文件留待人工清理，本进程不再尝试删除）`);
  process.exit(1);
}

// 同 verify-it-ledger.js T2：给任意 Promise 套超时，不改变正常 resolve/reject 的结果。
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label}超时(>${ms}ms)`), { __timeout: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 同 verify-it-ledger.js T1（17-R6T HIGH 必修）：任何"等一个操作 Promise 落定"的裸 await 都不许
// 直接 await——必须套超时，失败/超时一律 fatalExit（打印 PASS/FAIL 汇总）。
async function awaitSettle(promise, ms, label) {
  try {
    return await withTimeout(promise, ms, label);
  } catch (e) {
    // 17-R8T L1同款回补：区分真超时(__timeout:true)与目标Promise本身提前reject(普通拒绝)。
    if (e && e.__timeout) {
      fatalExit(`${label}: 等待落定超时`, e && e.message);
    } else {
      fatalExit(`${label}: 等待落定时目标Promise本身reject(非超时)`, e && (e.stack || e.message));
    }
    return undefined;
  }
}

// 同 verify-it-ledger.js T2：等待一个"到达"信号的统一助手（本 commit 暂未用到可等待闸场景，
// 但按派单前言"必须复用同款助手"要求原样带上，供 R2/R3 在本文件续写并发/闸相关用例时直接用）。
async function awaitArrived(arrivedPromise, label, opPromise) {
  const racers = [arrivedPromise.then(() => ({ kind: 'arrived' }))];
  if (opPromise) {
    racers.push(opPromise.then(
      (v) => (v && v.ok === false)
        ? { kind: 'earlyFail', earlyFail: (v.e || v.err || new Error('结构化失败结果(ok:false)')) }
        : (v && Object.prototype.hasOwnProperty.call(v, '__err'))
          ? { kind: 'earlyFail', earlyFail: (v.__err || new Error('结构化失败结果(__err)')) }
          : { kind: 'earlyDone', value: v },
      (e) => ({ kind: 'earlyFail', earlyFail: e })
    ));
  }
  let result;
  try {
    result = await withTimeout(Promise.race(racers), 3000, `${label} 到达信号`);
  } catch (e) {
    fatalExit(`${label}: 到达信号超时`, e && e.message);
    return;
  }
  if (result && result.kind === 'earlyFail') {
    fatalExit(`${label}: 对应操作在到达信号之前提前失败`, result.earlyFail && (result.earlyFail.stack || result.earlyFail.message));
  }
  if (result && result.kind === 'earlyDone') {
    fatalExit(`${label}: 对应操作在到达信号之前就已正常结束(时序假设不成立)`, JSON.stringify(result.value));
  }
}

// 同 verify-it-ledger.js T1：确定性调度屏障（两次 setImmediate），本 commit 暂未用到。
async function schedulingBarrier() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

const logger = {
  info: () => {},
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

// 同 verify-it-ledger.js（probeClosedDb，codex 19预筛 M1 回补）：对一条连接发真实查询，能
// 证明它确实已关闭（而不是把任何异常都当"已关闭"证据）。返回结构化 {ok, closed, reason}：
// - 引用无效（null/undefined/无 .get 方法）→ {ok:false, closed:false}（探针本身不可信,判fail）
// - 查询成功 → {ok:true, closed:false}（证明未关闭）
// - 查询失败且错误消息命中驱动明确的"已关闭"语义(SQLITE_MISUSE 或含"Database is closed"/
//   "SQLITE_MISUSE") → {ok:true, closed:true}（证明已关闭）
// - 查询失败但错误消息不属于上述已知关闭语义 → {ok:false, closed:false}（探针判fail，不臆断）
async function probeClosedDb(db) {
  if (!db || typeof db.get !== 'function') {
    return { ok: false, closed: false, reason: 'invalid_db_reference' };
  }
  try {
    await new Promise((resolve, reject) => {
      db.get('SELECT 1', (err) => (err ? reject(err) : resolve()));
    });
    return { ok: true, closed: false, reason: null };
  } catch (e) {
    const msg = (e && e.message) || '';
    // codex 19-R MED-2 回补：只认"Database is closed"这类明确关闭消息为主判据；SQLITE_MISUSE
    //   仅作辅助，且必须同时命中"is closed"这个词组本身（不是裸子串"closed"——"not closed
    //   reason"这种否定句式也含"closed"三个字母连在一起，裸子串匹配会被这种adversarial消息
    //   骗过；要求"is closed"作为一个词组出现，"not closed reason"里没有这个词组，能正确排除）。
    const isExplicitClosedMessage = /database is closed/i.test(msg);
    const isMisuseWithClosedHint = /SQLITE_MISUSE/i.test(msg) && /\bis\s+closed\b/i.test(msg);
    if (isExplicitClosedMessage || isMisuseWithClosedHint) {
      return { ok: true, closed: true, reason: msg };
    }
    return { ok: false, closed: false, reason: `未知错误(非已知关闭语义): ${msg}` };
  }
}

// codex 18预筛 MED-4/MED-5 回补：提交前失败四种场景共用的六项断言——列定义快照逐列对拍 /
// 行数据快照(全新库均为0行) / 两表不存在 / 三索引不存在 / 503 LEDGER_UNAVAILABLE / 连接已关闭
// (probeClosedDb)。baselineAssetCols 传入一份已独立验证过的"31列C1原状"快照（来自组2 part①
// 的真实 ROLLBACK 结果，而非手写猜测——避免手写 dflt_value 引号格式猜错）。
async function assertPrecommitRollbackIntact(mod, dbFile, label, baselineAssetCols) {
  const actualCols = normalizeCols(await rawAllOn(dbFile, 'PRAGMA table_info(it_assets)'));
  check(`${label}: it_assets列定义快照与基线(组2 part①)逐列全等`,
    JSON.stringify(actualCols) === JSON.stringify(baselineAssetCols),
    `actual=${JSON.stringify(actualCols)} baseline=${JSON.stringify(baselineAssetCols)}`);
  const rows = await rawAllOn(dbFile, 'SELECT * FROM it_assets');
  check(`${label}: it_assets行数据快照为空(全新库,0行)`, rows.length === 0, JSON.stringify(rows));
  const tables = (await rawAllOn(dbFile, "SELECT name FROM sqlite_master WHERE type='table'")).map((t) => t.name);
  check(`${label}: it_reconciles/it_reconcile_items均不存在`,
    !tables.includes('it_reconciles') && !tables.includes('it_reconcile_items'), JSON.stringify(tables));
  const idx = (await rawAllOn(dbFile, "SELECT name FROM sqlite_master WHERE type='index'")).map((t) => t.name);
  check(`${label}: 对账三索引均不存在`,
    !mod._internals.RECONCILE_REQUIRED_INDEXES.some((n) => idx.includes(n)), JSON.stringify(idx));
  const re = mod._internals.readinessError();
  check(`${label}: readinessError()=503 LEDGER_UNAVAILABLE`,
    re && re.status === 503 && re.code === 'LEDGER_UNAVAILABLE', JSON.stringify(re));
  const closedProbe = await probeClosedDb(mod._internals.getLastOpenedDbForTest());
  check(`${label}: 连接已关闭(probeClosedDb证句柄)`,
    closedProbe.ok === true && closedProbe.closed === true, JSON.stringify(closedProbe));
}

function rawAllOn(dbFile, sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.all(sql, params || [], (err, rows) => { db.close(); err ? reject(err) : resolve(rows); });
  });
}
function rawRunOn(dbFile, sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbFile);
    db.run(sql, params || [], function (err) {
      db.close();
      err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// H3 同款：it_reconciles / it_reconcile_items 列级期望 schema，独立誊写（不从 index.js 的
//   RECONCILE_DDL_STATEMENTS 反推）——若 DDL 手误写错某列，期望值若也从同一处派生，这类错误
//   永远测不出来。字段顺序按 PRAGMA table_info 的 cid 升序（建表语句里的列声明顺序）。
const EXPECTED_RECONCILE_SCHEMA = {
  it_reconciles: [
    { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
    { name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'source_meta', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'created_by', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now','localtime')", pk: 0 },
    { name: 'closed_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'closed_by', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'summary', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'note', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  ],
  it_reconcile_items: [
    { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
    { name: 'reconcile_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'asset_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'external_key', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'external_row', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'external_amount', type: 'REAL', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'ledger_snapshot', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'ambiguous_candidates', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'result', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'actual', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'checked_by', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'checked_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'note', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  ],
};
// it_assets 新增三列的期望（均可空无默认值，方案 §6）。
const EXPECTED_ASSET_P10_COLS = [
  { name: 'owner_name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'owner_dept', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  { name: 'asset_class', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
];

function normalizeCols(rows) {
  return rows
    .sort((a, b) => a.cid - b.cid)
    .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));
}

async function main() {
  // codex 18预筛 LOW-13回补：看门狗挪到 main() 开头（与 verify-it-ledger.js 一致）——原先挂在
  //   清理临时文件之后，若文件清理/require本身真死锁（极端情况），看门狗生效前会无限期挂起。
  //   预算按新增的 H1/HIGH-2/MED-6 等生命周期用例（多出约 8 个独立 module 实例）上调到 180s。
  let currentCaseLabel = '启动段';
  const MAIN_DEADLINE_MS = 180000;
  const mainDeadlineTimer = setTimeout(() => {
    fatalExit('MAIN_DEADLINE 超时·仍在: ' + currentCaseLabel);
  }, MAIN_DEADLINE_MS);
  if (typeof mainDeadlineTimer.unref === 'function') {
    mainDeadlineTimer.unref();
  }

  for (const f of [TEST_DB, TEST_DB2, TEST_DB3]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  const itLedgerFactory = require('../routes/it-ledger');
  let moduleA = null; // 幂等 + 真实数据下的结构事务安全性
  let moduleB = null; // 结构事务原子性（全新库，第一次init即注入）
  let moduleC = null; // M3回补：旧结构+存量行的原子性(第二列owner_dept失败)
  let moduleC2 = null; // codex19预筛 M3①回补：旧结构+存量行的原子性(第三列asset_class失败)
  let moduleH1a = null; // H1回补 提交前②：deadline哨兵
  let moduleH1b = null; // H1回补 提交前③：__faulted哨兵
  let moduleH1c = null; // H1回补 提交前④：结构核验哨兵
  let moduleH1d = null; // H1回补 提交后：结构已提交、不发布
  let moduleH1e = null; // codex18预筛 MED-4：提交前①(既有ALTER注入)独立实测，不再只做交叉引用
  let moduleH2 = null; // codex18预筛 HIGH-2：手工建同名非UNIQUE索引的旧库
  let moduleMed1 = null; // codex19-R MED-1：谓词被追加AND条件的同名索引
  let moduleH3 = null; // codex18复看第二轮 MED：手工建缺external_row列的旧版it_reconcile_items
  let moduleH4a = null; // codex19预筛 H1：结构核验期间真实emit('error')
  let moduleH4b = null; // codex19预筛 H1：结构核验期间预算耗尽
  let rawDbMed6 = null; // codex18预筛 MED-6：checkReconcileStructure直调-缺表
  let rawDbMed6b = null; // codex18预筛 MED-6：checkReconcileStructure直调-缺索引

  try {
    // ══════════════════════════════════════════════════════════════════
    // M1回补（codex 19预筛）：probeClosedDb 自检——两条反例证明"探针本身不会把任何异常都当
    //   已关闭证据"：①传 null → fail（不是"判定已关闭"，是"判定探针前提不成立"）；②对一条
    //   正常打开的连接探测 → 明确返回"未关闭"（closed:false），不是巧合般地" truthy/falsy"。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = 'M1回补: probeClosedDb自检(两条反例)';
    const probeNullResult = await probeClosedDb(null);
    check('M1回补: probeClosedDb(null)返回fail(ok:false),不是"已关闭"',
      probeNullResult.ok === false && probeNullResult.closed === false, JSON.stringify(probeNullResult));
    const PROBE_SELFTEST_DB = TEST_DB3.replace(/\.db$/, '-probe-selftest.db');
    if (fs.existsSync(PROBE_SELFTEST_DB)) fs.unlinkSync(PROBE_SELFTEST_DB);
    const openConnForProbe = new sqlite3.Database(PROBE_SELFTEST_DB);
    await new Promise((resolve, reject) => openConnForProbe.run('CREATE TABLE t(id INTEGER)', (err) => (err ? reject(err) : resolve())));
    const probeOpenResult = await probeClosedDb(openConnForProbe);
    check('M1回补: probeClosedDb(正常打开的连接)返回未关闭(ok:true,closed:false)',
      probeOpenResult.ok === true && probeOpenResult.closed === false, JSON.stringify(probeOpenResult));
    await new Promise((resolve) => openConnForProbe.close(() => resolve()));
    if (fs.existsSync(PROBE_SELFTEST_DB)) fs.unlinkSync(PROBE_SELFTEST_DB);

    // codex 19-R MED-2回补第三条反例：假连接对象，.get 回调返回一个"看起来像关闭错误但语义
    //   相反"的 adversarial 消息——SQLITE_MISUSE 码 + 消息含裸子串"closed"（"not closed
    //   reason"），但不含"is closed"词组。裸子串匹配会被这种消息骗过判 closed:true；改用
    //   "is closed"词组匹配后应正确判 ok:false, closed:false。
    const fakeMisuseDb = {
      get(sql, cb) { cb(new Error('SQLITE_MISUSE: not closed reason')); },
    };
    const probeMisuseResult = await probeClosedDb(fakeMisuseDb);
    check('M1回补: probeClosedDb(SQLITE_MISUSE但消息不含"is closed"词组)返回ok:false,closed:false(不被裸子串"closed"骗过)',
      probeMisuseResult.ok === false && probeMisuseResult.closed === false, JSON.stringify(probeMisuseResult));

    // ══════════════════════════════════════════════════════════════════
    // 组1：初始化幂等——有存量数据时 applyReconcileSchema 跑第二次，表/索引/列不变、行数据不变、
    //   readiness 仍 true（方案 §6 P10 段"幂等：再跑一次零副作用"）。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = '组1: 初始化幂等';
    moduleA = itLedgerFactory({
      logger, DB_FILE: TEST_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    await awaitSettle(moduleA.initSchema(), 15000, '组1: 等待首次initSchema()落定');
    check('组1: 首次init后 state.ready=true', moduleA._internals.state.ready === true, JSON.stringify(moduleA._internals.state));

    // 先插存量数据：it_assets 两行 + 一个 reconcile 批次 + 两条 items。
    await rawRunOn(TEST_DB, `INSERT INTO users (id, username, password, display_name, role) VALUES (1,'admin','x','管理员','admin')`).catch(() => {});
    await rawRunOn(TEST_DB, `INSERT INTO it_assets (id, category, name, status, created_by, owner_name) VALUES (101,'server','服务器A','in_service',1,'张三')`);
    await rawRunOn(TEST_DB, `INSERT INTO it_assets (id, category, name, status, created_by, owner_name) VALUES (102,'laptop','笔记本B','in_service',1,'李四')`);
    await rawRunOn(TEST_DB, `INSERT INTO it_reconciles (id, title, status, source_meta, created_by) VALUES (1,'2026年9月盘点','open','{}',1)`);
    await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result) VALUES (1,101,'A101','{}','{}','pending')`);
    await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result, checked_by, checked_at) VALUES (1,102,'A102','{}','{}','found',1,'2026-09-18 10:00:00')`);

    const beforeTables = (await rawAllOn(TEST_DB, "SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")).sort((a, b) => a.name.localeCompare(b.name));
    const beforeAssetCols = normalizeCols(await rawAllOn(TEST_DB, 'PRAGMA table_info(it_assets)'));
    const beforeReconcileCols = normalizeCols(await rawAllOn(TEST_DB, 'PRAGMA table_info(it_reconciles)'));
    const beforeItemCols = normalizeCols(await rawAllOn(TEST_DB, 'PRAGMA table_info(it_reconcile_items)'));
    const beforeAssetRows = await rawAllOn(TEST_DB, 'SELECT * FROM it_assets ORDER BY id');
    const beforeReconcileRows = await rawAllOn(TEST_DB, 'SELECT * FROM it_reconciles ORDER BY id');
    const beforeItemRows = await rawAllOn(TEST_DB, 'SELECT * FROM it_reconcile_items ORDER BY id');

    // 直接调用 applyReconcileSchema 第二次（不经完整生命周期——本函数已导出，幂等契约由它自己
    //   保证，不依赖 runLifecycleInit 的发布/关闭流程）。
    const liveDb = moduleA._internals.getDbIdentity();
    const secondRunResult = await moduleA._internals.applyReconcileSchema(liveDb, { deadlineTs: Date.now() + 10000 });
    check('组1: 第二次applyReconcileSchema返回ok:true', secondRunResult && secondRunResult.ok === true, JSON.stringify(secondRunResult));

    const afterTables = (await rawAllOn(TEST_DB, "SELECT name,type,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")).sort((a, b) => a.name.localeCompare(b.name));
    const afterAssetCols = normalizeCols(await rawAllOn(TEST_DB, 'PRAGMA table_info(it_assets)'));
    const afterReconcileCols = normalizeCols(await rawAllOn(TEST_DB, 'PRAGMA table_info(it_reconciles)'));
    const afterItemCols = normalizeCols(await rawAllOn(TEST_DB, 'PRAGMA table_info(it_reconcile_items)'));
    const afterAssetRows = await rawAllOn(TEST_DB, 'SELECT * FROM it_assets ORDER BY id');
    const afterReconcileRows = await rawAllOn(TEST_DB, 'SELECT * FROM it_reconciles ORDER BY id');
    const afterItemRows = await rawAllOn(TEST_DB, 'SELECT * FROM it_reconcile_items ORDER BY id');

    check('组1: sqlite_master(表+索引)第二次跑前后完全不变', JSON.stringify(beforeTables) === JSON.stringify(afterTables));
    check('组1: it_assets列结构不变', JSON.stringify(beforeAssetCols) === JSON.stringify(afterAssetCols));
    check('组1: it_reconciles列结构不变', JSON.stringify(beforeReconcileCols) === JSON.stringify(afterReconcileCols));
    check('组1: it_reconcile_items列结构不变', JSON.stringify(beforeItemCols) === JSON.stringify(afterItemCols));
    check('组1: it_assets行数据逐行不变(含2条存量)', JSON.stringify(beforeAssetRows) === JSON.stringify(afterAssetRows) && afterAssetRows.length === 2,
      `before=${JSON.stringify(beforeAssetRows)} after=${JSON.stringify(afterAssetRows)}`);
    check('组1: it_reconciles行数据不变', JSON.stringify(beforeReconcileRows) === JSON.stringify(afterReconcileRows));
    check('组1: it_reconcile_items行数据不变(含2条存量)', JSON.stringify(beforeItemRows) === JSON.stringify(afterItemRows) && afterItemRows.length === 2);
    check('组1: readiness仍true', moduleA._internals.state.ready === true);
    const readinessAfter = await moduleA._internals.checkReadiness(liveDb);
    check('组1: checkReadiness(db)显式复核ok:true', readinessAfter && readinessAfter.ok === true, JSON.stringify(readinessAfter));

    // ══════════════════════════════════════════════════════════════════
    // 组2：结构事务原子性（方案 §13 X-M2 / spec §3 用例2）
    //   part① 全新库首次init即注入ALTER失败（第二次/owner_dept）——两表刚被本次事务CREATE、
    //     三列本次事务里前一列已ALTER成功，注入命中第二列即抛错→整体ROLLBACK：两表必须消失
    //     （"注入点若在ALTER之前两表已CREATE，ROLLBACK后两表必须消失——这正是要证明的"）、
    //     it_assets列结构回到C1原状（31列，无P10三列）。
    //   part② 已就绪模块+真实存量数据，注入CREATE it_reconcile_items失败，验证real数据环境下
    //     it_assets行数据/列结构在对账结构事务失败时绝不被牵连（互补验证，用真实业务数据而非
    //     空库）。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = '组2 part①: 结构事务原子性(全新库,ALTER第二列注入)';
    moduleB = itLedgerFactory({
      logger, DB_FILE: TEST_DB2, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    // 复用既有 setDdlFailureInjection（不新增测试专用 setter，见R1回报"scope冲突"说明）——
    //   三列按 P10_ASSET_FIELDS 顺序：owner_name(第一)/owner_dept(第二)/asset_class(第三)。
    moduleB._internals.setDdlFailureInjection('ALTER it_assets ADD COLUMN owner_dept');
    await awaitSettle(moduleB.initSchema(), 15000, '组2 part①: 等待注入后首次initSchema()落定');

    check('组2 part①: 注入后 state.ready=false', moduleB._internals.state.ready === false);
    check('组2 part①: 注入后 isDbOpen()=false(未发布连接已关闭)', moduleB._internals.isDbOpen() === false);
    const re2a = moduleB._internals.readinessError();
    // 沿 C1 既有路径：ddl 类失败会置 state.error，readinessError() 判定走 LEDGER_UNAVAILABLE
    //   分支（不是 LEDGER_NOT_READY）——回报：R1_对账表结构_spec.md §3 用例2 字面写
    //   "模块503 LEDGER_NOT_READY"，与 C1 既有的 kind='ddl'→state.error→LEDGER_UNAVAILABLE
    //   路径不一致；本 verify 按 C1 实际既有行为断言（ddl 类失败历来都是 LEDGER_UNAVAILABLE，
    //   R1 复用同一条既有路径，不是本次新引入的不一致）。
    check('组2 part①: readinessError()=503 LEDGER_UNAVAILABLE(沿C1既有ddl失败路径)',
      re2a && re2a.status === 503 && re2a.code === 'LEDGER_UNAVAILABLE', JSON.stringify(re2a));

    const tablesAfterFail = await rawAllOn(TEST_DB2, "SELECT name FROM sqlite_master WHERE type='table'");
    const tableNamesAfterFail = tablesAfterFail.map((t) => t.name).sort();
    check('组2 part①: it_reconciles不存在(ROLLBACK后两表必须消失)', !tableNamesAfterFail.includes('it_reconciles'), JSON.stringify(tableNamesAfterFail));
    check('组2 part①: it_reconcile_items不存在(ROLLBACK后两表必须消失)', !tableNamesAfterFail.includes('it_reconcile_items'), JSON.stringify(tableNamesAfterFail));
    check('组2 part①: it_assets仍存在(C1的表未被牵连)', tableNamesAfterFail.includes('it_assets'), JSON.stringify(tableNamesAfterFail));

    const assetColsAfterFail = normalizeCols(await rawAllOn(TEST_DB2, 'PRAGMA table_info(it_assets)'));
    const assetColNamesAfterFail = assetColsAfterFail.map((c) => c.name);
    check('组2 part①: it_assets列数=31(C1原状，无P10三列，含owner_name本身也被ROLLBACK)', assetColsAfterFail.length === 31, JSON.stringify(assetColNamesAfterFail));
    check('组2 part①: it_assets不含owner_name(第一列ALTER也被整体ROLLBACK)', !assetColNamesAfterFail.includes('owner_name'), JSON.stringify(assetColNamesAfterFail));
    check('组2 part①: it_assets不含owner_dept', !assetColNamesAfterFail.includes('owner_dept'), JSON.stringify(assetColNamesAfterFail));
    check('组2 part①: it_assets不含asset_class', !assetColNamesAfterFail.includes('asset_class'), JSON.stringify(assetColNamesAfterFail));
    const assetRowsAfterFail = await rawAllOn(TEST_DB2, 'SELECT * FROM it_assets');
    check('组2 part①: it_assets行数据为空(该库从未注册过资产,行数据不变=0行)', assetRowsAfterFail.length === 0);

    // 清除注入，再跑一次（reinitForTest）→ 全部就位 ready。
    currentCaseLabel = '组2 part①: 清除注入后reinitForTest恢复';
    moduleB._internals.setDdlFailureInjection(null);
    const rebuildResult = await awaitSettle(moduleB._internals.reinitForTest(), 15000, '组2 part①: 等待reinitForTest()落定');
    check('组2 part①: reinitForTest返回ok:true', rebuildResult && rebuildResult.ok === true, JSON.stringify(rebuildResult));
    check('组2 part①: 复原后 state.ready=true', moduleB._internals.state.ready === true, JSON.stringify(moduleB._internals.state));
    const tablesAfterRebuild = (await rawAllOn(TEST_DB2, "SELECT name FROM sqlite_master WHERE type='table'")).map((t) => t.name).sort();
    check('组2 part①: 复原后9表齐全', ['it_asset_acl', 'it_asset_events', 'it_assets', 'it_floors', 'it_racks', 'it_reconcile_items', 'it_reconciles', 'it_stocktake_items', 'it_stocktakes']
      .every((t) => tablesAfterRebuild.includes(t)), JSON.stringify(tablesAfterRebuild));
    const assetColsAfterRebuild = (await rawAllOn(TEST_DB2, 'PRAGMA table_info(it_assets)')).map((c) => c.name);
    check('组2 part①: 复原后it_assets含P10三列', ['owner_name', 'owner_dept', 'asset_class'].every((c) => assetColsAfterRebuild.includes(c)), JSON.stringify(assetColsAfterRebuild));

    // part②：已就绪模块（moduleA，含组1插入的真实存量数据）+ 注入CREATE it_reconcile_items失败
    //   ——即便两表已存在（CREATE IF NOT EXISTS 原本会是no-op），注入检查发生在执行SQL之前、
    //   不看该语句是否本就是no-op，因此仍会命中并触发整体ROLLBACK；核心验证点：真实业务数据
    //   环境下，对账结构事务本身失败绝不牵连 it_assets 的既有行数据/列结构。
    currentCaseLabel = '组2 part②: 已就绪模块+真实数据下的结构事务失败隔离';
    const beforeAssetRows2 = await rawAllOn(TEST_DB, 'SELECT * FROM it_assets ORDER BY id');
    const beforeAssetCols2 = normalizeCols(await rawAllOn(TEST_DB, 'PRAGMA table_info(it_assets)'));
    moduleA._internals.setDdlFailureInjection('it_reconcile_items'); // 复用既有 setDdlFailureInjection
    const part2Result = await moduleA._internals.applyReconcileSchema(moduleA._internals.getDbIdentity(), { deadlineTs: Date.now() + 10000 });
    check('组2 part②: 注入CREATE失败后applyReconcileSchema返回ok:false', part2Result && part2Result.ok === false, JSON.stringify(part2Result));
    moduleA._internals.setDdlFailureInjection(null);
    const afterAssetRows2 = await rawAllOn(TEST_DB, 'SELECT * FROM it_assets ORDER BY id');
    const afterAssetCols2 = normalizeCols(await rawAllOn(TEST_DB, 'PRAGMA table_info(it_assets)'));
    check('组2 part②: it_assets真实存量行数据未受牵连', JSON.stringify(beforeAssetRows2) === JSON.stringify(afterAssetRows2));
    check('组2 part②: it_assets列结构未受牵连', JSON.stringify(beforeAssetCols2) === JSON.stringify(afterAssetCols2));
    check('组2 part②: 已就绪模块state.ready仍为true(本次是直调,不经runLifecycleInit,不影响已发布状态)', moduleA._internals.state.ready === true);
    // 清除注入后确认功能仍可正常重跑（表已存在，全no-op，返回ok:true）。
    const part2SecondRun = await moduleA._internals.applyReconcileSchema(moduleA._internals.getDbIdentity(), { deadlineTs: Date.now() + 10000 });
    check('组2 part②: 清除注入后再跑一次ok:true', part2SecondRun && part2SecondRun.ok === true, JSON.stringify(part2SecondRun));

    // ══════════════════════════════════════════════════════════════════
    // H1回补（codex 18 HIGH，codex 18预筛再回补 HIGH-1/MED-4/MED-5）：结构事务承诺边界——
    //   提交前失败四种(六项断言：列快照/行快照/两表不存在/三索引不存在/503/连接已关闭) +
    //   提交后失败一种(哨兵驱动，结构已提交、不发布)，两向都要，方案 §6 2026-09-19 已改口径。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = 'H1回补 提交前①: 既有ALTER失败(独立实测,不再只做交叉引用)';
    const H1E_DB = TEST_DB3.replace(/\.db$/, '-h1e.db');
    moduleH1e = itLedgerFactory({
      logger, DB_FILE: H1E_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    moduleH1e._internals.setDdlFailureInjection('ALTER it_assets ADD COLUMN owner_dept');
    await awaitSettle(moduleH1e.initSchema(), 15000, 'H1回补①: 等待首次initSchema()落定');
    check('H1回补①: state.ready=false', moduleH1e._internals.state.ready === false);
    check('H1回补①: isDbOpen()=false(未发布连接已关闭)', moduleH1e._internals.isDbOpen() === false);
    await assertPrecommitRollbackIntact(moduleH1e, H1E_DB, 'H1回补①', assetColsAfterFail);
    moduleH1e._internals.setDdlFailureInjection(null);
    const rebuildH1e = await awaitSettle(moduleH1e._internals.reinitForTest(), 15000, 'H1回补①: 等待reinitForTest()落定');
    check('H1回补①: 清除注入后reinitForTest返回ok:true', rebuildH1e && rebuildH1e.ok === true, JSON.stringify(rebuildH1e));
    check('H1回补①: 复原后state.ready=true', moduleH1e._internals.state.ready === true);

    currentCaseLabel = 'H1回补 提交前②: 事务内deadline耗尽(哨兵RECONCILE_PRECOMMIT_DEADLINE)';
    const H1A_DB = TEST_DB3.replace(/\.db$/, '-h1a.db');
    moduleH1a = itLedgerFactory({
      logger, DB_FILE: H1A_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    moduleH1a._internals.setDdlFailureInjection('RECONCILE_PRECOMMIT_DEADLINE');
    await awaitSettle(moduleH1a.initSchema(), 15000, 'H1回补②: 等待首次initSchema()落定');
    check('H1回补②: state.ready=false', moduleH1a._internals.state.ready === false);
    check('H1回补②: isDbOpen()=false(未发布连接已关闭)', moduleH1a._internals.isDbOpen() === false);
    await assertPrecommitRollbackIntact(moduleH1a, H1A_DB, 'H1回补②', assetColsAfterFail);
    moduleH1a._internals.setDdlFailureInjection(null);
    const rebuildH1a = await awaitSettle(moduleH1a._internals.reinitForTest(), 15000, 'H1回补②: 等待reinitForTest()落定');
    check('H1回补②: 清除哨兵后reinitForTest返回ok:true', rebuildH1a && rebuildH1a.ok === true, JSON.stringify(rebuildH1a));
    check('H1回补②: 复原后state.ready=true', moduleH1a._internals.state.ready === true);

    // codex 19预筛 M4回补：本用例只置字符串哨兵（RECONCILE_PRECOMMIT_FAULTED），触发点在
    //   "checkReconcileStructure调用之前"的连接故障检查——不是真实__faulted、也不覆盖"结构核验
    //   期间才发生故障"这条时序窗口。真实链路（checkReconcileStructure执行期间真实emit('error')
    //   置位__faulted）见下方"H1回补(codex19) 核验期间真实故障①"，用例名按codex19预筛要求
    //   明确改为"合成故障分支"，与真实链路用例互补而非重复。
    currentCaseLabel = 'H1回补 提交前③(合成故障分支): 事务内__faulted置位(哨兵RECONCILE_PRECOMMIT_FAULTED,非真实链路)';
    const H1B_DB = TEST_DB3.replace(/\.db$/, '-h1b.db');
    moduleH1b = itLedgerFactory({
      logger, DB_FILE: H1B_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    moduleH1b._internals.setDdlFailureInjection('RECONCILE_PRECOMMIT_FAULTED');
    await awaitSettle(moduleH1b.initSchema(), 15000, 'H1回补③(合成故障分支): 等待首次initSchema()落定');
    check('H1回补③(合成故障分支): state.ready=false', moduleH1b._internals.state.ready === false);
    check('H1回补③(合成故障分支): isDbOpen()=false(未发布连接已关闭)', moduleH1b._internals.isDbOpen() === false);
    await assertPrecommitRollbackIntact(moduleH1b, H1B_DB, 'H1回补③(合成故障分支)', assetColsAfterFail);
    // 哨兵反向：清除后确认能正常复原（③此前缺这一步，补齐与①②④对称）。
    moduleH1b._internals.setDdlFailureInjection(null);
    const rebuildH1b = await awaitSettle(moduleH1b._internals.reinitForTest(), 15000, 'H1回补③(合成故障分支): 等待reinitForTest()落定');
    check('H1回补③(合成故障分支): 清除哨兵后reinitForTest返回ok:true', rebuildH1b && rebuildH1b.ok === true, JSON.stringify(rebuildH1b));
    check('H1回补③(合成故障分支): 复原后state.ready=true', moduleH1b._internals.state.ready === true);

    currentCaseLabel = 'H1回补 提交前④: 事务内结构核验不符(哨兵RECONCILE_STRUCTURE_CHECK_FAIL)';
    const H1C_DB = TEST_DB3.replace(/\.db$/, '-h1c.db');
    moduleH1c = itLedgerFactory({
      logger, DB_FILE: H1C_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    moduleH1c._internals.setDdlFailureInjection('RECONCILE_STRUCTURE_CHECK_FAIL');
    await awaitSettle(moduleH1c.initSchema(), 15000, 'H1回补④: 等待首次initSchema()落定');
    check('H1回补④: state.ready=false', moduleH1c._internals.state.ready === false);
    check('H1回补④: isDbOpen()=false(未发布连接已关闭)', moduleH1c._internals.isDbOpen() === false);
    await assertPrecommitRollbackIntact(moduleH1c, H1C_DB, 'H1回补④', assetColsAfterFail);
    // 清除哨兵，确认能正常复原（同时也是对④这条哨兵本身"清除后不再误伤"的反证）。
    moduleH1c._internals.setDdlFailureInjection(null);
    const rebuildH1c = await awaitSettle(moduleH1c._internals.reinitForTest(), 15000, 'H1回补④: 等待reinitForTest()落定');
    check('H1回补④: 清除哨兵后reinitForTest返回ok:true', rebuildH1c && rebuildH1c.ok === true, JSON.stringify(rebuildH1c));
    check('H1回补④: 复原后state.ready=true', moduleH1c._internals.state.ready === true);

    // H1回补 提交后（codex 18预筛 HIGH-1 回补，取代此前"正常初始化后手动close再查询"的同义反复
    //   写法）：用真实的 RECONCILE_POSTCOMMIT_FAIL 哨兵——命中点在 applyReconcileSchema 成功
    //   返回 ok:true(COMMIT已落地)之后、readiness检查之前，这是 runDdlAndReadiness 自身的失败
    //   分支，不是"人为破坏一个已发布连接"这种间接手法。断言：结构已提交(两表/三索引/三列均
    //   仍存在)但模块判定为不就绪(state.ready=false)，503 LEDGER_UNAVAILABLE，withRead 请求
    //   同样被拒；清哨兵 reinitForTest 后恢复 ready 且结构不受影响。
    currentCaseLabel = 'H1回补 提交后: 结构已提交,不承诺结构未变(哨兵RECONCILE_POSTCOMMIT_FAIL)';
    const H1D_DB = TEST_DB3.replace(/\.db$/, '-h1d.db');
    moduleH1d = itLedgerFactory({
      logger, DB_FILE: H1D_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    moduleH1d._internals.setDdlFailureInjection('RECONCILE_POSTCOMMIT_FAIL');
    await awaitSettle(moduleH1d.initSchema(), 15000, 'H1回补(提交后): 等待首次initSchema()落定');
    check('H1回补(提交后): state.ready=false(哨兵命中,提交后失败)', moduleH1d._internals.state.ready === false, JSON.stringify(moduleH1d._internals.state));
    check('H1回补(提交后): state.error含"提交后失败"', /提交后失败/.test(moduleH1d._internals.state.error || ''), moduleH1d._internals.state.error);
    const tablesH1dAfter = (await rawAllOn(H1D_DB, "SELECT name FROM sqlite_master WHERE type='table'")).map((t) => t.name);
    check('H1回补(提交后): it_reconciles/it_reconcile_items仍存在(结构已提交,不因提交后失败回滚)',
      tablesH1dAfter.includes('it_reconciles') && tablesH1dAfter.includes('it_reconcile_items'), JSON.stringify(tablesH1dAfter));
    const idxH1dAfter = (await rawAllOn(H1D_DB, "SELECT name FROM sqlite_master WHERE type='index'")).map((t) => t.name);
    check('H1回补(提交后): 对账三索引仍存在', moduleH1d._internals.RECONCILE_REQUIRED_INDEXES.every((n) => idxH1dAfter.includes(n)), JSON.stringify(idxH1dAfter));
    const assetColsH1dAfter = (await rawAllOn(H1D_DB, 'PRAGMA table_info(it_assets)')).map((c) => c.name);
    check('H1回补(提交后): it_assets三列仍存在(结构已提交,"提交后不承诺结构未变"≠"结构会回滚")',
      ['owner_name', 'owner_dept', 'asset_class'].every((c) => assetColsH1dAfter.includes(c)), JSON.stringify(assetColsH1dAfter));
    const re_h1d = moduleH1d._internals.readinessError();
    check('H1回补(提交后): readinessError()=503 LEDGER_UNAVAILABLE', re_h1d && re_h1d.status === 503 && re_h1d.code === 'LEDGER_UNAVAILABLE', JSON.stringify(re_h1d));
    let withReadErrH1d = null;
    try { await moduleH1d._internals.withRead((q) => q.get('SELECT 1')); } catch (e) { withReadErrH1d = e; }
    check('H1回补(提交后): withRead拒绝503 LEDGER_UNAVAILABLE', withReadErrH1d && withReadErrH1d.status === 503 && withReadErrH1d.code === 'LEDGER_UNAVAILABLE',
      JSON.stringify(withReadErrH1d && { status: withReadErrH1d.status, code: withReadErrH1d.code }));
    moduleH1d._internals.setDdlFailureInjection(null);
    const rebuildH1d = await awaitSettle(moduleH1d._internals.reinitForTest(), 15000, 'H1回补(提交后): 等待reinitForTest()落定');
    check('H1回补(提交后): 清除哨兵后reinitForTest返回ok:true', rebuildH1d && rebuildH1d.ok === true, JSON.stringify(rebuildH1d));
    check('H1回补(提交后): 复原后state.ready=true', moduleH1d._internals.state.ready === true);

    // ══════════════════════════════════════════════════════════════════
    // H1回补（codex 19预筛 HIGH）：checkReconcileStructure 内部有多次 await，返回 ok:true 到
    //   COMMIT 之间若不再复核一次预算/__faulted，中间这段"核验刚过、还没提交"的窗口就没人守。
    //   两条真实链路用例（不用哨兵，禁 sleep）：用 sqlite3.Database.prototype.all 做一次性、
    //   针对特定 SQL 文本("PRAGMA index_list(it_reconcile_items)"，checkReconcileStructure 内
    //   唯一一次调用该 PRAGMA 的位置，确定性拦截点)的monkey-patch，在该查询即将执行的那一刻
    //   同步触发真实故障——不新增任何 index.js 侧的 setter/hook，纯测试侧对 driver 原型的
    //   临时拦截，用完立即 finally 恢复，不污染后续用例。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = 'H1回补(codex19) ①: 结构核验期间真实emit(error)置位__faulted';
    {
      const H4A_DB = TEST_DB3.replace(/\.db$/, '-h4a.db');
      moduleH4a = itLedgerFactory({
        logger, DB_FILE: H4A_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
        enableTestHooks: true,
      });
      const originalAll1 = sqlite3.Database.prototype.all;
      let intercepted1 = false;
      sqlite3.Database.prototype.all = function interceptedAll1(sql, ...rest) {
        // codex 19-R risk1回补：限定只在"本用例正在初始化的那条连接"上命中——prototype 拦截是
        //   全局的，若不限定连接身份，其它并发/后续实例对同一 SQL 文本的调用也会消耗掉这个
        //   一次性拦截标志（intercepted1），导致本用例的目标连接反而拦不到。
        if (!intercepted1 && typeof sql === 'string' && sql.indexOf('PRAGMA index_list(it_reconcile_items)') !== -1
          && this === moduleH4a._internals.getLastOpenedDbForTest()) {
          intercepted1 = true;
          // 真实机制：db.emit('error',...) 命中 openItDb 里"已 settled 之后才报错"分支
          // （scheduleSelfHealIfNeeded 置 conn.__faulted=true）——不是伪造的字段赋值。
          this.emit('error', new Error('H1回补(codex19)①测试注入: 结构核验期间连接层error'));
        }
        return originalAll1.apply(this, [sql, ...rest]);
      };
      try {
        await awaitSettle(moduleH4a.initSchema(), 15000, 'H1回补(codex19)①: 等待首次initSchema()落定');
      } finally {
        sqlite3.Database.prototype.all = originalAll1;
      }
      check('H1回补(codex19)①: 确实拦截到目标查询(intercepted1=true,否则用例前提不成立)', intercepted1 === true);
      check('H1回补(codex19)①: state.ready=false', moduleH4a._internals.state.ready === false, JSON.stringify(moduleH4a._internals.state));
      check('H1回补(codex19)①: state.error含"连接层错误"(真实__faulted路径,非哨兵)', /连接层错误/.test(moduleH4a._internals.state.error || ''), moduleH4a._internals.state.error);
      check('H1回补(codex19)①: isDbOpen()=false(未发布连接已关闭)', moduleH4a._internals.isDbOpen() === false);
      await assertPrecommitRollbackIntact(moduleH4a, H4A_DB, 'H1回补(codex19)①', assetColsAfterFail);
      const rebuildH4a = await awaitSettle(moduleH4a._internals.reinitForTest(), 15000, 'H1回补(codex19)①: 等待reinitForTest()落定');
      check('H1回补(codex19)①: 复原后reinitForTest返回ok:true', rebuildH4a && rebuildH4a.ok === true, JSON.stringify(rebuildH4a));
      check('H1回补(codex19)①: 复原后state.ready=true', moduleH4a._internals.state.ready === true);
    }

    currentCaseLabel = 'H1回补(codex19) ②: 结构核验期间预算耗尽';
    {
      const H4B_DB = TEST_DB3.replace(/\.db$/, '-h4b.db');
      moduleH4b = itLedgerFactory({
        logger, DB_FILE: H4B_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
        enableTestHooks: true,
      });
      // 预算给足(10s)，保证进入 checkReconcileStructure 之前的两次真实 deadline 检查都能通过
      // （不靠猜时序——10s 对本地空库初始化绰绰有余）；deadlineTs 在 runLifecycleInit 开头按此
      // 预算一次性算好（deadlineTs = Date.now()+10000），是个闭包内的固定时间戳。核验期间要让
      // "Date.now() > deadlineTs"变true但又不能真的等 10s，改为在拦截点把 Date.now 本身替换成
      // 返回"未来"值——不引入任何 setTimeout/sleep，纯确定性地让下一次 Date.now() 调用越过
      // deadlineTs 这个已经算死的时间戳。
      moduleH4b._internals.setDdlDeadlineMsOverride(10000);
      const originalAll2 = sqlite3.Database.prototype.all;
      const originalDateNow = Date.now;
      let intercepted2 = false;
      sqlite3.Database.prototype.all = function interceptedAll2(sql, ...rest) {
        // codex 19-R risk1回补：同①，限定只在本用例(moduleH4b)正在初始化的那条连接上命中。
        if (!intercepted2 && typeof sql === 'string' && sql.indexOf('PRAGMA index_list(it_reconcile_items)') !== -1
          && this === moduleH4b._internals.getLastOpenedDbForTest()) {
          intercepted2 = true;
          Date.now = () => originalDateNow() + 999999999; // 让此刻起的deadline判断恒为"已超时"
        }
        return originalAll2.apply(this, [sql, ...rest]);
      };
      try {
        await awaitSettle(moduleH4b.initSchema(), 15000, 'H1回补(codex19)②: 等待首次initSchema()落定');
      } finally {
        sqlite3.Database.prototype.all = originalAll2;
        Date.now = originalDateNow;
        moduleH4b._internals.setDdlDeadlineMsOverride(null);
      }
      check('H1回补(codex19)②: 确实拦截到目标查询(intercepted2=true,否则用例前提不成立)', intercepted2 === true);
      check('H1回补(codex19)②: state.ready=false', moduleH4b._internals.state.ready === false, JSON.stringify(moduleH4b._internals.state));
      check('H1回补(codex19)②: state.error含"超时"(核验后复核预算,非哨兵)', /超时/.test(moduleH4b._internals.state.error || ''), moduleH4b._internals.state.error);
      check('H1回补(codex19)②: isDbOpen()=false(未发布连接已关闭)', moduleH4b._internals.isDbOpen() === false);
      await assertPrecommitRollbackIntact(moduleH4b, H4B_DB, 'H1回补(codex19)②', assetColsAfterFail);
      const rebuildH4b = await awaitSettle(moduleH4b._internals.reinitForTest(), 15000, 'H1回补(codex19)②: 等待reinitForTest()落定');
      check('H1回补(codex19)②: 复原后reinitForTest返回ok:true', rebuildH4b && rebuildH4b.ok === true, JSON.stringify(rebuildH4b));
      check('H1回补(codex19)②: 复原后state.ready=true', moduleH4b._internals.state.ready === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // HIGH-2回补（codex 18预筛）：checkReconcileStructure 生产侧同款洞——手工建一个"同名但非
    //   UNIQUE"的历史遗留索引，CREATE UNIQUE INDEX IF NOT EXISTS 会静默跳过重建，只有本批新增
    //   的 unique/partial 位核验能拦住它。断言：初始化后判定提交前核验拒绝→ROLLBACK→不就绪。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = 'HIGH-2回补: 手工建同名非UNIQUE索引的旧库上初始化';
    const H2_DB = TEST_DB3.replace(/\.db$/, '-h2.db');
    if (fs.existsSync(H2_DB)) fs.unlinkSync(H2_DB);
    // codex 18预筛第二轮 MED回补：两表列集合必须齐全(与RECONCILE_TABLE_COLUMN_SPECS一致)——
    //   否则会被本批新增的"列集合核验"提前拦截，测不到本用例真正要测的"索引结构不符"分支。
    await rawRunOn(H2_DB, `CREATE TABLE it_reconciles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT, source_meta TEXT,
      created_by INTEGER, created_at TEXT, closed_at TEXT, closed_by INTEGER, summary TEXT, note TEXT
    )`);
    await rawRunOn(H2_DB, `CREATE TABLE it_reconcile_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reconcile_id INTEGER, asset_id INTEGER,
      external_key TEXT, external_row TEXT, external_amount REAL, ledger_snapshot TEXT,
      ambiguous_candidates TEXT, result TEXT, actual TEXT, checked_by INTEGER, checked_at TEXT, note TEXT
    )`);
    // 同名但非UNIQUE——IF NOT EXISTS 只看名字存在与否，不会替换掉这条语义错误的历史索引。
    await rawRunOn(H2_DB, `CREATE INDEX idx_it_reconcile_items_ext_key_unique ON it_reconcile_items(reconcile_id, external_key)`);
    await rawRunOn(H2_DB, `CREATE UNIQUE INDEX idx_it_reconcile_items_asset_id_unique ON it_reconcile_items(reconcile_id, asset_id) WHERE asset_id IS NOT NULL`);
    await rawRunOn(H2_DB, `CREATE INDEX idx_it_reconcile_items_result ON it_reconcile_items(reconcile_id, result)`);
    moduleH2 = itLedgerFactory({
      logger, DB_FILE: H2_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    await awaitSettle(moduleH2.initSchema(), 15000, 'HIGH-2回补: 等待首次initSchema()落定');
    check('HIGH-2回补: 手工建同名非UNIQUE索引的旧库上初始化后state.ready=false', moduleH2._internals.state.ready === false, JSON.stringify(moduleH2._internals.state));
    check('HIGH-2回补: state.error含"索引结构不符"(提交前核验拒绝)', /索引结构不符/.test(moduleH2._internals.state.error || ''), moduleH2._internals.state.error);
    check('HIGH-2回补: isDbOpen()=false(未发布连接已关闭,ROLLBACK后)', moduleH2._internals.isDbOpen() === false);
    const re_h2 = moduleH2._internals.readinessError();
    check('HIGH-2回补: readinessError()=503 LEDGER_UNAVAILABLE', re_h2 && re_h2.status === 503 && re_h2.code === 'LEDGER_UNAVAILABLE', JSON.stringify(re_h2));

    // ══════════════════════════════════════════════════════════════════
    // MED-1回补（codex 19-R）：partial 谓词此前用子串匹配(indexOf)，"WHERE external_key IS NOT
    //   NULL AND reconcile_id < 0"这种谓词被追加了额外条件的漂移也能蒙混过去（子串仍然存在）。
    //   手工建一个 unique/partial 位都对、但谓词多了一截 AND 条件的同名索引，验证提交前核验
    //   现在会拒（全等比较，不是子串包含）。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = 'MED-1回补: partial谓词被追加AND条件的同名索引应被拒';
    const MED1_DB = TEST_DB3.replace(/\.db$/, '-med1.db');
    if (fs.existsSync(MED1_DB)) fs.unlinkSync(MED1_DB);
    await rawRunOn(MED1_DB, `CREATE TABLE it_reconciles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT, source_meta TEXT,
      created_by INTEGER, created_at TEXT, closed_at TEXT, closed_by INTEGER, summary TEXT, note TEXT
    )`);
    await rawRunOn(MED1_DB, `CREATE TABLE it_reconcile_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reconcile_id INTEGER, asset_id INTEGER,
      external_key TEXT, external_row TEXT, external_amount REAL, ledger_snapshot TEXT,
      ambiguous_candidates TEXT, result TEXT, actual TEXT, checked_by INTEGER, checked_at TEXT, note TEXT
    )`);
    // unique=1/partial=1都对，谓词多了"AND reconcile_id < 0"——旧版indexOf子串匹配测不出来，
    //   新版全等比较应该能拒。
    await rawRunOn(MED1_DB, `CREATE UNIQUE INDEX idx_it_reconcile_items_ext_key_unique ON it_reconcile_items(reconcile_id, external_key) WHERE external_key IS NOT NULL AND reconcile_id < 0`);
    await rawRunOn(MED1_DB, `CREATE UNIQUE INDEX idx_it_reconcile_items_asset_id_unique ON it_reconcile_items(reconcile_id, asset_id) WHERE asset_id IS NOT NULL`);
    await rawRunOn(MED1_DB, `CREATE INDEX idx_it_reconcile_items_result ON it_reconcile_items(reconcile_id, result)`);
    moduleMed1 = itLedgerFactory({
      logger, DB_FILE: MED1_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    await awaitSettle(moduleMed1.initSchema(), 15000, 'MED-1回补: 等待首次initSchema()落定');
    check('MED-1回补: 谓词被追加AND条件的旧库上初始化后state.ready=false', moduleMed1._internals.state.ready === false, JSON.stringify(moduleMed1._internals.state));
    check('MED-1回补: state.error含"partial 谓词不符"(提交前核验拒绝)', /partial谓词不符|partial 谓词不符/.test(moduleMed1._internals.state.error || ''), moduleMed1._internals.state.error);
    check('MED-1回补: isDbOpen()=false(未发布连接已关闭,ROLLBACK后)', moduleMed1._internals.isDbOpen() === false);
    const re_med1 = moduleMed1._internals.readinessError();
    check('MED-1回补: readinessError()=503 LEDGER_UNAVAILABLE', re_med1 && re_med1.status === 503 && re_med1.code === 'LEDGER_UNAVAILABLE', JSON.stringify(re_med1));

    // ══════════════════════════════════════════════════════════════════
    // MED回补第二轮（codex 18复看后再回补）：checkReconcileStructure 光核两表名字+索引结构+
    //   it_assets三列，不核两表自身列集合——手工建一张缺 external_row 列但三索引齐全的旧版
    //   it_reconcile_items，IF NOT EXISTS 只看表名存在与否，不会补列，若不核列集合会被静默
    //   放行发布。断言：提交前核验拒绝(state.error含"对账表列不符")→ROLLBACK→it_assets无三列→503。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = 'MED回补第二轮: 旧库预建缺external_row列的it_reconcile_items(三索引齐)';
    const H3_DB = TEST_DB3.replace(/\.db$/, '-h3.db');
    if (fs.existsSync(H3_DB)) fs.unlinkSync(H3_DB);
    // it_reconciles 列齐全(与RECONCILE_TABLE_COLUMN_SPECS.it_reconciles一致)——本用例只想让
    //   失败精确落在 it_reconcile_items 缺列上，不让 it_reconciles 自己先漏出无关的"列不符"。
    await rawRunOn(H3_DB, `CREATE TABLE it_reconciles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT, source_meta TEXT,
      created_by INTEGER, created_at TEXT, closed_at TEXT, closed_by INTEGER, summary TEXT, note TEXT
    )`);
    // 缺 external_row 列（其余列齐全，模拟"历史版本表结构比现在少一列"）。
    await rawRunOn(H3_DB, `CREATE TABLE it_reconcile_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reconcile_id INTEGER, asset_id INTEGER,
      external_key TEXT, external_amount REAL, ledger_snapshot TEXT, ambiguous_candidates TEXT,
      result TEXT, actual TEXT, checked_by INTEGER, checked_at TEXT, note TEXT
    )`);
    await rawRunOn(H3_DB, `CREATE UNIQUE INDEX idx_it_reconcile_items_ext_key_unique ON it_reconcile_items(reconcile_id, external_key) WHERE external_key IS NOT NULL`);
    await rawRunOn(H3_DB, `CREATE UNIQUE INDEX idx_it_reconcile_items_asset_id_unique ON it_reconcile_items(reconcile_id, asset_id) WHERE asset_id IS NOT NULL`);
    await rawRunOn(H3_DB, `CREATE INDEX idx_it_reconcile_items_result ON it_reconcile_items(reconcile_id, result)`);
    moduleH3 = itLedgerFactory({
      logger, DB_FILE: H3_DB, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
      enableTestHooks: true,
    });
    await awaitSettle(moduleH3.initSchema(), 15000, 'MED回补第二轮: 等待首次initSchema()落定');
    check('MED回补第二轮: 缺列旧库上初始化后state.ready=false', moduleH3._internals.state.ready === false, JSON.stringify(moduleH3._internals.state));
    check('MED回补第二轮: state.error含"对账表列不符"(提交前核验拒绝)', /对账表列不符/.test(moduleH3._internals.state.error || ''), moduleH3._internals.state.error);
    check('MED回补第二轮: state.error点名it_reconcile_items与缺列external_row(非误指it_reconciles)',
      /it_reconcile_items/.test(moduleH3._internals.state.error || '') && /external_row/.test(moduleH3._internals.state.error || ''), moduleH3._internals.state.error);
    check('MED回补第二轮: isDbOpen()=false(未发布连接已关闭,ROLLBACK后)', moduleH3._internals.isDbOpen() === false);
    const assetColsH3 = (await rawAllOn(H3_DB, 'PRAGMA table_info(it_assets)')).map((c) => c.name);
    check('MED回补第二轮: it_assets无P10三列(提交前ROLLBACK,ALTER也被撤销)',
      !['owner_name', 'owner_dept', 'asset_class'].some((c) => assetColsH3.includes(c)), JSON.stringify(assetColsH3));
    const re_h3 = moduleH3._internals.readinessError();
    check('MED回补第二轮: readinessError()=503 LEDGER_UNAVAILABLE', re_h3 && re_h3.status === 503 && re_h3.code === 'LEDGER_UNAVAILABLE', JSON.stringify(re_h3));
    // 清库复原：删掉这张缺列的旧表，让模块能重新以标准DDL建出正确结构（IF NOT EXISTS不会
    //   补列，必须先物理清除旧表，"清库"而非"清哨兵"）。
    await rawRunOn(H3_DB, 'DROP TABLE it_reconcile_items');
    await rawRunOn(H3_DB, 'DROP TABLE it_reconciles');
    const rebuildH3 = await awaitSettle(moduleH3._internals.reinitForTest(), 15000, 'MED回补第二轮: 等待reinitForTest()落定');
    check('MED回补第二轮: 清库复原后reinitForTest返回ok:true', rebuildH3 && rebuildH3.ok === true, JSON.stringify(rebuildH3));
    check('MED回补第二轮: 复原后state.ready=true', moduleH3._internals.state.ready === true);
    const assetColsH3After = (await rawAllOn(H3_DB, 'PRAGMA table_info(it_assets)')).map((c) => c.name);
    check('MED回补第二轮: 复原后it_assets含P10三列', ['owner_name', 'owner_dept', 'asset_class'].every((c) => assetColsH3After.includes(c)), JSON.stringify(assetColsH3After));

    // ══════════════════════════════════════════════════════════════════
    // MED-6回补（codex 18预筛）：checkReconcileStructure 零真实判别力覆盖——直调该函数本身
    //   （不经完整初始化流程），分别在"缺两表"与"缺一条索引"的裸连接上验证 ok:false 且
    //   error 点名具体缺失项。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = 'MED-6回补: checkReconcileStructure直调(缺表/缺索引各一次)';
    const MED6_DB = TEST_DB3.replace(/\.db$/, '-med6.db');
    if (fs.existsSync(MED6_DB)) fs.unlinkSync(MED6_DB);
    await rawRunOn(MED6_DB, `CREATE TABLE it_assets (id INTEGER PRIMARY KEY)`);
    rawDbMed6 = new sqlite3.Database(MED6_DB);
    const checkNoTables = await moduleA._internals.checkReconcileStructure(rawDbMed6);
    check('MED-6回补: 缺两表时checkReconcileStructure返回ok:false且error点名缺表',
      checkNoTables && checkNoTables.ok === false && /对账表缺失/.test(checkNoTables.error || ''), JSON.stringify(checkNoTables));

    const MED6B_DB = TEST_DB3.replace(/\.db$/, '-med6b.db');
    if (fs.existsSync(MED6B_DB)) fs.unlinkSync(MED6B_DB);
    await rawRunOn(MED6B_DB, `CREATE TABLE it_assets (id INTEGER PRIMARY KEY, owner_name TEXT, owner_dept TEXT, asset_class TEXT)`);
    // 两表列集合齐全（同HIGH-2回补注释理由）——本组要测的是"缺一条索引"，不是"缺列"。
    await rawRunOn(MED6B_DB, `CREATE TABLE it_reconciles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, status TEXT, source_meta TEXT,
      created_by INTEGER, created_at TEXT, closed_at TEXT, closed_by INTEGER, summary TEXT, note TEXT
    )`);
    await rawRunOn(MED6B_DB, `CREATE TABLE it_reconcile_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, reconcile_id INTEGER, asset_id INTEGER,
      external_key TEXT, external_row TEXT, external_amount REAL, ledger_snapshot TEXT,
      ambiguous_candidates TEXT, result TEXT, actual TEXT, checked_by INTEGER, checked_at TEXT, note TEXT
    )`);
    await rawRunOn(MED6B_DB, `CREATE UNIQUE INDEX idx_it_reconcile_items_ext_key_unique ON it_reconcile_items(reconcile_id, external_key) WHERE external_key IS NOT NULL`);
    await rawRunOn(MED6B_DB, `CREATE UNIQUE INDEX idx_it_reconcile_items_asset_id_unique ON it_reconcile_items(reconcile_id, asset_id) WHERE asset_id IS NOT NULL`);
    // 缺 idx_it_reconcile_items_result（第三条索引）。
    rawDbMed6b = new sqlite3.Database(MED6B_DB);
    const checkMissingIndex = await moduleA._internals.checkReconcileStructure(rawDbMed6b);
    check('MED-6回补: 缺一条索引时checkReconcileStructure返回ok:false且error点名缺索引',
      checkMissingIndex && checkMissingIndex.ok === false && /对账索引缺失/.test(checkMissingIndex.error || ''), JSON.stringify(checkMissingIndex));

    // ══════════════════════════════════════════════════════════════════
    // 组3：列级对拍——两表 PRAGMA table_info 与手写期望常量对拍；it_assets 三列
    //   {name,type,notnull=0,dflt_value=null} 对拍（spec §3 用例3）。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = '组3: 列级对拍';
    for (const tableName of Object.keys(EXPECTED_RECONCILE_SCHEMA)) {
      const actualCols = normalizeCols(await rawAllOn(TEST_DB, `PRAGMA table_info(${tableName})`));
      const expected = EXPECTED_RECONCILE_SCHEMA[tableName];
      check(`组3: ${tableName} 列级对拍(name/type/notnull/dflt_value/pk 全字段)`,
        JSON.stringify(actualCols) === JSON.stringify(expected),
        `actual=${JSON.stringify(actualCols)} expected=${JSON.stringify(expected)}`);
    }
    const assetColsFull = normalizeCols(await rawAllOn(TEST_DB, 'PRAGMA table_info(it_assets)'));
    const assetP10Cols = assetColsFull.slice(-3);
    check('组3: it_assets P10三列(owner_name/owner_dept/asset_class)列级对拍',
      JSON.stringify(assetP10Cols) === JSON.stringify(EXPECTED_ASSET_P10_COLS),
      `actual=${JSON.stringify(assetP10Cols)} expected=${JSON.stringify(EXPECTED_ASSET_P10_COLS)}`);

    // ══════════════════════════════════════════════════════════════════
    // 组4：CHECK 负向/正向（spec §3 用例4）——每条负向一插，四种形态各一条合法插入成功。
    //   用独立原生连接（rawRunOn）直插，不经应用层校验，验证 DB CHECK 约束本身确实存在。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = '组4: CHECK负向/正向';
    // 复用一个新批次，避免和组1/组2的既有行冲突（unique 索引按 reconcile_id 维度）。
    await rawRunOn(TEST_DB, `INSERT INTO it_reconciles (id, title, status, source_meta, created_by) VALUES (2,'CHECK用例批次','open','{}',1)`);
    const negativeCases = [
      { label: 'it_reconciles.closed无closed_by', sql: `INSERT INTO it_reconciles (title, status, source_meta, created_by, closed_at) VALUES ('x','closed','{}',1,'2026-01-01')` },
      { label: 'checked_by有checked_at无', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result, checked_by) VALUES (2,101,'N1','{}','{}','found',1)` },
      { label: 'mismatch无actual', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result, checked_by, checked_at) VALUES (2,101,'N2','{}','{}','mismatch',1,'2026-01-01')` },
      { label: 'found有actual', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result, actual, checked_by, checked_at) VALUES (2,101,'N3','{}','{}','found','{"a":1}',1,'2026-01-01')` },
      { label: 'not_in_ledger带asset_id(形态①)', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, result) VALUES (2,101,'N4','{}','not_in_ledger')` },
      { label: 'ambiguous无candidates(形态②)', sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, result) VALUES (2,'N5','{}','ambiguous')` },
      { label: 'not_in_sheet带external_key(形态③)', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, ledger_snapshot, result) VALUES (2,101,'N6','{}','not_in_sheet')` },
      { label: 'pending带checked_*(形态④/自动分类恒NULL)', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result, checked_by, checked_at) VALUES (2,101,'N7','{}','{}','pending',1,'2026-01-01')` },
      { label: 'result非法值', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result) VALUES (2,101,'N8','{}','{}','bogus_result')` },
      // M1回补（codex 18，方案 §2.9.1 新增行）：ambiguous_candidates 不再只判 IS NOT NULL——
      //   '[]'/'[{}]'/'null'/'{}'/长度1 这类"非空但不合法"的值均须被 CHECK 拒。
      { label: "ambiguous候选'[]'(空数组,长度0<2)", sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, ambiguous_candidates, result) VALUES (2,'N9','{}','[]','ambiguous')` },
      { label: "ambiguous候选'[{}]'(长度1<2)", sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, ambiguous_candidates, result) VALUES (2,'N10','{}','[{}]','ambiguous')` },
      { label: "ambiguous候选'null'(json_type=null≠array)", sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, ambiguous_candidates, result) VALUES (2,'N11','{}','null','ambiguous')` },
      { label: "ambiguous候选'{}'(json_type=object≠array)", sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, ambiguous_candidates, result) VALUES (2,'N12','{}','{}','ambiguous')` },
      { label: "ambiguous候选'[1]'(长度1<2,元素非对象也不影响长度判定)", sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, ambiguous_candidates, result) VALUES (2,'N13','{}','[1]','ambiguous')` },
      // LOW-11回补（codex 18预筛）：非法JSON文本(不是"合法但不满足长度/类型"，是压根不是JSON)。
      { label: "ambiguous候选'abc'(非法JSON文本,json_valid=0)", sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, ambiguous_candidates, result) VALUES (2,'N14','{}','abc','ambiguous')` },
    ];
    for (const c of negativeCases) {
      let err = null;
      try { await rawRunOn(TEST_DB, c.sql); } catch (e) { err = e; }
      check(`组4负向: ${c.label} 被CHECK拒`, err && /CHECK constraint failed|NOT NULL constraint failed/i.test(err.message || ''), err && err.message);
    }
    const positiveCases = [
      { label: '唯一匹配(pending)', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result) VALUES (2,101,'P1','{}','{}','pending')` },
      { label: '册上有台账无(not_in_ledger)', sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, result) VALUES (2,'P2','{}','not_in_ledger')` },
      { label: '台账有册上无(not_in_sheet)', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, ledger_snapshot, result) VALUES (2,102,'{}','not_in_sheet')` },
      { label: '编号歧义(ambiguous)', sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, ambiguous_candidates, result) VALUES (2,'P4','{}','[{},{}]','ambiguous')` },
    ];
    for (const c of positiveCases) {
      let err = null;
      try { await rawRunOn(TEST_DB, c.sql); } catch (e) { err = e; }
      check(`组4正向: ${c.label} 插入成功`, !err, err && err.message);
    }

    // ══════════════════════════════════════════════════════════════════
    // M1回补：validateAmbiguousCandidates 服务层助手（DB CHECK 管长度/类型，元素内部结构由
    //   本助手管：键集合恰等于六键 / id 正整数且互不重复 / 其余字段 string|null）。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = 'M1回补: validateAmbiguousCandidates助手';
    const vac = moduleA._internals.validateAmbiguousCandidates;
    const validCandidate1 = { id: 1, asset_no: 'YW01', name: '服务器A', sn: 'SN1', category: 'server', location_desc: '机房A' };
    const validCandidate2 = { id: 2, asset_no: 'YW02', name: '服务器B', sn: null, category: 'server', location_desc: null };
    const vacCases = [
      ['非数组({})', {}, { ok: false, reason: 'not_array' }],
      ['长度1数组', [validCandidate1], { ok: false, reason: 'too_short' }],
      ['元素非对象([1,2])', [1, 2], { ok: false, reason: 'element_not_object' }],
      ['元素缺键(缺location_desc)', [{ id: 1, asset_no: 'A', name: 'B', sn: 'C', category: 'D' }, validCandidate2], { ok: false, reason: 'key_set_mismatch' }],
      ['元素多键(多extra)', [{ ...validCandidate1, extra: 1 }, validCandidate2], { ok: false, reason: 'key_set_mismatch' }],
      ['id重复', [validCandidate1, { ...validCandidate2, id: 1 }], { ok: false, reason: 'duplicate_id' }],
      ['id=0', [{ ...validCandidate1, id: 0 }, validCandidate2], { ok: false, reason: 'invalid_id' }],
      ['正向(两条合法)', [validCandidate1, validCandidate2], { ok: true }],
    ];
    for (const [label, input, expected] of vacCases) {
      const result = vac(input);
      check(`M1回补: ${label}`, JSON.stringify(result) === JSON.stringify(expected), `actual=${JSON.stringify(result)} expected=${JSON.stringify(expected)}`);
    }

    // codex 19预筛 L1回补：反例——类实例/自定义原型对象/带Symbol键，均应被拒（不是"看起来
    //   像候选"就放行，原型链必须恰为 Object.prototype 或 null，键集合必须严格是六个字符串键）。
    class CandidateClassInstance {
      constructor() {
        Object.assign(this, validCandidate1);
      }
    }
    const classInstanceCandidate = new CandidateClassInstance();
    check('L1回补: 类实例(非普通对象)被拒(element_not_plain_object)',
      JSON.stringify(vac([classInstanceCandidate, validCandidate2])) === JSON.stringify({ ok: false, reason: 'element_not_plain_object' }),
      JSON.stringify(vac([classInstanceCandidate, validCandidate2])));

    const customProto = { greet() { return 'hi'; } };
    const customProtoCandidate = Object.assign(Object.create(customProto), validCandidate1);
    check('L1回补: Object.create(自定义原型)被拒(element_not_plain_object)',
      JSON.stringify(vac([customProtoCandidate, validCandidate2])) === JSON.stringify({ ok: false, reason: 'element_not_plain_object' }),
      JSON.stringify(vac([customProtoCandidate, validCandidate2])));

    const symbolKeyCandidate = { ...validCandidate1, [Symbol('extra')]: 'sneaky' };
    check('L1回补: 带Symbol键的对象被拒(has_symbol_key)',
      JSON.stringify(vac([symbolKeyCandidate, validCandidate2])) === JSON.stringify({ ok: false, reason: 'has_symbol_key' }),
      JSON.stringify(vac([symbolKeyCandidate, validCandidate2])));

    const nullProtoCandidate = Object.assign(Object.create(null), validCandidate1);
    check('L1回补: Object.create(null)(原型为null)仍视为合法普通对象放行',
      JSON.stringify(vac([nullProtoCandidate, validCandidate2])) === JSON.stringify({ ok: true }),
      JSON.stringify(vac([nullProtoCandidate, validCandidate2])));

    // ══════════════════════════════════════════════════════════════════
    // rec回补：assertAssetClass 服务层助手（方案 §2.1 无 DB CHECK，取值集合由所有写入口
    //   服务层校验）+ 四类形态用例补 closed 正向/open 带关闭元数据负向/六终态正向/缺checked_*负向。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = 'rec回补: assertAssetClass助手';
    const aac = moduleA._internals.assertAssetClass;
    check('rec回补: assertAssetClass(null)放行', JSON.stringify(aac(null)) === JSON.stringify({ ok: true }));
    check('rec回补: assertAssetClass(undefined)放行', JSON.stringify(aac(undefined)) === JSON.stringify({ ok: true }));
    check('rec回补: assertAssetClass("fixed")合法', JSON.stringify(aac('fixed')) === JSON.stringify({ ok: true }));
    check('rec回补: assertAssetClass("low_value")合法', JSON.stringify(aac('low_value')) === JSON.stringify({ ok: true }));
    check('rec回补: assertAssetClass("FIXED")大小写敏感被拒', JSON.stringify(aac('FIXED')) === JSON.stringify({ ok: false, code: 'INVALID_ASSET_CLASS' }));
    check('rec回补: assertAssetClass("")空串被拒', JSON.stringify(aac('')) === JSON.stringify({ ok: false, code: 'INVALID_ASSET_CLASS' }));
    check('rec回补: assertAssetClass("other")被拒', JSON.stringify(aac('other')) === JSON.stringify({ ok: false, code: 'INVALID_ASSET_CLASS' }));
    check('rec回补: assertAssetClass(1)数字被拒', JSON.stringify(aac(1)) === JSON.stringify({ ok: false, code: 'INVALID_ASSET_CLASS' }));

    currentCaseLabel = 'rec回补: 四类形态closed/open/六终态checked_*';
    await rawRunOn(TEST_DB, `INSERT INTO it_reconciles (id, title, status, source_meta, created_by) VALUES (5,'rec回补批次','open','{}',1)`);
    const recCases = [
      // closed 正向（closed_at/closed_by 齐）——显式 id，避免与后续组6(id=6/7)等自增冲突
      //   （AUTOINCREMENT 的"下一个值"取决于历史最大已提交 id，显式 id=5 之后若这里再走自增，
      //   会拿到 6，正好撞上组6写死的 id=6，故此处及以下同批全部显式赋 id）。
      { label: 'it_reconciles closed正向(closed_at/closed_by齐)', sql: `INSERT INTO it_reconciles (id, title, status, source_meta, created_by, closed_at, closed_by) VALUES (91,'rec-closed','closed','{}',1,'2026-09-19 00:00:00',1)`, expectOk: true },
      // open 带关闭元数据负向
      { label: 'it_reconciles open带closed_by负向', sql: `INSERT INTO it_reconciles (id, title, status, source_meta, created_by, closed_by) VALUES (92,'rec-open-bad','open','{}',1,1)`, expectOk: false },
      // 六终态各一条正向（带 checked_*）——asset_id 在同一 reconcile_id 内必须两两不同（唯一
      //   索引 UNIQUE(reconcile_id,asset_id) WHERE asset_id IS NOT NULL 不豁免测试数据；本项目
      //   不开 FK，asset_id 用不与其他用例冲突的整数即可，不要求真实存在于 it_assets）。
      { label: '终态found正向(带checked_*)', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result, checked_by, checked_at) VALUES (5,9101,'REC-F1','{}','{}','found',1,'2026-09-19 00:00:00')`, expectOk: true },
      { label: '终态missing正向(带checked_*)', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result, checked_by, checked_at) VALUES (5,9102,'REC-F2','{}','{}','missing',1,'2026-09-19 00:00:00')`, expectOk: true },
      { label: '终态mismatch正向(带checked_*与actual)', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result, actual, checked_by, checked_at) VALUES (5,9103,'REC-F3','{}','{}','mismatch','{"a":1}',1,'2026-09-19 00:00:00')`, expectOk: true },
      { label: '终态ledger_added正向(带checked_*)', sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, result, checked_by, checked_at) VALUES (5,'REC-F4','{}','ledger_added',1,'2026-09-19 00:00:00')`, expectOk: true },
      { label: '终态confirmed_off_book正向(带checked_*)', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, ledger_snapshot, result, checked_by, checked_at) VALUES (5,9106,'{}','confirmed_off_book',1,'2026-09-19 00:00:00')`, expectOk: true },
      { label: '终态ledger_fixed正向(带checked_*与candidates)', sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, ambiguous_candidates, result, checked_by, checked_at) VALUES (5,'REC-F5','{}','[{},{}]','ledger_fixed',1,'2026-09-19 00:00:00')`, expectOk: true },
      // 六终态缺 checked_* 各一条负向（checked_by/checked_at 齐全约束的正例已在组4覆盖，这里
      //   逐状态补"缺 checked_*"负向，不因组4已测一个状态就合并判断——见 memory 状态集合逐状态核）
      { label: '终态missing缺checked_*负向', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result) VALUES (5,9104,'REC-N1','{}','{}','missing')`, expectOk: false },
      { label: '终态mismatch缺checked_*负向', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result, actual) VALUES (5,9105,'REC-N2','{}','{}','mismatch','{"a":1}')`, expectOk: false },
      { label: '终态ledger_added缺checked_*负向', sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, result) VALUES (5,'REC-N3','{}','ledger_added')`, expectOk: false },
      { label: '终态confirmed_off_book缺checked_*负向', sql: `INSERT INTO it_reconcile_items (reconcile_id, asset_id, ledger_snapshot, result) VALUES (5,9107,'{}','confirmed_off_book')`, expectOk: false },
      { label: '终态ledger_fixed缺checked_*负向', sql: `INSERT INTO it_reconcile_items (reconcile_id, external_key, external_row, ambiguous_candidates, result) VALUES (5,'REC-N4','{}','[{},{}]','ledger_fixed')`, expectOk: false },
    ];
    for (const c of recCases) {
      let err = null;
      try { await rawRunOn(TEST_DB, c.sql); } catch (e) { err = e; }
      if (c.expectOk) {
        check(`rec回补: ${c.label} 插入成功`, !err, err && err.message);
      } else {
        check(`rec回补: ${c.label} 被CHECK拒`, err && /CHECK constraint failed|NOT NULL constraint failed/i.test(err.message || ''), err && err.message);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // 组5：normalizeReconcileKey 七步（spec §3 用例5）。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = '组5: normalizeReconcileKey七步';
    const nrk = moduleA._internals.normalizeReconcileKey;
    check('组5: KEY_RULE_VERSION=1', moduleA._internals.KEY_RULE_VERSION === 1);
    const nrkCases = [
      ['null(非字符串)', null, { ok: false, reason: 'empty' }],
      ['单个换行', '\n', { ok: false, reason: 'newline' }],
      ["'a\\nb'内部换行", 'a\nb', { ok: false, reason: 'newline' }],
      ["' \\nX '首尾换行(不因trim变合法)", ' \nX ', { ok: false, reason: 'newline' }],
      ['全角空格(U+3000)→empty', '　', { ok: false, reason: 'empty' }],
      ["'yw01-02-267'规范化", 'yw01-02-267', { ok: true, key: 'YW01-02-267' }],
      ["'a b'内部空格→charset", 'a b', { ok: false, reason: 'charset' }],
      ['65字符→charset', 'a'.repeat(65), { ok: false, reason: 'charset' }],
      ['64字符→ok', 'a'.repeat(64), { ok: true, key: 'A'.repeat(64) }],
      ['空对象{}不抛', {}, { ok: false, reason: 'empty' }],
      ['数字123不抛', 123, { ok: false, reason: 'empty' }],
      ['undefined不抛', undefined, { ok: false, reason: 'empty' }],
    ];
    for (const [label, input, expected] of nrkCases) {
      let result, threw = false;
      try { result = nrk(input); } catch (e) { threw = true; result = e; }
      check(`组5: ${label}`, !threw && JSON.stringify(result) === JSON.stringify(expected),
        `threw=${threw} actual=${JSON.stringify(result)} expected=${JSON.stringify(expected)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    // 组6（M2回补，codex 18 MED）：索引结构改 PRAGMA index_list/index_info 核 unique/partial 位
    //   与列序（不再靠 /UNIQUE/i 正则——它会连"CREATE INDEX ... _unique"这种只是名字含unique
    //   但语句本身是非唯一索引的情况也判过）；partial 谓词仍核 sqlite_master.sql 文本；
    //   行为对拍 + 静态文本断言（DDL 文本含两处 CREATE UNIQUE INDEX）双保险——codex 19预筛
    //   rec②回补：此前"活体变异"措辞不准确，本用例只是对 DDL 源码文本做静态正则断言，没有
    //   真的运行时改写/替换任何行为，改称"静态文本断言"，与真正的运行时活体变异（比如
    //   verify-it-ledger.js 用例T6 那种真实改 DDL 再执行验证的场景）区分开。
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = '组6: 索引结构(PRAGMA index_list/index_info)+行为对拍+静态文本断言(M2回补)';
    const idxList = await rawAllOn(TEST_DB, 'PRAGMA index_list(it_reconcile_items)');
    const idxListByName = {};
    for (const r of idxList) idxListByName[r.name] = r;
    const extKeyIdx = idxListByName['idx_it_reconcile_items_ext_key_unique'];
    const assetIdIdx = idxListByName['idx_it_reconcile_items_asset_id_unique'];
    const resultIdx = idxListByName['idx_it_reconcile_items_result'];
    check('组6: idx_ext_key_unique存在且unique=1/partial=1', !!extKeyIdx && extKeyIdx.unique === 1 && extKeyIdx.partial === 1, JSON.stringify(extKeyIdx));
    check('组6: idx_asset_id_unique存在且unique=1/partial=1', !!assetIdIdx && assetIdIdx.unique === 1 && assetIdIdx.partial === 1, JSON.stringify(assetIdIdx));
    check('组6: idx_result存在且unique=0/partial=0', !!resultIdx && resultIdx.unique === 0 && resultIdx.partial === 0, JSON.stringify(resultIdx));

    async function indexColSeq(name) {
      const info = await rawAllOn(TEST_DB, `PRAGMA index_info(${name})`);
      return info.sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
    }
    check('组6: idx_ext_key_unique列序=[reconcile_id,external_key]',
      JSON.stringify(await indexColSeq('idx_it_reconcile_items_ext_key_unique')) === JSON.stringify(['reconcile_id', 'external_key']));
    check('组6: idx_asset_id_unique列序=[reconcile_id,asset_id]',
      JSON.stringify(await indexColSeq('idx_it_reconcile_items_asset_id_unique')) === JSON.stringify(['reconcile_id', 'asset_id']));
    check('组6: idx_result列序=[reconcile_id,result]',
      JSON.stringify(await indexColSeq('idx_it_reconcile_items_result')) === JSON.stringify(['reconcile_id', 'result']));

    // partial 谓词文本仍核 sqlite_master.sql（PRAGMA index_list 只给 partial 位，不给谓词本身）。
    const idxSqlRows = await rawAllOn(TEST_DB, "SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE 'idx_it_reconcile_items_%'");
    const idxSqlByName = {};
    for (const r of idxSqlRows) idxSqlByName[r.name] = r.sql;
    check('组6: idx_ext_key_unique的WHERE谓词含external_key IS NOT NULL文本',
      /external_key\s+IS\s+NOT\s+NULL/i.test(idxSqlByName['idx_it_reconcile_items_ext_key_unique'] || ''));
    check('组6: idx_asset_id_unique的WHERE谓词含asset_id IS NOT NULL文本',
      /asset_id\s+IS\s+NOT\s+NULL/i.test(idxSqlByName['idx_it_reconcile_items_asset_id_unique'] || ''));

    // 静态文本断言：DDL 语句文本本身须含两处 CREATE UNIQUE INDEX——防止把 UNIQUE INDEX 悄悄
    //   改成非唯一 INDEX 却因为索引名仍叫"..._unique"而测不出来。
    const reconcileDdlSqlTexts = moduleA._internals.RECONCILE_DDL_STATEMENTS.map(([, sql]) => sql);
    const uniqueIndexDdlCount = reconcileDdlSqlTexts.filter((sql) => /CREATE\s+UNIQUE\s+INDEX/i.test(sql)).length;
    check('组6(静态文本断言): RECONCILE_DDL_STATEMENTS文本含两处CREATE UNIQUE INDEX', uniqueIndexDdlCount === 2, `count=${uniqueIndexDdlCount}`);

    // 行为对拍：同批插入重复 external_key 被拒、重复 asset_id 被拒、跨批相同值允许、
    //   external_key IS NULL 的多行不撞唯一（partial index 的核心语义）。
    await rawRunOn(TEST_DB, `INSERT INTO it_reconciles (id, title, status, source_meta, created_by) VALUES (6,'M2行为对拍批次A','open','{}',1)`);
    await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result) VALUES (6,9201,'DUPKEY','{}','{}','pending')`);
    let dupExtKeyErr = null;
    try { await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result) VALUES (6,9202,'DUPKEY','{}','{}','pending')`); } catch (e) { dupExtKeyErr = e; }
    check('组6: 同批重复external_key被拒', dupExtKeyErr && /UNIQUE constraint failed/i.test(dupExtKeyErr.message || ''), dupExtKeyErr && dupExtKeyErr.message);

    await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, ledger_snapshot, result) VALUES (6,9203,'{}','not_in_sheet')`);
    let dupAssetIdErr = null;
    try { await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, ledger_snapshot, result) VALUES (6,9203,'{}','not_in_sheet')`); } catch (e) { dupAssetIdErr = e; }
    check('组6: 同批重复asset_id被拒', dupAssetIdErr && /UNIQUE constraint failed/i.test(dupAssetIdErr.message || ''), dupAssetIdErr && dupAssetIdErr.message);

    // 跨批相同 external_key 允许（唯一索引按 reconcile_id 维度分区）。
    await rawRunOn(TEST_DB, `INSERT INTO it_reconciles (id, title, status, source_meta, created_by) VALUES (7,'M2跨批批次B','open','{}',1)`);
    let crossBatchErr = null;
    try { await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, external_key, external_row, ledger_snapshot, result) VALUES (7,9204,'DUPKEY','{}','{}','pending')`); } catch (e) { crossBatchErr = e; }
    check('组6: 跨批相同external_key允许', !crossBatchErr, crossBatchErr && crossBatchErr.message);

    // codex 19预筛 rec①回补：跨批相同 asset_id 也应允许（同一条 partial unique 索引
    //   UNIQUE(reconcile_id,asset_id) 两个维度都要各自验证跨批场景，不能只测了 external_key
    //   跨批就当 asset_id 跨批"理所当然也一样"——两条索引是独立的两条 CREATE UNIQUE INDEX 语句，
    //   逐条验证不合并判断）。复用批次7、asset_id=9203（与批次6里已插入的9203同值）。
    let crossBatchAssetIdErr = null;
    try { await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, ledger_snapshot, result) VALUES (7,9203,'{}','not_in_sheet')`); } catch (e) { crossBatchAssetIdErr = e; }
    check('组6: 跨批相同asset_id允许', !crossBatchAssetIdErr, crossBatchAssetIdErr && crossBatchAssetIdErr.message);

    // external_key 为 NULL 的多行不撞唯一（partial index WHERE external_key IS NOT NULL 排除 NULL）。
    let nullKeyErr1 = null; let nullKeyErr2 = null;
    try { await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, ledger_snapshot, result) VALUES (6,9205,'{}','not_in_sheet')`); } catch (e) { nullKeyErr1 = e; }
    try { await rawRunOn(TEST_DB, `INSERT INTO it_reconcile_items (reconcile_id, asset_id, ledger_snapshot, result) VALUES (6,9206,'{}','not_in_sheet')`); } catch (e) { nullKeyErr2 = e; }
    check('组6: 多行external_key为NULL不撞唯一(均无external_key,分别插入均成功)', !nullKeyErr1 && !nullKeyErr2, `${nullKeyErr1 && nullKeyErr1.message} / ${nullKeyErr2 && nullKeyErr2.message}`);

    // ══════════════════════════════════════════════════════════════════
    // 组7（M3回补，codex 18 MED；codex 19预筛 M3 再回补①②③④）：原子性覆盖"存量行 + 旧结构"。
    //   ①参数化覆盖第二列(owner_dept)与第三列(asset_class)ALTER失败各一遍(不只测一列)
    //   ②旧库预建 it_assets 既有三索引(照真实DDL的索引语句)，失败后比对索引定义快照
    //   ③恢复后按旧列清单逐列比对全部3行资产+1行事件的每个列值(不只id)，断言新增三列均NULL
    //   ④旧结构DDL恢复REFERENCES子句，与C1 DDL_STATEMENTS逐字同源(标准化后)，静态断言防漂移
    // ══════════════════════════════════════════════════════════════════
    currentCaseLabel = '组7: 原子性覆盖存量行+旧结构(M3回补,codex19再回补)';
    // M3④：旧版 it_assets DDL 恢复 REFERENCES 子句（FK 关，PRAGMA foreign_keys 恒默认关闭，
    //   无副作用）——除此之外与 C1 DDL_STATEMENTS['CREATE it_assets'] 逐字同源（标准化后）。
    const GROUP7_OLD_ASSET_DDL = `CREATE TABLE it_assets (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_no            TEXT,
      category            TEXT NOT NULL CHECK (category IN ('server','disk','laptop','desktop','ap','software','subscription','other')),
      name                TEXT NOT NULL,
      brand               TEXT,
      model               TEXT,
      sn                  TEXT,
      status              TEXT NOT NULL CHECK (status IN ('in_service','in_depot','faulty','to_retire','retired','active','cancelled')),
      slot_count          INTEGER NOT NULL DEFAULT 0 CHECK (slot_count >= 0),
      u_height            INTEGER NOT NULL DEFAULT 0 CHECK (u_height >= 0),
      u_start             INTEGER CHECK (u_start IS NULL OR u_start > 0),
      rack_id             INTEGER REFERENCES it_racks(id),
      location_text       TEXT,
      floor_id            TEXT REFERENCES it_floors(id),
      room_id             TEXT,
      pos                 TEXT,
      parent_asset_id     INTEGER REFERENCES it_assets(id),
      slot_no             INTEGER CHECK (slot_no IS NULL OR slot_no > 0),
      custodian_user_id   INTEGER REFERENCES users(id),
      custodian_name      TEXT,
      purchased_at        TEXT,
      expires_at          TEXT,
      attrs               TEXT NOT NULL DEFAULT '{}',
      fin_amount          REAL,
      fin_vendor          TEXT,
      fin_contract_no     TEXT,
      note                TEXT,
      version             INTEGER NOT NULL DEFAULT 1,
      created_by          INTEGER NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`;
    const GROUP7_OLD_EVENT_DDL = `CREATE TABLE it_asset_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      op_id              TEXT NOT NULL,
      asset_id           INTEGER REFERENCES it_assets(id),
      action             TEXT NOT NULL,
      role               TEXT NOT NULL,
      related_asset_id   INTEGER,
      from_state         TEXT NOT NULL,
      to_state           TEXT NOT NULL,
      operator_id        INTEGER NOT NULL,
      note               TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`;
    // M3②：旧库预建 it_assets 既有三索引，文本照抄生产 DDL_STATEMENTS 里对应索引语句（去掉
    //   IF NOT EXISTS，效果一致——旧库里这些索引本就该已经存在）。
    const GROUP7_OLD_ASSET_INDEXES = [
      `CREATE UNIQUE INDEX idx_it_assets_asset_no_unique ON it_assets(asset_no) WHERE asset_no IS NOT NULL`,
      `CREATE UNIQUE INDEX idx_it_assets_sn_unique ON it_assets(sn) WHERE sn IS NOT NULL`,
      `CREATE UNIQUE INDEX idx_it_assets_parent_slot_unique ON it_assets(parent_asset_id, slot_no) WHERE parent_asset_id IS NOT NULL`,
    ];

    // M3④静态防漂移断言：标准化后逐字比对手写旧DDL与生产DDL_STATEMENTS里的'CREATE it_assets'
    //   （过滤掉 owner_name/owner_dept/asset_class 三列定义行——若未来这三列被误改成写进
    //   CREATE TABLE 本体而非 ALTER 追加，本断言仍应把它们从对比中剔除后比较剩余部分）。
    function normalizeDdlTextForCompare(sql) {
      const joined = sql
        .replace(/CREATE TABLE IF NOT EXISTS/i, 'CREATE TABLE')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^(owner_name|owner_dept|asset_class)\b/.test(line))
        .join(' ');
      // codex 19-R risk3回补：空白折叠只作用于字符串字面量之外——按单引号切分，偶数段(下标
      // 0,2,4...)在字面量外可折叠空白，奇数段(下标1,3,5...)在字面量内原样保留。本文件当前
      // 字面量('server'/'disk'等)都不含内部空白，是防御性写法：万一未来字面量里出现空格
      // （比如某个 CHECK 枚举值本身含空格），全局折叠会悄悄改变字面量内容、让比较基准失真。
      const parts = joined.split("'");
      const normalizedParts = parts.map((part, i) => (i % 2 === 0 ? part.replace(/\s+/g, ' ') : part));
      return normalizedParts.join("'").trim();
    }
    const productionAssetDdlEntry = moduleA._internals.DDL_STATEMENTS.find(([label]) => label === 'CREATE it_assets');
    const normalizedOldDdl = normalizeDdlTextForCompare(GROUP7_OLD_ASSET_DDL);
    const normalizedProdDdl = normalizeDdlTextForCompare(productionAssetDdlEntry[1]);
    check('组7(M3④静态防漂移): 手写旧结构DDL标准化后与生产DDL_STATEMENTS的CREATE it_assets标准化后逐字一致',
      normalizedOldDdl === normalizedProdDdl,
      `旧=${normalizedOldDdl}\n生产=${normalizedProdDdl}`);

    // M3①③②：把整套"建旧库→注入→断言原子性→复原→逐列比对"抽成参数化函数，跑两遍
    //   （第二列owner_dept / 第三列asset_class各失败一次）。
    async function runGroup7Scenario(dbFile, failColumn, label) {
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
      await rawRunOn(dbFile, GROUP7_OLD_ASSET_DDL);
      await rawRunOn(dbFile, GROUP7_OLD_EVENT_DDL);
      for (const idxSql of GROUP7_OLD_ASSET_INDEXES) {
        // eslint-disable-next-line no-await-in-loop
        await rawRunOn(dbFile, idxSql);
      }
      await rawRunOn(dbFile, `INSERT INTO it_assets (id, asset_no, category, name, status, created_by) VALUES (201,'${label}-A201','server','旧结构服务器A','in_service',1)`);
      await rawRunOn(dbFile, `INSERT INTO it_assets (id, asset_no, category, name, status, created_by) VALUES (202,'${label}-A202','laptop','旧结构笔记本B','in_service',1)`);
      await rawRunOn(dbFile, `INSERT INTO it_assets (id, asset_no, category, name, status, created_by) VALUES (203,'${label}-A203','desktop','旧结构台式机C','in_depot',1)`);
      await rawRunOn(dbFile, `INSERT INTO it_asset_events (op_id, asset_id, action, role, from_state, to_state, operator_id) VALUES ('op-legacy-1',201,'place','primary','{}','{}',1)`);

      const beforeAssetCols = normalizeCols(await rawAllOn(dbFile, 'PRAGMA table_info(it_assets)'));
      const beforeAssetRows = await rawAllOn(dbFile, 'SELECT * FROM it_assets ORDER BY id');
      const beforeEventRows = await rawAllOn(dbFile, 'SELECT * FROM it_asset_events ORDER BY id');
      const beforeIndexDefs = await rawAllOn(dbFile, "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='it_assets' ORDER BY name");

      const mod = itLedgerFactory({
        logger, DB_FILE: dbFile, authenticateToken: (req, res, next) => next(), requireAdmin: (req, res, next) => next(),
        enableTestHooks: true,
      });
      mod._internals.setDdlFailureInjection(`ALTER it_assets ADD COLUMN ${failColumn}`);
      await awaitSettle(mod.initSchema(), 15000, `${label}: 等待注入后首次initSchema()落定`);

      check(`${label}: 注入后state.ready=false`, mod._internals.state.ready === false);
      check(`${label}: 注入后isDbOpen()=false(未发布连接已关闭)`, mod._internals.isDbOpen() === false);
      const closedProbe = await probeClosedDb(mod._internals.getLastOpenedDbForTest());
      check(`${label}: 连接已关闭(probeClosedDb证句柄)`, closedProbe.ok === true && closedProbe.closed === true, JSON.stringify(closedProbe));

      const afterAssetCols = normalizeCols(await rawAllOn(dbFile, 'PRAGMA table_info(it_assets)'));
      const afterAssetRows = await rawAllOn(dbFile, 'SELECT * FROM it_assets ORDER BY id');
      const afterEventRows = await rawAllOn(dbFile, 'SELECT * FROM it_asset_events ORDER BY id');
      const afterIndexDefs = await rawAllOn(dbFile, "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='it_assets' ORDER BY name");
      check(`${label}: it_assets列定义快照不变(旧结构,PRAGMA table_info逐列全等)`,
        JSON.stringify(beforeAssetCols) === JSON.stringify(afterAssetCols),
        `before=${JSON.stringify(beforeAssetCols)} after=${JSON.stringify(afterAssetCols)}`);
      check(`${label}: it_assets行数据快照不变(3行,逐行全字段全等)`,
        JSON.stringify(beforeAssetRows) === JSON.stringify(afterAssetRows) && afterAssetRows.length === 3);
      check(`${label}: it_asset_events行数据不变(1行)`,
        JSON.stringify(beforeEventRows) === JSON.stringify(afterEventRows) && afterEventRows.length === 1);
      check(`${label}: it_assets既有三索引定义快照不变(sqlite_master.sql逐条比对)`,
        JSON.stringify(beforeIndexDefs) === JSON.stringify(afterIndexDefs),
        `before=${JSON.stringify(beforeIndexDefs)} after=${JSON.stringify(afterIndexDefs)}`);
      const tablesAfterFail = (await rawAllOn(dbFile, "SELECT name FROM sqlite_master WHERE type='table'")).map((t) => t.name);
      check(`${label}: it_reconciles不存在`, !tablesAfterFail.includes('it_reconciles'), JSON.stringify(tablesAfterFail));
      check(`${label}: it_reconcile_items不存在`, !tablesAfterFail.includes('it_reconcile_items'), JSON.stringify(tablesAfterFail));
      const idxAfterFail = (await rawAllOn(dbFile, "SELECT name FROM sqlite_master WHERE type='index'")).map((t) => t.name);
      check(`${label}: 对账三索引均不存在`,
        !mod._internals.RECONCILE_REQUIRED_INDEXES.some((n) => idxAfterFail.includes(n)), JSON.stringify(idxAfterFail));

      // 清除注入，再跑一次 → 全部就位 ready。
      mod._internals.setDdlFailureInjection(null);
      const rebuildResult = await awaitSettle(mod._internals.reinitForTest(), 15000, `${label}: 等待reinitForTest()落定`);
      check(`${label}: 复原后ok:true`, rebuildResult && rebuildResult.ok === true, JSON.stringify(rebuildResult));
      check(`${label}: 复原后state.ready=true`, mod._internals.state.ready === true, JSON.stringify(mod._internals.state));
      const assetColsAfterRebuild = (await rawAllOn(dbFile, 'PRAGMA table_info(it_assets)')).map((c) => c.name);
      check(`${label}: 复原后it_assets含P10三列`, ['owner_name', 'owner_dept', 'asset_class'].every((c) => assetColsAfterRebuild.includes(c)), JSON.stringify(assetColsAfterRebuild));

      // M3③：逐列比对全部3行资产+1行事件的每个列值(不只id)，并断言新增三列均为NULL。
      const assetRowsAfterRebuild = await rawAllOn(dbFile, 'SELECT * FROM it_assets ORDER BY id');
      const rowsMatchFully = assetRowsAfterRebuild.length === beforeAssetRows.length &&
        assetRowsAfterRebuild.every((row, i) => {
          const beforeRow = beforeAssetRows[i];
          const oldColsMatch = Object.keys(beforeRow).every((k) => row[k] === beforeRow[k]);
          const newColsNull = row.owner_name === null && row.owner_dept === null && row.asset_class === null;
          return oldColsMatch && newColsNull;
        });
      check(`${label}: 复原后3行资产逐列比对(旧列清单全字段值不变+新增三列均为NULL)`, rowsMatchFully,
        JSON.stringify({ before: beforeAssetRows, after: assetRowsAfterRebuild }));
      const eventRowsAfterRebuild = await rawAllOn(dbFile, 'SELECT * FROM it_asset_events ORDER BY id');
      check(`${label}: 复原后事件行逐列比对(全字段值不变)`,
        JSON.stringify(eventRowsAfterRebuild) === JSON.stringify(beforeEventRows),
        `before=${JSON.stringify(beforeEventRows)} after=${JSON.stringify(eventRowsAfterRebuild)}`);

      return mod;
    }

    const TEST_DB3_OWNER_DEPT = TEST_DB3.replace(/\.db$/, '-owner_dept.db');
    const TEST_DB3_ASSET_CLASS = TEST_DB3.replace(/\.db$/, '-asset_class.db');
    moduleC = await runGroup7Scenario(TEST_DB3_OWNER_DEPT, 'owner_dept', '组7-第二列owner_dept失败');
    moduleC2 = await runGroup7Scenario(TEST_DB3_ASSET_CLASS, 'asset_class', '组7-第三列asset_class失败');

    currentCaseLabel = 'R2上传解析分类';
    await require('./verify-it-reconcile-r2-cases')({ check, withTimeout, rawAllOn, rawRunOn, logger });
    currentCaseLabel = 'R3对账端点状态机';
    await require('./verify-it-reconcile-r3-cases')({ check, withTimeout, rawAllOn, rawRunOn, logger });
    currentCaseLabel = 'R4导出隔离与F1';
    await require('./verify-it-reconcile-r4-cases')({ check, withTimeout, rawAllOn, rawRunOn, logger });
    currentCaseLabel = '(收尾)';
  } catch (fatalErr) {
    check('FATAL: verify 脚本自身异常', false, fatalErr && fatalErr.stack);
  } finally {
    // 同 verify-it-ledger.js T4：兜底关闭，Windows 下未释放的文件句柄会让 unlinkSync 直接失败。
    for (const mod of [moduleA, moduleB, moduleC, moduleC2, moduleH1a, moduleH1b, moduleH1c, moduleH1d, moduleH1e, moduleH2, moduleMed1, moduleH3, moduleH4a, moduleH4b]) {
      if (!mod) continue;
      try {
        await withTimeout(mod.shutdown(), 5000, 'main finally: shutdown()落定');
      } catch (e) {
        fatalExit('main finally: shutdown()未在5s内落定(疑似真死锁)', e && e.message);
      }
    }
    // MED-6回补：checkReconcileStructure直调用的两条裸连接不经模块管理，独立关闭。
    for (const rawDb of [rawDbMed6, rawDbMed6b]) {
      if (!rawDb) continue;
      try {
        await withTimeout(new Promise((resolve) => rawDb.close(() => resolve())), 5000, 'main finally: 裸连接close()落定');
      } catch (e) {
        fatalExit('main finally: 裸连接close()未在5s内落定', e && e.message);
      }
    }
    const h1DbFiles = ['h1a', 'h1b', 'h1c', 'h1d', 'h1e', 'h2', 'med1', 'h3', 'h4a', 'h4b', 'med6', 'med6b', 'owner_dept', 'asset_class', 'probe-selftest'].map((suffix) => TEST_DB3.replace(/\.db$/, `-${suffix}.db`));
    for (const f of [TEST_DB, TEST_DB2, TEST_DB3, ...h1DbFiles]) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (unlinkErr) {
        check('收尾: 临时库文件删除成功', false, `临时库删除失败: ${f} ${unlinkErr && unlinkErr.message}`);
      }
    }
    clearTimeout(mainDeadlineTimer);
  }

  require('./verify-it-reconcile-groups').verify(observations.slice(), check);
  const mutation = require('child_process').spawnSync(process.execPath, [path.join(__dirname,'verify-it-reconcile-mutations.js')], {cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
  check('R6活体变异子过程完整通过', mutation.status===0&&!mutation.error&&!mutation.signal&&/(?:^|\n)PASS=9 FAIL=0\s*$/.test(mutation.stdout||''), mutation.stderr);
  console.log(results.join('\n'));
  console.log(mutation.stdout||'');
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('verify-it-reconcile 致命错误:', err && err.stack || err);
  process.exit(1);
});
