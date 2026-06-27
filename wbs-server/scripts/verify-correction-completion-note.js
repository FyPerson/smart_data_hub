// 验证脚本：数据修正「普通 single 完成留证放开」（v1.97.1）
// 需求变更：普通（非返工）single 数据修正开发完成，不再强制上传结果证明截图，改为对齐普通 batch——
//   - complete（FIXED）：完成说明【文字必填 ≥5 字】（防敷衍），结果证明截图【可选】。
//   - resubmit（REFIXED）：本次重修说明【文字必填，非空即可】，结果证明截图【可选】；若可选传了截图仍校验新增性（防复用旧图）。
//   - 返工 single（rework_parent_id 非空）：双必填【不变】——截图必传 + 文字必填 ≥5（Commit C 留证闸门，本次不外溢）。
//   - batch 行为不受影响（回归）。
// 覆盖范围：本脚本验 correctionTransition 闸门层语义（截图可选/文字必填/长度/新增性/返工双必填不破/history 拼接）。
//   路由层 /complete · /resubmit 的 files>0 仅返工拦、req.body 透传、前端 FormData append 键名经人工核对前后端一致。
// 用法：node scripts/verify-correction-completion-note.js
//
// 范式同 verify-correction-transition.js：注入 deps + require routes/corrections.js 的 _internals 真实
//   correctionTransition + mod.initSchema() 建真实三表，测的是真实代码（非复刻，无漂移风险）。
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
    sendIssueDingtalkRaw: asyncNoop, UPLOAD_DIR: path.join(require('os').tmpdir(), 'correction-completion-note-verify'),
    readSystemConfig: asyncNoop, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: asyncNoop,
    normalizeAttachmentExt: (x) => x, safeDeleteFileSync: noop, maskPhone: (x) => x,
};
const mod = require('../routes/corrections')(deps);
const I = mod._internals;
const { correctionTransition } = I;
function waitReady() { return new Promise((res) => { const t = setInterval(() => { if (I.CORRECTION_SCHEMA_STATE.ready) { clearInterval(t); res(); } }, 10); }); }

const actor = { id: 1, name: '管理员', role: 'admin' };
const ACTOR_DEV = { id: 5, name: '开发王', role: 'user' };

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
async function expectErr(promise, code, label) {
    try { await promise; assert.fail(`${label}：应抛 ${code} 却成功`); }
    catch (e) { if (!e || !e.code) throw e; assert.strictEqual(e.code, code, `${label}：应抛 ${code}，实际 ${e.code}`); }
}

async function setupSchema() {
    await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT, role TEXT)`);
    await run(`INSERT INTO users (id, display_name, role) VALUES (1,'管理员','admin'),(5,'开发王','user')`);
    mod.initSchema();
    await waitReady();
}

async function createCorrection({ correction_type = 'single' } = {}) {
    const r = await run(
        `INSERT INTO correction_requests (source_system, location_info, requester_name, correction_type, created_by, created_by_name)
         VALUES ('BMS', '合同表#1 金额错，应为 100', '业务张', ?, 1, '管理员')`, [correction_type]);
    const id = r.lastID;
    await run(`INSERT INTO correction_status_history (correction_request_id, from_status, to_status, reason, operator_id, operator_name)
               VALUES (?, NULL, 'PENDING_ASSIGN', '信息技术部建单', 1, '管理员')`, [id]);
    return id;
}
// 返工 single：建一个原单后建返工子单挂其下（rework_parent_id 非空 → isRework）。FIXED/REFIXED 闸门只读 rework_parent_id。
async function createReworkSingle() {
    const root = await createCorrection();
    const r = await run(
        `INSERT INTO correction_requests (source_system, location_info, requester_name, correction_type, created_by, created_by_name, correction_group_id, rework_parent_id, rework_root_id, rework_seq)
         VALUES ('BMS', '返工子单 #1', '业务张', 'single', 1, '管理员', ?, ?, ?, 1)`, [root, root, root]);
    const id = r.lastID;
    await run(`INSERT INTO correction_status_history (correction_request_id, from_status, to_status, reason, operator_id, operator_name)
               VALUES (?, NULL, 'PENDING_ASSIGN', '返工建单', 1, '管理员')`, [id]);
    return id;
}
// 推到 IN_PROGRESS（指派 → 回 ETA）
async function toInProgress(id) {
    await correctionTransition(id, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', actor, { assigned_to: 5, assigned_to_name: '开发王', assigned_by: 1 });
    await correctionTransition(id, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', ACTOR_DEV, { dev_estimated_at: '2026-06-20 12:00' });
}
async function addFixProof(id, name = 'fix.png', created_at = null) {
    return created_at
        ? run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name, created_at) VALUES (?, 'fix_proof', ?, 5, '开发王', ?)`, [id, name, created_at])
        : run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', ?, 5, '开发王')`, [id, name]);
}
const lastRefixReason = async (id) => (await all("SELECT reason FROM correction_status_history WHERE correction_request_id=? AND to_status='REFIXED' ORDER BY id DESC LIMIT 1", [id]))[0].reason;

