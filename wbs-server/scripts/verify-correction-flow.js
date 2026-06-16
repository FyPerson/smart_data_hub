// 验证脚本：数据修正模块 Commit C — reply-estimate + complete + resubmit + attachments（端点编排层）
// 方案：docs/local/数据修正/数据修正模块_方案_20260612_v1.3.md（§4.3/§4.4/§4.4a/§4.5）
// 用法：node scripts/verify-correction-flow.js
// 模式：临时内存 sqlite，忠实移植 server.js 的 correctionTransition + 4 个 endpoint 的"上传附件→调 transition"
//   编排逻辑（permission 预校验 / RC-M1 先传后传 id / 旁路 attachments 状态闸门 / transition 失败回滚附件）。
//   transition 8 态闸门本身已在 verify-correction-transition.js（Commit B）全覆盖；本文件**只测 C 新增的端点级行为**。
//
// ⚠️ 移植双份局限（同 Commit B verify / RC-L2）：复刻而非 require server.js（顶层 app.listen 占端口）。高价值 SQL 契约
//   （fix_proof join users 闸门、RC-M1 新增性 IN 校验、旁路状态闸门）在真实 sqlite 上跑，可信；纯 JS 编排靠人工同步。
// ⚠️ 踩坑 #2（0615）：REFIXED 新增性闸门 created_at > baseline 在同秒下假失败 → resubmit 测试用显式 '2099-01-01'
//   时间戳模拟"本次上传晚于上次完成"（真实环境 resubmit 在 FIXED 之后分钟/小时级，自然满足；测试跑太快需显式隔离）。
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

