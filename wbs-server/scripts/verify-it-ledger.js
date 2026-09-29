/**
 * C1 事务底座 verify · 信息化资产轻量台账（长任务 D）
 * 方案 docs/local/信息化资产_轻量版/信息化资产轻量台账_方案_20260918_v0.7.md §2.1–§2.7/§6/§9/§10
 * 执行 agent spec docs/local/信息化资产_轻量版/_agent_specs/C1_事务底座_spec.md §3
 *
 * 写法：起独立 express 实例挂本模块路由，临时 db 文件（非 :memory:——用例9 跨连接需要开第二个
 * 原生连接），伪造 authenticateToken（按请求头 x-test-user-id/x-test-user-role 注入 req.user）
 * 与 requireAdmin。14 条用例见方案/spec §3 逐条对应，每条至少一个 check() 行。
 *
 * 用法：node scripts/verify-it-ledger.js
 */
'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
if (process.argv.includes('--matrix')) process.exit(require('./verify-it-ledger-matrix').run());
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const TEST_DB = path.join(os.tmpdir(), `it-ledger-verify-${Date.now()}-${process.pid}.db`);

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`[OK] ${name}`); }
  else { fail++; results.push(`[FAIL] ${name}${detail ? ' · ' + String(detail) : ''}`); }
}

// T5（17-R4T 必修）：致命退出前打印当前 PASS/FAIL 汇总与 TEST_DB 路径——process.exit 会跳过
// main() 收尾的 console.log(results)/unlinkSync，不留痕就死等于没交代，留给人工排查的信息越
// 完整越好。
function fatalExit(label, detail) {
  check(label, false, detail);
  console.error(`[FATAL] ${label}${detail ? ' · ' + String(detail) : ''}——终止 verify 进程`);
  console.error(`[FATAL] 当前汇总 PASS=${pass} FAIL=${fail}`);
  console.error(`[FATAL] TEST_DB=${TEST_DB}（临时文件留待人工清理，本进程不再尝试删除）`);
  process.exit(1);
}

// T2（17-R4T HIGH 必修）：给任意 Promise 套超时——不改变正常 resolve/reject 的结果，只在超过
// ms 未 settle 时额外注入一次 reject。
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label}超时(>${ms}ms)`), { __timeout: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// T2：等待一个"到达"信号（openGateArrived/ddlBackoffArrived/txnMidGateArrived 等）的统一助手——
//   套 3s 超时（超时判致命退出，策略同 M2-②：继续跑后面用例的噪音远比一条 FAIL 更难排查）；
//   同时可选地观察触发该信号的操作本身是否提前失败（opPromise 提前 reject 说明流程根本没走到
//   闸这一步，测试前提就不成立，同样致命退出，而不是死等一个永远不会到达的信号）。opPromise
//   若正常 resolve 不参与竞速（用一个永不 settle 的 Promise 吞掉，只有 reject 才算"提前失败"）。
// T3（17-R5T M2 必修）：opPromise 的正常结束不再被静默吞掉——① 若 resolve 出的值是本文件约定
//   的结构化失败结果（{ok:false, ...}，各处 .then(v=>({ok:true,v}),e=>({ok:false,e})) 封装的
//   产物），视为"提前失败"立即报告，不等超时；② 若 resolve 出的是正常成功结果，说明操作根本
//   没走到预期闸门就已经结束（闸位置可能被改错、或时序假设整个不成立），同样立即报告，不等
//   3s 超时才发现"其实早就结束了"。
async function awaitArrived(arrivedPromise, label, opPromise) {
  const racers = [arrivedPromise.then(() => ({ kind: 'arrived' }))];
  if (opPromise) {
    racers.push(opPromise.then(
      // 17-R7T M④：结构化失败封装有两种历史写法并存——较新的 {ok:false, e/err} 与较早的
      // {__err: ...}——awaitArrived 必须两种都认得，否则旧写法产出的"提前失败"会被误判成
      // earlyDone（当成正常结束），掩盖真实的提前失败时序。
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
    return; // fatalExit 内部 process.exit(1)，这行不会真的执行到，纯粹让静态分析满意
  }
  if (result && result.kind === 'earlyFail') {
    fatalExit(`${label}: 对应操作在到达信号之前提前失败`, result.earlyFail && (result.earlyFail.stack || result.earlyFail.message));
  }
  if (result && result.kind === 'earlyDone') {
    fatalExit(`${label}: 对应操作在到达信号之前就已正常结束(未经过预期闸门，时序假设不成立)`, JSON.stringify(result.value));
  }
}


// T1（17-R4T HIGH 必修）：判定"某个 Promise 尚未 settle"的确定性调度屏障——两次 setImmediate
// （宏任务边界）能保证介于两次调用之间所有已经就绪的微任务（含目标 Promise 链路上真正会同步
// 完成的那部分）都已经跑完。不用 Promise.race([p.then(...), Promise.resolve(...)]) 这种哨兵
// 写法——链式 .then() 比裸 Promise.resolve() 多一轮微任务调度，会让"未完成"哨兵恒先 settle，
// 断言恒真，测不出真实时序（codex 17-R4T HIGH）。
async function schedulingBarrier() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ── 伪造鉴权中间件（按请求头注入 req.user，不校验真实 JWT）────────────────────────────
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
const logger = {
  info: () => {},
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};

async function seedUsers() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
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
      const stmt = db.prepare(`INSERT INTO users (id, username, password, display_name, role) VALUES (?,?,?,?,?)`);
      stmt.run(1, 'admin', 'x', '管理员', 'admin');
      stmt.run(2, 'alice', 'x', 'Alice', 'user');
      stmt.run(3, 'bob', 'x', 'Bob', 'user');
      stmt.run(4, 'carol', 'x', 'Carol', 'user');
      stmt.run(5, 'dave', 'x', 'Dave', 'user');
      stmt.run(6, 'erin', 'x', 'Erin', 'user');
      stmt.finalize((err) => {
        db.close(() => (err ? reject(err) : resolve()));
      });
    });
  });
}

function rawAll(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
    db.all(sql, params || [], (err, rows) => { db.close(); err ? reject(err) : resolve(rows); });
  });
}

// H1/H2/H3 专用：原生连接直接执行写 SQL（不经模块 mutex），用于绕过应用层校验、直插非法值
// 验证 DB CHECK 约束本身确实存在（不是只靠 JS 层校验兜底）。
function rawRun(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
    db.run(sql, params || [], function (err) {
      db.close();
      err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// H3：7 表列级期望 schema，按方案 §2.1–§2.6 手写为常量（不从 routes/it-ledger/index.js 的
//   DDL_STATEMENTS 字符串反推/正则提取）——若 DDL 手误写错某列的类型/NOT NULL/默认值，若
//   期望值也是从同一份 DDL 派生的，这类错误永远测不出来；只有独立按方案重新誊写一份，才能
//   起到"交叉校验"的作用。字段顺序按 PRAGMA table_info 的 cid 升序（建表语句里的列声明顺序）。
//   dflt_value 的具体字符串格式（如函数默认值不带外层括号、字符串默认值带内层单引号）已用
//   一次性 dump 脚本核对过 sqlite3 驱动的真实返回值，不是凭空猜测。
const EXPECTED_SCHEMA = {
  it_assets: [
    { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
    { name: 'asset_no', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'category', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'brand', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'model', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'sn', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'slot_count', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'u_height', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'u_start', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'rack_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'location_text', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'floor_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'room_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'pos', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'parent_asset_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'slot_no', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'custodian_user_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'custodian_name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'purchased_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'expires_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'attrs', type: 'TEXT', notnull: 1, dflt_value: "'{}'", pk: 0 },
    { name: 'fin_amount', type: 'REAL', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'fin_vendor', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'fin_contract_no', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'note', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'version', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
    { name: 'created_by', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 }, // L7：本轮改为 NOT NULL
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now','localtime')", pk: 0 },
    { name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now','localtime')", pk: 0 },
    // R1（长任务D · P10对账族）：ALTER TABLE ADD COLUMN 追加于既有列之后，均可空无默认值
    //   （方案 §6）——顺序即 P10_ASSET_FIELDS 顺序（routes/it-ledger/index.js）。
    { name: 'owner_name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'owner_dept', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'asset_class', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  ],
  it_racks: [
    { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
    { name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'room', type: 'TEXT', notnull: 1, dflt_value: "'机房'", pk: 0 },
    { name: 'u_total', type: 'INTEGER', notnull: 1, dflt_value: '42', pk: 0 },
    { name: 'sort_order', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'note', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now','localtime')", pk: 0 },
  ],
  it_floors: [
    { name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 }, // H2：本轮改为 NOT NULL
    { name: 'name', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'sort_order', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
    { name: 'rooms', type: 'TEXT', notnull: 1, dflt_value: "'[]'", pk: 0 },
    { name: 'note', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now','localtime')", pk: 0 },
  ],
  it_asset_events: [
    { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
    { name: 'op_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'asset_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'action', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'role', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'related_asset_id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'from_state', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'to_state', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'operator_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'note', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now','localtime')", pk: 0 },
  ],
  it_asset_acl: [
    { name: 'user_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 }, // L5：本轮改为 NOT NULL
    { name: 'level', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'granted_by', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now','localtime')", pk: 0 },
  ],
  it_stocktakes: [
    { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
    { name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'scope', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'status', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'created_by', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: "datetime('now','localtime')", pk: 0 },
    { name: 'closed_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'closed_by', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'summary', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'note', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  ],
  it_stocktake_items: [
    { name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
    { name: 'stocktake_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'asset_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'expected', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { name: 'result', type: 'TEXT', notnull: 1, dflt_value: "'pending'", pk: 0 },
    { name: 'actual', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'checked_by', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'checked_at', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'resolved_op_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
    { name: 'note', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
  ],
  // R1（长任务D · P10对账族，spec R1_对账表结构_spec.md §2.2）：新增两表列级对拍，独立誊写
  //   （不从 index.js 的 RECONCILE_DDL_STATEMENTS 反推），精神同上方 7 表。
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

// T6（本轮 codex 17-R2 必修）：6 个索引的期望结构手写为常量（名/列序/unique/partial WHERE），
//   同 H3 的 EXPECTED_SCHEMA 精神——不从 index.js 的 DDL_STATEMENTS 反推，独立誊写才能起到
//   交叉校验的作用。whereClause 只在 partial=true 时使用。
const EXPECTED_INDEXES = {
  idx_it_assets_asset_no_unique: { table: 'it_assets', cols: ['asset_no'], unique: true, partial: true, whereClause: 'asset_no IS NOT NULL' },
  idx_it_assets_sn_unique: { table: 'it_assets', cols: ['sn'], unique: true, partial: true, whereClause: 'sn IS NOT NULL' },
  idx_it_assets_parent_slot_unique: { table: 'it_assets', cols: ['parent_asset_id', 'slot_no'], unique: true, partial: true, whereClause: 'parent_asset_id IS NOT NULL' },
  idx_it_asset_events_asset_id: { table: 'it_asset_events', cols: ['asset_id', 'id'], unique: false, partial: false },
  idx_it_asset_events_op_id: { table: 'it_asset_events', cols: ['op_id'], unique: false, partial: false },
  idx_it_stocktake_items_unique: { table: 'it_stocktake_items', cols: ['stocktake_id', 'asset_id'], unique: true, partial: false },
};

function normalizeSqlFragmentForTest(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// 对 sqlite_master.sql 与 PRAGMA index_info 核实一个索引的真实结构是否符合期望。
async function checkIndexStructureForTest(indexName, expected) {
  const listRows = await rawAll(`PRAGMA index_list(${expected.table})`);
  const row = (listRows || []).find((r) => r.name === indexName);
  if (!row) return { ok: false, reason: '索引不存在' };
  const expectUnique = expected.unique ? 1 : 0;
  if (Number(row.unique) !== expectUnique) {
    return { ok: false, reason: `unique不符(期望${expectUnique},实得${row.unique})` };
  }
  const infoRows = await rawAll(`PRAGMA index_info(${indexName})`);
  const cols = (infoRows || []).slice().sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
  const colsOk = cols.length === expected.cols.length && cols.every((c, i) => c === expected.cols[i]);
  if (!colsOk) {
    return { ok: false, reason: `列序不符(期望[${expected.cols.join(',')}],实得[${cols.join(',')}])` };
  }
  if (expected.partial) {
    if (Number(row.partial) !== 1) {
      return { ok: false, reason: '期望partial索引但实得非partial' };
    }
    const sqlRows = await rawAll(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`, [indexName]);
    const sqlText = (sqlRows[0] && sqlRows[0].sql) || '';
    const m = /\bWHERE\b([\s\S]*)$/i.exec(sqlText);
    const actualWhere = m ? m[1].trim() : '';
    if (normalizeSqlFragmentForTest(actualWhere) !== normalizeSqlFragmentForTest(expected.whereClause)) {
      return { ok: false, reason: `WHERE不符(期望"${expected.whereClause}",实得"${actualWhere}")` };
    }
  } else if (Number(row.partial) === 1) {
    return { ok: false, reason: '期望非partial索引但实得partial(多出WHERE)' };
  }
  return { ok: true };
}

// M4（主会话 2026-09-18 裁定）：forceRawRollback 已删除——用例10b 路径2 改为真实路径（业务回调
//   自己真实 ROLLBACK 收尾），路径3 改用 _internals.reinitForTest() 强制重连收尾，两者都不再需要
//   这个"手工补发原生 ROLLBACK"的擦屁股助手。

async function queryLastEventByUserId(action, userId) {
  const rows = await rawAll(`SELECT * FROM it_asset_events WHERE action=? ORDER BY id DESC LIMIT 30`, [action]);
  return (rows || []).find((r) => {
    try {
      const f = JSON.parse(r.from_state), t = JSON.parse(r.to_state);
      return f.user_id === userId || t.user_id === userId;
    } catch (_) { return false; }
  }) || null;
}

