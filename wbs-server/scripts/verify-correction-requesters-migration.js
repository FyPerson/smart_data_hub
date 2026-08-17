// verify-correction-requesters-migration.js — 跨系统关联方案 L1 迁移 verify（§5.2/§5.4 / RC3-L1/RC3-L2 / C-1）
// 证明：已上线 correction_requests（v1.84.0，无 correction_group_id/error_proof_note、无 correction_requesters 表）
//   经 initSchema/runCorrectionMigration——
//   ① 主表幂等 ALTER 补 correction_group_id + error_proof_note（旧数据保留）
//   ② idx_corr_group 索引建立（ALTER 后建，非 serialize 块，避免旧库无列熔断）
//   ③ correction_requesters 子表 + 主业务方唯一索引 + 查询索引建立
//   ④ 幂等回填：每"标准单/主单"（非子单）一条 is_primary=1，搬 requester_name/phone + completion_notify_*
//   ⑤ 空名历史单跳过 / VOIDED 有名单正常回填 / VOIDED 无名单豁免（readiness 不要求其 primary）
//   ⑥ readiness RC3-L1 不变量：非 VOIDED 非子单恰一条 primary；违反 → ready=false（503 fail-fast）
//   ⑦ RC3-L2 status 枚举 = not_sent/sent/failed/no_phone
//   ⑧ 二跑幂等 / 主业务方唯一索引硬约束 / 段二子单（group_id≠id）回填豁免（前向兼容）
//   ⑨ codex 48 加固：M-1 非法旧 completion_notify_status 回填清洗为 not_sent / L-3 is_primary·seq CHECK DB 层硬拒
// 关键：require routes/corrections 真实 initSchema + _internals（非复刻，根治 RC-L2 漂移）。
// 用法：node scripts/verify-correction-requesters-migration.js
'use strict';
const assert = require('assert');
const sqlite3 = require('sqlite3');

const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
const asyncNoop = async () => ({});

function makeDeps(db) {
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db,
    dbRunAsync: (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); })),
    dbGetAsync: (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r))),
    dbAllAsync: (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r))),
    authenticateToken: mwPass, requireAdmin: mwPass, requirePublisherOrAdmin: mwPass,
    sendIssueDingtalkRaw: asyncNoop,
    UPLOAD_DIR: require('path').join(require('os').tmpdir(), 'correction-requesters-mig-uploads'),
    readSystemConfig: asyncNoop,
    COLLAB_CHAT_ADMIN_ID: 3,
    callDingtalkWithTokenRetry: asyncNoop,
    normalizeAttachmentExt: (x) => x,
    safeDeleteFileSync: noop,
    maskPhone: (x) => x,
  };
}

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
async function waitSettled(state, timeoutMs = 3000) {
  const t0 = Date.now();
  while (!state.ready && !state.error) {
    if (Date.now() - t0 > timeoutMs) throw new Error('migration 未在 ' + timeoutMs + 'ms 内 settle');
    await new Promise(r => setTimeout(r, 30));
  }
}

