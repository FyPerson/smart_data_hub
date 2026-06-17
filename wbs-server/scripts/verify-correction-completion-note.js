// 验证脚本：数据修正 single「完成说明」选填（2026-06-18 单 commit 轻量迭代）
// 需求：开发完成 single 数据修正时，上传截图（必传不变）之外可选填文字说明。
//   - complete：single 复用 batch_completion_note 字段，非空才写、空/空白保持 NULL；截图必传闸门不被文字替代
//   - resubmit：single 可选 resubmit_note 拼入 history.reason（对称 batch，不加主表字段）
//   - batch 行为不受影响（回归）
// 覆盖范围（codex 47 L-4）：本脚本验 correctionTransition 闸门层语义（写入/空值/长度/截图不被替代/history 拼接）。
//   路由层 /complete · /resubmit 对 req.body.batch_completion_note / resubmit_note 的透传、及前端 FormData append 键名，
//   经人工核对前后端一致（complete/resubmit single 分支），未做完整 HTTP multipart e2e。
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

    // [1] single complete 带完成说明 → batch_completion_note 写入
    const c1 = await createCorrection();
    await toInProgress(c1);
    await addFixProof(c1);
    await correctionTransition(c1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '原值因业务方口径调整改为 X，已同步知会财务' });
    const r1 = await get('SELECT status, batch_completion_note FROM correction_requests WHERE id=?', [c1]);
    assert.strictEqual(r1.status, 'FIXED', 'c1 进 FIXED');
    assert.strictEqual(r1.batch_completion_note, '原值因业务方口径调整改为 X，已同步知会财务', 'single complete 带 note → batch_completion_note 写入');
    ok('single complete 带完成说明 → 写入 batch_completion_note');

    // [2] single complete 不带说明 → NULL；且无截图仍拒（文字不替代截图，留证铁律）
    const c2 = await createCorrection();
    await toInProgress(c2);
    await expectErr(correctionTransition(c2, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '只写文字不传图' }), 'FIX_PROOF_REQUIRED', 'single 仅文字无截图仍拒');
    await addFixProof(c2);
    await correctionTransition(c2, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, {});
    const r2 = await get('SELECT status, batch_completion_note FROM correction_requests WHERE id=?', [c2]);
    assert.strictEqual(r2.status, 'FIXED', 'c2 进 FIXED');
    assert.strictEqual(r2.batch_completion_note, null, 'single complete 无 note → batch_completion_note 保持 NULL');
    ok('single complete 无说明 → NULL；且文字不能替代截图（FIX_PROOF_REQUIRED 仍生效）');

    // [3] single complete 纯空白说明（trim 后空）→ 不写入
    const c3 = await createCorrection();
    await toInProgress(c3);
    await addFixProof(c3);
    await correctionTransition(c3, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '   　 ' });
    const r3 = await get('SELECT batch_completion_note FROM correction_requests WHERE id=?', [c3]);
    assert.strictEqual(r3.batch_completion_note, null, '空白说明 trim 后空 → 不写入');
    ok('single complete 纯空白说明 → 不写入保持 NULL');

    // [4] single resubmit 带说明 → 拼入 history.reason（默认描述：说明）
    const c1fix2 = await addFixProof(c1, 'fix2.png', '2099-01-01 00:00:00');
    await correctionTransition(c1, 'FIXED', 'REFIXED', ACTOR_DEV, { new_fix_proof_attachment_ids: [c1fix2.lastID], resubmit_note: '补充了 2024 年之后的回溯数据' });
    const reason4 = await lastRefixReason(c1);
    assert.ok(reason4.includes('新增 1 张结果证明'), 'resubmit 默认描述保留');
    assert.ok(reason4.includes('补充了 2024 年之后的回溯数据'), 'single resubmit_note 拼入 history.reason');
    ok(`single resubmit 带说明 → history.reason 拼接（"${reason4}"）`);

    // [5] single resubmit 不带说明 → history.reason 仅默认描述（无尾缀）
    const c2fix2 = await addFixProof(c2, 'c2fix2.png', '2099-01-01 00:00:00');
    await correctionTransition(c2, 'FIXED', 'REFIXED', ACTOR_DEV, { new_fix_proof_attachment_ids: [c2fix2.lastID] });
    const reason5 = await lastRefixReason(c2);
    assert.strictEqual(reason5, '重修提交（新增 1 张结果证明）', 'single resubmit 无 note → 默认描述无尾缀');
    ok('single resubmit 无说明 → history.reason 默认描述（不带冒号尾缀）');

    // [6] 回归：batch complete 仍必填 batch_completion_note，single 改动不影响 batch 分支
    const b1 = await createCorrection({ correction_type: 'batch' });
    await toInProgress(b1);
    await expectErr(correctionTransition(b1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, {}), 'BATCH_NOTE_REQUIRED', 'batch 仍必填完成说明');
    await correctionTransition(b1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '批量更新 30 条客户编号映射' });
    const rb1 = await get('SELECT batch_completion_note FROM correction_requests WHERE id=?', [b1]);
    assert.strictEqual(rb1.batch_completion_note, '批量更新 30 条客户编号映射', 'batch note 写入不变');
    ok('回归：batch complete 仍必填 batch_completion_note（single 改动不破坏 batch）');

    // [7] 回归：batch resubmit_note 仍写 history.reason（§9 约束 33，single 改动不破坏 batch）
    await correctionTransition(b1, 'FIXED', 'REFIXED', ACTOR_DEV, { resubmit_note: '本次重新核对客户编号映射' });
    const reason7 = await lastRefixReason(b1);
    assert.strictEqual(reason7, '本次重新核对客户编号映射', 'batch resubmit_note 直接作 history.reason（与 single 拼接格式不同，各自分支独立）');
    ok('回归：batch resubmit_note 仍直接写 history.reason（batch/single 分支互不影响）');

    // [8] 长度上限（codex 47 L-3）：完成说明 > 500 → 400 COMPLETION_NOTE_TOO_LONG；= 500 边界放行（截图已传，仅卡文字超长）
    const c4 = await createCorrection();
    await toInProgress(c4);
    await addFixProof(c4);
    const long501 = '永'.repeat(501);
    await expectErr(correctionTransition(c4, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: long501 }), 'COMPLETION_NOTE_TOO_LONG', '完成说明超 500 字');
    await correctionTransition(c4, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '永'.repeat(500) });
    assert.strictEqual((await get('SELECT length(batch_completion_note) AS n FROM correction_requests WHERE id=?', [c4])).n, 500, '500 字边界写入');
    ok('长度上限（L-3）：完成说明 > 500 拒 COMPLETION_NOTE_TOO_LONG，= 500 边界放行');

    // [9] 长度上限：重修说明 > 500 → 400 RESUBMIT_NOTE_TOO_LONG
    const c4fix2 = await addFixProof(c4, 'c4fix2.png', '2099-01-01 00:00:00');
    await expectErr(correctionTransition(c4, 'FIXED', 'REFIXED', ACTOR_DEV, { new_fix_proof_attachment_ids: [c4fix2.lastID], resubmit_note: long501 }), 'RESUBMIT_NOTE_TOO_LONG', '重修说明超 500 字');
    ok('长度上限（L-3）：重修说明 > 500 拒 RESUBMIT_NOTE_TOO_LONG');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ single 完成说明验证通过（complete 写入/空白不写/截图不被文字替代 + 长度上限 500 + resubmit 进 history + batch 双回归）`);
    db.close();
}
main().catch((e) => { console.error('\n[失败]', e && e.message, e && e.stack); db.close(); process.exit(1); });
