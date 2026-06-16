/**
 * verify-correction-relay-whitelist.js
 * 数据修正·对接人白名单化（路线 B）验证。
 *
 * 覆盖：
 *  1) 三处字面量同源（后端 corrections.js / 前端 Data_Correction.html / 本脚本期望）—— RC-L1 防漂移
 *  2) isCorrectionRelayWhitelisted 纯函数 + _internals 导出
 *  3) 防御断言：白名单不含只读领导 READONLY_LEADER_IDS=[6,11]（防 viewer/只读领导混入）—— M-4
 *  4) correctionTransition 指派放行/越权矩阵（核心权威闸门）：
 *     - 白名单 relay 派其本人经手 PENDING_ASSIGN 单 → 成功（RC-M3 修复：transition 放行白名单 relay）
 *     - 白名单 relay 派非本人经手单 → 403（H-1 归属）
 *     - 非白名单 user 派单（即便该单 relay=自己）→ 403（M-5 移出白名单即失效）
 *     - 白名单 relay 派非 PENDING_ASSIGN 单 → 被拒（状态守卫）
 *     - 白名单 relay 调 reject/archive/void 其经手单 → 403（H-2 隔离：仅放行指派一个动作）
 *     - admin 指派不受影响（原路径保留）
 *
 * require routes/corrections.js 真实 _internals（对齐 verify-correction-routes-smoke 范式）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.error('  ✗ ' + msg); } }

const EXPECTED = [7, 13];
const READONLY_LEADERS = [6, 11];

// ---- 1. 三处字面量同源（RC-L1）----
function extractIds(file, varname) {
    const src = fs.readFileSync(file, 'utf8');
    const m = src.match(new RegExp(varname + '\\s*=\\s*\\[([^\\]]*)\\]'));
    if (!m) return null;
    return m[1].split(',').map(s => s.trim()).filter(Boolean).map(Number);
}
const backFile = path.join(__dirname, '..', 'routes', 'corrections.js');
const frontFile = path.join(__dirname, '..', 'public', 'Data_Correction.html');
const backIds = extractIds(backFile, 'CORRECTION_RELAY_USER_IDS');
const frontIds = extractIds(frontFile, 'CORRECTION_RELAY_USER_IDS');
console.log('[1] 三处字面量同源（RC-L1 防漂移）');
ok(backIds && JSON.stringify(backIds) === JSON.stringify(EXPECTED), `后端 ${backFile} = [${EXPECTED}]（实际 [${backIds}]）`);
ok(frontIds && JSON.stringify(frontIds) === JSON.stringify(EXPECTED), `前端 ${frontFile} = [${EXPECTED}]（实际 [${frontIds}]）`);
ok(backIds && frontIds && JSON.stringify(backIds) === JSON.stringify(frontIds), '后端 / 前端白名单字面量一致');

// ---- 构造 deps + require routes（smoke 范式）----
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
    UPLOAD_DIR: path.join(require('os').tmpdir(), 'correction-relay-verify'),
    readSystemConfig: asyncNoop, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: asyncNoop,
    normalizeAttachmentExt: (x) => x, safeDeleteFileSync: noop, maskPhone: (x) => x,
};
const mod = require('../routes/corrections')(deps);
const I = mod._internals;

// ---- 2. isCorrectionRelayWhitelisted + 导出 ----
console.log('[2] isCorrectionRelayWhitelisted 纯函数 + 导出');
ok(typeof I.isCorrectionRelayWhitelisted === 'function', '_internals 导出 isCorrectionRelayWhitelisted');
ok(JSON.stringify(I.CORRECTION_RELAY_USER_IDS) === JSON.stringify(EXPECTED), `_internals.CORRECTION_RELAY_USER_IDS = [${EXPECTED}]`);
ok(I.isCorrectionRelayWhitelisted(7) === true, '(7)=true');
ok(I.isCorrectionRelayWhitelisted(13) === true, '(13)=true');
ok(I.isCorrectionRelayWhitelisted('13') === true, "('13')=true（字符串归一）");
ok(I.isCorrectionRelayWhitelisted(1) === false, '(1)=false（admin id 不在名单）');
ok(I.isCorrectionRelayWhitelisted(99) === false, '(99)=false（非白名单）');
ok(I.isCorrectionRelayWhitelisted(0) === false, '(0)=false');
ok(I.isCorrectionRelayWhitelisted(null) === false, '(null)=false');

// ---- 3. M-4 防御：白名单不含只读领导 ----
console.log('[3] M-4 防御：白名单与只读领导 [6,11] 无交集');
ok(EXPECTED.every(id => !READONLY_LEADERS.includes(id)), '白名单不含只读领导 6/11（防 viewer/只读领导混入对接人）');

// ---- 4. correctionTransition 指派放行/越权矩阵 ----
function waitReady() { return new Promise((res) => { const t = setInterval(() => { if (I.CORRECTION_SCHEMA_STATE.ready) { clearInterval(t); res(); } }, 10); }); }
async function seed({ relay = null, assigned = null, status = 'PENDING_ASSIGN' } = {}) {
    const r = await dbRunAsync(
        `INSERT INTO correction_requests (source_system, location_info, correction_type, requester_name, status, relay_notified_user_id, assigned_to, created_by, created_by_name)
         VALUES ('BMS', '某处错误', 'single', '测试业务方', ?, ?, ?, 1, 'admin')`,
        [status, relay, assigned]);
    return r.lastID;
}
async function transitionStatus(args) {
    try { await I.correctionTransition.apply(null, args); return { okk: true }; }
    catch (e) { return { okk: false, httpStatus: e.httpStatus, code: e.code }; }
}

(async () => {
    mod.initSchema();
    await waitReady();
    ok(I.CORRECTION_SCHEMA_STATE.ready === true, 'initSchema 三表就绪');

    console.log('[4] correctionTransition 指派放行 / 越权矩阵（核心权威闸门）');

    // 4a 白名单 relay(13) 派其本人经手 PENDING_ASSIGN 单 → 成功（RC-M3 修复核心）
    const id1 = await seed({ relay: 13 });
    const r1 = await transitionStatus([id1, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', { id: 13, name: '示例对接人', role: 'user' }, { assigned_to: 8, assigned_to_name: 'dev', assigned_by: 13 }]);
    ok(r1.okk === true, '白名单 relay(13,user) 派其经手单(relay=13,PENDING_ASSIGN) → 成功（RC-M3：transition 放行白名单 relay）');

    // 4b 白名单 relay(13) 派非本人经手单(relay=7) → 403（H-1 归属）
    const id2 = await seed({ relay: 7 });
    const r2 = await transitionStatus([id2, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', { id: 13, role: 'user' }, { assigned_to: 8, assigned_by: 13 }]);
    ok(r2.httpStatus === 403 && r2.code === 'NOT_AUTHORIZED_FOR_TRANSITION', '白名单 relay(13) 派非本人经手单(relay=7) → 403');

    // 4c 非白名单 user(99) 派单(relay=99) → 403（M-5 移出白名单即失效）
    const id3 = await seed({ relay: 99 });
    const r3 = await transitionStatus([id3, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', { id: 99, role: 'user' }, { assigned_to: 8, assigned_by: 99 }]);
    ok(r3.httpStatus === 403, '非白名单 user(99) 派单(即便 relay=99) → 403（M-5 移出白名单即失效）');

    // 4d 白名单 relay(13) 派非 PENDING_ASSIGN 单 → 被拒（状态守卫；IN_PROGRESS 不允许→ASSIGNED）
    const id4 = await seed({ relay: 13, status: 'IN_PROGRESS', assigned: 8 });
    const r4 = await transitionStatus([id4, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', { id: 13, role: 'user' }, { assigned_to: 9, assigned_by: 13 }]);
    ok(r4.okk === false && (r4.httpStatus === 400 || r4.httpStatus === 409), '白名单 relay(13) 派非 PENDING_ASSIGN 单 → 被拒（状态守卫）');

    // 4e 白名单 relay(13) 调 reject/archive/void 其经手单 → 403（H-2 隔离：仅放行指派）
    for (const ts of ['REJECTED', 'ARCHIVED', 'VOIDED']) {
        const idx = await seed({ relay: 13 });
        const rx = await transitionStatus([idx, null, ts, { id: 13, role: 'user' }, {}]);
        ok(rx.httpStatus === 403, `白名单 relay(13) 调 ${ts} 其经手单 → 403（H-2 隔离：relay 仅能指派，不能其他写）`);
    }

    // 4f admin 指派不受白名单影响（原路径保留）
    const id6 = await seed({ relay: 13 });
    const r6 = await transitionStatus([id6, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', { id: 1, role: 'admin' }, { assigned_to: 8, assigned_by: 1 }]);
    ok(r6.okk === true, 'admin 指派不受白名单影响（原 admin/publisher 路径保留）');

    // 4g publisher 指派不受影响
    const id7 = await seed({ relay: 7 });
    const r7 = await transitionStatus([id7, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', { id: 7, role: 'publisher' }, { assigned_to: 8, assigned_by: 7 }]);
    ok(r7.okk === true, 'publisher 指派不受白名单影响');

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('verify 异常:', e); process.exit(1); });