// 模拟"生产 v1.84.0 已上线表"：含全部 KEY_COLS（creator 5 列在）+ 完整 completion_notify_* 集，
//   唯独缺 L1 的 correction_group_id / error_proof_note（待 migration ALTER 补）。子表 + 索引由 initSchema 建。
const OLD_TABLE_V1840 = `CREATE TABLE correction_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_system TEXT NOT NULL, source_system_other TEXT, location_info TEXT NOT NULL,
  correction_count INTEGER, reason TEXT, oa_number TEXT,
  correction_type TEXT NOT NULL DEFAULT 'single',
  requester_dept TEXT, requester_name TEXT NOT NULL, requester_phone TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_ASSIGN',
  expected_deadline DATETIME, dev_estimated_at DATETIME,
  assigned_to INTEGER, assigned_to_name TEXT, assigned_by INTEGER, assigned_at DATETIME,
  batch_completion_note TEXT, submission_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT (datetime('now','localtime')),
  estimated_replied_at DATETIME, fixed_at DATETIME, refixed_at DATETIME,
  completion_notified_at DATETIME, completion_notify_status TEXT DEFAULT 'not_sent',
  completion_notify_message_key TEXT, completion_notify_error TEXT, completion_read_at DATETIME,
  relay_notified_user_id INTEGER, relay_notified_at DATETIME, relay_notify_status TEXT DEFAULT 'not_sent',
  relay_notify_message_key TEXT, relay_notify_error TEXT, relay_read_at DATETIME,
  archived_at DATETIME, archived_by INTEGER, archived_by_name TEXT, friction_reason TEXT,
  closure_type TEXT DEFAULT 'normal', closure_reason TEXT,
  voided_at DATETIME, voided_by INTEGER, voided_by_name TEXT, void_reason TEXT,
  created_by INTEGER NOT NULL, created_by_name TEXT,
  rejected_at DATETIME, rejected_by INTEGER, rejected_by_name TEXT, reject_reason TEXT,
  notify_status TEXT DEFAULT 'not_sent', notified_at DATETIME, notify_message_key TEXT, notify_error TEXT, read_at DATETIME,
  requester_notify_status TEXT DEFAULT 'not_sent', requester_notified_at DATETIME,
  requester_notify_message_key TEXT, requester_notify_error TEXT, requester_read_at DATETIME,
  creator_notify_status TEXT DEFAULT 'not_sent', creator_notified_at DATETIME,
  creator_notify_message_key TEXT, creator_notify_error TEXT, creator_read_at DATETIME,
  dingtalk_chat_id TEXT, dingtalk_open_conversation_id TEXT, dingtalk_chat_created_at DATETIME,
  dingtalk_chat_created_by INTEGER, dingtalk_chat_name TEXT
)`;

