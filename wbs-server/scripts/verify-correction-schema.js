// 验证脚本：数据修正模块 correction 三表 schema（9 态全字段（暂缓方案 v1.1 新增 SUSPENDED）+ 5 群字段 + NOT NULL + 索引 + CHECK + FK）
// 方案：docs/local/数据修正/数据修正模块_方案_20260612_v1.3.md §2 / §9b（schema 层）
// 用法：node scripts/verify-correction-schema.js
//
// J3（RC-L2 根治）：本脚本原**复刻**一份 DDL_CORRECTION_*（与 server.js/routes 建表 DDL 双份，易漂移）。
//   现改为 **require routes/corrections.js 的真实 mod.initSchema()** 建表（db helper 注入本脚本 :memory: db），
//   断言期望清单（REQ_KEY_COLS / REQ_NOTNULL_COLS / EXPECTED_INDEXES）不变，但测的是真实建表 DDL（漂移即暴露）。
const assert = require('assert');
const sqlite3 = require('sqlite3');
const path = require('path');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

// 注入 deps + require 真实 corrections 模块（initSchema 在本脚本 :memory: db 建真实三表 + 索引）
const noop = () => {};
const mwPass = (req, res, next) => (next ? next() : undefined);
const asyncNoop = async () => ({});
const deps = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
    authenticateToken: mwPass, requireAdmin: mwPass, requirePublisherOrAdmin: mwPass,
    sendIssueDingtalkRaw: asyncNoop, UPLOAD_DIR: path.join(require('os').tmpdir(), 'correction-schema-verify'),
    readSystemConfig: asyncNoop, COLLAB_CHAT_ADMIN_ID: 3, callDingtalkWithTokenRetry: asyncNoop,
    normalizeAttachmentExt: (x) => x, safeDeleteFileSync: noop, maskPhone: (x) => x,
};
const mod = require('../routes/corrections')(deps);
const I = mod._internals;
function waitReady() { return new Promise((res) => { const t = setInterval(() => { if (I.CORRECTION_SCHEMA_STATE.ready) { clearInterval(t); res(); } }, 10); }); }