// === 与 server.js 同步的枚举/流转表 + transition（忠实移植，db helper 换 run/get）===
const CORRECTION_STATUSES = ['PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', 'FIXED', 'REFIXED', 'ARCHIVED', 'REJECTED', 'VOIDED'];
const CORRECTION_STATUS_TRANSITIONS = {
    'PENDING_ASSIGN': ['ASSIGNED_PENDING_ESTIMATE', 'ARCHIVED', 'REJECTED', 'VOIDED'],   // I2 M-1：ARCHIVED 仅行政闭环（同步 server.js 流转表）
    'ASSIGNED_PENDING_ESTIMATE': ['IN_PROGRESS', 'ARCHIVED', 'REJECTED', 'VOIDED'],
    'IN_PROGRESS': ['FIXED', 'ARCHIVED', 'REJECTED', 'VOIDED'],
    'FIXED': ['REFIXED', 'ARCHIVED', 'VOIDED'],
    'REFIXED': ['REFIXED', 'ARCHIVED', 'VOIDED'],
    'ARCHIVED': ['VOIDED'],
    'REJECTED': ['VOIDED'],
};
function normalizeCorrectionDatetime(raw) {
    if (raw === undefined || raw === null) return null;
    let dv = String(raw).trim().replace('T', ' ');
    if (!dv) return null;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dv)) dv += ':00';
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(dv);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
    const dt = new Date(y, mo - 1, d, h, mi, s);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d ||
        dt.getHours() !== h || dt.getMinutes() !== mi || dt.getSeconds() !== s) return null;
    return dv;
}
class CorrectionTransitionError extends Error {
    constructor(httpStatus, code, message) { super(message); this.httpStatus = httpStatus; this.code = code; }
}
async function correctionTransition(requestId, expectedFromStatus, toStatus, actor, payload = {}) {
    if (!CORRECTION_STATUSES.includes(toStatus)) throw new CorrectionTransitionError(400, 'INVALID_TARGET_STATUS', `非法目标状态：${toStatus}`);
    await run('BEGIN IMMEDIATE');
    try {
        const row = await get('SELECT id, status, correction_type, assigned_to, created_by, dingtalk_chat_id, fixed_at, refixed_at FROM correction_requests WHERE id = ?', [requestId]);
        if (!row) throw new CorrectionTransitionError(404, 'CORRECTION_NOT_FOUND', '修正单不存在');
        const fromStatus = row.status;
        if (toStatus === 'VOIDED') {
            if (fromStatus === 'VOIDED') throw new CorrectionTransitionError(409, 'ALREADY_VOIDED', '修正单已作废');
        } else {
            const allowed = CORRECTION_STATUS_TRANSITIONS[fromStatus] || [];
            if (!allowed.includes(toStatus)) throw new CorrectionTransitionError(400, 'INVALID_TRANSITION', `不能从「${fromStatus}」转为「${toStatus}」`);
            if (expectedFromStatus && fromStatus !== expectedFromStatus) throw new CorrectionTransitionError(409, 'CONCURRENT_STATE_CHANGE', '修正单状态已变更，请刷新重试');
        }
        {
            const role = actor.role;
            const isAdmin = role === 'admin';
            const isPublisher = role === 'publisher';
            const isAssignee = Number(row.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
            const isCreator = Number(row.created_by) === Number(actor.id) && Number(actor.id) > 0;
            let permitted = false;
            switch (toStatus) {
                case 'ASSIGNED_PENDING_ESTIMATE': permitted = isAdmin || isPublisher; break;
                case 'IN_PROGRESS': case 'FIXED': case 'REFIXED': permitted = isAdmin || isAssignee; break;
                case 'REJECTED': permitted = (fromStatus === 'PENDING_ASSIGN') ? (isAdmin || isPublisher) : (isAdmin || isPublisher || isAssignee); break;
                case 'ARCHIVED': {   // I2 §3.4 + codex 28 M-2 归一化前置（复刻 server.js）
                    const ct = (payload.closure_type === undefined || payload.closure_type === null || payload.closure_type === '') ? 'normal' : payload.closure_type;
                    if (ct !== 'normal' && ct !== 'admin_closure') throw new CorrectionTransitionError(400, 'INVALID_CLOSURE_TYPE', 'closure_type 仅 normal | admin_closure');
                    permitted = (ct === 'admin_closure') ? isAdmin : (isAdmin || isCreator); break;
                }
                case 'VOIDED': permitted = isAdmin || isCreator; break;
                default: permitted = isAdmin;
            }
            if (!permitted) throw new CorrectionTransitionError(403, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权执行此状态流转');
        }
        const setFrags = [];
        const setParams = [];
        let historyReason = null;
        switch (toStatus) {
            case 'IN_PROGRESS': {
                const est = normalizeCorrectionDatetime(payload.dev_estimated_at);
                if (!est) throw new CorrectionTransitionError(400, 'ESTIMATE_REQUIRED', '请先回复预计完成时间');
                setFrags.push('dev_estimated_at = ?', "estimated_replied_at = datetime('now','localtime')");
                setParams.push(est);
                break;
            }
            case 'FIXED':
                if (row.correction_type === 'batch') {
                    const note = (typeof payload.batch_completion_note === 'string' ? payload.batch_completion_note.trim() : '');
                    if (!note) throw new CorrectionTransitionError(400, 'BATCH_NOTE_REQUIRED', '批量修正标完成必须填写完成说明');
                    setFrags.push('batch_completion_note = ?'); setParams.push(note);
                } else {
                    const cnt = await get(
                        `SELECT COUNT(*) AS c FROM correction_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
                          WHERE a.correction_request_id = ? AND a.attachment_type = 'fix_proof' AND a.uploaded_by IS NOT NULL
                            AND (a.uploaded_by = ? OR u.role = 'admin')`, [requestId, Number(row.assigned_to) || -1]);
                    if (!cnt || cnt.c < 1) throw new CorrectionTransitionError(400, 'FIX_PROOF_REQUIRED', '单数据修正标完成必须上传结果证明截图');
                }
                setFrags.push("fixed_at = datetime('now','localtime')", 'submission_count = 1');
                break;
            case 'REFIXED':
                if (row.correction_type === 'batch') {
                    const rnote = (typeof payload.resubmit_note === 'string' ? payload.resubmit_note.trim() : '');
                    if (!rnote) throw new CorrectionTransitionError(400, 'BATCH_RESUBMIT_NOTE_REQUIRED', '批量重修提交必须填写本次重修说明');
                    historyReason = rnote;
                } else {
                    const ids = Array.isArray(payload.new_fix_proof_attachment_ids)
                        ? payload.new_fix_proof_attachment_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
                    if (ids.length === 0) throw new CorrectionTransitionError(400, 'FIX_PROOF_REQUIRED', '单数据修正重修提交必须上传本次新增结果证明');
                    const newnessBaseline = row.refixed_at || row.fixed_at || null;
                    const placeholders = ids.map(() => '?').join(',');
                    const cnt = await get(
                        `SELECT COUNT(*) AS c FROM correction_attachments a LEFT JOIN users u ON u.id = a.uploaded_by
                          WHERE a.correction_request_id = ? AND a.attachment_type = 'fix_proof' AND a.uploaded_by IS NOT NULL
                            AND a.id IN (${placeholders}) AND (a.uploaded_by = ? OR u.role = 'admin')
                            AND a.created_at > ?`, [requestId, ...ids, Number(row.assigned_to) || -1, newnessBaseline]);
                    if (!cnt || cnt.c !== ids.length) throw new CorrectionTransitionError(400, 'FIX_PROOF_REQUIRED', '本次新增结果证明无效');
                    historyReason = `重修提交（新增 ${ids.length} 张结果证明）`;
                }
                setFrags.push("refixed_at = datetime('now','localtime')", 'submission_count = submission_count + 1');
                break;
            case 'ARCHIVED': {   // Commit D1 + I2 §3.4 双分支（复刻 server.js，须同步）
                const closureType = (payload.closure_type === undefined || payload.closure_type === null || payload.closure_type === '') ? 'normal' : payload.closure_type;
                if (closureType !== 'normal' && closureType !== 'admin_closure') throw new CorrectionTransitionError(400, 'INVALID_CLOSURE_TYPE', 'closure_type 仅 normal | admin_closure');
                if (closureType === 'admin_closure') {
                    if (!['PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS'].includes(fromStatus)) throw new CorrectionTransitionError(400, 'INVALID_CLOSURE_SOURCE', '行政闭环只能从未完成态发起');
                    const cr = (typeof payload.closure_reason === 'string' ? payload.closure_reason.trim() : '');
                    if (cr.length < 10 || cr.length > 500) throw new CorrectionTransitionError(400, 'CLOSURE_REASON_REQUIRED', '行政闭环必须填写闭环原因（10-500 字）');
                    setFrags.push("archived_at = datetime('now','localtime')", 'archived_by = ?', 'archived_by_name = ?', "closure_type = 'admin_closure'", 'closure_reason = ?', 'friction_reason = NULL');   // L-1 互斥
                    setParams.push(Number(actor.id) || null, actor.name || null, cr); historyReason = `行政闭环：${cr}`;
                } else {
                    if (fromStatus !== 'FIXED' && fromStatus !== 'REFIXED') throw new CorrectionTransitionError(400, 'INVALID_TRANSITION', '正常归档只能从已完成态（FIXED/REFIXED）发起');
                    const fr = (typeof payload.friction_reason === 'string' ? payload.friction_reason.trim() : '');
                    if (row.dingtalk_chat_id && !fr) throw new CorrectionTransitionError(400, 'FRICTION_REASON_REQUIRED', '本单发起过拉群讨论，归档必须填写摩擦原因');
                    setFrags.push("archived_at = datetime('now','localtime')", 'archived_by = ?', 'archived_by_name = ?', "closure_type = 'normal'", 'friction_reason = ?', 'closure_reason = NULL');   // L-1 互斥
                    setParams.push(Number(actor.id) || null, actor.name || null, fr || null); historyReason = fr || null;
                }
                break;
            }
            case 'REJECTED': {   // Commit D1
                const rr = (typeof payload.reject_reason === 'string' ? payload.reject_reason.trim() : '');
                if (!rr) throw new CorrectionTransitionError(400, 'REJECT_REASON_REQUIRED', '拒绝必须填写原因');
                setFrags.push("rejected_at = datetime('now','localtime')", 'rejected_by = ?', 'rejected_by_name = ?', 'reject_reason = ?');
                setParams.push(Number(actor.id) || null, actor.name || null, rr); historyReason = rr; break;
            }
            case 'VOIDED': {   // Commit D1（通用旁路，上方已处理 expectedFrom 比对豁免 + ALREADY_VOIDED）
                const vr = (typeof payload.void_reason === 'string' ? payload.void_reason.trim() : '');
                setFrags.push("voided_at = datetime('now','localtime')", 'voided_by = ?', 'voided_by_name = ?', 'void_reason = ?');
                setParams.push(Number(actor.id) || null, actor.name || null, vr || null); historyReason = vr || null; break;
            }
            default:
                throw new CorrectionTransitionError(400, 'UNSUPPORTED_TRANSITION', `flow verify 不覆盖 ${toStatus}`);
        }
        const setClause = ['status = ?', ...setFrags].join(', ');
        const upd = await run(`UPDATE correction_requests SET ${setClause} WHERE id = ? AND status = ?`, [toStatus, ...setParams, requestId, fromStatus]);
        if (!upd || upd.changes !== 1) throw new CorrectionTransitionError(409, 'CONCURRENT_STATE_CHANGE', '修正单状态已变更，请刷新重试');
        await run(`INSERT INTO correction_status_history (correction_request_id, from_status, to_status, reason, operator_id, operator_name)
                   VALUES (?, ?, ?, ?, ?, ?)`, [requestId, fromStatus, toStatus, historyReason, Number(actor.id) || null, actor.name || null]);
        await run('COMMIT');
        return { ok: true, fromStatus, toStatus };
    } catch (e) {
        try { await run('ROLLBACK'); } catch (_) {}
        throw e;
    }
}

// === 移植 Commit C 端点编排（persist 用 INSERT 模拟"上传落库"；createdAt 可注入以隔离同秒，见踩坑 #2）===
// 模拟 correctionPersistAttachments：INSERT count 个 fix_proof，返回 id 数组。createdAt 注入 → 模拟"本次上传时刻"。
async function persistAttachments(rid, uploader, count, createdAt = null) {
    const ids = [];
    for (let i = 0; i < count; i++) {
        const r = createdAt
            ? await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name, created_at) VALUES (?, 'fix_proof', ?, ?, ?, ?)`,
                [rid, `correction/${rid}/f${i}.png`, uploader.id, uploader.name, createdAt])
            : await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', ?, ?, ?)`,
                [rid, `correction/${rid}/f${i}.png`, uploader.id, uploader.name]);
        ids.push(r.lastID);
    }
    return ids;
}
async function rollbackPersisted(ids) { for (const id of ids) { try { await run('DELETE FROM correction_attachments WHERE id = ?', [id]); } catch (_) {} } }

