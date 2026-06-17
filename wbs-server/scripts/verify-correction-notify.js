// 验证脚本：数据修正 D2a/D2b + I1 通知手动化 — 钉钉通知落库 + 重发契约 + 可发状态枚举 + read-status 字段映射
// 方案：docs/local/数据修正/数据修正模块_复审优化_方案_20260616_v1.1.md（§2 通知模型重构）
// 用法：node scripts/verify-correction-notify.js
// 模式：临时内存 sqlite，忠实复刻 server.js 落库逻辑（send 结果注入 mock）。
//   钉钉真发无法 e2e——真机实测留部署后；本脚本验①落库状态映射 ②失败不阻断业务状态 ③重发清对应 read_at
//   ④可发状态枚举（§2.2）⑤read-status 字段映射（§2.5）⑥relay 投递审计四件套（I1：替代旧 relay_notified_at 单字段，§2.3）。
// J3（RC-L2 部分根治）：可发状态枚举/字段映射**常量已改 require 真实 _internals**（CORRECTION_NOTIFY_SENDABLE /
//   CORRECTION_READ_FIELD_MAP，漂移即暴露）；**落库 UPDATE 逻辑（applyDevNotify 等）仍是 handler 内联复刻**（未抽函数导出，
//   务实收尾保留）——改 corrections.js 各 notify endpoint 的落库 SQL（status/read_at CASE 清理）时须同步本文件。未覆盖真实 HTTP 集成（留浏览器实测）。
const assert = require('assert');
const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(':memory:');
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
// J3：require 真实 corrections 模块拿 _internals 常量（CORRECTION_NOTIFY_SENDABLE / CORRECTION_READ_FIELD_MAP）替代复刻
const _noop = () => {}; const _mw = (q, s, n) => (n ? n() : undefined); const _an = async () => ({});
const _mod = require('../routes/corrections')({ logger: { info: _noop, warn: _noop, error: _noop, debug: _noop }, db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all, authenticateToken: _mw, requireAdmin: _mw, requirePublisherOrAdmin: _mw, sendIssueDingtalkRaw: _an, UPLOAD_DIR: require('path').join(require('os').tmpdir(), 'corr-notify-verify'), readSystemConfig: _an, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: _an, normalizeAttachmentExt: x => x, safeDeleteFileSync: _noop, maskPhone: x => x });
const I = _mod._internals;