async function main() {
    await setupSchema();
    ok('schema + users 就绪（真实 initSchema 三表）');

    // ===== 普通 single 标完成（FIXED）=====
    // [1] 文字≥5 + 截图 → FIXED，note 写入
    const c1 = await createCorrection();
    await toInProgress(c1);
    await addFixProof(c1);
    await correctionTransition(c1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '原值因业务方口径调整改为 X，已同步知会财务' });
    const r1 = await get('SELECT status, batch_completion_note FROM correction_requests WHERE id=?', [c1]);
    assert.strictEqual(r1.status, 'FIXED', 'c1 进 FIXED');
    assert.strictEqual(r1.batch_completion_note, '原值因业务方口径调整改为 X，已同步知会财务', 'note 写入 batch_completion_note');
    ok('普通 single complete：文字≥5 + 截图 → FIXED + note 写入');

    // [2] ⭐核心放开：文字≥5 + 【无截图】 → FIXED（截图可选）
    const c2 = await createCorrection();
    await toInProgress(c2);
    await correctionTransition(c2, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '已修正合同金额为 100' });
    const r2 = await get('SELECT status, batch_completion_note FROM correction_requests WHERE id=?', [c2]);
    assert.strictEqual(r2.status, 'FIXED', 'c2 无截图也进 FIXED');
    assert.strictEqual(r2.batch_completion_note, '已修正合同金额为 100', '无截图 note 仍写入');
    ok('⭐普通 single complete：文字≥5 + 无截图 → FIXED（留证放开核心）');

    // [3] 无 note（即便有截图）→ SINGLE_NOTE_REQUIRED（文字改必填）
    const c3 = await createCorrection();
    await toInProgress(c3);
    await addFixProof(c3);
    await expectErr(correctionTransition(c3, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, {}), 'SINGLE_NOTE_REQUIRED', 'single 无完成说明');
    ok('普通 single complete：无完成说明 → SINGLE_NOTE_REQUIRED（文字必填）');

    // [4] 空白 note（trim 后空）→ SINGLE_NOTE_REQUIRED
    await expectErr(correctionTransition(c3, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '   　 ' }), 'SINGLE_NOTE_REQUIRED', 'single 空白说明');
    ok('普通 single complete：纯空白说明 → SINGLE_NOTE_REQUIRED');

    // [5] note < 5 字 → SINGLE_NOTE_TOO_SHORT（防敷衍，与 batch 同口径）
    await expectErr(correctionTransition(c3, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '改了' }), 'SINGLE_NOTE_TOO_SHORT', 'single 说明<5');
    await correctionTransition(c3, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '已经改对了' });   // 恰好 5 字（Array.from===5）边界放行，锁 `<5` 不被误改 `<=5`
    assert.strictEqual((await get('SELECT batch_completion_note FROM correction_requests WHERE id=?', [c3])).batch_completion_note, '已经改对了', 'single note 恰好 5 字边界放行');
    ok('普通 single complete：说明<5 拒 SINGLE_NOTE_TOO_SHORT，恰好 5 字「已经改对了」放行');

    // ===== 普通 single 重修（REFIXED）=====
    // [6] 文字 + 新截图 → REFIXED，reason 含「新增1张」+ note
    const c1fix2 = await addFixProof(c1, 'fix2.png', '2099-01-01 00:00:00');
    await correctionTransition(c1, 'FIXED', 'REFIXED', ACTOR_DEV, { new_fix_proof_attachment_ids: [c1fix2.lastID], resubmit_note: '补充了 2024 年之后的回溯数据' });
    const reason6 = await lastRefixReason(c1);
    assert.ok(reason6.includes('新增 1 张结果证明') && reason6.includes('补充了 2024 年之后的回溯数据'), 'reason 含截图数+note');
    ok(`普通 single resubmit：文字 + 新截图 → history.reason 含两者（"${reason6}"）`);

    // [7] ⭐核心放开：文字 + 【无截图】 → REFIXED，reason 无 proof 段（"重修提交：note"）
    await correctionTransition(c2, 'FIXED', 'REFIXED', ACTOR_DEV, { resubmit_note: '本次按业务方最新口径重新核对' });
    const reason7 = await lastRefixReason(c2);
    assert.strictEqual(reason7, '重修提交：本次按业务方最新口径重新核对', 'reason 无「新增 N 张」段');
    ok('⭐普通 single resubmit：文字 + 无截图 → REFIXED（截图可选，reason 无 proof 段）');

    // [8] 无重修说明 → SINGLE_RESUBMIT_NOTE_REQUIRED（文字改必填）
    const c4 = await createCorrection();
    await toInProgress(c4);
    await correctionTransition(c4, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '首次已修正完成' });
    await expectErr(correctionTransition(c4, 'FIXED', 'REFIXED', ACTOR_DEV, {}), 'SINGLE_RESUBMIT_NOTE_REQUIRED', 'single 重修无说明');
    ok('普通 single resubmit：无重修说明 → SINGLE_RESUBMIT_NOTE_REQUIRED');

    // [9] 重修可选传截图但复用旧图（非新增）→ FIX_PROOF_REQUIRED（留证质量不松：可不传，但传就得真新增）
    // c4 首次完成无截图，构造一张"旧图"（created_at 早于 baseline）模拟复用
    const c4oldProof = await addFixProof(c4, 'old.png', '2000-01-01 00:00:00');
    await expectErr(correctionTransition(c4, 'FIXED', 'REFIXED', ACTOR_DEV, { resubmit_note: '本次重修核对', new_fix_proof_attachment_ids: [c4oldProof.lastID] }), 'FIX_PROOF_REQUIRED', 'single 重修传旧图（非新增）');
    ok('普通 single resubmit：可选传截图但复用旧图（非本次新增）→ FIX_PROOF_REQUIRED（新增性仍校验）');
    // 传真·新增截图 → 放行
    const c4new = await addFixProof(c4, 'new.png', '2099-01-01 00:00:00');
    await correctionTransition(c4, 'FIXED', 'REFIXED', ACTOR_DEV, { resubmit_note: '本次重修核对', new_fix_proof_attachment_ids: [c4new.lastID] });
    ok('普通 single resubmit：传本次新增截图 + 文字 → REFIXED 放行');

    // ===== 返工 single 双必填【不变】回归（证明本次改动不外溢）=====
    // [10] 返工 single complete 无截图 → FIX_PROOF_REQUIRED（双必填截图不破）
    const rw1 = await createReworkSingle();
    await toInProgress(rw1);
    await expectErr(correctionTransition(rw1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '返工已重新修正完成' }), 'FIX_PROOF_REQUIRED', '返工 single 无截图');
    ok('⭐回归：返工 single complete 无截图 → FIX_PROOF_REQUIRED（双必填不破，非外溢）');

    // [11] 返工 single complete 有截图无文字 → REWORK_COMPLETION_NOTE_REQUIRED（双必填文字不破）
    await addFixProof(rw1);
    await expectErr(correctionTransition(rw1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, {}), 'REWORK_COMPLETION_NOTE_REQUIRED', '返工 single 有图无文字');
    await correctionTransition(rw1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '返工已重新修正完成' });
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [rw1])).status, 'FIXED', '返工 single 双必填满足 → FIXED');
    ok('⭐回归：返工 single complete 有图无文字 → REWORK_COMPLETION_NOTE_REQUIRED（双必填不破）');

    // ===== batch 回归（single 改动不影响 batch 分支）=====
    // [12] batch complete 仍必填 ≥5
    const b1 = await createCorrection({ correction_type: 'batch' });
    await toInProgress(b1);
    await expectErr(correctionTransition(b1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, {}), 'BATCH_NOTE_REQUIRED', 'batch 仍必填完成说明');
    await expectErr(correctionTransition(b1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '1' }), 'BATCH_NOTE_TOO_SHORT', 'batch「1」<5 拒');
    await correctionTransition(b1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '已批量修正' });
    ok('回归：batch complete 必填 ≥5（空/「1」拒，「已批量修正」放行）');

    // [13] batch resubmit_note 仍直接写 history.reason
    await correctionTransition(b1, 'FIXED', 'REFIXED', ACTOR_DEV, { resubmit_note: '本次重新核对客户编号映射' });
    assert.strictEqual(await lastRefixReason(b1), '本次重新核对客户编号映射', 'batch resubmit_note 直接作 history.reason');
    ok('回归：batch resubmit_note 仍直接写 history.reason（batch/single 分支独立）');

    // ===== 长度上限（L-3）=====
    // [14] 完成说明 > 500 → COMPLETION_NOTE_TOO_LONG；= 500 边界放行
    const c5 = await createCorrection();
    await toInProgress(c5);
    const long501 = '永'.repeat(501);
    await expectErr(correctionTransition(c5, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: long501 }), 'COMPLETION_NOTE_TOO_LONG', '完成说明超 500');
    await correctionTransition(c5, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '永'.repeat(500) });
    assert.strictEqual((await get('SELECT length(batch_completion_note) AS n FROM correction_requests WHERE id=?', [c5])).n, 500, '500 字边界写入');
    ok('长度上限：完成说明 > 500 拒 COMPLETION_NOTE_TOO_LONG，= 500 放行');

    // [15] 重修说明 > 500 → RESUBMIT_NOTE_TOO_LONG（无截图路径也卡长度）
    await expectErr(correctionTransition(c5, 'FIXED', 'REFIXED', ACTOR_DEV, { resubmit_note: long501 }), 'RESUBMIT_NOTE_TOO_LONG', '重修说明超 500');
    ok('长度上限：重修说明 > 500 拒 RESUBMIT_NOTE_TOO_LONG');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 普通 single 留证放开验证通过（截图可选 + 文字必填≥5/非空 + 新增性仍校验 + 返工双必填不外溢 + batch 双回归 + 长度上限）`);
    db.close();
}
main().catch((e) => { console.error('\n[失败]', e && e.message, e && e.stack); db.close(); process.exit(1); });