async function main() {
  // 17-R8T M1回补：总看门狗挪到 main() 开头——原先挂在 try 块入口（用例循环开始前），
  //   seedUsers()/模块构造/server.listen() 这段启动段本身若真死锁（比如 seedUsers 卡死、
  //   app.listen 从不触发 'listening'），会在看门狗生效前无限期挂起，整个 verify 进程假死且
  //   没有任何汇总输出。现在看门狗覆盖整个 main()（含启动段），启动段真死锁也能到点强制退出
  //   并打印 PASS/FAIL 汇总。
  let currentCaseLabel = '启动段';
  const MAIN_DEADLINE_MS = 240000;
  const mainDeadlineTimer = setTimeout(() => {
    fatalExit('MAIN_DEADLINE 超时·仍在: ' + currentCaseLabel);
  }, MAIN_DEADLINE_MS);
  if (typeof mainDeadlineTimer.unref === 'function') {
    // 不 unref 会导致该定时器本身阻止进程退出；等它触发前，进程理应早已通过其它路径结束。
    mainDeadlineTimer.unref();
  }

  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await seedUsers();

  const app = express();
  app.use(express.json());

  const itLedgerFactory = require('../routes/it-ledger');
  const itLedgerModule = itLedgerFactory({
    logger, DB_FILE: TEST_DB, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
    enableTestHooks: true, // M8：只有本 verify 传 true 才挂载四个行为改写型测试 seam
  });
  app.use('/api', itLedgerModule.router);

  // S2（17-R4S 必修，测试侧配套）：连接层 error 监听器触发的自愈重建是 fire-and-forget，没有
  // Promise 可直接 await——只能通过 lifecycleCounters.published 的增量间接观察"重建真的发布
  // 成功了"。轮询 + withTimeout 包一层，超时视为致命失败（不是"重建慢"，是"重建从未发生/被
  // 吞掉了"）。
  async function waitForPublishedIncrement(countersBefore, label, timeoutMs) {
    const { getLifecycleCounters } = itLedgerModule._internals;
    const poll = new Promise((resolve) => {
      const check = () => {
        const now = getLifecycleCounters();
        if (now.published > countersBefore.published) return resolve(now);
        setTimeout(check, 10);
      };
      check();
    });
    try {
      return await withTimeout(poll, timeoutMs || 3000, label);
    } catch (e) {
      fatalExit(`${label}: 等待锁内自愈重建发布超时`, JSON.stringify(getLifecycleCounters()));
      return undefined;
    }
  }

  // S6 配套：有些自愈重建注定失败（比如 B5-realclose 场景对同一条连接重复 close()，或
  // M2-② 场景真实撞上第三方 EXCLUSIVE 锁直到 fastMode 预算耗尽才判失败），不会有 published
  // 增量可等——改轮询一个任意布尔条件，同样套 withTimeout；timeoutMs 可选（默认 3000ms），
  // M2-② 这类"真实等锁"场景需要传更宽裕的上限（fastMode 预算 3s + 调度开销，不能卡默认 3s）。
  async function waitForCondition(predicateFn, label, timeoutMs) {
    const poll = new Promise((resolve) => {
      const check = () => {
        if (predicateFn()) return resolve(true);
        setTimeout(check, 10);
      };
      check();
    });
    try {
      return await withTimeout(poll, timeoutMs || 3000, label);
    } catch (e) {
      fatalExit(`${label}: 等待条件成立超时`, e && e.message);
      return undefined;
    }
  }

  // T1（17-R6T HIGH 必修）：任何"等一个操作 Promise 落定"的裸 await（writeP/initP/shutdownP等）
  // 都不许直接 await——必须套超时，否则一旦生产代码真的死锁，这一行会把整个 verify 进程拖死，
  // 而不是报一条 FAIL 后继续跑完其余用例。超时统一走 fatalExit（含PASS/FAIL汇总+TEST_DB路径）。
  async function awaitSettle(promise, ms, label) {
    try {
      return await withTimeout(promise, ms, label);
    } catch (e) {
      // 17-R8T L1回补：withTimeout 的 reject 有两种来源——① 真超时(__timeout:true，withTimeout
      //   自己 setTimeout 触发)；② 被等待的 promise 本身在超时前就已经 reject（普通拒绝，不是
      //   卡死）。两者混用同一句"等待落定超时"文案会误导排查方向（普通拒绝被误判成假死）。
      if (e && e.__timeout) {
        fatalExit(`${label}: 等待落定超时`, e && e.message);
      } else {
        fatalExit(`${label}: 等待落定时目标Promise本身reject(非超时)`, e && (e.stack || e.message));
      }
      return undefined;
    }
  }

  const server = await listenOnSafePort(app, null);
  const PORT = server.address().port;
  const BASE = `http://localhost:${PORT}`;

  // T1（17-R6T HIGH 必修）：所有 HTTP 请求统一套 5s 超时——不是在每个调用点各自重复包一层
  // withTimeout（30 处调用点各包一次既啰嗦又容易漏），而是把超时收进这个唯一的 HTTP 出口本身：
  // 任何调用 api(...) 的地方天然获得保护，不存在"这处忘了包"的遗漏。超时视为致命失败（不是
  // 普通 FAIL——请求挂起代表 HTTP 层/事件循环有真实问题，继续跑后面用例只会级联超时）。
  async function api(method, urlPath, { uid, role, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (uid !== undefined) headers['x-test-user-id'] = String(uid);
    if (role !== undefined) headers['x-test-user-role'] = String(role);
    const doFetch = (async () => {
      const r = await fetch(`${BASE}${urlPath}`, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let j = null;
      try { j = await r.json(); } catch (_) { /* ignore */ }
      return { status: r.status, body: j };
    })();
    try {
      return await withTimeout(doFetch, 5000, `api(${method} ${urlPath})`);
    } catch (e) {
      // 17-R8T L1回补：区分"5s内确实没落定"(真超时) 与 "fetch/JSON解析本身在5s内就抛错"(普通拒绝)。
      if (e && e.__timeout) {
        fatalExit(`api(${method} ${urlPath}): HTTP请求未在5s内落定`, e && e.message);
      } else {
        fatalExit(`api(${method} ${urlPath}): HTTP请求本身异常(非超时)`, e && (e.stack || e.message));
      }
      return undefined;
    }
  }

  function makeRes() {
    const res = { statusCode: 200 };
    res.status = function (code) { res.statusCode = code; return res; };
    res.json = function (body) { res.body = body; return res; };
    return res;
  }
  async function callMiddleware(mw, userId, role) {
    const req = { user: { id: userId, role } };
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    return { nextCalled, status: res.statusCode, body: res.body };
  }

  // L2（主会话 2026-09-18 裁定）：把用例6/用例12里"该判据是否仍在拦"这件事各抽成一个可复用函数，
  //   对照组（正常场景）与用例14的变异组调用同一份判据，两处共享同一条真相，不是各写一份看起来
  //   相似但实际可能悄悄漂移的断言逻辑。

  // T1（本轮 codex 17-R2 必修）：判据函数改返回结构化 { ok, hitTarget, otherErr, opId? }——
  //   ok = 被守护的操作本身是否"真的完成"（写成功了 = true；被guard拦下 = false，不是"是否
  //   抛错"这种容易和语义倒过来的说法）；hitTarget = 若被拦下，拦下的原因是否精确是目标断言
  //   （403 LEDGER_FORBIDDEN / LEDGER_INTERNAL）；otherErr = 非目标错误对象（一律判用例失败，
  //   不能含糊过关）。对照组（guard 正常）应该是 ok=false 且 hitTarget=true；变异组（guard 被
  //   短路）应该是 ok=true（写真的成功了，hitTarget 随之为 false）。

  // 判据①：锁内终判——占住锁→排入write用户的写(assertWrite)→排队期间撤销ACL→放锁。
  // L3（17-R3 M）：本轮加固四条前提断言，不再只信任 HTTP 200/隐式假设：①授权响应200且ACL行
  //   level确实='write'；②写请求确认已真排队（waiterCount，不是碰巧还没发起）；③撤销响应
  //   changes===1（不是撤销了0行的空操作）；④回调在 assertWrite 之后写一行唯一标记——正常组
  //   （assertWrite真的拦下）标记应不存在，变异组（被短路）标记应存在，证明"写成功了"不只是
  //   返回值层面，数据库确实落了这一行。
  // T6（17-R4T 必修）：queuedPromise 创建时立即用 .then(v=>({ok:true,v}),e=>({ok:false,e}))
  //   封装成永不 reject 的结构化结果，调用方之后只需要 await 它，不必到处 try/catch；前提检查
  //   （排队确认+撤销）/ 释放锁 / 收集排队结果（含 3s 超时兜底）/ 判定 / 标记清理统一收进同一个
  //   try/finally——finally 无论正常完成还是中途抛错都会兜底放锁+清理标记行；排队结果的等待
  //   不再无界，超时视为致命失败（继续跑后面用例只会级联超时，不如现在就说清楚）。
  async function checkLockedFinalAuthScenario() {
    const MARKER_UID = 9992; // 未落在其它用例状态里的假 user_id，本函数结束前自行清理
    const grantR = await api('PUT', '/api/it-assets/acl/5', { uid: 1, role: 'admin', body: { level: 'write' } });
    if (grantR.status !== 200) {
      throw new Error(`checkLockedFinalAuthScenario前提失败: 授权响应非200(${grantR.status})`);
    }
    const aclRows = await rawAll('SELECT level FROM it_asset_acl WHERE user_id = ?', [5]);
    if (!aclRows[0] || aclRows[0].level !== 'write') {
      throw new Error(`checkLockedFinalAuthScenario前提失败: ACL行level非write(${JSON.stringify(aclRows)})`);
    }
    const { itTxnMutex, withWrite } = itLedgerModule._internals;
    const releaseHold = await itTxnMutex.acquire(5000);
    const queuedPromise = withWrite(async (q) => {
      await q.assertWrite({ id: 5, role: 'user' });
      // 只有 assertWrite 放行（被拦下时函数已在上一行抛出）才会跑到这里，写一行唯一标记。
      await q.run(`INSERT INTO it_asset_acl (user_id, level, granted_by, created_at) VALUES (?,?,?,datetime('now','localtime'))`,
        [MARKER_UID, 'write', 1]);
      return { ok: true };
    }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

    // T3（17-R6T M2 必修）：finally 固定按这个顺序执行——①幂等放锁（不管 try 是否正常完成，
    // 锁不能悬空；queuedPromise 早在锁释放前就已经创建，即使 try 块半途因前提检查失败而抛错，
    // 排队中的写请求仍会在锁释放后继续跑，不能放着不管） ②等 queuedPromise 真正落定（3s 超时
    // 兜底，超时 fatalExit，不无界等待） ③落定之后才读一次标记是否命中、再删掉标记行（标记
    // 行的存在性只有在 queuedPromise 落定之后才是确定的）。判定逻辑挪到 finally 之外，用这里
    // 捕获的 queuedResult/marked 两个变量。
    let queuedResult = null;
    let marked = false;
    try {
      let queuedOk = false;
      for (let i = 0; i < 100; i++) {
        if (itTxnMutex._internals.waiterCount() >= 1) { queuedOk = true; break; }
        await new Promise((r) => setTimeout(r, 5));
      }
      if (!queuedOk) throw new Error('checkLockedFinalAuthScenario前提失败: 写请求未能在合理时间内排队');
      const revokeResult = await new Promise((resolve, reject) => {
        const db2 = new sqlite3.Database(TEST_DB);
        db2.run('DELETE FROM it_asset_acl WHERE user_id = ?', [5], function (err) {
          db2.close();
          err ? reject(err) : resolve({ changes: this.changes });
        });
      });
      if (revokeResult.changes !== 1) {
        throw new Error(`checkLockedFinalAuthScenario前提失败: 撤销changes非1(${revokeResult.changes})`);
      }
    } finally {
      releaseHold(); // ①幂等放锁
      try {
        queuedResult = await withTimeout(queuedPromise, 3000, 'checkLockedFinalAuthScenario排队结果'); // ②落定
      } catch (e) {
        fatalExit('checkLockedFinalAuthScenario: 排队写请求未在有界时间内结束', e && e.message);
      }
      const markedRows = await rawAll('SELECT 1 AS x FROM it_asset_acl WHERE user_id = ?', [MARKER_UID]);
      marked = !!(markedRows && markedRows.length > 0);
      await rawRun('DELETE FROM it_asset_acl WHERE user_id = ?', [MARKER_UID]); // ③删标记
    }

    if (!queuedResult.ok) {
      const e = queuedResult.e;
      const hitTarget = !!(e && e.status === 403 && e.code === 'LEDGER_FORBIDDEN');
      if (hitTarget && marked) {
        return { ok: false, hitTarget: false, otherErr: new Error('assertWrite拦下但标记行仍写入了，回调执行顺序有问题') };
      }
      return { ok: false, hitTarget, otherErr: hitTarget ? null : e };
    }
    if (!marked) {
      // 写返回成功但数据库里查不到标记行——返回值与数据库不一致，不是"变异判红"该有的样子。
      return { ok: true, hitTarget: false, otherErr: new Error('写返回成功但标记行未查到，数据库与返回值不一致') };
    }
    return { ok: true, hitTarget: false, otherErr: null }; // 写成功了=终判没拦住（变异组期望），且数据库真的写入
  }

  // 判据②：非豁免 action 的 asset_id 为 NULL 规则。变异组(ok=true)时调用方必须用返回的 opId
  //   去数据库里查证确实写入了一行 asset_id IS NULL 的事件——不能只满足于"写成功了"，必须证明
  //   业务确实按误放行的规则真写了库（否则"变异判红"这句话没有事实支撑）。
  async function checkAssetIdNullRuleScenario() {
    const { withWrite, writeEvent } = itLedgerModule._internals;
    const opId = 'nullrule-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    try {
      await withWrite(async (q) => {
        await writeEvent(q, {
          op_id: opId,
          asset_id: null, action: 'update', role: 'primary', related_asset_id: null,
          from_state: {}, to_state: {}, operator_id: 1,
        });
      });
      return { ok: true, hitTarget: false, otherErr: null, opId };
    } catch (e) {
      const hitTarget = !!(e && e.code === 'LEDGER_INTERNAL');
      return { ok: false, hitTarget, otherErr: hitTarget ? null : e, opId };
    }
  }

  // S2（17-R3S 必修）：_internals.handleRollbackFailure 已不再直接导出——需要触发"ROLLBACK 失败
  //   → 模块置不可用 → 重建"这条路径4的用例，改走这个助手：真实注入 ROLLBACK 失败 + 真实抛一个
  //   业务错误触发 withWrite 的 catch 分支，让生产代码自己走到内部的 handleRollbackFailure（不
  //   再绕开锁语义裸调用内部函数）——比直接调用内部函数更贴近生产行为，调用前可以先另外叠加
  //   openDbFailureInjection/ddlBusyInjection 等注入，模拟"重建本身也失败"的组合场景。
  async function triggerRollbackFailureRebuild(marker) {
    const { setRollbackFailureInjection, withWrite } = itLedgerModule._internals;
    setRollbackFailureInjection(true);
    try {
      await withWrite(async () => {
        throw Object.assign(new Error(marker || '测试触发ROLLBACK失败重建'), { status: 400, code: 'TEST_TRIGGER_RBF' });
      });
    } catch (e) {
      // 预期会抛错（503 LEDGER_UNAVAILABLE 或其它）——调用方按 state.ready/state.error 断言结果，
      // 这里不对错误形状做额外判断。
    } finally {
      setRollbackFailureInjection(false);
    }
  }

  // 17-R7T H：全套用例的总看门狗（已挪到 main() 开头，见上方；此处 currentCaseLabel 沿用同一
  // 变量，进入用例循环后逐条更新）。
  try {
    // ══════════════════════════════════════════════════════════════════
    // 组0：初始化前 503（用例2 前半）
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '组0：初始化前 503（用例2 前半）';
      const r = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
      check('用例2: 初始化前 GET /me 503 LEDGER_NOT_READY', r.status === 503 && r.body && r.body.code === 'LEDGER_NOT_READY', JSON.stringify(r));

      // M5：未就绪时直接白盒调 withRead（绕开路由层 requireLedgerReady），应拿到结构化的
      // 503 LEDGER_NOT_READY，而不是 itDb 为 null 导致的原始 TypeError。
      let caught = null;
      try {
        await itLedgerModule._internals.withRead((q) => q.get('SELECT 1'));
      } catch (e) { caught = e; }
      check('用例M5: 未就绪时直调withRead→LEDGER_NOT_READY(非TypeError)',
        caught && caught.status === 503 && caught.code === 'LEDGER_NOT_READY' && !(caught instanceof TypeError),
        JSON.stringify(caught && { name: caught.name, status: caught.status, code: caught.code }));
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例1/2：initSchema 一次性闸 + 就绪门 + DDL失败注入（C1 串行化重构：initSchema 只允许
    //   启动时被真正执行一次——下面这次调用即用掉这唯一一次机会，哪怕它失败了也不会"重开一次"，
    //   要真正恢复只能走 reinitForTest()，不能再指望第二次调用 initSchema() 生效）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例1/2：initSchema 一次性闸 + 就绪门 + DDL失败注入（C1 串行化重构：initSchema 只允许';
      // DDL 失败注入——本模块生命周期里唯一一次真实的 initSchema() 调用，一次性闸门消耗于此。
      itLedgerModule._internals.setDdlFailureInjection('CREATE it_assets');
      await awaitSettle(itLedgerModule.initSchema(), 15000, '用例2等待initSchema()首次真实调用落定');
      check('用例2: DDL失败注入后 state.ready=false', itLedgerModule._internals.state.ready === false);
      check('用例2: DDL失败注入后 state.error 含建表失败', /建表失败/.test(itLedgerModule._internals.state.error || ''), itLedgerModule._internals.state.error);
      check('用例2: DDL失败注入后连接已关闭', itLedgerModule._internals.isDbOpen() === false);
      {
        const r = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
        check('用例2: DDL失败后请求503 LEDGER_UNAVAILABLE', r.status === 503 && r.body && r.body.code === 'LEDGER_UNAVAILABLE', JSON.stringify(r));
      }

      // 清除注入——但 initSchema 的一次性机会已经用掉，不能再靠调用 initSchema() 恢复（会被闸
      //   忽略），改用 reinitForTest()（仅 enableTestHooks，走取锁重建路径，不受一次性闸限制）。
      itLedgerModule._internals.setDdlFailureInjection(null);
      await awaitSettle(itLedgerModule._internals.reinitForTest(), 15000, '用例2等待reinitForTest()落定');
      check('用例2: reinitForTest恢复后 state.ready=true 放行', itLedgerModule._internals.state.ready === true);
      {
        const r = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
        check('用例2: 恢复后请求放行(200)', r.status === 200, JSON.stringify(r));
      }

      // 用例H5①（C1 串行化重构，替换旧版"并发两次 initSchema() 只真的开了一条连接"）：
      //   initSchema 只允许启动时被真正执行一次——上面已经真实跑过一次（虽失败），本次是第二次
      //   真实调用，必须被忽略：连接身份不变、openAndPrepareCallCount 不变（没有真的再开连接）。
      const { getDbIdentity, getOpenAndPrepareCallCount, state } = itLedgerModule._internals;
      const dbIdentityBeforeReentry = getDbIdentity();
      const openedCountBeforeReentry = getOpenAndPrepareCallCount();
      const readyBeforeReentry = state.ready;
      await awaitSettle(itLedgerModule.initSchema(), 15000, '用例H5①等待initSchema()第二次调用落定'); // 第二次真实调用——一次性闸门应忽略它
      check('用例H5①: 第二次initSchema()被一次性闸忽略(连接身份不变)',
        getDbIdentity() === dbIdentityBeforeReentry);
      check('用例H5①: 第二次initSchema()被忽略(openAndPrepareCallCount不变，没有真的再开连接)',
        getOpenAndPrepareCallCount() === openedCountBeforeReentry,
        `before=${openedCountBeforeReentry} after=${getOpenAndPrepareCallCount()}`);
      check('用例H5①: 第二次initSchema()被忽略(state.ready不变且为true)',
        state.ready === readyBeforeReentry && readyBeforeReentry === true);

      const before = await rawAll(`SELECT type, name FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name`);
      // 17-R8T M1回补：裸 await 改 withTimeout（不用 awaitSettle 是因为下面几行还要用
      //   dbIdentityBeforeReentry 等变量核对，保持原有断言结构，只加超时兜底，不改判据）。
      await withTimeout(itLedgerModule._internals.reinitForTest(), 15000, '用例1: reinitForTest()真实重建落定'); // 绕开重入守卫，真实关闭+重开+重建
      const after = await rawAll(`SELECT type, name FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name`);
      const { REQUIRED_TABLES, REQUIRED_INDEXES } = itLedgerModule._internals;
      check('用例1: reinitForTest真实重建后7表齐全',
        REQUIRED_TABLES.every((t) => after.some((r) => r.type === 'table' && r.name === t)),
        JSON.stringify(REQUIRED_TABLES));
      check('用例1: reinitForTest真实重建后6关键索引齐全',
        REQUIRED_INDEXES.every((i) => after.some((r) => r.type === 'index' && r.name === i)),
        JSON.stringify(REQUIRED_INDEXES));
      check('用例1: reinitForTest真实重建零副作用(schema对象列表不变)',
        JSON.stringify(before) === JSON.stringify(after));
      check('用例1: reinitForTest后state.ready=true', itLedgerModule._internals.state.ready === true);
      check('用例1: reinitForTest后连接对象已真实更换(非忽略)',
        itLedgerModule._internals.getDbIdentity() !== dbIdentityBeforeReentry);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例1b（M1）：SQLITE_BUSY 类错误有限退避重试——注入前2次 BUSY，第3次放行，应重试后成功。
    //   模块此刻已就绪，故用 reinitForTest() 触发真实重建（直调 initSchema() 会被重入守卫忽略）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例1b（M1）：SQLITE_BUSY 类错误有限退避重试——注入前2次 BUSY，第3次放行，应重试后成功。';
      const { setDdlBusyInjection, state, reinitForTest } = itLedgerModule._internals;
      setDdlBusyInjection('CREATE it_racks', 2); // 前2次判 BUSY，退避 500ms+1000ms 后第3次放行
      const t0 = Date.now();
      await withTimeout(reinitForTest(), 15000, '用例1b: 首次reinitForTest()落定'); // 17-R8T M1回补：裸await改withTimeout
      const elapsedMs = Date.now() - t0;
      setDdlBusyInjection(null, 0);
      check('用例1b: 前2次BUSY退避重试后第3次成功→ready=true', state.ready === true, JSON.stringify({ ready: state.ready, error: state.error }));
      check('用例1b: 确实经过了至少2次退避等待(耗时≥1400ms，含500+1000)', elapsedMs >= 1400, `elapsedMs=${elapsedMs}`);
      // 复原模块到干净就绪态，供后续用例使用。
      await withTimeout(reinitForTest(), 15000, '用例1b: 复原reinitForTest()落定'); // 17-R8T M1回补
      check('用例1b: 复原后仍ready=true', itLedgerModule._internals.state.ready === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例T4（原M8，本轮 codex 17-R2 + Opus B5 改造）：两个实例（enableTestHooks 传/不传）各自
    //   Object.keys(_internals) 求差集，断言差集**恰好等于**手写冻结清单——不再是"抽4个代表性
    //   seam 逐个查有没有"（漏了新增的 counters/gates 也测不出来），差集多一个或少一个都判红。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例T4（原M8，本轮 codex 17-R2 + Opus B5 改造）：两个实例（enableTestHooks 传/不传）各自';
      const itLedgerFactory2 = require('../routes/it-ledger');
      const gatedModule = itLedgerFactory2({
        logger, DB_FILE: TEST_DB, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
        enableTestHooks: true,
      });
      const throwawayModule = itLedgerFactory2({
        logger, DB_FILE: TEST_DB, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
        // 故意不传 enableTestHooks（也不传 false——按字面"不传"，未传时 deps.enableTestHooks 为
        // undefined，同样不 === true）。
      });
      // 手写冻结清单——独立誊写，不从代码里 grep 提取（避免"代码漏挂一个 gate、清单跟着漏抄一样
      // 的错"这种假阳性）。本轮（17-R3S/17-R4T·S2）：删 handleRollbackFailure 直接导出（不再
      // 绕开锁语义裸调用内部函数）；新增 setCloseFailureInjection（S3）、getConnTrace/
      // clearConnTrace/setSwapGlobalItDbForTest（S4）。17-R6S M：新增 setCloseFailureDelayMs
      // （配合 setCloseFailureInjection 给注入的关闭失败加延迟，供用例B6-openfail-shutdown制造
      // discardUnpublished仍在途的真实窗口）。G2A2（长任务 E 段2）：新增 ledgerRequestContext
      //   （不是 setter，是 AsyncLocalStorage 实例引用，供 verify 构造"写请求上下文里发生一次
      //   锁外读"的正向对照场景，见 verify-it-ledger-inspection-sheets.js）。G3A（41S/41T 必修）：
      //   新增 setPreCommitGate（withWrite 内"txnMarker.active 已置false、COMMIT/ROLLBACK 尚未
      //   发出"这个窗口的可等待闸，语义同 setTxnMidGate）与 runCleanupDetached（不是 setter，是
      //   函数引用，与 ledgerRequestContext 同款导出方式，供 verify 直接拿到与
      //   inspection-sheets.js 工厂收到的同一个函数引用，验证反射取值也拿不到任意回调执行权）。
      //   G3A-b（M1 必修）：新增 setGateTimeoutMsOverride（调小 awaitGateWithTimeout 的超时时长，
      //   供"闸从不放行"场景可控地验证收尾正确性，不用真等 30s）。G3A-c（41RT M4 必修）：新增
      //   getCleanupSettleCounters（只读快照，{started,settled}，供 verify 判定清理动作是否真的
      //   跑完了，不靠"探针记录数连续几轮不再增长"这种间接猜测）。截至本轮共 25 个行为改写/测试
      //   专用导出型 seam。
      const FROZEN_GATED_KEYS = [
        'setDdlFailureInjection', 'setDdlBusyInjection', 'setRollbackFailureInjection',
        'setSkipAssertWriteForTest', 'setDisableNoTxnExemptionForTest',
        'setOpenDbFailureInjection', 'setOpenDbCallbackErrInjection', 'setDdlDeadlineMsOverride',
        'getOpenAndPrepareCallCount', 'setOpenGate', 'setTxnMidGate', 'getLastOpenedDbForTest',
        'getLifecycleCounters', 'getRollbackCallCount', 'reinitForTest',
        'setCloseFailureInjection', 'setCloseFailureDelayMs', 'getConnTrace', 'clearConnTrace',
        'setSwapGlobalItDbForTest', 'ledgerRequestContext', 'setPreCommitGate', 'runCleanupDetached',
        'setGateTimeoutMsOverride', 'getCleanupSettleCounters',
      ].sort();

      const gatedKeys = Object.keys(gatedModule._internals).sort();
      const throwawayKeys = Object.keys(throwawayModule._internals).sort();
      const actualDiff = gatedKeys.filter((k) => !throwawayKeys.includes(k)).sort();

      check('用例T4: enableTestHooks传/不传两实例的_internals键差集恰好等于手写冻结清单(25个)',
        JSON.stringify(actualDiff) === JSON.stringify(FROZEN_GATED_KEYS),
        `actualDiff=${JSON.stringify(actualDiff)} frozen=${JSON.stringify(FROZEN_GATED_KEYS)}`);
      check('用例T4: throwawayModule键集合是gatedModule键集合的真子集(无额外多余键)',
        throwawayKeys.every((k) => gatedKeys.includes(k)) && throwawayKeys.length < gatedKeys.length);
      check('用例T4: 非测试类只读口(isDbOpen)两实例都在(未被误伤)',
        typeof throwawayModule._internals.isDbOpen === 'function' && typeof gatedModule._internals.isDbOpen === 'function');
      // 两个实例都从未 initSchema()，也不挂到 app / server，用完即弃，无需清理。
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例G3Ab-M1：闸超时（COMMIT侧）不再让连接停留在"BEGIN已发出、事务从未真正结束"的半开状态。
    //   旧实现把 preCommitGate 的等待放在包裹 dbRunOn(conn,'COMMIT') 的 try 之外——闸超时抛出的
    //   裸 Error 会直接穿透 withWrite()，既不 COMMIT 也不 ROLLBACK，锁被 finally 释放但连接层的
    //   事务从未真正结束；下一次写请求复用同一条（串行化模型下全程只有一条）连接会在
    //   BEGIN IMMEDIATE 那一步撞见"cannot start a transaction within a transaction"。改法（本轮
    //   M1）：把闸等待挪进 try，闸超时现在与 COMMIT 本身失败走同一条收尾路径（显式 ROLLBACK 后
    //   返回 503 LEDGER_BUSY）。用 setGateTimeoutMsOverride 把超时调到 150ms（不用真等 30s），设
    //   一个永不放行的 preCommitGate，触发一次写请求：①断言该次写以某种错误 reject（闸超时被当作
    //   COMMIT 失败处理）②断言紧接着的下一次写请求能正常成功——这才是本用例真正要证明的性质：锁
    //   与事务都已被正确收尾，没有卡在半开状态。变异：把 index.js 里"提交侧闸等待挪进 COMMIT 的
    //   try"这处改动撤销（闸等待重新移到 try 外）→ 第二次写不再能成功（会撞见 LEDGER_BUSY），
    //   本用例应变红。
    // ══════════════════════════════════════════════════════════════════
    {
      const { withWrite, setPreCommitGate, setGateTimeoutMsOverride } = itLedgerModule._internals;
      const adminUser = { id: 1, role: 'admin' };
      setGateTimeoutMsOverride(150);
      setPreCommitGate(new Promise(() => {})); // 永不放行
      let firstErr = null;
      try {
        await withWrite(async (q) => { await q.assertWrite(adminUser); });
      } catch (e) {
        firstErr = e;
      }
      check('用例G3Ab-M1: 闸从不放行时,第一次写以错误reject(闸超时被当作COMMIT失败,走ROLLBACK收尾)', !!firstErr, firstErr && { code: firstErr.code, message: firstErr.message });
      setPreCommitGate(null);
      setGateTimeoutMsOverride(null);
      let secondErr = null;
      try {
        await withWrite(async (q) => { await q.assertWrite(adminUser); });
      } catch (e) {
        secondErr = e;
      }
      check('用例G3Ab-M1: 第一次写reject后,紧接着的第二次写能正常成功(锁与事务都已正确收尾,未卡在半开状态)', secondErr === null, secondErr && { code: secondErr.code, message: secondErr.message });
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例H1/H2/H3：DDL 结构强化——action 列 CHECK、it_floors.id NOT NULL、7 表列级对拍 + 枚举列
    //   逐列负向插入（主会话 2026-09-18 Opus 预筛裁定批）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例H1/H2/H3：DDL 结构强化——action 列 CHECK、it_floors.id NOT NULL、7 表列级对拍 + 枚举列';
      // H1：it_asset_events.action 直插非法值 → SQLITE_CONSTRAINT
      let err = null;
      try {
        await rawRun(
          `INSERT INTO it_asset_events (op_id, asset_id, action, role, related_asset_id, from_state, to_state, operator_id, created_at)
           VALUES ('h1', NULL, 'not_a_real_action', 'primary', NULL, '{}', '{}', 1, datetime('now','localtime'))`
        );
      } catch (e) { err = e; }
      check('用例H1: it_asset_events.action 直插非法值被CHECK拒(SQLITE_CONSTRAINT)',
        err && /SQLITE_CONSTRAINT/i.test(err.message || ''), err && err.message);

      // H2：it_floors.id 插 NULL → 被拒（NOT NULL PRIMARY KEY）
      err = null;
      try {
        await rawRun(`INSERT INTO it_floors (id, name) VALUES (NULL, 'X楼')`);
      } catch (e) { err = e; }
      check('用例H2: it_floors.id 插NULL被拒',
        err && /SQLITE_CONSTRAINT|NOT NULL/i.test(err.message || ''), err && err.message);

      // H3：7 表列级对拍——期望值按方案 §2.1–§2.6 手写（见文件顶部 EXPECTED_SCHEMA 常量），
      //   不从 index.js 的 DDL_STATEMENTS 反推（避免"DDL 写错、期望值抄一样的错"这种假阳性）。
      for (const tableName of Object.keys(EXPECTED_SCHEMA)) {
        const actualCols = await rawAll(`PRAGMA table_info(${tableName})`);
        const actualNormalized = actualCols
          .sort((a, b) => a.cid - b.cid)
          .map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk }));
        const expected = EXPECTED_SCHEMA[tableName];
        check(`用例H3: ${tableName} 列级对拍(name/type/notnull/dflt_value/pk 全字段)`,
          JSON.stringify(actualNormalized) === JSON.stringify(expected),
          `actual=${JSON.stringify(actualNormalized)} expected=${JSON.stringify(expected)}`);
      }

      // H3 下半：每个枚举列各插一个非法值，断言被 CHECK 拒绝。
      const enumNegativeCases = [
        { label: 'it_assets.category', sql: `INSERT INTO it_assets (id, category, name, status, created_by) VALUES (9001,'bogus','X','in_depot',1)` },
        { label: 'it_assets.status', sql: `INSERT INTO it_assets (id, category, name, status, created_by) VALUES (9002,'other','X','bogus_status',1)` },
        { label: 'it_asset_events.role', sql: `INSERT INTO it_asset_events (op_id, asset_id, action, role, related_asset_id, from_state, to_state, operator_id, created_at) VALUES ('h3a', NULL, 'floor_update', 'bogus_role', NULL, '{}', '{}', 1, datetime('now','localtime'))` },
        { label: 'it_asset_events.action', sql: `INSERT INTO it_asset_events (op_id, asset_id, action, role, related_asset_id, from_state, to_state, operator_id, created_at) VALUES ('h3b', NULL, 'bogus_action', 'primary', NULL, '{}', '{}', 1, datetime('now','localtime'))` },
        { label: 'it_asset_acl.level', sql: `INSERT INTO it_asset_acl (user_id, level, granted_by) VALUES (999, 'bogus_level', 1)` },
        { label: 'it_stocktakes.status', sql: `INSERT INTO it_stocktakes (title, scope, status, created_by) VALUES ('t','{}','bogus_status',1)` },
        { label: 'it_stocktake_items.result', sql: `INSERT INTO it_stocktake_items (stocktake_id, asset_id, expected, result) VALUES (1, 1, '{}', 'bogus_result')` },
      ];
      for (const c of enumNegativeCases) {
        let e2 = null;
        try { await rawRun(c.sql); } catch (e) { e2 = e; }
        // T6（本轮 codex 17-R2 必修）：明确断言错误消息含 "CHECK constraint failed"（实测节点
        // sqlite3 驱动对 CHECK 违例的真实文案格式，见文件顶部诊断记录）——不再只满足于宽松的
        // /SQLITE_CONSTRAINT/，那个正则连 NOT NULL 违例、UNIQUE 违例都会命中，判别力不够精确。
        check(`用例H3: 枚举列 ${c.label} 插非法值被CHECK拒`, e2 && /CHECK constraint failed/i.test(e2.message || ''), e2 && e2.message);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例T6（HIGH·codex 17-R2 测试轮）：① 六个索引的真实结构对 sqlite_master.sql 与
    //   PRAGMA index_info 逐项核实（名/列序/unique/partial WHERE，手写期望见文件顶部
    //   EXPECTED_INDEXES）。② 枚举列全部合法值正向插入必须成功（含 it_asset_events.action
    //   全部 24 个动作码），不能只测负向。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例T6（HIGH·codex 17-R2 测试轮）：① 六个索引的真实结构对 sqlite_master.sql 与';
      // ① 索引结构核对
      for (const indexName of Object.keys(EXPECTED_INDEXES)) {
        const result = await checkIndexStructureForTest(indexName, EXPECTED_INDEXES[indexName]);
        check(`用例T6①: 索引${indexName}结构核对(名/列序/unique/partial WHERE)`, result.ok === true, result.reason);
      }

      // ② 枚举列全部合法值正向插入
      const ALL_CATEGORY_VALUES = ['server', 'disk', 'laptop', 'desktop', 'ap', 'software', 'subscription', 'other'];
      const ALL_STATUS_VALUES = ['in_service', 'in_depot', 'faulty', 'to_retire', 'retired', 'active', 'cancelled'];
      const ALL_ROLE_VALUES = ['primary', 'affected'];
      const ALL_ACTION_VALUES = [
        'rack_in', 'rack_out', 'rack_move', 'rack_relocate', 'place', 'relocate', 'ap_place', 'ap_relocate',
        'assign', 'reassign', 'return', 'disk_mount', 'disk_unmount', 'disk_swap', 'disk_move',
        'mark_status', 'retire', 'renew', 'cancel',
        'update', 'register', 'acl_grant', 'acl_revoke', 'floor_update',
      ];
      const NULL_ASSET_ACTIONS_LOCAL = new Set(['acl_grant', 'acl_revoke', 'floor_update']);
      const ALL_LEVEL_VALUES = ['read', 'write'];
      const ALL_STOCKTAKES_STATUS_VALUES = ['open', 'closed'];
      const ALL_ITEM_RESULT_VALUES = ['pending', 'found', 'missing', 'mismatch'];

      check('用例T6②准备: it_asset_events.action全部合法值数量=24(19§4动作+5非动作族)', ALL_ACTION_VALUES.length === 24, ALL_ACTION_VALUES.length);

      for (let i = 0; i < ALL_CATEGORY_VALUES.length; i++) {
        let posErr = null;
        try { await rawRun(`INSERT INTO it_assets (id, category, name, status, created_by) VALUES (${9100 + i}, '${ALL_CATEGORY_VALUES[i]}', 'X', 'in_depot', 1)`); } catch (e) { posErr = e; }
        check(`用例T6②: it_assets.category='${ALL_CATEGORY_VALUES[i]}' 正向插入成功`, posErr === null, posErr && posErr.message);
      }
      await rawRun(`DELETE FROM it_assets WHERE id BETWEEN 9100 AND 9199`);

      for (let i = 0; i < ALL_STATUS_VALUES.length; i++) {
        let posErr = null;
        try { await rawRun(`INSERT INTO it_assets (id, category, name, status, created_by) VALUES (${9200 + i}, 'other', 'X', '${ALL_STATUS_VALUES[i]}', 1)`); } catch (e) { posErr = e; }
        check(`用例T6②: it_assets.status='${ALL_STATUS_VALUES[i]}' 正向插入成功`, posErr === null, posErr && posErr.message);
      }
      await rawRun(`DELETE FROM it_assets WHERE id BETWEEN 9200 AND 9299`);

      let actIdx = 0;
      for (const act of ALL_ACTION_VALUES) {
        const assetIdVal = NULL_ASSET_ACTIONS_LOCAL.has(act) ? 'NULL' : '1';
        let posErr = null;
        try {
          await rawRun(
            `INSERT INTO it_asset_events (op_id, asset_id, action, role, related_asset_id, from_state, to_state, operator_id, created_at)
             VALUES ('t6act${actIdx}', ${assetIdVal}, '${act}', 'primary', NULL, '{}', '{}', 1, datetime('now','localtime'))`
          );
        } catch (e) { posErr = e; }
        check(`用例T6②: it_asset_events.action='${act}' 正向插入成功`, posErr === null, posErr && posErr.message);
        actIdx++;
      }
      for (const rl of ALL_ROLE_VALUES) {
        let posErr = null;
        try {
          await rawRun(
            `INSERT INTO it_asset_events (op_id, asset_id, action, role, related_asset_id, from_state, to_state, operator_id, created_at)
             VALUES ('t6role_${rl}', NULL, 'floor_update', '${rl}', NULL, '{}', '{}', 1, datetime('now','localtime'))`
          );
        } catch (e) { posErr = e; }
        check(`用例T6②: it_asset_events.role='${rl}' 正向插入成功`, posErr === null, posErr && posErr.message);
      }
      await rawRun(`DELETE FROM it_asset_events WHERE op_id LIKE 't6%'`);

      for (const lv of ALL_LEVEL_VALUES) {
        const uid = lv === 'read' ? 9990 : 9991; // 用不落在其它用例状态里的假 user_id，避免污染 alice/bob 的ACL
        let posErr = null;
        try { await rawRun(`INSERT INTO it_asset_acl (user_id, level, granted_by) VALUES (${uid}, '${lv}', 1)`); } catch (e) { posErr = e; }
        check(`用例T6②: it_asset_acl.level='${lv}' 正向插入成功`, posErr === null, posErr && posErr.message);
      }
      await rawRun(`DELETE FROM it_asset_acl WHERE user_id IN (9990,9991)`);

      for (const st of ALL_STOCKTAKES_STATUS_VALUES) {
        let posErr = null;
        try {
          if (st === 'open') {
            await rawRun(`INSERT INTO it_stocktakes (title, scope, status, created_by) VALUES ('t6open','{}','open',1)`);
          } else {
            await rawRun(`INSERT INTO it_stocktakes (title, scope, status, created_by, closed_at, closed_by) VALUES ('t6closed','{}','closed',1,datetime('now'),1)`);
          }
        } catch (e) { posErr = e; }
        check(`用例T6②: it_stocktakes.status='${st}' 正向插入成功`, posErr === null, posErr && posErr.message);
      }
      await rawRun(`DELETE FROM it_stocktakes WHERE title IN ('t6open','t6closed')`);

      // UNIQUE(stocktake_id, asset_id)——四个 result 值必须用各自独立的 asset_id，否则同一
      // (1,1) 插第二条就撞 UNIQUE，跟本用例要测的 CHECK 枚举无关，会污染断言。
      for (let ri = 0; ri < ALL_ITEM_RESULT_VALUES.length; ri++) {
        const rs = ALL_ITEM_RESULT_VALUES[ri];
        const assetIdForRow = 9300 + ri;
        let posErr = null;
        try {
          if (rs === 'pending') {
            await rawRun(`INSERT INTO it_stocktake_items (stocktake_id, asset_id, expected, result) VALUES (1,${assetIdForRow},'{}','pending')`);
          } else if (rs === 'mismatch') {
            await rawRun(`INSERT INTO it_stocktake_items (stocktake_id, asset_id, expected, result, actual, checked_by, checked_at) VALUES (1,${assetIdForRow},'{}','mismatch','{"a":1}',1,datetime('now'))`);
          } else {
            await rawRun(`INSERT INTO it_stocktake_items (stocktake_id, asset_id, expected, result, checked_by, checked_at) VALUES (1,${assetIdForRow},'{}','${rs}',1,datetime('now'))`);
          }
        } catch (e) { posErr = e; }
        check(`用例T6②: it_stocktake_items.result='${rs}' 正向插入成功`, posErr === null, posErr && posErr.message);
      }
      await rawRun(`DELETE FROM it_stocktake_items WHERE stocktake_id=1 AND asset_id BETWEEN 9300 AND 9399`);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例H2b：连接打开失败的两条路径——① initSchema 首次打开失败（DB_FILE 指向不存在目录）
    //   → 不抛、模块 503 LEDGER_NOT_READY；② 路径4触发的重建打开失败（注入）→ 503
    //   LEDGER_UNAVAILABLE。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例H2b：连接打开失败的两条路径——① initSchema 首次打开失败（DB_FILE 指向不存在目录）';
      // ① 首次打开失败：独立的一次性模块实例，DB_FILE 指向不存在的目录。
      const badDir = path.join(os.tmpdir(), `it-ledger-nodir-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'sub');
      const badDbFile = path.join(badDir, 'x.db'); // badDir 从未创建，sqlite3 打开会失败
      const itLedgerFactory3 = require('../routes/it-ledger');
      const badModule = itLedgerFactory3({
        logger, DB_FILE: badDbFile, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
        enableTestHooks: true,
      });
      let initThrew = false;
      try {
        await badModule.initSchema();
      } catch (e) { initThrew = true; }
      check('用例H2b-①: DB_FILE指向不存在目录时initSchema不抛', initThrew === false);
      check('用例H2b-①: 模块state.ready=false', badModule._internals.state.ready === false);
      check('用例H2b-①: 模块state.error未设置(NOT_READY语义而非UNAVAILABLE)', badModule._internals.state.error === null);
      // 白盒调用 requireLedgerReady 断言路由层实际返回 LEDGER_NOT_READY。
      {
        const res = makeRes();
        let nextCalled = false;
        badModule._internals.requireLedgerReady({ user: { id: 1, role: 'admin' } }, res, () => { nextCalled = true; });
        check('用例H2b-①: requireLedgerReady返回503 LEDGER_NOT_READY',
          !nextCalled && res.statusCode === 503 && res.body && res.body.code === 'LEDGER_NOT_READY',
          JSON.stringify({ statusCode: res.statusCode, body: res.body }));
      }
      // 这个一次性实例从未真正打开过连接，也无需 shutdown/close，直接丢弃。

      // ② 重建打开失败（注入）：用主 itLedgerModule（此刻已就绪），真实触发 ROLLBACK 失败走
      //   路径4，模拟"ROLLBACK 失败触发重建，且重建打开也失败"（S2：不再直接裸调用内部函数）。
      const { setOpenDbFailureInjection, reinitForTest, state } = itLedgerModule._internals;
      setOpenDbFailureInjection(true);
      await triggerRollbackFailureRebuild('用例H2b-②触发业务错误(经ROLLBACK失败注入走路径4)');
      setOpenDbFailureInjection(false);
      check('用例H2b-②: 重建打开失败后state.ready=false', state.ready === false);
      check('用例H2b-②: 重建打开失败后state.error已设置(UNAVAILABLE语义)', typeof state.error === 'string' && /重建连接失败/.test(state.error));
      {
        const r = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
        check('用例H2b-②: HTTP层返回503 LEDGER_UNAVAILABLE', r.status === 503 && r.body && r.body.code === 'LEDGER_UNAVAILABLE', JSON.stringify(r));
      }
      // 复原模块，供后续用例使用。17-R8T LOW-14回补：裸await改withTimeout。
      await withTimeout(reinitForTest(), 15000, '用例H2b-②: reinitForTest()落定');
      check('用例H2b-②: 复原后state.ready=true', itLedgerModule._internals.state.ready === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例B4：① openDbCallbackErrInjection 保留项——同样能让重建打开失败（与 openDbFailureInjection
    //   的语义不同：直接命中回调 err 分支，不经过 on('error') 事件）。② 打开成功后手动在真实 itDb
    //   上 emit('error')，验证"已 settled 之后才报错"这条分支会把模块置为不可用。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例B4：① openDbCallbackErrInjection 保留项——同样能让重建打开失败（与 openDbFailureInjection';
      const { setOpenDbCallbackErrInjection, reinitForTest, state, getDbIdentity } = itLedgerModule._internals;

      // ①（S2：不再直接裸调用内部函数，改真实触发 ROLLBACK 失败走路径4）
      setOpenDbCallbackErrInjection(true);
      await triggerRollbackFailureRebuild('用例B4-①触发业务错误(经ROLLBACK失败注入走路径4)');
      setOpenDbCallbackErrInjection(false);
      check('用例B4-①: openDbCallbackErrInjection也能让重建打开失败(state.ready=false)', state.ready === false);
      check('用例B4-①: state.error已设置(UNAVAILABLE语义)', typeof state.error === 'string' && /重建连接失败/.test(state.error));
      await withTimeout(reinitForTest(), 15000, '用例B4-①: reinitForTest()落定'); // 17-R8T LOW-14回补
      check('用例B4-①: 复原后state.ready=true', itLedgerModule._internals.state.ready === true);

      // ②（S1/S2 重构：healing CAS 子系统已删——服务期连接层故障由 error 监听器自己
      //   fire-and-forget 触发一次锁内重建，不再是"下一个请求进锁自愈"。emit('error') 之后到
      //   重建真正发布成功之前，这段窗口内的请求一律直接 503 UNAVAILABLE；用
      //   lifecycleCounters.published 增量 + withTimeout 观察重建何时真正完成）。
      const liveDb = getDbIdentity();
      check('用例B4-②准备: 模块当前确实ready且有真实连接', state.ready === true && !!liveDb);
      const countersBefore2 = itLedgerModule._internals.getLifecycleCounters();
      liveDb.emit('error', new Error('用例B4-②手动模拟连接层error'));
      check('用例B4-②: 手动emit(error)后state.ready=false', state.ready === false);
      check('用例B4-②: 手动emit(error)后state.error含"连接层错误"', typeof state.error === 'string' && /连接层错误/.test(state.error), state.error);

      await waitForPublishedIncrement(countersBefore2, '用例B4-②等待监听器触发的自愈重建发布');
      check('用例B4-②: 自愈重建后state.ready=true(监听器fire-and-forget触发,未借道reinitForTest)',
        itLedgerModule._internals.state.ready === true);
      check('用例B4-②: 自愈重建后连接对象已更换(新itDb≠故障前旧itDb)',
        itLedgerModule._internals.getDbIdentity() !== liveDb && itLedgerModule._internals.getDbIdentity() !== null);

      const r = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
      check('用例B4-②: 重建发布之后新请求放行(200)', r.status === 200, JSON.stringify(r));
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例B3-healing（S1/S2 重构，T5 改写）：healing CAS 子系统已删——faulted 后 state.ready
    //   已经因为 error 监听器同步置 false（S2），并发多条请求全部走纯 throwReadinessError()，
    //   在取锁前就统一拿到 503 UNAVAILABLE（不是 BUSY），**没有任何一条会真的进锁**。本用例先
    //   显式占住 itTxnMutex，制造"emit(error)排队的自愈重建已经排队、但还没轮到执行"这个窗口，
    //   在窗口内验证 5 条并发请求确实全部在取锁前就被拒绝（waiterCount 不会因为它们而增长，
    //   证明"不进锁"不是巧合，是取锁前就被拦下了）；放锁后等监听器排的那次重建真正发布
    //   （published 增量），全程只有这一次重建真的打开了新连接（opened 增量恰 1）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例B3-healing（S1/S2 重构，T5 改写）：healing CAS 子系统已删——faulted 后 state.ready';
      const { withRead, itTxnMutex, getDbIdentity, getOpenAndPrepareCallCount, getLifecycleCounters, state } = itLedgerModule._internals;
      const liveDb = getDbIdentity();
      check('用例B3-healing准备: 模块当前确实ready且有真实连接', state.ready === true && !!liveDb);
      const openedBefore = getOpenAndPrepareCallCount();
      const countersBefore = getLifecycleCounters();

      // T5：先显式占锁——制造"重建已排队、还没轮到执行"的窗口。
      const releaseHold = await itTxnMutex.acquire(5000);
      try {
        liveDb.emit('error', new Error('用例B3-healing手动模拟连接层error')); // 同步排队一次自愈重建
        check('用例B3-healing: emit(error)后state.ready=false', state.ready === false);

        const waiterCountAfterEmit = itTxnMutex._internals.waiterCount();
        check('用例B3-healing(T5): emit(error)排队的自愈重建已真排队(waiterCount恰1)',
          waiterCountAfterEmit === 1, `waiterCount=${waiterCountAfterEmit}`);

        const CONCURRENCY = 5;
        const results = await awaitSettle(
          Promise.all(
            Array.from({ length: CONCURRENCY }, () =>
              withTimeout(
                withRead(async (q) => q.get('SELECT 1')).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
                2000,
                '用例B3-healing单条并发请求',
              ).catch((e) => ({ ok: false, e })) // withTimeout 超时本身会 reject，兜底转成同型结果，不让整个 Promise.all 被一条拖垮
            )
          ),
          5000,
          '用例B3-healing等待5条并发请求全部落定',
        );
        const okCount = results.filter((r) => r.ok).length;
        check('用例B3-healing(T5): 5条并发请求全部在2s内立即拿到503 UNAVAILABLE(不进锁,不是BUSY)',
          okCount === 0 && results.every((r) => r.e && r.e.status === 503 && r.e.code === 'LEDGER_UNAVAILABLE'),
          JSON.stringify(results.map((r) => (r.ok ? 'OK' : (r.e && r.e.code)))));
        check('用例B3-healing(T5): 持锁期间发的5条请求都没有进锁排队(waiterCount未+5,仍是排队的那1次重建)',
          itTxnMutex._internals.waiterCount() === waiterCountAfterEmit,
          `before=${waiterCountAfterEmit} after=${itTxnMutex._internals.waiterCount()}`);
      } finally {
        releaseHold();
      }

      await waitForPublishedIncrement(countersBefore, '用例B3-healing等待监听器触发的自愈重建发布');
      check('用例B3-healing: 只有监听器排的那一次重建真的开了新连接(opened增量恰1)',
        getOpenAndPrepareCallCount() - openedBefore === 1, `before=${openedBefore} after=${getOpenAndPrepareCallCount()}`);

      const r2 = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
      check('用例B3-healing: 重建发布之后新请求放行(200)', r2.status === 200, JSON.stringify(r2));
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例B4-drain（S1/S2 重构）：监听器 fire-and-forget 排的自愈重建正排队等锁（holder 占着
    //   锁）时 shutdown() 被调用——轮到重建进锁执行 rebuildUnderLock 时应发现 state.draining
    //   已置 true，立即放弃（不开新连接），不与 shutdown() 的 closeItDb() 打架。用一个真实的
    //   withWrite（挂在 txnMidGate 上）占住锁，制造"重建已经因为 emit('error') 被排进队列、
    //   但还没真正执行到 rebuildUnderLock"的窗口；emit('error') 与 shutdown() 调用顺序决定
    //   两者在锁队列里的先后（JS 单线程同步执行保证顺序确定）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例B4-drain（S1/S2 重构）：监听器 fire-and-forget 排的自愈重建正排队等锁（holder 占着';
      const {
        itTxnMutex, withWrite, setTxnMidGate, getDbIdentity,
        getOpenAndPrepareCallCount, getLifecycleCounters, isDbOpen, reinitForTest, state,
      } = itLedgerModule._internals;

      let holderGateResolve;
      const holderArrived = setTxnMidGate(new Promise((r) => { holderGateResolve = r; }));
      // 17-R7T M③：创建时即用 .then(ok/err) 结构化接管，不留裸 reject 落地窗口。
      const holderPromise = withWrite(async () => 'holder-done').then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      await awaitArrived(holderArrived, '用例B4-drain-holder到达txnMidGate', holderPromise);
      setTxnMidGate(null); // 只给 holder 一次性用

      const liveDb = getDbIdentity(); // 就是 holder 捕获的那条 conn——holder 未完成，itDb 还没变
      const openedBefore = getOpenAndPrepareCallCount();
      const countersBefore = getLifecycleCounters();
      liveDb.emit('error', new Error('用例B4-drain手动模拟连接层error')); // 同步排队一次锁内重建（waiter#1）

      let queuedOk = false;
      for (let i = 0; i < 100; i++) {
        if (itTxnMutex._internals.waiterCount() >= 1) { queuedOk = true; break; }
        await new Promise((r) => setTimeout(r, 5));
      }
      check('用例B4-drain准备: 监听器排的自愈重建已真排队等锁(waiterCount≥1)', queuedOk,
        `waiterCount=${itTxnMutex._internals.waiterCount()}`);

      // 17-R7T M③：创建时即用 .then(ok/err) 结构化接管，不留裸 reject 落地窗口。
      const shutdownPromise = itLedgerModule.shutdown()
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); // 置 draining=true，自己也排进同一把锁（waiter#2）

      holderGateResolve(); // 放闸——holder 提交并释放锁，排队的自愈重建先拿到锁执行 rebuildUnderLock
      const holderResult = await awaitSettle(holderPromise, 5000, '用例B4-drain等待holderPromise落定');
      check('用例B4-drain(M③): holderPromise接管结果ok===true',
        holderResult && holderResult.ok === true,
        holderResult && holderResult.ok !== true ? (holderResult.e && holderResult.e.stack) : JSON.stringify(holderResult));
      const shutdownResult2 = await awaitSettle(shutdownPromise, 5000, '用例B4-drain等待shutdownPromise落定');
      check('用例B4-drain(M③): shutdownPromise接管结果ok===true',
        shutdownResult2 && shutdownResult2.ok === true,
        shutdownResult2 && shutdownResult2.ok !== true ? (shutdownResult2.e && shutdownResult2.e.stack) : JSON.stringify(shutdownResult2));

      check('用例B4-drain: 自愈重建因draining被中止,未真的开新连接(opened增量0)',
        getOpenAndPrepareCallCount() - openedBefore === 0, `before=${openedBefore} after=${getOpenAndPrepareCallCount()}`);
      check('用例B4-drain: 自愈重建因draining被中止,published增量0(未发布任何新连接)',
        getLifecycleCounters().published - countersBefore.published === 0,
        JSON.stringify({ before: countersBefore, after: getLifecycleCounters() }));
      check('用例B4-drain: shutdown完成后连接已关闭', isDbOpen() === false);
      check('用例B4-drain: shutdown完成后state.ready=false', state.ready === false);

      itLedgerModule._internals.state.draining = false; // 复位，模拟运维侧重启前的正常操作
      await awaitSettle(reinitForTest(), 15000, '用例B4-drain等待reinitForTest()落定');
      check('用例B4-drain: 复原后state.ready=true', itLedgerModule._internals.state.ready === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例B5-realclose（S1/S2/S4/S6 重构）：txnMidGate 闸内对捕获的 conn 直接 close()（不是
    //   emit('error') 那种"标记但驱动仍可用"的模拟，是真的让底层句柄失效）→ 放闸 → 断言
    //   q.run/COMMIT 报 SQLITE_MISUSE: Database is closed、withWrite 按路径2原样透传该错误、
    //   独立连接核实该行确实未落库、execRollback 命中 S6"Database is closed"分支（豁免+排队
    //   自愈，不是完全跳过）。
    //   S4 订正：closeAndCount 现在把"驱动明确报已经关闭过"识别为关闭完成（ok:true,
    //   alreadyClosed:true），不再置 recoveryForbidden 终态——所以 S6 排队的这次自愈重建会
    //   干净地把 itDb 置 null、开一条新连接、跑 DDL、发布成功，回到"S6 触发自愈 → 重建成功 →
    //   新请求 200"这条正常路径，不再需要 setSwapGlobalItDbForTest(null) 这种 test-only 摘除
    //   手段收尾。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例B5-realclose（S1/S2/S4/S6 重构）：txnMidGate 闸内对捕获的 conn 直接 close()（不是';
      const {
        withWrite, setTxnMidGate, getDbIdentity, getLifecycleCounters, getRollbackCallCount, state,
      } = itLedgerModule._internals;
      const dbBefore = getDbIdentity();
      const countersBefore = getLifecycleCounters();
      const rollbackCountBefore = getRollbackCallCount();

      let gateResolve;
      const arrived = setTxnMidGate(new Promise((r) => { gateResolve = r; }));
      const writeP = withWrite(async (q) => {
        await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (912, 'B5REALCLOSE', 0)`);
        return 'should-not-commit';
      }).catch((e) => ({ __err: e }));
      await awaitArrived(arrived, '用例B5-realclose到达txnMidGate', writeP);

      // 闸内：直接对捕获的连接对象 close()——真断连接，不是标记 __faulted。
      await new Promise((resolve) => dbBefore.close(() => resolve()));
      setTxnMidGate(null);
      gateResolve();

      const result = await awaitSettle(writeP, 5000, '用例B5-realclose等待writeP落定');
      check('用例B5-realclose: q.run在已关闭连接上报SQLITE_MISUSE/Database is closed',
        result.__err && /Database is closed|SQLITE_MISUSE/i.test(result.__err.message || ''), JSON.stringify(result));
      // 白盒直调 withWrite（不经过 handleErr）：豁免命中后 withWrite 按路径2原样透传业务错误
      // 本身（这里就是驱动抛出的 "Database is closed" 原始错误），不额外包一层503——那层包装
      // 属于 HTTP 路由层（handleErr：err.status/err.code 都有才回用户码，否则统一回500
      // LEDGER_INTERNAL，本模块当前唯二会调用 withWrite 的生产路由都不会构造这种裸错误，此处
      // 用白盒断言原始错误对象本身，不经过还没被这条业务路径覆盖的 handleErr 二次包装）。
      check('用例B5-realclose: withWrite按路径2原样透传原始错误(不额外包装status)',
        result.__err && result.__err.status === undefined, result.__err && result.__err.status);
      check('用例B5-realclose: execRollback确实被调用过(命中S6"Database is closed"分支,而不是完全跳过)',
        getRollbackCallCount() > rollbackCountBefore, `before=${rollbackCountBefore} after=${getRollbackCallCount()}`);

      const rowAfter = await rawAll('SELECT * FROM it_racks WHERE id=912');
      check('用例B5-realclose: 独立连接核实该行确实未落库', rowAfter.length === 0, JSON.stringify(rowAfter));

      // S6 排的自愈重建此刻应该已经在队列里（execRollback 在 withWrite 释放锁之前就调用了
      // scheduleSelfHealIfNeeded）；S4 修复后这次重建应该干净地成功发布，不再终态化。
      await waitForPublishedIncrement(countersBefore, '用例B5-realclose等待S6排队的自愈重建发布');
      check('用例B5-realclose: S6触发的自愈重建成功发布，recoveryForbidden仍为false(S4:重复关闭不算真失败)',
        state.recoveryForbidden === false);
      check('用例B5-realclose: 重建后连接对象已更换(非报废的dbBefore)',
        getDbIdentity() !== dbBefore && getDbIdentity() !== null);

      const r2 = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
      check('用例B5-realclose: 重建发布之后新请求放行(200)', r2.status === 200, JSON.stringify(r2));
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例S1-stale（17-R5S HIGH 必修）：连接层 error 监听器排队的自愈重建，真正拿到锁时必须
    //   复核"自己是不是还对得上号"——事务持锁内先 emit('error')（排队一次自愈重建，此刻锁被
    //   本次 withWrite 自己占着，只能排队），同一笔事务紧接着 ROLLBACK 失败触发
    //   handleRollbackFailure，它在**同一次 withWrite 调用里**（还没 release()）直接调用
    //   rebuildUnderLock（不再排队，已持锁）抢先把这条故障连接换成一条健康连接并发布成功。
    //   释放锁后，排队的那次自愈重建才轮到执行：断言它发现 itDb 已经不是自己当初盯的那条连接，
    //   判定 stale 直接放弃——不二次关闭刚发布的健康连接、不重复打开第三条连接（published
    //   增量恰 1、closedAttempts 增量恰 1、新连接确实可查询）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例S1-stale（17-R5S HIGH 必修）：连接层 error 监听器排队的自愈重建，真正拿到锁时必须';
      const {
        withWrite, withRead, setTxnMidGate, getDbIdentity, getLifecycleCounters,
        setRollbackFailureInjection, itTxnMutex,
      } = itLedgerModule._internals;
      const dbBefore = getDbIdentity();
      const countersBefore = getLifecycleCounters();

      let gateResolve;
      const arrived = setTxnMidGate(new Promise((r) => { gateResolve = r; }));
      setRollbackFailureInjection(true);
      const writeP = withWrite(async () => {
        throw Object.assign(new Error('用例S1-stale触发业务错误(经ROLLBACK失败注入走路径4)'), { status: 400, code: 'TEST_TRIGGER_S1STALE' });
      }).catch((e) => ({ __err: e }));
      await awaitArrived(arrived, '用例S1-stale到达txnMidGate', writeP);

      // 闸内：对当前连接 emit('error')——排队一次自愈重建（锁被 writeP 自己占着，只能排队）。
      dbBefore.emit('error', new Error('用例S1-stale手动模拟连接层error(在途事务中触发)'));
      let queuedOk = false;
      for (let i = 0; i < 100; i++) {
        if (itTxnMutex._internals.waiterCount() >= 1) { queuedOk = true; break; }
        await new Promise((r) => setTimeout(r, 5));
      }
      check('用例S1-stale准备: emit(error)排队的自愈重建确实已排队(waiterCount≥1)', queuedOk,
        `waiterCount=${itTxnMutex._internals.waiterCount()}`);

      setTxnMidGate(null);
      // 放闸——fn 抛错 → ROLLBACK失败(注入) → handleRollbackFailure 在同一次调用里直接
      // rebuildUnderLock（已持锁，不再排队），抢先把故障连接换成健康连接并发布。
      gateResolve();
      const result = await awaitSettle(writeP, 5000, '用例S1-stale等待writeP落定');
      setRollbackFailureInjection(false);
      check('用例S1-stale: 触发事务本身按路径4返回503 LEDGER_UNAVAILABLE',
        result.__err && result.__err.status === 503 && result.__err.code === 'LEDGER_UNAVAILABLE',
        JSON.stringify(result.__err && { status: result.__err.status, code: result.__err.code }));

      const dbAfterHandleRollback = getDbIdentity();
      check('用例S1-stale: handleRollbackFailure的重建已经把连接换成健康的新连接',
        dbAfterHandleRollback !== dbBefore && dbAfterHandleRollback !== null);

      // 排队的那次自愈重建此刻应该已经轮到执行（锁已释放）——等队列真正排空（stale 判定不会
      // 再 acquire 任何东西，一拿到锁就同步返回，等锁本身释放即代表它跑完了）。
      await waitForCondition(
        () => !itTxnMutex._internals.isLocked() && itTxnMutex._internals.waiterCount() === 0,
        '用例S1-stale等待排队的自愈重建完成stale判定并释放锁',
      );
      const countersAfter = getLifecycleCounters();
      check('用例S1-stale: published增量恰1(排队的那次自愈判stale放弃,没有二次发布)',
        countersAfter.published - countersBefore.published === 1,
        JSON.stringify({ before: countersBefore, after: countersAfter }));
      check('用例S1-stale: closedAttempts增量恰1(排队的那次自愈没有二次关闭健康连接)',
        countersAfter.closedAttempts - countersBefore.closedAttempts === 1,
        JSON.stringify({ before: countersBefore, after: countersAfter }));

      const r3 = await withRead(async (q) => q.get('SELECT 1'))
        .then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e }));
      check('用例S1-stale: 新连接确实可查询(未被stale判定的自愈误伤)', r3.ok === true, JSON.stringify(r3));
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例B3：全局 deadline + fastMode。① 普通模式下把 deadline 临时调小验证生效（不等满额退避）；
    //   ② fastMode 下持续 BUSY 注入，路径4触发的重建应在 ≤2s 内返回且模块 UNAVAILABLE。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例B3：全局 deadline + fastMode。① 普通模式下把 deadline 临时调小验证生效（不等满额退避）；';
      const { setDdlBusyInjection, setDdlDeadlineMsOverride, reinitForTest, state } = itLedgerModule._internals;

      // ① 普通模式：deadline 调到 100ms，注入持续 BUSY，验证远早于"等满第一级500ms退避"就判失败。
      setDdlBusyInjection('CREATE it_racks', Infinity);
      setDdlDeadlineMsOverride(100);
      const t0 = Date.now();
      await withTimeout(reinitForTest(), 15000, '用例B3-①: reinitForTest()落定'); // 17-R8T M1回补：裸await改withTimeout
      const elapsed1 = Date.now() - t0;
      check('用例B3-①: deadline=100ms时远早于500ms首次退避就判失败', elapsed1 < 400, `elapsed=${elapsed1}`);
      check('用例B3-①: 判失败后state.ready=false', state.ready === false);
      setDdlDeadlineMsOverride(null);
      setDdlBusyInjection(null, 0);
      await withTimeout(reinitForTest(), 15000, '用例B3-①: 复原reinitForTest()落定'); // 17-R8T M1回补
      check('用例B3-①: 复原后state.ready=true', itLedgerModule._internals.state.ready === true);

      // ②（注入·只验JS退避，S2：改走真实路径4触发）：fastMode 下内部 rebuildUnderLock 以
      //   {fastMode:true} 调用，退避压成单次500ms，持续 BUSY **注入**下应在 ≤2s 内返回——这条
      //   只验证 JS 层退避调度对不对，不是真实 SQLite 锁竞争（M2 裁定：真实等锁预算另见下方
      //   "用例M2-②真实持锁"）。
      setDdlBusyInjection('CREATE it_racks', Infinity);
      const t1 = Date.now();
      await triggerRollbackFailureRebuild('用例B3-②触发业务错误(经ROLLBACK失败注入走路径4,持续BUSY)');
      const elapsed2 = Date.now() - t1;
      setDdlBusyInjection(null, 0);
      check('用例B3-②(注入·只验JS退避): fastMode下路径4重建在≤2s内返回', elapsed2 <= 2000, `elapsed=${elapsed2}`);
      check('用例B3-②(注入·只验JS退避): 模块UNAVAILABLE(state.error已设置)', typeof state.error === 'string');
      check('用例B3-②(注入·只验JS退避): state.ready=false', state.ready === false);
      await withTimeout(reinitForTest(), 15000, '用例B3-②: 复原reinitForTest()落定'); // 17-R8T M1回补：裸await改withTimeout
      check('用例B3-②(注入·只验JS退避): 复原后state.ready=true', itLedgerModule._internals.state.ready === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例M2-②（S1/S2 重构）：真实等锁预算——第二个原生连接持真正的 EXCLUSIVE 锁不放，
    //   emit('error') 手动故障当前连接直接触发监听器 fire-and-forget 的锁内自愈重建
    //   （rebuildUnderLock({fastMode:true})），断言在真实 SQLite 锁竞争下也能在合理上限内
    //   结束（非无限等）且模块 UNAVAILABLE。S2 改造：自愈不再由"下一个请求"触发，是 emit
    //   本身同步排队——不需要再借道一次 withRead 调用去触发它；没有 Promise 可直接 await，
    //   改轮询 state.error 出现"重建连接失败"这句具体文案（代表这次尝试真的跑完了：真实撞上
    //   db2 的 EXCLUSIVE 锁，DDL 阶段反复退避直到 fastMode 预算耗尽才判失败）。
    //   实测踩坑两次：① 单纯 BEGIN IMMEDIATE 不够——本模块重建的 DDL 全是 CREATE ... IF NOT
    //   EXISTS，对象已存在时 SQLite 走只读快速路径判定"无需修改"，根本不申请写锁，对端持不持
    //   RESERVED 都不影响，实测秒回。② PRAGMA locking_mode=EXCLUSIVE + BEGIN IMMEDIATE + INSERT
    //   仍不够（同样秒回）。改用 `BEGIN EXCLUSIVE`（显式立即请求 EXCLUSIVE，而非等写操作时才
    //   升级）——独立诊断脚本证实这条确实能让第三方连接的 CREATE TABLE IF NOT EXISTS 真实阻塞、
    //   最终 SQLITE_BUSY（诊断里请求 busy_timeout=2000ms，实测耗时 3144ms——SQLite 的 busy 重试
    //   循环存在真实调度开销，不是精确到毫秒的定时器，实测会比标称值多出约 50%，故本用例的时间
    //   上限按标称 fastMode 预算(3000ms)的 2 倍(6000ms)留够裕度，而不是卡 4000ms 这种偏紧的数；
    //   waitForCondition 的超时上限也相应传 8000ms，不能卡默认 3000ms）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例M2-②（S1/S2 重构）：真实等锁预算——第二个原生连接持真正的 EXCLUSIVE 锁不放，';
      const { getDbIdentity, reinitForTest, state } = itLedgerModule._internals;

      const db2 = new sqlite3.Database(TEST_DB);
      // db2 的释放放进 finally——无论上面断言是否通过、是否命中看门狗，都必须释放这把 EXCLUSIVE
      // 锁，否则它会一直卡住后面所有用例（db2 不关闭的话谁都碰不了这个 db 文件）。
      try {
        await new Promise((resolve, reject) => db2.run('BEGIN EXCLUSIVE', (err) => (err ? reject(err) : resolve())));
        // 不提交——db2 持有真正的 EXCLUSIVE 锁，覆盖"任何"其他连接的读写，直到 ROLLBACK/COMMIT。

        const liveDb = getDbIdentity();
        const t0 = Date.now();
        liveDb.emit('error', new Error('用例M2-②手动模拟连接层error(真实持锁下触发自愈重建)'));

        await waitForCondition(
          () => typeof state.error === 'string' && /重建连接失败/.test(state.error),
          '用例M2-②等待锁内自愈重建真实撞锁后失败结束',
          8000,
        );
        const elapsed = Date.now() - t0;

        check('用例M2-②: 自愈重建真的在有界时间内返回(未触发致命看门狗)', true, `elapsed=${elapsed}`);
        check('用例M2-②: 真实持锁下自愈重建在合理上限(≤6s)内返回', elapsed <= 6000, `elapsed=${elapsed}`);
        check('用例M2-②: 确实真的等了锁(耗时≥900ms，非秒回)', elapsed >= 900, `elapsed=${elapsed}`);
        check('用例M2-②: 模块UNAVAILABLE(state.error已设置)', typeof state.error === 'string', state.error);
        check('用例M2-②: state.ready=false', state.ready === false);
      } finally {
        await new Promise((resolve) => db2.run('ROLLBACK', () => resolve())); // best-effort，不阻断后续 finally
        await new Promise((resolve) => db2.close(() => resolve()));
      }
      await withTimeout(reinitForTest(), 15000, '用例M2-②: reinitForTest()落定'); // 17-R8T LOW-14回补
      check('用例M2-②: 释放锁并reinitForTest后state.ready=true', itLedgerModule._internals.state.ready === true);
    }

    // 用例17R-H5①（并发两次 initSchema() 返回同一 Promise 对象）已随 lifecycleGen 代次仲裁一起
    //   删除——C1 串行化重构下 initSchema 是一次性闸门，"第二次调用被忽略"已在上面的用例1/2 段落
    //   内并入新版"用例H5①"覆盖（连接身份不变、openAndPrepareCallCount 不变），此处不再重复。

    // T2 公共小助手（codex 19预筛 M1 回补，与 verify-it-reconcile.js 同款实现）：对一条据信已
    // 关闭的 db 对象发一次真实查询，返回结构化 {ok, closed, reason}——不再把任何异常都当"已
    // 关闭"证据：引用无效/无 .get 方法直接 fail；只有驱动明确的关闭语义（SQLITE_MISUSE 或消息
    // 含"Database is closed"/"SQLITE_MISUSE"）才判 closed:true，其余错误判 fail(ok:false)。
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
        // codex 19-R MED-2 回补（与 verify-it-reconcile.js 同款）：只认"Database is closed"
        //   明确关闭消息为主判据；SQLITE_MISUSE 仅作辅助，且须同时命中"is closed"词组本身
        //   （不是裸子串"closed"——"not closed reason"含"closed"三个字母但语义相反，要求
        //   "is closed"词组能正确排除这种adversarial消息）。
        const isExplicitClosedMessage = /database is closed/i.test(msg);
        const isMisuseWithClosedHint = /SQLITE_MISUSE/i.test(msg) && /\bis\s+closed\b/i.test(msg);
        if (isExplicitClosedMessage || isMisuseWithClosedHint) {
          return { ok: true, closed: true, reason: msg };
        }
        return { ok: false, closed: false, reason: `未知错误(非已知关闭语义): ${msg}` };
      }
    }

    // M1回补自检（两条反例，codex 19预筛）：probeClosedDb(null) 判 fail；正常打开连接判"未关闭"。
    {
      const probeNullResult = await probeClosedDb(null);
      check('M1回补: probeClosedDb(null)返回fail(ok:false),不是"已关闭"',
        probeNullResult.ok === false && probeNullResult.closed === false, JSON.stringify(probeNullResult));
      const probeSelftestDb = path.join(os.tmpdir(), `it-ledger-probe-selftest-${Date.now()}-${process.pid}.db`);
      if (fs.existsSync(probeSelftestDb)) fs.unlinkSync(probeSelftestDb);
      const openConnForProbe = new sqlite3.Database(probeSelftestDb);
      await new Promise((resolve, reject) => openConnForProbe.run('CREATE TABLE t(id INTEGER)', (err) => (err ? reject(err) : resolve())));
      const probeOpenResult = await probeClosedDb(openConnForProbe);
      check('M1回补: probeClosedDb(正常打开的连接)返回未关闭(ok:true,closed:false)',
        probeOpenResult.ok === true && probeOpenResult.closed === false, JSON.stringify(probeOpenResult));
      await new Promise((resolve) => openConnForProbe.close(() => resolve()));
      if (fs.existsSync(probeSelftestDb)) fs.unlinkSync(probeSelftestDb);

      // codex 19-R MED-2回补第三条反例（与 verify-it-reconcile.js 同款）：假连接对象，
      //   .get 回调返回 SQLITE_MISUSE + 消息含裸子串"closed"但不含"is closed"词组的
      //   adversarial 消息，应正确判 ok:false,closed:false（不被裸子串"closed"骗过）。
      const fakeMisuseDb = {
        get(sql, cb) { cb(new Error('SQLITE_MISUSE: not closed reason')); },
      };
      const probeMisuseResult = await probeClosedDb(fakeMisuseDb);
      check('M1回补: probeClosedDb(SQLITE_MISUSE但消息不含"is closed"词组)返回ok:false,closed:false(不被裸子串"closed"骗过)',
        probeMisuseResult.ok === false && probeMisuseResult.closed === false, JSON.stringify(probeMisuseResult));
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例H5②（C1 串行化重构，L6 到达信号）：启动初始化卡在 openGate 上时调 shutdown() → 放闸 →
    //   断言 shutdown 等到 init 落地后才关闭；最终 ready=false、itDb===null、init 打开的那条
    //   连接确实已被关闭（对它发真实查询应报"已关闭"类错误，不只是猜测）。
    //   一次性闸门（startupStarted）意味着不能再靠"手动拨回 state.ready=false 后再调
    //   itLedgerModule.initSchema()"这种老手法触发第二次真实初始化——改用一个从未调用过
    //   initSchema() 的全新实例，直接测试"真实的启动路径"，比旧版绕开重入守卫更贴近真实场景。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例H5②（C1 串行化重构，L6 到达信号）：启动初始化卡在 openGate 上时调 shutdown() → 放闸 →';
      const itLedgerFactory4 = require('../routes/it-ledger');
      const freshModule = itLedgerFactory4({
        logger, DB_FILE: TEST_DB, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
        enableTestHooks: true,
      });
      const { setOpenGate, getDbIdentity, getLastOpenedDbForTest, state } = freshModule._internals;

      let gateResolve;
      const arrived = setOpenGate(new Promise((r) => { gateResolve = r; }));
      const order = [];
      const initP = freshModule.initSchema().finally(() => { order.push('init-done'); }); // 启动初始化——一次性闸门唯一的真实调用
      await awaitArrived(arrived, '用例H5②到达openGate', initP); // T1：到达信号必须套超时，不能裸 await

      const midDb = getLastOpenedDbForTest(); // 这一轮打开、还未发布的连接引用
      // T1（17-R4T 必修）：放闸前先断言这条连接仍可查询——此刻还没跑到"发布前同步检查发现
      // draining→不发布→关闭"这一步，连接应当完好。
      const preGateProbe = await new Promise((resolve) => {
        midDb.get('SELECT 1', (err) => resolve(err ? { err } : { ok: true }));
      });
      check('用例H5②(T1): 放闸前新连接仍可查询(尚未被关闭)',
        preGateProbe.ok === true, JSON.stringify(preGateProbe.err && preGateProbe.err.message));

      let shutdownDone = false;
      // 17-R7T M③：创建时即用 .then(ok/err) 结构化接管，不留裸 reject 落地窗口。
      const shutdownP = freshModule.shutdown()
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
        .finally(() => { shutdownDone = true; order.push('shutdown-done'); }); // 内部 await initPromise（此刻还卡在 openGate 上）

      // T1（17-R4T HIGH 必修）：不用 Promise.race([p.then(()=>'done'), Promise.resolve('pending')])
      // 这种哨兵写法——链式 .then 比裸 Promise.resolve 多一轮微任务，导致 'pending' 哨兵恒先
      // settle，"shutdown 尚未完成"这条断言恒真、测不出真实时序（codex 17-R4T HIGH）。改用
      // shutdown() 自己 .finally() 同步置位的本地标志，等待两次 setImmediate 调度屏障（宏任务
      // 边界，保证介于其间所有已就绪的微任务都已跑完）后再读这个标志。
      await schedulingBarrier();
      check('用例H5②(T1): shutdown尚未完成(仍在等init落地)', shutdownDone === false);
      check('用例H5②: 放闸前state.draining已是true', state.draining === true);

      gateResolve(); // 放闸——runLifecycleInit 的发布前同步检查会发现 draining=true 而放弃发布
      await awaitSettle(initP, 5000, '用例H5②等待initP落定'); // T1：不许裸 await，套超时防真死锁拖死进程
      const shutdownResult = await awaitSettle(shutdownP, 5000, '用例H5②等待shutdownP落定');
      check('用例H5②(M③): shutdownP接管结果ok===true',
        shutdownResult && shutdownResult.ok === true,
        shutdownResult && shutdownResult.ok !== true ? (shutdownResult.e && shutdownResult.e.stack) : JSON.stringify(shutdownResult));

      check('用例H5②: shutdown后state.ready=false', state.ready === false);
      check('用例H5②: shutdown后itDb===null(启动初始化未发布)', getDbIdentity() === null);
      check('用例H5②(T1): init落地时刻在shutdown完成时刻之前',
        order.indexOf('init-done') >= 0 && order.indexOf('shutdown-done') >= 0 &&
        order.indexOf('init-done') < order.indexOf('shutdown-done'),
        JSON.stringify(order));

      const probe = await probeClosedDb(midDb);
      check('用例H5②: 启动初始化打开的那条连接确实已被关闭(查询报错)',
        probe.ok === true && probe.closed === true, JSON.stringify(probe));
      // 一次性 throwaway 实例，从未挂到 app/server，用完即弃，无需复原。
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例B1-serial（Opus 复看必修）：setOpenGate 卡住启动初始化（throwaway 实例）→ 并发调
    //   reinitForTest() → 放闸 → 断言两者确实串行（reinitForTest 内部先 await initPromise，
    //   不会跟启动初始化抢锁/抢开连接）、最终恰一条连接存活、无孤儿（对启动初始化那条连接做
    //   probeClosedDb）。用 lifecycleCounters 的增量关系验证："published 增量 === closedAttempts
    //   增量 + 1"——两次 runLifecycleInit 各自成功发布一次（opened 增量 2），但只有第一条（启动
    //   初始化发布的那条）会在 reinitForTest 的重建里被关掉换成第二条（closedAttempts 增量 1），
    //   这条关系式只在"真串行、无并发打架"时才会精确成立；若退化成并发抢跑，増量组合会失配。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例B1-serial（Opus 复看必修）：setOpenGate 卡住启动初始化（throwaway 实例）→ 并发调';
      const itLedgerFactory5 = require('../routes/it-ledger');
      const freshModule = itLedgerFactory5({
        logger, DB_FILE: TEST_DB, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
        enableTestHooks: true,
      });
      const { setOpenGate, getDbIdentity, getLastOpenedDbForTest, getLifecycleCounters, reinitForTest } = freshModule._internals;

      let gateResolve;
      const arrived = setOpenGate(new Promise((r) => { gateResolve = r; }));
      const countersBefore = getLifecycleCounters();
      // T1：创建时即接管拒绝——initP/reinitP 本身不再可能裸 reject。
      const initP = freshModule.initSchema().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); // 启动初始化——一次性闸门唯一的真实调用，卡在 openGate 上
      await awaitArrived(arrived, '用例B1-serial到达openGate', initP);

      const midDb = getLastOpenedDbForTest(); // 启动初始化这一轮打开、还未发布的连接引用

      // 并发调用 reinitForTest()——它内部会先 await initPromise（此刻还卡着），与启动初始化
      // 天然串行，不会抢着开第二条连接。用完成标志（而非裸 await 结果）断言它此刻确实尚未完成。
      let reinitDone = false;
      const reinitP = freshModule._internals.reinitForTest()
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })) // T1：创建时即接管拒绝
        .finally(() => { reinitDone = true; });
      await schedulingBarrier(); // 让 reinitForTest 的同步前缀真正跑到"await initPromise"这一步

      // 17-R7T M①：放闸前断言挪到"创建 reinitP 并 schedulingBarrier 之后"——避免在 reinitP 尚未
      // 创建、reinitForTest 的同步前缀尚未真正跑到"await initPromise"这一步之前就断言计数器
      // 状态，那样测不出 reinitForTest 是否真的在此刻被启动初始化天然串行地卡住。
      const countersMidGate = getLifecycleCounters();
      check('用例B1-serial(T2): 放闸前opened增量恰1(启动init只开了一条连接,还没发布)',
        countersMidGate.opened - countersBefore.opened === 1,
        JSON.stringify({ before: countersBefore, mid: countersMidGate }));
      check('用例B1-serial(T2): 放闸前published增量为0(还没发布)',
        countersMidGate.published - countersBefore.published === 0,
        JSON.stringify({ before: countersBefore, mid: countersMidGate }));
      check('用例B1-serial(T2): 放闸前closedAttempts增量为0(还没关过任何连接)',
        countersMidGate.closedAttempts - countersBefore.closedAttempts === 0,
        JSON.stringify({ before: countersBefore, mid: countersMidGate }));
      check('用例B1-serial(T2): 放闸前reinitForTest()尚未完成(仍在等initPromise落地,完成标志false)',
        reinitDone === false);

      gateResolve(); // 放闸——启动初始化走完 DDL+发布检查，正常发布成功；随后 initPromise 落地，
      // reinitForTest 才真正取锁+重建。
      const initResult = await awaitSettle(initP, 5000, '用例B1-serial等待initP落定'); // T1：不许裸 await
      check('用例B1-serial(M②): initP接管结果ok===true(非裸await)',
        initResult && initResult.ok === true,
        initResult && initResult.ok !== true ? (initResult.e && initResult.e.stack) : JSON.stringify(initResult));
      const reinitResult = await awaitSettle(reinitP, 5000, '用例B1-serial等待reinitP落定');
      check('用例B1-serial(M②): reinitP接管结果ok===true(非裸await)',
        reinitResult && reinitResult.ok === true,
        reinitResult && reinitResult.ok !== true ? (reinitResult.e && reinitResult.e.stack) : JSON.stringify(reinitResult));

      // T2：放闸后精确断言——两次生命周期动作各开一条连接（opened 增量 2）、各成功发布一次
      // （published 增量 2）、只有 reinitForTest 的重建关闭了启动init发布的那一条（closedAttempts
      // 增量 1）。
      const countersAfter = getLifecycleCounters();
      check('用例B1-serial(T2): 放闸后opened增量精确为2', countersAfter.opened - countersBefore.opened === 2,
        JSON.stringify({ before: countersBefore, after: countersAfter }));
      check('用例B1-serial(T2): 放闸后published增量精确为2', countersAfter.published - countersBefore.published === 2,
        JSON.stringify({ before: countersBefore, after: countersAfter }));
      check('用例B1-serial(T2): 放闸后closedAttempts增量精确为1', countersAfter.closedAttempts - countersBefore.closedAttempts === 1,
        JSON.stringify({ before: countersBefore, after: countersAfter }));
      const openedDelta = countersAfter.opened - countersBefore.opened;
      const publishedDelta = countersAfter.published - countersBefore.published;
      const closedDelta = countersAfter.closedAttempts - countersBefore.closedAttempts;
      check('用例B1-serial: 串行关系式published增量===closedAttempts增量+1(只有一次重建关闭了上一条)',
        publishedDelta === closedDelta + 1,
        JSON.stringify({ openedDelta, publishedDelta, closedDelta }));

      const finalDb = getDbIdentity();
      check('用例B1-serial: 最终恰一条连接存活(非null)', finalDb !== null);
      check('用例B1-serial: 最终连接不是启动init打开的那条(已被reinitForTest的重建替换)', finalDb !== midDb);

      const probe2 = await probeClosedDb(midDb);
      check('用例B1-serial: 启动init发布的那条连接已被reinitForTest的重建关闭(无孤儿,查询报错)',
        probe2.ok === true && probe2.closed === true, JSON.stringify(probe2));
      // 一次性 throwaway 实例，从未挂到 app/server——但 reinitForTest() 发布的那条连接仍是真实
      // 打开的 TEST_DB 句柄，必须显式 shutdown() 关掉，否则 Windows 下会让脚本末尾的 unlinkSync
      // 因文件句柄未释放而报 EBUSY（POSIX 允许删除仍打开的文件，Windows 不允许）。
      await awaitSettle(freshModule.shutdown(), 15000, '用例B1-serial等待freshModule.shutdown()落定');
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例B6-openfail-shutdown（17-R6S M 必修）：openItDb 打开失败 → discardUnpublished 的关闭
    //   注入延迟且失败 → 与打开失败同一时刻立即调 shutdown()——验证修复后的顺序保证：
    //   discardUnpublished（关闭完成/孤儿登记）必须先于 reject 落定，所以 shutdown() 内部
    //   "await initPromise" 天然等到孤儿已登记之后才能继续往下走到收尾重试循环，不会有"孤儿还
    //   没登记、shutdown 已经跑完收尾"的竞态窗口。
    //   codex 18预筛 LOW回补：本用例只断言孤儿计数(orphanRetryProcessed增量/getOrphanConnCount)
    //   与 shutdown()/initSchema() 本身落定，**不证明连接句柄真的已经关闭**——这里走的是
    //   setCloseFailureInjection 合成关闭失败(会真实调用close()回调并携带注入的错误)，不是
    //   "close()回调永不触发"那种真实驱动病理行为；句柄关闭与否的证明边界见下方
    //   用例B6c-openfail-closeAndCount-timeout-no-handle-proof 的用例名与其源码注释。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例B6-openfail-shutdown（17-R6S M 必修）：openItDb 打开失败→discardUnpublished延迟失败关闭→立即shutdown()';
      const itLedgerFactory6 = require('../routes/it-ledger');
      const freshModule6 = itLedgerFactory6({
        logger, DB_FILE: TEST_DB, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
        enableTestHooks: true,
      });
      const {
        setOpenDbCallbackErrInjection, setCloseFailureInjection, setCloseFailureDelayMs,
        getLifecycleCounters: getLifecycleCounters6, getOrphanConnCount,
      } = freshModule6._internals;

      setOpenDbCallbackErrInjection(true); // openItDb 回调err注入分支——打开必失败
      setCloseFailureInjection(true); // discardUnpublished 里的关闭也必失败(才会记进orphanConns)
      setCloseFailureDelayMs(150); // 关闭失败延迟150ms结算，制造"discardUnpublished仍在途"的真实窗口

      const countersBefore6 = getLifecycleCounters6();
      // 创建时即接管拒绝——initP 本身不再可能裸 reject。
      const initP6 = freshModule6.initSchema().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      // 不 await initP6，立即（同一 tick）调用 shutdown()——shutdown() 内部会自己 await
      // initPromise，天然把两者串起来；这里要验证的正是"即便立即调用，也不会抢在
      // discardUnpublished 落定之前完成收尾"。
      const shutdownP6 = freshModule6.shutdown().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

      const initResult6 = await awaitSettle(initP6, 5000, '用例B6-openfail-shutdown等待initP6落定');
      check('用例B6-openfail-shutdown: initSchema()本身不裸抛(即便打开失败,runLifecycleInit内部已吞并置state)',
        initResult6 && initResult6.ok === true, JSON.stringify(initResult6 && initResult6.e && initResult6.e.stack));

      const shutdownResult6 = await awaitSettle(shutdownP6, 5000, '用例B6-openfail-shutdown等待shutdownP6落定');
      check('用例B6-openfail-shutdown: shutdown()本身成功落定(ok===true)',
        shutdownResult6 && shutdownResult6.ok === true,
        shutdownResult6 && shutdownResult6.ok !== true ? (shutdownResult6.e && shutdownResult6.e.stack) : JSON.stringify(shutdownResult6));

      const countersAfter6 = getLifecycleCounters6();
      check('用例B6-openfail-shutdown: shutdown()返回前孤儿收尾重试已处理恰1条(orphanRetryProcessed增量===1)',
        countersAfter6.orphanRetryProcessed - countersBefore6.orphanRetryProcessed === 1,
        JSON.stringify({ before: countersBefore6, after: countersAfter6 }));
      check('用例B6-openfail-shutdown: shutdown()返回后orphanConns已被收尾循环清空(getOrphanConnCount()===0)',
        getOrphanConnCount() === 0, `getOrphanConnCount()=${getOrphanConnCount()}`);

      setOpenDbCallbackErrInjection(false);
      setCloseFailureInjection(false);
      setCloseFailureDelayMs(0);
      // 一次性 throwaway 实例——打开从未成功过，没有真实句柄需要额外关闭；shutdown() 已跑过。
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例B6c-openfail-closeAndCount-timeout-path-reachable（codex 19预筛 M2 回补，收窄自
    //   codex 18预筛 MED-9 的"等价覆盖"声明——原声明"证明回调永不触发"过强，如实改为"closeAndCount
    //   超时兜底路径可达"）：底层 sqlite3.Database 在 open 本身真实失败（非注入，真
    //   SQLITE_CANTOPEN：DB_FILE 指向不存在的目录）之后，对同一个 db 对象调 close() 的回调
    //   **永远不会触发**（已用独立复现脚本确认，本用例不重复证明这一点）。closeAndCount 给
    //   close() 包了 5s 超时兜底：超时按失败处理(ok:false)，仍记日志+计入孤儿，不会让
    //   initSchema()/shutdown() 永久挂起。**本用例证明的范围**：①孤儿登记计数与 shutdown()
    //   收尾重试计数的增量关系（不是只看 closedAttempts 一个数字）②对 itTxnMutex 做一次带超时
    //   的真实 acquire/release（不是只读 waiterCount===0——waiterCount 是队列长度，不是"锁真的
    //   可被拿到"的证明，真实 acquire 才是）。**仍不证明"句柄真的已关闭"**——原因不变：open
    //   本身就从未真正成功过，driver 从不回调 close()，现有导出没有能捕获"打开失败连接引用"的
    //   钩子，新增会破坏"不新增测试专用setter"铁律，主会话已裁定接受本用例作为等价覆盖。
    //   5s 是 closeAndCount 内部硬编码超时，不是猜测的 sleep；耗时区间只作辅助诊断日志
    //   （console.log），不再是一条会让整批失败的 check() 断言（机器快慢不该影响这条用例的
    //   通过与否，本用例真正要证明的是"路径可达+收尾正确"，不是"精确耗时"）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例B6c-openfail-closeAndCount-timeout-path-reachable（codex19预筛 M2回补）：真实open失败→closeAndCount 5s兜底超时路径可达(不证句柄关闭)';
      const BAD_DIR_DB_FILE = path.join(os.tmpdir(), `it-ledger-nonexistent-dir-${Date.now()}-${process.pid}`, 'unreachable.db');
      const itLedgerFactory7 = require('../routes/it-ledger');
      // codex 19-R MED-3回补：closeAndCount 的超时分支本身有 logger.error 输出（index.js
      //   "连接关闭超时(__id=..." 文案）——本模块实例专属构造一个捕获式 logger（logger 是
      //   构造参数，天然可替换，不是新增 setter），断言超时分支确实被走到，而不是只靠耗时区间
      //   和计数器间接推断"路径可达"。
      const capturedLogs7 = [];
      const capturingLogger7 = {
        info: () => {},
        warn: (...a) => capturedLogs7.push({ level: 'warn', msg: a.join(' ') }),
        error: (...a) => capturedLogs7.push({ level: 'error', msg: a.join(' ') }),
      };
      const freshModule7 = itLedgerFactory7({
        logger: capturingLogger7, DB_FILE: BAD_DIR_DB_FILE, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
        enableTestHooks: true,
      });
      const { getLifecycleCounters: getLifecycleCounters7, itTxnMutex: itTxnMutex7, state: state7, getOrphanConnCount: getOrphanConnCount7 } = freshModule7._internals;
      const countersBefore7 = getLifecycleCounters7();

      const t0_7 = Date.now();
      const initResult7 = await awaitSettle(
        freshModule7.initSchema().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
        12000,
        '用例B6c: 等待initSchema()(真实open失败路径)落定'
      );
      const elapsed7 = Date.now() - t0_7;
      check('用例B6c: initSchema()本身不裸抛(open失败已被runLifecycleInit吞并置state)', initResult7 && initResult7.ok === true, JSON.stringify(initResult7));
      check('用例B6c: 最终state.ready=false(真实open失败,目录不存在)', state7.ready === false, JSON.stringify(state7));
      check('用例B6c: 专属logger捕获到"连接关闭超时"文案(closeAndCount超时分支确实被走到,非只靠耗时/计数器间接推断)',
        capturedLogs7.some((l) => /连接关闭超时/.test(l.msg)), JSON.stringify(capturedLogs7));
      // 耗时只作辅助诊断日志——不再是通过/失败的判据（M2回补：机器快慢不该决定这条用例是否
      // 判红，本用例只关心"路径确实走到了、走完了"）。
      console.log(`[DIAG] 用例B6c: closeAndCount超时兜底路径耗时约${elapsed7}ms(硬编码5s量级,仅供参考)`);

      const countersAfterInit7 = getLifecycleCounters7();
      check('用例B6c: lifecycleCounters.closedAttempts确实递增(closeAndCount被真实调用过)',
        countersAfterInit7.closedAttempts > countersBefore7.closedAttempts,
        JSON.stringify({ before: countersBefore7, afterInit: countersAfterInit7 }));

      // M2回补①：initSchema 之后触发 shutdown()，断言孤儿登记计数(orphanRetryProcessed增量)
      //   与 getOrphanConnCount() 的关系——不是只看一次性的 closedAttempts，而是看"孤儿收尾这
      //   条独立流程"本身有没有被真实触发、有没有真实处理完。open失败的这条连接因 close()
      //   回调永不触发而在 closeAndCount 内部超时判失败，会被登记进 orphanConns；shutdown()
      //   收尾时会对它做二次重试关闭（同样会再次超时，因为它就是永远不回调的那条），过程中
      //   orphanRetryProcessed 计数应递增，且最终 orphanConns 队列应清空。
      const shutdownResult7 = await awaitSettle(
        freshModule7.shutdown().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
        12000,
        '用例B6c: 等待shutdown()(孤儿收尾重试,同样~5s超时)落定'
      );
      check('用例B6c: shutdown()本身不裸抛(孤儿收尾重试内部失败已被吞并)', shutdownResult7 && shutdownResult7.ok === true, JSON.stringify(shutdownResult7));
      const countersAfterShutdown7 = getLifecycleCounters7();
      check('用例B6c: shutdown()收尾重试期间orphanRetryProcessed增量≥1(孤儿收尾确实被真实处理过,不只是登记)',
        countersAfterShutdown7.orphanRetryProcessed - countersBefore7.orphanRetryProcessed >= 1,
        JSON.stringify({ before: countersBefore7, afterShutdown: countersAfterShutdown7 }));
      check('用例B6c: shutdown()收尾后getOrphanConnCount()===0(孤儿队列已清空,不留残留)',
        getOrphanConnCount7() === 0, `getOrphanConnCount()=${getOrphanConnCount7()}`);

      // M2回补②：锁释放用带超时的真实 acquire/release 证明，不用 waiterCount===0——
      //   waiterCount 只反映"排队等锁的数量"，不代表"锁此刻真的能被拿到"（比如锁持有者已死但
      //   从未 release，waiterCount 同样可能是0）。真实 acquire 一次并立即 release，能确定性
      //   证明这把锁没有被前面任何失败路径遗留占用。
      let acquiredRelease7 = null;
      const acquireResult7 = await withTimeout(itTxnMutex7.acquire(0), 5000, '用例B6c: itTxnMutex真实acquire()验证锁未被占用');
      acquiredRelease7 = typeof acquireResult7 === 'function' ? acquireResult7 : null;
      check('用例B6c: itTxnMutex真实acquire()在5s内成功拿到锁(锁未被这条open失败路径永久占用)', typeof acquireResult7 === 'function', typeof acquireResult7);
      if (acquiredRelease7) acquiredRelease7();

      // 一次性 throwaway 实例——open 从未成功过，没有真实句柄需要额外关闭；shutdown() 已跑过。
    }

    // 用例17R-H5③ 与其活体变异④（并发两次初始化经 publishGate/lifecycleGen 仲裁）已随代次仲裁
    //   机制一起删除——C1 串行化重构下不存在"两条初始化同时在途"这种场景：启动初始化是一次性闸门
    //   （一次只会有一条），重建恒在 itTxnMutex 内串行（同一时刻至多一个重建在跑），两者组合后
    //   "谁先谁后发布"这个问题本身不再存在，无需仲裁也无需测试仲裁。M2-② 在本节之前，已重写为 L5
    //   看门狗致命失败（见该用例）。

    // ══════════════════════════════════════════════════════════════════
    // 用例17R-M1（T2 增强）：初始化期连接故障——DDL 退避窗口内（用 ddlBusyInjection 让第一条 DDL
    //   先 BUSY 一次）手动 emit('error')，放行 DDL 后断言最终 ready=false、state.error 含
    //   "连接层错误"；另断言注入时的连接身份 ≠ 基线、此刻 counters 显示"处于 DDL 阶段"（这一轮
    //   已 opened 但尚未 published/superseded）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例17R-M1（T2 增强）：初始化期连接故障——DDL 退避窗口内（用 ddlBusyInjection 让第一条 DDL';
      const { setDdlBusyInjection, getLastOpenedDbForTest, getDbIdentity, getLifecycleCounters, reinitForTest, state } = itLedgerModule._internals;
      await withTimeout(reinitForTest(), 15000, '用例17R-M1: reinitForTest()起点干净'); // 17-R8T LOW-14回补
      const baselineDb = getDbIdentity();
      const countersBefore = getLifecycleCounters();

      // L6：非空注入同步返回"到达"信号——第一条DDL先BUSY一次，制造退避等待窗口，等到真正进入
      // setTimeout 退避的那一刻再动作，不靠猜 sleep 时长。C1 串行化重构：initSchema 一次性闸门
      // 早已在用例1/2 消耗过，这里改走 reinitForTest()（取锁重建路径）触发真实初始化。
      const backoffArrived = setDdlBusyInjection('CREATE it_assets', 1);
      // T1：创建时即接管拒绝。
      const initP = reinitForTest().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      await awaitArrived(backoffArrived, '用例17R-M1到达DDL退避窗口', initP);

      const midDb = getLastOpenedDbForTest();
      check('用例17R-M1准备: 拿到正在初始化中的连接引用', !!midDb);
      check('用例17R-M1(T2): 注入时的连接身份≠基线', midDb !== baselineDb);

      const countersMid = getLifecycleCounters();
      check('用例17R-M1(T2): counters显示处于DDL阶段(已opened但尚未published)',
        countersMid.opened - countersBefore.opened === 1 &&
        countersMid.published === countersBefore.published,
        JSON.stringify({ before: countersBefore, mid: countersMid }));

      if (midDb) midDb.emit('error', new Error('用例17R-M1手动模拟连接层error(退避窗口内)'));

      // 17-R8T M2回补：结构化结果显式断言——initP 恒 ok:true(reinitForTest本身不 reject，内部
      //   失败靠 state.ready/state.error 表达，不是抛错)，只有真正 reject（比如 LEDGER_DRAINING）
      //   才会走到 ok:false；本用例不该命中那条分支。
      const initSettleResult = await awaitSettle(initP, 5000, '用例17R-M1等待initP落定'); // 退避结束后 DDL 会放行重试，但 __faulted 已为 true，应据此中止
      check('用例17R-M1: initP结构化结果ok:true(reinitForTest本身未reject)', initSettleResult && initSettleResult.ok === true, JSON.stringify(initSettleResult));

      check('用例17R-M1: 最终ready=false', state.ready === false);
      check('用例17R-M1: state.error含"连接层错误"', /连接层错误/.test(state.error || ''), state.error);

      setDdlBusyInjection(null, 0);
      await withTimeout(reinitForTest(), 15000, '用例17R-M1: 复原reinitForTest()落定'); // 17-R8T LOW-14回补
      check('用例17R-M1: 复原后ready=true', itLedgerModule._internals.state.ready === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例B5：三处判据同源——重建失败态下，锁前快速拒绝（新请求直接命中）与锁后权威复核（已排队
    //   请求命中）拿到同一个错误码；都应与 requireLedgerReady 给出的码一致。
    //   S2 改造：不再直接裸调用内部 handleRollbackFailure（已不导出）——改用一个真实的 withWrite
    //   （注入 ROLLBACK 失败 + 重建打开失败）卡在 txnMidGate 上模拟"占锁期间才坏"的窗口，排队
    //   请求在这个真实 holder 释放锁之前就已经入队（此刻 itDb 还没故障，走的是正常排队路径，
    //   不受 B3 自愈 CAS 影响——CAS 只挡"故障已发生之后才到达"的请求）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例B5：三处判据同源——重建失败态下，锁前快速拒绝（新请求直接命中）与锁后权威复核（已排队';
      const { itTxnMutex, withRead, withWrite, setOpenDbFailureInjection, setRollbackFailureInjection, setTxnMidGate, reinitForTest, readinessError } = itLedgerModule._internals;

      let gateResolve;
      const arrived = setTxnMidGate(new Promise((r) => { gateResolve = r; }));
      setRollbackFailureInjection(true);
      setOpenDbFailureInjection(true);
      const holderPromise = withWrite(async () => {
        throw Object.assign(new Error('用例B5触发业务错误(经ROLLBACK失败+重建打开失败注入,模拟锁内重建失败)'), { status: 400, code: 'TEST_TRIGGER_B5' });
      }).catch((e) => ({ __err: e }));
      await awaitArrived(arrived, '用例B5-holder到达txnMidGate', holderPromise);

      const queuedPromise = withRead(async (q) => q.get('SELECT 1')).catch((e) => ({ __err: e }));
      let queuedOk = false;
      for (let i = 0; i < 100; i++) {
        if (itTxnMutex._internals.waiterCount() >= 1) { queuedOk = true; break; }
        await new Promise((r) => setTimeout(r, 5));
      }
      check('用例B5准备: 排队读请求确实已排队(waiterCount≥1，故障发生前就已入队)', queuedOk,
        `waiterCount=${itTxnMutex._internals.waiterCount()}`);

      setTxnMidGate(null);
      gateResolve(); // 放闸——holder 的 fn 抛错→ROLLBACK失败(注入)→重建打开也失败(注入)→模块UNAVAILABLE
      // codex 18预筛 MED-7回补：结构化结果显式断言——holderPromise 恒 resolve 到 {__err} 形态
      // （.catch 已接管拒绝），断言 __err 确实存在，证明 holder 的业务回调真的抛错触发了后续
      // ROLLBACK失败+重建打开失败注入链路，不是静默吞掉/提前正常结束。
      const holderResultB5 = await awaitSettle(holderPromise, 5000, '用例B5等待holderPromise落定');
      check('用例B5: holderPromise结构化结果含__err(业务回调确实抛错,触发了注入链路)',
        holderResultB5 && !!holderResultB5.__err, JSON.stringify(holderResultB5 && holderResultB5.__err && holderResultB5.__err.message));
      setOpenDbFailureInjection(false);
      setRollbackFailureInjection(false);

      const queuedResult = await awaitSettle(queuedPromise, 5000, '用例B5等待queuedPromise落定'); // 锁后权威复核拿到的码

      // 锁前快速拒绝：模块此刻已确定不可用（重建失败=终态,B2），新请求应立即在取锁前被拒。
      let preAcquireResult = null;
      try { await withRead(async (q) => q.get('SELECT 1')); } catch (e) { preAcquireResult = e; }

      const readinessCode = readinessError() && readinessError().code;
      check('用例B5: 锁前与锁后拿到同一个码',
        queuedResult.__err && preAcquireResult &&
        queuedResult.__err.code === preAcquireResult.code &&
        queuedResult.__err.code === readinessCode,
        JSON.stringify({ 锁后: queuedResult.__err && queuedResult.__err.code, 锁前: preAcquireResult && preAcquireResult.code, readinessError: readinessCode }));
      check('用例B5: 该码是LEDGER_UNAVAILABLE(非误判为NOT_READY)',
        queuedResult.__err && queuedResult.__err.code === 'LEDGER_UNAVAILABLE');

      await withTimeout(reinitForTest(), 15000, '用例B5: 复原reinitForTest()落定'); // 17-R8T LOW-14回补
      check('用例B5: 复原后state.ready=true', itLedgerModule._internals.state.ready === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例M1：取锁后再核——占锁→排入一读一写→锁内触发重建失败(注入)→放锁→两条排队请求都得到
    //   503 LEDGER_UNAVAILABLE，而不是碰到已置空的 itDb 炸出 500，也不是被误判成 LEDGER_BUSY。
    //   S2 改造：同用例B5，改走真实 holder + txnMidGate 触发（不再裸调用内部函数）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例M1：取锁后再核——占锁→排入一读一写→锁内触发重建失败(注入)→放锁→两条排队请求都得到';
      const { itTxnMutex, withRead, withWrite, setOpenDbFailureInjection, setRollbackFailureInjection, setTxnMidGate, reinitForTest } = itLedgerModule._internals;

      let gateResolve;
      const arrived = setTxnMidGate(new Promise((r) => { gateResolve = r; }));
      setRollbackFailureInjection(true);
      setOpenDbFailureInjection(true);
      const holderPromise = withWrite(async () => {
        throw Object.assign(new Error('用例M1触发业务错误(经ROLLBACK失败+重建打开失败注入,模拟锁内重建失败)'), { status: 400, code: 'TEST_TRIGGER_M1' });
      }).catch((e) => ({ __err: e }));
      await awaitArrived(arrived, '用例M1-holder到达txnMidGate', holderPromise);

      const readPromise = withRead(async (q) => q.get('SELECT 1')).catch((e) => ({ __err: e }));
      const writePromise = withWrite(async (q) => { await q.get('SELECT 1'); return 'should-not-reach'; }).catch((e) => ({ __err: e }));
      let queuedOk = false;
      for (let i = 0; i < 100; i++) {
        if (itTxnMutex._internals.waiterCount() >= 2) { queuedOk = true; break; }
        await new Promise((r) => setTimeout(r, 5));
      }
      check('用例M1准备: 排队的读写请求确实都已排队(waiterCount≥2)', queuedOk,
        `waiterCount=${itTxnMutex._internals.waiterCount()}`);

      setTxnMidGate(null);
      gateResolve(); // 放闸——holder 走完整条失败链路，随后排队的读写依次拿到锁
      // codex 18预筛 MED-7回补：同用例B5——显式断言holderPromise结构化结果含__err。
      const holderResultM1 = await awaitSettle(holderPromise, 5000, '用例M1等待holderPromise落定');
      check('用例M1: holderPromise结构化结果含__err(业务回调确实抛错,触发了注入链路)',
        holderResultM1 && !!holderResultM1.__err, JSON.stringify(holderResultM1 && holderResultM1.__err && holderResultM1.__err.message));
      setOpenDbFailureInjection(false);
      setRollbackFailureInjection(false);

      const [readResult, writeResult] = await awaitSettle(Promise.all([readPromise, writePromise]), 5000, '用例M1等待读写请求Promise.all落定');
      check('用例M1: 排队中的读请求得到503 LEDGER_UNAVAILABLE(非500/非BUSY)',
        readResult.__err && readResult.__err.status === 503 && readResult.__err.code === 'LEDGER_UNAVAILABLE',
        JSON.stringify(readResult.__err && { status: readResult.__err.status, code: readResult.__err.code }));
      check('用例M1: 排队中的写请求得到503 LEDGER_UNAVAILABLE(非500/非BUSY)',
        writeResult.__err && writeResult.__err.status === 503 && writeResult.__err.code === 'LEDGER_UNAVAILABLE',
        JSON.stringify(writeResult.__err && { status: writeResult.__err.status, code: writeResult.__err.code }));

      await withTimeout(reinitForTest(), 15000, '用例M1: 复原reinitForTest()落定'); // 17-R8T LOW-14回补
      check('用例M1: 复原后state.ready=true', itLedgerModule._internals.state.ready === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例5：ACL 三端点正向 + 非admin 403 + level非法400 + 不存在404 + 目标admin400
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例5：ACL 三端点正向 + 非admin 403 + level非法400 + 不存在404 + 目标admin400';
      let r = await api('GET', '/api/it-assets/acl', { uid: 2, role: 'user' });
      check('用例5: 非admin GET /acl 403', r.status === 403);
      r = await api('PUT', '/api/it-assets/acl/2', { uid: 2, role: 'user', body: { level: 'write' } });
      check('用例5: 非admin PUT /acl 403', r.status === 403);
      r = await api('DELETE', '/api/it-assets/acl/2', { uid: 2, role: 'user' });
      check('用例5: 非admin DELETE /acl 403', r.status === 403);

      r = await api('PUT', '/api/it-assets/acl/2', { uid: 1, role: 'admin', body: { level: 'bogus' } });
      check('用例5: level非法400', r.status === 400 && r.body.code === 'LEDGER_INVALID_LEVEL');

      r = await api('PUT', '/api/it-assets/acl/9999', { uid: 1, role: 'admin', body: { level: 'read' } });
      check('用例5: userId不存在404', r.status === 404 && r.body.code === 'LEDGER_USER_NOT_FOUND');

      r = await api('PUT', '/api/it-assets/acl/1', { uid: 1, role: 'admin', body: { level: 'read' } });
      check('用例5: 目标admin400', r.status === 400 && r.body.code === 'LEDGER_TARGET_IS_ADMIN');

      r = await api('PUT', '/api/it-assets/acl/2', { uid: 1, role: 'admin', body: { level: 'write' } });
      check('用例5: 授予alice write 200', r.status === 200 && r.body.level === 'write');
      let evt = await queryLastEventByUserId('acl_grant', 2);
      check('用例5: alice授予事件action=acl_grant', evt && evt.action === 'acl_grant');
      check('用例5: alice授予事件asset_id NULL', evt && evt.asset_id === null);
      check('用例5: alice授予事件from={} to={user_id,level}',
        evt && Object.keys(JSON.parse(evt.from_state)).length === 0 &&
        JSON.stringify(JSON.parse(evt.to_state)) === JSON.stringify({ user_id: 2, level: 'write' }));

      r = await api('PUT', '/api/it-assets/acl/3', { uid: 1, role: 'admin', body: { level: 'read' } });
      check('用例5: 授予bob read 200', r.status === 200 && r.body.level === 'read');

      r = await api('PUT', '/api/it-assets/acl/2', { uid: 1, role: 'admin', body: { level: 'read' } });
      check('用例5: 变更alice为read 200', r.status === 200);
      evt = await queryLastEventByUserId('acl_grant', 2);
      check('用例5: 变更事件from非空(旧level=write)',
        JSON.stringify(JSON.parse(evt.from_state)) === JSON.stringify({ user_id: 2, level: 'write' }));

      r = await api('PUT', '/api/it-assets/acl/2', { uid: 1, role: 'admin', body: { level: 'write' } });
      check('用例5: 改回alice write 200(供后续用例使用)', r.status === 200);

      r = await api('GET', '/api/it-assets/acl', { uid: 1, role: 'admin' });
      check('用例5: GET /acl 含alice与bob',
        r.status === 200 && r.body.items.some((i) => i.user_id === 2) && r.body.items.some((i) => i.user_id === 3));

      r = await api('DELETE', '/api/it-assets/acl/9999', { uid: 1, role: 'admin' });
      check('用例5: DELETE不存在404', r.status === 404 && r.body.code === 'LEDGER_ACL_NOT_FOUND');

      r = await api('PUT', '/api/it-assets/acl/4', { uid: 1, role: 'admin', body: { level: 'read' } });
      check('用例5: 临时授予carol read 200', r.status === 200);
      r = await api('DELETE', '/api/it-assets/acl/4', { uid: 1, role: 'admin' });
      check('用例5: DELETE carol 200', r.status === 200 && r.body.ok === true);
      evt = await queryLastEventByUserId('acl_revoke', 4);
      check('用例5: carol撤销事件action=acl_revoke to={}',
        evt && evt.action === 'acl_revoke' && Object.keys(JSON.parse(evt.to_state)).length === 0);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例3：/me 四态
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例3：/me 四态';
      let r = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
      check('用例3: admin level=admin 含expiring_count', r.status === 200 && r.body.level === 'admin' && 'expiring_count' in r.body);

      r = await api('GET', '/api/it-assets/me', { uid: 4, role: 'user' }); // carol 无ACL
      check('用例3: 无ACL level=null 且无expiring_count', r.status === 200 && r.body.level === null && !('expiring_count' in r.body));

      r = await api('GET', '/api/it-assets/me', { uid: 3, role: 'user' }); // bob read
      check('用例3: bob level=read 含expiring_count', r.status === 200 && r.body.level === 'read' && 'expiring_count' in r.body);

      r = await api('GET', '/api/it-assets/me', { uid: 2, role: 'user' }); // alice write
      check('用例3: alice level=write 含expiring_count', r.status === 200 && r.body.level === 'write' && 'expiring_count' in r.body);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例4：读/写守卫403矩阵（白盒调用中间件——C1 除 ACL 三端点与 /me 外无其它路由）
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例4：读/写守卫403矩阵（白盒调用中间件——C1 除 ACL 三端点与 /me 外无其它路由）';
      const { requireLedgerRead, requireLedgerWrite } = itLedgerModule._internals;
      let r = await callMiddleware(requireLedgerRead, 5, 'user'); // dave 无ACL
      check('用例4: 无ACL读403', r.status === 403 && !r.nextCalled);

      r = await callMiddleware(requireLedgerWrite, 3, 'user'); // bob read用户写
      check('用例4: read用户写403', r.status === 403 && !r.nextCalled);

      r = await callMiddleware(requireLedgerWrite, 2, 'user'); // alice write用户写
      check('用例4: write用户写放行', r.nextCalled === true);

      r = await callMiddleware(requireLedgerWrite, 1, 'admin'); // admin写
      check('用例4: admin写放行', r.nextCalled === true);

      r = await callMiddleware(requireLedgerRead, 3, 'user'); // bob read用户读
      check('用例4: read用户读放行', r.nextCalled === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例6：锁内终判 — 占住锁→排入write用户的写→排队期间撤销ACL→放锁→该写403
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例6：锁内终判 — 占住锁→排入write用户的写→排队期间撤销ACL→放锁→该写403';
      const result = await checkLockedFinalAuthScenario();
      check('用例6: 排队期间撤权后该写403 LEDGER_FORBIDDEN(终判起作用)',
        result.ok === false && result.hitTarget === true && result.otherErr === null, JSON.stringify(result));
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例7：并发恰一成功
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例7：并发恰一成功';
      const { withWrite } = itLedgerModule._internals;
      const testUserId = 6; // erin
      async function tryInsert() {
        return withWrite(async (q) => {
          const existing = await q.get('SELECT user_id FROM it_asset_acl WHERE user_id=?', [testUserId]);
          if (existing) { const e = new Error('已存在'); e.status = 409; e.code = 'DUP_TEST'; throw e; }
          await q.run(`INSERT INTO it_asset_acl (user_id, level, granted_by, created_at) VALUES (?,?,?,datetime('now','localtime'))`, [testUserId, 'read', 1]);
          return { ok: true };
        }).catch((err) => ({ __err: err }));
      }
      const [r1, r2] = await awaitSettle(Promise.all([tryInsert(), tryInsert()]), 5000, '用例7等待并发写入Promise.all落定');
      const successes = [r1, r2].filter((r) => r.ok === true).length;
      const conflicts = [r1, r2].filter((r) => r.__err && r.__err.status === 409).length;
      check('用例7: 并发恰一成功一409', successes === 1 && conflicts === 1, JSON.stringify([r1, r2]));
      await withWrite(async (q) => { await q.run('DELETE FROM it_asset_acl WHERE user_id=?', [testUserId]); });
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例8：读隔离（mutex 使读写严格互斥，覆盖提交与回滚两种结局）
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例8：读隔离（mutex 使读写严格互斥，覆盖提交与回滚两种结局）';
      const { withWrite, withRead, itTxnMutex } = itLedgerModule._internals;
      await withWrite(async (q) => { await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (901, 'TEST-A', 0)`); });

      // L4（17-R3 M，取代 T5 的"睡5ms猜时序"轮询）：写事务回调自己在第一次 UPDATE 完成后立即
      // resolve 一个本地 arrived Promise——不需要碰生产代码（回调本身就是测试脚本传入的，闸和
      // 到达信号都是脚本自己控制的局部变量），测试用 awaitArrived（套超时）等这个信号就能确定
      // "写已经真的拿到锁且跑完第一条 UPDATE"，不用反复轮询 isLocked()。发读之后仍用
      // waiterCount() 确认它已经真的排进等待队列（这一步不是猜时序，是直接读 mutex 内部状态）。

      // 提交结局：两次UPDATE之间卡闸，确认读已排队等锁后再放闸，读只能拿到写完成后的终值。
      let arrivedResolve1;
      const arrived1 = new Promise((r) => { arrivedResolve1 = r; });
      let midGateResolve1;
      const midGate1 = new Promise((r) => { midGateResolve1 = r; });
      // T1：创建时即接管拒绝。
      const writeP = withWrite(async (q) => {
        await q.run(`UPDATE it_racks SET sort_order=1 WHERE id=901`);
        arrivedResolve1(); // 第一次 UPDATE 已完成，通知测试可以发读了
        await midGate1; // 卡住，直到脚本确认读已入队
        await q.run(`UPDATE it_racks SET sort_order=2 WHERE id=901`);
        return 'committed';
      }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      await awaitArrived(arrived1, '用例8-提交到达第一次UPDATE后', writeP);
      const readP = withRead((q) => q.get('SELECT sort_order FROM it_racks WHERE id=901'))
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); // T1：创建时即接管拒绝
      // 确认读请求已经真的排进等待队列（此刻写事务卡在 midGate1 上，锁被占着，读只能排队）。
      let readQueuedOk = false;
      for (let i = 0; i < 100; i++) {
        if (itTxnMutex._internals.waiterCount() >= 1) { readQueuedOk = true; break; }
        await new Promise((r) => setTimeout(r, 5));
      }
      check('用例8-提交(L4): 读请求确实已排队等锁(waiterCount≥1)后才放闸', readQueuedOk);
      midGateResolve1(); // 确认读已排队后才放闸，写事务继续
      // T1：Promise.all 也必须套超时，不能裸等。
      const [writeResult, readResult1] = await awaitSettle(Promise.all([writeP, readP]), 5000, '用例8-提交等待Promise.all落定');
      check('用例8-提交: 写事务提交成功', writeResult.ok === true && writeResult.v === 'committed', JSON.stringify(writeResult));
      check('用例8-提交: 读隔离(mutex使读排在写完成之后，只能读到提交后终值2，绝不可能是中间值1)',
        readResult1.ok === true && readResult1.v && readResult1.v.sort_order === 2, JSON.stringify(readResult1));

      // 回滚结局：两次UPDATE后抛错触发ROLLBACK，同样用arrived信号+waiterCount确认时序。
      let arrivedResolve2;
      const arrived2 = new Promise((r) => { arrivedResolve2 = r; });
      let midGateResolve2;
      const midGate2 = new Promise((r) => { midGateResolve2 = r; });
      const writeP2 = withWrite(async (q) => {
        await q.run(`UPDATE it_racks SET sort_order=10 WHERE id=901`);
        arrivedResolve2();
        await midGate2;
        await q.run(`UPDATE it_racks SET sort_order=20 WHERE id=901`);
        throw Object.assign(new Error('用例8强制回滚'), { status: 400, code: 'TEST_FORCE_ROLLBACK' });
      }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); // T1：创建时即接管拒绝
      await awaitArrived(arrived2, '用例8-回滚到达第一次UPDATE后', writeP2);
      const readP2 = withRead((q) => q.get('SELECT sort_order FROM it_racks WHERE id=901'))
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      let readQueuedOk2 = false;
      for (let i = 0; i < 100; i++) {
        if (itTxnMutex._internals.waiterCount() >= 1) { readQueuedOk2 = true; break; }
        await new Promise((r) => setTimeout(r, 5));
      }
      check('用例8-回滚(L4): 读请求确实已排队等锁(waiterCount≥1)后才放闸', readQueuedOk2);
      midGateResolve2();
      const [w2, readResult2] = await awaitSettle(Promise.all([writeP2, readP2]), 5000, '用例8-回滚等待Promise.all落定');
      check('用例8-回滚: 写事务确实按预期抛错回滚', !w2.ok && w2.e && w2.e.code === 'TEST_FORCE_ROLLBACK');
      check('用例8-回滚: 读隔离(读排在回滚完成之后，只能读到回滚后的终值2，绝不可能是中间值10/20)',
        readResult2.ok === true && readResult2.v && readResult2.v.sort_order === 2, JSON.stringify(readResult2));

      await withWrite(async (q) => { await q.run('DELETE FROM it_racks WHERE id=901'); });
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例9：跨连接（按方案 §2.1 实测事实设计）
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例9：跨连接（按方案 §2.1 实测事实设计）';
      const { withWrite, withRead, setBusyTimeout } = itLedgerModule._internals;
      await setBusyTimeout(300);

      // T7（本轮 codex 17-R2 必修）：db2/db3 是持真实文件锁的原生连接——9a 段里 withWrite/
      //   withRead 若意外抛出未被内层 try 捕获的错误，若不进 finally 释放，db2 的 SHARED 锁会
      //   一直卡到进程退出，拖死本文件后面所有用例（谁都碰不了这个 db 文件）。两段都收进
      //   try/finally，finally 里 best-effort ROLLBACK+close，不因为 ROLLBACK 本身失败而抛出
      //   新错误盖掉原始断言失败原因。
      const db2 = new sqlite3.Database(TEST_DB);
      try {
        await new Promise((resolve, reject) => db2.run('BEGIN', (err) => (err ? reject(err) : resolve())));
        await new Promise((resolve, reject) => db2.get('SELECT COUNT(*) AS c FROM it_racks', (err) => (err ? reject(err) : resolve())));
        // db2 此刻持 SHARED 读事务不放（未 COMMIT/ROLLBACK）

        let caught = null;
        try {
          await withWrite(async (q) => { await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (903, 'CROSSCONN', 0)`); });
        } catch (err) { caught = err; }
        check('用例9a: 跨连接COMMIT遇对端SHARED读→503 LEDGER_BUSY',
          caught && caught.status === 503 && caught.code === 'LEDGER_BUSY', JSON.stringify(caught && { status: caught.status, code: caught.code }));
        // 小项：精确断言这次503确实走的是路径3(COMMIT失败)而不是路径1(BEGIN失败)——只看响应码
        // 无法区分两条不同的错误路径，路径直接挂在抛出的错误对象上（e.busyPath），不再靠共享变量。
        check('用例9a: 精确走的是路径3(COMMIT)而非路径1(BEGIN)', caught && caught.busyPath === 'commit', `caught.busyPath=${caught && caught.busyPath}`);

        const rowAfter = await withRead((q) => q.get('SELECT * FROM it_racks WHERE id=903'));
        check('用例9a: 事务完整回滚(无该行)', !rowAfter);
      } finally {
        await new Promise((resolve) => db2.run('ROLLBACK', () => resolve()));
        await new Promise((resolve) => db2.close(() => resolve()));
      }

      await withWrite(async (q) => { await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (903, 'CROSSCONN', 0)`); });
      const rowAfter2 = await withRead((q) => q.get('SELECT * FROM it_racks WHERE id=903'));
      check('用例9a: 释放SHARED后同样的写成功', !!rowAfter2);
      await withWrite(async (q) => { await q.run('DELETE FROM it_racks WHERE id=903'); });

      // 9b：两端各做短事务交替，双方都提交成功
      const db3 = new sqlite3.Database(TEST_DB);
      try {
        await new Promise((resolve, reject) => db3.run('PRAGMA busy_timeout=300', (err) => (err ? reject(err) : resolve())));
        function db3Run(sql, params) {
          return new Promise((resolve, reject) => db3.run(sql, params || [], function (err) { err ? reject(err) : resolve(this); }));
        }
        let bothOk = true;
        try {
          await withWrite(async (q) => { await q.run(`INSERT INTO it_racks (id,name,sort_order) VALUES (904,'A1',0)`); });
          await db3Run('BEGIN IMMEDIATE');
          await db3Run(`INSERT INTO it_racks (id,name,sort_order) VALUES (905,'B1',0)`);
          await db3Run('COMMIT');
          await withWrite(async (q) => { await q.run(`INSERT INTO it_racks (id,name,sort_order) VALUES (906,'A2',0)`); });
        } catch (e) { bothOk = false; }
        check('用例9b: 两端短事务交替均提交成功', bothOk);
      } finally {
        await new Promise((resolve) => db3.close(() => resolve()));
      }
      await withWrite(async (q) => { await q.run('DELETE FROM it_racks WHERE id IN (904,905,906)'); });

      await setBusyTimeout(5000);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例T3（HIGH·codex 17-R2 测试轮）：BEGIN 忙不得 ROLLBACK——路径1（BEGIN IMMEDIATE 失败）
    //   明文规定"不执行 ROLLBACK"（方案 §6），本用例用第二原生连接真实持写锁逼平这条路径，
    //   逐项验证：503 LEDGER_BUSY、busyPath==='begin'、业务回调完全未执行、连接身份不变、
    //   execRollback 一次都没被调用；释放锁后恢复正常写。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例T3（HIGH·codex 17-R2 测试轮）：BEGIN 忙不得 ROLLBACK——路径1（BEGIN IMMEDIATE 失败）';
      const { withWrite, setBusyTimeout, getDbIdentity, getRollbackCallCount } = itLedgerModule._internals;
      await setBusyTimeout(300);

      // T7：db4 持真实 RESERVED 写锁——同样的道理，收进 try/finally 防止内部断言/withWrite
      // 意外抛出时锁不释放，拖死后面所有用例。
      const db4 = new sqlite3.Database(TEST_DB);
      try {
        await new Promise((resolve, reject) => db4.run('BEGIN IMMEDIATE', (err) => (err ? reject(err) : resolve())));
        // db4 持有真实的写锁（RESERVED）不放——本模块的 BEGIN IMMEDIATE 会在这把锁上真实等待到
        // busy_timeout（不是注入，是 SQLite 真实文件锁竞争）。

        const dbBefore = getDbIdentity();
        const rollbackCountBefore = getRollbackCallCount();
        let bizExecuted = false;
        let caught = null;
        try {
          await withWrite(async (q) => {
            bizExecuted = true; // 若真的跑到这里说明 BEGIN 居然成功了，本用例的前提就不成立
            await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (909, 'T3', 0)`);
          });
        } catch (err) { caught = err; }

        check('用例T3: BEGIN忙时返回503 LEDGER_BUSY',
          caught && caught.status === 503 && caught.code === 'LEDGER_BUSY', JSON.stringify(caught && { status: caught.status, code: caught.code }));
        check('用例T3: busyPath==="begin"', caught && caught.busyPath === 'begin', caught && caught.busyPath);
        check('用例T3: 业务回调完全未执行', bizExecuted === false);
        check('用例T3: 连接身份不变', getDbIdentity() === dbBefore);
        check('用例T3: 未发ROLLBACK(execRollback调用次数不变)',
          getRollbackCallCount() === rollbackCountBefore, `before=${rollbackCountBefore} after=${getRollbackCallCount()}`);
      } finally {
        await new Promise((resolve) => db4.run('ROLLBACK', () => resolve()));
        await new Promise((resolve) => db4.close(() => resolve()));
      }
      await setBusyTimeout(5000);

      let followUpOk = true;
      try {
        await withWrite(async (q) => { await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (909, 'T3', 0)`); });
      } catch (e) { followUpOk = false; }
      check('用例T3: 释放锁后正常写成功', followUpOk);
      await withWrite(async (q) => { await q.run('DELETE FROM it_racks WHERE id=909'); });
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例L1（C1 串行化重构新增，T6 重写）：事务绑定连接——BEGIN 成功、业务回调开始之前卡在
    //   setTxnMidGate 闸上，对当前 itDb 手动 emit('error')（模拟服务期连接层故障——监听器只
    //   标记 __faulted / 置 state 不可用 / fire-and-forget 排一次锁内自愈重建，不摘除 itDb、
    //   不关闭连接，理由见 routes/it-ledger/index.js 的 openItDb 注释）→ 放闸 → 业务回调继续
    //   执行：connTrace 现在记录 {op, sql, connId}——按 op 精确定位 BEGIN / 目标 INSERT（按
    //   sql 文本匹配，不是笼统数 run 出现几次）/ COMMIT 三步，断言三者都存在、相对顺序正确、
    //   connId 全等且 === BEGIN 时捕获的那条，不因为全局状态被标记故障就中途切换/中断。
    //   emit('error') 触发的自愈重建此刻已经排进了 itTxnMutex 队列（L1 自己的 withWrite 还
    //   持着锁），事务提交、锁释放之后它才真正执行——用 lifecycleCounters.published 增量 +
    //   withTimeout 等它真正发布完成，而不是指望"下一个请求"去触发。末尾加活体变异：闸内
    //   setSwapGlobalItDbForTest 把全局 itDb 换成另一条连接——若实现退化成读全局 itDb 而非
    //   绑定的 conn，connTrace 会出现第二个连接 id，判红；交换连接场景下用独立原生连接确认
    //   913 已提交后再清理，不止信任 withWrite 返回值。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例L1（C1 串行化重构新增，T6 重写）：事务绑定连接——BEGIN 成功、业务回调开始之前卡在';
      const {
        withWrite, setTxnMidGate, getDbIdentity, getConnTrace, clearConnTrace,
        setSwapGlobalItDbForTest, getLifecycleCounters, state,
      } = itLedgerModule._internals;
      const dbBefore = getDbIdentity();
      const countersBefore = getLifecycleCounters();

      clearConnTrace();
      let gateResolve;
      const arrived = setTxnMidGate(new Promise((r) => { gateResolve = r; }));
      // T1：创建时即接管拒绝——writeP 本身不再可能裸 reject，后续只需 await 它的落定结果。
      const writeP = withWrite(async (q) => {
        await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (910, 'L1', 0)`);
        return 'committed';
      }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      await awaitArrived(arrived, '用例L1到达txnMidGate', writeP);
      check('用例L1准备: BEGIN已完成后卡在闸内，全局itDb仍是事务绑定的那条', getDbIdentity() === dbBefore);
      dbBefore.emit('error', new Error('用例L1手动模拟服务期连接层故障(事务中途)')); // 同步排队一次锁内自愈重建
      check('用例L1: emit(error)后itDb未被摘除(仍是同一对象,只是标记__faulted)', getDbIdentity() === dbBefore);
      check('用例L1: emit(error)后state.ready=false(服务期故障已反映到state)', state.ready === false);

      setTxnMidGate(null);
      gateResolve(); // 放闸——业务回调继续执行，用的是 BEGIN 时捕获的 conn（不重新读被标记故障的全局 itDb）
      const result = await awaitSettle(writeP, 5000, '用例L1等待writeP落定');
      check('用例L1: 事务绑定连接不受中途状态翻转影响，正常提交成功(未跨连接/未中断)',
        result.ok === true && result.v === 'committed', JSON.stringify(result));

      // T6：按 op 精确定位 BEGIN / 目标 INSERT（按 sql 文本匹配）/ COMMIT 三步，而不是笼统看
      // "至少3条 run"——顺序与 connId 一致性都要求全部满足。
      const trace = getConnTrace();
      const beginIdx = trace.findIndex((t) => t.op === 'BEGIN');
      const insertIdx = trace.findIndex((t) => t.op === 'run' && /INSERT INTO it_racks/.test(t.sql || ''));
      const commitIdx = trace.findIndex((t) => t.op === 'COMMIT');
      check('用例L1(T6): connTrace定位到BEGIN/目标INSERT/COMMIT三步都存在',
        beginIdx >= 0 && insertIdx >= 0 && commitIdx >= 0, JSON.stringify(trace));
      check('用例L1(T6): 三步相对顺序正确(BEGIN < INSERT < COMMIT)',
        beginIdx >= 0 && insertIdx >= 0 && commitIdx >= 0 && beginIdx < insertIdx && insertIdx < commitIdx,
        JSON.stringify({ beginIdx, insertIdx, commitIdx }));
      check('用例L1(T6): 三步connId全等且===捕获连接id(dbBefore.__id)',
        beginIdx >= 0 && insertIdx >= 0 && commitIdx >= 0 &&
        trace[beginIdx].connId === dbBefore.__id &&
        trace[insertIdx].connId === dbBefore.__id &&
        trace[commitIdx].connId === dbBefore.__id,
        JSON.stringify({ trace, expected: dbBefore.__id }));

      const rowAfter = await rawAll('SELECT * FROM it_racks WHERE id=910');
      check('用例L1: 事务确实落库(绑定连接完整提交了这一行)', rowAfter.length === 1, JSON.stringify(rowAfter));
      await rawRun('DELETE FROM it_racks WHERE id=910');

      // L1 自己的事务已经提交、锁已释放——emit('error') 排队的自愈重建这才真正开始执行。
      await waitForPublishedIncrement(countersBefore, '用例L1等待事务提交后锁内自愈重建发布');
      const dbAfterHeal = getDbIdentity();
      check('用例L1: 自愈重建后连接对象已更换(新itDb≠故障前旧itDb)', dbAfterHeal !== dbBefore && dbAfterHeal !== null);
      const probe3 = await probeClosedDb(dbBefore);
      check('用例L1(T4): 旧连接关闭态探针命中(故障前那条连接确实已被关闭)',
        probe3.ok === true && probe3.closed === true, JSON.stringify(probe3));

      const r2 = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
      check('用例L1: 重建发布之后新请求放行(200)', r2.status === 200, JSON.stringify(r2));

      // T6 活体变异：闸内把全局 itDb 换成第二条连接——正确实现下 q 绑定的仍是 BEGIN 时捕获的
      // conn，connTrace 不应出现变异连接的 id；变异结束在 finally 里复原（关闭变异连接、把
      // 全局 itDb 恢复成 dbAfterHeal，不让污染扩散到后续用例）。
      const mutantDb = new sqlite3.Database(TEST_DB);
      try {
        clearConnTrace();
        const dbBefore2 = getDbIdentity();
        let gateResolve2;
        const arrived2 = setTxnMidGate(new Promise((r) => { gateResolve2 = r; }));
        // T1：创建时即接管拒绝。
        const writeP2 = withWrite(async (q) => {
          await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (913, 'L1MUT', 0)`);
          return 'committed';
        }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
        await awaitArrived(arrived2, '用例L1变异到达txnMidGate', writeP2);
        setSwapGlobalItDbForTest(mutantDb); // 变异：把全局 itDb 临时换成另一条连接
        setTxnMidGate(null);
        gateResolve2();
        const mutResult = await awaitSettle(writeP2, 5000, '用例L1变异等待writeP2落定');

        const trace2 = getConnTrace();
        const ids2 = new Set(trace2.map((t) => t.connId));
        check('用例L1变异(T6): connTrace未出现变异连接id(证明q绑定的是捕获的conn,不是误读全局itDb)',
          ids2.size === 1 && ids2.has(dbBefore2.__id) && !ids2.has(mutantDb.__id),
          JSON.stringify({ trace2, dbBefore2Id: dbBefore2.__id, mutantId: mutantDb.__id }));
        check('用例L1变异(T6): 事务仍在原连接上正常提交成功(未受swap影响)',
          mutResult.ok === true && mutResult.v === 'committed', JSON.stringify(mutResult));

        // T6：交换连接场景用独立原生连接确认 913 已提交，再清理——不止信任 withWrite 的返回值。
        const row913 = await rawAll('SELECT * FROM it_racks WHERE id=913');
        check('用例L1变异(T6): 独立连接核实913确实已提交', row913.length === 1, JSON.stringify(row913));
        await rawRun('DELETE FROM it_racks WHERE id=913');
      } finally {
        setSwapGlobalItDbForTest(dbAfterHeal); // 复原全局 itDb，不让变异污染扩散到后续用例
        setTxnMidGate(null);
        await new Promise((resolve) => mutantDb.close(() => resolve()));
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例10：ROLLBACK 失败注入 → 503 LEDGER_UNAVAILABLE → 重建后恢复
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例10：ROLLBACK 失败注入 → 503 LEDGER_UNAVAILABLE → 重建后恢复';
      // M4（本轮措辞修正，codex 17-R）：handleRollbackFailure 是同步 await 链，withWrite 抛出
      // 503 LEDGER_UNAVAILABLE 的那一刻，重建其实已经跑完——准确措辞是"触发请求返回后，后续
      // 请求立即成功"（不是笼统的"无可观测不可用窗口"，那句话在并发场景下不成立——见新增用例
      // H5②/③/M2②：其他并发请求在重建过程中仍可能看到短暂 503）。删掉原先的恒真轮询（重建早
      // 在断言执行前就已完成，轮询第一次就会命中，属于测不出问题的伪断言），改为直接断言：
      // 连接对象已被替换（新 itDb ≠ 旧 itDb）+ 触发请求返回后，后续请求立即成功。
      const { withWrite, setRollbackFailureInjection, state, getDbIdentity } = itLedgerModule._internals;
      const dbBefore = getDbIdentity();
      setRollbackFailureInjection(true);
      let caught = null;
      try {
        await withWrite(async () => {
          throw Object.assign(new Error('用例10触发业务错误'), { status: 400, code: 'TEST_TRIGGER' });
        });
      } catch (err) { caught = err; }
      setRollbackFailureInjection(false);
      check('用例10: ROLLBACK失败注入后返回503 LEDGER_UNAVAILABLE',
        caught && caught.status === 503 && caught.code === 'LEDGER_UNAVAILABLE', JSON.stringify(caught && { status: caught.status, code: caught.code }));
      check('用例10: 抛错返回的同一时刻state.ready已是重建后的最终结果(true)', state.ready === true);
      check('用例10: 连接对象已被替换(新itDb≠旧itDb)', getDbIdentity() !== dbBefore && getDbIdentity() !== null);
      const r2 = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
      check('用例10: 触发请求返回后，后续请求立即成功', r2.status === 200, JSON.stringify(r2));
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例10b：ROLLBACK "事务已不存在" 豁免（方案 §6 路径3 精确条件——非无条件 ROLLBACK）。
    //   M4（主会话 2026-09-18 修正）：路径2 改为真实路径——业务回调内先 `q.run('ROLLBACK')`
    //   真正结束事务，再抛业务错误，让生产 execRollback 自己撞到**真实**的
    //   "cannot rollback - no transaction is active"，不再靠 rollbackFailure='no_txn' 注入伪造
    //   错误消息（伪造消息不会让 SQLite 真的结束事务，此前靠 forceRawRollback 擦屁股——已删除该
    //   函数，改让业务回调自己负责把事务收尾，测的是生产分支的真实行为而非"消息匹配"这一层皮）。
    //   路径3（COMMIT 遇忙）保留注入版——因为"COMMIT 因对端 SHARED 读锁 BUSY 失败"这一真实场景下
    //   事务其实仍然存活（BUSY 不会让 SQLite 自动结束事务），构造不出"COMMIT 真忙 + 事务真的已经
    //   不存在"这个自然组合；这里注入只是单独覆盖 execRollback 里"消息匹配"这一个分支本身，
    //   不代表这个精确组合会在生产中发生，用例名标注清楚。注入会让真实事务遗留在 itDb 上，改用
    //   `_internals.reinitForTest()` 强制重连收尾（不再用已删除的 forceRawRollback）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例10b：ROLLBACK "事务已不存在" 豁免（方案 §6 路径3 精确条件——非无条件 ROLLBACK）。';
      const { withWrite, withRead, setRollbackFailureInjection, setBusyTimeout, state, getDbIdentity, reinitForTest } = itLedgerModule._internals;

      // 路径2（真实路径）：业务回调自己先真实 ROLLBACK 结束事务，再抛业务错误 → execRollback
      //   的 dbRun('ROLLBACK') 撞到真实的 no-transaction 错误 → 命中豁免（不抛）→ 原业务错误原样透传
      {
        const dbBefore = getDbIdentity();
        let caught = null;
        try {
          await withWrite(async (q) => {
            await q.run('ROLLBACK'); // 真实结束事务（模拟 SQLITE_FULL 等场景下 SQLite 自动收尾）
            throw Object.assign(new Error('用例10b路径2触发业务错误'), { status: 409, code: 'TEST_TRIGGER_10B_P2' });
          });
        } catch (err) { caught = err; }
        check('用例10b-路径2(真实路径): no_txn豁免后仍是原业务错误码(非LEDGER_UNAVAILABLE)',
          caught && caught.status === 409 && caught.code === 'TEST_TRIGGER_10B_P2',
          JSON.stringify(caught && { status: caught.status, code: caught.code }));
        check('用例10b-路径2(真实路径): state.ready仍为true(未被误判为路径4致命错误)', state.ready === true);
        check('用例10b-路径2(真实路径): 连接对象未被替换', getDbIdentity() === dbBefore);
        // 事务已经被业务回调真实结束，无残留挂起事务，无需 forceRawRollback 之类的清理。
        let followUpOk = true;
        try { await withWrite(async (q) => { await q.get('SELECT 1'); }); } catch (e) { followUpOk = false; }
        check('用例10b-路径2(真实路径): 后续正常写成功', followUpOk);
      }

      // 路径3（注入·覆盖边界=消息分支）：COMMIT 遇对端持 SHARED 读锁 BUSY 是真实失败，但这个
      //   真实失败不会让事务消失；"no_txn"消息在此仅用于单独覆盖 execRollback 的分支判定本身。
      {
        await setBusyTimeout(300);
        const dbBefore = getDbIdentity();
        // T7：db2 与 setRollbackFailureInjection 都是"必须复原"的外部状态——收进 try/finally，
        // 防止中间任何一步意外抛出时，锁不放、注入标志不清，污染本文件后面所有用例。
        const db2 = new sqlite3.Database(TEST_DB);
        try {
          await new Promise((resolve, reject) => db2.run('BEGIN', (err) => (err ? reject(err) : resolve())));
          await new Promise((resolve, reject) => db2.get('SELECT COUNT(*) AS c FROM it_racks', (err) => (err ? reject(err) : resolve())));

          setRollbackFailureInjection('no_txn');
          let caught = null;
          try {
            await withWrite(async (q) => { await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (907, 'T10B-P3', 0)`); });
          } catch (err) { caught = err; }
          check('用例10b-路径3(注入·覆盖边界=消息分支): no_txn豁免后仍是503 LEDGER_BUSY(非LEDGER_UNAVAILABLE)',
            caught && caught.status === 503 && caught.code === 'LEDGER_BUSY',
            JSON.stringify(caught && { status: caught.status, code: caught.code }));
          check('用例10b-路径3(注入·覆盖边界=消息分支): state.ready仍为true(未被误判为路径4致命错误)', state.ready === true);
          check('用例10b-路径3(注入·覆盖边界=消息分支): 连接对象未被替换', getDbIdentity() === dbBefore);
        } finally {
          setRollbackFailureInjection(false);
          // 释放对端 SHARED 读事务。
          await new Promise((resolve) => db2.run('ROLLBACK', () => resolve()));
          await new Promise((resolve) => db2.close(() => resolve()));
        }

        // 注入让真实事务未被清理，靠强制重连收尾（reinitForTest 会 close 掉带残留事务的旧连接、
        // 重开新连接——旧连接一 close，未提交的事务自然被 SQLite 丢弃，不需要手工 ROLLBACK）。
        await withTimeout(reinitForTest(), 15000, '用例10b-路径3: reinitForTest()落定'); // 17-R8T LOW-14回补

        const rowAfter = await withRead((q) => q.get('SELECT * FROM it_racks WHERE id=907'));
        check('用例10b-路径3: 强制重连后事务确实未落地(无该行)', !rowAfter);

        let followUpOk = true;
        try {
          await withWrite(async (q) => { await q.run(`INSERT INTO it_racks (id, name, sort_order) VALUES (907, 'T10B-P3', 0)`); });
        } catch (e) { followUpOk = false; }
        check('用例10b-路径3: 重连后正常写成功', followUpOk);
        await withWrite(async (q) => { await q.run('DELETE FROM it_racks WHERE id=907'); });

        await setBusyTimeout(5000);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例S5-precise（17-R5S 必修）：execRollback 豁免正则改精确匹配完整短语"cannot rollback -
    //   no transaction is active"——错误消息含"cannot rollback"但不含"no transaction is
    //   active"这半句，不该被松散关键词并集误判成豁免，必须升级为路径4真实回滚失败处理。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例S5-precise（17-R5S 必修）：execRollback 豁免正则改精确匹配完整短语"cannot rollback -';
      const { withWrite, setRollbackFailureInjection, reinitForTest, state, getDbIdentity } = itLedgerModule._internals;
      const dbBefore = getDbIdentity();
      setRollbackFailureInjection('SQLITE_ERROR: cannot rollback - due to simulated disk I/O error');
      let caught = null;
      try {
        await withWrite(async () => {
          throw Object.assign(new Error('用例S5-precise触发业务错误'), { status: 400, code: 'TEST_TRIGGER_S5' });
        });
      } catch (err) { caught = err; }
      setRollbackFailureInjection(false);
      check('用例S5-precise: 含"cannot rollback"但不含完整豁免短语时未被豁免,升级为路径4的503 LEDGER_UNAVAILABLE',
        caught && caught.status === 503 && caught.code === 'LEDGER_UNAVAILABLE',
        JSON.stringify(caught && { status: caught.status, code: caught.code }));
      // 路径4触发后 handleRollbackFailure 在同一次 withWrite 调用里就地重建（已持锁，未
      // release()），rebuild 成功会把 state.error 覆盖回 null——不能等 withWrite 返回之后再
      // 检查 state.error 是否还留着"ROLLBACK 失败"字样，那时候重建早已经把它冲掉了。改用
      // "连接对象已被替换"这个不会被覆盖的证据，证明确实真的走了路径4的重建分支（不是被
      // 豁免直接吞掉、原地不动）。
      check('用例S5-precise: 连接对象已被替换(真实走了路径4的重建分支,不是被豁免原地放过)',
        getDbIdentity() !== dbBefore && getDbIdentity() !== null,
        `dbBefore=${!!dbBefore} dbAfter=${!!getDbIdentity()}`);

      await withTimeout(reinitForTest(), 15000, '用例S5-precise: 复原reinitForTest()落定'); // 17-R8T LOW-14回补
      check('用例S5-precise: 复原后state.ready=true', itLedgerModule._internals.state.ready === true);
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例11：财务字段助手
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例11：财务字段助手';
      const { rejectFinanceFields, stripFinance } = itLedgerModule._internals;
      let threw = false;
      try { rejectFinanceFields({ fin_amount: 100, name: 'x' }, false); } catch (e) { threw = e.status === 400 && e.code === 'FINANCE_FIELD_FORBIDDEN'; }
      check('用例11: 非admin带fin_amount 400', threw === true);

      threw = false;
      try { rejectFinanceFields({ external_amount: 1, name: 'x' }, false); } catch (e) { threw = e.status === 400; }
      check('用例11: 非admin带external_amount 400', threw === true);

      let noThrow = true;
      try { rejectFinanceFields({ fin_amount: 100 }, true); } catch (e) { noThrow = false; }
      check('用例11: admin携带财务字段不拒', noThrow === true);

      // M7：rejectFinanceFields 改递归后，嵌套对象里的财务键也要能拦住（原版只查顶层键会漏判）。
      threw = false;
      try { rejectFinanceFields({ attrs: { fin_amount: 1 } }, false); } catch (e) { threw = e.status === 400 && e.code === 'FINANCE_FIELD_FORBIDDEN'; }
      check('用例11: 非admin嵌套{attrs:{fin_amount:1}}400(M7递归)', threw === true);

      const nested = { name: 'x', attrs: { fin_vendor: 'y', keep: 'z' }, list: [{ fin_amount: 1, keep2: 'w' }, { keep3: 'v' }] };
      const stripped = stripFinance(nested, false);
      check('用例11: stripFinance递归剔除嵌套财务键', !('fin_vendor' in stripped.attrs));
      check('用例11: stripFinance保留非敏感键(attrs.keep)', stripped.attrs.keep === 'z');
      check('用例11: stripFinance数组元素递归剔除', !('fin_amount' in stripped.list[0]) && stripped.list[0].keep2 === 'w');
      check('用例11: stripFinance保留非敏感数组元素(list[1])', stripped.list[1].keep3 === 'v');

      const adminView = stripFinance(nested, true);
      check('用例11: admin原样', adminView.attrs.fin_vendor === 'y' && adminView.list[0].fin_amount === 1);

      // M6①：Buffer 原样透传（不被当成普通对象/数组递归拆解）。
      const buf = Buffer.from('fin_amount_should_not_be_parsed');
      const bufResult = stripFinance(buf, false);
      check('用例11: stripFinance对Buffer原样返回(引用相同)', bufResult === buf);

      // M6②：循环引用不栈溢出，且能正常返回（不追求环上字段也被剔除，只要求不炸）。
      const circular = { name: 'circ', fin_amount: 1 };
      circular.self = circular;
      let circularOk = true;
      let circularResult = null;
      try { circularResult = stripFinance(circular, false); } catch (e) { circularOk = false; }
      check('用例11: stripFinance对循环引用不栈溢出', circularOk === true);
      check('用例11: stripFinance循环引用场景仍剔除顶层财务键且保留其他字段',
        circularOk && !('fin_amount' in circularResult) && circularResult.name === 'circ');

      // H1（主会话 2026-09-18 修正——推翻上一版 WeakSet 方案的真实缺陷）：共享引用（同一对象被
      //   两个不同的属性/数组元素引用，不是环）必须两处都拿到脱敏副本，不能有一处漏网返回原始
      //   带财务字段的对象。改用 WeakMap<原对象,副本> 后应该三种共享形态都不泄露。
      const shared1 = { fin_amount: 100, name: '设备' };
      const sharedByProps = stripFinance({ a: shared1, b: shared1 }, false);
      const sharedByPropsJson = JSON.stringify(sharedByProps);
      check('用例11(H1): 同一对象被两个属性引用→JSON不含fin_amount',
        !sharedByPropsJson.includes('fin_amount'), sharedByPropsJson);
      check('用例11(H1): 同一对象被两个属性引用→a与b各自保留name',
        sharedByProps.a.name === '设备' && sharedByProps.b.name === '设备');

      const shared2 = { fin_amount: 200, name: '硬盘' };
      const sharedByArrayElems = stripFinance([shared2, shared2], false);
      const sharedByArrayElemsJson = JSON.stringify(sharedByArrayElems);
      check('用例11(H1): 同一对象被两个数组元素引用→JSON不含fin_amount',
        !sharedByArrayElemsJson.includes('fin_amount'), sharedByArrayElemsJson);
      check('用例11(H1): 同一对象被两个数组元素引用→[0]与[1]各自保留name',
        sharedByArrayElems[0].name === '硬盘' && sharedByArrayElems[1].name === '硬盘');

      const shared3 = { fin_amount: 300, name: 'AP' };
      const sharedMixed = stripFinance({ single: shared3, list: [shared3, { name: '其他' }] }, false);
      const sharedMixedJson = JSON.stringify(sharedMixed);
      check('用例11(H1): 对象属性与数组元素共同引用同一对象→JSON不含fin_amount',
        !sharedMixedJson.includes('fin_amount'), sharedMixedJson);
      check('用例11(H1): 对象属性与数组元素共同引用同一对象→各处保留name',
        sharedMixed.single.name === 'AP' && sharedMixed.list[0].name === 'AP' && sharedMixed.list[1].name === '其他');
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例12：事件助手（含 floor_update 契约）
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例12：事件助手（含 floor_update 契约）';
      const { withWrite, withRead, writeEvent, newOpId, PAYLOAD_KEYS } = itLedgerModule._internals;
      await withWrite(async (q) => { await q.run(`INSERT INTO it_assets (id, category, name, status, created_by) VALUES (950, 'other', 'T12', 'in_depot', 1)`); });

      let threw = false;
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: 950, action: 'not_a_real_action', role: 'primary', related_asset_id: null, from_state: {}, to_state: {}, operator_id: 1 }); });
      } catch (e) { threw = e.code === 'LEDGER_INTERNAL'; }
      check('用例12: 未知action抛', threw === true);

      {
        const r12 = await checkAssetIdNullRuleScenario();
        check('用例12: 非豁免action的asset_id NULL抛', r12.ok === false && r12.hitTarget === true && r12.otherErr === null, JSON.stringify(r12));
      }

      threw = false;
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: 950, action: 'update', role: 'primary', related_asset_id: null, from_state: {}, to_state: { bogus_key: 1 }, operator_id: 1 }); });
      } catch (e) { threw = e.code === 'LEDGER_INTERNAL'; }
      check('用例12: 键超出PAYLOAD_KEYS抛', threw === true);

      // 财务键分支（第二道防线）：C1 当前 PAYLOAD_KEYS 没有任何 action 把财务字段收进允许集合，
      //   所以"不允许字段"分支会先命中；临时把 fin_amount 加入 update.primary 允许集合，专门验证
      //   写死在 writeEvent 里的"事件永不记录财务值"这道独立防线确实存在（不依赖 PAYLOAD_KEYS 配置对）。
      PAYLOAD_KEYS.update.primary.add('fin_amount');
      threw = false; let errMsg = '';
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: 950, action: 'update', role: 'primary', related_asset_id: null, from_state: {}, to_state: { fin_amount: 1 }, operator_id: 1 }); });
      } catch (e) { threw = true; errMsg = e.message; }
      PAYLOAD_KEYS.update.primary.delete('fin_amount');
      check('用例12: from/to含财务键抛(独立于PAYLOAD_KEYS的第二道防线)', threw === true && /财务字段/.test(errMsg), errMsg);

      // M3 补充（主会话 2026-09-18 裁定）：递归财务字段拒绝（'attrs' 本就在 update.primary 允许集合
      //   内，无需临时加）+ fin_changed 格式校验。
      threw = false; errMsg = '';
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: 950, action: 'update', role: 'primary', related_asset_id: null, from_state: {}, to_state: { attrs: { fin_amount: 1 } }, operator_id: 1 }); });
      } catch (e) { threw = true; errMsg = e.message; }
      check('用例12(M3): to_state.attrs.fin_amount嵌套被递归拒绝', threw === true && /财务字段/.test(errMsg), errMsg);

      threw = false;
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: 950, action: 'update', role: 'primary', related_asset_id: null, from_state: {}, to_state: { fin_changed: [{ fin_amount: 1 }] }, operator_id: 1 }); });
      } catch (e) { threw = e.code === 'LEDGER_INTERNAL'; }
      check('用例12(M3): fin_changed含对象元素被拒', threw === true);

      threw = false;
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: 950, action: 'update', role: 'primary', related_asset_id: null, from_state: {}, to_state: { fin_changed: ['external_amount'] }, operator_id: 1 }); });
      } catch (e) { threw = e.code === 'LEDGER_INTERNAL'; }
      check('用例12(M3): fin_changed含external_amount被拒(资产事件不涉及它)', threw === true);

      let m3PassOk = true;
      const m3OpId = newOpId();
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: m3OpId, asset_id: 950, action: 'update', role: 'primary', related_asset_id: null, from_state: {}, to_state: { fin_changed: ['fin_amount'] }, operator_id: 1 }); });
      } catch (e) { m3PassOk = false; }
      check('用例12(M3): fin_changed含fin_amount(合法字段名，非值)通过', m3PassOk === true);

      // B1（必修，主会话 2026-09-18 裁定）：环形 to_state 不栈溢出，且仍能拒绝藏在环里的财务键
      //   （findFinanceKeyDeep 加 _seen WeakSet 防环之前，这条会直接栈溢出而不是走到正常的
      //   "抛业务错误"分支）。
      {
        const circularToState = { attrs: {} };
        circularToState.attrs.self = circularToState; // 真环
        circularToState.attrs.fin_amount = 1; // 财务键藏在环里
        let threwCircular = false;
        let circularErrMsg = '';
        try {
          await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: 950, action: 'update', role: 'primary', related_asset_id: null, from_state: {}, to_state: circularToState, operator_id: 1 }); });
        } catch (e) { threwCircular = true; circularErrMsg = e.message; }
        check('用例12(B1): 环形to_state不栈溢出且仍拒财务键', threwCircular === true && /财务字段/.test(circularErrMsg), circularErrMsg);
      }

      // M2 补充（主会话 2026-09-18 裁定）：floor_update 专项校验——5 条负向 + 补齐删除/修改两条正向
      //   （新建那条已在下方原有测试里覆盖）。
      const floorOpId = newOpId();
      await withWrite(async (q) => {
        await writeEvent(q, {
          op_id: floorOpId, asset_id: null, action: 'floor_update', role: 'primary', related_asset_id: null,
          from_state: {}, to_state: { floor_id: 'F1', name: '一楼', sort_order: 0, rooms: [] },
          operator_id: 1, note: null,
        });
      });
      const byAsset = await withRead((q) => q.get(`SELECT * FROM it_asset_events WHERE op_id=? AND asset_id IS NOT NULL`, [floorOpId]));
      check('用例12: floor_update事件 WHERE asset_id=? 查不到(不进任何资产时间线)', !byAsset);
      const byOp = await withRead((q) => q.get(`SELECT * FROM it_asset_events WHERE op_id=?`, [floorOpId]));
      check('用例12: floor_update事件 WHERE op_id=? 查得到', !!byOp && byOp.action === 'floor_update');

      const validFloorTo = { floor_id: 'FX', name: 'X楼', sort_order: 0, rooms: [] };

      threw = false;
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: null, action: 'floor_update', role: 'affected', related_asset_id: null, from_state: {}, to_state: validFloorTo, operator_id: 1 }); });
      } catch (e) { threw = e.code === 'LEDGER_INTERNAL'; }
      check('用例12(M2)负1: floor_update role=affected被拒(必须primary)', threw === true);

      threw = false;
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: null, action: 'floor_update', role: 'primary', related_asset_id: 950, from_state: {}, to_state: validFloorTo, operator_id: 1 }); });
      } catch (e) { threw = e.code === 'LEDGER_INTERNAL'; }
      check('用例12(M2)负2: floor_update related_asset_id非空被拒', threw === true);

      threw = false;
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: null, action: 'floor_update', role: 'primary', related_asset_id: null, from_state: {}, to_state: {}, operator_id: 1 }); });
      } catch (e) { threw = e.code === 'LEDGER_INTERNAL'; }
      check('用例12(M2)负3: floor_update from/to同时为空被拒', threw === true);

      threw = false;
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: null, action: 'floor_update', role: 'primary', related_asset_id: null, from_state: {}, to_state: { floor_id: 'FX', name: 'X楼', sort_order: 0 }, operator_id: 1 }); }); // 缺 rooms
      } catch (e) { threw = e.code === 'LEDGER_INTERNAL'; }
      check('用例12(M2)负4: floor_update缺rooms键被拒', threw === true);

      threw = false;
      try {
        await withWrite(async (q) => { await writeEvent(q, { op_id: 'x', asset_id: null, action: 'floor_update', role: 'primary', related_asset_id: null, from_state: {}, to_state: { floor_id: 'FX', name: 'X楼', sort_order: '0', rooms: [] }, operator_id: 1 }); }); // sort_order 类型错(字符串非整数)
      } catch (e) { threw = e.code === 'LEDGER_INTERNAL'; }
      check('用例12(M2)负5: floor_update sort_order类型不合法被拒', threw === true);

      const delOpId = newOpId();
      let delOk = true;
      try {
        await withWrite(async (q) => {
          await writeEvent(q, {
            op_id: delOpId, asset_id: null, action: 'floor_update', role: 'primary', related_asset_id: null,
            from_state: { floor_id: 'F1', name: '一楼', sort_order: 0, rooms: [] }, to_state: {},
            operator_id: 1, note: null,
          });
        });
      } catch (e) { delOk = false; }
      check('用例12(M2)正2: floor_update删除(to为空)写入成功', delOk === true);

      const modOpId = newOpId();
      let modOk = true;
      try {
        await withWrite(async (q) => {
          await writeEvent(q, {
            op_id: modOpId, asset_id: null, action: 'floor_update', role: 'primary', related_asset_id: null,
            from_state: { floor_id: 'F1', name: '一楼', sort_order: 0, rooms: [] },
            to_state: { floor_id: 'F1', name: '一楼(改)', sort_order: 1, rooms: [{ id: 'r1', name: '机房' }] },
            operator_id: 1, note: null,
          });
        });
      } catch (e) { modOk = false; }
      check('用例12(M2)正3: floor_update修改(两侧均非空)写入成功', modOk === true);

      await withWrite(async (q) => {
        await q.run('DELETE FROM it_assets WHERE id=950');
        await q.run(
          'DELETE FROM it_asset_events WHERE asset_id=950 OR op_id IN (?,?,?,?)',
          [floorOpId, m3OpId, delOpId, modOpId]
        );
      });
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例14：活体变异 ≥2（先跑正常场景已在用例6/12覆盖，此处只做"变异后必须判红"）
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例14：活体变异 ≥2（先跑正常场景已在用例6/12覆盖，此处只做"变异后必须判红"）';
      const { withWrite, setSkipAssertWriteForTest, NULL_ASSET_ACTIONS } = itLedgerModule._internals;

      // 变异①（T1修正）：去掉锁内终判 → 用同一份判据函数(checkLockedFinalAuthScenario，L2)重跑，
      //   对照组已在用例6里绿过（ok=false,hitTarget=true）；变异后必须 ok=true（写真的成功了，
      //   guard 没拦住）。
      {
        // T3（17-R6T M2 必修）：外层独立 try/finally 复位 setSkipAssertWriteForTest——
        // checkLockedFinalAuthScenario() 内部本来就有前提检查失败会抛错的路径，若不用
        // try/finally 包住，一旦它抛错，复位这行代码会被跳过，变异开关永久卡在 true，
        // 污染后面所有用例（不止这一条）。
        setSkipAssertWriteForTest(true);
        let resultMutated;
        try {
          resultMutated = await checkLockedFinalAuthScenario();
        } finally {
          setSkipAssertWriteForTest(false);
        }
        // T3（17-R4T 必修）：完整结构化判据，不只看 ok——变异后必须"写真的成功了"(ok=true)
        // 且不再命中目标拦截(hitTarget=false)且没有其它异常(otherErr=null)三者同时成立。
        check('用例14①: 去掉锁内终判后同一判据函数返回ok=true&hitTarget=false&otherErr=null(活体变异判红)',
          resultMutated.ok === true && resultMutated.hitTarget === false && resultMutated.otherErr === null,
          JSON.stringify(resultMutated));
      }

      // 变异②（T1修正）：去掉 asset_id 空值规则 → 用同一份判据函数重跑，对照组已在用例12里绿过
      //   （ok=false,hitTarget=true）；变异后必须 ok=true 且**真的写入库**——按 opId 查得到一行
      //   asset_id IS NULL 的事件，不能只满足于"没抛错"这个弱断言。
      {
        NULL_ASSET_ACTIONS.add('update'); // 变异：让 'update' 被误判为允许 NULL asset_id
        const resultMutated2 = await checkAssetIdNullRuleScenario();
        NULL_ASSET_ACTIONS.delete('update'); // 复原
        // T3：同用例14①，完整结构化判据。
        check('用例14②: 去掉asset_id空值规则后同一判据函数返回ok=true&hitTarget=false&otherErr=null(活体变异判红)',
          resultMutated2.ok === true && resultMutated2.hitTarget === false && resultMutated2.otherErr === null,
          JSON.stringify(resultMutated2));
        const persistedRow = await rawAll(`SELECT asset_id FROM it_asset_events WHERE op_id=?`, [resultMutated2.opId]);
        check('用例14②: 变异写入的事件行按op_id真查到且asset_id确实为NULL',
          persistedRow.length === 1 && persistedRow[0].asset_id === null, JSON.stringify(persistedRow));
        await withWrite(async (q) => { await q.run(`DELETE FROM it_asset_events WHERE action='update' AND op_id LIKE 'nullrule-%'`); });
      }

      // 变异③（M4：改为作用于真实路径）：去掉"事务已不存在"豁免 → 重跑用例10b路径2(真实路径)
      //   场景——业务回调自己先真实 ROLLBACK 结束事务再抛业务错误，让 execRollback 自己撞到真实
      //   的 no-transaction 错误 → 变异后必须判红（升级为503 LEDGER_UNAVAILABLE）；对照组（豁免
      //   开启）已在用例10b自身验证过绿，这里只做变异后的红。
      {
        const { setDisableNoTxnExemptionForTest, state: st } = itLedgerModule._internals;
        setDisableNoTxnExemptionForTest(true);
        let caughtAfterMutation = null;
        try {
          await withWrite(async (q) => {
            await q.run('ROLLBACK'); // 真实结束事务
            throw Object.assign(new Error('用例14③触发业务错误'), { status: 409, code: 'TEST_TRIGGER_14C' });
          });
        } catch (err) { caughtAfterMutation = err; }
        setDisableNoTxnExemptionForTest(false);
        check('用例14③(真实路径): 去掉no_txn豁免后升级为503 LEDGER_UNAVAILABLE(活体变异判红——证明该豁免平时确实在拦截误升级)',
          caughtAfterMutation && caughtAfterMutation.status === 503 && caughtAfterMutation.code === 'LEDGER_UNAVAILABLE',
          JSON.stringify(caughtAfterMutation && { status: caughtAfterMutation.status, code: caughtAfterMutation.code }));

        // 变异③会把模块打成 LEDGER_UNAVAILABLE 并触发自动重建，等重建完成恢复 ready，避免污染后续用例。
        let recovered3 = st.ready === true;
        for (let i = 0; i < 50 && !recovered3; i++) {
          await new Promise((r) => setTimeout(r, 50));
          recovered3 = st.ready === true;
        }
        check('用例14③: 变异测试后模块自动重建恢复ready(避免污染后续用例)', recovered3);
      }

      await api('DELETE', '/api/it-assets/acl/5', { uid: 1, role: 'admin' });
    }

    // ══════════════════════════════════════════════════════════════════
    // 用例13（L2 重写，对应 17-R3 H2；T1 补充）：shutdown() 排空（放最后——会关闭连接，之后不再
    //   对模块发起写请求）。w1 卡在 setTxnMidGate 闸内（持锁未释放）、w2 已排队（waiterCount===1）
    //   → 调 shutdown() → 断言 shutdown 尚未完成（shutdown().finally() 本地标志 + 两次
    //   setImmediate 调度屏障判定，不用 Promise.race 哨兵）且 state.draining===true → 新请求
    //   503 DRAINING → 放闸 → 等 shutdown 完成 → 用独立原生连接查询两行均已提交（不止信任
    //   withWrite 返回值）→ 保存的旧连接关闭态探针命中（shutdown 关的确实是本用例开始前那条
    //   连接）。
    // ══════════════════════════════════════════════════════════════════
    {
      currentCaseLabel = '用例13（L2 重写，对应 17-R3 H2；T1 补充）：shutdown() 排空（放最后——会关闭连接，之后不再';
      const { withWrite, itTxnMutex, setTxnMidGate, getDbIdentity, state } = itLedgerModule._internals;
      const dbBeforeShutdown = getDbIdentity();

      let gateResolve;
      const arrivedW1 = setTxnMidGate(new Promise((r) => { gateResolve = r; }));

      // T1：创建时即接管拒绝。
      const w1 = withWrite(async (q) => {
        await q.run(`INSERT INTO it_racks (id,name,sort_order) VALUES (910,'S1',0)`);
        return 'w1-done';
      }).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
      // w1 会在 BEGIN 之后、业务回调开始之前卡在 txnMidGate 上（本轮新增的公共闸，见用例L1）。
      await awaitArrived(arrivedW1, '用例13-w1到达txnMidGate', w1);

      const w2 = withWrite(async (q) => { await q.run(`INSERT INTO it_racks (id,name,sort_order) VALUES (911,'S2',0)`); return 'w2-done'; })
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); // T1：创建时即接管拒绝
      let w2QueuedOk = false;
      for (let i = 0; i < 100; i++) {
        if (itTxnMutex._internals.waiterCount() === 1) { w2QueuedOk = true; break; }
        await new Promise((r) => setTimeout(r, 2));
      }
      check('用例13(L2): w2已真正排入等待队列(waiterCount===1)后再shutdown', w2QueuedOk,
        `waiterCount=${itTxnMutex._internals.waiterCount()}`);

      let shutdownDone = false;
      // 17-R7T M③：创建时即用 .then(ok/err) 结构化接管，不留裸 reject 落地窗口。
      const shutdownPromise = itLedgerModule.shutdown()
        .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
        .finally(() => { shutdownDone = true; });

      // T1（17-R4T HIGH 必修）：不用 Promise.race([p.then(()=>'done'), Promise.resolve('pending')])
      // 哨兵写法——链式 .then() 比裸 Promise.resolve() 多一轮微任务，'pending' 哨兵恒先 settle，
      // 断言恒真、测不出真实时序。改用 shutdown().finally() 本地标志 + 两次 setImmediate 调度
      // 屏障判定。
      await schedulingBarrier();
      check('用例13(L2/T1): shutdown尚未完成(仍在等两条在途写排空)', shutdownDone === false);
      check('用例13(L2): state.draining===true', state.draining === true);

      let draining = null;
      try {
        await itLedgerModule._internals.withWrite(async (q) => { await q.get('SELECT 1'); });
      } catch (e) { draining = e; }
      check('用例13: 排空期间新请求503 LEDGER_DRAINING',
        draining && draining.status === 503 && draining.code === 'LEDGER_DRAINING', JSON.stringify(draining && { status: draining.status, code: draining.code }));

      setTxnMidGate(null); // w1 已捕获原 gate 对象的引用，此处清空不影响它继续等待同一个 Promise
      gateResolve(); // 放闸——w1 的业务回调继续，随后 w2（txnMidGate 已为 null，不再等待）依次执行

      const [r1, r2] = await awaitSettle(Promise.all([w1, w2]), 5000, '用例13等待w1/w2 Promise.all落定');
      check('用例13: 两条旧写都完成', r1.ok === true && r1.v === 'w1-done' && r2.ok === true && r2.v === 'w2-done', JSON.stringify([r1, r2]));

      const shutdownResult13 = await awaitSettle(shutdownPromise, 5000, '用例13等待shutdownPromise落定');
      check('用例13(M③): shutdownPromise接管结果ok===true',
        shutdownResult13 && shutdownResult13.ok === true,
        shutdownResult13 && shutdownResult13.ok !== true ? (shutdownResult13.e && shutdownResult13.e.stack) : JSON.stringify(shutdownResult13));
      check('用例13: 连接已关闭', itLedgerModule._internals.isDbOpen() === false);

      // L2：用独立原生连接查询两行均已提交——不止信任 withWrite 的返回值。
      const committedRows = await rawAll('SELECT id FROM it_racks WHERE id IN (910,911) ORDER BY id');
      check('用例13(L2): 两行均已在数据库层真实提交(独立原生连接核实)',
        committedRows.length === 2 && committedRows[0].id === 910 && committedRows[1].id === 911,
        JSON.stringify(committedRows));
      await rawRun('DELETE FROM it_racks WHERE id IN (910,911)');

      // L2：保存的旧连接关闭态探针命中——shutdown() 关闭的应该正是本用例开始前那条连接。
      const probe4 = await probeClosedDb(dbBeforeShutdown);
      check('用例13(L2): shutdown关闭的正是本用例开始前那条连接(查询报错)',
        probe4.ok === true && probe4.closed === true, JSON.stringify(probe4));

      const rHttp = await api('GET', '/api/it-assets/me', { uid: 1, role: 'admin' });
      check('用例13: HTTP层新请求也503', rHttp.status === 503, JSON.stringify(rHttp));
      check('用例13: HTTP层响应体code=LEDGER_DRAINING(L6)', rHttp.body && rHttp.body.code === 'LEDGER_DRAINING', JSON.stringify(rHttp.body));

      // B2：shutdown() 应在关闭连接前把 state.ready 拨回 false，且之后 reinitForTest() 仍能
      // 正常重建（证明 shutdown 不是"半吊子终态"，模块可以从这个状态干净地再次启动）。
      check('用例13(B2): shutdown后state.ready=false', itLedgerModule._internals.state.ready === false);
      itLedgerModule._internals.state.draining = false; // 复位，模拟运维侧重启前的正常操作
      await awaitSettle(itLedgerModule._internals.reinitForTest(), 15000, '用例13(B2)等待reinitForTest()落定');
      check('用例13(B2): shutdown后reinitForTest()能重建(ready恢复true)', itLedgerModule._internals.state.ready === true);
    }

    // 收尾：C1 串行化重构——initSchema() 一次性闸门早已在用例1/2 段落消耗过，此处不能再靠调用
    //   它"恢复模块可用状态"（会被一次性闸忽略）。用例13 末尾的 reinitForTest() 已经把模块拨回
    //   ready=true，这里只需做测试脚本自身的收尾一次性 shutdown（生产从不这样"关了又开又关"——
    //   这里单纯是测试脚本自身要继续访问 TEST_DB 做收尾核验）。
    itLedgerModule._internals.state.draining = false;
    await awaitSettle(itLedgerModule.shutdown(), 15000, '收尾等待itLedgerModule.shutdown()落定');
  } catch (fatalErr) {
    check('FATAL: verify 脚本自身异常', false, fatalErr && fatalErr.stack);
  } finally {
    // T4（17-R6T M3 必修）：若 try 块在跑到收尾的 itLedgerModule.shutdown() 之前就 FATAL 了
    // （比如某个用例中途抛出未捕获异常），itDb 这条独立连接可能还开着——Windows 下文件句柄未
    // 释放会导致下面的 unlinkSync 直接失败（不像 POSIX 允许删除仍被打开的文件）。这里兜底再关
    // 一次，即便前面已经正常 shutdown 过也无副作用（shutdown 本身是幂等的：itDb 已为 null 时
    // closeItDb 是 no-op）。不再用 Promise.race+空 catch(_) 这种"超时就假装没事"的写法——改用
    // withTimeout，失败/超时一律 check(false) + fatalExit（打印 PASS/FAIL 汇总 + TEST_DB
    // 路径后终止进程），不侥幸尝试继续走后面的清理——shutdown 真卡死是比"临时文件没删干净"
    // 严重得多的独立故障，不该被这层 finally 悄悄掩盖成"正常退出"。server.close 同样套超时。
    try {
      await withTimeout(itLedgerModule.shutdown(), 5000, 'main finally: shutdown()落定');
    } catch (e) {
      fatalExit('main finally: shutdown()未在5s内落定(疑似真死锁)', e && e.message);
    }
    try {
      await withTimeout(new Promise((resolve) => server.close(resolve)), 5000, 'main finally: server.close()落定');
    } catch (e) {
      fatalExit('main finally: server.close()未在5s内落定', e && e.message);
    }
    // T5（17-R4T 必修）：删除失败不再静默吞掉——记一条 FAIL（含路径与原始错误），让"临时文件没
    // 删干净"这件事本身可见，而不是只打个日志就当无事发生。
    try {
      if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    } catch (unlinkErr) {
      check('收尾: 临时库文件删除成功', false, `临时库删除失败: ${TEST_DB} ${unlinkErr && unlinkErr.message}`);
    }
    clearTimeout(mainDeadlineTimer); // 17-R7T H：正常走到这里说明全套用例没有卡死，撤销总看门狗
  }

  console.log(results.join('\n'));
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('verify-it-ledger 致命错误:', err && err.stack || err);
  process.exit(1);
});
