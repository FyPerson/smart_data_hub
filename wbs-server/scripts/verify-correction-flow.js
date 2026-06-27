// 验证脚本：数据修正模块 reply-estimate + complete + resubmit + attachments + D1（reject/archive/void）端点编排层
// 方案：docs/local/数据修正/数据修正模块_方案_20260612_v1.3.md（§4.3/§4.4/§4.4a/§4.5）
// 用法：node scripts/verify-correction-flow.js
//
// J3（RC-L2 根治）：本脚本原**复刻**了完整 correctionTransition（与 transition verify 同一漂移源）。现改为
//   **require routes/corrections.js 的真实 _internals.correctionTransition**（db helper 注入本脚本 :memory: db）。
//   下方 epXxx 端点编排（persist 附件 → 调 transition → 失败回滚）是**本脚本的测试模拟**（真实 endpoint 在
//   corrections.js handler 内联，未抽函数导出，属务实收尾保留项）——但它们调的是**真实 transition**，故核心闸门同源。
//   ⚠️ 改 corrections.js 的 complete/resubmit/attachments handler 编排（persist 顺序/回滚/旁路状态闸门）时，须同步本文件 epXxx。
const assert = require('assert');
const sqlite3 = require('sqlite3');
const path = require('path');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

// 注入 deps + require 真实 corrections 模块（correctionTransition / 枚举 真实导出，非复刻）
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
const asyncNoop = async () => ({});
const deps = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass, requirePublisherOrAdmin: mwPass,
    sendIssueDingtalkRaw: asyncNoop, UPLOAD_DIR: path.join(require('os').tmpdir(), 'correction-flow-verify'),
    readSystemConfig: asyncNoop, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: asyncNoop,
    normalizeAttachmentExt: (x) => x, safeDeleteFileSync: noop, maskPhone: (x) => x,
};
const mod = require('../routes/corrections')(deps);
const I = mod._internals;
const correctionTransition = I.correctionTransition;   // ⭐ 真实导出（含 v1.82.0 对接人 relay 放行）
function waitReady() { return new Promise((res) => { const t = setInterval(() => { if (I.CORRECTION_SCHEMA_STATE.ready) { clearInterval(t); res(); } }, 10); }); }

// 端点级轻量错误（给 epXxx 的权限/文件预校验抛错用；真实 transition 抛真实 CorrectionTransitionError，二者均带 .code）
class EndpointError extends Error { constructor(httpStatus, code, message) { super(message); this.httpStatus = httpStatus; this.code = code; } }

// === 端点编排测试模拟（persist 用 INSERT；调真实 transition）===
async function persistAttachments(rid, uploader, count, createdAt = null) {
    const ids = [];
    for (let i = 0; i < count; i++) {
        const r = createdAt
            ? await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name, created_at) VALUES (?, 'fix_proof', ?, ?, ?, ?)`, [rid, `correction/${rid}/f${i}.png`, uploader.id, uploader.name, createdAt])
            : await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', ?, ?, ?)`, [rid, `correction/${rid}/f${i}.png`, uploader.id, uploader.name]);
        ids.push(r.lastID);
    }
    return ids;
}
async function rollbackPersisted(ids) { for (const id of ids) { try { await run('DELETE FROM correction_attachments WHERE id = ?', [id]); } catch (_) {} } }