// correction_requests 关键列子集（§9b schema 层断言用，非 §2 62 列全集——聚焦有约束/有业务语义的列）。
const REQ_KEY_COLS = [
    'source_system', 'source_system_other', 'location_info',
    'correction_count', 'reason', 'oa_number', 'correction_type', 'requester_dept', 'requester_name',
    'requester_phone', 'status', 'expected_deadline', 'dev_estimated_at', 'assigned_to',
    'batch_completion_note', 'submission_count', 'fixed_at', 'refixed_at',
    'completion_notified_at', 'completion_notify_status', 'completion_read_at',
    'relay_notified_user_id', 'relay_notified_at', 'relay_notify_status', 'relay_read_at',
    'archived_at', 'archived_by', 'friction_reason', 'closure_type', 'closure_reason',
    'voided_at', 'voided_by', 'void_reason',
    'created_by', 'created_by_name',
    'rejected_at', 'reject_reason',
    'notify_status', 'requester_notify_status',
    'dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at',
    'dingtalk_chat_created_by', 'dingtalk_chat_name',
];
const EXPECTED_INDEXES = [
    'idx_corr_status', 'idx_corr_assigned', 'idx_corr_created_by',
    'idx_corr_dev_estimated', 'idx_corr_voided', 'idx_corr_att_rid', 'idx_corr_hist_rid',
];
const CORRECTION_STATUSES = I.CORRECTION_STATUSES;   // 真实导出 9 态（暂缓方案 v1.1 新增 SUSPENDED）

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function main() {
    // FK 强制（SQLite 默认 OFF）。⚠️ 边界：生产 server.js 未启用 FK（仅结构声明），本脚本启用仅为测 FK 定义拼对。
    await run('PRAGMA foreign_keys = ON');
    mod.initSchema();           // J3：真实建表（替代复刻 DDL）
    await waitReady();
    ok('三表 + 索引建立成功（真实 initSchema，FK 强制已开，仅测试期验 FK 定义正确性）');

    // [0] _internals KEY_COLS 与本脚本期望清单同源（防真实建表与断言期望漂移）
    assert.ok(Array.isArray(I.CORRECTION_REQUESTS_KEY_COLS) && I.CORRECTION_REQUESTS_KEY_COLS.length > 0, '_internals 导出 CORRECTION_REQUESTS_KEY_COLS');
    ok(`_internals.CORRECTION_REQUESTS_KEY_COLS 就绪（${I.CORRECTION_REQUESTS_KEY_COLS.length} 列，readiness 校验锚点）`);

    // [1] 三表存在
    const tables = (await all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('correction_requests','correction_attachments','correction_status_history')"
    )).map(r => r.name);
    assert.strictEqual(tables.length, 3, `应有 3 表，实际 ${tables.length}: ${tables.join(',')}`);
    ok(`三表存在：${tables.sort().join(' / ')}`);

    // [2] correction_requests 关键列齐全（含 5 群字段 + 通知 + 责任链锚点）
    const colRows = await all('PRAGMA table_info(correction_requests)');
    const cols = colRows.map(r => r.name);
    const missing = REQ_KEY_COLS.filter(c => !cols.includes(c));
    assert.strictEqual(missing.length, 0, `主表关键列缺失: ${missing.join(',')}`);
    ok(`correction_requests 关键列齐全（${REQ_KEY_COLS.length} 列含 9 态/5 群/通知/责任链锚点）`);
    // [2b] _internals.CORRECTION_REQUESTS_KEY_COLS 每列都在真实表（同源闭环）
    const keyColMissing = I.CORRECTION_REQUESTS_KEY_COLS.filter(c => !cols.includes(c));
    assert.strictEqual(keyColMissing.length, 0, `_internals KEY_COLS 在真实表缺失: ${keyColMissing.join(',')}`);
    ok('_internals.CORRECTION_REQUESTS_KEY_COLS 全部存在于真实建表（readiness 校验与真实 schema 同源）');

    // [2c] 核心 NOT NULL 列断言（v1.81.0 复审优化 H：删 expected_value，location_info 语义改"修正方式"）
    const REQ_NOTNULL_COLS = ['source_system', 'location_info', 'requester_name', 'created_by', 'status', 'correction_type'];
    const notNullBroken = REQ_NOTNULL_COLS.filter(c => {
        const def = colRows.find(x => x.name === c);
        return !def || def.notnull !== 1;
    });
    assert.strictEqual(notNullBroken.length, 0, `主表 NOT NULL 约束缺失/未生效: ${notNullBroken.join(',')}`);
    ok(`主表 6 个核心列 NOT NULL 约束生效（source_system/location_info/requester_name/created_by/status/correction_type）`);

    // [3] 5 个钉钉群字段单列断言（旁路字段，G-6 不走 transition）
    const chatCols = ['dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at', 'dingtalk_chat_created_by', 'dingtalk_chat_name'];
    assert.ok(chatCols.every(c => cols.includes(c)), '5 群字段应全在');
    ok(`5 个 dingtalk_chat_* 群字段齐全（旁路 UPDATE 不动 status）`);

    // [4] 关键索引存在（含 idx_corr_voided 支撑软删过滤）
    const idxRows = (await all("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_corr%'")).map(r => r.name);
    const missingIdx = EXPECTED_INDEXES.filter(i => !idxRows.includes(i));
    assert.strictEqual(missingIdx.length, 0, `索引缺失: ${missingIdx.join(',')}`);
    ok(`7 索引齐全（含 idx_corr_voided 支撑列表 voided_at IS NULL 过滤）`);

    // [5] NOT NULL 生效：created_by 缺失 → 拒（R-3/M-2 责任链/可见性锚点）
    await assert.rejects(
        run(`INSERT INTO correction_requests (source_system, location_info, requester_name) VALUES ('BMS', 'loc', '业务张')`),
        /NOT NULL|constraint/i, 'created_by NOT NULL 未生效');
    ok('NOT NULL：建单缺 created_by 被拒（可见性/权限锚点强制）');

    // [6] NOT NULL 生效：核心需求字段缺失 → 拒（location_info）
    await assert.rejects(
        run(`INSERT INTO correction_requests (source_system, requester_name, created_by) VALUES ('BMS', '业务张', 1)`),
        /NOT NULL|constraint/i, 'location_info NOT NULL 未生效');
    ok('NOT NULL：缺 location_info（修正方式）被拒（核心需求字段强制非空）');

    // [7] 合法建单成功 + 默认值（status=PENDING_ASSIGN / type=single / count=0 / 三通知 not_sent / voided_at NULL）
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by) VALUES ('BMS', '合同表#123 金额错，应为 100', '业务张', 1)`);
    const r1 = await get(`SELECT status, correction_type, submission_count, completion_notify_status, notify_status, requester_notify_status, voided_at FROM correction_requests WHERE source_system='BMS'`);
    assert.strictEqual(r1.status, 'PENDING_ASSIGN', `status 默认应 PENDING_ASSIGN，实际 ${r1.status}`);
    assert.strictEqual(r1.correction_type, 'single', `correction_type 默认应 single，实际 ${r1.correction_type}`);
    assert.strictEqual(r1.submission_count, 0, `submission_count 默认应 0，实际 ${r1.submission_count}`);
    assert.strictEqual(r1.completion_notify_status, 'not_sent', 'completion_notify_status 默认 not_sent');
    assert.strictEqual(r1.notify_status, 'not_sent', 'notify_status 默认 not_sent');
    assert.strictEqual(r1.requester_notify_status, 'not_sent', 'requester_notify_status 默认 not_sent');
    assert.strictEqual(r1.voided_at, null, '新建单 voided_at 应为 NULL（未作废）');
    ok(`默认值：status=PENDING_ASSIGN / type=single / count=0 / 三通知 not_sent / voided_at=NULL`);

    // [7b] H 新增 correction_count CHECK（RC-L2 + codex24 M-2）+ closure_type/relay_notify_status 默认值
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count) VALUES ('ERP', 'cnt-null', '业务张', 1, NULL)`);
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count) VALUES ('ERP', 'cnt-5', '业务张', 1, 5)`);
    await assert.rejects(run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count) VALUES ('ERP', 'cnt-0', '业务张', 1, 0)`), /CHECK|constraint/i, 'correction_count=0 应被 CHECK 拒');
    await assert.rejects(run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count) VALUES ('ERP', 'cnt-neg', '业务张', 1, -3)`), /CHECK|constraint/i, 'correction_count=-3 应被 CHECK 拒');
    await assert.rejects(run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count) VALUES ('ERP', 'cnt-real', '业务张', 1, 1.5)`), /CHECK|constraint/i, 'correction_count=1.5（REAL）应被 typeof CHECK 拒');
    ok('correction_count CHECK（RC-L2 + codex24 M-2）：NULL/正整数可写，0/负数/1.5(REAL) 被拒');

    // [7c] correction_count 后端正则口径自检（codex 24 M-1）。⚠️ 此正则是 server.js POST endpoint 逻辑的复刻（非 schema），
    //   endpoint 校验未抽函数导出 _internals，故仍以复刻断言口径，须与 corrections.js path B 建单 /^[1-9]\d{0,8}$/ 同步。
    const COUNT_RE = /^[1-9]\d{0,8}$/;
    const norm = (s) => String(s).trim();
    const shouldReject = ['5.0', '1e3', '0x10', '0', '-3', '01', '1234567890', 'abc'];
    const shouldAccept = ['1', '5', '999999999', '100', ' 5 '];
    assert.strictEqual(shouldReject.filter(s => COUNT_RE.test(norm(s))).length, 0, 'correction_count 正则应拒却通过');
    assert.strictEqual(shouldAccept.filter(s => !COUNT_RE.test(norm(s))).length, 0, 'correction_count 正则应放行却拒');
    ok('correction_count 后端正则口径自检（M-1，endpoint 逻辑复刻）：拒 5.0/1e3/0x10/0/前导0/10位/非数字，放行 1-999999999');
    const hDefaults = await get(`SELECT closure_type, relay_notify_status, relay_read_at FROM correction_requests WHERE source_system='ERP' AND location_info='cnt-5'`);
    assert.strictEqual(hDefaults.closure_type, 'normal', `closure_type 默认应 normal，实际 ${hDefaults.closure_type}`);
    assert.strictEqual(hDefaults.relay_notify_status, 'not_sent', `relay_notify_status 默认应 not_sent，实际 ${hDefaults.relay_notify_status}`);
    assert.strictEqual(hDefaults.relay_read_at, null, 'relay_read_at 默认应 NULL');
    ok('H 预置字段默认值：closure_type=normal / relay_notify_status=not_sent / relay_read_at=NULL');

    // [8] 9 态枚举全部可写（schema 不限制枚举，后端集中校验；暂缓方案 v1.1 新增 SUSPENDED）
    for (let i = 0; i < CORRECTION_STATUSES.length; i++) {
        await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, status) VALUES ('CRM', 'loc${i}', '业务李', 1, ?)`, [CORRECTION_STATUSES[i]]);
    }
    const stCount = await get(`SELECT COUNT(DISTINCT status) AS c FROM correction_requests WHERE source_system='CRM'`);
    assert.strictEqual(stCount.c, CORRECTION_STATUSES.length, `9 态应全部可写，实际 ${stCount.c}`);
    ok(`9 态全部可写入（schema 不挡合法态，枚举校验归后端写入口）`);

    // [9] 软删过滤契约（G-14/L-3）：列表默认 WHERE voided_at IS NULL 只见未作废单
    await run(`UPDATE correction_requests SET voided_at=datetime('now','localtime'), void_reason='误建' WHERE source_system='BMS'`);
    const visible = await get(`SELECT COUNT(*) AS c FROM correction_requests WHERE voided_at IS NULL`);
    const voided = await get(`SELECT COUNT(*) AS c FROM correction_requests WHERE voided_at IS NOT NULL`);
    assert.strictEqual(voided.c, 1, `应有 1 作废单，实际 ${voided.c}`);
    assert.ok(visible.c >= CORRECTION_STATUSES.length, '未作废列表应仍含 9 态测试单');
    const stillExists = await get(`SELECT id, void_reason FROM correction_requests WHERE source_system='BMS'`);
    assert.ok(stillExists && stillExists.void_reason === '误建', '作废单应物理存在（软删不删行）');
    ok(`软删契约：voided_at 标记不物理删，列表 WHERE voided_at IS NULL 过滤掉作废单`);

    // [10] 附件表 uploaded_by NOT NULL（R-3 归属责任链）
    const rid = (await get(`SELECT id FROM correction_requests WHERE source_system='CRM' LIMIT 1`)).id;
    await assert.rejects(run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name) VALUES (?, 'fix_proof', 'proof.png')`, [rid]), /NOT NULL|constraint/i, 'uploaded_by NOT NULL 未生效');
    ok('附件表 NOT NULL：fix_proof 缺 uploaded_by 被拒（R-3 归属责任链强制）');

    // [11] 合法附件写入（error_proof / fix_proof 两类型）
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'error_proof', 'err.png', 1, '业务张')`, [rid]);
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', 'fix.png', 5, '开发王')`, [rid]);
    const attCount = await get(`SELECT COUNT(*) AS c FROM correction_attachments WHERE correction_request_id=?`, [rid]);
    assert.strictEqual(attCount.c, 2, `应有 2 附件，实际 ${attCount.c}`);
    ok('附件表：error_proof + fix_proof 两类型可写（uploaded_by 非空）');

    // [12] 合规 fix_proof 闸门 SQL 契约（H-2/R-2）基础过滤
    const fixProofCount = await get(`SELECT COUNT(*) AS c FROM correction_attachments WHERE correction_request_id=? AND attachment_type='fix_proof' AND uploaded_by IS NOT NULL`, [rid]);
    assert.strictEqual(fixProofCount.c, 1, `合规 fix_proof（本单+类型+非空）应 1 条，实际 ${fixProofCount.c}`);
    ok('闸门 SQL 契约：合规 fix_proof 基础过滤（本单+fix_proof+uploaded_by 非空）成立');

    // [13] 状态历史表 append-only：from_status 首次可 NULL + to_status NOT NULL
    await assert.rejects(run(`INSERT INTO correction_status_history (correction_request_id, from_status) VALUES (?, 'PENDING_ASSIGN')`, [rid]), /NOT NULL|constraint/i, 'to_status NOT NULL 未生效');
    ok('历史表 NOT NULL：to_status 缺失被拒');
    await run(`INSERT INTO correction_status_history (correction_request_id, from_status, to_status, operator_id, operator_name) VALUES (?, NULL, 'PENDING_ASSIGN', 1, '系统')`, [rid]);
    await run(`INSERT INTO correction_status_history (correction_request_id, from_status, to_status, reason, operator_id, operator_name) VALUES (?, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', '指派开发王', 1, 'admin')`, [rid]);
    const histRows = await all(`SELECT from_status, to_status FROM correction_status_history WHERE correction_request_id=? ORDER BY id`, [rid]);
    assert.strictEqual(histRows.length, 2, '应有 2 条历史');
    assert.strictEqual(histRows[0].from_status, null, '首条 from_status 应为 NULL');
    ok('历史表 append-only：首次 from_status=NULL 合法 + reason 可记流转说明');

    // [14] 积压筛选口径契约（L-3）：status IN ('FIXED','REFIXED') AND voided_at IS NULL，起点 COALESCE(refixed_at, fixed_at)
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, status, fixed_at) VALUES ('HRD', 'fixed单', '业务赵', 1, 'FIXED', '2026-06-10 10:00')`);
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, status, fixed_at, refixed_at) VALUES ('HRD', 'refixed单', '业务赵', 1, 'REFIXED', '2026-06-09 10:00', '2026-06-11 15:00')`);
    const backlog = await all(`SELECT location_info, COALESCE(refixed_at, fixed_at) AS backlog_since FROM correction_requests WHERE status IN ('FIXED','REFIXED') AND voided_at IS NULL AND source_system='HRD' ORDER BY location_info`);
    assert.strictEqual(backlog.length, 2, `积压（HRD 隔离）应 2 单，实际 ${backlog.length}`);
    assert.strictEqual(backlog.find(b => b.location_info === 'fixed单').backlog_since, '2026-06-10 10:00', 'FIXED 单起点取 fixed_at');
    assert.strictEqual(backlog.find(b => b.location_info === 'refixed单').backlog_since, '2026-06-11 15:00', 'REFIXED 单起点取 refixed_at（COALESCE 优先 refixed_at）');
    ok(`积压筛选契约（L-3）：status IN(FIXED,REFIXED) + voided_at IS NULL，起点 COALESCE(refixed_at, fixed_at) 正确`);

    // [15] FK 定义正确性（codex 08 L-2，测试期）：附件/历史插入不存在 request_id 被 FK 拒
    await assert.rejects(run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by) VALUES (999999, 'fix_proof', 'orphan.png', 5)`), /FOREIGN KEY|constraint/i, '附件 FK 未拦截孤儿引用');
    await assert.rejects(run(`INSERT INTO correction_status_history (correction_request_id, to_status) VALUES (999999, 'PENDING_ASSIGN')`), /FOREIGN KEY|constraint/i, '历史 FK 未拦截孤儿引用');
    ok(`FK 定义正确（L-2，测试期）：附件/历史插入不存在 request_id 被 FK 拒（生产未启用 FK，仅结构声明）`);

    console.log(`\n[全部通过] ${passed}/${passed} ✓ correction schema 验证通过【J3 require 真实 initSchema，非复刻 DDL】（三表 + 9 态字段（含暂缓方案 v1.1 SUSPENDED）+ 5 群字段 + NOT NULL + CHECK + 软删过滤 + 闸门/积压 SQL 契约 + FK 定义）`);
    db.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); db.close(); process.exit(1); });