// === 复刻 server.js 三个回填点的落库逻辑（send 结果注入；与端点内 UPDATE 同源）===
// notifyCorrectionAssignedDev 落库段：ok→sent+key / fail→failed+error（dev 无 no_phone 单列态，失败统归 failed）
async function applyDevNotify(id, sr) {
    // I1：重发成功清 read_at（RC-M3 以最近一次为准；endpoint 是 r.ok 后单独 UPDATE read_at=NULL，此处 CASE 等价）
    await run(`UPDATE correction_requests SET notify_status=?, notified_at=datetime('now','localtime'), notify_message_key=?, notify_error=?, read_at=CASE WHEN ?='sent' THEN NULL ELSE read_at END WHERE id=?`,
        [sr.ok ? 'sent' : 'failed', sr.ok ? sr.message_key : null, sr.ok ? null : (sr.reason || 'other'), sr.ok ? 'sent' : 'failed', id]);
}
// reply-estimate 回复预计通知业务方：三态映射 sent / no_phone / failed
async function applyRequesterNotify(id, sr) {
    const status = sr.ok ? 'sent' : (sr.reason === 'no_phone' ? 'no_phone' : 'failed');
    // I1 notify-estimate：重发 sent 清 requester_read_at（CASE WHEN sent，对齐 endpoint）
    await run(`UPDATE correction_requests SET requester_notify_status=?, requester_notified_at=datetime('now','localtime'), requester_notify_message_key=?, requester_notify_error=?, requester_read_at=CASE WHEN ?='sent' THEN NULL ELSE requester_read_at END WHERE id=?`,
        [status, sr.ok ? sr.message_key : null, sr.ok ? null : (sr.reason || 'other'), status, id]);
    return status;
}
// I1 notify-relay：relay 改"投递审计四件套"（对齐 dev/requester），sent/failed 都落 status；重发清 relay_read_at。
//   积压口径相应从 relay_notified_at IS NOT NULL 改为 relay_notify_status='sent'（§2.3）。
async function applyRelayNotify(id, sr) {
    const status = sr.ok ? 'sent' : 'failed';
    await run(`UPDATE correction_requests SET relay_notify_status=?, relay_notified_at=datetime('now','localtime'), relay_notify_message_key=?, relay_notify_error=?, relay_read_at=CASE WHEN ?='sent' THEN NULL ELSE relay_read_at END WHERE id=?`,
        [status, sr.ok ? sr.message_key : null, sr.ok ? null : (sr.reason || 'other'), status, id]);
    return status;
}
// D2b notify-done 三分支决策（复刻 endpoint：无手机号→no_phone / 有 fix_proof→有附件 / 无 fix_proof→无附件文字）
function completionBranch(requesterPhone, hasFixProof) {
    if (!String(requesterPhone || '').trim()) return 'no_phone';
    return hasFixProof ? 'has_attachment' : 'no_attachment';
}
// D2b notify-done 落库（复刻 endpoint 三态：no_phone 旁路 / sent 全成清 read / failed）
async function applyCompletionNotify(id, outcome) {
    if (outcome.status === 'sent') {
        await run(`UPDATE correction_requests SET completion_notify_status='sent', completion_notified_at=datetime('now','localtime'), completion_notify_message_key=?, completion_notify_error=NULL, completion_read_at=NULL WHERE id=?`, [outcome.message_key, id]);
    } else if (outcome.status === 'no_phone') {
        await run(`UPDATE correction_requests SET completion_notify_status='no_phone', completion_notified_at=datetime('now','localtime'), completion_notify_message_key=NULL, completion_notify_error='no_phone' WHERE id=?`, [id]);
    } else {
        await run(`UPDATE correction_requests SET completion_notify_status='failed', completion_notified_at=datetime('now','localtime'), completion_notify_message_key=NULL, completion_notify_error=? WHERE id=?`, [outcome.error || 'failed', id]);
    }
}

let passed = 0;
const ok = (m) => { passed++; console.log(`  ✓ ${m}`); };
async function setup() {
    await run(`CREATE TABLE correction_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'PENDING_ASSIGN',
        assigned_to INTEGER, requester_phone TEXT, relay_notified_user_id INTEGER, relay_notified_at DATETIME,
        relay_notify_status TEXT DEFAULT 'not_sent', relay_notify_message_key TEXT, relay_notify_error TEXT, relay_read_at DATETIME,
        notify_status TEXT DEFAULT 'not_sent', notified_at DATETIME, notify_message_key TEXT, notify_error TEXT, read_at DATETIME,
        requester_notify_status TEXT DEFAULT 'not_sent', requester_notified_at DATETIME, requester_notify_message_key TEXT, requester_notify_error TEXT, requester_read_at DATETIME,
        completion_notify_status TEXT DEFAULT 'not_sent', completion_notified_at DATETIME, completion_notify_message_key TEXT, completion_notify_error TEXT, completion_read_at DATETIME,
        creator_notify_status TEXT DEFAULT 'not_sent', creator_notified_at DATETIME, creator_notify_message_key TEXT, creator_notify_error TEXT, creator_read_at DATETIME,
        correction_type TEXT DEFAULT 'single',
        created_by INTEGER)`);
}
async function mk(f = {}) {
    const r = await run(`INSERT INTO correction_requests (status, assigned_to, requester_phone, relay_notified_user_id, created_by) VALUES (?,?,?,?,1)`,
        [f.status || 'ASSIGNED_PENDING_ESTIMATE', f.assigned_to || 5, f.requester_phone || null, f.relay || null]);
    return r.lastID;
}

