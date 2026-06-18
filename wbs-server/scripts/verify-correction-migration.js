// verify-correction-migration.js — 细优② K1 迁移时序 verify（C-1 / M-5 / codex 36-37）
// 证明：已上线 correction_requests（生产已有数据、不含 creator 5 列）经 initSchema/runCorrectionMigration
//   幂等 ALTER 补列后——① 旧数据保留 ② creator 5 列补齐 ③ creator_notify_status 回填 'not_sent'
//   ④ readiness ready=true（ALTER 在 KEY_COLS 复查【之前】完成，未熔断）⑤ 二次跑幂等不报错。
//   关键：专测"生产已有表 ALTER"场景，非全新空库（空库走 CREATE TABLE 一次建全，测不到迁移时序）。
// 用法：node scripts/verify-correction-migration.js
'use strict';
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const dbRunAsync = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const dbGetAsync = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbAllAsync = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
const asyncNoop = async () => ({});

const deps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync, dbGetAsync, dbAllAsync,
  authenticateToken: mwPass, requireAdmin: mwPass, requirePublisherOrAdmin: mwPass,
  sendIssueDingtalkRaw: asyncNoop,
  UPLOAD_DIR: require('path').join(require('os').tmpdir(), 'correction-migration-uploads'),
  readSystemConfig: asyncNoop,
  COLLAB_CHAT_ADMIN_ID: 3,
  callDingtalkWithTokenRetry: asyncNoop,
  normalizeAttachmentExt: (x) => x,
  safeDeleteFileSync: noop,
  maskPhone: (x) => x,
};

let pass = 0;
const ok = (cond, label) => { assert(cond, label); console.log('  ✓ ' + label); pass++; };

async function waitReady(state, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!state.ready) {
    if (state.error) throw new Error('schema error: ' + state.error);
    if (Date.now() - t0 > timeoutMs) throw new Error('readiness timeout（migration 未在 ' + timeoutMs + 'ms 内就绪）');
    await new Promise(r => setTimeout(r, 30));
  }
}
// 失败路径用：轮询到 ready 或 error 任一出现（不像 waitReady 在 error 时抛，便于断言 error）
async function waitSettled(state, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!state.ready && !state.error) {
    if (Date.now() - t0 > timeoutMs) throw new Error('migration 未在 ' + timeoutMs + 'ms 内 settle');
    await new Promise(r => setTimeout(r, 30));
  }
}

const CREATOR_COLS = ['creator_notify_status', 'creator_notified_at', 'creator_notify_message_key', 'creator_notify_error', 'creator_read_at'];