(async () => {
  console.log('=== 跨系统关联 L1 迁移 verify（业务方子表 + 2 列 + 回填 + RC3-L1 不变量）===\n');

  // ───────────────── 场景 1：v1.84.0 → L1 主迁移 + 回填 ─────────────────
  {
    console.log('[场景1] 生产 v1.84.0 表 → L1 ALTER + 建子表 + 回填');
    const db = new sqlite3.Database(':memory:');
    const deps = makeDeps(db);
    const run = deps.dbRunAsync, all = deps.dbAllAsync, get = deps.dbGetAsync;
    await run(OLD_TABLE_V1840);
    // id=1：非 VOIDED FIXED 单，有名有手机 + 非默认完成通知态（测回填搬运 completion_notify_*）
    await run(`INSERT INTO correction_requests
      (id, source_system, location_info, requester_name, requester_phone, status, correction_type, created_by,
       completion_notify_status, completion_notified_at, completion_notify_message_key, completion_read_at)
      VALUES (1,'BMS','把金额100改成200','张三','13800000001','FIXED','single',1,
              'sent','2026-06-17 10:00:00','msgkey-1','2026-06-17 10:05:00')`);
    // id=2：VOIDED 但有名（生产 id=1 同形态）→ 正常回填
    await run(`INSERT INTO correction_requests
      (id, source_system, location_info, requester_name, requester_phone, status, correction_type, created_by)
      VALUES (2,'BMS','测试单','李四','13800000002','VOIDED','single',1)`);
    // id=3：VOIDED 空名 → 回填跳过 + readiness 豁免
    await run(`INSERT INTO correction_requests
      (id, source_system, location_info, requester_name, status, correction_type, created_by)
      VALUES (3,'BMS','空名作废单','','VOIDED','single',1)`);
    // id=4：非 VOIDED FIXED，旧 completion_notify_status 为非法值（模拟脏数据）→ 回填须清洗为 not_sent（codex 48 M-1）
    await run(`INSERT INTO correction_requests
      (id, source_system, location_info, requester_name, status, correction_type, created_by, completion_notify_status)
      VALUES (4,'BMS','脏状态单','赵六','FIXED','single',1,'garbage_status')`);

    const beforeNames = (await all('PRAGMA table_info(correction_requests)')).map(c => c.name);
    ok(!beforeNames.includes('correction_group_id') && !beforeNames.includes('error_proof_note'),
      '前置：旧表无 correction_group_id/error_proof_note（模拟 v1.84.0 已上线表）');

    const mod = require('../routes/corrections')(makeDeps(db));
    // 复用同一 db：用 mod 自己的 deps（注意须用同库句柄）——重建 deps 指向同 db
    const I = mod._internals;
    mod.initSchema();
    await waitReady(I.CORRECTION_SCHEMA_STATE);
    ok(I.CORRECTION_SCHEMA_STATE.ready === true, 'migration ready=true（C-1：ALTER 在 KEY_COLS 复查前完成，未熔断）');

    // ① 2 列补齐 + 旧数据保留
    const afterNames = (await all('PRAGMA table_info(correction_requests)')).map(c => c.name);
    ok(afterNames.includes('correction_group_id') && afterNames.includes('error_proof_note'),
      '主表补列：correction_group_id + error_proof_note（C-1 ALTER）');
    const r1 = await get('SELECT * FROM correction_requests WHERE id=1');
    ok(r1 && r1.status === 'FIXED' && r1.location_info === '把金额100改成200' && r1.correction_group_id === null,
      '旧数据保留（status/location_info 原文 + 新列默认 NULL）');

    // ② idx_corr_group 索引建立
    const idxList = await all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='correction_requests'");
    ok(idxList.some(x => x.name === 'idx_corr_group'), 'idx_corr_group 索引建立（ALTER 后建，非 serialize 块）');

    // ③ 子表 + 两索引建立
    const tbls = await all("SELECT name FROM sqlite_master WHERE type='table' AND name='correction_requesters'");
    ok(tbls.length === 1, 'correction_requesters 子表建立');
    const reqIdx = await all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='correction_requesters'");
    ok(reqIdx.some(x => x.name === 'idx_correction_requester_primary'), '主业务方唯一索引 idx_correction_requester_primary 建立');
    ok(reqIdx.some(x => x.name === 'idx_correction_requester_req'), '按单+seq 查询索引 idx_correction_requester_req 建立');

    // ④ 回填：id=1/id=2 各一条 primary；id=3 空名跳过
    const allReq = await all('SELECT * FROM correction_requesters ORDER BY correction_request_id');
    ok(allReq.length === 3, `回填 3 条 primary（id=1 FIXED + id=2 VOIDED 有名 + id=4 脏状态；id=3 空名跳过）实得 ${allReq.length}`);
    const p1 = allReq.find(x => x.correction_request_id === 1);
    ok(p1 && p1.is_primary === 1 && p1.seq === 1 && p1.requester_name === '张三' && p1.requester_phone === '13800000001',
      'id=1 primary 行：is_primary=1 seq=1 + 搬 requester_name/phone');
    ok(p1.completion_notify_status === 'sent' && p1.completion_notified_at === '2026-06-17 10:00:00'
      && p1.completion_notify_message_key === 'msgkey-1' && p1.completion_read_at === '2026-06-17 10:05:00',
      'id=1 primary 行：completion_notify_* 兼容列从主表搬入（非全部默认）');
    ok(!allReq.some(x => x.correction_request_id === 3), 'id=3 空名 VOIDED 单：回填跳过（无 primary 行）');
    // codex 48 M-1：非法旧 completion_notify_status 回填时枚举清洗为 not_sent（不把脏值搬进子表）
    const p4 = allReq.find(x => x.correction_request_id === 4);
    ok(p4 && p4.completion_notify_status === 'not_sent',
      'M-1：id=4 非法旧 completion_notify_status(garbage_status) 回填清洗为 not_sent（§5.3 RC-L2 枚举清洗）');

    // ⑤ readiness 通过（id=3 VOIDED 无 primary 被豁免，未触发 RC3-L1）
    ok(I.CORRECTION_SCHEMA_STATE.ready === true && !I.CORRECTION_SCHEMA_STATE.error,
      'readiness 放行：VOIDED 空名单无 primary 被豁免（RC3-L1 仅约束非 VOIDED）');

    // ⑦ RC3-L2 status 枚举 + KEY_COLS 归属
    ok(JSON.stringify(I.CORRECTION_REQUESTER_NOTIFY_STATUSES) === JSON.stringify(['not_sent', 'sent', 'failed', 'no_phone']),
      'RC3-L2：CORRECTION_REQUESTER_NOTIFY_STATUSES = [not_sent,sent,failed,no_phone]');
    ok(I.CORRECTION_REQUESTS_KEY_COLS.includes('correction_group_id'), 'KEY_COLS 含 correction_group_id 锚点');
    ok(!I.CORRECTION_REQUESTS_KEY_COLS.includes('error_proof_note'), 'KEY_COLS 不含 error_proof_note（可空辅助列，方案 §5.1）');

    // ⑧ 二跑幂等：重置 ready 再跑，primary 不翻倍、不报错
    I.CORRECTION_SCHEMA_STATE.ready = false;
    I.CORRECTION_SCHEMA_STATE.error = null;
    mod.initSchema();
    await waitReady(I.CORRECTION_SCHEMA_STATE);
    const allReq2 = await all('SELECT * FROM correction_requesters');
    ok(allReq2.length === 3 && I.CORRECTION_SCHEMA_STATE.ready === true && !I.CORRECTION_SCHEMA_STATE.error,
      '幂等：二跑 initSchema 不翻倍 primary（仍 3 条）+ 不报错（NOT EXISTS 防重 + ALTER 跳过）');

    // 主业务方唯一索引硬约束：对 id=1 再插 is_primary=1 → 违反 partial unique index
    let dupThrew = false;
    try {
      await run(`INSERT INTO correction_requesters (correction_request_id, requester_name, is_primary, seq) VALUES (1,'冒充主',1,2)`);
    } catch (e) { dupThrew = /UNIQUE|constraint/i.test(e.message); }
    ok(dupThrew, '主业务方唯一索引硬约束：同单第二条 is_primary=1 被拒（H-1 至多一条）');

    // codex 48 L-3：is_primary/seq 数据类型 guard CHECK 在 DB 层硬拒非法值
    let badPrimaryThrew = false;
    try { await run(`INSERT INTO correction_requesters (correction_request_id, requester_name, is_primary, seq) VALUES (2,'非法bool',2,1)`); }
    catch (e) { badPrimaryThrew = /CHECK|constraint/i.test(e.message); }
    ok(badPrimaryThrew, 'L-3 CHECK：is_primary=2 被 DB 拒（数据类型 guard IN(0,1)）');
    let badSeqThrew = false;
    try { await run(`INSERT INTO correction_requesters (correction_request_id, requester_name, is_primary, seq) VALUES (2,'非法seq',0,0)`); }
    catch (e) { badSeqThrew = /CHECK|constraint/i.test(e.message); }
    ok(badSeqThrew, 'L-3 CHECK：seq=0 被 DB 拒（range guard >=1）');
    db.close();
  }

  // ───────────────── 场景 2：RC3-L1 负向——非 VOIDED 无 primary → ready=false ─────────────────
  {
    console.log('\n[场景2] RC3-L1 负向：非 VOIDED 单缺 primary → readiness 熔断 503');
    const db = new sqlite3.Database(':memory:');
    const deps = makeDeps(db);
    await deps.dbRunAsync(OLD_TABLE_V1840);
    // 非 VOIDED FIXED 单但 requester_name 空串 → 回填跳过 → 非 VOIDED 0 primary → 触发不变量断言
    await deps.dbRunAsync(`INSERT INTO correction_requests
      (id, source_system, location_info, requester_name, status, correction_type, created_by)
      VALUES (1,'BMS','脏数据单','','FIXED','single',1)`);
    const mod = require('../routes/corrections')(deps);
    const I = mod._internals;
    mod.initSchema();
    await waitSettled(I.CORRECTION_SCHEMA_STATE);
    ok(I.CORRECTION_SCHEMA_STATE.ready === false, 'RC3-L1：非 VOIDED 单 0 primary → ready=false（写入口 503 不放行）');
    ok(/不变量|primary/i.test(I.CORRECTION_SCHEMA_STATE.error || ''),
      'RC3-L1：error 可观测指向主业务方不变量 → ' + (I.CORRECTION_SCHEMA_STATE.error || '(空)'));
    db.close();
  }

  // ───────────────── 场景 3：段二子单（group_id≠id）回填豁免（前向兼容 / 重启安全）─────────────────
  {
    console.log('\n[场景3] 段二前向兼容：跨系统子单（group_id≠id）回填豁免 + 不触发 RC3-L1');
    const db = new sqlite3.Database(':memory:');
    const deps0 = makeDeps(db);
    // 先建到 L1 后状态（含新列+子表）：跑一次 initSchema 让 schema 就位
    await deps0.dbRunAsync(OLD_TABLE_V1840);
    const mod0 = require('../routes/corrections')(deps0);
    mod0.initSchema();
    await waitReady(mod0._internals.CORRECTION_SCHEMA_STATE);
    // 模拟段二建组：主单 id=10（group_id=10）+ 手写主业务方 primary；子单 id=11（group_id=10，兼容列复制主业务方名、无子表行）
    const run = deps0.dbRunAsync, all = deps0.dbAllAsync;
    await run(`INSERT INTO correction_requests (id, source_system, location_info, requester_name, requester_phone, status, correction_type, created_by, correction_group_id)
               VALUES (10,'BMS','主单','王五','13800000010','FIXED','single',1,10)`);
    await run(`INSERT INTO correction_requesters (correction_request_id, requester_name, requester_phone, is_primary, seq) VALUES (10,'王五','13800000010',1,1)`);
    await run(`INSERT INTO correction_requests (id, source_system, location_info, requester_name, requester_phone, status, correction_type, created_by, correction_group_id)
               VALUES (11,'HRD','子单','王五','13800000010','ASSIGNED_PENDING_ESTIMATE','single',1,10)`);
    // 重启再迁移：回填不得为子单 id=11 造 primary；断言不得因子单缺 primary 熔断
    mod0._internals.CORRECTION_SCHEMA_STATE.ready = false;
    mod0._internals.CORRECTION_SCHEMA_STATE.error = null;
    mod0.initSchema();
    await waitSettled(mod0._internals.CORRECTION_SCHEMA_STATE);
    ok(mod0._internals.CORRECTION_SCHEMA_STATE.ready === true,
      '子单豁免：含跨系统子单时 readiness 仍 ready=true（RC3-L1 group_id≠id 不约束）');
    const childRows = await all('SELECT * FROM correction_requesters WHERE correction_request_id=11');
    ok(childRows.length === 0, '重启安全：回填未给子单（group_id≠id）误造 primary 行（§6.1 契约 B 子单不写子表）');
    const masterRows = await all('SELECT * FROM correction_requesters WHERE correction_request_id=10');
    ok(masterRows.length === 1, '主单（group_id=id）primary 行保持 1 条（已有则 NOT EXISTS 跳过，不翻倍）');
    db.close();
  }

  console.log(`\n=== L1 迁移 verify 通过：${pass} 断言 ===`);
})().catch(e => { console.error('✗ FAIL:', e.message); process.exit(1); });