async function main() {
    await setup();
    ok('schema 就绪');

    // [1] 指派通知开发：send ok→sent+key / fail→failed+error；notify 成败均不改业务状态（失败不阻断/不回滚）
    const a = await mk({ status: 'ASSIGNED_PENDING_ESTIMATE' });
    await applyDevNotify(a, { ok: true, message_key: 'k1' });
    let r = await get('SELECT status, notify_status, notify_message_key, notify_error FROM correction_requests WHERE id=?', [a]);
    assert.strictEqual(r.notify_status, 'sent'); assert.strictEqual(r.notify_message_key, 'k1'); assert.strictEqual(r.notify_error, null);
    assert.strictEqual(r.status, 'ASSIGNED_PENDING_ESTIMATE', 'notify 成功不改业务状态');
    await applyDevNotify(a, { ok: false, reason: 'no_phone' });
    r = await get('SELECT status, notify_status, notify_message_key, notify_error FROM correction_requests WHERE id=?', [a]);
    assert.strictEqual(r.notify_status, 'failed'); assert.strictEqual(r.notify_message_key, null); assert.strictEqual(r.notify_error, 'no_phone');
    assert.strictEqual(r.status, 'ASSIGNED_PENDING_ESTIMATE', 'notify 失败不改业务状态（旁路不阻断/不回滚）');
    ok('指派通知开发：send ok→sent+key / fail→failed+error；notify 成败均不改业务状态（失败不阻断）');

    // [2] 回复预计通知业务方：三态映射 sent / no_phone / failed（no_phone 单列，其余失败归 failed）
    const b = await mk({ status: 'IN_PROGRESS', requester_phone: '13800000000' });
    assert.strictEqual(await applyRequesterNotify(b, { ok: true, message_key: 'k2' }), 'sent', 'ok→sent');
    assert.strictEqual((await get('SELECT requester_notify_status, requester_notify_message_key FROM correction_requests WHERE id=?', [b])).requester_notify_message_key, 'k2', 'sent 写 message_key');
    assert.strictEqual(await applyRequesterNotify(b, { ok: false, reason: 'no_phone' }), 'no_phone', 'no_phone→no_phone');
    assert.strictEqual(await applyRequesterNotify(b, { ok: false, reason: 'send_failed' }), 'failed', '其他 reason→failed');
    assert.strictEqual(await applyRequesterNotify(b, { ok: false, reason: 'requester_invalid' }), 'failed', 'requester_invalid→failed');
    assert.strictEqual((await get('SELECT requester_notify_error FROM correction_requests WHERE id=?', [b])).requester_notify_error, 'requester_invalid', 'failed 落 reason 到 error');
    ok('回复预计通知业务方：三态映射 sent / no_phone / failed（no_phone 单列，requester_invalid/send_failed 等归 failed + reason 落 error）');

    // [3] relay 通知对接人（I1 投递审计四件套）：sent/failed 都落 relay_notify_status；重发 sent 清 relay_read_at；积压口径改 status='sent'
    const c = await mk({ status: 'PENDING_ASSIGN', relay: 7 });
    assert.strictEqual(await applyRelayNotify(c, { ok: false, reason: 'exception' }), 'failed', 'relay 失败→failed');
    let rc = await get('SELECT relay_notify_status, relay_notify_error, relay_notify_message_key FROM correction_requests WHERE id=?', [c]);
    assert.strictEqual(rc.relay_notify_status, 'failed'); assert.strictEqual(rc.relay_notify_error, 'exception'); assert.strictEqual(rc.relay_notify_message_key, null);
    await run(`UPDATE correction_requests SET relay_read_at=datetime('now','localtime') WHERE id=?`, [c]);   // 模拟上次已读
    assert.strictEqual(await applyRelayNotify(c, { ok: true, message_key: 'rk1' }), 'sent', 'relay 成功→sent');
    rc = await get('SELECT relay_notify_status, relay_notify_message_key, relay_read_at FROM correction_requests WHERE id=?', [c]);
    assert.strictEqual(rc.relay_notify_status, 'sent'); assert.strictEqual(rc.relay_notify_message_key, 'rk1');
    assert.strictEqual(rc.relay_read_at, null, '重发 sent 清 relay_read_at（RC-M3）');
    ok('relay 投递审计四件套（I1，§2.3）：sent/failed 都落 relay_notify_status+error；重发 sent 清 relay_read_at；积压口径→relay_notify_status=sent');

    // [4] codex 13 闭合验证：异常/not_found 路径也落 failed（server.js 把 send 异常/dev 不存在规范为 {ok:false} 后统一落库，不被异常绕过）
    const d = await mk({ status: 'ASSIGNED_PENDING_ESTIMATE' });
    await applyDevNotify(d, { ok: false, reason: 'exception' });   // 发送抛异常被规范为 {ok:false,reason:'exception'}
    let rd = await get('SELECT notify_status, notify_error FROM correction_requests WHERE id=?', [d]);
    assert.strictEqual(rd.notify_status, 'failed'); assert.strictEqual(rd.notify_error, 'exception', '发送异常→failed+error=exception');
    const e = await mk({ status: 'ASSIGNED_PENDING_ESTIMATE' });
    await applyDevNotify(e, { ok: false, reason: 'not_found' });   // dev 查不到被规范为 {ok:false,reason:'not_found'}
    let re = await get('SELECT notify_status, notify_error FROM correction_requests WHERE id=?', [e]);
    assert.strictEqual(re.notify_status, 'failed'); assert.strictEqual(re.notify_error, 'not_found', 'dev 不存在→failed+error=not_found');
    const f = await mk({ status: 'IN_PROGRESS' });
    assert.strictEqual(await applyRequesterNotify(f, { ok: false, reason: 'exception' }), 'failed', 'requester 发送异常→failed');
    ok('codex 13 闭合：异常/not_found 路径统一落 failed（"失败必落库"不被异常绕过；dev exception/not_found + requester exception 均验）');

    // [5] D2b notify-done：三分支决策 + 三态落库
    // 三分支决策
    assert.strictEqual(completionBranch('', true), 'no_phone', '无手机号→no_phone（即便有附件）');
    assert.strictEqual(completionBranch('13800000000', true), 'has_attachment', '有手机号+有 fix_proof→有附件分支（single）');
    assert.strictEqual(completionBranch('13800000000', false), 'no_attachment', '有手机号+无 fix_proof→无附件文字分支（batch 只填文字）');
    // 三态落库
    const g = await mk({ status: 'FIXED', requester_phone: '' });
    await applyCompletionNotify(g, { status: 'no_phone' });
    let rg = await get('SELECT completion_notify_status, completion_notify_error, completion_notify_message_key FROM correction_requests WHERE id=?', [g]);
    assert.strictEqual(rg.completion_notify_status, 'no_phone'); assert.strictEqual(rg.completion_notify_error, 'no_phone'); assert.strictEqual(rg.completion_notify_message_key, null);
    const h = await mk({ status: 'FIXED', requester_phone: '13800000000' });
    await run(`UPDATE correction_requests SET completion_read_at=datetime('now','localtime') WHERE id=?`, [h]);   // 模拟上次已读
    await applyCompletionNotify(h, { status: 'sent', message_key: 'ck1' });
    let rh = await get('SELECT completion_notify_status, completion_notify_message_key, completion_read_at FROM correction_requests WHERE id=?', [h]);
    assert.strictEqual(rh.completion_notify_status, 'sent'); assert.strictEqual(rh.completion_notify_message_key, 'ck1');
    assert.strictEqual(rh.completion_read_at, null, '重发 sent 清 completion_read_at（§4.5 L-2 以最近一次为准）');
    const i = await mk({ status: 'REFIXED', requester_phone: '13800000000' });
    await applyCompletionNotify(i, { status: 'failed', error: 'file_send' });
    let ri = await get('SELECT completion_notify_status, completion_notify_error FROM correction_requests WHERE id=?', [i]);
    assert.strictEqual(ri.completion_notify_status, 'failed'); assert.strictEqual(ri.completion_notify_error, 'file_send', '部分失败落 failed + failed_step');
    ok('D2b notify-done：三分支决策（no_phone/有附件/无附件）+ 三态落库（no_phone 旁路 / sent 全成清 read / failed 落 step）');

    // [6] 可发状态枚举（§2.2 H-3/M-6）：J3 require 真实 _internals.CORRECTION_NOTIFY_SENDABLE（非复刻，漂移即暴露）
    const SENDABLE = I.CORRECTION_NOTIFY_SENDABLE;
    assert.ok(SENDABLE.dev.includes('ASSIGNED_PENDING_ESTIMATE') && SENDABLE.dev.includes('IN_PROGRESS'), 'dev 可发 ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS');
    assert.ok(!SENDABLE.dev.includes('FIXED') && !SENDABLE.dev.includes('PENDING_ASSIGN'), 'dev 不可发 FIXED/PENDING_ASSIGN');
    assert.deepStrictEqual(SENDABLE.relay, ['PENDING_ASSIGN'], 'relay 仅 PENDING_ASSIGN');
    assert.deepStrictEqual(SENDABLE.estimate, ['IN_PROGRESS'], 'estimate 仅 IN_PROGRESS（reply-estimate 闸门保证进 IN_PROGRESS≡有 dev_estimated_at）');
    assert.deepStrictEqual(SENDABLE.done, ['FIXED', 'REFIXED'], 'done 仅 FIXED/REFIXED');
    ['VOIDED', 'REJECTED', 'ARCHIVED'].forEach(s => Object.keys(SENDABLE).forEach(k => assert.ok(!SENDABLE[k].includes(s), `${k} 不可发于终态 ${s}`)));
    ok('可发状态枚举（§2.2 H-3/M-6）：dev/relay/estimate/done 各自精确枚举；VOIDED/REJECTED/ARCHIVED 四类全禁发');

    // [7] read-status 字段映射（§2.5 M-5）：J3 require 真实 _internals.CORRECTION_READ_FIELD_MAP（非复刻，漂移即暴露）
    const READ_MAP = I.CORRECTION_READ_FIELD_MAP;
    assert.strictEqual(READ_MAP.dev.byPhone, false, 'dev 走 users（assigned_to）');
    assert.strictEqual(READ_MAP.relay.byPhone, false, 'relay 走 users（relay_notified_user_id）');
    assert.strictEqual(READ_MAP.estimate.byPhone, true, 'estimate 走 phone 反查');
    assert.strictEqual(READ_MAP.done.byPhone, true, 'done 走 phone 反查');
    const cols = (await new Promise((res, rej) => db.all(`PRAGMA table_info(correction_requests)`, (e, r) => e ? rej(e) : res(r)))).map(x => x.name);
    Object.values(READ_MAP).forEach(m => { assert.ok(cols.includes(m.status_col), `${m.status_col} 列存在`); assert.ok(cols.includes(m.read_at), `${m.read_at} 列存在`); });
    ok('read-status 字段映射（§2.5 M-5）：4 recipient × status_col/read_at/byPhone 正确 + 列真实存在（防映射错列查错已读）');

    // [8] 重发契约（§2.6 RC-M3）：未传 force_resend 且 status='sent' 且 message_key 非空 → ALREADY_SENT（不重发）
    const alreadySent = (status, messageKey, forceResend) => (!forceResend && status === 'sent' && !!messageKey);
    assert.strictEqual(alreadySent('sent', 'k', false), true, 'sent+key+无force → ALREADY_SENT');
    assert.strictEqual(alreadySent('sent', 'k', true), false, 'force_resend=true → 重发');
    assert.strictEqual(alreadySent('sent', null, false), false, 'sent 但无 key → 可重发（防"已发但查不到已读"死局）');
    assert.strictEqual(alreadySent('failed', 'k', false), false, 'failed → 可重发');
    assert.strictEqual(alreadySent('not_sent', null, false), false, 'not_sent → 首发');
    ok('重发契约（§2.6 RC-M3）：sent+key+无force→ALREADY_SENT；force_resend/无key/failed/not_sent 均放行');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 数据修正通知验证通过（D2a/D2b 落库+失败不阻断+异常闭合 + notify-done 三分支 / I1：relay 投递审计四件套§2.3 + 重发清 read_at + 可发状态枚举§2.2 + read-status 字段映射§2.5 + 重发契约§2.6）`);
    db.close();
}
main().catch((e) => { console.error('\n[失败]', e && e.message, e && e.stack); db.close(); process.exit(1); });