(async () => {
  console.log('=== 细优② K1 迁移时序 verify：旧表 ALTER 补 creator 5 列（C-1/M-5）===\n');

  // [前置] 造"旧版"correction_requests（不含 creator 5 列，含其余 KEY_COLS）+ 样例数据，模拟生产已上线表
  // 旧表须忠实生产 schema：含 requester_phone + 完整 completion_notify_*（Commit A 起就有）——
  //   否则 L1 跨系统迁移的子表回填 SELECT cr.requester_phone/completion_notify_* 会因列缺失报错（非 L1 bug，stub 不忠实）。
  await dbRunAsync(`CREATE TABLE correction_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_system TEXT, source_system_other TEXT, location_info TEXT, requester_name TEXT, requester_phone TEXT, status TEXT,
    correction_type TEXT, batch_completion_note TEXT, submission_count INTEGER,
    expected_deadline DATETIME, dev_estimated_at DATETIME,
    assigned_to INTEGER, assigned_to_name TEXT,
    fixed_at DATETIME, refixed_at DATETIME,
    completion_notified_at DATETIME, completion_notify_status TEXT, completion_notify_message_key TEXT, completion_notify_error TEXT, completion_read_at DATETIME,
    archived_at DATETIME, friction_reason TEXT, voided_at DATETIME,
    created_by INTEGER, relay_notified_user_id INTEGER,
    dingtalk_chat_id TEXT, dingtalk_open_conversation_id TEXT, dingtalk_chat_created_at DATETIME,
    dingtalk_chat_created_by INTEGER, dingtalk_chat_name TEXT,
    correction_count INTEGER, relay_notify_status TEXT, closure_type TEXT,
    created_at DATETIME
  )`);
  await dbRunAsync(`INSERT INTO correction_requests (id, source_system, location_info, requester_name, status, correction_type, created_by, created_at)
                   VALUES (1,'BMS','把金额从100改成200','张三','FIXED','single',1,'2026-06-17 10:00:00')`);
  // 也建附件/历史表的"缺列"场景不测（migration 对它们是 CREATE IF NOT EXISTS 兜底），此处只造主表已存在
  const before = await dbAllAsync('PRAGMA table_info(correction_requests)');
  const beforeNames = before.map(c => c.name);
  ok(!CREATOR_COLS.some(c => beforeNames.includes(c)), '前置：旧表不含任何 creator 列（模拟生产已上线表）');

  // 实例化 + initSchema：CREATE TABLE IF NOT EXISTS 对已存在旧表 no-op → migration [2a] ALTER 补 creator 列
  const mod = require('../routes/corrections')(deps);
  const I = mod._internals;
  mod.initSchema();
  await waitReady(I.CORRECTION_SCHEMA_STATE);
  ok(I.CORRECTION_SCHEMA_STATE.ready === true, 'migration ready=true（C-1：ALTER 在 KEY_COLS 复查前完成，未因缺列熔断 503）');

  // creator 5 列补齐
  const after = await dbAllAsync('PRAGMA table_info(correction_requests)');
  const afterNames = after.map(c => c.name);
  CREATOR_COLS.forEach(c => ok(afterNames.includes(c), 'creator 列补齐：' + c));

  // 旧数据保留 + creator_notify_status 回填 'not_sent'（H-1 DEFAULT）
  const row = await dbGetAsync('SELECT * FROM correction_requests WHERE id=1');
  ok(row && row.status === 'FIXED' && row.source_system === 'BMS' && row.location_info === '把金额从100改成200',
    '旧数据保留（status=FIXED / source_system=BMS / location_info 原文）');
  ok(row.creator_notify_status === 'not_sent', '旧行 creator_notify_status 回填 not_sent（H-1 ALTER DEFAULT 生效）');
  ok(row.creator_read_at === null && row.creator_notify_message_key === null && row.creator_notify_error === null,
    '旧行 creator_read_at/message_key/error 为 NULL（无默认值列）');

  // 幂等：二次跑 migration（creator 列已存在 → ALTER 跳过，不报 duplicate column）
  I.CORRECTION_SCHEMA_STATE.ready = false;
  I.CORRECTION_SCHEMA_STATE.error = null;
  mod.initSchema();
  await waitReady(I.CORRECTION_SCHEMA_STATE);
  ok(I.CORRECTION_SCHEMA_STATE.ready === true && !I.CORRECTION_SCHEMA_STATE.error,
    '幂等：二次 initSchema 不报错（creator 列已存在，[2a] 跳过 ALTER）');

  // creator 通知契约常量（K1 声明，供 K2 端点 + verify 用）
  ok(JSON.stringify(I.CORRECTION_NOTIFY_SENDABLE.creator) === JSON.stringify(['FIXED', 'REFIXED']),
    'NOTIFY_SENDABLE.creator = [FIXED, REFIXED]');
  const m = I.CORRECTION_READ_FIELD_MAP.creator;
  ok(m && m.user_id_col === 'created_by' && m.status_col === 'creator_notify_status' && m.read_at === 'creator_read_at' && m.byPhone === false && m.label === '创建人',
    'READ_FIELD_MAP.creator 映射正确（created_by / creator_notify_status / label=创建人）');
  ok(I.CORRECTION_REQUESTS_KEY_COLS.includes('creator_notify_status'), 'KEY_COLS 含 creator_notify_status 锚点');

  // [失败路径] ALTER 失败 → 外层 catch → ready=false + error 可观测（K1-M2，codex 38）：
  //   独立 failDb，包装 run 拦截 creator_notified_at 的 ALTER 返错，证明 migration 不静默吞错（对齐"失败必落库/可观测"铁律）。
  const failDb = new sqlite3.Database(':memory:');
  const origFailRun = failDb.run.bind(failDb);
  failDb.run = function (sql, ...rest) {
    if (typeof sql === 'string' && /ALTER TABLE correction_requests ADD COLUMN creator_notified_at/.test(sql)) {
      const cb = rest.find(a => typeof a === 'function');
      if (cb) { cb(new Error('mock ALTER fail (creator_notified_at)')); return failDb; }
    }
    return origFailRun(sql, ...rest);
  };
  const fRun = (sql, p = []) => new Promise((res, rej) => failDb.run(sql, p, function (e) { e ? rej(e) : res(this); }));
  // 旧表（不含 creator 列）——注意经包装的 failDb.run，但本 CREATE 不匹配拦截正则，正常执行
  await fRun(`CREATE TABLE correction_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_system TEXT, source_system_other TEXT, location_info TEXT, requester_name TEXT, requester_phone TEXT, status TEXT,
    correction_type TEXT, batch_completion_note TEXT, submission_count INTEGER,
    expected_deadline DATETIME, dev_estimated_at DATETIME, assigned_to INTEGER, assigned_to_name TEXT,
    fixed_at DATETIME, refixed_at DATETIME,
    completion_notified_at DATETIME, completion_notify_status TEXT, completion_notify_message_key TEXT, completion_notify_error TEXT, completion_read_at DATETIME,
    archived_at DATETIME, friction_reason TEXT, voided_at DATETIME,
    created_by INTEGER, relay_notified_user_id INTEGER,
    dingtalk_chat_id TEXT, dingtalk_open_conversation_id TEXT, dingtalk_chat_created_at DATETIME,
    dingtalk_chat_created_by INTEGER, dingtalk_chat_name TEXT,
    correction_count INTEGER, relay_notify_status TEXT, closure_type TEXT, created_at DATETIME
  )`);
  const depsF = {
    ...deps, db: failDb, dbRunAsync: fRun,
    dbGetAsync: (sql, p = []) => new Promise((res, rej) => failDb.get(sql, p, (e, r) => e ? rej(e) : res(r))),
    dbAllAsync: (sql, p = []) => new Promise((res, rej) => failDb.all(sql, p, (e, r) => e ? rej(e) : res(r))),
  };
  const modF = require('../routes/corrections')(depsF);
  modF.initSchema();
  await waitSettled(modF._internals.CORRECTION_SCHEMA_STATE);
  ok(modF._internals.CORRECTION_SCHEMA_STATE.ready === false, '失败路径：ALTER 失败 → ready=false（写入口不放行）');
  ok(/迁移异常|mock ALTER fail/.test(modF._internals.CORRECTION_SCHEMA_STATE.error || ''),
    '失败路径：error 可观测非静默吞错 → ' + (modF._internals.CORRECTION_SCHEMA_STATE.error || '(空)'));
  failDb.close();

  console.log(`\n=== 迁移时序 verify 通过：${pass} 断言 ===`);
  db.close();
})().catch(e => { console.error('✗ FAIL:', e.message); db.close(); process.exit(1); });
