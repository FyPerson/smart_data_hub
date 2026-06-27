// 验证脚本：数据修正模块「归档单事后返工」schema 层（Commit A）
// 方案：docs/local/数据修正/数据修正模块_归档单返工_方案_20260626_v1.2.md §3（字段）/ §3.1（DB 层防护）/ §9.2（不变量）
// 用法：node scripts/verify-correction-rework-schema.js
//
// 覆盖（codex 66/67/68 审 + 五视角对抗审加固点）：
//   [1] 5 rework 列存在 + 全 NULLABLE + rework_child_count DEFAULT 0
//   [2] 5 列【不入】CORRECTION_REQUESTS_KEY_COLS（可空辅助列，与 error_proof_note 同级，缺失不阻断写入口）
//   [3] 唯一索引 idx_correction_rework_root_seq + 血缘索引 idx_corr_rework_parent/root 存在
//   [4] 新库建表 CHECK（rework_parent_id 非空 ⇒ correction_group_id 非空）生效——直接 INSERT 违反被拒
//   [5] 唯一索引生效：同一 (rework_root_id, rework_seq) 重复 INSERT 被拒（H-3 DB 兜底）
//   [6] 部分唯一索引边界：rework_root_id/seq 任一为 NULL 不受唯一约束（多条 NULL 共存）
//   [7] readiness [2g] 不变量探针：rework_parent_id 非空但 group_id=自身 id 的脏写 → ready=false（既有库兜底，M-2）
//   [8] ⭐建前重复脏数据熔断（codex 69 H-1 回归锁）：既有库存在重复 (root,seq) → migration 熔断 ready=false 且 error 锚"重复脏数据"不被 [2g]/[3] 覆盖（验 dup 分支 return）
//
// 范式：require 真实 routes/corrections.js 的 mod.initSchema() 建表（不复刻 DDL，漂移即暴露，对齐 verify-correction-schema J3）。
const assert = require('assert');
const sqlite3 = require('sqlite3');
const path = require('path');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
const asyncNoop = async () => ({});
const deps = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass, requirePublisherOrAdmin: mwPass,
    sendIssueDingtalkRaw: asyncNoop, UPLOAD_DIR: path.join(require('os').tmpdir(), 'correction-rework-schema-verify'),
    readSystemConfig: asyncNoop, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: asyncNoop,
    normalizeAttachmentExt: (x) => x, safeDeleteFileSync: noop, maskPhone: (x) => x,
};
const mod = require('../routes/corrections')(deps);
const I = mod._internals;
function waitReady() { return new Promise((res, rej) => { let n = 0; const t = setInterval(() => { if (I.CORRECTION_SCHEMA_STATE.ready) { clearInterval(t); res(); } else if (++n > 500) { clearInterval(t); rej(new Error('initSchema 超时未 ready: ' + I.CORRECTION_SCHEMA_STATE.error)); } }, 10); }); }

const REWORK_COLS = ['rework_parent_id', 'rework_root_id', 'rework_seq', 'reopen_reason', 'rework_child_count'];

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