// POST /:id/reply-estimate → IN_PROGRESS
async function epReplyEstimate(id, actor, devEstimatedAt) {
    return correctionTransition(id, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', actor, { dev_estimated_at: devEstimatedAt });
}
// POST /:id/complete → FIXED（single 先上传 fix_proof→transition；batch 走 note）。transition 失败回滚本次附件。
async function epComplete(id, actor, { fileCount = 0, batchNote = null } = {}) {
    const row = await get('SELECT id, status, correction_type, assigned_to FROM correction_requests WHERE id = ?', [id]);
    if (!row) throw new CorrectionTransitionError(404, 'CORRECTION_NOT_FOUND', '修正单不存在');
    const isAdmin = actor.role === 'admin', isAssignee = Number(row.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
    if (!isAdmin && !isAssignee) throw new CorrectionTransitionError(403, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权标完成');
    let persisted = [];
    try {
        if (row.correction_type === 'single') {
            if (fileCount === 0) throw new CorrectionTransitionError(400, 'FIX_PROOF_REQUIRED', '单数据修正标完成必须上传结果证明截图');
            persisted = await persistAttachments(id, actor, fileCount);
            return await correctionTransition(id, 'IN_PROGRESS', 'FIXED', actor, {});
        } else {
            if (fileCount > 0) persisted = await persistAttachments(id, actor, fileCount);
            return await correctionTransition(id, 'IN_PROGRESS', 'FIXED', actor, { batch_completion_note: batchNote || '' });
        }
    } catch (e) { await rollbackPersisted(persisted); throw e; }
}
// POST /:id/resubmit → REFIXED（⭐RC-M1：single 先上传→只传本次 id；batch 走 note）。transition 失败回滚本次附件。
async function epResubmit(id, actor, { fileCount = 0, resubmitNote = null, uploadCreatedAt = null } = {}) {
    const row = await get('SELECT id, status, correction_type, assigned_to FROM correction_requests WHERE id = ?', [id]);
    if (!row) throw new CorrectionTransitionError(404, 'CORRECTION_NOT_FOUND', '修正单不存在');
    const isAdmin = actor.role === 'admin', isAssignee = Number(row.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
    if (!isAdmin && !isAssignee) throw new CorrectionTransitionError(403, 'NOT_AUTHORIZED_FOR_TRANSITION', '无权重修提交');
    let persisted = [];
    try {
        if (row.correction_type === 'single') {
            if (fileCount === 0) throw new CorrectionTransitionError(400, 'FIX_PROOF_REQUIRED', '单数据修正重修提交必须上传本次新增结果证明');
            persisted = await persistAttachments(id, actor, fileCount, uploadCreatedAt);   // 踩坑 #2：注入未来时间戳隔离同秒
            return await correctionTransition(id, row.status, 'REFIXED', actor, { new_fix_proof_attachment_ids: persisted });   // ⭐RC-M1：只传本次 id
        } else {
            if (fileCount > 0) persisted = await persistAttachments(id, actor, fileCount, uploadCreatedAt);   // L-3：batch 可选附件先 persist（同真实代码），transition 失败 catch 回滚
            return await correctionTransition(id, row.status, 'REFIXED', actor, { resubmit_note: resubmitNote || '' });
        }
    } catch (e) { await rollbackPersisted(persisted); throw e; }
}
// POST /:id/attachments → 旁路 append（不调 transition），权限 creator/assignee/admin，状态须 FIXED/REFIXED
async function epAddAttachments(id, actor, { fileCount = 1 } = {}) {
    const row = await get('SELECT id, status, assigned_to, created_by FROM correction_requests WHERE id = ?', [id]);
    if (!row) throw new CorrectionTransitionError(404, 'CORRECTION_NOT_FOUND', '修正单不存在');
    const isAdmin = actor.role === 'admin';
    const isAssignee = Number(row.assigned_to) === Number(actor.id) && Number(actor.id) > 0;
    const isCreator = Number(row.created_by) === Number(actor.id) && Number(actor.id) > 0;
    if (!isAdmin && !isAssignee && !isCreator) throw new CorrectionTransitionError(403, 'NOT_AUTHORIZED_FOR_ATTACHMENT', '无权补充附件');
    if (row.status !== 'FIXED' && row.status !== 'REFIXED') throw new CorrectionTransitionError(409, 'INVALID_STATE_FOR_ATTACHMENT', '仅已完成的修正单可补充附件');
    if (fileCount === 0) throw new CorrectionTransitionError(400, 'NO_FILE', '未收到上传文件');
    return persistAttachments(id, actor, fileCount);   // 旁路：不改 status、不增 submission_count
}
// ── Commit D1：reject/archive/void 三个纯 transition 薄封装（endpoint 传 expectedFrom=null）──
async function epReject(id, actor, reason) { return correctionTransition(id, null, 'REJECTED', actor, { reject_reason: reason }); }
async function epArchive(id, actor, friction) { return correctionTransition(id, null, 'ARCHIVED', actor, { friction_reason: friction }); }
async function epVoid(id, actor, reason) { return correctionTransition(id, null, 'VOIDED', actor, { void_reason: reason }); }

async function createCorrection({ correction_type = 'single', created_by = 1, created_by_name = '管理员' } = {}) {
    const r = await run(
        `INSERT INTO correction_requests (source_system, location_info, requester_name, correction_type, created_by, created_by_name)
         VALUES ('BMS', '合同表#1 金额错，应为 100', '业务张', ?, ?, ?)`, [correction_type, created_by, created_by_name]);
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
    catch (e) { if (!(e instanceof CorrectionTransitionError)) throw e; assert.strictEqual(e.code, code, `${label}：应抛 ${code}，实际 ${e.code}`); }
}
async function setupSchema() {
    await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT, role TEXT)`);
    await run(`INSERT INTO users (id, display_name, role) VALUES (1,'管理员','admin'),(5,'开发王','user'),(7,'示例发布者','publisher'),(99,'路人','user')`);
    await run(`CREATE TABLE correction_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source_system TEXT NOT NULL, location_info TEXT NOT NULL,
        requester_name TEXT NOT NULL, correction_type TEXT NOT NULL DEFAULT 'single',
        status TEXT NOT NULL DEFAULT 'PENDING_ASSIGN', dev_estimated_at DATETIME, estimated_replied_at DATETIME,
        assigned_to INTEGER, assigned_to_name TEXT, assigned_by INTEGER, assigned_at DATETIME,
        batch_completion_note TEXT, submission_count INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','localtime')),
        fixed_at DATETIME, refixed_at DATETIME, dingtalk_chat_id TEXT, created_by INTEGER NOT NULL, created_by_name TEXT,
        rejected_at DATETIME, rejected_by INTEGER, rejected_by_name TEXT, reject_reason TEXT,
        archived_at DATETIME, archived_by INTEGER, archived_by_name TEXT, friction_reason TEXT, closure_type TEXT DEFAULT 'normal', closure_reason TEXT,
        voided_at DATETIME, voided_by INTEGER, voided_by_name TEXT, void_reason TEXT)`);
    await run(`CREATE TABLE correction_attachments (id INTEGER PRIMARY KEY AUTOINCREMENT, correction_request_id INTEGER NOT NULL,
        attachment_type TEXT NOT NULL, file_name TEXT NOT NULL, original_name TEXT, file_size INTEGER, mime_type TEXT,
        uploaded_by INTEGER NOT NULL, uploaded_by_name TEXT, created_at DATETIME DEFAULT (datetime('now','localtime')))`);
    await run(`CREATE TABLE correction_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, correction_request_id INTEGER NOT NULL,
        from_status TEXT, to_status TEXT NOT NULL, reason TEXT, operator_id INTEGER, operator_name TEXT, created_at DATETIME DEFAULT (datetime('now','localtime')))`);
}
// 推单到 IN_PROGRESS（指派 + 回复预计）
async function toInProgress(id, est = '2026-06-20 12:00') {
    await run(`UPDATE correction_requests SET status='ASSIGNED_PENDING_ESTIMATE', assigned_to=5, assigned_to_name='开发王', assigned_by=1 WHERE id=?`, [id]);
    await epReplyEstimate(id, DEV, est);
}

async function main() {
    await setupSchema();
    ok('schema + users 就绪');

    // [1] reply-estimate：ESTIMATE 闸门 + →IN_PROGRESS
    const a = await createCorrection({ correction_type: 'single' });
    await run(`UPDATE correction_requests SET status='ASSIGNED_PENDING_ESTIMATE', assigned_to=5, assigned_to_name='开发王', assigned_by=1 WHERE id=?`, [a]);
    await expectErr(epReplyEstimate(a, DEV, 'abc'), 'ESTIMATE_REQUIRED', 'reply-estimate 非法日期');
    await expectErr(epReplyEstimate(a, STRANGER, '2026-06-20 12:00'), 'NOT_AUTHORIZED_FOR_TRANSITION', '非本单开发回复预计');
    await epReplyEstimate(a, DEV, '2026-06-20T12:00');
    const ra = await get('SELECT status, dev_estimated_at FROM correction_requests WHERE id=?', [a]);
    assert.strictEqual(ra.status, 'IN_PROGRESS', '→IN_PROGRESS');
    assert.strictEqual(ra.dev_estimated_at, '2026-06-20 12:00:00', 'dev_estimated_at 归一化');
    ok('reply-estimate：非法日期拒 / 非本单开发拒 / 合法→IN_PROGRESS + 归一化');

    // [2] complete single：无文件拒 / 非本单开发拒 / 开发本人上传 fix_proof→FIXED + count=1
    await expectErr(epComplete(a, DEV, { fileCount: 0 }), 'FIX_PROOF_REQUIRED', 'complete single 无文件');
    await expectErr(epComplete(a, STRANGER, { fileCount: 1 }), 'NOT_AUTHORIZED_FOR_TRANSITION', '非本单开发标完成');
    await epComplete(a, DEV, { fileCount: 1 });
    const r2 = await get('SELECT status, submission_count FROM correction_requests WHERE id=?', [a]);
    assert.strictEqual(r2.status, 'FIXED', 'complete→FIXED');
    assert.strictEqual(r2.submission_count, 1, 'count=1');
    assert.strictEqual((await get(`SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=? AND attachment_type='fix_proof'`, [a])).c, 1, '1 个 fix_proof 落库');
    ok('complete single：无文件拒 / 非本单开发拒 / 开发上传 fix_proof→FIXED + count=1 + 附件落库');

    // [3] complete batch：无 note 拒 / 有 note→FIXED（无附件要求）
    const b = await createCorrection({ correction_type: 'batch' });
    await toInProgress(b);
    await expectErr(epComplete(b, DEV, { fileCount: 0, batchNote: '' }), 'BATCH_NOTE_REQUIRED', 'complete batch 无 note');
    await epComplete(b, DEV, { fileCount: 0, batchNote: '批量更新 30 条' });
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [b])).status, 'FIXED', 'batch→FIXED 无附件');
    ok('complete batch：无 note 拒 / 有 note→FIXED（无附件要求）');

    // [4] ⭐RC-M1 resubmit single：无文件拒 / 只传本次上传 id→REFIXED + count+1（新增性用未来时间戳隔离同秒）
    await expectErr(epResubmit(a, DEV, { fileCount: 0 }), 'FIX_PROOF_REQUIRED', 'resubmit single 无文件');
    await epResubmit(a, DEV, { fileCount: 1, uploadCreatedAt: '2099-01-01 00:00:00' });
    const r4 = await get('SELECT status, submission_count FROM correction_requests WHERE id=?', [a]);
    assert.strictEqual(r4.status, 'REFIXED', 'resubmit→REFIXED');
    assert.strictEqual(r4.submission_count, 2, 'count+1=2');
    ok('⭐RC-M1 resubmit single：无文件拒 / 只传本次上传 id→REFIXED + count+1（本次 id 必属本单+新增性满足）');

    // [5] RC-M1 反证：endpoint 只把"本次上传"id 传入——历史旧 fix_proof（[2] 那张，created_at≤fixed_at）若被传会被新增性拒。
    //   直接调 transition 传旧 id 模拟"若 endpoint 误传历史 id"→ 必拒，证明 RC-M1"只传本次"是必要的。
    const oldFix = await get(`SELECT id FROM correction_attachments WHERE correction_request_id=? AND attachment_type='fix_proof' ORDER BY id LIMIT 1`, [a]);
    await expectErr(correctionTransition(a, 'REFIXED', 'REFIXED', DEV, { new_fix_proof_attachment_ids: [oldFix.id] }), 'FIX_PROOF_REQUIRED', '误传历史旧附件 id');
    ok('RC-M1 反证：误传历史旧 fix_proof id（created_at≤baseline）被新增性闸门拒 → 证明"只传本次上传 id"是必要前置');

    // [6] resubmit batch：无 note 拒 / 有附件但 note 空→拒+附件回滚（L-3 codex 11）/ 有 note→REFIXED + 写 history.reason
    await expectErr(epResubmit(b, DEV, { fileCount: 0, resubmitNote: '' }), 'BATCH_RESUBMIT_NOTE_REQUIRED', 'resubmit batch 无 note');
    const bAttBefore = (await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [b])).c;
    await expectErr(epResubmit(b, DEV, { fileCount: 1, resubmitNote: '', uploadCreatedAt: '2099-01-01 00:00:00' }), 'BATCH_RESUBMIT_NOTE_REQUIRED', 'resubmit batch 有附件但 note 空');
    const bAttAfter = (await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [b])).c;
    assert.strictEqual(bAttAfter, bAttBefore, 'L-3：batch resubmit note 空 → 本次可选附件回滚（计数不变）');
    await epResubmit(b, DEV, { resubmitNote: '重核客户编号映射' });
    const h6 = await all(`SELECT reason FROM correction_status_history WHERE correction_request_id=? AND to_status='REFIXED'`, [b]);
    assert.strictEqual(h6[0].reason, '重核客户编号映射', 'batch resubmit_note 写 history.reason');
    ok('resubmit batch：无 note 拒 / 有附件 note 空→拒+附件回滚（L-3）/ 有 note→REFIXED + resubmit_note 写 history.reason');

    // [7] transition 失败回滚附件：对 FIXED single 调 complete（期望 IN_PROGRESS≠FIXED）→ persist 后 transition 失败 → 附件回滚
    const c = await createCorrection({ correction_type: 'single' });
    await toInProgress(c);
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', 'pre.png', 5, '开发王')`, [c]);
    await correctionTransition(c, 'IN_PROGRESS', 'FIXED', DEV, {});   // 推到 FIXED
    const before = (await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [c])).c;
    // FIXED 单再 complete：transition 先撞流转合法性（FIXED→FIXED 非法，检查早于 expectedFrom 比对）→ INVALID_TRANSITION
    await expectErr(epComplete(c, DEV, { fileCount: 2 }), 'INVALID_TRANSITION', 'FIXED 单再 complete（FIXED→FIXED 非法流转）');
    const after = (await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [c])).c;
    assert.strictEqual(after, before, 'transition 失败 → 本次 persist 的 2 个附件已回滚（计数不变）');
    ok('transition 失败回滚：persist 后 transition 抛错（INVALID_TRANSITION）→ 本次落库附件被回滚（无 orphan）');

    // [8] attachments 旁路：状态闸门（IN_PROGRESS 拒 / FIXED·REFIXED 放行）+ 不改状态不增 count
    const d = await createCorrection({ correction_type: 'single' });
    await toInProgress(d);
    await expectErr(epAddAttachments(d, DEV, { fileCount: 1 }), 'INVALID_STATE_FOR_ATTACHMENT', 'IN_PROGRESS 补充附件（防完成前伪造留证）');
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', 'x.png', 5, '开发王')`, [d]);
    await correctionTransition(d, 'IN_PROGRESS', 'FIXED', DEV, {});
    const cntBefore = (await get('SELECT submission_count FROM correction_requests WHERE id=?', [d])).submission_count;
    await epAddAttachments(d, DEV, { fileCount: 2 });
    const rd = await get('SELECT status, submission_count FROM correction_requests WHERE id=?', [d]);
    assert.strictEqual(rd.status, 'FIXED', '旁路 append 不改状态（仍 FIXED）');
    assert.strictEqual(rd.submission_count, cntBefore, '旁路 append 不增 submission_count');
    ok('attachments 旁路：IN_PROGRESS 拒（M-1 防伪造）/ FIXED 放行 / 不改状态 + 不增 count');

    // [9] attachments 权限矩阵（M-2）：creator/assignee/admin 放行 / stranger 拒
    const e = await createCorrection({ correction_type: 'single', created_by: 7, created_by_name: '示例发布者' });   // 建单人=publisher 7（测 isCreator 独立于 admin）
    await run(`UPDATE correction_requests SET status='FIXED', assigned_to=5, assigned_to_name='开发王', submission_count=1, fixed_at=datetime('now','localtime') WHERE id=?`, [e]);
    await expectErr(epAddAttachments(e, STRANGER, { fileCount: 1 }), 'NOT_AUTHORIZED_FOR_ATTACHMENT', 'stranger 补充附件');
    await epAddAttachments(e, PUB, { fileCount: 1 });   // creator（示例发布者 7）
    await epAddAttachments(e, DEV, { fileCount: 1 });   // assignee（开发王 5）
    await epAddAttachments(e, ADMIN, { fileCount: 1 }); // admin
    assert.strictEqual((await get('SELECT COUNT(*) c FROM correction_attachments WHERE correction_request_id=?', [e])).c, 3, 'creator+assignee+admin 各 append 1 → 3 个');
    ok('attachments 权限矩阵（M-2）：creator/assignee/admin 放行 / stranger 拒（403 NOT_AUTHORIZED_FOR_ATTACHMENT）');

    // [10] M-2（codex 11）已知限制·诚实记录（不被 2099 注入掩盖）：同秒 created_at==baseline 被新增性闸门拒
    const f = await createCorrection({ correction_type: 'single' });
    await toInProgress(f);
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', 'f1.png', 5, '开发王')`, [f]);
    await correctionTransition(f, 'IN_PROGRESS', 'FIXED', DEV, {});
    const fFixedAt = (await get('SELECT fixed_at FROM correction_requests WHERE id=?', [f])).fixed_at;
    // 模拟"resubmit 与 FIXED 同一秒"：新 fix_proof created_at 恰=fixed_at（baseline）→ created_at>baseline 不成立 → 被拒
    const sameSec = await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name, created_at) VALUES (?, 'fix_proof', 'same.png', 5, '开发王', ?)`, [f, fFixedAt]);
    await expectErr(correctionTransition(f, 'FIXED', 'REFIXED', DEV, { new_fix_proof_attachment_ids: [sameSec.lastID] }), 'FIX_PROOF_REQUIRED', '同秒 created_at==baseline 误拒');
    ok('M-2 已知限制（诚实记录非掩盖）：同秒 created_at==baseline 被新增性闸门拒；节奏定性非必须修（真实环境 resubmit 在 FIXED 后分钟级不触发，C 端只传本次 id 仍是主保证）');

    // [11] Commit D1 reject 薄封装：endpoint expectedFrom=null → 从多个合法源态都能拒；payload 透传 + R-1
    const g1 = await createCorrection({ correction_type: 'single' });
    await expectErr(epReject(g1, ADMIN, ''), 'REJECT_REASON_REQUIRED', 'reject 无 reason');
    await epReject(g1, ADMIN, '业务上无需修正');
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [g1])).status, 'REJECTED', 'reject PENDING_ASSIGN→REJECTED');
    const g2 = await createCorrection({ correction_type: 'single' });
    await toInProgress(g2);
    await epReject(g2, DEV, '改不动需退回');   // 多源态：IN_PROGRESS 也能拒（被指派开发本人）
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [g2])).status, 'REJECTED', 'reject IN_PROGRESS→REJECTED（多源态，null expectedFrom）');
    const g3 = await createCorrection({ correction_type: 'single' });
    await toInProgress(g3);
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', 'g.png', 5, '开发王')`, [g3]);
    await correctionTransition(g3, 'IN_PROGRESS', 'FIXED', DEV, {});
    await expectErr(epReject(g3, ADMIN, 'x'), 'INVALID_TRANSITION', 'reject FIXED（R-1 完成态不可拒）');
    ok('D1 reject：无 reason 拒 / PENDING_ASSIGN+IN_PROGRESS 多源态→REJECTED / FIXED→INVALID_TRANSITION（R-1，null expectedFrom 靠流转合法性拦）');

    // [12] Commit D1 archive/void 薄封装：archive 摩擦闸门 + void 通用旁路 + 重复作废
    const g4 = await createCorrection({ correction_type: 'single', created_by: 1 });
    await run(`UPDATE correction_requests SET status='FIXED', assigned_to=5, dingtalk_chat_id='cid1', submission_count=1, fixed_at=datetime('now','localtime') WHERE id=?`, [g4]);
    await expectErr(epArchive(g4, ADMIN, ''), 'FRICTION_REASON_REQUIRED', 'archive 有 chat 无 friction');
    await epArchive(g4, ADMIN, '拉群澄清后确认');
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [g4])).status, 'ARCHIVED', 'archive→ARCHIVED');
    await epVoid(g4, ADMIN, '误归档');   // ARCHIVED→VOIDED 通用旁路（null expectedFrom）
    assert.strictEqual((await get('SELECT status, voided_at FROM correction_requests WHERE id=?', [g4])).status, 'VOIDED', 'archive 后 void→VOIDED 旁路');
    await expectErr(epVoid(g4, ADMIN, ''), 'ALREADY_VOIDED', '重复作废');
    ok('D1 archive/void：archive 有 chat 必填 friction→ARCHIVED / void 通用旁路 ARCHIVED→VOIDED + 重复作废 ALREADY_VOIDED');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit C+D1 端点编排验证通过（reply-estimate / complete / ⭐RC-M1 resubmit + 反证 / resubmit batch + 回滚 / transition 失败回滚 / attachments 旁路 + M-2 权限 + 同秒已知限制 / D1 reject 多源态 + R-1 / archive 摩擦闸门 / void 旁路 + 重复作废）`);
    db.close();
}
main().catch((e) => { console.error('\n[失败]', e && e.message, e && e.stack); db.close(); process.exit(1); });
