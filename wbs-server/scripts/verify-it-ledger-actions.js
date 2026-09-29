/**
 * C3 机柜动作族 + C4 硬盘动作 verify · 信息化资产轻量台账（长任务 D · L3/L4）
 * 方案 docs/local/信息化资产_轻量版/信息化资产轻量台账_方案_20260918_v0.7.md §4/§13
 * 执行 agent spec docs/local/信息化资产_轻量版/_agent_specs/C3_机柜动作_spec.md §6
 *
 * 写法：与 verify-it-ledger-write.js 同款——独立 express 实例挂本模块路由，临时 db 文件，伪造
 * authenticateToken/requireAdmin。本文件独立起自己的 express/db/助手，不 require 其它 verify
 * 文件，避免波及已冻结的 C1/C2/R1 守卫基线。
 *
 * 覆盖范围说明（H3，第3批如实记账，按实到重写）：
 * - S（schema 校验器）：完整行契约 + ctx 五种元素形态 + 27 列类型校验（H2 后，ASSET_COLUMN_SCHEMA
 *   实到条目数，含第3批新增的 expires_at/rack_id/parent_asset_id/custodian_user_id/version）。
 * - N1（骨架协议）：含排队期撤权（H5，照抄 write.js I 组范式，awaitArrived+waiterCount 固定顺序）。
 * - N2（六动作 × 硬件五态 + software）：满表，手写期望表逐格断言 + 非法格行/事件快照不变 +
 *   ACTION_NOT_ALLOWED_IN_STATUS 格另核 detail.current_status（M14）。
 * - N3（U 区间，含 Promise.all 并发）。
 * - N4（下架去向与联动 1+n 事件）。
 * - N5（随装盘与 retire 链路）。
 * - N6（脏数据拦截）：两例，均先跑干净态对照组；例2 断言定死 400 LEDGER_BAD_REQUEST
 *   field=rack_id（H4，spec §6 原文写 409 是主会话笔误）。
 * - N7（活体变异）：① 子盘 UPDATE 被注掉——H1 重写后同一请求内即暴露 409
 *   HOST_DISK_STATUS_SYNC 且事务回滚（不再需要借道独立 PUT）；② 逐子盘校验循环被注掉——用
 *   子盘专属、宿主聚合视角看不到的 u_height 字段隔离（干净侧 400 field=u_height，变异侧 200
 *   且 u_height 仍为 3）；③ schema 校验器调用被注掉——纯函数直调。三处均写死双侧结果。
 * - N8（事件载荷与 PAYLOAD_KEYS 对拍）：H6 改为真事件对拍——六动作各跑一次成功请求，按
 *   op_id 取事件行，from_state/to_state 键集合 + 值逐个 === 与手写期望表比对（不只对键集合）。
 * - N9（并发终态一致性，登记 vs 下架竞争两种顺序）。
 * - N10（错误码闭集）。
 * 全部十组均已实现且有真实反例/断言，无本轮遗留的"未实现"分组。
 *
 * 用法：node scripts/verify-it-ledger-actions.js
 */
'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const fetchTestHttp = require('./lib/test-http-fetch');
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const TEST_DB = path.join(os.tmpdir(), `it-ledger-actions-verify-${Date.now()}-${process.pid}.db`);

let pass = 0; let fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`[OK] ${name}`); } else { fail++; results.push(`[FAIL] ${name}${detail ? ' · ' + String(detail) : ''}`); }
}
function fatalExit(label, detail) {
  check(label, false, detail);
  console.error(`[FATAL] ${label}${detail ? ' · ' + String(detail) : ''}——终止 verify 进程`);
  console.error(`[FATAL] 当前汇总 PASS=${pass} FAIL=${fail}`);
  console.error(`[FATAL] TEST_DB=${TEST_DB}（临时文件留待人工清理，本进程不再尝试删除）`);
  process.exit(1);
}
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label}超时(>${ms}ms)`), { __timeout: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function schedulingBarrier() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}
// awaitArrived（第3批·H5，同 verify-it-ledger-write.js 同款范式）：等待一个"到达信号" Promise，
// 若绑定的操作在到达信号前就已经 resolve/reject，视为时序假设不成立，直接 fatalExit（不是弱弱
// 地放过去）。
async function awaitArrived(arrivedPromise, label, opPromise) {
  const racers = [arrivedPromise.then(() => ({ kind: 'arrived' }))];
  if (opPromise) {
    racers.push(opPromise.then(
      (v) => ({ kind: 'earlyDone', value: v }),
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
    return;
  }
  if (result && result.kind === 'earlyDone') {
    fatalExit(`${label}: 对应操作在到达信号之前就已正常结束(时序假设不成立)`, JSON.stringify(result.value));
    return;
  }
}
// waitForCondition（第2批·N9 并发用，同 verify-it-ledger-write.js 同款范式）：轮询一个布尔条件，
// 超时直接 fatalExit（不弱弱地 check(false) 后继续跑），避免裸 setTimeout 轮询循环。
async function waitForCondition(predicateFn, label, timeoutMs) {
  const poll = new Promise((resolve) => {
    const tick = () => (predicateFn() ? resolve(true) : setTimeout(tick, 10));
    tick();
  });
  try {
    return await withTimeout(poll, timeoutMs || 3000, label);
  } catch (e) {
    fatalExit(`${label}: 等待条件成立超时`, e && e.message);
    return undefined;
  }
}

function fakeAuthenticateToken(req, res, next) {
  const uid = req.headers['x-test-user-id'];
  if (uid === undefined) return res.status(401).json({ error: '未登录' });
  req.user = { id: Number(uid), role: req.headers['x-test-user-role'] || 'user' };
  next();
}
function fakeRequireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '权限不足' });
  next();
}
const logger = { info: () => {}, warn: (...a) => console.warn('[WARN]', ...a), error: (...a) => console.error('[ERROR]', ...a) };

async function seedUsers(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath || TEST_DB);
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        role TEXT DEFAULT 'user',
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT (datetime('now','localtime'))
      )`);
      const stmt = db.prepare('INSERT INTO users (id, username, password, display_name, role) VALUES (?,?,?,?,?)');
      stmt.run(1, 'admin', 'x', '管理员', 'admin');
      stmt.run(2, 'alice', 'x', 'Alice', 'user'); // ACL write
      stmt.run(3, 'bob', 'x', 'Bob', 'user'); // ACL read
      stmt.finalize((err) => { db.close(() => (err ? reject(err) : resolve())); });
    });
  });
}

let seq = 0;
function uniq(prefix) { seq += 1; return `${prefix}-${Date.now()}-${seq}`; }

function rawRunAt(dbPath, sql, params) {
  const op = new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath);
    const closeAndSettle = (settle) => { db.close((closeErr) => { if (closeErr) console.warn('[WARN] rawRunAt close失败', closeErr.message); settle(); }); };
    db.run('PRAGMA busy_timeout = 5000', (pragmaErr) => {
      if (pragmaErr) { closeAndSettle(() => reject(pragmaErr)); return; }
      db.run(sql, params || [], function (e) {
        const lastID = this.lastID; const changes = this.changes;
        closeAndSettle(() => (e ? reject(e) : resolve({ lastID, changes })));
      });
    });
  });
  return withTimeout(op, 10000, `rawRunAt(${sql.slice(0, 40)}...)`);
}
function rawRun(sql, params) { return rawRunAt(TEST_DB, sql, params); }
function rawGetAt(dbPath, sql, params) {
  // L1（第9批）：resolve/reject 挪到 db.close 回调之后——关闭错误不再被静默吞掉，
  // 一旦 close 失败会连同查询错误一起冒泡给调用方（原版 db.close() 不等关闭结果就直接
  // resolve/reject，关闭失败永远测不出来）。
  // MED-2/LOW-3（第9批 Opus 复看）：改 OPEN_READONLY——dbPath 写错时 sqlite3 默认会静默建出
  // 一个空库再"查到"undefined，READONLY 下会直接以连接错误失败，不会把路径错误伪装成
  // "查无此行"；busy_timeout 对齐 rawRunAt，避免读侧撞上并发写事务的 SQLITE_BUSY 无谓失败。
  const op = new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) { reject(openErr); return; }
      db.run('PRAGMA busy_timeout = 5000', (pragmaErr) => {
        if (pragmaErr) { db.close(() => reject(pragmaErr)); return; }
        db.get(sql, params || [], (e, row) => {
          db.close((closeErr) => {
            if (e) return reject(e);
            if (closeErr) return reject(closeErr);
            resolve(row);
          });
        });
      });
    });
  });
  return withTimeout(op, 10000, `rawGetAt(${sql.slice(0, 40)}...)`);
}
function rawGet(sql, params) { return rawGetAt(TEST_DB, sql, params); }
function rawAllAt(dbPath, sql, params) {
  // MED-2/LOW-3（第9批）：同 rawGetAt——OPEN_READONLY + busy_timeout 对齐。
  const op = new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (openErr) => {
      if (openErr) { reject(openErr); return; }
      db.run('PRAGMA busy_timeout = 5000', (pragmaErr) => {
        if (pragmaErr) { db.close(() => reject(pragmaErr)); return; }
        db.all(sql, params || [], (e, rows) => {
          db.close((closeErr) => {
            if (e) return reject(e);
            if (closeErr) return reject(closeErr);
            resolve(rows);
          });
        });
      });
    });
  });
  return withTimeout(op, 10000, `rawAllAt(${sql.slice(0, 40)}...)`);
}
function rawAll(sql, params) { return rawAllAt(TEST_DB, sql, params); }

// ============================================================
// 第5批（29-S/29-T 合并修复）共用助手——先建好，下面全部用例组复用，避免同类断言各写一套。
// ============================================================

// sortObj：对象键排序后重建（不改值），配合 JSON.stringify 做"键集合+值"一次性精确比较
// （比"先比键数组、再比值"两段式更不容易漏斗——键多一个/少一个/值不同，三种情形统一在一次
// 字符串比较里现形）。
// LOW-4（第7批 Opus 复看）：改递归——原版只排顶层键，事件载荷若出现嵌套对象/数组（比如
// affected 载荷未来扩展成 {status, extra:{...}}），嵌套层的键序不归一会让 JSON.stringify 比较
// 产生假阴性（值完全一样，只因内层键序不同就判"不相等"）。数组保持原序（顺序本身是语义的一
// 部分，不排序，只递归归一数组内每个元素自己的键序）。
function sortObj(o) {
  if (Array.isArray(o)) return o.map(sortObj);
  if (o !== null && typeof o === 'object') {
    const keys = Object.keys(o).sort();
    const out = {};
    for (const k of keys) out[k] = sortObj(o[k]);
    return out;
  }
  return o;
}

// snapshotAssets(ids)：多个资产 id 的完整行快照，按 id 排序，供前后对拍。
async function snapshotAssets(ids) {
  const sorted = [...ids].sort((a, b) => a - b);
  const rows = [];
  for (const id of sorted) rows.push(await rawGet('SELECT * FROM it_assets WHERE id=?', [id]));
  return rows;
}
// snapshotEvents(assetIds)：这些资产的全部事件行快照（按 asset_id 再按 id 排序），含 from/to 原文。
async function snapshotEvents(assetIds) {
  const sorted = [...assetIds].sort((a, b) => a - b);
  const rows = [];
  for (const id of sorted) {
    const evts = await rawAll('SELECT * FROM it_asset_events WHERE asset_id=? ORDER BY id', [id]);
    rows.push(...evts);
  }
  return rows;
}
// snapshotAssetsFrom/snapshotEventsFrom（RT-H3，第8批）：同款快照助手，但指向任意 dbPath——
// N7①②的变异体世界用的是独立 mutantDb（不是全局 TEST_DB），mutApi 只有 HTTP 接口没有裸
// sqlite 句柄，这两个助手让变异体场景也能做"资产行+事件表"深等对拍，而不只是逐字段人工核对。
async function snapshotAssetsFrom(dbPath, ids) {
  const sorted = [...ids].sort((a, b) => a - b);
  const rows = [];
  for (const id of sorted) rows.push(await rawGetAt(dbPath, 'SELECT * FROM it_assets WHERE id=?', [id]));
  return rows;
}
async function snapshotEventsFrom(dbPath, assetIds) {
  const sorted = [...assetIds].sort((a, b) => a - b);
  const rows = [];
  for (const id of sorted) {
    const evts = await rawAllAt(dbPath, 'SELECT * FROM it_asset_events WHERE asset_id=? ORDER BY id', [id]);
    rows.push(...evts);
  }
  return rows;
}