async function epReplyEstimate(id, actor, devEstimatedAt) {
    return correctionTransition(id, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', actor, { dev_estimated_at: devEstimatedAt });
}
async function epComplete(id, actor, { fileCount = 0, batchNote = null } = {}) {
    const row = await get('SELECT id, status, correction_type, assigned_to FROM correction_requests WHERE id = ?', [id]);
    if (!row) throw new EndpointError(404, 'CORRECTION_NOT_FOUND', '修正单不存在');
    const isAdmin = actor.role === 'admin', isAssignee = Number(row.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
    if (!isAdmin && !isAssignee) throw new EndpointError(403, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权标完成');
    let persisted = [];
    try {
        // v1.97.1：普通 single/batch 同口径——截图可选（仅返工须上传，flow 不测返工）、文字必填在 transition 校验
        if (fileCount > 0) persisted = await persistAttachments(id, actor, fileCount);
        return await correctionTransition(id, 'IN_PROGRESS', 'FIXED', actor, { batch_completion_note: batchNote || '' });
    } catch (e) { await rollbackPersisted(persisted); throw e; }
}
async function epResubmit(id, actor, { fileCount = 0, resubmitNote = null, uploadCreatedAt = null } = {}) {
    const row = await get('SELECT id, status, correction_type, assigned_to FROM correction_requests WHERE id = ?', [id]);
    if (!row) throw new EndpointError(404, 'CORRECTION_NOT_FOUND', '修正单不存在');
    const isAdmin = actor.role === 'admin', isAssignee = Number(row.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
    if (!isAdmin && !isAssignee) throw new EndpointError(403, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权重修提交');
    let persisted = [];
    try {
        // v1.97.1：普通 single/batch 同口径——截图可选（传了走新增性校验）、文字必填在 transition 校验
        if (fileCount > 0) persisted = await persistAttachments(id, actor, fileCount, uploadCreatedAt);   // ⭐RC-M1：只传本次 id
        return await correctionTransition(id, row.status, 'REFIXED', actor, { new_fix_proof_attachment_ids: persisted, resubmit_note: resubmitNote || '' });
    } catch (e) { await rollbackPersisted(persisted); throw e; }
}
async function epAddAttachments(id, actor, { fileCount = 1 } = {}) {
    const row = await get('SELECT id, status, assigned_to, created_by FROM correction_requests WHERE id = ?', [id]);
    if (!row) throw new EndpointError(404, 'CORRECTION_NOT_FOUND', '修正单不存在');
    const isAdmin = actor.role === 'admin';
    const isAssignee = Number(row.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
    const isCreator = Number(row.created_by) === Number(actor.id) && Number(actor.id) > 0;
    if (!isAdmin && !isAssignee && !isCreator) throw new EndpointError(403, 'NOT_AUTHORIZED_FOR_ATTACHMENT', '无权补充附件');
    if (row.status !== 'FIXED' && row.status !== 'REFIXED') throw new EndpointError(409, 'INVALID_STATE_FOR_ATTACHMENT', '仅已完成的修正单可补充附件');
    if (fileCount === 0) throw new EndpointError(400, 'NO_FILE', '未收到上传文件');
    return persistAttachments(id, actor, fileCount);
}
async function epReject(id, actor, reason) { return correctionTransition(id, null, 'REJECTED', actor, { reject_reason: reason }); }
async function epArchive(id, actor, friction) { return correctionTransition(id, null, 'ARCHIVED', actor, { friction_reason: friction }); }
async function epVoid(id, actor, reason) { return correctionTransition(id, null, 'VOIDED', actor, { void_reason: reason }); }

async function createCorrection({ correction_type = 'single', created_by = 1, created_by_name = '管理员' } = {}) {
    const r = await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, correction_type, created_by, created_by_name) VALUES ('BMS', '合同表#1 金额错，应为 100', '业务张', ?, ?, ?)`, [correction_type, created_by, created_by_name]);
    return r.lastID;
}
const ADMIN = { id: 1, name: '管理员', role: 'admin' };
const DEV = { id: 5, name: '开发王', role: 'user' };
const PUB = { id: 7, name: '示例发布者', role: 'publisher' };
const STRANGER = { id: 99, name: '路人', role: 'user' };

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
async function expectErr(promise, code, label) {
    try { await promise; assert.fail(`${label}：应抛 ${code} 却成功`); }
    catch (e) { if (!e || !e.code) throw e; assert.strictEqual(e.code, code, `${label}：应抛 ${code}，实际 ${e.code}`); }
}
async function setupSchema() {
    await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT, role TEXT)`);
    await run(`INSERT INTO users (id, display_name, role) VALUES (1,'管理员','admin'),(5,'开发王','user'),(7,'示例发布者','publisher'),(99,'路人','user')`);
    mod.initSchema();           // J3：真实建表（替代复刻 DDL）
    await waitReady();
}
async function toInProgress(id, est = '2026-06-20 12:00') {
    await run(`UPDATE correction_requests SET status='ASSIGNED_PENDING_ESTIMATE', assigned_to=5, assigned_to_name='开发王', assigned_by=1 WHERE id=?`, [id]);
    await epReplyEstimate(id, DEV, est);
}

async function main() {
    await setupSchema();
    ok('schema + users 就绪（真实 initSchema）');

    // [1] reply-estimate：ESTIMATE 闸门 + →IN_PROGRESS
    const a = await createCorrection({ correction_type: 'single' });
    await run(`UPDATE correction_requests SET status='ASSIGNED_PENDING_ESTIMATE', assigned_to=5, assigned_to_name='开发王', assigned_by=1 WHERE id=?`, [a]);
    await expectErr(epReplyEstimate(a, DEV, 'abc'), 'ESTIMATE_REQUIRED', 'reply-estimate 非法日期');
    await expectErr(epReplyEstimate(a, STRANGER, '2026-06-20 12:00'), 'NOT_AUTHORIZED_FOR_TRANSITION', '非本单开发回复预计');
    await epReplyEstimate(a, DEV, '2026-06-20T12:00');
    const ra = await get('SELECT status, dev_estimated_at FROM correction_requests WHERE id=?', [a]);
    assert.strictEqual(ra.status, 'IN_PROGRESS', '→IN_PROGRESS');
    assert.strictEqual(ra.dev_estimated_at, '2026-06-20 12:00:00', 'dev_estimated_at 归一化');
    ok('reply-estimate：非法日期拒 / 非本单开发拒 / 合法→IN_PROGRESS + 归一化（真实 transition）');

    // [2] complete 普通 single（v1.97.1 留证放开）：文字必填 / 非本单开发拒 / 文字+无截图→FIXED + count=1（截图可选）
    await expectErr(epComplete(a, DEV, { fileCount: 0 }), 'SINGLE_NOTE_REQUIRED', 'complete single 无完成说明');
    await expectErr(epComplete(a, STRANGER, { fileCount: 0, batchNote: '已修正完成口径' }), 'NOT_AUTHORIZED_FOR_TRANSITION', '非本单开发标完成');
    await epComplete(a, DEV, { fileCount: 0, batchNote: '已修正合同金额为 100' });   // 截图可选：不传也放行
    const r2 = await get('SELECT status, submission_count FROM correction_requests WHERE id=?', [a]);
    assert.strictEqual(r2.status, 'FIXED', 'complete→FIXED');
    assert.strictEqual(r2.submission_count, 1, 'count=1');
    ok('complete 普通 single（v1.97.1）：无文字拒 SINGLE_NOTE_REQUIRED / 非本单开发拒 / 文字+无截图→FIXED + count=1');

    // [3] complete batch：无 note 拒 / 有 note→FIXED（无附件要求）
    const b = await createCorrection({ correction_type: 'batch' });
    await toInProgress(b);
    await expectErr(epComplete(b, DEV, { fileCount: 0, batchNote: '' }), 'BATCH_NOTE_REQUIRED', 'complete batch 无 note');
    await epComplete(b, DEV, { fileCount: 0, batchNote: '批量更新 30 条' });
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [b])).status, 'FIXED', 'batch→FIXED 无附件');
    ok('complete batch：无 note 拒 / 有 note→FIXED（无附件要求）');

    // [4] resubmit 普通 single（v1.97.1 留证放开）：重修说明必填 / 文字+无截图→REFIXED + count+1（截图可选，新增性仅在传截图时校验）
    await expectErr(epResubmit(a, DEV, { fileCount: 0 }), 'SINGLE_RESUBMIT_NOTE_REQUIRED', 'resubmit single 无说明');
    await epResubmit(a, DEV, { fileCount: 0, resubmitNote: '本次按业务方口径重新核对' });   // 截图可选：不传也放行
    const r4 = await get('SELECT status, submission_count FROM correction_requests WHERE id=?', [a]);
    assert.strictEqual(r4.status, 'REFIXED', 'resubmit→REFIXED');
    assert.strictEqual(r4.submission_count, 2, 'count+1=2');
    ok('resubmit 普通 single（v1.97.1）：无说明拒 SINGLE_RESUBMIT_NOTE_REQUIRED / 文字+无截图→REFIXED + count+1');

    // [5] 新增性兜底仍守：可选传截图时若传历史旧 fix_proof（created_at≤baseline）→ FIX_PROOF_REQUIRED（含 resubmit_note 越过文字闸门后命中新增性）
    const c5fix = await createCorrection({ correction_type: 'single' });
    await toInProgress(c5fix);
    await epComplete(c5fix, DEV, { fileCount: 1, batchNote: '首次已修正完成' });   // 首次带截图，建立 baseline=fixed_at
    const oldFix = await get(`SELECT id FROM correction_attachments WHERE correction_request_id=? AND attachment_type='fix_proof' ORDER BY id LIMIT 1`, [c5fix]);
    await expectErr(correctionTransition(c5fix, 'FIXED', 'REFIXED', DEV, { new_fix_proof_attachment_ids: [oldFix.id], resubmit_note: '本次重新核对' }), 'FIX_PROOF_REQUIRED', '误传历史旧附件 id（越过文字闸门命中新增性）');
    ok('RC-M1 反证：误传历史旧 fix_proof id（created_at≤baseline）被新增性闸门拒 → 证明"只传本次上传 id"是必要前置');

    // [6] resubmit batch：无 note 拒 / 有附件但 note 空→拒+附件回滚（L-3）/ 有 note→REFIXED + 写 history.reason
    await expectErr(epResubmit(b, DEV, { fileCount: 0, resubmitNote: '' }), 'BATCH_RESUBMIT_NOTE_REQUIRED', 'resubmit batch 无 note');
    const bAttBefore = (await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [b])).c;
    await expectErr(epResubmit(b, DEV, { fileCount: 1, resubmitNote: '', uploadCreatedAt: '2099-01-01 00:00:00' }), 'BATCH_RESUBMIT_NOTE_REQUIRED', 'resubmit batch 有附件但 note 空');
    const bAttAfter = (await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [b])).c;
    assert.strictEqual(bAttAfter, bAttBefore, 'L-3：batch resubmit note 空 → 本次可选附件回滚（计数不变）');
    await epResubmit(b, DEV, { resubmitNote: '重核客户编号映射' });
    const h6 = await all(`SELECT reason FROM correction_status_history WHERE correction_request_id=? AND to_status='REFIXED'`, [b]);
    assert.strictEqual(h6[0].reason, '重核客户编号映射', 'batch resubmit_note 写 history.reason');
    ok('resubmit batch：无 note 拒 / 有附件 note 空→拒+附件回滚（L-3）/ 有 note→REFIXED + resubmit_note 写 history.reason');

    // [7] transition 失败回滚附件
    const c = await createCorrection({ correction_type: 'single' });
    await toInProgress(c);
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', 'pre.png', 5, '开发王')`, [c]);
    await correctionTransition(c, 'IN_PROGRESS', 'FIXED', DEV, { batch_completion_note: '已修正完成口径说明' });   // v1.97.1：普通 single 文字必填
    const before = (await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [c])).c;
    await expectErr(epComplete(c, DEV, { fileCount: 2 }), 'INVALID_TRANSITION', 'FIXED 单再 complete（FIXED→FIXED 非法流转）');
    const after = (await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [c])).c;
    assert.strictEqual(after, before, 'transition 失败 → 本次 persist 的 2 个附件已回滚（计数不变）');
    ok('transition 失败回滚：persist 后 transition 抛错（INVALID_TRANSITION）→ 本次落库附件被回滚（无 orphan）');

    // [8] attachments 旁路：状态闸门 + 不改状态不增 count
    const d = await createCorrection({ correction_type: 'single' });
    await toInProgress(d);
    await expectErr(epAddAttachments(d, DEV, { fileCount: 1 }), 'INVALID_STATE_FOR_ATTACHMENT', 'IN_PROGRESS 补充附件（防完成前伪造留证）');
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', 'x.png', 5, '开发王')`, [d]);
    await correctionTransition(d, 'IN_PROGRESS', 'FIXED', DEV, { batch_completion_note: '已修正完成口径说明' });   // v1.97.1：普通 single 文字必填
    const cntBefore = (await get('SELECT submission_count FROM correction_requests WHERE id=?', [d])).submission_count;
    await epAddAttachments(d, DEV, { fileCount: 2 });
    const rd = await get('SELECT status, submission_count FROM correction_requests WHERE id=?', [d]);
    assert.strictEqual(rd.status, 'FIXED', '旁路 append 不改状态（仍 FIXED）');
    assert.strictEqual(rd.submission_count, cntBefore, '旁路 append 不增 submission_count');
    ok('attachments 旁路：IN_PROGRESS 拒（M-1 防伪造）/ FIXED 放行 / 不改状态 + 不增 count');

    // [9] attachments 权限矩阵（M-2）：creator/assignee/admin 放行 / stranger 拒
    const e = await createCorrection({ correction_type: 'single', created_by: 7, created_by_name: '示例发布者' });
    await run(`UPDATE correction_requests SET status='FIXED', assigned_to=5, assigned_to_name='开发王', submission_count=1, fixed_at=datetime('now','localtime') WHERE id=?`, [e]);
    await expectErr(epAddAttachments(e, STRANGER, { fileCount: 1 }), 'NOT_AUTHORIZED_FOR_ATTACHMENT', 'stranger 补充附件');
    await epAddAttachments(e, PUB, { fileCount: 1 });
    await epAddAttachments(e, DEV, { fileCount: 1 });
    await epAddAttachments(e, ADMIN, { fileCount: 1 });
    assert.strictEqual((await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [e])).c, 3, 'creator+assignee+admin 各 append 1 → 3 个');
    ok('attachments 权限矩阵（M-2）：creator/assignee/admin 放行 / stranger 拒（403 NOT_AUTHORIZED_FOR_ATTACHMENT）');

    // [10] M-2 已知限制：同秒 created_at==baseline 被新增性闸门拒（诚实记录）
    const f = await createCorrection({ correction_type: 'single' });
    await toInProgress(f);
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', 'f1.png', 5, '开发王')`, [f]);
    await correctionTransition(f, 'IN_PROGRESS', 'FIXED', DEV, { batch_completion_note: '已修正完成口径说明' });   // v1.97.1：普通 single 文字必填
    const fFixedAt = (await get('SELECT fixed_at FROM correction_requests WHERE id=?', [f])).fixed_at;
    const sameSec = await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name, created_at) VALUES (?, 'fix_proof', 'same.png', 5, '开发王', ?)`, [f, fFixedAt]);
    await expectErr(correctionTransition(f, 'FIXED', 'REFIXED', DEV, { new_fix_proof_attachment_ids: [sameSec.lastID], resubmit_note: '本次重新核对口径' }), 'FIX_PROOF_REQUIRED', '同秒 created_at==baseline 误拒（含说明越过文字闸门命中新增性）');
    ok('M-2 已知限制（诚实记录非掩盖）：同秒 created_at==baseline 被新增性闸门拒；真实环境 resubmit 在 FIXED 后分钟级不触发');

    // [11] D1 reject 薄封装：多源态 + R-1
    const g1 = await createCorrection({ correction_type: 'single' });
    await expectErr(epReject(g1, ADMIN, ''), 'REJECT_REASON_REQUIRED', 'reject 无 reason');
    await epReject(g1, ADMIN, '业务上无需修正');
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [g1])).status, 'REJECTED', 'reject PENDING_ASSIGN→REJECTED');
    const g2 = await createCorrection({ correction_type: 'single' });
    await toInProgress(g2);
    await epReject(g2, DEV, '改不动需退回');
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [g2])).status, 'REJECTED', 'reject IN_PROGRESS→REJECTED（多源态，null expectedFrom）');
    const g3 = await createCorrection({ correction_type: 'single' });
    await toInProgress(g3);
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', 'g.png', 5, '开发王')`, [g3]);
    await correctionTransition(g3, 'IN_PROGRESS', 'FIXED', DEV, { batch_completion_note: '已修正完成口径说明' });   // v1.97.1：普通 single 文字必填
    await expectErr(epReject(g3, ADMIN, 'x'), 'INVALID_TRANSITION', 'reject FIXED（R-1 完成态不可拒）');
    ok('D1 reject：无 reason 拒 / PENDING_ASSIGN+IN_PROGRESS 多源态→REJECTED / FIXED→INVALID_TRANSITION（R-1）');

    // [12] D1 archive/void 薄封装
    const g4 = await createCorrection({ correction_type: 'single', created_by: 1 });
    await run(`UPDATE correction_requests SET status='FIXED', assigned_to=5, dingtalk_chat_id='cid1', submission_count=1, fixed_at=datetime('now','localtime') WHERE id=?`, [g4]);
    await expectErr(epArchive(g4, ADMIN, ''), 'FRICTION_REASON_REQUIRED', 'archive 有 chat 无 friction');
    await epArchive(g4, ADMIN, '拉群澄清后确认');
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [g4])).status, 'ARCHIVED', 'archive→ARCHIVED');
    await epVoid(g4, ADMIN, '误归档');
    assert.strictEqual((await get('SELECT status, voided_at FROM correction_requests WHERE id=?', [g4])).status, 'VOIDED', 'archive 后 void→VOIDED 旁路');
    await expectErr(epVoid(g4, ADMIN, ''), 'ALREADY_VOIDED', '重复作废');
    ok('D1 archive/void：archive 有 chat 必填 friction→ARCHIVED / void 通用旁路 ARCHIVED→VOIDED + 重复作废 ALREADY_VOIDED');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 端点编排验证通过【J3 require 真实 transition，端点编排为测试模拟】（reply-estimate / complete / ⭐RC-M1 resubmit + 反证 / resubmit batch + 回滚 / transition 失败回滚 / attachments 旁路 + M-2 权限 / D1 reject 多源态 + R-1 / archive 摩擦闸门 / void 旁路 + 重复作废）`);
    db.close();
}
main().catch((e) => { console.error('\n[失败]', e && e.message, e && e.stack); db.close(); process.exit(1); });
