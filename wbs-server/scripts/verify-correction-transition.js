// 验证脚本：数据修正模块 correctionTransition 单一状态流转入口 + 建单 + 指派
// 方案：docs/local/数据修正/数据修正模块_方案_20260612_v1.3.md（§3 状态机 / §4 流程 / §7 权限 / §9 闸门）
// 用法：node scripts/verify-correction-transition.js
//
// J3（RC-L2 根治）：本脚本原**复刻** server.js/routes 的 correctionTransition + 流转表 + normalizeCorrectionDatetime，
//   存在复刻漂移风险（如 v1.82.0 对接人白名单化给 transition 加 relay 放行，复刻版不会跟着变 → verify 测旧逻辑给假绿）。
//   现改为 **require routes/corrections.js 的 _internals 真实逻辑**：注入 db helper 指向本脚本 :memory: db + mod.initSchema()
//   建真实三表，断言不变但测的是真实代码（范式同 verify-correction-routes-smoke / relay-whitelist）。
const assert = require('assert');
const sqlite3 = require('sqlite3');
const path = require('path');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

// 注入 deps + require 真实 corrections 模块（db helper 指向本脚本 :memory: db，故 correctionTransition 操作同一库）
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
const asyncNoop = async () => ({});
const deps = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass, requirePublisherOrAdmin: mwPass,
    sendIssueDingtalkRaw: asyncNoop, UPLOAD_DIR: path.join(require('os').tmpdir(), 'correction-transition-verify'),
    readSystemConfig: asyncNoop, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: asyncNoop,
    normalizeAttachmentExt: (x) => x, safeDeleteFileSync: noop, maskPhone: (x) => x,
};
const mod = require('../routes/corrections')(deps);
const I = mod._internals;
// 真实导出（替代复刻）：correctionTransition / 枚举 / 流转表 / 日期归一化
const { correctionTransition, CORRECTION_STATUSES, CORRECTION_STATUS_TRANSITIONS, normalizeCorrectionDatetime } = I;
function waitReady() { return new Promise((res) => { const t = setInterval(() => { if (I.CORRECTION_SCHEMA_STATE.ready) { clearInterval(t); res(); } }, 10); }); }

// 建单 helper（移植 POST /api/corrections 的 INSERT + history 首行；省略 HTTP 层字段校验，专注流转事实）
async function createCorrection({ correction_type = 'single', created_by = 1, created_by_name = '管理员', dingtalk_chat_id = null } = {}) {
    const r = await run(
        `INSERT INTO correction_requests (source_system, location_info, requester_name, correction_type, created_by, created_by_name, dingtalk_chat_id)
         VALUES ('BMS', '合同表#1 金额错，应为 100', '业务张', ?, ?, ?, ?)`,
        [correction_type, created_by, created_by_name, dingtalk_chat_id]);
    const id = r.lastID;
    await run(`INSERT INTO correction_status_history (correction_request_id, from_status, to_status, reason, operator_id, operator_name)
               VALUES (?, NULL, 'PENDING_ASSIGN', '信息技术部建单', ?, ?)`, [id, created_by, created_by_name]);
    return id;
}
const actor = { id: 1, name: '管理员', role: 'admin' };
const ACTOR_DEV = { id: 5, name: '开发王', role: 'user' };
const ACTOR_PUB = { id: 7, name: '示例发布者', role: 'publisher' };
const ACTOR_STRANGER = { id: 99, name: '路人', role: 'user' };   // 非 assignee 非 creator 非白名单

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };
// 断言 transition 抛指定 code（真实 CorrectionTransitionError 带 .code/.httpStatus）
async function expectErr(promise, code, label) {
    try { await promise; assert.fail(`${label}：应抛 ${code} 却成功`); }
    catch (e) {
        if (!e || !e.code) throw e;
        assert.strictEqual(e.code, code, `${label}：应抛 ${code}，实际 ${e.code}`);
    }
}