// assertNoSideEffect(label, ids, fn)：执行前对 ids 涉及的资产行+完整事件表拍快照，跑 fn()（预期
// 会失败的请求），执行后再拍一次快照，深等比较（行 + 事件表），证明"这次被拒绝的请求真的没有
// 留下任何痕迹"（不只比 status/version 几个字段）。返回 fn() 的结果供调用方另断响应状态码/码。
// C4 自审补强：资产只证明传入 ids 的完整行，事件改为全表快照，不漏误写到其他 asset_id 的事件。
// 不能称作全库资产不变——调用方必须把该请求理论上可能触碰到的所有资产 id（含子盘/关联宿主）都
// 列进 ids，遗漏某个 id 会让那部分的副作用测不出来（这不是助手本身的缺陷，是调用点的覆盖面
// 责任，各调用点已按此原则逐一核对过传入的 id 列表）。
async function assertNoSideEffect(label, ids, fn) {
  const before = await snapshotAssets(ids);
  const beforeEvt = await rawAll('SELECT * FROM it_asset_events ORDER BY id');
  const res = await fn();
  const after = await snapshotAssets(ids);
  const afterEvt = await rawAll('SELECT * FROM it_asset_events ORDER BY id');
  check(`${label}: 资产行深等(无副作用)`, JSON.stringify(before) === JSON.stringify(after),
    `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  check(`${label}: 事件表深等(无副作用)`, JSON.stringify(beforeEvt) === JSON.stringify(afterEvt),
    `before=${JSON.stringify(beforeEvt)} after=${JSON.stringify(afterEvt)}`);
  return res;
}

// assertEventSet(label, opId, expect)：expect = { primary:{assetId,from,to}, affected:[{assetId,from,to},...] }
// 断言：op_id 非空；总行数=1+affected.length；primary 恰1行且 asset_id/related_asset_id(null)
// 正确；affected 行的 asset_id 集合与期望精确相等（不用 .every 弱判据）；每行 role 正确；
// 每行 from_state/to_state 键集合+值逐键比较全等（sortObj 一次性比较，收 T-L1）。
async function assertEventSetCore(rows, label, opId, expect, record = check) {
  record(`${label}: op_id非空字符串`, typeof opId === 'string' && opId.length > 0, JSON.stringify(opId));
  const primaryRows = rows.filter((r) => r.role === 'primary');
  const affectedRows = rows.filter((r) => r.role === 'affected');
  record(`${label}: 总行数=1+${expect.affected.length}`, rows.length === 1 + expect.affected.length,
    `实际${rows.length}行: ${JSON.stringify(rows.map((r) => ({ id: r.id, role: r.role, asset_id: r.asset_id })))}`);
  record(`${label}: role集合恰为{primary×1,affected×${expect.affected.length}}`,
    primaryRows.length === 1 && affectedRows.length === expect.affected.length,
    `primary=${primaryRows.length} affected=${affectedRows.length}`);
  if (primaryRows.length === 1) {
    const p = primaryRows[0];
    record(`${label}: primary.asset_id===${expect.primary.assetId}`, p.asset_id === expect.primary.assetId, p.asset_id);
    record(`${label}: primary.related_asset_id为null`, p.related_asset_id === null, p.related_asset_id);
    // MED-2（第7批）：补断 action / operator_id——此前只核对 role/asset_id/载荷，动作码写错
    // （比如误写成别的动作名）或 operator_id 记错人都测不出来。
    record(`${label}: primary.action===${expect.action}`, p.action === expect.action, p.action);
    record(`${label}: primary.operator_id===${expect.operator_id}`, p.operator_id === expect.operator_id, p.operator_id);
    const from = JSON.parse(p.from_state); const to = JSON.parse(p.to_state);
    record(`${label}: primary.from_state键集合+值全等`, JSON.stringify(sortObj(from)) === JSON.stringify(sortObj(expect.primary.from)),
      `实际=${JSON.stringify(from)} 期望=${JSON.stringify(expect.primary.from)}`);
    record(`${label}: primary.to_state键集合+值全等`, JSON.stringify(sortObj(to)) === JSON.stringify(sortObj(expect.primary.to)),
      `实际=${JSON.stringify(to)} 期望=${JSON.stringify(expect.primary.to)}`);
  }
  const affectedIdsActual = affectedRows.map((r) => r.asset_id).sort((a, b) => a - b);
  const affectedIdsExpected = expect.affected.map((a) => a.assetId).sort((a, b) => a - b);
  record(`${label}: affected的asset_id集合精确等于期望`,
    JSON.stringify(affectedIdsActual) === JSON.stringify(affectedIdsExpected),
    `实际=${JSON.stringify(affectedIdsActual)} 期望=${JSON.stringify(affectedIdsExpected)}`);
  for (const exp of expect.affected) {
    const row = affectedRows.find((r) => r.asset_id === exp.assetId);
    record(`${label}: affected(id=${exp.assetId})确实存在`, !!row, JSON.stringify(affectedRows.map((r) => r.asset_id)));
    if (row) {
      record(`${label}: affected(id=${exp.assetId}).related_asset_id===主资产id`, row.related_asset_id === expect.primary.assetId, row.related_asset_id);
      record(`${label}: affected(id=${exp.assetId}).action===${expect.action}`, row.action === expect.action, row.action);
      record(`${label}: affected(id=${exp.assetId}).operator_id===${expect.operator_id}`, row.operator_id === expect.operator_id, row.operator_id);
      const from = JSON.parse(row.from_state); const to = JSON.parse(row.to_state);
      record(`${label}: affected(id=${exp.assetId}).from_state键集合+值全等`,
        JSON.stringify(sortObj(from)) === JSON.stringify(sortObj(exp.from)), `实际=${JSON.stringify(from)} 期望=${JSON.stringify(exp.from)}`);
      record(`${label}: affected(id=${exp.assetId}).to_state键集合+值全等`,
        JSON.stringify(sortObj(to)) === JSON.stringify(sortObj(exp.to)), `实际=${JSON.stringify(to)} 期望=${JSON.stringify(exp.to)}`);
    }
  }
  return rows;
}
async function assertEventSet(label, opId, expect) {
  const rows = await rawAll('SELECT * FROM it_asset_events WHERE op_id=? ORDER BY id', [opId]);
  return assertEventSetCore(rows, label, opId, expect);
}
// assertEventSetFrom（RT-M3，第9批）：与 assertEventSet 完全同款比较逻辑（同一份
// assertEventSetCore），只是取数换成任意 dbPath——N7② 变异体世界只有独立 mutantDb，没有
// 全局 TEST_DB，用它核对变异体放行后 rack_in 的主+子盘事件行同样精确（角色/related_asset_id/
// action/operator_id/前后载荷全比对，不只查落库字段）。
async function assertEventSetFrom(dbPath, label, opId, expect) {
  const rows = await rawAllAt(dbPath, 'SELECT * FROM it_asset_events WHERE op_id=? ORDER BY id', [opId]);
  return assertEventSetCore(rows, label, opId, expect);
}

async function main() {
  let currentCaseLabel = '启动段';
  const MAIN_DEADLINE_MS = 180000;
  const mainDeadlineTimer = setTimeout(() => fatalExit('MAIN_DEADLINE 超时·仍在: ' + currentCaseLabel), MAIN_DEADLINE_MS);
  if (typeof mainDeadlineTimer.unref === 'function') mainDeadlineTimer.unref();

  let itLedgerModule = null;
  let server = null;

  // T-risk3（第5批，取代原 M12）：N7 的 index.js 变异体已改写到 scratchpad（见
  // withMutatedIndexModule），不再落进 routes/it-ledger/ 源码目录——不再需要启动段清扫。
  // .gitignore 里 `wbs-server/routes/it-ledger/index.mutant-*.js` 那条规则保留（无害，防止
  // 万一未来又有人往那个目录写同名文件）。

  try {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await seedUsers();

    const app = express();
    app.use(express.json());
    const itLedgerFactory = require('../routes/it-ledger');
    itLedgerModule = itLedgerFactory({
      logger, DB_FILE: TEST_DB, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
      enableTestHooks: true,
    });
    app.use('/api', itLedgerModule.router);
    const inv = itLedgerModule._internals.invariants;

    currentCaseLabel = '首次 initSchema() 真实调用';
    await withTimeout(itLedgerModule.initSchema(), 15000, '首次 initSchema() 调用落定');

    server = await listenOnSafePort(app, null);
    const PORT = server.address().port;
    const BASE = `http://localhost:${PORT}`;

    const observedCodes = new Set();
    async function api(method, urlPath, { uid, role, body } = {}) {
      const headers = { 'Content-Type': 'application/json' };
      if (uid !== undefined) headers['x-test-user-id'] = String(uid);
      if (role !== undefined) headers['x-test-user-role'] = String(role);
      const doFetch = (async () => {
        const r = await fetchTestHttp(`${BASE}${urlPath}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        let j = null;
        try { j = await r.json(); } catch (_e) { /* ignore */ }
        if (j && typeof j.code === 'string') observedCodes.add(j.code);
        return { status: r.status, body: j };
      })();
      try {
        return await withTimeout(doFetch, 5000, `api(${method} ${urlPath})`);
      } catch (e) {
        fatalExit(`api(${method} ${urlPath}) 超时/异常`, e && e.message);
        return undefined;
      }
    }
    function expectCode(res, code, label) {
      const ok = !!(res && res.body && res.body.code === code);
      check(label, ok, JSON.stringify(res && res.body));
      return ok;
    }

    try {
    currentCaseLabel = '等待 initSchema 就绪';
    await withTimeout(
      new Promise((resolve) => { const poll = () => (itLedgerModule._internals.state.ready ? resolve() : setTimeout(poll, 10)); poll(); }),
      15000, 'initSchema 就绪等待'
    );

    // ── 基础夹具 ──────────────────────────────────────────────────────────────
    currentCaseLabel = '夹具准备';
    await api('PUT', '/api/it-assets/acl/2', { uid: 1, role: 'admin', body: { level: 'write' } });
    await api('PUT', '/api/it-assets/acl/3', { uid: 1, role: 'admin', body: { level: 'read' } });

    function regAdmin(body) { return api('POST', '/api/it-assets', { uid: 1, role: 'admin', body }); }
    function actionAs(uid, role, id, action, body) { return api('POST', `/api/it-assets/${id}/actions/${action}`, { uid, role, body }); }
    function actionAdmin(id, action, body) { return actionAs(1, 'admin', id, action, body); }
    // freshVersion：GET /:id 响应形态是 {asset:{...}, events:[...]}（不是资产字段直接铺在顶层）。
    async function freshVersion(id) { const r = await api('GET', `/api/it-assets/${id}`, { uid: 1, role: 'admin' }); return r.body.asset.version; }
    // freshRack：每个需要"干净机柜"的用例各自开一个新机柜，避免跨用例占位互相干扰
    // （同一机柜跨 section 复用会让后一个 section 的"紧邻不重叠"类断言撞上前一个 section
    //   留下的在位设备，本轮调试已实证踩坑一次，改为默认隔离）。
    async function freshRack(uTotal) {
      const r = await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: uniq('RACK'), u_total: uTotal || 10 } });
      check('夹具: 新建隔离机柜成功', r.status === 201, JSON.stringify(r.body));
      return r.body.id;
    }
    const rackAId = await freshRack(10);
    const rackBId = await freshRack(10);

    // ============================================================
    // S. 前置形态校验器 validateRowSchema（spec §1/§6 S 组）——纯函数直调。
    // ============================================================
    currentCaseLabel = 'S组: validateRowSchema';
    function fullValidRow(overrides) {
      return Object.assign({
        id: undefined, asset_no: null, category: 'server', name: '主机', brand: null, model: null, sn: null,
        status: 'in_depot', slot_count: 0, u_height: 2, u_start: null, rack_id: null, location_text: null,
        floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null,
        custodian_user_id: null, custodian_name: null, purchased_at: null, expires_at: null, attrs: {},
        fin_amount: null, fin_vendor: null, fin_contract_no: null, note: null, version: 1, created_by: 1,
        created_at: null, updated_at: null, owner_name: null, owner_dept: null, asset_class: null,
      }, overrides || {});
    }
    check('S-合法完整行放行(null)', inv.validateRowSchema(fullValidRow(), {}) === null);
    {
      const row = fullValidRow(); delete row.sn;
      const v = inv.validateRowSchema(row, {});
      check('S-漏键(sn)→500 ROW_SCHEMA', v && v.status === 500 && v.code === 'LEDGER_INTERNAL' && v.rule === 'ROW_SCHEMA', JSON.stringify(v));
    }
    {
      const row = fullValidRow(); row.extra_col = 1;
      const v = inv.validateRowSchema(row, {});
      check('S-多键(extra_col)→500', v && v.status === 500, JSON.stringify(v));
    }
    {
      const row = fullValidRow(); row.brand = undefined;
      const v = inv.validateRowSchema(row, {});
      check('S-列undefined(非id)→500', v && v.status === 500, JSON.stringify(v));
    }
    check('S-id=undefined(新建)放行', inv.validateRowSchema(fullValidRow({ id: undefined }), {}) === null);
    check('S-id=安全正整数放行', inv.validateRowSchema(fullValidRow({ id: 5 }), {}) === null);
    // 主会话2026-09-20裁定A：id 有值时不做值域校验（不属于 ROW_SCHEMA 四类范围之一），
    // id=0 这类"业务上不合法但类型上是数字"的值，ROW_SCHEMA 层放行（null），交由更上层
    // （目前没有 RULE 管 id，属已知的、裁定内的空白，不是本层疏漏）。
    check('S-id=0(值域交由上层,ROW_SCHEMA放行null)', inv.validateRowSchema(fullValidRow({ id: 0 }), {}) === null);

    // 主会话2026-09-20裁定A（第3批 H2 收紧）：数值域列（u_height/slot_count/u_start/slot_no）
    // 与 status/category 六列的值域校验故意不在 ASSET_COLUMN_SCHEMA（留给既有 RULES 独占，
    // J 组变异测试要求每条 RULE 独占拦截），ROW_SCHEMA 对这六列的坏值一律放行 null。
    const REMOVED_FROM_ROW_SCHEMA = [
      ['category', 'not-a-category'], ['status', 123], ['slot_count', -1], ['u_height', 1.5],
      ['u_start', 0], ['slot_no', 0],
    ];
    for (const [col, badVal] of REMOVED_FROM_ROW_SCHEMA) {
      const row = fullValidRow(); row[col] = badVal;
      const v = inv.validateRowSchema(row, {});
      check(`S-已移出ROW_SCHEMA职责(${col}=${JSON.stringify(badVal)})→放行null(留给RULES)`, v === null, JSON.stringify(v));
    }

    // 既有 RULES 未覆盖的列——类型校验，400 LEDGER_BAD_REQUEST（主会话裁定A.3 + 第3批 H2
    // 补充 expires_at/rack_id/parent_asset_id/custodian_user_id/version 五列）。
    const BAD_COLUMN_CASES_400 = [
      ['asset_no', 123], ['name', 123], ['brand', 123], ['model', 123], ['sn', 123],
      ['location_text', 123], ['floor_id', 123], ['room_id', 123], ['pos', [1, 2]],
      ['custodian_name', 123], ['purchased_at', 123], ['expires_at', 123], ['attrs', []],
      ['fin_amount', {}], ['fin_vendor', {}], ['fin_contract_no', {}], ['note', 123],
      ['rack_id', -5], ['parent_asset_id', 'x'], ['custodian_user_id', 'x'], ['version', 0],
      ['created_by', -1], ['created_at', 123], ['updated_at', 123],
      ['owner_name', 123], ['owner_dept', 123], ['asset_class', 123],
    ];
    for (const [col, badVal] of BAD_COLUMN_CASES_400) {
      const row = fullValidRow(); row[col] = badVal;
      const v = inv.validateRowSchema(row, {});
      check(`S-列坏类型(${col}=${JSON.stringify(badVal)})→400 LEDGER_BAD_REQUEST`,
        v && v.status === 400 && v.code === 'LEDGER_BAD_REQUEST' && v.field === col && v.rule === 'ROW_SCHEMA', JSON.stringify(v));
    }
    // ctx 形态
    check('S-ctx空对象放行', inv.validateRowSchema(fullValidRow(), {}) === null);
    // LOW-2（第4批）：validateAssetInvariants 不再用 `ctx || {}` 兜底 null/undefined，直接
    // 透传给 validateRowSchema，M8 应判 500 ROW_SCHEMA field='ctx'。
    {
      const v1 = inv.validateAssetInvariants(fullValidRow(), null);
      check('S-validateAssetInvariants(row,null)→500 ROW_SCHEMA field=ctx',
        v1 && v1.status === 500 && v1.rule === 'ROW_SCHEMA' && v1.field === 'ctx', JSON.stringify(v1));
      const v2 = inv.validateAssetInvariants(fullValidRow(), undefined);
      check('S-validateAssetInvariants(row,undefined)→500 ROW_SCHEMA field=ctx',
        v2 && v2.status === 500 && v2.rule === 'ROW_SCHEMA' && v2.field === 'ctx', JSON.stringify(v2));
    }
    {
      const v = inv.validateRowSchema(fullValidRow(), { unknown_ctx_key: 1 });
      check('S-ctx多余键→500', v && v.status === 500, JSON.stringify(v));
    }
    check('S-ctx.rack合法放行', inv.validateRowSchema(fullValidRow(), { rack: { u_total: 10 } }) === null);
    {
      const v = inv.validateRowSchema(fullValidRow(), { rack: { u_total: 10, extra: 1 } });
      check('S-ctx.rack多余键→500', v && v.status === 500, JSON.stringify(v));
    }
    {
      // S-L1（第5批）：原型链注入反例——自身只有 extra 键（长度凑巧=1），u_total 从原型继承；
      // ownKeysEqual 用 Object.keys 精确比较键名而非只比数量，应判违反。
      const maliciousRack = Object.assign(Object.create({ u_total: 42 }), { extra: 1 });
      const v = inv.validateRowSchema(fullValidRow(), { rack: maliciousRack });
      check('S-L1-ctx.rack原型链注入(自身仅extra,u_total继承自原型)→500', v && v.status === 500, JSON.stringify(v));
    }
    {
      const v = inv.validateRowSchema(fullValidRow(), { rack: { u_total: 0 } });
      check('S-ctx.rack.u_total非法→500', v && v.status === 500, JSON.stringify(v));
    }
    check('S-ctx.occupiedIntervals合法放行', inv.validateRowSchema(fullValidRow(), { occupiedIntervals: [[1, 2, 5]] }) === null);
    {
      const v = inv.validateRowSchema(fullValidRow(), { occupiedIntervals: [[2, 1, 5]] });
      check('S-ctx.occupiedIntervals lo>hi→500', v && v.status === 500, JSON.stringify(v));
    }
    {
      const v = inv.validateRowSchema(fullValidRow(), { occupiedIntervals: [[1, 2]] });
      check('S-ctx.occupiedIntervals非三元组→500', v && v.status === 500, JSON.stringify(v));
    }
    check('S-ctx.parent合法放行', inv.validateRowSchema(fullValidRow(), { parent: { slot_count: 2, status: 'in_depot', category: 'server' } }) === null);
    {
      const v = inv.validateRowSchema(fullValidRow(), { parent: { slot_count: 2, status: 'in_depot' } });
      check('S-ctx.parent缺键→500', v && v.status === 500, JSON.stringify(v));
    }
    {
      // LOW-2（第7批）：原型链注入——自身只有 {slot_count,status,extra}（缺 category，多 extra），
      // category 从原型继承，ownKeysEqual 应判违反。
      const maliciousParent = Object.assign(Object.create({ category: 'server' }), { slot_count: 2, status: 'in_depot', extra: 1 });
      const v = inv.validateRowSchema(fullValidRow(), { parent: maliciousParent });
      check('S-L2-ctx.parent原型链注入(缺category继承自原型,多extra)→500', v && v.status === 500, JSON.stringify(v));
    }
    check('S-ctx.childDisks合法放行', inv.validateRowSchema(fullValidRow(), { childDisks: [{ slot_no: 1, status: 'in_depot' }] }) === null);
    {
      const v = inv.validateRowSchema(fullValidRow(), { childDisks: [{ slot_no: 1 }] });
      check('S-ctx.childDisks缺status→500', v && v.status === 500, JSON.stringify(v));
    }
    {
      const v = inv.validateRowSchema(fullValidRow(), { childDisks: [{ slot_no: 1, status: 'x', extra: 1 }] });
      check('S-ctx.childDisks多余键→500', v && v.status === 500, JSON.stringify(v));
    }
    {
      // LOW-2（第7批）：原型链注入——自身只有 {slot_no,extra}（缺 status，多 extra），status
      // 从原型继承。
      const maliciousChild = Object.assign(Object.create({ status: 'in_depot' }), { slot_no: 1, extra: 1 });
      const v = inv.validateRowSchema(fullValidRow(), { childDisks: [maliciousChild] });
      check('S-L2-ctx.childDisks元素原型链注入(缺status继承自原型,多extra)→500', v && v.status === 500, JSON.stringify(v));
    }
    check('S-ctx.floor合法放行', inv.validateRowSchema(fullValidRow(), { floor: { rooms: [] } }) === null);
    {
      const v = inv.validateRowSchema(fullValidRow(), { floor: { rooms: 'x' } });
      check('S-ctx.floor.rooms非数组→500', v && v.status === 500, JSON.stringify(v));
    }
    {
      // LOW-2（第7批）：原型链注入——自身只有 {extra}（缺 rooms，多 extra），rooms 从原型继承。
      const maliciousFloor = Object.assign(Object.create({ rooms: [] }), { extra: 1 });
      const v = inv.validateRowSchema(fullValidRow(), { floor: maliciousFloor });
      check('S-L2-ctx.floor原型链注入(缺rooms继承自原型,多extra)→500', v && v.status === 500, JSON.stringify(v));
    }
    // 静态对拍：ASSET_ROW_KEYS 与 index.js DDL 文本解析出的 it_assets 列名集合全等。
    {
      const srcText = fs.readFileSync(path.join(__dirname, '../routes/it-ledger/index.js'), 'utf8');
      const ddlMatch = /CREATE TABLE IF NOT EXISTS it_assets \(([\s\S]*?)\n\s*\)/.exec(srcText);
      const colNames = ddlMatch ? ddlMatch[1].split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s+/)[0]) : [];
      const fullColSet = colNames.concat(itLedgerModule._internals.P10_ASSET_FIELDS);
      const a = [...fullColSet].sort(); const b = [...inv.ASSET_ROW_KEYS].sort();
      check('S-静态对拍: ASSET_ROW_KEYS 与 DDL(+P10)列名集合全等',
        JSON.stringify(a) === JSON.stringify(b), `ddl=${JSON.stringify(a)} rowKeys=${JSON.stringify(b)}`);
    }
    // LOW-6（第4批）：HARDWARE_CATEGORIES ∪ SOFTWARE_LIKE 与 CATEGORY_VALUES 集合全等——
    // SOFTWARE_LIKE 是 invariants.js 的模块内部私有集合（未导出，保持模块公开面不因本次验证
    // 需要而扩大），这里按其字面量镜像（software/subscription），与 HARDWARE_CATEGORIES 的
    // 六个硬件类别取并集，核对不多不少覆盖 CATEGORY_VALUES 全部八个类别。
    {
      const SOFTWARE_LIKE_MIRROR = ['software', 'subscription'];
      const union = [...inv.HARDWARE_CATEGORIES, ...SOFTWARE_LIKE_MIRROR].sort();
      const all = [...inv.CATEGORY_VALUES].sort();
      check('S-静态对拍: HARDWARE_CATEGORIES∪SOFTWARE_LIKE 与 CATEGORY_VALUES 全等',
        JSON.stringify(union) === JSON.stringify(all), `union=${JSON.stringify(union)} all=${JSON.stringify(all)}`);
    }

    // ============================================================
    // N1. 骨架协议
    // ============================================================
    currentCaseLabel = 'N1组: 骨架协议';
    const srv1 = await regAdmin({ category: 'server', name: uniq('SRV'), u_height: 2, slot_count: 0, placement: { kind: 'depot', status: 'in_depot' } });
    check('N1夹具: 登记server(in_depot,u_height2)成功', srv1.status === 201, JSON.stringify(srv1.body));
    const srv1Id = srv1.body.id;

    {
      // RT2-M2（第9批）：包进 assertNoSideEffect——路由协议层负向用例过去只判响应码，
      // 未证明该请求真的没有留下任何数据痕迹。
      const r = await assertNoSideEffect('N1-未知动作码(#26批准迁移)', [srv1Id], () => actionAdmin(srv1Id, '__unknown_c5_action__', { expected_version: 1 }));
      check('N1-未知动作码→400 UNKNOWN_ACTION', r.status === 400 && r.body.code === 'UNKNOWN_ACTION', JSON.stringify(r.body));
    }
    {
      const r = await assertNoSideEffect('N1-乱串动作码', [srv1Id], () => actionAdmin(srv1Id, 'zzz_not_a_real_action', { expected_version: 1 }));
      check('N1-乱串动作码→400 UNKNOWN_ACTION', r.status === 400 && r.body.code === 'UNKNOWN_ACTION', JSON.stringify(r.body));
    }
    // S-M1（第5批）：ACTION_HANDLERS 改 Object.create(null)+Object.hasOwn 查找后，普通对象
    // 原型链上的键名不应再被误判成"存在的动作"——逐个验证。
    for (const protoKey of ['constructor', 'toString', '__proto__']) {
      const r = await assertNoSideEffect(`N1-原型链键名动作名(${protoKey})`, [srv1Id], () => actionAdmin(srv1Id, protoKey, { expected_version: 1 }));
      check(`N1-原型链键名动作名(${protoKey})→400 UNKNOWN_ACTION`, r.status === 400 && r.body.code === 'UNKNOWN_ACTION', JSON.stringify(r.body));
    }
    {
      const r = await assertNoSideEffect('N1-缺expected_version', [srv1Id], () => actionAdmin(srv1Id, 'rack_in', { rack_id: rackAId, u_start: 1 }));
      check('N1-缺expected_version→400', r.status === 400 && r.body.code === 'LEDGER_BAD_REQUEST' && r.body.field === 'expected_version', JSON.stringify(r.body));
    }
    {
      // T-H2（第5批）：改用 assertNoSideEffect（整行深等，不只比 version 一个字段）。
      const r = await assertNoSideEffect('N1-陈旧版本', [srv1Id],
        () => actionAdmin(srv1Id, 'rack_in', { expected_version: 999, rack_id: rackAId, u_start: 1 }));
      check('N1-陈旧版本→409 VERSION_CONFLICT', r.status === 409 && r.body.code === 'VERSION_CONFLICT', JSON.stringify(r.body));
    }
    {
      const r = await assertNoSideEffect('N1-带非空peer_versions', [srv1Id], () => actionAdmin(srv1Id, 'rack_in', { expected_version: 1, rack_id: rackAId, u_start: 1, peer_versions: { 5: 1 } }));
      check('N1-带非空peer_versions→400', r.status === 400 && r.body.code === 'LEDGER_BAD_REQUEST' && r.body.field === 'peer_versions', JSON.stringify(r.body));
    }
    {
      const r = await assertNoSideEffect('N1-非admin带财务键', [srv1Id], () => actionAs(2, 'user', srv1Id, 'rack_in', { expected_version: 1, rack_id: rackAId, u_start: 1, fin_amount: 100 }));
      check('N1-非admin带财务键→400 FINANCE_FIELD_FORBIDDEN', r.status === 400 && r.body.code === 'FINANCE_FIELD_FORBIDDEN', JSON.stringify(r.body));
    }
    {
      // RT-M4（第8批）：改用 assertNoSideEffect。
      const r = await assertNoSideEffect('N1-ACL read用户', [srv1Id],
        () => actionAs(3, 'user', srv1Id, 'rack_in', { expected_version: 1, rack_id: rackAId, u_start: 1 }));
      check('N1-ACL read用户→403', r.status === 403, JSON.stringify(r.body));
    }
    {
      const r = await assertNoSideEffect('N1-无ACL用户', [srv1Id],
        () => actionAs(99, 'user', srv1Id, 'rack_in', { expected_version: 1, rack_id: rackAId, u_start: 1 }));
      check('N1-无ACL用户→403', r.status === 403, JSON.stringify(r.body));
    }
    {
      const r = await actionAdmin(999999, 'rack_in', { expected_version: 1, rack_id: rackAId, u_start: 1 });
      check('N1-不存在的id→404 LEDGER_NOT_FOUND', r.status === 404 && r.body.code === 'LEDGER_NOT_FOUND', JSON.stringify(r.body));
      // RT2-M2（第9批）：目标id本身不存在，assertNoSideEffect的"前后快照深等"对不存在的行没
      // 有意义（before/after 都是同一个 undefined），改为直接断言请求后该id仍不存在+事件表为空。
      const ghostRow = await rawGet('SELECT * FROM it_assets WHERE id=?', [999999]);
      check('N1-不存在的id: 请求后该id仍不存在(SELECT为空)', ghostRow === undefined, JSON.stringify(ghostRow));
      const ghostEvts = await rawAll('SELECT * FROM it_asset_events WHERE asset_id=?', [999999]);
      check('N1-不存在的id: 事件表对该id为空', Array.isArray(ghostEvts) && ghostEvts.length === 0, JSON.stringify(ghostEvts));
    }
    {
      // 排队期撤权（H5，照抄 verify-it-ledger-write.js:1183-1204 I 组范式）：撤权先占闸并卡在
      // txnMidGate，动作请求排队等待；确认动作请求已排队 + 撤销确实仍未落定后才放闸，撤销
      // 提交后动作才轮到，此时 assertWrite 在同一事务内重读 ACL，应看到已撤销状态 → 403。
      const { itTxnMutex } = itLedgerModule._internals;
      const srv1b = await regAdmin({ category: 'other', name: uniq('SW'), u_height: 1, slot_count: 0, placement: { kind: 'depot', status: 'in_depot' } });
      const srv1bId = srv1b.body.id;
      await api('PUT', '/api/it-assets/acl/2', { uid: 1, role: 'admin', body: { level: 'write' } });
      // RT-M4（第8批）：撤权与动作请求发起前先给目标资产拍快照，双方落定后深等对拍。
      const srv1bSnapBefore = await snapshotAssets([srv1bId]);
      const srv1bEvtSnapBefore = await snapshotEvents([srv1bId]);
      let resolveGate;
      const arrived = itLedgerModule._internals.setTxnMidGate(new Promise((resolve) => { resolveGate = resolve; }));
      let revokeSettled = false;
      const revokeP = api('DELETE', '/api/it-assets/acl/2', { uid: 1, role: 'admin' }).then((r) => { revokeSettled = true; return r; });
      await awaitArrived(arrived, 'N1-排队期撤权到达txnMidGate', revokeP);
      const actionP = actionAs(2, 'user', srv1bId, 'rack_in', { expected_version: 1, rack_id: rackAId, u_start: 9 });
      await schedulingBarrier();
      const queuedOk = await waitForCondition(() => itTxnMutex._internals.waiterCount() >= 1, 'N1-排队期撤权等待动作请求排队', 3000);
      check('N1-排队期撤权: 动作请求已排入等待队列', queuedOk === true, `waiterCount=${itTxnMutex._internals.waiterCount()}`);
      check('N1-释放门闩前: 撤销请求仍未落定(还卡在txnMidGate)', revokeSettled === false, `revokeSettled=${revokeSettled}`);
      resolveGate();
      itLedgerModule._internals.setTxnMidGate(null);
      const revokeResult = await withTimeout(revokeP, 5000, 'N1-撤销请求落定');
      check('N1-撤销请求成功', revokeResult.status === 200, JSON.stringify(revokeResult.body));
      const actionResult = await withTimeout(actionP, 5000, 'N1-动作请求落定');
      check('N1-排队期撤权: 动作请求403(权限已在其BEGIN前失效)', actionResult.status === 403, JSON.stringify(actionResult.body));
      const srv1bSnapAfter = await snapshotAssets([srv1bId]);
      const srv1bEvtSnapAfter = await snapshotEvents([srv1bId]);
      check('N1-排队期撤权: 目标资产行深等(无副作用)', JSON.stringify(srv1bSnapBefore) === JSON.stringify(srv1bSnapAfter),
        `before=${JSON.stringify(srv1bSnapBefore)} after=${JSON.stringify(srv1bSnapAfter)}`);
      check('N1-排队期撤权: 目标资产事件表深等(无副作用)', JSON.stringify(srv1bEvtSnapBefore) === JSON.stringify(srv1bEvtSnapAfter),
        `before=${JSON.stringify(srv1bEvtSnapBefore)} after=${JSON.stringify(srv1bEvtSnapAfter)}`);
      await api('PUT', '/api/it-assets/acl/2', { uid: 1, role: 'admin', body: { level: 'write' } });
    }
    {
      const r = await actionAs(2, 'user', srv1Id, 'rack_in', { expected_version: 1, rack_id: rackAId, u_start: 1 });
      check('N1-非admin登记响应200', r.status === 200, JSON.stringify(r.body));
      check('N1-非admin响应不含财务四键', !('fin_amount' in r.body) && !('fin_vendor' in r.body) && !('fin_contract_no' in r.body) && !('external_amount' in r.body), JSON.stringify(r.body));
      check('N1-响应含op_id', typeof r.body.op_id === 'string' && r.body.op_id.length > 0);
      check('N1-响应含affected_ids数组', Array.isArray(r.body.affected_ids));
    }
    {
      // S-rec2（第5批）：_internals.writeEvent 直调反例——rack_move 的 PAYLOAD_KEYS.affected
      // 是空集合，role='affected' 即便载荷完全为空对象也必须被拒绝（不能只靠"载荷键不在允许
      // 集合里"这条防线，那条防线对{}/{}天然失效）。
      // RT2-M2（第9批）：包进 assertNoSideEffect——该路径在任何 q.run(INSERT...) 之前抛错，
      // 理论上不可能有DB副作用，但用统一助手实测核验比"理论上不可能"更硬。
      let caught = null;
      await assertNoSideEffect('S-rec2-writeEvent直调', [srv1Id], async () => {
        try {
          await itLedgerModule._internals.withWrite(async (q) => {
            await itLedgerModule._internals.writeEvent(q, {
              op_id: itLedgerModule._internals.newOpId(), asset_id: srv1Id, action: 'rack_move', role: 'affected',
              related_asset_id: null, from_state: {}, to_state: {}, operator_id: 1, note: null,
            });
          });
        } catch (e) { caught = e; }
      });
      check('S-rec2-writeEvent直调: rack_move(affected空集合)role=affected(空载荷)必须抛错',
        !!caught && caught.code === 'LEDGER_INTERNAL' && caught.status === 500, caught && JSON.stringify({ code: caught.code, status: caught.status, message: caught.message }));
    }
    {
      // T-M3（第6批）：登记带非空财务三字段的 server（admin）→ 对它跑合法动作（mark_status）
      // → admin 响应含三字段且值相等；非 admin（ACL write）响应三键不存在（递归扫描，不只查
      // 顶层）；GET 详情同款一次作对照。
      function hasFinanceKeyDeep(obj, seen) {
        seen = seen || new Set();
        if (obj === null || typeof obj !== 'object') return false;
        if (seen.has(obj)) return false;
        seen.add(obj);
        if (Array.isArray(obj)) return obj.some((v) => hasFinanceKeyDeep(v, seen));
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'fin_amount' || k === 'fin_vendor' || k === 'fin_contract_no' || k === 'external_amount') return true;
          if (hasFinanceKeyDeep(v, seen)) return true;
        }
        return false;
      }
      const finAsset = await regAdmin({
        category: 'server', name: uniq('N1fin'), u_height: 1, placement: { kind: 'depot', status: 'in_depot' },
        fin_amount: 12345.6, fin_vendor: '厂商甲', fin_contract_no: 'CT-0001',
      });
      check('N1财务夹具: 登记带三财务字段成功', finAsset.status === 201, JSON.stringify(finAsset.body));
      const finId = finAsset.body.id;
      check('N1财务夹具: admin登记响应含三字段且值正确',
        finAsset.body.fin_amount === 12345.6 && finAsset.body.fin_vendor === '厂商甲' && finAsset.body.fin_contract_no === 'CT-0001',
        JSON.stringify(finAsset.body));

      const finAction = await actionAdmin(finId, 'mark_status', { expected_version: 1, status: 'faulty' });
      check('N1财务-admin动作响应200且含三财务字段且值正确',
        finAction.status === 200 && finAction.body.fin_amount === 12345.6 && finAction.body.fin_vendor === '厂商甲' && finAction.body.fin_contract_no === 'CT-0001',
        JSON.stringify(finAction.body));

      const finActionNonAdmin = await actionAs(2, 'user', finId, 'mark_status', { expected_version: 2, status: 'to_retire' });
      check('N1财务-非admin动作响应200', finActionNonAdmin.status === 200, JSON.stringify(finActionNonAdmin.body));
      check('N1财务-非admin动作响应不含任何财务键(递归扫描)', !hasFinanceKeyDeep(finActionNonAdmin.body), JSON.stringify(finActionNonAdmin.body));

      const finGetAdmin = await api('GET', `/api/it-assets/${finId}`, { uid: 1, role: 'admin' });
      check('N1财务-GET详情(admin)含三财务字段且值正确',
        finGetAdmin.body.asset.fin_amount === 12345.6 && finGetAdmin.body.asset.fin_vendor === '厂商甲' && finGetAdmin.body.asset.fin_contract_no === 'CT-0001',
        JSON.stringify(finGetAdmin.body.asset));
      const finGetNonAdmin = await api('GET', `/api/it-assets/${finId}`, { uid: 2, role: 'user' });
      check('N1财务-GET详情(非admin)不含任何财务键(递归扫描)', !hasFinanceKeyDeep(finGetNonAdmin.body), JSON.stringify(finGetNonAdmin.body));
    }

    // ============================================================
    // N3. U 区间
    // ============================================================
    currentCaseLabel = 'N3组: U区间';
    {
      // T-M6（第6批）：全部负向用例改用 assertNoSideEffect。
      const rN3a = await freshRack(10);
      const s = await regAdmin({ category: 'server', name: uniq('SRV'), u_height: 2, slot_count: 0, placement: { kind: 'depot', status: 'in_depot' } });
      const sid = s.body.id;
      let r = await assertNoSideEffect('N3-缺rack_id', [sid], () => actionAdmin(sid, 'rack_in', { expected_version: 1, u_start: 1 }));
      check('N3-缺rack_id→400', r.status === 400 && r.body.field === 'rack_id', JSON.stringify(r.body));
      r = await assertNoSideEffect('N3-缺u_start(rack_in)', [sid], () => actionAdmin(sid, 'rack_in', { expected_version: 1, rack_id: rN3a }));
      check('N3-缺u_start→400', r.status === 400 && r.body.field === 'u_start', JSON.stringify(r.body));
      r = await assertNoSideEffect('N3-柜不存在', [sid], () => actionAdmin(sid, 'rack_in', { expected_version: 1, rack_id: 999999, u_start: 1 }));
      check('N3-柜不存在→400', r.status === 400 && r.body.code === 'LEDGER_BAD_REQUEST' && r.body.field === 'rack_id', JSON.stringify(r.body));
      r = await assertNoSideEffect('N3-越顶(rack_in)', [sid], () => actionAdmin(sid, 'rack_in', { expected_version: 1, rack_id: rN3a, u_start: 10 }));
      check('N3-越顶(10+2-1>10)→409 U_INTERVAL_OUT_OF_RANGE', r.status === 409 && r.body.code === 'U_INTERVAL_OUT_OF_RANGE', JSON.stringify(r.body));
      // RS-M1（第8批）：u_start=Number.MAX_SAFE_INTEGER——参数校验阶段的不溢出比较必须提前拦
      // 下，产出 409（不是"写后重读+occupiedIntervals 相加溢出"链路可能误判出的 500）。
      r = await assertNoSideEffect('N3-rack_in越顶(MAX_SAFE_INTEGER)', [sid],
        () => actionAdmin(sid, 'rack_in', { expected_version: 1, rack_id: rN3a, u_start: Number.MAX_SAFE_INTEGER }));
      check('N3-rack_in越顶(u_start=MAX_SAFE_INTEGER)→409(不是500)', r.status === 409 && r.body.code === 'U_INTERVAL_OUT_OF_RANGE', JSON.stringify(r.body));
    }
    {
      const rN3b = await freshRack(10);
      const rN3c = await freshRack(10);
      const a1 = await regAdmin({ category: 'server', name: uniq('SRV'), u_height: 2, slot_count: 0, placement: { kind: 'rack', rack_id: rN3b, u_start: 1 } });
      check('N3夹具: 登记a1在rack[1,2]', a1.status === 201, JSON.stringify(a1.body));
      const s2 = await regAdmin({ category: 'server', name: uniq('SRV'), u_height: 2, slot_count: 0, placement: { kind: 'depot', status: 'in_depot' } });
      const s2Id = s2.body.id;
      let r = await assertNoSideEffect('N3-与在位设备重叠(rack_in)', [s2Id], () => actionAdmin(s2Id, 'rack_in', { expected_version: 1, rack_id: rN3b, u_start: 1 }));
      check('N3-与在位设备重叠→409 RACK_SLOT_OCCUPIED', r.status === 409 && r.body.code === 'RACK_SLOT_OCCUPIED', JSON.stringify(r.body));
      r = await actionAdmin(s2Id, 'rack_in', { expected_version: 1, rack_id: rN3b, u_start: 3 });
      check('N3-紧邻不重叠成功([1,2]与[3,4])', r.status === 200, JSON.stringify(r.body));

      // T-M4（第6批）：rack_move/rack_relocate 负向补齐——缺u_start/越顶/与他人重叠，全走
      // assertNoSideEffect。此刻 s2 在 rN3b 占 [3,4]（u_height=2），version=2。
      // RT-rec-1（第8批）：rack_move 缺 rack_id 专门用例（此前只测了缺 u_start）。
      r = await assertNoSideEffect('N3-rack_move缺rack_id', [s2Id], () => actionAdmin(s2Id, 'rack_move', { expected_version: 2, u_start: 5 }));
      check('N3-rack_move缺rack_id→400', r.status === 400 && r.body.field === 'rack_id', JSON.stringify(r.body));
      r = await assertNoSideEffect('N3-rack_move缺u_start', [s2Id], () => actionAdmin(s2Id, 'rack_move', { expected_version: 2, rack_id: rN3c }));
      check('N3-rack_move缺u_start→400', r.status === 400 && r.body.field === 'u_start', JSON.stringify(r.body));
      r = await assertNoSideEffect('N3-rack_move越顶', [s2Id], () => actionAdmin(s2Id, 'rack_move', { expected_version: 2, rack_id: rN3c, u_start: 10 }));
      check('N3-rack_move越顶(10+2-1>10)→409 U_INTERVAL_OUT_OF_RANGE', r.status === 409 && r.body.code === 'U_INTERVAL_OUT_OF_RANGE', JSON.stringify(r.body));
      r = await assertNoSideEffect('N3-rack_move越顶(MAX_SAFE_INTEGER)', [s2Id],
        () => actionAdmin(s2Id, 'rack_move', { expected_version: 2, rack_id: rN3c, u_start: Number.MAX_SAFE_INTEGER }));
      check('N3-rack_move越顶(u_start=MAX_SAFE_INTEGER)→409(不是500)', r.status === 409 && r.body.code === 'U_INTERVAL_OUT_OF_RANGE', JSON.stringify(r.body));
      r = await assertNoSideEffect('N3-rack_relocate缺u_start', [s2Id], () => actionAdmin(s2Id, 'rack_relocate', { expected_version: 2 }));
      check('N3-rack_relocate缺u_start→400', r.status === 400 && r.body.field === 'u_start', JSON.stringify(r.body));
      r = await assertNoSideEffect('N3-rack_relocate越顶', [s2Id], () => actionAdmin(s2Id, 'rack_relocate', { expected_version: 2, u_start: 10 }));
      check('N3-rack_relocate越顶(10+2-1>10)→409 U_INTERVAL_OUT_OF_RANGE', r.status === 409 && r.body.code === 'U_INTERVAL_OUT_OF_RANGE', JSON.stringify(r.body));
      r = await assertNoSideEffect('N3-rack_relocate越顶(MAX_SAFE_INTEGER)', [s2Id],
        () => actionAdmin(s2Id, 'rack_relocate', { expected_version: 2, u_start: Number.MAX_SAFE_INTEGER }));
      check('N3-rack_relocate越顶(u_start=MAX_SAFE_INTEGER)→409(不是500)', r.status === 409 && r.body.code === 'U_INTERVAL_OUT_OF_RANGE', JSON.stringify(r.body));
      // 同柜同区间与 a1[1,2] 重叠。
      r = await assertNoSideEffect('N3-rack_relocate与其他资产重叠', [s2Id], () => actionAdmin(s2Id, 'rack_relocate', { expected_version: 2, u_start: 1 }));
      check('N3-rack_relocate与其他资产重叠→409 RACK_SLOT_OCCUPIED', r.status === 409 && r.body.code === 'RACK_SLOT_OCCUPIED', JSON.stringify(r.body));

      // rack_relocate 移到与自身原区间部分重叠的新位——证明排除自身。
      r = await actionAdmin(s2Id, 'rack_relocate', { expected_version: 2, u_start: 4 });
      check('N3-rack_relocate移到与自身原区间部分重叠的新位成功(排除自身)', r.status === 200, JSON.stringify(r.body));
      // 此时 s2 占 [4,5]。
      r = await assertNoSideEffect('N3-rack_relocate同位', [s2Id], () => actionAdmin(s2Id, 'rack_relocate', { expected_version: 3, u_start: 4 }));
      check('N3-rack_relocate同位→409 NO_OP_TRANSITION', r.status === 409 && r.body.code === 'NO_OP_TRANSITION', JSON.stringify(r.body));

      // rack_move 同柜→409 NO_OP；到另一柜重叠→409。
      r = await assertNoSideEffect('N3-rack_move同柜', [s2Id], () => actionAdmin(s2Id, 'rack_move', { expected_version: 3, rack_id: rN3b, u_start: 4 }));
      check('N3-rack_move同柜→409 NO_OP_TRANSITION', r.status === 409 && r.body.code === 'NO_OP_TRANSITION', JSON.stringify(r.body));
      const bOcc = await regAdmin({ category: 'server', name: uniq('SRV'), u_height: 2, slot_count: 0, placement: { kind: 'rack', rack_id: rN3c, u_start: 1 } });
      check('N3夹具: rackC占位[1,2]', bOcc.status === 201, JSON.stringify(bOcc.body));
      r = await assertNoSideEffect('N3-rack_move到另一柜重叠', [s2Id], () => actionAdmin(s2Id, 'rack_move', { expected_version: 3, rack_id: rN3c, u_start: 1 }));
      check('N3-rack_move到另一柜重叠→409 RACK_SLOT_OCCUPIED', r.status === 409 && r.body.code === 'RACK_SLOT_OCCUPIED', JSON.stringify(r.body));
    }
    {
      // T-H1（第5批）：Promise.all 两台设备 rack_in 同柜同区间——改门闩形态，不再靠随机竞态。
      // 第一请求先占闸进事务，第二请求确认已排队后再放闸，保证"先到达者提交在前"是确定性的，
      // 不是"谁先跑赢算谁的"。
      const rackCId = await freshRack(10);
      const d1 = await regAdmin({ category: 'server', name: uniq('SRV'), u_height: 2, slot_count: 0, placement: { kind: 'depot', status: 'in_depot' } });
      const d2 = await regAdmin({ category: 'server', name: uniq('SRV'), u_height: 2, slot_count: 0, placement: { kind: 'depot', status: 'in_depot' } });
      const d1Id = d1.body.id; const d2Id = d2.body.id;
      const { itTxnMutex } = itLedgerModule._internals;
      // RT-H1（第8批）：启动两笔请求前先给失败方(d2)拍快照，落定后深等对拍（不只比
      // status/version 两个字段）。
      const d2SnapBefore = await snapshotAssets([d2Id]);
      const d2EvtSnapBefore = await snapshotEvents([d2Id]);
      let releaseGate; const gatePromise = new Promise((resolve) => { releaseGate = resolve; });
      const arrived = itLedgerModule._internals.setTxnMidGate(gatePromise);
      const p1 = actionAdmin(d1Id, 'rack_in', { expected_version: 1, rack_id: rackCId, u_start: 1 });
      await awaitArrived(arrived, 'N3-Promise.all第一请求到达txnMidGate', p1);
      const p2 = actionAdmin(d2Id, 'rack_in', { expected_version: 1, rack_id: rackCId, u_start: 1 });
      const queuedOk = await waitForCondition(() => itTxnMutex._internals.waiterCount() >= 1, 'N3-Promise.all等待第二请求排队', 3000);
      check('N3-Promise.all: 第二请求已排入等待队列', queuedOk === true, `waiterCount=${itTxnMutex._internals.waiterCount()}`);
      releaseGate();
      itLedgerModule._internals.setTxnMidGate(null);
      const [r1, r2] = await Promise.all([p1, p2]);
      check('N3-Promise.all门闩顺序: 先到达者(d1)成功200', r1.status === 200, JSON.stringify(r1.body));
      check('N3-Promise.all门闩顺序: 排队者(d2)冲突409 RACK_SLOT_OCCUPIED', r2.status === 409 && r2.body.code === 'RACK_SLOT_OCCUPIED', JSON.stringify(r2.body));
      await assertEventSet('N3-Promise.all成功方(d1)事件', r1.body.op_id, {
        action: 'rack_in', operator_id: 1,
        primary: { assetId: d1Id, from: { status: 'in_depot', rack_id: null, u_start: null }, to: { status: 'in_service', rack_id: rackCId, u_start: 1 } },
        affected: [],
      });
      const d2SnapAfter = await snapshotAssets([d2Id]);
      const d2EvtSnapAfter = await snapshotEvents([d2Id]);
      check('N3-Promise.all失败方(d2): 资产行深等(无副作用)', JSON.stringify(d2SnapBefore) === JSON.stringify(d2SnapAfter),
        `before=${JSON.stringify(d2SnapBefore)} after=${JSON.stringify(d2SnapAfter)}`);
      check('N3-Promise.all失败方(d2): 事件表深等(无副作用)', JSON.stringify(d2EvtSnapBefore) === JSON.stringify(d2EvtSnapAfter),
        `before=${JSON.stringify(d2EvtSnapBefore)} after=${JSON.stringify(d2EvtSnapAfter)}`);
    }

    // ============================================================
    // N4. 下架去向与联动
    // ============================================================
    currentCaseLabel = 'N4组: 下架去向与联动';
    {
      const rN4a = await freshRack(10);
      const rN4b = await freshRack(10);
      const host = await regAdmin({ category: 'server', name: uniq('HOST'), u_height: 2, slot_count: 4, placement: { kind: 'depot', status: 'in_depot' } });
      const hostId = host.body.id;
      const d1 = await regAdmin({ category: 'disk', name: uniq('DISK'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 }, peer_versions: { [hostId]: 1 } });
      check('N4夹具: 登记盘1到宿主(库房)成功', d1.status === 201, JSON.stringify(d1.body));
      const d2 = await regAdmin({ category: 'disk', name: uniq('DISK'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 2 }, peer_versions: { [hostId]: 2 } });
      check('N4夹具: 登记盘2到宿主(库房)成功', d2.status === 201, JSON.stringify(d2.body));
      const d1Id = d1.body.id; const d2Id = d2.body.id;
      const hostV = await freshVersion(hostId);
      check('N4夹具: 宿主经两次登记version=3', hostV === 3, hostV);

      // T-H3（第5批）：改用 assertEventSet——按已保存的子盘 id 精确断言（不对空集合用 .every）。
      const r = await actionAdmin(hostId, 'rack_in', { expected_version: hostV, rack_id: rN4a, u_start: 1 });
      check('N4-带两盘宿主rack_in成功(in_depot→in_service)', r.status === 200 && r.body.status === 'in_service', JSON.stringify(r.body));
      // RT-M1（第8批）：affected_ids 排序后深等 [d1Id,d2Id]（不只比长度）。
      check('N4-rack_in affected_ids深等[d1Id,d2Id]',
        JSON.stringify([...r.body.affected_ids].sort((a, b) => a - b)) === JSON.stringify([d1Id, d2Id].sort((a, b) => a - b)),
        JSON.stringify(r.body.affected_ids));
      await assertEventSet('N4-rack_in联动', r.body.op_id, {
        action: 'rack_in', operator_id: 1,
        primary: { assetId: hostId, from: { status: 'in_depot', rack_id: null, u_start: null }, to: { status: 'in_service', rack_id: rN4a, u_start: 1 } },
        affected: [
          { assetId: d1Id, from: { status: 'in_depot' }, to: { status: 'in_service' } },
          { assetId: d2Id, from: { status: 'in_depot' }, to: { status: 'in_service' } },
        ],
      });
      const d1Row1 = await rawGet('SELECT status, version FROM it_assets WHERE id=?', [d1Id]);
      const d2Row1 = await rawGet('SELECT status, version FROM it_assets WHERE id=?', [d2Id]);
      check('N4-盘1: status=in_service,version=2(登记1→rack_in联动+1)', d1Row1.status === 'in_service' && d1Row1.version === 2, JSON.stringify(d1Row1));
      check('N4-盘2: status=in_service,version=2(登记1→rack_in联动+1)', d2Row1.status === 'in_service' && d2Row1.version === 2, JSON.stringify(d2Row1));

      // rack_out to=faulty：主+两子盘同进故障栏。
      const hostV2 = await freshVersion(hostId);
      const r2 = await actionAdmin(hostId, 'rack_out', { expected_version: hostV2, to: 'faulty' });
      check('N4-rack_out(to=faulty)成功', r2.status === 200 && r2.body.status === 'faulty' && r2.body.rack_id === null && r2.body.u_start === null, JSON.stringify(r2.body));
      check('N4-rack_out affected_ids深等[d1Id,d2Id]',
        JSON.stringify([...r2.body.affected_ids].sort((a, b) => a - b)) === JSON.stringify([d1Id, d2Id].sort((a, b) => a - b)),
        JSON.stringify(r2.body.affected_ids));
      await assertEventSet('N4-rack_out(faulty)联动', r2.body.op_id, {
        action: 'rack_out', operator_id: 1,
        primary: { assetId: hostId, from: { status: 'in_service', rack_id: rN4a, u_start: 1 }, to: { status: 'faulty', rack_id: null, u_start: null } },
        affected: [
          { assetId: d1Id, from: { status: 'in_service' }, to: { status: 'faulty' } },
          { assetId: d2Id, from: { status: 'in_service' }, to: { status: 'faulty' } },
        ],
      });
      const d1Row2 = await rawGet('SELECT status, version FROM it_assets WHERE id=?', [d1Id]);
      const d2Row2 = await rawGet('SELECT status, version FROM it_assets WHERE id=?', [d2Id]);
      check('N4-盘1: status=faulty,version=3(2→rack_out联动+1)', d1Row2.status === 'faulty' && d1Row2.version === 3, JSON.stringify(d1Row2));
      check('N4-盘2: status=faulty,version=3(2→rack_out联动+1)', d2Row2.status === 'faulty' && d2Row2.version === 3, JSON.stringify(d2Row2));
      const hostRowAfterOut = await rawGet('SELECT version FROM it_assets WHERE id=?', [hostId]);
      check('N4-rack_out后: 宿主version恰+1', hostRowAfterOut.version === hostV2 + 1, JSON.stringify(hostRowAfterOut));

      // rack_out.to 非法校验要求前置状态 in_service——host 此刻是 faulty（上一步 rack_out 的
      // 结果），先 mark_status 回 in_depot 再 rack_in 回到位，才能单独验证参数校验本身。
      const hostVBackA = await freshVersion(hostId);
      await actionAdmin(hostId, 'mark_status', { expected_version: hostVBackA, status: 'in_depot' });
      const hostVBackB = await freshVersion(hostId);
      const backIn = await actionAdmin(hostId, 'rack_in', { expected_version: hostVBackB, rack_id: rN4b, u_start: 1 });
      check('N4夹具: host重新rack_in回到位(供to参数校验用)', backIn.status === 200, JSON.stringify(backIn.body));
      const hostV3 = await freshVersion(hostId);
      // RT-M4（第8批）：带两盘宿主的非法 rack_out.to → assertNoSideEffect([hostId,d1Id,d2Id]).
      let r3 = await assertNoSideEffect('N4-rack_out.to非法', [hostId, d1Id, d2Id],
        () => actionAdmin(hostId, 'rack_out', { expected_version: hostV3, to: 'not-a-real-status' }));
      check('N4-rack_out.to非法→400', r3.status === 400 && r3.body.code === 'LEDGER_BAD_REQUEST' && r3.body.field === 'to', JSON.stringify(r3.body));

      // to 缺省 = in_depot：先 mark_status 宿主回 in_depot，再走一次全新的无盘宿主验证缺省。
      const bare = await regAdmin({ category: 'other', name: uniq('SWH'), u_height: 1, slot_count: 0, placement: { kind: 'rack', rack_id: rN4b, u_start: 5 } });
      check('N4夹具: 无盘设备登记在位', bare.status === 201, JSON.stringify(bare.body));
      const r4 = await actionAdmin(bare.body.id, 'rack_out', { expected_version: 1 });
      check('N4-rack_out无to参数缺省in_depot', r4.status === 200 && r4.body.status === 'in_depot', JSON.stringify(r4.body));
      check('N4-无盘设备rack_out事件恰1行affected_ids=[]', Array.isArray(r4.body.affected_ids) && r4.body.affected_ids.length === 0, JSON.stringify(r4.body.affected_ids));
      // RT2-M1（第9批）：对 op_id 做精确事件集合核对（primary恰1行、affected空、载荷/action/
      // operator_id全比对），不只查响应里的 affected_ids 数组。
      await assertEventSet('N4-无盘设备rack_out', r4.body.op_id, {
        action: 'rack_out', operator_id: 1,
        primary: { assetId: bare.body.id, from: { status: 'in_service', rack_id: rN4b, u_start: 5 }, to: { status: 'in_depot', rack_id: null, u_start: null } },
        affected: [],
      });

      // mark_status 宿主 in_depot→to_retire 同步两子盘——host 此刻仍 in_service（r3 是被拒绝的
      // 无效请求，未改变状态），先 rack_out 回库房。
      const hostVBackC = await freshVersion(hostId);
      const backOut = await actionAdmin(hostId, 'rack_out', { expected_version: hostVBackC });
      check('N4夹具: host rack_out回in_depot(供mark_status测试用)', backOut.status === 200 && backOut.body.status === 'in_depot', JSON.stringify(backOut.body));
      const hostV4 = await freshVersion(hostId);
      // RT-M1：mark_status 联动前先按固定 id 读子盘 version，联动后逐盘断恰 +1。
      const d1BeforeMs = await rawGet('SELECT version FROM it_assets WHERE id=?', [d1Id]);
      const d2BeforeMs = await rawGet('SELECT version FROM it_assets WHERE id=?', [d2Id]);
      const r5 = await actionAdmin(hostId, 'mark_status', { expected_version: hostV4, status: 'to_retire' });
      check('N4-mark_status宿主in_depot→to_retire成功', r5.status === 200 && r5.body.status === 'to_retire', JSON.stringify(r5.body));
      check('N4-mark_status affected_ids深等[d1Id,d2Id]',
        JSON.stringify([...r5.body.affected_ids].sort((a, b) => a - b)) === JSON.stringify([d1Id, d2Id].sort((a, b) => a - b)),
        JSON.stringify(r5.body.affected_ids));
      await assertEventSet('N4-mark_status(to_retire)联动', r5.body.op_id, {
        action: 'mark_status', operator_id: 1,
        primary: { assetId: hostId, from: { status: 'in_depot' }, to: { status: 'to_retire' } },
        affected: [
          { assetId: d1Id, from: { status: 'in_depot' }, to: { status: 'to_retire' } },
          { assetId: d2Id, from: { status: 'in_depot' }, to: { status: 'to_retire' } },
        ],
      });
      const d1Row3 = await rawGet('SELECT status, version FROM it_assets WHERE id=?', [d1Id]);
      const d2Row3 = await rawGet('SELECT status, version FROM it_assets WHERE id=?', [d2Id]);
      check('N4-盘1/盘2: mark_status后均to_retire', d1Row3.status === 'to_retire' && d2Row3.status === 'to_retire', JSON.stringify({ d1Row3, d2Row3 }));
      check('N4-盘1: mark_status联动后version恰+1', d1Row3.version === d1BeforeMs.version + 1,
        `before=${d1BeforeMs.version} after=${d1Row3.version}`);
      check('N4-盘2: mark_status联动后version恰+1', d2Row3.version === d2BeforeMs.version + 1,
        `before=${d2BeforeMs.version} after=${d2Row3.version}`);
    }

    // ============================================================
    // N5. 随装盘与 retire
    // ============================================================
    currentCaseLabel = 'N5组: 随装盘与retire';
    {
      const host = await regAdmin({ category: 'server', name: uniq('HOST2'), u_height: 1, slot_count: 1, placement: { kind: 'depot', status: 'in_depot' } });
      const hostId = host.body.id;
      const d1 = await regAdmin({ category: 'disk', name: uniq('DISK'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 }, peer_versions: { [hostId]: 1 } });
      const diskId = d1.body.id;
      // T-M6（第6批）：N5 全部负向用例改用 assertNoSideEffect。
      let r = await assertNoSideEffect('N5-随装盘mark_status', [hostId, diskId], () => actionAdmin(diskId, 'mark_status', { expected_version: 1, status: 'faulty' }));
      check('N5-随装盘mark_status→409 MOUNTED_DISK_ACTION_FORBIDDEN', r.status === 409 && r.body.code === 'MOUNTED_DISK_ACTION_FORBIDDEN', JSON.stringify(r.body));
      r = await assertNoSideEffect('N5-随装盘retire', [hostId, diskId], () => actionAdmin(diskId, 'retire', { expected_version: 1 }));
      check('N5-随装盘retire→409 MOUNTED_DISK_ACTION_FORBIDDEN', r.status === 409 && r.body.code === 'MOUNTED_DISK_ACTION_FORBIDDEN', JSON.stringify(r.body));

      const hostV2 = await freshVersion(hostId);
      r = await actionAdmin(hostId, 'mark_status', { expected_version: hostV2, status: 'to_retire' });
      check('N5夹具: 宿主mark_status→to_retire成功', r.status === 200, JSON.stringify(r.body));
      const hostV3 = await freshVersion(hostId);
      r = await assertNoSideEffect('N5-带盘宿主to_retire后retire', [hostId, diskId], () => actionAdmin(hostId, 'retire', { expected_version: hostV3 }));
      check('N5-带盘宿主to_retire后retire→409 RETIRE_BLOCKED_BY_DISKS', r.status === 409 && r.body.code === 'RETIRE_BLOCKED_BY_DISKS', JSON.stringify(r.body));
    }
    {
      // 散盘 in_depot→faulty→to_retire→retire 全链成功（§3.3 无出口核验）。
      const d = await regAdmin({ category: 'disk', name: uniq('DISKB'), placement: { kind: 'depot', status: 'in_depot' } });
      const did = d.body.id;
      let r = await actionAdmin(did, 'mark_status', { expected_version: 1, status: 'faulty' });
      check('N5-散盘in_depot→faulty成功', r.status === 200, JSON.stringify(r.body));
      r = await actionAdmin(did, 'mark_status', { expected_version: 2, status: 'to_retire' });
      check('N5-散盘faulty→to_retire成功', r.status === 200, JSON.stringify(r.body));
      r = await actionAdmin(did, 'retire', { expected_version: 3 });
      check('N5-散盘to_retire→retire成功', r.status === 200 && r.body.status === 'retired', JSON.stringify(r.body));

      // retired 后任何六动作 409。
      r = await assertNoSideEffect('N5-retired后mark_status', [did], () => actionAdmin(did, 'mark_status', { expected_version: 4, status: 'faulty' }));
      check('N5-retired后mark_status→409 ACTION_NOT_ALLOWED_IN_STATUS', r.status === 409 && r.body.code === 'ACTION_NOT_ALLOWED_IN_STATUS', JSON.stringify(r.body));
      r = await assertNoSideEffect('N5-retired后retire', [did], () => actionAdmin(did, 'retire', { expected_version: 4 }));
      check('N5-retired后retire→409 ACTION_NOT_ALLOWED_IN_STATUS', r.status === 409 && r.body.code === 'ACTION_NOT_ALLOWED_IN_STATUS', JSON.stringify(r.body));
    }
    {
      // 无盘设备 rack_out→mark_status→retire 全链成功。
      const rN5a = await freshRack(10);
      const sw = await regAdmin({ category: 'other', name: uniq('SW2'), u_height: 1, slot_count: 0, placement: { kind: 'rack', rack_id: rN5a, u_start: 8 } });
      const swId = sw.body.id;
      let r = await actionAdmin(swId, 'rack_out', { expected_version: 1 });
      check('N5-无盘设备rack_out成功', r.status === 200, JSON.stringify(r.body));
      // RT-H2（第8批）：无盘设备 rack_out 也走 assertEventSet（primary 1 行、affected 空、
      // 载荷 status/rack_id/u_start 前后值、action、operator_id），保留响应 affected_ids 深等 []。
      check('N5-无盘设备rack_out: affected_ids深等于[]', Array.isArray(r.body.affected_ids) && r.body.affected_ids.length === 0, JSON.stringify(r.body.affected_ids));
      await assertEventSet('N5-无盘设备rack_out', r.body.op_id, {
        action: 'rack_out', operator_id: 1,
        primary: { assetId: swId, from: { status: 'in_service', rack_id: rN5a, u_start: 8 }, to: { status: 'in_depot', rack_id: null, u_start: null } },
        affected: [],
      });
      r = await actionAdmin(swId, 'mark_status', { expected_version: 2, status: 'to_retire' });
      check('N5-无盘设备mark_status→to_retire成功', r.status === 200, JSON.stringify(r.body));
      r = await actionAdmin(swId, 'retire', { expected_version: 3 });
      check('N5-无盘设备retire成功', r.status === 200 && r.body.status === 'retired', JSON.stringify(r.body));

      // mark_status 同态 → 409 NO_OP。
      const sw2 = await regAdmin({ category: 'other', name: uniq('SW3'), u_height: 1, slot_count: 0, placement: { kind: 'depot', status: 'faulty' } });
      const sw2Id = sw2.body.id;
      r = await assertNoSideEffect('N5-mark_status同态', [sw2Id], () => actionAdmin(sw2Id, 'mark_status', { expected_version: 1, status: 'faulty' }));
      check('N5-mark_status同态→409 NO_OP_TRANSITION', r.status === 409 && r.body.code === 'NO_OP_TRANSITION', JSON.stringify(r.body));
    }
    {
      // faulty 设备 rack_in → 409（投入使用只接受 in_depot）。
      const rN5b = await freshRack(10);
      const sw = await regAdmin({ category: 'other', name: uniq('SW4'), u_height: 1, slot_count: 0, placement: { kind: 'depot', status: 'faulty' } });
      const swId = sw.body.id;
      const r = await assertNoSideEffect('N5-faulty设备rack_in', [swId], () => actionAdmin(swId, 'rack_in', { expected_version: 1, rack_id: rN5b, u_start: 8 }));
      check('N5-faulty设备rack_in→409 ACTION_NOT_ALLOWED_IN_STATUS(仅接受in_depot)', r.status === 409 && r.body.code === 'ACTION_NOT_ALLOWED_IN_STATUS', JSON.stringify(r.body));
    }
    {
      // laptop 非机柜 mark_status 三态互转成功；software mark_status 400。
      const lap = await regAdmin({ category: 'laptop', name: uniq('LAP'), placement: { kind: 'depot', status: 'in_depot' } });
      const lapId = lap.body.id;
      let r = await actionAdmin(lapId, 'mark_status', { expected_version: 1, status: 'faulty' });
      check('N5-laptop mark_status in_depot→faulty成功', r.status === 200, JSON.stringify(r.body));
      // LOW-8（第4批）：无子盘资产（laptop 结构上不可能有 parent_asset_id 指向它的行）
      // mark_status → affected_ids 深等于 []，且该 op_id 事件恰 1 行（无 affected 行）。
      check('N5-laptop(无子盘)mark_status: affected_ids深等于[]', Array.isArray(r.body.affected_ids) && r.body.affected_ids.length === 0, JSON.stringify(r.body.affected_ids));
      {
        const evts = await rawAll('SELECT id FROM it_asset_events WHERE op_id=?', [r.body.op_id]);
        check('N5-laptop(无子盘)mark_status: 该op_id事件恰1行', evts.length === 1, evts.length);
      }
      r = await actionAdmin(lapId, 'mark_status', { expected_version: 2, status: 'to_retire' });
      check('N5-laptop mark_status faulty→to_retire成功', r.status === 200, JSON.stringify(r.body));
      r = await assertNoSideEffect('N5-laptop不具备机柜资格rack_in', [lapId], () => actionAdmin(lapId, 'rack_in', { expected_version: 3, rack_id: rackAId, u_start: 9 }));
      check('N5-laptop不具备机柜资格rack_in→400 ACTION_NOT_APPLICABLE', r.status === 400 && r.body.code === 'ACTION_NOT_APPLICABLE', JSON.stringify(r.body));

      const sw5 = await regAdmin({ category: 'software', name: uniq('SFT') });
      check('N5夹具: 登记software成功', sw5.status === 201, JSON.stringify(sw5.body));
      const sw5Id = sw5.body.id;
      r = await assertNoSideEffect('N5-software mark_status', [sw5Id], () => actionAdmin(sw5Id, 'mark_status', { expected_version: 1, status: 'faulty' }));
      check('N5-software mark_status→400 ACTION_NOT_APPLICABLE', r.status === 400 && r.body.code === 'ACTION_NOT_APPLICABLE', JSON.stringify(r.body));
      r = await assertNoSideEffect('N5-software retire', [sw5Id], () => actionAdmin(sw5Id, 'retire', { expected_version: 1 }));
      check('N5-software retire→400 ACTION_NOT_APPLICABLE', r.status === 400 && r.body.code === 'ACTION_NOT_APPLICABLE', JSON.stringify(r.body));
    }
    {
      // T-M4（第6批）：laptop/ap/other(非机柜,u_height=0) 库房三态六条有向转换全部 200，
      // 各自 assertEventSet（primary 1 行、affected 0 行、载荷恰 {status} 前后值）。
      const DIRECTED_PAIRS = [
        ['in_depot', 'faulty'], ['faulty', 'in_depot'],
        ['in_depot', 'to_retire'], ['to_retire', 'in_depot'],
        ['faulty', 'to_retire'], ['to_retire', 'faulty'],
      ];
      async function testMarkStatusDirected(category, extra) {
        for (const [from, to] of DIRECTED_PAIRS) {
          const reg = await regAdmin(Object.assign(
            { category, name: uniq(`N5${category}`), placement: { kind: 'depot', status: from } }, extra || {}
          ));
          check(`N5夹具-${category}(${from}): 登记成功`, reg.status === 201, JSON.stringify(reg.body));
          const id = reg.body.id;
          const r = await actionAdmin(id, 'mark_status', { expected_version: 1, status: to });
          check(`N5-${category} mark_status ${from}→${to} 成功200`, r.status === 200, JSON.stringify(r.body));
          await assertEventSet(`N5-${category} mark_status ${from}→${to}`, r.body.op_id, {
            action: 'mark_status', operator_id: 1,
            primary: { assetId: id, from: { status: from }, to: { status: to } },
            affected: [],
          });
          // RT-risk-2（第8批）：GET 详情断资产 status===目标态 且 version 恰 +1（登记时1→动作后2）。
          const getAfter = await api('GET', `/api/it-assets/${id}`, { uid: 1, role: 'admin' });
          check(`N5-${category} mark_status ${from}→${to}: GET详情status===${to}且version恰+1`,
            getAfter.body.asset.status === to && getAfter.body.asset.version === 2, JSON.stringify(getAfter.body.asset));
        }
      }
      await testMarkStatusDirected('laptop');
      await testMarkStatusDirected('ap');
      await testMarkStatusDirected('other', { u_height: 0 });
    }

    // ============================================================
    // N8. 事件载荷与 PAYLOAD_KEYS 对拍
    // ============================================================
    currentCaseLabel = 'N8组: 事件载荷与PAYLOAD_KEYS对拍';
    {
      const PAYLOAD_KEYS = itLedgerModule._internals.PAYLOAD_KEYS;
      const expectedKeys = {
        rack_in: { primary: ['status', 'rack_id', 'u_start'], affected: ['status'] },
        rack_out: { primary: ['status', 'rack_id', 'u_start'], affected: ['status'] },
        rack_move: { primary: ['rack_id', 'u_start'], affected: [] },
        rack_relocate: { primary: ['u_start'], affected: [] },
        mark_status: { primary: ['status'], affected: ['status'] },
        retire: { primary: ['status'], affected: [] },
      };
      for (const action of Object.keys(expectedKeys)) {
        const p = [...PAYLOAD_KEYS[action].primary].sort();
        const a = [...PAYLOAD_KEYS[action].affected].sort();
        check(`N8-${action}.primary键集合与§3表全等`, JSON.stringify(p) === JSON.stringify([...expectedKeys[action].primary].sort()), JSON.stringify(p));
        check(`N8-${action}.affected键集合与§3表全等`, JSON.stringify(a) === JSON.stringify([...expectedKeys[action].affected].sort()), JSON.stringify(a));
      }

      // T-M5（第6批）：六动作全部走 assertEventSet（op_id 非空、role、asset_id、
      // related_asset_id、载荷键集全等+逐键值），删掉旧的手写 assertEventShape 对拍。

      // rack_in（带一块随装盘，覆盖 affected）。
      {
        const rk = await freshRack(10);
        const host = await regAdmin({ category: 'server', name: uniq('N8in'), u_height: 1, slot_count: 1, placement: { kind: 'depot', status: 'in_depot' } });
        const hostId = host.body.id;
        const disk = await regAdmin({ category: 'disk', name: uniq('N8ind'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 }, peer_versions: { [hostId]: 1 } });
        const diskId = disk.body.id;
        const r = await actionAdmin(hostId, 'rack_in', { expected_version: 2, rack_id: rk, u_start: 1 });
        check('N8夹具: rack_in成功', r.status === 200, JSON.stringify(r.body));
        await assertEventSet('N8-rack_in', r.body.op_id, {
          action: 'rack_in', operator_id: 1,
          primary: { assetId: hostId, from: { status: 'in_depot', rack_id: null, u_start: null }, to: { status: 'in_service', rack_id: rk, u_start: 1 } },
          affected: [{ assetId: diskId, from: { status: 'in_depot' }, to: { status: 'in_service' } }],
        });
      }

      // rack_out（在位宿主+一块随装盘，to 缺省 in_depot）。
      {
        const rk = await freshRack(10);
        const host = await regAdmin({ category: 'server', name: uniq('N8out'), u_height: 1, slot_count: 1, placement: { kind: 'rack', rack_id: rk, u_start: 1 } });
        const hostId = host.body.id;
        const disk = await regAdmin({ category: 'disk', name: uniq('N8outd'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 }, peer_versions: { [hostId]: 1 } });
        const diskId = disk.body.id;
        const r = await actionAdmin(hostId, 'rack_out', { expected_version: 2 });
        check('N8夹具: rack_out成功', r.status === 200, JSON.stringify(r.body));
        await assertEventSet('N8-rack_out', r.body.op_id, {
          action: 'rack_out', operator_id: 1,
          primary: { assetId: hostId, from: { status: 'in_service', rack_id: rk, u_start: 1 }, to: { status: 'in_depot', rack_id: null, u_start: null } },
          affected: [{ assetId: diskId, from: { status: 'in_service' }, to: { status: 'in_depot' } }],
        });
      }

      // mark_status（库房态宿主+一块随装盘）。
      {
        const host = await regAdmin({ category: 'server', name: uniq('N8ms'), u_height: 1, slot_count: 1, placement: { kind: 'depot', status: 'in_depot' } });
        const hostId = host.body.id;
        const disk = await regAdmin({ category: 'disk', name: uniq('N8msd'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 }, peer_versions: { [hostId]: 1 } });
        const diskId = disk.body.id;
        const r = await actionAdmin(hostId, 'mark_status', { expected_version: 2, status: 'faulty' });
        check('N8夹具: mark_status成功', r.status === 200, JSON.stringify(r.body));
        await assertEventSet('N8-mark_status', r.body.op_id, {
          action: 'mark_status', operator_id: 1,
          primary: { assetId: hostId, from: { status: 'in_depot' }, to: { status: 'faulty' } },
          affected: [{ assetId: diskId, from: { status: 'in_depot' }, to: { status: 'faulty' } }],
        });
      }

      // retire（无盘设备，恰1行，无affected）。
      {
        const dev = await regAdmin({ category: 'laptop', name: uniq('N8ret'), placement: { kind: 'depot', status: 'to_retire' } });
        const devId = dev.body.id;
        const r = await actionAdmin(devId, 'retire', { expected_version: 1 });
        check('N8夹具: retire成功', r.status === 200, JSON.stringify(r.body));
        await assertEventSet('N8-retire', r.body.op_id, {
          action: 'retire', operator_id: 1,
          primary: { assetId: devId, from: { status: 'to_retire' }, to: { status: 'retired' } },
          affected: [],
        });
      }

      // rack_move（无盘设备，恰1行，无affected）。
      {
        const rN8a = await freshRack(10);
        const rN8b = await freshRack(10);
        const s = await regAdmin({ category: 'server', name: uniq('N8mv'), u_height: 1, slot_count: 0, placement: { kind: 'rack', rack_id: rN8a, u_start: 8 } });
        const sid = s.body.id;
        const r = await actionAdmin(sid, 'rack_move', { expected_version: 1, rack_id: rN8b, u_start: 9 });
        check('N8夹具: rack_move成功', r.status === 200, JSON.stringify(r.body));
        await assertEventSet('N8-rack_move', r.body.op_id, {
          action: 'rack_move', operator_id: 1,
          primary: { assetId: sid, from: { rack_id: rN8a, u_start: 8 }, to: { rack_id: rN8b, u_start: 9 } },
          affected: [],
        });

        // rack_relocate（同一台设备继续同柜移位，恰1行，无affected）。
        const r2 = await actionAdmin(sid, 'rack_relocate', { expected_version: 2, u_start: 7 });
        check('N8夹具: rack_relocate成功', r2.status === 200, JSON.stringify(r2.body));
        await assertEventSet('N8-rack_relocate', r2.body.op_id, {
          action: 'rack_relocate', operator_id: 1,
          primary: { assetId: sid, from: { u_start: 9 }, to: { u_start: 7 } },
          affected: [],
        });
      }
    }

    // ============================================================
    // N2. 状态机负向矩阵（六动作 × 硬件五态 + software(active)）——第2批补齐。
    //   期望矩阵是手写常量表（不从实现推导），逐格断言；非法格额外核对行/事件快照不变。
    // ============================================================
    currentCaseLabel = 'N2组: 状态机负向矩阵';
    {
      let n2SlotSeq = 0;
      function nextN2Slot() { n2SlotSeq += 1; return (n2SlotSeq % 18) + 1; }
      async function forceStatus(id, status) { await rawRun('UPDATE it_assets SET status = ? WHERE id = ?', [status, id]); }

      // 手写期望表（方案 §4 矩阵逐格）：'OK' | 'ACTION_NOT_ALLOWED_IN_STATUS' | 'ACTION_NOT_APPLICABLE'。
      const EXPECTED = {
        rack_in: { in_service: 'ACTION_NOT_ALLOWED_IN_STATUS', in_depot: 'OK', faulty: 'ACTION_NOT_ALLOWED_IN_STATUS', to_retire: 'ACTION_NOT_ALLOWED_IN_STATUS', retired: 'ACTION_NOT_ALLOWED_IN_STATUS', software: 'ACTION_NOT_APPLICABLE' },
        rack_out: { in_service: 'OK', in_depot: 'ACTION_NOT_ALLOWED_IN_STATUS', faulty: 'ACTION_NOT_ALLOWED_IN_STATUS', to_retire: 'ACTION_NOT_ALLOWED_IN_STATUS', retired: 'ACTION_NOT_ALLOWED_IN_STATUS', software: 'ACTION_NOT_APPLICABLE' },
        rack_move: { in_service: 'OK', in_depot: 'ACTION_NOT_ALLOWED_IN_STATUS', faulty: 'ACTION_NOT_ALLOWED_IN_STATUS', to_retire: 'ACTION_NOT_ALLOWED_IN_STATUS', retired: 'ACTION_NOT_ALLOWED_IN_STATUS', software: 'ACTION_NOT_APPLICABLE' },
        rack_relocate: { in_service: 'OK', in_depot: 'ACTION_NOT_ALLOWED_IN_STATUS', faulty: 'ACTION_NOT_ALLOWED_IN_STATUS', to_retire: 'ACTION_NOT_ALLOWED_IN_STATUS', retired: 'ACTION_NOT_ALLOWED_IN_STATUS', software: 'ACTION_NOT_APPLICABLE' },
        mark_status: { in_service: 'ACTION_NOT_ALLOWED_IN_STATUS', in_depot: 'OK', faulty: 'OK', to_retire: 'OK', retired: 'ACTION_NOT_ALLOWED_IN_STATUS', software: 'ACTION_NOT_APPLICABLE' },
        retire: { in_service: 'ACTION_NOT_ALLOWED_IN_STATUS', in_depot: 'ACTION_NOT_ALLOWED_IN_STATUS', faulty: 'ACTION_NOT_ALLOWED_IN_STATUS', to_retire: 'OK', retired: 'ACTION_NOT_ALLOWED_IN_STATUS', software: 'ACTION_NOT_APPLICABLE' },
      };
      // T-M2（第5批）：期望表加 HTTP 状态列——逐格精确比状态码 + 业务码，不只看业务码。
      const EXPECTED_STATUS = { OK: 200, ACTION_NOT_ALLOWED_IN_STATUS: 409, ACTION_NOT_APPLICABLE: 400 };
      const HW_STATES = ['in_service', 'in_depot', 'faulty', 'to_retire', 'retired'];
      const RACK_ACTIONS = new Set(['rack_in', 'rack_out', 'rack_move', 'rack_relocate']);

      for (const action of Object.keys(EXPECTED)) {
        for (const state of HW_STATES.concat(['software'])) {
          const expected = EXPECTED[action][state];
          let id;
          let extraParams = {};
          if (state === 'software') {
            const r = await regAdmin({ category: 'software', name: uniq('N2sw') });
            id = r.body.id;
          } else if (RACK_ACTIONS.has(action)) {
            if (state === 'in_service') {
              const rk = await freshRack(20);
              const slot = nextN2Slot();
              const r = await regAdmin({ category: 'other', name: uniq('N2rk'), u_height: 1, slot_count: 0, placement: { kind: 'rack', rack_id: rk, u_start: slot } });
              id = r.body.id;
              if (action === 'rack_move') extraParams = { rack_id: await freshRack(10), u_start: 1 };
              // L20（主会话第3批裁定）：目标 U 显式写"当前 U+1"（而非另取一个不相关的随机槽位），
              // 让"合法格必须成功"这句断言的因果更直白——slot ∈ [1,18]（nextN2Slot 的取模范围），
              // rack_id 独立机柜 u_total=20，slot+1 ≤19 恒在合法区间内，不会意外撞越顶。
              else if (action === 'rack_relocate') extraParams = { u_start: slot + 1 };
            } else {
              const r = await regAdmin({ category: 'other', name: uniq('N2rk'), u_height: 1, slot_count: 0, placement: { kind: 'depot', status: 'in_depot' } });
              id = r.body.id;
              if (state !== 'in_depot') await forceStatus(id, state);
              if (action === 'rack_in' || action === 'rack_move') extraParams = { rack_id: await freshRack(10), u_start: 1 };
              else if (action === 'rack_relocate') extraParams = { u_start: 1 };
            }
          } else {
            if (state === 'in_service') {
              const r = await regAdmin({ category: 'laptop', name: uniq('N2lap'), placement: { kind: 'custodian', custodian_name: '张三' } });
              id = r.body.id;
            } else {
              const r = await regAdmin({ category: 'laptop', name: uniq('N2lap'), placement: { kind: 'depot', status: 'in_depot' } });
              id = r.body.id;
              if (state !== 'in_depot') await forceStatus(id, state);
            }
            if (action === 'mark_status') extraParams = { status: state === 'in_depot' ? 'faulty' : 'in_depot' };
          }

          const expectedStatus = EXPECTED_STATUS[expected];
          let r;
          if (expected === 'OK') {
            r = await actionAdmin(id, action, Object.assign({ expected_version: 1 }, extraParams));
            check(`N2-${action}×${state}: 合法格期望HTTP${expectedStatus}`, r.status === expectedStatus, JSON.stringify(r.body));
          } else {
            // T-H2（第5批）：assertNoSideEffect 替换"只比 status/version/事件数"——整行深等 +
            // 事件表深等。
            r = await assertNoSideEffect(`N2-${action}×${state}`, [id],
              () => actionAdmin(id, action, Object.assign({ expected_version: 1 }, extraParams)));
            check(`N2-${action}×${state}: 非法格期望HTTP${expectedStatus}/${expected}`,
              r.status === expectedStatus && !!r.body && r.body.code === expected, JSON.stringify(r.body));
            // M14（主会话第3批裁定）：ACTION_NOT_ALLOWED_IN_STATUS 格额外核对 detail.current_status
            // 精确等于本格的前置状态（state 在五态循环里就是真实 DB 状态字面量，可直接比较；
            // software 格走 ACTION_NOT_APPLICABLE，不带 detail，不做此项断言）。
            if (expected === 'ACTION_NOT_ALLOWED_IN_STATUS') {
              check(`N2-${action}×${state}: detail.current_status===${state}`,
                !!r.body.detail && r.body.detail.current_status === state, JSON.stringify(r.body));
            }
          }
        }
      }
    }

    // ============================================================
    // N6. #10 脏数据拦截——第2批补齐（守卫自有 sqlite3 句柄直插脏数据 → HTTP 动作 →
    //   409 CUSTODIAN_REQUIRED / RACK_INTERVAL 族码 + 行不变 + 无新事件；每例先跑干净态
    //   同动作成功作对照组）。
    // ============================================================
    currentCaseLabel = 'N6组: #10脏数据拦截';
    {
      // 例1：CUSTODIAN_REQUIRED——干净态对照组先证明同一动作在合法数据上能成功。
      const cleanLap = await regAdmin({ category: 'laptop', name: uniq('N6clean'), placement: { kind: 'depot', status: 'in_depot' } });
      const cleanR = await actionAdmin(cleanLap.body.id, 'mark_status', { expected_version: 1, status: 'faulty' });
      check('N6-对照组: 干净laptop mark_status成功(200)', cleanR.status === 200, JSON.stringify(cleanR.body));

      // T-M6（第6批）：改用 assertNoSideEffect——完整行快照（SELECT *）天然含 custodian_name
      // 脏值，深等比较等于"脏值原样保留 + 其余列不变"一次断完。
      const dirtyLap = await regAdmin({ category: 'laptop', name: uniq('N6dirty'), placement: { kind: 'depot', status: 'in_depot' } });
      const dirtyId = dirtyLap.body.id;
      await rawRun("UPDATE it_assets SET custodian_name = '脏' WHERE id = ?", [dirtyId]);
      const dirtyR = await assertNoSideEffect('N6-脏custodian_name', [dirtyId],
        () => actionAdmin(dirtyId, 'mark_status', { expected_version: 1, status: 'faulty' }));
      check('N6-脏custodian_name(mark_status前存量脏数据): →409 CUSTODIAN_REQUIRED',
        dirtyR.status === 409 && dirtyR.body.code === 'CUSTODIAN_REQUIRED', JSON.stringify(dirtyR.body));

      // 例2：RACK_INTERVAL 族码——宿主行脏写 u_start 非空但 status 仍 in_depot（"库房态恒
      //   NULL"的不变量被存量脏数据破坏）。用 mark_status（不改位置列，直接暴露脏值）而非
      //   rack_in（rack_in 会用请求参数覆写 u_start，反而"顺带修好"脏数据，测不出"动作路径对
      //   整行做全量校验"这条性质——这是本轮相对 spec §6 N6 原文的必要替换，回报中列出）。
      const cleanHost = await regAdmin({ category: 'server', name: uniq('N6cleanhost'), u_height: 2, slot_count: 0, placement: { kind: 'depot', status: 'in_depot' } });
      const cleanHostR = await actionAdmin(cleanHost.body.id, 'mark_status', { expected_version: 1, status: 'faulty' });
      check('N6-对照组: 干净host mark_status成功(200)', cleanHostR.status === 200, JSON.stringify(cleanHostR.body));

      const dirtyHost = await regAdmin({ category: 'server', name: uniq('N6dirtyhost'), u_height: 2, slot_count: 0, placement: { kind: 'depot', status: 'in_depot' } });
      const dirtyHostId = dirtyHost.body.id;
      await rawRun('UPDATE it_assets SET u_start = 5 WHERE id = ?', [dirtyHostId]);
      // T-M6：assertNoSideEffect 完整行快照天然含 rack_id(null)/u_start(脏值5)，深等比较即
      // "脏值原样保留"。
      const dirtyHostR = await assertNoSideEffect('N6-脏u_start', [dirtyHostId],
        () => actionAdmin(dirtyHostId, 'mark_status', { expected_version: 1, status: 'faulty' }));
      // H4（主会话第3批裁定）：断言定死为 400 LEDGER_BAD_REQUEST field='rack_id'——RACK_INTERVAL
      // 规则非在位分支的默认 v() 判据固定产出这三项（spec §6 N6 原文写 409 是主会话笔误，回报
      // 里列为 spec 偏差，不是本文件断言错）。
      check('N6-脏u_start(库房态残留): mark_status→400 LEDGER_BAD_REQUEST field=rack_id',
        dirtyHostR.status === 400 && dirtyHostR.body.code === 'LEDGER_BAD_REQUEST' && dirtyHostR.body.field === 'rack_id',
        JSON.stringify(dirtyHostR.body));

      // 例3（LOW-1，第7批）：库内存量脏 attrs（不是合法 JSON 对象文本）——toRowForCheck 必须
      // fail-closed 成 500 LEDGER_INTERNAL，不能让裸 JSON.parse 抛出的 SyntaxError 冒泡成别的
      // 形态，也不能被误判成 400。
      const cleanAttrs = await regAdmin({ category: 'laptop', name: uniq('N6cleanattrs'), placement: { kind: 'depot', status: 'in_depot' } });
      const cleanAttrsR = await actionAdmin(cleanAttrs.body.id, 'mark_status', { expected_version: 1, status: 'faulty' });
      check('N6-对照组: 干净attrs mark_status成功(200)', cleanAttrsR.status === 200, JSON.stringify(cleanAttrsR.body));

      const dirtyAttrs = await regAdmin({ category: 'laptop', name: uniq('N6dirtyattrs'), placement: { kind: 'depot', status: 'in_depot' } });
      const dirtyAttrsId = dirtyAttrs.body.id;
      await rawRun("UPDATE it_assets SET attrs = 'oops' WHERE id = ?", [dirtyAttrsId]);
      const dirtyAttrsR = await assertNoSideEffect('N6-脏attrs', [dirtyAttrsId],
        () => actionAdmin(dirtyAttrsId, 'mark_status', { expected_version: 1, status: 'faulty' }));
      check('N6-脏attrs(非法JSON文本): mark_status→500 LEDGER_INTERNAL field=attrs',
        dirtyAttrsR.status === 500 && dirtyAttrsR.body.code === 'LEDGER_INTERNAL' && dirtyAttrsR.body.field === 'attrs',
        JSON.stringify(dirtyAttrsR.body));
    }

    // ============================================================
    // N7. 活体变异——第2批补齐。三处：①注掉子盘UPDATE ②注掉逐子盘校验 ③注掉schema校验器调用。
    //   ①②需要独立的"变异后 index.js"实例（HTTP 全链路）——RT-rec-5（第8批）：写到
    //   scripts/.mutant-scratch/ 临时目录（不是 routes/it-ledger/ 生产源码目录），
    //   index.js 内部原本的相对路径 require('./invariants') 在写入前已被替换成绝对路径
    //   字面量（见 withMutatedIndexModule），因此变异体不需要和 invariants.js 同目录也能正确
    //   解析依赖；用完立即删除。③是纯函数直调，沿用 J 组对 invariants.js 的变异手法。
    // ============================================================
    let withC4MutatedIndexModule;
    currentCaseLabel = 'N7组: 活体变异';
    {
      const itLedgerDir = path.join(__dirname, '..', 'routes', 'it-ledger');
      async function withMutatedIndexModule(mutateFn, scenarioFn, label) {
        const srcPath = path.join(itLedgerDir, 'index.js');
        const src = fs.readFileSync(srcPath, 'utf8');
        const mutated0 = mutateFn(src);
        if (mutated0 === src) {
          check(`N7-${label}: 变异未生效(静态正则失配，不许静默通过)`, false, '正则未匹配到目标代码');
          return;
        }
        // T-risk3（第5批）→ RT-M3（第8批加固）：变异体不再写进 routes/it-ledger/ 源码目录——
        // 改写到 scratchpad，同时把相对 require('./invariants') 替换成绝对路径字面量
        // （JSON.stringify 出的字符串本身就是合法 JS 字符串字面量，含 Windows 反斜杠也安全），
        // 这样变异体挂在任意目录都能正确加载依赖，不需要"和 invariants.js 同目录"这个前提。
        // RT-M3：替换前先数 `require('./invariants')` 的命中次数，不是恰好 1 次就 fatalExit
        // 报出具体原因（0 次=源码写法已变、mutateFn 的正则/字符串替换可能已经悄悄改动了这行；
        // ≥2 次=源码里出现了不止一处这个字面量，替换会作用到不该动的地方）——避免"看似替换
        // 成功，实际上要么什么都没换、要么换错了地方"这种静默失败。
        const invariantsRequireCount = (mutated0.match(/require\('\.\/invariants'\)/g) || []).length;
        if (invariantsRequireCount !== 1) {
          fatalExit(`N7-${label}: require('./invariants') 命中次数异常`, `期望恰1次，实际${invariantsRequireCount}次`);
          return;
        }
        const invAbsPath = path.resolve(itLedgerDir, 'invariants.js');
        const c5Require = "require('./single-asset-actions')";
        if (mutated0.split(c5Require).length !== 2) throw new Error('C5依赖改写必须恰一次');
        const c6Require = "require('./stocktakes')"; if (mutated0.split(c6Require).length !== 2) throw new Error('C6依赖改写必须恰一次');
        const r2Require = "require('./reconciles')"; if (mutated0.split(r2Require).length !== 2) throw new Error('R2依赖改写必须恰一次');
        let mutated = mutated0.replace("require('./invariants')", `require(${JSON.stringify(invAbsPath)})`).replace(c5Require, `require(${JSON.stringify(path.resolve(itLedgerDir, 'single-asset-actions.js'))})`).replace(c6Require, `require(${JSON.stringify(path.resolve(itLedgerDir, 'stocktakes.js'))})`).replace(r2Require, `require(${JSON.stringify(path.resolve(itLedgerDir, 'reconciles.js'))})`);
        for (const name of ['inspections','inspection-collector','inspection-collect','record-management','inspection-sheets','inspection-photo-files']) {
          const needle = `require('./${name}')`;
          if (mutated.split(needle).length !== 2) throw new Error('巡检依赖改写必须恰一次');
          mutated = mutated.replace(needle, `require(${JSON.stringify(path.resolve(itLedgerDir,name+'.js'))})`);
        }
        // RT-M3：替换后再扫一遍剩余的相对 require（'./' 或 '../' 开头）——理论上 index.js 只有
        // 这一处相对依赖，若源码日后新增了别的相对 require 而本函数没跟着更新，变异体会在
        // scratch 目录里因为找不到相对路径的兄弟文件而 MODULE_NOT_FOUND，与其让它跑到那一步
        // 才报一个不知所云的错误，不如在这里主动扫描并 fatalExit 列出。
        const remainingRelativeRequires = mutated.match(/require\((['"])\.\.?\/[^'")]*\1\)/g) || [];
        if (remainingRelativeRequires.length > 0) {
          fatalExit(`N7-${label}: 变异体仍含未处理的相对 require`, JSON.stringify(remainingRelativeRequires));
          return;
        }
        // T-risk3 修正：非相对 require（express/sqlite3/crypto）靠 Node 从"文件所在目录"逐级向上
        // 找 node_modules 解析——scratch 目录必须仍在 wbs-server/ 目录树内才能找到
        // wbs-server/node_modules，落在 os.tmpdir() 会直接 MODULE_NOT_FOUND。用
        // scripts/.mutant-scratch/（scripts/ 是 node_modules 的兄弟目录，向上一级即可解析），
        // 不落进 routes/it-ledger/ 生产源码目录即达成本条目的初衷。RT-M3：显式 path.resolve()
        // 成绝对路径（IT_VERIFY_SCRATCH 若被设成相对路径，后续 fs.mkdirSync/fs.writeFileSync
        // 仍会以进程 cwd 为基准正确解析，但显式转绝对路径能让报错信息里的路径本身自解释，
        // 不依赖读者知道当时的 cwd 是什么）。
        const scratchDir = path.resolve(process.env.IT_VERIFY_SCRATCH || path.join(__dirname, '.mutant-scratch'));
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });
        const mutantPath = path.join(scratchDir, `it-ledger-index-mutant-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
        const mutantDb = path.join(os.tmpdir(), `it-ledger-actions-mutant-${Date.now()}-${process.pid}.db`);
        let mutServer = null; let mutMod = null;
        try {
          fs.writeFileSync(mutantPath, mutated, 'utf8');
          if (fs.existsSync(mutantDb)) fs.unlinkSync(mutantDb);
          await seedUsers(mutantDb);
          const mutApp = express(); mutApp.use(express.json());
          const factory = require(mutantPath);
          mutMod = factory({ logger, DB_FILE: mutantDb, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin, enableTestHooks: true });
          mutApp.use('/api', mutMod.router);
          await withTimeout(mutMod.initSchema(), 15000, `${label} initSchema`);
          mutServer = await listenOnSafePort(mutApp, null);
          const mutBase = `http://localhost:${mutServer.address().port}`;
          async function mutApi(method, urlPath, { uid, role, body } = {}) {
            const r = await fetchTestHttp(`${mutBase}${urlPath}`, {
              method,
              headers: Object.assign({ 'Content-Type': 'application/json' },
                uid !== undefined ? { 'x-test-user-id': String(uid) } : {},
                role !== undefined ? { 'x-test-user-role': String(role) } : {}),
              body: body !== undefined ? JSON.stringify(body) : undefined,
            });
            let j = null; try { j = await r.json(); } catch (_e) { /* ignore */ }
            return { status: r.status, body: j };
          }
          await scenarioFn(mutApi, mutantDb);
        } finally {
          if (mutServer) { try { await withTimeout(new Promise((resolve, reject) => mutServer.close((err) => err ? reject(err) : resolve())), 5000, 'mutServer.close'); } catch (err) { check(`N7-${label}: 变异服务关闭`, false, err.message); } }
          if (mutMod) { try { await withTimeout(mutMod.shutdown(), 10000, 'mutMod.shutdown'); } catch (err) { check(`N7-${label}: 变异模块关闭`, false, err.message); } }
          delete require.cache[mutantPath];
          try { if (fs.existsSync(mutantPath)) fs.unlinkSync(mutantPath); } catch (err) { check(`N7-${label}: 变异源码清理`, false, err.message); }
          // L1（第9批）：变异库清理失败不再吞掉——记一条 check(false,...)，避免"清理失败但
          // 测试仍全绿"这种静默假象（清理失败本身不影响本轮断言正确性，但会在临时目录残留
          // 泄漏，值得留痕而非静默忽略）。
          try { if (fs.existsSync(mutantDb)) fs.unlinkSync(mutantDb); } catch (cleanupErr) {
            check(`N7-${label}: 变异库清理成功`, false, cleanupErr && cleanupErr.message);
          }
        }
      }

      withC4MutatedIndexModule = withMutatedIndexModule;
      // ①注掉「UPDATE 子盘 status」一句——H1 重写后校验改为"写后重读再校验"，子盘真实
      //   status 从未被更新会被同一请求内的 HOST_DISK_STATUS_SYNC（宿主视角，读重读到的子盘
      //   真实 status）直接拦下并回滚，不再需要借道独立 PUT 端点才能暴露（H1 之前的版本子盘
      //   ctx 恒用 primaryTarget.status 覆盖，读不到真实值，只能借道 PUT；H1 之后同一请求即可
      //   暴露，测试相应简化）。
      {
        const rkClean = await freshRack(10);
        const hostClean = await regAdmin({ category: 'server', name: uniq('N7hostClean'), u_height: 2, slot_count: 2, placement: { kind: 'rack', rack_id: rkClean, u_start: 1 } });
        const hostCleanId = hostClean.body.id;
        const diskClean = await regAdmin({ category: 'disk', name: uniq('N7diskClean'), placement: { kind: 'host', parent_asset_id: hostCleanId, slot_no: 1 }, peer_versions: { [hostCleanId]: 1 } });
        const diskCleanId = diskClean.body.id;
        const outClean = await actionAdmin(hostCleanId, 'rack_out', { expected_version: 2 });
        check('N7①-原始行为(未变异): rack_out成功且子盘同步', outClean.status === 200, JSON.stringify(outClean.body));
        // T-H4（第5批）：成功对照组读子盘验证真的同步了（不只信响应体 status===200）。
        const diskCleanRow = await rawGet('SELECT status, version FROM it_assets WHERE id=?', [diskCleanId]);
        check('N7①-原始行为: 子盘真实DB状态随宿主同步为in_depot,version+1(1→2)',
          diskCleanRow.status === 'in_depot' && diskCleanRow.version === 2, JSON.stringify(diskCleanRow));
      }
      await withMutatedIndexModule(
        (src) => src.replace(
          `await q.run("UPDATE it_assets SET status = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?", [targetStatus, child.id]);`,
          `// MUTATED(N7-1): 子盘 UPDATE 语句已被注掉`
        ),
        async (mutApi, mutantDb) => {
          // MED-1（第9批 Opus 复看）：变异世界夹具三次建资产逐次断 201——不这样做的话，一旦
          // 某次建资产静默失败（比如变异体路由行为异常），hostId/diskId 会是 undefined，后面
          // 拿 undefined 去查快照会前后都查到"空行"，深等永远相等、测试假绿。
          const rk = await mutApi('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: 'RK1', u_total: 10 } });
          check('N7①-变异世界夹具: 建柜成功(201)', rk.status === 201, JSON.stringify(rk.body));
          const host = await mutApi('POST', '/api/it-assets', { uid: 1, role: 'admin', body: { category: 'server', name: 'H1', u_height: 2, slot_count: 2, placement: { kind: 'rack', rack_id: rk.body.id, u_start: 1 } } });
          check('N7①-变异世界夹具: 建宿主成功(201)', host.status === 201, JSON.stringify(host.body));
          const hostId = host.body.id;
          const disk = await mutApi('POST', '/api/it-assets', { uid: 1, role: 'admin', body: { category: 'disk', name: 'D1', placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 }, peer_versions: { [hostId]: 1 } } });
          check('N7①-变异世界夹具: 建子盘成功(201)', disk.status === 201, JSON.stringify(disk.body));
          const diskId = disk.body.id;
          // RT-H3（第8批）：mutant 世界改用 mutantDb 直接 SELECT * 快照宿主与固定子盘（含事件表），
          // 不再借道 GET 端点做深等对拍（GET 走 parseAssetRow/stripFinance 会做一层转换，不是
          // 最贴近底层的比较；直连 sqlite 才是名副其实的"资产行"深等）。
          const hostBefore = await snapshotAssetsFrom(mutantDb, [hostId]);
          const diskBefore = await snapshotAssetsFrom(mutantDb, [diskId]);
          const hostEvtBefore = await snapshotEventsFrom(mutantDb, [hostId]);
          const diskEvtBefore = await snapshotEventsFrom(mutantDb, [diskId]);
          // MED-1：快照本身非空——否则 hostId 为 undefined 时 before/after 会一起查出全空数组，
          // 后面的深等比较"真空通过"（都是[]自然相等），测不出任何差异。
          check('N7①-快照非空(宿主资产行确实存在)', !!hostBefore[0], JSON.stringify(hostBefore));
          check('N7①-快照非空(子盘资产行确实存在)', !!diskBefore[0], JSON.stringify(diskBefore));
          const out1 = await mutApi('POST', `/api/it-assets/${hostId}/actions/rack_out`, { uid: 1, role: 'admin', body: { expected_version: 2 } });
          check('N7①-变异后rack_out(子盘UPDATE被注掉)→409 HOST_DISK_STATUS_SYNC(同一请求内暴露，事务回滚)',
            out1.status === 409 && out1.body.code === 'HOST_DISK_STATUS_SYNC', JSON.stringify(out1.body));
          const hostAfter = await snapshotAssetsFrom(mutantDb, [hostId]);
          const diskAfter = await snapshotAssetsFrom(mutantDb, [diskId]);
          const hostEvtAfter = await snapshotEventsFrom(mutantDb, [hostId]);
          const diskEvtAfter = await snapshotEventsFrom(mutantDb, [diskId]);
          check('N7①-变异后: 宿主资产行深等无副作用(事务回滚)', JSON.stringify(hostBefore) === JSON.stringify(hostAfter),
            `before=${JSON.stringify(hostBefore)} after=${JSON.stringify(hostAfter)}`);
          check('N7①-变异后: 宿主事件表深等无副作用(事务回滚)', JSON.stringify(hostEvtBefore) === JSON.stringify(hostEvtAfter),
            `before=${JSON.stringify(hostEvtBefore)} after=${JSON.stringify(hostEvtAfter)}`);
          check('N7①-变异后: 固定子盘资产行深等无副作用(事务回滚)', JSON.stringify(diskBefore) === JSON.stringify(diskAfter),
            `before=${JSON.stringify(diskBefore)} after=${JSON.stringify(diskAfter)}`);
          check('N7①-变异后: 固定子盘事件表深等无副作用(事务回滚)', JSON.stringify(diskEvtBefore) === JSON.stringify(diskEvtAfter),
            `before=${JSON.stringify(diskEvtBefore)} after=${JSON.stringify(diskEvtAfter)}`);
        },
        '子盘UPDATE被注掉'
      );

      // ②注掉「对每个子盘跑 validateAssetInvariants」（M13，H1 重写后子盘 ctx/target 改用
      //   重读到的真实行，不再重言式覆盖 status——原批次两种反例（slot_no 超限 / 自引用）之所以
      //   无法隔离，根源正是"覆盖真实值"；现在用真实值后，"逐子盘专属、宿主聚合视角看不到"的
      //   字段（u_height，宿主 ctx.childDisks 只含 {slot_no,status}）就能唯一隔离这条循环）。
      {
        const rk0 = await freshRack(10);
        const host0 = await regAdmin({ category: 'server', name: uniq('N7host0'), u_height: 2, slot_count: 2, placement: { kind: 'depot', status: 'in_depot' } });
        const host0Id = host0.body.id;
        const disk0 = await regAdmin({ category: 'disk', name: uniq('N7disk0'), placement: { kind: 'host', parent_asset_id: host0Id, slot_no: 1 }, peer_versions: { [host0Id]: 1 } });
        const disk0Id = disk0.body.id;
        await rawRun('UPDATE it_assets SET u_height = 3 WHERE id = ?', [disk0Id]);
        // T-H4（第5批）：assertNoSideEffect 替换"只比 status/version"——宿主+固定子盘+事件表
        // 一起深等（脏写的 u_height=3 本身不受事务回滚影响，但宿主/子盘的 status/version/
        // 事件表必须原样不变）。
        const origResult = await assertNoSideEffect('N7②-原始行为', [host0Id, disk0Id],
          () => actionAdmin(host0Id, 'rack_in', { expected_version: 2, rack_id: rk0, u_start: 1 }));
        check('N7②-原始行为: 脏u_height=3(disk类别须恒0)使rack_in被拦截400 LEDGER_BAD_REQUEST field=u_height',
          origResult.status === 400 && origResult.body.code === 'LEDGER_BAD_REQUEST' && origResult.body.field === 'u_height', JSON.stringify(origResult.body));
      }
      await withMutatedIndexModule(
        (src) => {
          const marker = `    const ctxChild = { parent: { slot_count: primaryRow.slot_count, status: primaryRow.status, category: primaryRow.category } };
    for (const child of rereadChildren) {
      const childRow = toRowForCheck(child, {});
      const cv = validateAssetInvariants(childRow, ctxChild);
      // LOW-1（第4批 Opus 复看）：validateAssetInvariants 的违反对象恒自带 status/code（RULES
      // 每条分支都显式写了这两个字段，ROW_SCHEMA 同理），throwViolation 的 fallback 参数在
      // 这条调用点上从未被用到——删掉两个死 fallback，沿用违反对象自带状态码。
      if (cv) throwViolation(cv);
    }`;
          if (!src.includes(marker)) return src;
          return src.replace(marker, '    // MUTATED(N7-2): 逐子盘 validateAssetInvariants 循环已被注掉');
        },
        async (mutApi, mutantDb) => {
          // MED-1（第9批）：同 N7①，三次建资产逐次断 201，避免 hostId/diskId 为 undefined 时
          // 后续按 id 查询/事件核对静默假绿。
          const rk = await mutApi('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: 'RK2', u_total: 10 } });
          check('N7②-变异世界夹具: 建柜成功(201)', rk.status === 201, JSON.stringify(rk.body));
          const host = await mutApi('POST', '/api/it-assets', { uid: 1, role: 'admin', body: { category: 'server', name: 'H2', u_height: 2, slot_count: 2, placement: { kind: 'depot', status: 'in_depot' } } });
          check('N7②-变异世界夹具: 建宿主成功(201)', host.status === 201, JSON.stringify(host.body));
          const hostId = host.body.id;
          const d1 = await mutApi('POST', '/api/it-assets', { uid: 1, role: 'admin', body: { category: 'disk', name: 'D2', placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 }, peer_versions: { [hostId]: 1 } } });
          check('N7②-变异世界夹具: 建子盘成功(201)', d1.status === 201, JSON.stringify(d1.body));
          const diskId = d1.body.id;
          await rawRunAt(mutantDb, 'UPDATE it_assets SET u_height = 3 WHERE id = ?', [diskId]);
          const rackId = rk.body.id;
          const in1 = await mutApi('POST', `/api/it-assets/${hostId}/actions/rack_in`, { uid: 1, role: 'admin', body: { expected_version: 2, rack_id: rackId, u_start: 1 } });
          check('N7②-变异后: 脏u_height=3不再被拦截，rack_in放行(200)', in1.status === 200, JSON.stringify(in1.body));
          // RT-M3（第9批）：变异库里按 op_id 核对事件集合——主事件(宿主)+固定子盘 affected 恰
          // 1+1，角色/related_asset_id/action/operator_id/前后载荷全部精确核对。
          await assertEventSetFrom(mutantDb, 'N7②-变异后事件', in1.body.op_id, {
            action: 'rack_in', operator_id: 1,
            primary: { assetId: hostId, from: { status: 'in_depot', rack_id: null, u_start: null }, to: { status: 'in_service', rack_id: rackId, u_start: 1 } },
            affected: [
              { assetId: diskId, from: { status: 'in_depot' }, to: { status: 'in_service' } },
            ],
          });
          // RT-M2（第8批）：读变异库直断宿主落库结果 + 子盘同步结果 + 双方 version 各 +1。
          const hostRow = await rawGetAt(mutantDb, 'SELECT rack_id, u_start, status, version FROM it_assets WHERE id=?', [hostId]);
          check('N7②-变异后: 宿主rack_id/u_start/status落库正确',
            hostRow.rack_id === rackId && hostRow.u_start === 1 && hostRow.status === 'in_service', JSON.stringify(hostRow));
          check('N7②-变异后: 宿主version恰+1(2→3)', hostRow.version === 3, hostRow.version);
          const diskRow = await rawGetAt(mutantDb, 'SELECT status, version, u_height FROM it_assets WHERE id=?', [diskId]);
          check('N7②-变异后: 子盘status同步为in_service', diskRow.status === 'in_service', JSON.stringify(diskRow));
          check('N7②-变异后: 子盘version恰+1(1→2)', diskRow.version === 2, diskRow.version);
          check('N7②-变异后: 子盘u_height仍为3(动作本身不写u_height列，纯粹放行未被任何逻辑修正)',
            diskRow.u_height === 3, JSON.stringify(diskRow));
        },
        '逐子盘校验被注掉'
      );

      // ③注掉 schema 校验器调用（invariants.js 的 validateAssetInvariants 首行）——不完整行
      //   不再被 ROW_SCHEMA 拦截，纯函数直调验证。
      {
        const srcPath = path.join(itLedgerDir, 'invariants.js');
        const src = fs.readFileSync(srcPath, 'utf8');
        // LOW-2（第4批）：invariants.js 不再用 safeCtx 兜底，validateRowSchema 直接透传 ctx。
        const marker = 'const schemaResult = validateRowSchema(row, ctx);\n  if (schemaResult) return schemaResult;';
        if (!src.includes(marker)) {
          check('N7③-变异未生效(字符串匹配失配，不许静默通过)', false, '未找到目标片段');
        } else {
          const mutated = src.replace(marker, '// MUTATED(N7-3): schema 校验器调用已被注掉');
          const mutPath = path.join(os.tmpdir(), `it-ledger-invariants-mutant-noschema-${Date.now()}.js`);
          fs.writeFileSync(mutPath, mutated, 'utf8');
          try {
            // T-M1（第5批）：反例改为"合法 laptop 完整行删除 sn 键"（漏键，ROW_SCHEMA 四类职责
            // 里的"完整行契约"分支）——category 用 laptop（非机柜/非宿主资格）+ u_height:0，
            // 避免其它 RULE 因缺 ctx.childDisks/ctx.rack 抢先 500 干扰单一变量对照。同一个对象
            // 先过原始（未变异）入口证明确实 500/ROW_SCHEMA，再过变异入口证明变成 null。
            const rowMissingSn = fullValidRow({ category: 'laptop', u_height: 0 });
            delete rowMissingSn.sn;
            const before = inv.validateAssetInvariants(rowMissingSn, {});
            check('N7③-原始行为(未变异): laptop完整行删sn键→500 LEDGER_INTERNAL/ROW_SCHEMA/field=sn',
              !!before && before.status === 500 && before.code === 'LEDGER_INTERNAL' && before.rule === 'ROW_SCHEMA' && before.field === 'sn', JSON.stringify(before));
            const mutInv = require(mutPath);
            const after = mutInv.validateAssetInvariants(rowMissingSn, {});
            check('N7③-变异后(schema校验器被注掉): 同一漏sn键的行完全放行(null)', after === null, JSON.stringify(after));
          } finally {
            // L19（主会话第3批裁定）：require.cache 的键是 require.resolve() 出的绝对路径，
            // 用 require.resolve(mutPath) 而非裸 mutPath 更稳妥（两者理论上应相等，因 mutPath
            // 已是绝对路径，但统一走 resolve() 与 N7①②的清理写法同源，不留隐患）。
            try { delete require.cache[require.resolve(mutPath)]; } catch (_e) { /* ignore */ }
            try { fs.unlinkSync(mutPath); } catch (_e) { /* ignore */ }
          }
        }
      }
    }

    // ============================================================
    // N9. 并发终态一致性（登记 host 分支 vs 宿主 rack_out 两种顺序）——第2批补齐。
    // ============================================================
    currentCaseLabel = 'N9组: 并发终态一致性';
    {
      const { itTxnMutex } = itLedgerModule._internals;
      async function setupHostInRack() {
        const rk = await freshRack(10);
        const h = await regAdmin({ category: 'server', name: uniq('N9host'), u_height: 1, slot_count: 2, placement: { kind: 'rack', rack_id: rk, u_start: 1 } });
        return h.body.id;
      }

      // 顺序A：register(host分支) 先进事务并卡闸，rack_out 排队；释放闸后两者按序完成。
      {
        const hostId = await setupHostInRack();
        let releaseGate; const gatePromise = new Promise((r) => { releaseGate = r; });
        const arrivedPromise = itLedgerModule._internals.setTxnMidGate(gatePromise);
        const regP = regAdmin({ category: 'disk', name: uniq('N9diskA'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 }, peer_versions: { [hostId]: 1 } });
        // T-M7（第5批）：await arrivedPromise 改用 awaitArrived（同一请求 Promise 一并传入，
        // 若在到达信号前就提前 resolve/reject，会 fatalExit 而不是悄悄放过）。
        await awaitArrived(arrivedPromise, 'N9顺序A: register到达txnMidGate', regP);
        // register(host分支)保证先于rack_out完整提交(闸控)，故rack_out执行时宿主真实版本
        // 已是1(初始)+1(register host分支)=2——register 端点响应体不含 op_id/expected_version
        // 回显，这个"2"是根据代码里"host分支恒 version+1"这条契约推导出的确定值，不是猜测。
        const outP = actionAdmin(hostId, 'rack_out', { expected_version: 2 });
        await waitForCondition(() => itTxnMutex._internals.waiterCount() >= 1, 'N9顺序A等待rack_out排队', 3000);
        releaseGate();
        itLedgerModule._internals.setTxnMidGate(null);
        const [regR, outR] = await Promise.all([regP, outP]);
        check('N9顺序A: register(host分支)成功', regR.status === 201, JSON.stringify(regR.body));
        check('N9顺序A: rack_out成功', outR.status === 200, JSON.stringify(outR.body));
        const diskRow = await rawGet('SELECT status FROM it_assets WHERE id=?', [regR.body.id]);
        const hostRow = await rawGet('SELECT status, version FROM it_assets WHERE id=?', [hostId]);
        // T-M7：顺序A显式断言宿主与子盘均为 in_depot（rack_out 默认去向），不只比"两者相等"。
        check('N9顺序A: 终态子盘与宿主均为in_depot', diskRow.status === 'in_depot' && hostRow.status === 'in_depot', JSON.stringify({ diskRow, hostRow }));
        check('N9顺序A: 宿主version恰+2(1→2→3)', hostRow.version === 3, hostRow.version);
        // register 响应体不含 op_id（与动作端点响应形态不同）——改按 asset_id 查其 primary 事件
        // 拿到真实 op_id，再用该 op_id 查完整行数。
        const regPrimaryEvt = await rawGet("SELECT op_id FROM it_asset_events WHERE asset_id=? AND role='primary' ORDER BY id DESC LIMIT 1", [regR.body.id]);
        const regEvt = await rawAll('SELECT id FROM it_asset_events WHERE op_id=?', [regPrimaryEvt && regPrimaryEvt.op_id]);
        const outEvt = await rawAll('SELECT id FROM it_asset_events WHERE op_id=?', [outR.body.op_id]);
        check('N9顺序A: register事件1+1(primary+宿主affected)', regEvt.length === 2, regEvt.length);
        check('N9顺序A: rack_out事件1+1(primary+新盘affected，因盘已存在)', outEvt.length === 2, outEvt.length);
      }

      // 顺序B：rack_out 先进事务并卡闸，register 排队；释放闸后两者按序完成。
      {
        const hostId = await setupHostInRack();
        let releaseGate; const gatePromise = new Promise((r) => { releaseGate = r; });
        const arrivedPromise = itLedgerModule._internals.setTxnMidGate(gatePromise);
        const outP = actionAdmin(hostId, 'rack_out', { expected_version: 1 });
        await awaitArrived(arrivedPromise, 'N9顺序B: rack_out到达txnMidGate', outP);
        const regP = regAdmin({ category: 'disk', name: uniq('N9diskB'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 }, peer_versions: { [hostId]: 2 } });
        await waitForCondition(() => itTxnMutex._internals.waiterCount() >= 1, 'N9顺序B等待register排队', 3000);
        releaseGate();
        itLedgerModule._internals.setTxnMidGate(null);
        const [outR, regR] = await Promise.all([outP, regP]);
        check('N9顺序B: rack_out成功', outR.status === 200, JSON.stringify(outR.body));
        check('N9顺序B: register(host分支,带正确宿主版本2)成功', regR.status === 201, JSON.stringify(regR.body));
        const diskRow = await rawGet('SELECT status FROM it_assets WHERE id=?', [regR.body.id]);
        const hostRow = await rawGet('SELECT status, version FROM it_assets WHERE id=?', [hostId]);
        check('N9顺序B: 终态子盘随宿主进in_depot', !!diskRow && diskRow.status === 'in_depot' && hostRow.status === 'in_depot', JSON.stringify({ diskRow, hostRow }));
        check('N9顺序B: 宿主version恰+2(1→2→3)', hostRow.version === 3, hostRow.version);
        const outEvt = await rawAll('SELECT id FROM it_asset_events WHERE op_id=?', [outR.body.op_id]);
        const regPrimaryEvt = await rawGet("SELECT op_id FROM it_asset_events WHERE asset_id=? AND role='primary' ORDER BY id DESC LIMIT 1", [regR.body.id]);
        const regEvt = await rawAll('SELECT id FROM it_asset_events WHERE op_id=?', [regPrimaryEvt && regPrimaryEvt.op_id]);
        check('N9顺序B: rack_out事件恰1行(此时尚无子盘)', outEvt.length === 1, outEvt.length);
        check('N9顺序B: register事件1+1(primary+宿主affected)', regEvt.length === 2, regEvt.length);
      }
    }

    // C4 D1-D10：冻结期望均为手写表；不从 ACTION_HANDLERS/PAYLOAD_KEYS 推导。
    const diskActions = ['disk_mount', 'disk_unmount', 'disk_swap', 'disk_move'];
    const equal = (a, b) => JSON.stringify(sortObj(a)) === JSON.stringify(sortObj(b));
    async function dRow(id) {
      const row = await rawGet('SELECT * FROM it_assets WHERE id=?', [id]);
      check(`D夹具: 行${id}非空`, !!row);
      if (!row) throw new Error(`D fixture row missing: ${id}`);
      return row;
    }
    async function dRegister(body) {
      const r = await regAdmin(Object.assign({ name: uniq('D'), fin_amount: 123, fin_vendor: 'D-vendor' }, body));
      check('D夹具: register=201', r.status === 201, JSON.stringify(r.body));
      if (r.status !== 201) throw new Error(`D register fixture: ${JSON.stringify(r)}`);
      return r.body.id;
    }
    async function dHost() {
      const rackId = await freshRack(10);
      return dRegister({ category: 'server', u_height: 2, slot_count: 4, placement: { kind: 'rack', rack_id: rackId, u_start: 1 } });
    }
    async function dDisk(hostId, slot) {
      return dRegister(hostId ? { category: 'disk', placement: { kind: 'host', parent_asset_id: hostId, slot_no: slot }, peer_versions: { [hostId]: (await dRow(hostId)).version } }
        : { category: 'disk', placement: { kind: 'depot', status: 'in_depot' } });
    }
    async function dFixture(action) {
      const source = await dHost(); const target = await dHost();
      const sibling = await dDisk(source, 4);
      const disk = await dDisk(action === 'disk_mount' ? null : source, 1);
      const replacement = await dDisk(null);
      const f = { source, target, sibling, disk, replacement, ids: [source, target, sibling, disk, replacement] };
      f.body = await dBody(f, action);
      return f;
    }
    async function dBody(f, action) {
      const body = { expected_version: (await dRow(f.disk)).version, peer_versions: {} };
      if (action === 'disk_mount' || action === 'disk_move') Object.assign(body, { parent_asset_id: f.target, slot_no: 2 });
      if (action === 'disk_unmount' || action === 'disk_swap') body.to = 'faulty';
      if (action === 'disk_swap') body.new_disk_id = f.replacement;
      const ids = action === 'disk_mount' ? [f.target] : action === 'disk_unmount' ? [f.source] : action === 'disk_swap' ? [f.source, f.replacement] : [f.source, f.target];
      for (const id of ids) body.peer_versions[id] = (await dRow(id)).version;
      return body;
    }
    async function dReject(label, f, action, body, status, code, user) {
      const allEvents = await rawAll('SELECT * FROM it_asset_events ORDER BY id');
      const r = await assertNoSideEffect(label, f.ids, () => actionAs(user ? user.uid : 1, user ? user.role : 'admin', f.disk, action, body));
      check(`${label}: 全事件表深等`, equal(allEvents, await rawAll('SELECT * FROM it_asset_events ORDER BY id')));
      check(`${label}: ${status} ${code}`, r.status === status && r.body.code === code, JSON.stringify(r));
      return r;
    }
    function dExpected(f, action, before, body) {
      const disk = before.find((r) => r.id === f.disk);
      const replacement = before.find((r) => r.id === f.replacement);
      const triple = (r) => ({ status: r.status, parent_asset_id: r.parent_asset_id, slot_no: r.slot_no });
      const primary = { assetId: f.disk, from: triple(disk), to: null };
      const affected = [];
      if (action === 'disk_mount') {
        primary.to = { status: 'in_service', parent_asset_id: body.parent_asset_id, slot_no: body.slot_no };
        affected.push({ assetId: body.parent_asset_id, from: { slot_no: body.slot_no, disk_id: null }, to: { slot_no: body.slot_no, disk_id: f.disk } });
      } else if (action === 'disk_unmount') {
        primary.to = { status: body.to, parent_asset_id: null, slot_no: null };
        affected.push({ assetId: disk.parent_asset_id, from: { slot_no: disk.slot_no, disk_id: f.disk }, to: { slot_no: disk.slot_no, disk_id: null } });
      } else if (action === 'disk_swap') {
        primary.to = { status: body.to, parent_asset_id: null, slot_no: null };
        affected.push({ assetId: f.replacement, from: triple(replacement), to: { status: 'in_service', parent_asset_id: disk.parent_asset_id, slot_no: disk.slot_no } });
        affected.push({ assetId: disk.parent_asset_id, from: { slot_no: disk.slot_no, disk_id: f.disk }, to: { slot_no: disk.slot_no, disk_id: f.replacement } });
      } else {
        primary.from = { parent_asset_id: disk.parent_asset_id, slot_no: disk.slot_no };
        primary.to = { parent_asset_id: body.parent_asset_id, slot_no: body.slot_no };
        affected.push({ assetId: disk.parent_asset_id, from: { slot_no: disk.slot_no, disk_id: f.disk }, to: { slot_no: disk.slot_no, disk_id: null } });
        affected.push({ assetId: body.parent_asset_id, from: { slot_no: body.slot_no, disk_id: null }, to: { slot_no: body.slot_no, disk_id: f.disk } });
      }
      return { action, operator_id: 1, primary, affected };
    }
    async function dSuccess(label, f, action, body, user) {
      const before = await snapshotAssets(f.ids);
      const expected = dExpected(f, action, before, body);
      expected.operator_id = user ? user.uid : 1;
      const r = await actionAs(expected.operator_id, user ? user.role : 'admin', f.disk, action, body);
      check(`${label}: 200`, r.status === 200, JSON.stringify(r));
      if (r.status !== 200) throw new Error(`${label}: unexpected response`);
      await assertEventSet(label, r.body.op_id, expected);
      const affectedIds = expected.affected.map((e) => e.assetId);
      check(`${label}: affected_ids集合全等`, equal([...r.body.affected_ids].sort((a,b)=>a-b), [...affectedIds].sort((a,b)=>a-b)));
      const after = await snapshotAssets(f.ids);
      const changed = new Map([[f.disk, expected.primary.to]]);
      if (action === 'disk_swap') changed.set(f.replacement, expected.affected[0].to);
      for (const old of before) {
        const next = after.find((row) => row.id === old.id);
        const touched = old.id === f.disk || affectedIds.includes(old.id);
        const want = Object.assign({}, old, changed.get(old.id) || {}, touched ? { version: old.version + 1, updated_at: next.updated_at } : {});
        check(`${label}: 行${old.id}完整字段及version${touched ? '+1' : '不变'}`, equal(want, next), JSON.stringify({want,next}));
      }
      check(`${label}: note写入全部事件`, (await rawAll('SELECT note FROM it_asset_events WHERE op_id=?', [r.body.op_id])).every((e) => e.note === (body.note || null)));
      if (user) for (const key of ['fin_amount','fin_vendor','fin_contract_no','external_amount']) check(`${label}: 响应剔除${key}`, !Object.prototype.hasOwnProperty.call(r.body, key));
      else check(`${label}: admin财务对照123`, r.body.fin_amount === 123, JSON.stringify(r.body));
      return r;
    }

    currentCaseLabel = 'D1协议';
    for (const action of diskActions) {
      const f = await dFixture(action);
      const b = f.body; const peerKeys = Object.keys(b.peer_versions);
      const variants = [
        ['缺peer', { ...b, peer_versions: undefined }], ['空peer', { ...b, peer_versions: {} }],
        ['nullpeer', { ...b, peer_versions: null }], ['数组peer', { ...b, peer_versions: [] }],
        ['多peer', { ...b, peer_versions: { ...b.peer_versions, 999999: 1 } }],
        ['别名peer', { ...b, peer_versions: Object.assign({}, b.peer_versions, { ['0' + peerKeys[0]]: 1 }) }],
        ['原型peer', { ...b, peer_versions: JSON.parse('{"__proto__":1}') }],
        ['未知字段', { ...b, sneaky: 1 }], ['缺主版本', { ...b, expected_version: undefined }],
        ['坏主版本', { ...b, expected_version: '1' }],
      ];
      for (const key of peerKeys) {
        const less = { ...b.peer_versions }; delete less[key];
        variants.push([`缺键${key}`, { ...b, peer_versions: less }]);
        for (const value of [0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) variants.push([`坏版本${key}:${value}`, { ...b, peer_versions: { ...b.peer_versions, [key]: value } }]);
        await dReject(`D1-${action}-对端${key}陈旧`, f, action, { ...b, peer_versions: { ...b.peer_versions, [key]: b.peer_versions[key] + 1 } }, 409, 'VERSION_CONFLICT');
      }
      for (const [name, body] of variants) await dReject(`D1-${action}-${name}`, f, action, body, 400, 'LEDGER_BAD_REQUEST');
      await dReject(`D1-${action}-主版本陈旧`, f, action, { ...b, expected_version: b.expected_version + 1 }, 409, 'VERSION_CONFLICT');
      for (const uid of [3, 999]) await dReject(`D1-${action}-权限${uid}`, f, action, b, 403, 'LEDGER_FORBIDDEN', { uid, role:'user' });
      await dReject(`D1-${action}-非admin财务`, f, action, { ...b, fin_amount: 5 }, 400, 'FINANCE_FIELD_FORBIDDEN', { uid:2, role:'user' });
      await dSuccess(`D4-${action}`, f, action, { ...b, note: 'C4测试' });
      const userF = await dFixture(action);
      await dSuccess(`D1-${action}-write响应隔离`, userF, action, userF.body, { uid:2, role:'user' });
    }
    for (const action of ['rack_in','rack_out','rack_move','rack_relocate','mark_status','retire']) {
      const f = await dFixture('disk_mount'); f.disk = f.source;
      await dReject(`D1-C3-${action}非空peer`, f, action, { expected_version:(await dRow(f.disk)).version, peer_versions:{[f.target]:1} }, 400, 'LEDGER_BAD_REQUEST');
    }

    currentCaseLabel = 'D2手写矩阵';
    // 每格的期望是业务手写：M=散盘装入，其余要求随装；库房拆盘是唯一例外。
    const D2_DISK_MATRIX = {
      disk_mount:   { in_depot:200, faulty:409, to_retire:409, retired:409 },
      disk_unmount: { in_depot:409, faulty:409, to_retire:409, retired:409 },
      disk_swap:    { in_depot:409, faulty:409, to_retire:409, retired:409 },
      disk_move:    { in_depot:409, faulty:409, to_retire:409, retired:409 },
    };
    const D2_HOST_MATRIX = {
      disk_mount:   { in_service:200, in_depot:409, faulty:409, to_retire:409, retired:409 },
      disk_unmount: { in_service:200, in_depot:200, faulty:200, to_retire:200, retired:409 },
      disk_swap:    { in_service:200, in_depot:409, faulty:409, to_retire:409, retired:409 },
      disk_move:    { in_service:200, in_depot:409, faulty:409, to_retire:409, retired:409 },
    };
    for (const action of diskActions) {
      for (const [state, expected] of Object.entries(D2_DISK_MATRIX[action])) {
        const f = await dFixture('disk_mount');
        await rawRun('UPDATE it_assets SET status=? WHERE id=?', [state,f.disk]);
        f.body = await dBody(f,action);
        if (expected === 200) await dSuccess(`D2-${action}-散盘${state}`, f,action,f.body);
        else await dReject(`D2-${action}-散盘${state}`,f,action,f.body,expected,'ACTION_NOT_ALLOWED_IN_STATUS');
      }
      for (const [state, expected] of Object.entries(D2_HOST_MATRIX[action])) {
        const f = await dFixture(action);
        const hostId = action === 'disk_mount' ? f.target : f.source;
        if (state !== 'in_service') {
          await rawRun('UPDATE it_assets SET status=?,rack_id=NULL,u_start=NULL WHERE id=?',[state,hostId]);
          await rawRun('UPDATE it_assets SET status=? WHERE parent_asset_id=?',[state,hostId]);
        }
        f.body = await dBody(f,action);
        if (expected === 200) await dSuccess(`D2-${action}-宿主${state}`,f,action,f.body);
        else await dReject(`D2-${action}-宿主${state}`,f,action,f.body,expected,'ACTION_NOT_ALLOWED_IN_STATUS');
      }
      const wrong = await dFixture(action);
      await rawRun("UPDATE it_assets SET category='laptop' WHERE id=?",[wrong.disk]);
      await dReject(`D2-${action}-主体非disk`,wrong,action,wrong.body,400,'ACTION_NOT_APPLICABLE');
      const noHost = await dFixture(action);
      await rawRun('UPDATE it_assets SET slot_count=0 WHERE id=?',[action === 'disk_mount' ? noHost.target : noHost.source]);
      await dReject(`D2-${action}-零容量非宿主`,noHost,action,noHost.body,400,'ACTION_NOT_APPLICABLE');
    }
    const mounted = await dFixture('disk_swap');
    await dReject('D2-mount随装盘拒绝',mounted,'disk_mount',await dBody(mounted,'disk_mount'),409,'ACTION_NOT_ALLOWED_IN_STATUS');
    for (const state of ['faulty','to_retire','retired']) {
      const f = await dFixture('disk_swap'); await rawRun('UPDATE it_assets SET status=? WHERE id=?',[state,f.replacement]);
      await dReject(`D2-swap新盘${state}`,f,'disk_swap',f.body,409,'ACTION_NOT_ALLOWED_IN_STATUS');
    }
    for (const category of ['laptop','server']) {
      const f=await dFixture('disk_swap'); await rawRun('UPDATE it_assets SET category=? WHERE id=?',[category,f.replacement]);
      await dReject(`D2-swap新盘类别${category}`,f,'disk_swap',f.body,400,'ACTION_NOT_APPLICABLE');
    }
    {
      const f=await dFixture('disk_swap');
      await rawRun("UPDATE it_assets SET parent_asset_id=?,slot_no=3,status='in_service' WHERE id=?",[f.target,f.replacement]);
      await dReject('D2-swap新盘已随装',f,'disk_swap',f.body,409,'ACTION_NOT_ALLOWED_IN_STATUS');
    }

    currentCaseLabel='D3槽位及参数';
    for (const action of ['disk_mount','disk_move']) {
      const f=await dFixture(action);
      for (const slot of [undefined,null,0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1,5]) await dReject(`D3-${action}-slot=${slot}`,f,action,{...f.body,slot_no:slot},400,'LEDGER_BAD_REQUEST');
      for (const id of [undefined,null,0,'1',999999]) await dReject(`D3-${action}-target=${id}`,f,action,{...f.body,parent_asset_id:id},400,'LEDGER_BAD_REQUEST');
      const occupied=await dDisk(f.target,2); f.ids.push(occupied); f.body=await dBody(f,action);
      await dReject(`D3-${action}-已占槽`,f,action,f.body,409,'SLOT_OCCUPIED');
      for (const slot of [1,3,4]) f.ids.push(await dDisk(f.target,slot));
      f.body=await dBody(f,action);
      await dReject(`D3-${action}-满槽`,f,action,f.body,409,'SLOT_OCCUPIED');
      const edge=await dFixture(action); await dSuccess(`D3-${action}-最大合法槽4`,edge,action,{...edge.body,slot_no:4});
    }
    for (const action of ['disk_unmount','disk_swap']) {
      const f=await dFixture(action);
      for (const to of [undefined,null,'in_service','retired','active',1]) await dReject(`D3-${action}-to=${to}`,f,action,{...f.body,to},400,'LEDGER_BAD_REQUEST');
      if (action==='disk_unmount') await dReject('D3-unmount禁止to_retire',f,action,{...f.body,to:'to_retire'},400,'LEDGER_BAD_REQUEST');
      for (const to of action==='disk_swap'?['in_depot','faulty','to_retire']:['in_depot','faulty']) {
        const good=await dFixture(action); await dSuccess(`D4-${action}-去向${to}`,good,action,{...good.body,to});
      }
    }
    {
      const f=await dFixture('disk_swap');
      for(const id of [undefined,null,0,'1',999999]) await dReject(`D3-swap新盘id=${id}`,f,'disk_swap',{...f.body,new_disk_id:id},400,'LEDGER_BAD_REQUEST');
      await dReject('D3-swap不能自换',f,'disk_swap',{...f.body,new_disk_id:f.disk},409,'NO_OP_TRANSITION');
      await dReject('D3-move不能同宿主',f,'disk_move',{expected_version:1,parent_asset_id:f.source,slot_no:2,peer_versions:{[f.source]:(await dRow(f.source)).version}},409,'NO_OP_TRANSITION');
      await rawRun('UPDATE it_assets SET parent_asset_id=999999 WHERE id=?',[f.disk]);
      await dReject('D3-源宿主引用缺失',f,'disk_unmount',{expected_version:1,to:'faulty',peer_versions:{999999:1}},500,'LEDGER_INTERNAL');
    }

    currentCaseLabel='D5精确载荷';
    const D5_PAYLOAD_TABLE = {
      disk_mount:{primary:['parent_asset_id','slot_no','status'],affected:['disk_id','slot_no']},
      disk_unmount:{primary:['parent_asset_id','slot_no','status'],affected:['disk_id','slot_no']},
      disk_swap:{primary:['parent_asset_id','slot_no','status'],affected:{disk:['parent_asset_id','slot_no','status'],host:['disk_id','slot_no']}},
      disk_move:{primary:['parent_asset_id','slot_no'],affected:['disk_id','slot_no']},
    };
    for(const action of diskActions) {
      const actual=itLedgerModule._internals.PAYLOAD_KEYS[action]; const want=D5_PAYLOAD_TABLE[action];
      check(`D5-${action}-primary集合全等`,equal([...actual.primary].sort(),want.primary));
      if(action==='disk_swap') for(const kind of ['disk','host']) check(`D5-swap-${kind}集合全等`,equal([...actual.affected[kind]].sort(),want.affected[kind]));
      else check(`D5-${action}-affected集合全等`,equal([...actual.affected].sort(),want.affected));
    }
    {
      const f=await dFixture('disk_swap');
      const triple={status:'in_depot',parent_asset_id:null,slot_no:null}; const pair={slot_no:1,disk_id:null};
      const bad=[
        ['宿主用盘载荷',f.source,'affected',triple,triple],['盘用宿主载荷',f.replacement,'affected',pair,pair],
        ['五键并集',f.source,'affected',{...triple,...pair},{...triple,...pair}],
        ['空载荷',f.source,'affected',{},{}],['缺键',f.source,'affected',{slot_no:1},pair],
        ['多键',f.source,'affected',{...pair,x:1},pair],['双侧异构',f.source,'affected',pair,triple],
        ['primary错误类别',f.source,'primary',triple,triple],
      ];
      for(const [label,id,role,from,to] of bad) {
        const allEvents=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
        let error;
        await assertNoSideEffect(`D5-${label}`,f.ids,async()=>{
          try { await itLedgerModule._internals.withWrite(q=>itLedgerModule._internals.writeEvent(q,{op_id:uniq('bad-event'),asset_id:id,action:'disk_swap',role,related_asset_id:role==='primary'?null:f.disk,from_state:from,to_state:to,operator_id:1})); }
          catch(e){ error=e; }
        });
        check(`D5-${label}:500 LEDGER_INTERNAL`,error&&error.status===500&&error.code==='LEDGER_INTERNAL',error&&error.message);
        check(`D5-${label}:全事件表不变`,equal(allEvents,await rawAll('SELECT * FROM it_asset_events ORDER BY id')));
      }
    }

    currentCaseLabel = 'D6并发';
    async function dOrdered(label, first, second) {
      const internals = itLedgerModule._internals;
      let release; const gate = new Promise((resolve) => { release = resolve; });
      const arrived = internals.setTxnMidGate(gate);
      let a; let b;
      try {
        a = first(); await awaitArrived(arrived, `${label}-首请求到达`, a);
        b = second();
        await waitForCondition(() => internals.itTxnMutex._internals.waiterCount() >= 1, `${label}-次请求已排队`, 3000);
        check(`${label}: 次请求进入mutex队列`, internals.itTxnMutex._internals.waiterCount() >= 1);
        internals.setTxnMidGate(null); release();
        return await Promise.all([a,b]);
      } finally {
        internals.setTxnMidGate(null); release();
        await Promise.allSettled([a,b].filter(Boolean));
      }
    }
    async function dConcurrentSnapshot(label, f, before, beforeEvents, winner, expected, changedFields) {
      await assertEventSet(label, winner.body.op_id, expected);
      const after = await snapshotAssets(f.ids);
      for (const row of before) {
        const next = after.find((r) => r.id === row.id);
        const fields = changedFields.get(row.id);
        check(`${label}: 竞争后完整行${row.id}`, equal(next, fields ? {...row,...fields,version:row.version+1,updated_at:next.updated_at} : row), JSON.stringify(next));
      }
      const events = await rawAll('SELECT * FROM it_asset_events ORDER BY id');
      check(`${label}: 既有事件原文不变`, equal(events.slice(0,beforeEvents.length), beforeEvents));
      check(`${label}: 只有成功方事件且行数精确`,events.length === beforeEvents.length+1+expected.affected.length && events.slice(beforeEvents.length).every((e)=>e.op_id===winner.body.op_id));
    }
    {
      const f=await dFixture('disk_mount'); const second=f.replacement;
      const before=await snapshotAssets(f.ids); const events=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
      const [a,b]=await dOrdered('D6同slot',()=>actionAdmin(f.disk,'disk_mount',f.body),()=>actionAdmin(second,'disk_mount',{...f.body,expected_version:1}));
      check('D6同slot: 恰一200一409 VERSION_CONFLICT',a.status===200&&b.status===409&&b.body.code==='VERSION_CONFLICT',JSON.stringify({a,b}));
      const expected=dExpected(f,'disk_mount',before,f.body);
      await dConcurrentSnapshot('D6同slot',f,before,events,a,expected,new Map([[f.disk,expected.primary.to],[f.target,{}]]));
    }
    for (const order of ['mount先','rack_out先']) {
      const f=await dFixture('disk_mount'); const host=await dRow(f.target);
      const before=await snapshotAssets(f.ids); const events=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
      const mount=()=>actionAdmin(f.disk,'disk_mount',f.body);
      const out=()=>actionAdmin(f.target,'rack_out',{expected_version:host.version});
      const [a,b]=await dOrdered(`D6-${order}`,order==='mount先'?mount:out,order==='mount先'?out:mount);
      check(`D6-${order}: 首200次409 VERSION_CONFLICT`,a.status===200&&b.status===409&&b.body.code==='VERSION_CONFLICT',JSON.stringify({a,b}));
      const expected=order==='mount先'?dExpected(f,'disk_mount',before,f.body):{
        action:'rack_out',operator_id:1,primary:{assetId:f.target,from:{status:'in_service',rack_id:host.rack_id,u_start:host.u_start},to:{status:'in_depot',rack_id:null,u_start:null}},affected:[]};
      const changed=order==='mount先'?new Map([[f.disk,expected.primary.to],[f.target,{}]]):new Map([[f.target,expected.primary.to]]);
      await dConcurrentSnapshot(`D6-${order}`,f,before,events,a,expected,changed);
      const disk=await dRow(f.disk); const afterHost=await dRow(f.target);
      check(`D6-${order}: 终态状态一致且装载关系正确`,disk.status===afterHost.status && disk.parent_asset_id===(order==='mount先'?f.target:null));
      if(order==='rack_out先') await dReject('D6-下架后用新peer仍不可装',f,'disk_mount',{...f.body,peer_versions:{[f.target]:afterHost.version}},409,'ACTION_NOT_ALLOWED_IN_STATUS');
      else {
        const r=await actionAdmin(f.target,'rack_out',{expected_version:afterHost.version});
        check('D6-mount后刷新再rack_out成功',r.status===200,JSON.stringify(r));
        await assertEventSet('D6-mount后刷新rack_out',r.body.op_id,{action:'rack_out',operator_id:1,primary:{assetId:f.target,from:{status:'in_service',rack_id:host.rack_id,u_start:1},to:{status:'in_depot',rack_id:null,u_start:null}},affected:[{assetId:f.disk,from:{status:'in_service'},to:{status:'in_depot'}}]});
        check('D6-mount后下架子盘跟随', (await dRow(f.disk)).status==='in_depot' && (await dRow(f.target)).status==='in_depot');
      }
    }
    {
      const f=await dFixture('disk_mount');
      const r=await assertNoSideEffect('D1排队撤权',f.ids,async()=>{
        const internals=itLedgerModule._internals;
        let release;const gate=new Promise(resolve=>{release=resolve;});
        const arrived=internals.setTxnMidGate(gate);let blocker;let request;
        try {
          blocker=internals.withWrite(async q=>{await q.run('DELETE FROM it_asset_acl WHERE user_id=2');});
          await awaitArrived(arrived,'D1撤权阻塞事务到达',blocker);
          request=actionAs(2,'user',f.disk,'disk_mount',f.body);
          await waitForCondition(()=>internals.itTxnMutex._internals.waiterCount()>=1,'D1撤权请求排队');
          internals.setTxnMidGate(null);release();await blocker;return await request;
        } finally {internals.setTxnMidGate(null);release();await Promise.allSettled([blocker,request].filter(Boolean));}
      });
      check('D1排队撤权:403 LEDGER_FORBIDDEN',r.status===403&&r.body.code==='LEDGER_FORBIDDEN',JSON.stringify(r));
      const grant=await api('PUT','/api/it-assets/acl/2',{uid:1,role:'admin',body:{level:'write'}});
      check('D1排队撤权:恢复ACL成功',grant.status===200||grant.status===201,JSON.stringify(grant));
    }

    currentCaseLabel='D8库房拆盘出口';
    for(const state of ['in_depot','faulty','to_retire']) {
      const f=await dFixture('disk_unmount');
      const out=await actionAdmin(f.source,'rack_out',{expected_version:(await dRow(f.source)).version,to:state});
      check(`D8-${state}:rack_out成功`,out.status===200,JSON.stringify(out));
      f.body=await dBody(f,'disk_unmount');await dSuccess(`D8-${state}-unmount`,f,'disk_unmount',f.body);
      for(const id of [f.disk,f.sibling]) {
        let disk=await dRow(id);
        if(id===f.sibling) {
          const body={expected_version:disk.version,to:'faulty',peer_versions:{[f.source]:(await dRow(f.source)).version}};
          const oldF={...f,disk:id};await dSuccess(`D8-${state}-拆完兄弟盘`,oldF,'disk_unmount',body);disk=await dRow(id);
        }
        const mark=await actionAdmin(id,'mark_status',{expected_version:disk.version,status:'to_retire'});
        check(`D8-${state}-${id}:mark_status成功`,mark.status===200,JSON.stringify(mark));
        await assertEventSet(`D8-${state}-${id}-mark`,mark.body.op_id,{action:'mark_status',operator_id:1,primary:{assetId:id,from:{status:'faulty'},to:{status:'to_retire'}},affected:[]});
        const retire=await actionAdmin(id,'retire',{expected_version:disk.version+1});
        check(`D8-${state}-${id}:retire成功`,retire.status===200,JSON.stringify(retire));
        await assertEventSet(`D8-${state}-${id}-retire`,retire.body.op_id,{action:'retire',operator_id:1,primary:{assetId:id,from:{status:'to_retire'},to:{status:'retired'}},affected:[]});
        const final=await dRow(id);check(`D8-${state}-${id}:落库retired且version+2`,final.status==='retired'&&final.version===disk.version+2&&final.parent_asset_id===null);
      }
      let host=await dRow(f.source);
      if(state!=='to_retire') { const r=await actionAdmin(f.source,'mark_status',{expected_version:host.version,status:'to_retire'});check(`D8-${state}-空宿主待退役`,r.status===200,JSON.stringify(r)); }
      host=await dRow(f.source);
      const r=await actionAdmin(f.source,'retire',{expected_version:host.version});check(`D8-${state}-空宿主retire`,r.status===200,JSON.stringify(r));
      check(`D8-${state}-空宿主真实退役`,(await dRow(f.source)).status==='retired');
    }

    currentCaseLabel='D7活体变异';
    function dMutate(src,pattern,replacement,label) {
      const hits=src.match(pattern)||[];
      if(hits.length!==1) throw new Error(`${label}: expected one mutation target, got ${hits.length}`);
      return src.replace(pattern,replacement);
    }
    async function dMutantFixture(call,dbPath,label) {
      const admin={uid:1,role:'admin'};
      const create=async(url,body)=>{
        const r=await call('POST',url,{...admin,body});check(`${label}:创建201`,r.status===201,JSON.stringify(r));
        if(r.status!==201) throw new Error(`${label}: bad fixture`);return r.body.id;
      };
      const rack=await create('/api/it-assets/racks',{name:uniq('M-rack'),u_total:10});
      const host=await create('/api/it-assets',{category:'server',name:uniq('M-host'),u_height:2,slot_count:4,placement:{kind:'rack',rack_id:rack,u_start:1}});
      const disk=await create('/api/it-assets',{category:'disk',name:uniq('M-disk'),placement:{kind:'depot',status:'in_depot'}});
      const second=await create('/api/it-assets',{category:'disk',name:uniq('M-second'),placement:{kind:'depot',status:'in_depot'}});
      const ids=[host,disk,second];const before=await snapshotAssetsFrom(dbPath,ids);
      check(`${label}:夹具快照三行非空`,before.length===3&&before.every(Boolean));
      return {host,disk,second,ids,before,body:{expected_version:1,parent_asset_id:host,slot_no:1,peer_versions:{[host]:1}},act:(id,body)=>call('POST',`/api/it-assets/${id}/actions/disk_mount`,{...admin,body})};
    }
    async function dMutantNoEffect(label,dbPath,ids,fn,status,code) {
      const before=await snapshotAssetsFrom(dbPath,ids);const events=await rawAllAt(dbPath,'SELECT * FROM it_asset_events ORDER BY id');
      const r=await fn();
      check(`${label}:精确${status}/${code}`,r.status===status&&r.body.code===code,JSON.stringify(r));
      check(`${label}:完整行回滚`,equal(before,await snapshotAssetsFrom(dbPath,ids)));
      check(`${label}:完整事件回滚`,equal(events,await rawAllAt(dbPath,'SELECT * FROM it_asset_events ORDER BY id')));return r;
    }
    function dMountExpectation(f,disk,slot) {return {action:'disk_mount',operator_id:1,primary:{assetId:disk,from:{status:'in_depot',parent_asset_id:null,slot_no:null},to:{status:'in_service',parent_asset_id:f.host,slot_no:slot}},affected:[{assetId:f.host,from:{slot_no:slot,disk_id:null},to:{slot_no:slot,disk_id:disk}}]};}
    for(const mutant of [false,true]) {
      const scenario=async(call,dbPath)=>{
        const label=`D7①-${mutant?'变异':'干净'}`;const f=await dMutantFixture(call,dbPath,label);
        const first=await f.act(f.disk,f.body);check(`${label}:第一笔200`,first.status===200,JSON.stringify(first));
        await assertEventSetFrom(dbPath,`${label}-第一笔事件`,first.body.op_id,dMountExpectation(f,f.disk,1));
        const secondBody={...f.body,slot_no:2};
        if(!mutant) await dMutantNoEffect(`${label}-陈旧peer`,dbPath,f.ids,()=>f.act(f.second,secondBody),409,'VERSION_CONFLICT');
        else {
          const r=await f.act(f.second,secondBody);check(`${label}:陈旧peer错误放行200`,r.status===200,JSON.stringify(r));
          await assertEventSetFrom(dbPath,`${label}-第二笔事件`,r.body.op_id,dMountExpectation(f,f.second,2));
          const rows=await snapshotAssetsFrom(dbPath,f.ids);const host=rows.find(x=>x.id===f.host);
          check(`${label}:宿主版本未递增=1`,host.version===1);
          for(const [id,slot]of [[f.disk,1],[f.second,2]]) {const row=rows.find(x=>x.id===id);check(`${label}:盘${id}真实落库`,row.status==='in_service'&&row.parent_asset_id===f.host&&row.slot_no===slot&&row.version===2);}
        }
      };
      if(mutant)await withC4MutatedIndexModule(src=>dMutate(src,/^.*await q\.run\([^\n]+\/\/ C4_HOST_VERSION\r?$/gm,'      // C4_HOST_VERSION removed','D7①'),scenario,'D7①');
      else await scenario(api,TEST_DB);
    }
    for(const mutant of [false,true]) {
      const scenario=async(call,dbPath)=>{
        const label=`D7②-${mutant?'变异':'干净'}`;const f=await dMutantFixture(call,dbPath,label);
        const trigger=`d7_slot_${f.disk}`;
        await rawRunAt(dbPath,`CREATE TRIGGER ${trigger} AFTER UPDATE OF parent_asset_id ON it_assets WHEN NEW.id=${f.disk} AND NEW.parent_asset_id=${f.host} BEGIN UPDATE it_assets SET slot_count=0 WHERE id=${f.host}; END`);
        try {
          if(!mutant)await dMutantNoEffect(label,dbPath,f.ids,()=>f.act(f.disk,f.body),409,'SLOT_COUNT_BELOW_OCCUPIED');
          else {
            const r=await f.act(f.disk,f.body);check(`${label}:脏写被错误放行200`,r.status===200,JSON.stringify(r));
            await assertEventSetFrom(dbPath,`${label}-事件`,r.body.op_id,dMountExpectation(f,f.disk,1));
            const rows=await snapshotAssetsFrom(dbPath,f.ids);const host=rows.find(x=>x.id===f.host);const disk=rows.find(x=>x.id===f.disk);
            check(`${label}:宿主脏容量0且version2`,host.slot_count===0&&host.version===2);
            check(`${label}:盘真实装入且version2`,disk.parent_asset_id===f.host&&disk.slot_no===1&&disk.status==='in_service'&&disk.version===2);
          }
        } finally {await rawRunAt(dbPath,`DROP TRIGGER ${trigger}`);}
      };
      if(mutant)await withC4MutatedIndexModule(src=>dMutate(src,/^.*validateDiskActionRows\(rows, childrenByHost, hostContexts\); \/\/ C4_REREAD_VALIDATE\r?$/gm,'    // C4_REREAD_VALIDATE removed','D7②'),scenario,'D7②');
      else await scenario(api,TEST_DB);
    }
    for(const mutant of [false,true]) {
      const scenario=async(call,dbPath)=>{
        const label=`D7③-${mutant?'变异':'干净'}`;const f=await dMutantFixture(call,dbPath,label);
        const r=await f.act(f.disk,f.body);check(`${label}:请求200`,r.status===200,JSON.stringify(r));
        const expect=dMountExpectation(f,f.disk,1);
        if(!mutant)await assertEventSetFrom(dbPath,label,r.body.op_id,expect);
        else {
          const rows=await rawAllAt(dbPath,'SELECT * FROM it_asset_events WHERE op_id=? ORDER BY id',[r.body.op_id]);
          const recorded=[];await assertEventSetCore(rows,label,r.body.op_id,expect,(name,ok)=>recorded.push({name,ok}));
          const expectedFailures=['总行数','role集合','affected的asset_id集合','确实存在'];
          const failures=recorded.filter(x=>!x.ok);
          const verdict={ok:failures.length===4,hitTarget:failures.some(x=>x.name.includes('总行数')),otherErr:failures.filter(x=>!expectedFailures.some(n=>x.name.includes(n)))};
          check(`${label}:事件助手目标断言变红且无他错`,verdict.ok&&verdict.hitTarget&&verdict.otherErr.length===0,JSON.stringify({verdict,failures}));
          const disk=await rawGetAt(dbPath,'SELECT * FROM it_assets WHERE id=?',[f.disk]);const host=await rawGetAt(dbPath,'SELECT * FROM it_assets WHERE id=?',[f.host]);
          check(`${label}:资产仍实际写入盘+宿主各version2`,disk.parent_asset_id===f.host&&disk.slot_no===1&&disk.status==='in_service'&&disk.version===2&&host.version===2);
        }
      };
      if(mutant)await withC4MutatedIndexModule(src=>dMutate(src,/      await writeEvent\(q, \{ \/\/ C4_HOST_EVENT_BEGIN[\s\S]*?      \}\); \/\/ C4_HOST_EVENT_END/g,'      // C4_HOST_EVENT removed','D7③'),scenario,'D7③');
      else await scenario(api,TEST_DB);
    }

    currentCaseLabel='D9回滚与读隔离';
    for (const action of diskActions) {
      const f=await dFixture(action);const trigger=`d9_fail_${f.disk}`;
      await rawRun(`CREATE TRIGGER ${trigger} BEFORE INSERT ON it_asset_events WHEN NEW.action='${action}' AND NEW.role='affected' BEGIN SELECT RAISE(ABORT,'D9 event failure'); END`);
      try {await dReject(`D9-${action}-事件失败`,f,action,f.body,500,'LEDGER_INTERNAL');}
      finally {await rawRun(`DROP TRIGGER ${trigger}`);}
    }
    // SQL 句柄外层替身：第一条 UPDATE 已执行但回调暂不交还，精确卡在两次 UPDATE 之间。
    for (const rollback of [false,true]) {
      const label=`D9读隔离-${rollback?'回滚':'提交'}`;const f=await dFixture('disk_swap');
      const conn=itLedgerModule._internals.getDbIdentity();const originalRun=conn.run;
      let arrivedResolve;const arrived=new Promise(r=>{arrivedResolve=r;});
      let release;const gate=new Promise(r=>{release=r;});let held=false;
      let write;let read;let readSettled=false;
      const before=await snapshotAssets(f.ids);const events=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
      const trigger=`d9_read_${f.disk}`;
      if(rollback)await rawRun(`CREATE TRIGGER ${trigger} BEFORE INSERT ON it_asset_events WHEN NEW.action='disk_swap' AND NEW.role='affected' BEGIN SELECT RAISE(ABORT,'D9 rollback'); END`);
      conn.run=function(sql,params,callback){
        if(!held && /^UPDATE it_assets SET status = \?, parent_asset_id = NULL/.test(sql)) {
          held=true;
          return originalRun.call(this,sql,params,function(error){
            const context=this;
            if(error){callback.call(context,error);return;}
            arrivedResolve();
            gate.then(()=>callback.call(context,null));
          });
        }
        return originalRun.call(this,sql,params,callback);
      };
      try {
        const operation=async()=>{
          write=actionAdmin(f.disk,'disk_swap',f.body);
          await awaitArrived(arrived,label,write);
          read=api('GET',`/api/it-assets/${f.disk}`,{uid:1,role:'admin'}).then(r=>{readSettled=true;return r;});
          await waitForCondition(()=>itLedgerModule._internals.itTxnMutex._internals.waiterCount()>=1,`${label}-读排队`);
          check(`${label}: 外部读在mutex排队且未返回`,!readSettled&&itLedgerModule._internals.itTxnMutex._internals.waiterCount()>=1);
          release();return await write;
        };
        const r=rollback?await assertNoSideEffect(label,f.ids,operation):await operation();
        const view=await read;check(`${label}: GET=200`,view.status===200,JSON.stringify(view));
        if(rollback) {
          check(`${label}: 写返回500 LEDGER_INTERNAL`,r.status===500&&r.body.code==='LEDGER_INTERNAL',JSON.stringify(r));
          check(`${label}: 读到原始完整资产`,equal(view.body.asset,itLedgerModule._internals.parseAssetRow(before.find(x=>x.id===f.disk))));
          check(`${label}: 全事件表回滚`,equal(events,await rawAll('SELECT * FROM it_asset_events ORDER BY id')));
        } else {
          check(`${label}: 写200`,r.status===200,JSON.stringify(r));
          const final=await dRow(f.disk);
          check(`${label}: 读到完整提交资产`,equal(view.body.asset,itLedgerModule._internals.parseAssetRow(final)));
          const expected=dExpected(f,'disk_swap',before,f.body);
          await dConcurrentSnapshot(label,f,before,events,r,expected,new Map([[f.disk,expected.primary.to],[f.replacement,expected.affected[0].to],[f.source,{}]]));
        }
      } finally {
        release();await Promise.allSettled([write,read].filter(Boolean));conn.run=originalRun;
        if(rollback)await rawRun(`DROP TRIGGER ${trigger}`);
      }
    }
    // 持 SHARED 读事务迫使 delete 模式 COMMIT 忙；不以 BEGIN 忙替代目标路径。
    {
      const f=await dFixture('disk_move');let reader;
      const sql=(statement,params=[])=>new Promise((resolve,reject)=>reader.run(statement,params,error=>error?reject(error):resolve()));
      const read=(statement)=>new Promise((resolve,reject)=>reader.get(statement,(error,row)=>error?reject(error):resolve(row)));
      try {
        reader=await new Promise((resolve,reject)=>{const db=new sqlite3.Database(TEST_DB,sqlite3.OPEN_READONLY,error=>error?reject(error):resolve(db));});
        const mode=await read('PRAGMA journal_mode');check('D9-COMMIT忙:delete模式',mode.journal_mode==='delete',JSON.stringify(mode));
        await sql('BEGIN');const probe=await read('SELECT COUNT(*) AS n FROM it_assets');check('D9-COMMIT忙:SHARED真实读非空',probe.n>0);
        await itLedgerModule._internals.setBusyTimeout(100);
        itLedgerModule._internals.clearConnTrace();
        await dReject('D9-COMMIT忙整笔回滚',f,'disk_move',f.body,503,'LEDGER_BUSY');
        const trace=itLedgerModule._internals.getConnTrace();
        check('D9-COMMIT忙:确实到达COMMIT并ROLLBACK',trace.some(t=>t.sql==='COMMIT')&&trace.some(t=>t.sql==='ROLLBACK'),JSON.stringify(trace));
      } finally {
        if(reader){try{await sql('ROLLBACK');}finally{await new Promise((resolve,reject)=>reader.close(error=>error?reject(error):resolve()));}}
        await itLedgerModule._internals.setBusyTimeout(5000);
      }
    }
    // 短暂跨连接写竞争：收到 BEGIN 的到达信号后释放另一连接，双方真实提交。
    {
      const f=await dFixture('disk_mount');let external;
      const run=(sql,params=[])=>new Promise((resolve,reject)=>external.run(sql,params,error=>error?reject(error):resolve()));
      const conn=itLedgerModule._internals.getDbIdentity();const originalRun=conn.run;
      let arrive;const arrived=new Promise(resolve=>{arrive=resolve;});let pending;
      try {
        external=await new Promise((resolve,reject)=>{const db=new sqlite3.Database(TEST_DB,error=>error?reject(error):resolve(db));});
        await run('BEGIN IMMEDIATE');await run("UPDATE it_assets SET note='external committed' WHERE id=?",[f.sibling]);
        conn.run=function(sql,params,callback){if(sql==='BEGIN IMMEDIATE')arrive();return originalRun.call(this,sql,params,callback);};
        const before=await snapshotAssets(f.ids);const expected=dExpected(f,'disk_mount',before,f.body);
        pending=actionAdmin(f.disk,'disk_mount',f.body);await awaitArrived(arrived,'D9短竞争到达BEGIN',pending);
        await run('COMMIT');const r=await pending;
        check('D9短竞争:台账请求200',r.status===200,JSON.stringify(r));
        await assertEventSet('D9短竞争-事件',r.body.op_id,expected);
        const disk=await dRow(f.disk);const host=await dRow(f.target);const sibling=await dRow(f.sibling);
        check('D9短竞争:两连接写入各自落库',disk.parent_asset_id===f.target&&disk.version===2&&host.version===2&&sibling.note==='external committed');
      } finally {
        conn.run=originalRun;
        if(external){try{await run('ROLLBACK');}catch(error){if(!/no transaction/i.test(error.message))throw error;}finally{await new Promise((resolve,reject)=>external.close(error=>error?reject(error):resolve()));}}
        await Promise.allSettled([pending].filter(Boolean));
      }
    }
    // D2 笛卡尔矩阵：每行对应盘形态，每列对应宿主状态；期望值独立手写。
    currentCaseLabel = 'D2盘形态×宿主状态完整矩阵';
    const D2_HOST_STATES = ['in_service','in_depot','faulty','to_retire','retired'];
    const D2_CROSS_MATRIX = {
      disk_mount: {
        loose_in_depot:[200,409,409,409,409], loose_faulty:[409,409,409,409,409],
        loose_to_retire:[409,409,409,409,409], loose_retired:[409,409,409,409,409], mounted:[409,409,409,409,409],
      },
      disk_unmount: {
        loose_in_depot:[409,409,409,409,409], loose_faulty:[409,409,409,409,409],
        loose_to_retire:[409,409,409,409,409], loose_retired:[409,409,409,409,409], mounted:[200,200,200,200,409],
      },
      disk_swap: {
        loose_in_depot:[409,409,409,409,409], loose_faulty:[409,409,409,409,409],
        loose_to_retire:[409,409,409,409,409], loose_retired:[409,409,409,409,409], mounted:[200,409,409,409,409],
      },
      disk_move: {
        loose_in_depot:[409,409,409,409,409], loose_faulty:[409,409,409,409,409],
        loose_to_retire:[409,409,409,409,409], loose_retired:[409,409,409,409,409], mounted:[200,409,409,409,409],
      },
    };
    for (const action of diskActions) {
      for (const [form, expectedStates] of Object.entries(D2_CROSS_MATRIX[action])) {
        for (let column=0; column<D2_HOST_STATES.length; column++) {
          const hostState=D2_HOST_STATES[column];
          const f=await dFixture(form==='mounted'?'disk_swap':'disk_mount');
          if(form!=='mounted')await rawRun('UPDATE it_assets SET status=? WHERE id=?',[form.slice(6),f.disk]);
          const hostId=action==='disk_mount'?f.target:f.source;
          if(hostState!=='in_service') {
            await rawRun('UPDATE it_assets SET status=?,rack_id=NULL,u_start=NULL WHERE id=?',[hostState,hostId]);
            await rawRun('UPDATE it_assets SET status=? WHERE parent_asset_id=?',[hostState,hostId]);
          }
          const body=await dBody(f,action);const label=`D2交叉-${action}-${form}-${hostState}`;
          if(expectedStates[column]===200)await dSuccess(label,f,action,body);
          else await dReject(label,f,action,body,409,'ACTION_NOT_ALLOWED_IN_STATUS');
        }
      }
    }
    for (const state of ['in_depot','faulty','to_retire','retired']) {
      const f=await dFixture('disk_move');
      await rawRun('UPDATE it_assets SET status=?,rack_id=NULL,u_start=NULL WHERE id=?',[state,f.target]);
      await dReject(`D2-move目标${state}`,f,'disk_move',f.body,409,'ACTION_NOT_ALLOWED_IN_STATUS');
    }
    for(const action of diskActions) {
      const f=await dFixture(action);
      // 宿主整体校验看不到兄弟盘自己的 u_height，必须靠逐盘真实行校验才能拒绝。
      await rawRun('UPDATE it_assets SET u_height=3 WHERE id=?',[f.sibling]);
      if(action==='disk_mount') {
        const bad=await dDisk(f.target,4);f.ids.push(bad);
        await rawRun('UPDATE it_assets SET u_height=3 WHERE id=?',[bad]);f.body=await dBody(f,action);
      }
      await dReject(`D2-${action}-兄弟盘脏u_height`,f,action,f.body,400,'LEDGER_BAD_REQUEST');
      const missing=await dFixture(action);missing.disk=999999; // 不存在主资产，仍快照原完整参与集合。
      await dReject(`D1-${action}-主资产不存在`,missing,action,missing.body,404,'LEDGER_NOT_FOUND');
    }
    // 目标类型不靠 slot_count 单值猜测；合法 other 宿主亦须可用。
    for(const action of ['disk_mount','disk_move']) {
      const f=await dFixture(action);
      await rawRun("UPDATE it_assets SET category='laptop' WHERE id=?",[f.target]);
      await dReject(`D2-${action}-目标类别非宿主`,f,action,f.body,400,'ACTION_NOT_APPLICABLE');
      const other=await dFixture(action);
      await rawRun("UPDATE it_assets SET category='other' WHERE id=?",[other.target]);
      await dSuccess(`D2-${action}-other宿主`,other,action,other.body);
    }

    currentCaseLabel='D5全动作载荷反例';
    for(const action of diskActions) {
      const f=await dFixture(action);
      const variants=[
        {role:'primary',id:f.disk,valid:action==='disk_move'?{parent_asset_id:f.source,slot_no:1}:{status:'in_depot',parent_asset_id:null,slot_no:null}},
        {role:'affected',id:f.source,valid:{slot_no:1,disk_id:f.disk}},
      ];
      if(action==='disk_swap')variants.push({role:'affected',id:f.replacement,valid:{status:'in_depot',parent_asset_id:null,slot_no:null}});
      for(const v of variants) {
        const missing={...v.valid};delete missing.slot_no;
        for(const [kind,bad] of [['少键',missing],['多键',{...v.valid,extra:1}],['空对象',{}]]) {
          for(const side of ['from','to']) {
            const label=`D5-${action}-${v.id}-${v.role}-${side}-${kind}`;let error;
            const events=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
            await assertNoSideEffect(label,f.ids,async()=>{
              try {
                await itLedgerModule._internals.withWrite(q=>itLedgerModule._internals.writeEvent(q,{
                  op_id:uniq('invalid-c4-event'),asset_id:v.id,action,role:v.role,related_asset_id:v.role==='primary'?null:f.disk,
                  from_state:side==='from'?bad:v.valid,to_state:side==='to'?bad:v.valid,operator_id:1,
                }));
              }catch(e){error=e;}
            });
            check(`${label}:500 LEDGER_INTERNAL`,error&&error.status===500&&error.code==='LEDGER_INTERNAL',error&&error.message);
            check(`${label}:全事件表不变`,equal(events,await rawAll('SELECT * FROM it_asset_events ORDER BY id')));
          }
        }
      }
    }

    currentCaseLabel='D10错误码及新增范围';
    check('D10-C4观测错误码闭集', [...observedCodes].every(code=>itLedgerModule._internals.WRITE_ERROR_CODES.has(code)),JSON.stringify([...observedCodes]));
    check('D10-ACTION_ERROR_CODES仍为已追认六码全等',equal([...itLedgerModule._internals.ACTION_ERROR_CODES].sort(),['UNKNOWN_ACTION','ACTION_NOT_APPLICABLE','ACTION_NOT_ALLOWED_IN_STATUS','NO_OP_TRANSITION','MOUNTED_DISK_ACTION_FORBIDDEN','RETIRE_BLOCKED_BY_DISKS'].sort()));



    // ============================================================
    // N10. 错误码闭集（先运行独立C5用例，全部观测码进入同一闭集核验）
    // ============================================================
    currentCaseLabel = 'C5九个单资产动作';
    await require('./verify-it-ledger-c5-cases')({ api, check, itLedgerModule, TEST_DB, rawAll, rawGet, rawRun, rawAllAt, rawGetAt, rawRunAt, assertNoSideEffect, assertEventSet, assertEventSetFrom, snapshotAssets, withTimeout, awaitArrived, waitForCondition, seedUsers, fakeAuthenticateToken, fakeRequireAdmin, logger });
    currentCaseLabel = 'C6自检盘点'; await require('./verify-it-ledger-c6-cases')({ check, rawAllAt, rawGetAt, rawRunAt, withTimeout, awaitArrived, waitForCondition, seedUsers, fakeAuthenticateToken, fakeRequireAdmin, logger, observedCodes, assertEventSetFrom });
    currentCaseLabel = 'N10组: 错误码闭集';
    {
      const WRITE_ERROR_CODES = itLedgerModule._internals.WRITE_ERROR_CODES;
      const ACTION_ERROR_CODES = itLedgerModule._internals.ACTION_ERROR_CODES;
      const badCodes = [...observedCodes].filter((c) => !WRITE_ERROR_CODES.has(c));
      check('N10-观测码⊆WRITE_ERROR_CODES闭集', badCodes.length === 0, `越界: ${JSON.stringify(badCodes)}`);
      const missing = [...ACTION_ERROR_CODES].filter((c) => !observedCodes.has(c));
      check('N10-ACTION_ERROR_CODES每码至少观测一次', missing.length === 0, `未命中: ${JSON.stringify(missing)}`);
    }

    } finally {
      currentCaseLabel = '收尾';
    }
  } catch (err) {
    check('main() 未捕获异常', false, err && (err.stack || err.message));
  }

  if (server) {
    try {
      await withTimeout(new Promise((resolve, reject) => { server.close((err) => (err ? reject(err) : resolve())); }), 5000, '收尾server.close');
      check('收尾: server.close()成功', true);
    } catch (e) { check('收尾: server.close()成功', false, e && e.message); }
  }
  if (itLedgerModule) {
    try { await withTimeout(itLedgerModule.shutdown(), 10000, '收尾shutdown'); check('收尾: itLedgerModule.shutdown()成功', true); }
    catch (e) { check('收尾: itLedgerModule.shutdown()成功', false, e && e.message); }
  }
  try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); check('收尾: 临时文件清理成功', true); }
  catch (e) { check('收尾: 临时文件清理成功', false, e && e.message); }

  clearTimeout(mainDeadlineTimer);
  console.log(results.join('\n'));
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[FATAL] main() 未捕获异常', err && (err.stack || err.message));
  console.log(results.join('\n'));
  console.log(`PASS=${pass} FAIL=${fail + 1}`);
  process.exit(1);
});