// 完整建一张可流转的最小主单（含 created_by/status 等 NOT NULL）；返回 id
async function insertBaseRow(overrides = {}) {
    const base = { source_system: 'BMS', location_info: 'loc', requester_name: '业务张', created_by: 1, status: 'ARCHIVED', correction_type: 'single' };
    const row = { ...base, ...overrides };
    const keys = Object.keys(row);
    const r = await run(`INSERT INTO correction_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
    return r.lastID;
}

async function main() {
    mod.initSchema();
    await waitReady();
    ok('真实 initSchema 建表 + readiness 通过（新库路径，含 rework 列建表 CHECK）');

    const colRows = await all('PRAGMA table_info(correction_requests)');
    const colByName = Object.fromEntries(colRows.map(r => [r.name, r]));

    // [1] 5 rework 列存在 + NULLABLE + rework_child_count DEFAULT 0
    const missing = REWORK_COLS.filter(c => !colByName[c]);
    assert.strictEqual(missing.length, 0, `rework 列缺失: ${missing.join(',')}`);
    ok(`5 个 rework 列齐全：${REWORK_COLS.join(' / ')}`);
    const notNullable = REWORK_COLS.filter(c => colByName[c].notnull === 1);
    assert.strictEqual(notNullable.length, 0, `rework 列不应 NOT NULL（须 NULLABLE 兼容历史单）: ${notNullable.join(',')}`);
    ok('5 列全 NULLABLE（历史/非返工单为 NULL）');
    assert.strictEqual(String(colByName['rework_child_count'].dflt_value), '0', 'rework_child_count 应 DEFAULT 0');
    ok('rework_child_count DEFAULT 0（对齐 submission_count，避免 NULL）');

    // [2] 5 列【不入】KEY_COLS（与 error_proof_note 同级）
    const leaked = REWORK_COLS.filter(c => I.CORRECTION_REQUESTS_KEY_COLS.includes(c));
    assert.strictEqual(leaked.length, 0, `rework 列不应入 KEY_COLS（可空辅助列）: ${leaked.join(',')}`);
    ok('5 列均不入 CORRECTION_REQUESTS_KEY_COLS（缺失不阻断写入口，与 error_proof_note 同级）');

    // [3] 唯一索引 + 血缘索引存在
    const idxRows = (await all("SELECT name FROM sqlite_master WHERE type='index'")).map(r => r.name);
    for (const idx of ['idx_correction_rework_root_seq', 'idx_corr_rework_parent', 'idx_corr_rework_root']) {
        assert.ok(idxRows.includes(idx), `索引缺失: ${idx}`);
    }
    ok('唯一索引 idx_correction_rework_root_seq + 血缘索引 idx_corr_rework_parent/root 齐全');

    // [4] 新库建表 CHECK：rework_parent_id 非空但 group_id NULL → 直接 INSERT 被拒
    await assert.rejects(
        insertBaseRow({ rework_parent_id: 999, correction_group_id: null }),
        /CHECK constraint failed/i, '建表 CHECK（parent 非空⇒group_id 非空）未生效');  // codex 69 L-1：收窄到 CHECK 文案，避免 NOT NULL 等其他 constraint 误判通过
    ok('[CHECK] 新库建表 CHECK 生效：rework_parent_id 非空但 group_id NULL 的直接 INSERT 被拒（断言精确匹配 CHECK constraint failed）');

    // [5] 唯一索引生效：同一 (root, seq) 重复 → 拒（H-3）
    const masterId = await insertBaseRow({ status: 'ARCHIVED' });
    await run('UPDATE correction_requests SET correction_group_id=? WHERE id=?', [masterId, masterId]); // 升主单
    // 合法返工子单：group_id=masterId（≠自身）, parent=masterId, root=masterId, seq=1
    const childId1 = await insertBaseRow({ status: 'ASSIGNED_PENDING_ESTIMATE', correction_group_id: masterId, rework_parent_id: masterId, rework_root_id: masterId, rework_seq: 1 });
    assert.ok(childId1 > 0, '合法返工子单应可插入');
    ok('合法返工子单可插入（group_id=master≠自身, parent/root=master, seq=1）');
    await assert.rejects(
        insertBaseRow({ status: 'ASSIGNED_PENDING_ESTIMATE', correction_group_id: masterId, rework_parent_id: masterId, rework_root_id: masterId, rework_seq: 1 }),
        /UNIQUE|constraint/i, '(root, seq) 唯一索引未生效');
    ok('[H-3] 唯一索引生效：同一 (rework_root_id, rework_seq)=（master,1）重复 INSERT 被拒');

    // [6] 部分唯一索引边界：root/seq 任一 NULL 不受约束（多条共存）
    const a = await insertBaseRow({ rework_root_id: null, rework_seq: null });
    const b = await insertBaseRow({ rework_root_id: null, rework_seq: null });
    assert.ok(a > 0 && b > 0 && a !== b, '两条 root/seq=NULL 应可共存（部分唯一索引 WHERE 排除 NULL）');
    ok('[边界] 部分唯一索引正确：rework_root_id/seq 为 NULL 的多条（历史/非返工单）共存不冲突');

    // [7] readiness [2g] 不变量探针：rework_parent_id 非空但 group_id=自身 → ready=false（既有库兜底，CHECK 管不到"≠自身"）
    //   绕过建表 CHECK（group_id 非空满足 CHECK）但违反"≠自身"：先插合法行再 UPDATE 成 group_id=自身。
    const bad = await insertBaseRow({ status: 'ASSIGNED_PENDING_ESTIMATE', correction_group_id: masterId, rework_parent_id: masterId, rework_root_id: masterId, rework_seq: 2 });
    await run('UPDATE correction_requests SET correction_group_id=? WHERE id=?', [bad, bad]); // group_id=自身 id（违反不变量）
    I.CORRECTION_SCHEMA_STATE.ready = false; // 重置后重跑 migration 复查（ddlError=null）
    await I.runCorrectionMigration(null);
    assert.strictEqual(I.CORRECTION_SCHEMA_STATE.ready, false, '[2g] 探针应拦截 group_id=自身 的返工子单脏写');
    assert.ok(/返工不变量/.test(I.CORRECTION_SCHEMA_STATE.error || ''), `[2g] 错误信息应含"返工不变量"，实际: ${I.CORRECTION_SCHEMA_STATE.error}`);
    ok('[2g/M-2] readiness 不变量探针生效：rework_parent_id 非空但 group_id=自身 id 的脏写 → ready=false（既有库兜底）');

    // [8/H-1] ⭐ 建前重复脏数据熔断（codex 69 H-1 修复的回归锁 + M-1 覆盖缺口补全）：
    //   模拟"既有库迁移路径"——先 DROP 唯一索引（等价既有库尚未建索引，让重复可插入），插两条相同非空 (root,seq)，
    //   重跑 migration，断言 [2a-x4] dup 探针熔断 ready=false 且【error 仍锚定"重复脏数据"未被后续 [2g]/[3] 覆盖】。
    //   ⭐ 若 dup 分支漏 return（H-1 原 bug），流程会穿透去 CREATE UNIQUE INDEX（脏数据下崩 UNIQUE）或被 [3](null) 覆盖 → error 不再含"重复脏数据" → 本断言失败，故此用例即 H-1 回归锁。
    //   codex 70 L-1 加固：先清掉 [7] 制造的 bad 行，使本用例只剩"重复 (root,seq)"一种脏数据、不依赖 [2g] 与探针的执行先后，回归锁自包含、抗后续重排。
    await run('DELETE FROM correction_requests WHERE id=?', [bad]);
    await run('DROP INDEX IF EXISTS idx_correction_rework_root_seq');
    await insertBaseRow({ rework_root_id: masterId, rework_seq: 9 }); // parent=NULL 不触建表 CHECK，仅造 (root,seq) 重复
    await insertBaseRow({ rework_root_id: masterId, rework_seq: 9 });
    I.CORRECTION_SCHEMA_STATE.ready = false;
    await I.runCorrectionMigration(null);
    assert.strictEqual(I.CORRECTION_SCHEMA_STATE.ready, false, '[H-1] 建前重复 (root,seq) 脏数据应熔断 ready=false（不被 [3] 覆盖）');
    assert.ok(/重复脏数据/.test(I.CORRECTION_SCHEMA_STATE.error || ''), `[H-1] 错误信息应含"重复脏数据"（证明 dup 分支 return 生效、熔断未被后续探针覆盖），实际: ${I.CORRECTION_SCHEMA_STATE.error}`);
    ok('[H-1/M-1] 建前重复脏数据熔断生效：(root,seq) 重复 → migration 后 ready=false 且 error 锚定"重复脏数据"未被 [2g]/[3] 覆盖（dup 分支 return 回归锁）');

    console.log(`\n✅ verify-correction-rework-schema 全部通过（${passed} 项）`);
    process.exit(0);
}

main().catch(e => { console.error('\n❌ 验证失败：', e && (e.stack || e.message)); process.exit(1); });