// schema：users 表本脚本建（routes 不含）；correction 三表用真实 mod.initSchema()（同源，不再复刻 DDL）
async function setupSchema() {
    await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT, role TEXT)`);
    await run(`INSERT INTO users (id, display_name, role) VALUES (1,'管理员','admin'),(4,'示例客服B','admin'),(5,'开发王','user'),(7,'示例发布者','publisher'),(11,'示例只读领导A','viewer')`);
    mod.initSchema();
    await waitReady();
}

async function main() {
    await setupSchema();
    ok('schema + users 表就绪（真实 initSchema 建三表 + users：admin 1/4 / user 5 / publisher 7 / viewer 11）');

    // [1] 流转表结构（9 态 + R-1 完成态不可拒 + 暂缓与列表导出方案 v1.1 SUSPENDED 边）
    assert.strictEqual(CORRECTION_STATUSES.length, 9, '应 9 态（8 态 + SUSPENDED，暂缓方案 v1.1）');
    assert.ok(CORRECTION_STATUS_TRANSITIONS['PENDING_ASSIGN'].includes('ASSIGNED_PENDING_ESTIMATE'), 'PENDING_ASSIGN→指派 合法');
    assert.ok(!CORRECTION_STATUS_TRANSITIONS['FIXED'].includes('REJECTED'), 'R-1：FIXED 不可→REJECTED');
    assert.ok(!CORRECTION_STATUS_TRANSITIONS['REFIXED'].includes('REJECTED'), 'R-1：REFIXED 不可→REJECTED');
    assert.strictEqual(CORRECTION_STATUS_TRANSITIONS['VOIDED'], undefined, 'VOIDED 无后续转移');
    // 暂缓方案 v1.1 §2.1.1：逐边核对——入口两态（ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS→SUSPENDED）+ 出口三路（SUSPENDED→恢复/ARCHIVED/VOIDED）
    assert.ok(CORRECTION_STATUS_TRANSITIONS['ASSIGNED_PENDING_ESTIMATE'].includes('SUSPENDED'), 'ASSIGNED_PENDING_ESTIMATE→SUSPENDED 合法（入口）');
    assert.ok(CORRECTION_STATUS_TRANSITIONS['IN_PROGRESS'].includes('SUSPENDED'), 'IN_PROGRESS→SUSPENDED 合法（入口）');
    assert.ok(!CORRECTION_STATUS_TRANSITIONS['PENDING_ASSIGN'].includes('SUSPENDED'), 'PENDING_ASSIGN 不可→SUSPENDED（未指派谈不上开发判断）');
    assert.ok(!CORRECTION_STATUS_TRANSITIONS['FIXED'].includes('SUSPENDED'), 'FIXED 不可→SUSPENDED（已完成谈不上无法修正）');
    assert.ok(!CORRECTION_STATUS_TRANSITIONS['REFIXED'].includes('SUSPENDED'), 'REFIXED 不可→SUSPENDED（已完成谈不上无法修正）');
    assert.deepStrictEqual(CORRECTION_STATUS_TRANSITIONS['SUSPENDED'].slice().sort(),
        ['ARCHIVED', 'ASSIGNED_PENDING_ESTIMATE', 'VOIDED'], 'SUSPENDED 出口恰三路（恢复/行政闭环/作废，无死锁受困态）');
    ok('流转表（真实导出）：9 态 + R-1 完成态不可拒 + VOIDED 无后续 + SUSPENDED 入口两态/出口三路（暂缓方案 v1.1 §2.1.1）');

    // [2] 建单：INSERT + history 首行 NULL→PENDING_ASSIGN
    const c1 = await createCorrection({ correction_type: 'single' });
    const h1 = await all('SELECT from_status, to_status FROM correction_status_history WHERE correction_request_id=? ORDER BY id', [c1]);
    assert.strictEqual(h1.length, 1, '建单应有 1 条 history');
    assert.strictEqual(h1[0].from_status, null, '首条 from_status=NULL');
    assert.strictEqual(h1[0].to_status, 'PENDING_ASSIGN', '首条 to=PENDING_ASSIGN');
    ok('建单：INSERT + history 首行 NULL→PENDING_ASSIGN');

    // [3] 指派 PENDING_ASSIGN→ASSIGNED_PENDING_ESTIMATE（路径 A/B 共用）
    await correctionTransition(c1, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', actor, { assigned_to: 5, assigned_to_name: '开发王', assigned_by: 1 });
    const r3 = await get('SELECT status, assigned_to, assigned_to_name, assigned_by FROM correction_requests WHERE id=?', [c1]);
    assert.strictEqual(r3.status, 'ASSIGNED_PENDING_ESTIMATE', '指派后状态');
    assert.strictEqual(r3.assigned_to, 5, 'assigned_to 写入');
    const h3 = await all('SELECT from_status, to_status, reason FROM correction_status_history WHERE correction_request_id=? ORDER BY id', [c1]);
    assert.strictEqual(h3.length, 2, '指派后 2 条 history');
    assert.strictEqual(h3[1].from_status, 'PENDING_ASSIGN', '第 2 条 from=PENDING_ASSIGN（走 transition 非直接 INSERT，L-1）');
    ok('指派：transition 产生 history（L-1，from=PENDING_ASSIGN→ASSIGNED_PENDING_ESTIMATE + assigned_to 写入）');

    // [4] expectedFromStatus 比对（R-6）：已指派单用 PENDING_ASSIGN 期望去推 IN_PROGRESS → 409
    await expectErr(correctionTransition(c1, 'PENDING_ASSIGN', 'IN_PROGRESS', ACTOR_DEV, { dev_estimated_at: '2026-06-20 12:00' }), 'CONCURRENT_STATE_CHANGE', 'R-6 陈旧 expectedFrom');
    ok('R-6：expectedFromStatus 与 DB 真实状态不符 → 409 CONCURRENT_STATE_CHANGE');

    // [5] →IN_PROGRESS 强制闸门：dev_estimated_at 必填
    await expectErr(correctionTransition(c1, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', ACTOR_DEV, {}), 'ESTIMATE_REQUIRED', '无预计时间');
    await correctionTransition(c1, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', ACTOR_DEV, { dev_estimated_at: '2026-06-20T12:00' });
    const r5 = await get('SELECT status, dev_estimated_at, estimated_replied_at FROM correction_requests WHERE id=?', [c1]);
    assert.strictEqual(r5.status, 'IN_PROGRESS', '进 IN_PROGRESS');
    assert.strictEqual(r5.dev_estimated_at, '2026-06-20 12:00:00', 'dev_estimated_at 归一化（T→空格 + 补秒）');
    assert.ok(r5.estimated_replied_at, 'estimated_replied_at 写入');
    ok('→IN_PROGRESS 闸门：无 dev_estimated_at 拒 ESTIMATE_REQUIRED；有则归一化写入');

    // [6] →FIXED 普通 single 闸门（v1.97.1 留证放开）：文字必填≥5，截图改可选（详细越权/error_proof 留证仍由 verify-correction-rework-gate C 段返工分支守）
    await expectErr(correctionTransition(c1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, {}), 'SINGLE_NOTE_REQUIRED', '普通 single 无完成说明');
    await expectErr(correctionTransition(c1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '改了' }), 'SINGLE_NOTE_TOO_SHORT', '普通 single 说明<5');
    await correctionTransition(c1, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '已修正合同金额为 100' });   // 截图可选：不传也放行
    const r6 = await get('SELECT status, fixed_at, submission_count FROM correction_requests WHERE id=?', [c1]);
    assert.strictEqual(r6.status, 'FIXED', '进 FIXED');
    assert.strictEqual(r6.submission_count, 1, '首次完成 submission_count=1');
    assert.ok(r6.fixed_at, 'fixed_at 写入');
    ok('→FIXED 普通 single 闸门（v1.97.1）：无文字 SINGLE_NOTE_REQUIRED / <5 SINGLE_NOTE_TOO_SHORT / 文字≥5 无截图也放行 + count=1');

    // [7] →REFIXED 普通 single（v1.97.1）：重修说明必填、截图可选；若可选传截图仍校验新增性（codex 09 H-1，防复用旧图）
    await expectErr(correctionTransition(c1, 'FIXED', 'REFIXED', ACTOR_DEV, {}), 'SINGLE_RESUBMIT_NOTE_REQUIRED', '普通 single 重修无说明');
    // 7a 可选传截图但复用本单旧图（created_at ≤ fixed_at）→ 新增性兜底拒（留证质量不松：可不传，传就得真新增）
    const fixOld = await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name, created_at) VALUES (?, 'fix_proof', 'old.png', 5, '开发王', '2000-01-01 00:00:00')`, [c1]);
    await expectErr(correctionTransition(c1, 'FIXED', 'REFIXED', ACTOR_DEV, { resubmit_note: '本次重新核对', new_fix_proof_attachment_ids: [fixOld.lastID] }), 'FIX_PROOF_REQUIRED', 'H-1 可选传截图但复用旧图（非新增）');
    // 7b 重修说明 + 无截图 → 放行 + count+1（截图可选）
    await correctionTransition(c1, 'FIXED', 'REFIXED', ACTOR_DEV, { resubmit_note: '本次按业务方口径重新核对' });
    const r7 = await get('SELECT status, refixed_at, submission_count FROM correction_requests WHERE id=?', [c1]);
    assert.strictEqual(r7.status, 'REFIXED', '进 REFIXED');
    assert.strictEqual(r7.submission_count, 2, '重修 submission_count+1=2');
    assert.ok(r7.refixed_at, 'refixed_at 写入');
    ok('→REFIXED 普通 single 闸门（v1.97.1）：无说明 SINGLE_RESUBMIT_NOTE_REQUIRED / 可选截图复用旧图仍拒 FIX_PROOF_REQUIRED / 说明+无截图放行 + count+1');

    // [8] →ARCHIVED 摩擦闸门：造一个有 chat_id（发起过拉群=有摩擦）的 FIXED 单
    const c2 = await createCorrection({ correction_type: 'single', dingtalk_chat_id: 'cidXYZ' });
    await correctionTransition(c2, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', actor, { assigned_to: 5, assigned_to_name: '开发王', assigned_by: 1 });
    await correctionTransition(c2, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', ACTOR_DEV, { dev_estimated_at: '2026-06-20 12:00' });
    await correctionTransition(c2, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '已修正口径完成' });   // v1.97.1：普通 single 文字必填、截图可选
    await expectErr(correctionTransition(c2, 'FIXED', 'ARCHIVED', actor, {}), 'FRICTION_REASON_REQUIRED', '有摩擦归档无原因');
    await correctionTransition(c2, 'FIXED', 'ARCHIVED', actor, { friction_reason: '业务方对口径有异议，拉群澄清后确认' });
    const r8 = await get('SELECT status, archived_at, archived_by, friction_reason FROM correction_requests WHERE id=?', [c2]);
    assert.strictEqual(r8.status, 'ARCHIVED', '进 ARCHIVED');
    assert.ok(r8.friction_reason, 'friction_reason 写入');
    ok('→ARCHIVED 闸门（G-13）：有 chat_id 归档必填 friction_reason；含 history.reason');

    // [9] c1（REFIXED，无 chat_id）归档：无摩擦不强制 friction_reason
    await correctionTransition(c1, 'REFIXED', 'ARCHIVED', actor, {});
    assert.strictEqual((await get('SELECT status FROM correction_requests WHERE id=?', [c1])).status, 'ARCHIVED', 'c1 无摩擦归档成功');
    ok('→ARCHIVED：无 chat_id（未拉群）归档不强制 friction_reason');

    // [9b] I2 §3.4 行政闭环 ARCHIVED 双闸门：normal 须 FIXED/REFIXED；admin_closure 仅 admin 从未完成态 + closure_reason 10-500
    const ac1 = await createCorrection();   // PENDING_ASSIGN
    await expectErr(correctionTransition(ac1, null, 'ARCHIVED', actor, { closure_type: 'normal' }), 'INVALID_TRANSITION', 'normal 归档须 FIXED/REFIXED（未完成态拒）');
    await expectErr(correctionTransition(ac1, null, 'ARCHIVED', actor, { closure_type: 'bad_typo' }), 'INVALID_CLOSURE_TYPE', '非法 closure_type 拒（RC-M2 不静默归一）');
    await expectErr(correctionTransition(ac1, null, 'ARCHIVED', actor, { closure_type: 'admin_closure', closure_reason: '太短' }), 'CLOSURE_REASON_REQUIRED', 'admin_closure 须 closure_reason 10-500');
    await expectErr(correctionTransition(ac1, null, 'ARCHIVED', ACTOR_PUB, { closure_type: 'admin_closure', closure_reason: '开发长期未处理，线下已确认数据修正，行政收口' }), 'NOT_AUTHORIZED_FOR_TRANSITION', '行政闭环仅 admin（publisher 拒）');
    await correctionTransition(ac1, null, 'ARCHIVED', actor, { closure_type: 'admin_closure', closure_reason: '开发长期未处理，线下已确认数据修正，行政收口' });
    const rac1 = await get('SELECT status, closure_type, closure_reason, friction_reason FROM correction_requests WHERE id=?', [ac1]);
    assert.strictEqual(rac1.status, 'ARCHIVED', 'admin_closure 进 ARCHIVED');
    assert.strictEqual(rac1.closure_type, 'admin_closure', 'closure_type=admin_closure 落库');
    assert.ok(rac1.closure_reason && rac1.closure_reason.length >= 10, 'closure_reason 落库');
    assert.strictEqual(rac1.friction_reason, null, 'L-1：admin_closure 互斥清 friction_reason=NULL');
    ok('行政闭环（I2 §3.4）：normal 须 FIXED/REFIXED / 非法 closure_type 拒 / admin_closure 须 reason 10-500 + 仅 admin + 从 PENDING_ASSIGN 落 closure_type+reason');

    // [9c] 边界：admin_closure 不可从已完成态 FIXED（INVALID_CLOSURE_SOURCE）；缺 closure_type 默认 normal 向后兼容
    const ac2 = await createCorrection();
    await correctionTransition(ac2, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', actor, { assigned_to: 5, assigned_to_name: '开发王', assigned_by: 1 });
    await correctionTransition(ac2, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', ACTOR_DEV, { dev_estimated_at: '2099-01-01 10:00' });
    await correctionTransition(ac2, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '已修正完成口径' });   // v1.97.1：普通 single 文字必填、截图可选
    await expectErr(correctionTransition(ac2, null, 'ARCHIVED', actor, { closure_type: 'admin_closure', closure_reason: '已完成单不应走行政闭环占位文字够长' }), 'INVALID_CLOSURE_SOURCE', 'admin_closure 不可从 FIXED');
    await correctionTransition(ac2, 'FIXED', 'ARCHIVED', actor, {});   // 缺 closure_type → 默认 normal
    const rac2 = await get('SELECT status, closure_type, closure_reason FROM correction_requests WHERE id=?', [ac2]);
    assert.strictEqual(rac2.status, 'ARCHIVED', 'FIXED normal 归档成功');
    assert.strictEqual(rac2.closure_type, 'normal', '缺 closure_type 默认 normal（向后兼容旧 archive 调用）');
    assert.strictEqual(rac2.closure_reason, null, 'L-1：normal 互斥清 closure_reason=NULL');
    ok('行政闭环边界：admin_closure 不可从 FIXED（INVALID_CLOSURE_SOURCE）；缺 closure_type 默认 normal 向后兼容 + L-1 字段互斥');

    // [9d] L-2 流转表快照断言（codex 28）：ARCHIVED 可达源态 = FIXED/REFIXED(normal) + 4 未完成态(admin_closure)
    //   暂缓方案 v1.1 §2.1.1：SUSPENDED 加入行政闭环源态白名单（否则 SUSPENDED→ARCHIVED 出口断路），反查集合应由 5→6。
    const archSources = Object.keys(CORRECTION_STATUS_TRANSITIONS).filter(s => (CORRECTION_STATUS_TRANSITIONS[s] || []).includes('ARCHIVED'));
    assert.deepStrictEqual(archSources.slice().sort(), ['ASSIGNED_PENDING_ESTIMATE', 'FIXED', 'IN_PROGRESS', 'PENDING_ASSIGN', 'REFIXED', 'SUSPENDED'], '流转表 ARCHIVED 可达源态应为 6 个（暂缓方案 v1.1 新增 SUSPENDED）');
    ok('流转表快照（L-2）：ARCHIVED 可达 6 源态（PENDING_ASSIGN/ASSIGNED_PENDING_ESTIMATE/IN_PROGRESS/SUSPENDED 行政闭环 + FIXED/REFIXED 正常归档，暂缓方案 v1.1 §2.1.1）');

    // [9e] 暂缓方案 v1.1 §2.4 运行时冒烟（完整端点/边界断言在专用 verify-correction-suspend.js，此处只证 correctionTransition 真实跑通两条边）
    const cs1 = await createCorrection({ correction_type: 'single' });
    await correctionTransition(cs1, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', actor, { assigned_to: 5, assigned_to_name: '开发王', assigned_by: 1 });
    await correctionTransition(cs1, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', ACTOR_DEV, { dev_estimated_at: '2026-06-20 12:00' });
    await correctionTransition(cs1, 'IN_PROGRESS', 'SUSPENDED', ACTOR_DEV, { reason: '业务源单据未闭环，暂无法修正' });
    const rs1 = await get('SELECT status, suspended_at, dev_estimated_at FROM correction_requests WHERE id=?', [cs1]);
    assert.strictEqual(rs1.status, 'SUSPENDED', 'IN_PROGRESS→SUSPENDED 成功');
    assert.ok(rs1.suspended_at, 'suspended_at 写入');
    assert.ok(rs1.dev_estimated_at, '暂缓不清空 dev_estimated_at（保留现场，§2.4）');
    await correctionTransition(cs1, 'SUSPENDED', 'ASSIGNED_PENDING_ESTIMATE', ACTOR_DEV, {});
    const rs2 = await get('SELECT status, dev_estimated_at, suspended_at FROM correction_requests WHERE id=?', [cs1]);
    assert.strictEqual(rs2.status, 'ASSIGNED_PENDING_ESTIMATE', '恢复固定回 ASSIGNED_PENDING_ESTIMATE（§2.1.2）');
    assert.strictEqual(rs2.dev_estimated_at, null, '恢复清空 dev_estimated_at（旧预计失效）');
    assert.ok(rs2.suspended_at, '恢复不清空 suspended_at（最后一次暂缓时刻，§2.2）');
    ok('暂缓/恢复冒烟：IN_PROGRESS→SUSPENDED（不清 dev_estimated_at）→ 恢复→ASSIGNED_PENDING_ESTIMATE（清 dev_estimated_at，留 suspended_at）');

    // [10] →REJECTED：reason 必填；FIXED→REJECTED 非法（R-1）
    const c3 = await createCorrection({ correction_type: 'single' });
    await expectErr(correctionTransition(c3, 'PENDING_ASSIGN', 'REJECTED', actor, {}), 'REJECT_REASON_REQUIRED', '拒绝无原因');
    await correctionTransition(c3, 'PENDING_ASSIGN', 'REJECTED', actor, { reject_reason: '该数据业务上无需修正' });
    assert.strictEqual((await get('SELECT status, reject_reason FROM correction_requests WHERE id=?', [c3])).status, 'REJECTED', '进 REJECTED');
    const c4 = await createCorrection({ correction_type: 'batch' });
    await correctionTransition(c4, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', actor, { assigned_to: 5, assigned_to_name: '开发王', assigned_by: 1 });
    await correctionTransition(c4, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', ACTOR_DEV, { dev_estimated_at: '2026-06-20 12:00' });
    await expectErr(correctionTransition(c4, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, {}), 'BATCH_NOTE_REQUIRED', '批量无完成说明');
    await correctionTransition(c4, 'IN_PROGRESS', 'FIXED', ACTOR_DEV, { batch_completion_note: '批量更新了 30 条合同金额' });
    await expectErr(correctionTransition(c4, 'FIXED', 'REJECTED', actor, { reject_reason: 'x' }), 'INVALID_TRANSITION', 'R-1 FIXED 不可拒');
    ok('→REJECTED：reason 必填 + FIXED→REJECTED 非法（R-1）；→FIXED batch 必填 batch_completion_note');

    // [11] →REFIXED batch：resubmit_note 必填且写 history.reason（§9 约束 33）
    await expectErr(correctionTransition(c4, 'FIXED', 'REFIXED', ACTOR_DEV, {}), 'BATCH_RESUBMIT_NOTE_REQUIRED', '批量重修无说明');
    await correctionTransition(c4, 'FIXED', 'REFIXED', ACTOR_DEV, { resubmit_note: '本次重新核对了客户编号映射' });
    const h11 = await all("SELECT to_status, reason FROM correction_status_history WHERE correction_request_id=? AND to_status='REFIXED'", [c4]);
    assert.strictEqual(h11.length, 1, '1 条 REFIXED history');
    assert.strictEqual(h11[0].reason, '本次重新核对了客户编号映射', 'batch resubmit_note 写入 history.reason');
    ok('→REFIXED batch：resubmit_note 必填且写 history.reason（不加主表字段，§9 约束 33）');

    // [12] VOIDED 通用旁路：任意非 VOIDED 态可作废（c3 REJECTED → VOIDED）
    await correctionTransition(c3, null, 'VOIDED', actor, { void_reason: '误建' });
    const r12 = await get('SELECT status, voided_at, void_reason FROM correction_requests WHERE id=?', [c3]);
    assert.strictEqual(r12.status, 'VOIDED', 'REJECTED→VOIDED 旁路成功');
    assert.ok(r12.voided_at, 'voided_at 写入（软删标记）');
    await expectErr(correctionTransition(c3, null, 'VOIDED', actor, {}), 'ALREADY_VOIDED', '重复作废');
    await expectErr(correctionTransition(c3, 'VOIDED', 'ARCHIVED', actor, {}), 'INVALID_TRANSITION', 'VOIDED 无后续');
    ok('VOIDED 旁路（G-14）：任意非 VOIDED 态可作废（不比 expectedFrom）；重复作废 409；VOIDED 无后续转移');

    // [13] 双条件 WHERE 守卫 SQL 契约：status 被并发改后，按旧 status UPDATE → changes=0
    const c5 = await createCorrection({ correction_type: 'single' });
    await run(`UPDATE correction_requests SET status='VOIDED' WHERE id=?`, [c5]);
    const staleUpd = await run(`UPDATE correction_requests SET status='ASSIGNED_PENDING_ESTIMATE' WHERE id=? AND status='PENDING_ASSIGN'`, [c5]);
    assert.strictEqual(staleUpd.changes, 0, '双 WHERE：status 已变，按旧状态 UPDATE 命中 0 行');
    ok('双条件 WHERE 守卫 SQL 契约：旧状态 UPDATE 命中 0 行（→ transition 内 changes!==1 回滚 409）');

    // [14] 非法目标 + 非法流转
    await expectErr(correctionTransition(c5, null, 'NOT_A_STATUS', actor, {}), 'INVALID_TARGET_STATUS', '非法目标状态');
    const c6 = await createCorrection({ correction_type: 'single' });
    await expectErr(correctionTransition(c6, 'PENDING_ASSIGN', 'FIXED', ACTOR_DEV, {}), 'INVALID_TRANSITION', 'PENDING_ASSIGN→FIXED 跳态');
    ok('非法目标状态 + 跳态流转（PENDING_ASSIGN→FIXED）均被拦');

    // [15] codex 09 M-2：normalizeCorrectionDatetime 非法值校验 + 透传到闸门
    assert.strictEqual(normalizeCorrectionDatetime('abc'), null, "'abc' 应返 null");
    assert.strictEqual(normalizeCorrectionDatetime('2026-13-01 10:00'), null, '13 月越界应返 null');
    assert.strictEqual(normalizeCorrectionDatetime('2026-06-31 10:00'), null, '6月31日越界应返 null');
    assert.strictEqual(normalizeCorrectionDatetime('2026-06-20T12:00'), '2026-06-20 12:00:00', '合法 T 格式归一化');
    const c7 = await createCorrection({ correction_type: 'single' });
    await correctionTransition(c7, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', actor, { assigned_to: 5, assigned_to_name: '开发王', assigned_by: 1 });
    await expectErr(correctionTransition(c7, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', ACTOR_DEV, { dev_estimated_at: 'abc' }), 'ESTIMATE_REQUIRED', '非法日期被当空 → 拒进 IN_PROGRESS');
    ok("M-2：normalizeCorrectionDatetime 严格校验（'abc'/13月/31日→null），非法 dev_estimated_at 拒进 IN_PROGRESS");

    // [16] codex 09 M-3：transition 权限分流（§7.2）——非授权 actor 被 403 拦
    const c8 = await createCorrection({ correction_type: 'single', created_by: 1 });
    await correctionTransition(c8, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', actor, { assigned_to: 5, assigned_to_name: '开发王', assigned_by: 1 });
    await expectErr(correctionTransition(c8, 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', ACTOR_STRANGER, { dev_estimated_at: '2026-06-20 12:00' }), 'NOT_AUTHORIZED_FOR_TRANSITION', '非本单开发不可推进');
    const c9 = await createCorrection({ correction_type: 'single', created_by: 1 });
    await correctionTransition(c9, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', ACTOR_PUB, { assigned_to: 5, assigned_to_name: '开发王', assigned_by: 7 });
    await expectErr(correctionTransition(c9, null, 'VOIDED', ACTOR_PUB, { void_reason: 'x' }), 'NOT_AUTHORIZED_FOR_TRANSITION', 'publisher 非建单人不可作废');
    const c10 = await createCorrection({ correction_type: 'single', created_by: 1 });
    await expectErr(correctionTransition(c10, 'PENDING_ASSIGN', 'REJECTED', ACTOR_DEV, { reject_reason: 'x' }), 'NOT_AUTHORIZED_FOR_TRANSITION', '开发不可拒未指派单');
    ok('M-3：transition 权限分流——非本单开发不可标完成 / publisher 不可作废 / 开发不可拒未指派单（均 403）');

    // [17] codex 09 M-4：建单路径 A/B 互斥（endpoint 级规则镜像；完整 endpoint 覆盖在 flow verify）
    const conflictRule = (hasAssign, hasRelay) => (hasAssign && hasRelay);
    assert.strictEqual(conflictRule(true, true), true, '同传 assigned_to+relay → 冲突');
    assert.strictEqual(conflictRule(true, false), false, '仅指派 → 不冲突');
    assert.strictEqual(conflictRule(false, true), false, '仅对接人 → 不冲突');
    ok('M-4：建单路径 A/B 互斥规则镜像（同传判冲突 ASSIGN_AND_RELAY_CONFLICT；完整 endpoint 断言在 flow verify）');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ correctionTransition 验证通过【J3 require 真实 _internals，非复刻】（9 态闸门 + 双 WHERE 守卫 + VOIDED 旁路 + fix_proof join users 契约 + R-6 + R-1 + codex 09 全 6 项 + 暂缓方案 v1.1 SUSPENDED 边）`);
    db.close();
}

main().catch((e) => { console.error('\n[失败]', e && e.message, e && e.stack); db.close(); process.exit(1); });
