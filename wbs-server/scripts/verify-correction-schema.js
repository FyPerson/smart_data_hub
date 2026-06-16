// 验证脚本：数据修正模块 Commit A — correction 三表 schema（8 态全字段 + 5 群字段 + NOT NULL + 索引）
// 方案：docs/local/数据修正/数据修正模块_方案_20260612_v1.3.md §2 / §9b（schema 层）
// 用法：node scripts/verify-correction-schema.js
// 模式：临时内存 sqlite，复刻 server.js Commit A DDL，验证表/字段/索引/NOT NULL/软删过滤/闸门 SQL 契约。
//   不碰生产 db。范式对齐 verify-collab-quality-v2-schema.js。
//
// ⚠️ 覆盖边界（Commit A 只验 schema 不变量）：§9b 里"直接改 status 被拒/并发双提交只成功一次/
//   枚举校验被拒"等依赖 correctionTransition（Commit B）与后端写入口（B/C/D），属流程层，
//   挪到 Commit G 的 verify-correction-flow.js。本脚本只验 A 阶段建表后立即可断言的 schema 事实。
//
// ⚠️ DDL 双份局限（codex 08 M-2，已知边界）：本脚本复刻了一份 DDL 常量（DDL_CORRECTION_*），
//   而非 require server.js（server.js 顶层 app.listen，require 会起服务占端口）。因此本脚本验的是
//   "脚本自己的理想 DDL"，若 server.js 真实 DDL 与此漂移（漏字段/默认值写错/NOT NULL 不一致），
//   本脚本不一定能发现。缓解：① 修改 server.js correction DDL 时必须同步本文件的 DDL_CORRECTION_*；
//   ② REQ_KEY_COLS 字段集合与 server.js 建表保持人工对齐。彻底同源（解析 server.js DDL 比对）
//   留待全模块完成后评估，不在 Commit A 范围。
const assert = require('assert');
const sqlite3 = require('sqlite3');

const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) =>
    db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) =>
    db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) =>
    db.get(sql, params, (e, row) => e ? rej(e) : res(row)));

// === 与 server.js Commit A 同步的三表 DDL（initTable serialize 块）===
const DDL_CORRECTION_REQUESTS = `CREATE TABLE IF NOT EXISTS correction_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_system TEXT NOT NULL,
    source_system_other TEXT,
    location_info TEXT NOT NULL,
    correction_count INTEGER CHECK (correction_count IS NULL OR (typeof(correction_count) = 'integer' AND correction_count >= 1)),
    reason TEXT,
    oa_number TEXT,
    correction_type TEXT NOT NULL DEFAULT 'single',
    requester_dept TEXT,
    requester_name TEXT NOT NULL,
    requester_phone TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING_ASSIGN',
    expected_deadline DATETIME,
    dev_estimated_at DATETIME,
    assigned_to INTEGER,
    assigned_to_name TEXT,
    assigned_by INTEGER,
    assigned_at DATETIME,
    batch_completion_note TEXT,
    submission_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    estimated_replied_at DATETIME,
    fixed_at DATETIME,
    refixed_at DATETIME,
    completion_notified_at DATETIME,
    completion_notify_status TEXT DEFAULT 'not_sent',
    completion_notify_message_key TEXT,
    completion_notify_error TEXT,
    completion_read_at DATETIME,
    relay_notified_user_id INTEGER,
    relay_notified_at DATETIME,
    relay_notify_status TEXT DEFAULT 'not_sent',
    relay_notify_message_key TEXT,
    relay_notify_error TEXT,
    relay_read_at DATETIME,
    archived_at DATETIME,
    archived_by INTEGER,
    archived_by_name TEXT,
    friction_reason TEXT,
    closure_type TEXT DEFAULT 'normal',
    closure_reason TEXT,
    voided_at DATETIME,
    voided_by INTEGER,
    voided_by_name TEXT,
    void_reason TEXT,
    created_by INTEGER NOT NULL,
    created_by_name TEXT,
    rejected_at DATETIME,
    rejected_by INTEGER,
    rejected_by_name TEXT,
    reject_reason TEXT,
    notify_status TEXT DEFAULT 'not_sent',
    notified_at DATETIME,
    notify_message_key TEXT,
    notify_error TEXT,
    read_at DATETIME,
    requester_notify_status TEXT DEFAULT 'not_sent',
    requester_notified_at DATETIME,
    requester_notify_message_key TEXT,
    requester_notify_error TEXT,
    requester_read_at DATETIME,
    dingtalk_chat_id TEXT,
    dingtalk_open_conversation_id TEXT,
    dingtalk_chat_created_at DATETIME,
    dingtalk_chat_created_by INTEGER,
    dingtalk_chat_name TEXT
)`;
const DDL_CORRECTION_ATTACHMENTS = `CREATE TABLE IF NOT EXISTS correction_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    correction_request_id INTEGER NOT NULL,
    attachment_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    original_name TEXT,
    file_size INTEGER,
    mime_type TEXT,
    uploaded_by INTEGER NOT NULL,
    uploaded_by_name TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (correction_request_id) REFERENCES correction_requests(id)
)`;
const DDL_CORRECTION_HISTORY = `CREATE TABLE IF NOT EXISTS correction_status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    correction_request_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    operator_id INTEGER,
    operator_name TEXT,
    created_at DATETIME DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (correction_request_id) REFERENCES correction_requests(id)
)`;
const CORRECTION_INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_corr_status ON correction_requests(status)`,
    `CREATE INDEX IF NOT EXISTS idx_corr_assigned ON correction_requests(assigned_to)`,
    `CREATE INDEX IF NOT EXISTS idx_corr_created_by ON correction_requests(created_by)`,
    `CREATE INDEX IF NOT EXISTS idx_corr_dev_estimated ON correction_requests(dev_estimated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_corr_voided ON correction_requests(voided_at)`,
    `CREATE INDEX IF NOT EXISTS idx_corr_att_rid ON correction_attachments(correction_request_id)`,
    `CREATE INDEX IF NOT EXISTS idx_corr_hist_rid ON correction_status_history(correction_request_id)`,
];

// correction_requests 关键列子集（§9b schema 层断言用）。
//   ⚠️ codex 08 M-3：这不是 §2 的 62 列"全集"——刻意不含纯可空辅助列（notify_message_key/error、
//   *_by_name、*_read_at、*_notified_at 等），它们存在性验证价值低（缺失也不影响 Commit A 不变量）。
//   全集校验意义有限（DDL 双份局限见文件头 M-2）；本清单聚焦"有约束/有业务语义"的关键列。
//   下方 [2c] 对真正有约束的列（NOT NULL/默认值）单独断言，比堆全集更有效。
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
// 8 态枚举（后端集中校验用，schema 层验"能写进去"+ 默认值）
const CORRECTION_STATUSES = [
    'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', 'IN_PROGRESS', 'FIXED', 'REFIXED',
    'ARCHIVED', 'REJECTED', 'VOIDED',
];

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

async function main() {
    // codex 08 L-2：开启 FK 强制（SQLite 默认 OFF）。
    //   ⚠️ 边界声明：生产 server.js **未**启用 foreign_keys（FK 在生产运行期不强制，仅作结构声明）。
    //   本脚本启用 FK 仅为测试"三表 FOREIGN KEY 定义是否拼对"（防 FK 列名笔误），不代表生产强制级联。
    await run('PRAGMA foreign_keys = ON');
    await run(DDL_CORRECTION_REQUESTS);
    await run(DDL_CORRECTION_ATTACHMENTS);
    await run(DDL_CORRECTION_HISTORY);
    for (const idx of CORRECTION_INDEXES) await run(idx);
    ok('三表 + 7 索引建立成功（FK 强制已开，仅测试期验 FK 定义正确性）');

    // [1] 三表存在
    const tables = (await all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('correction_requests','correction_attachments','correction_status_history')"
    )).map(r => r.name);
    assert.strictEqual(tables.length, 3, `应有 3 表，实际 ${tables.length}: ${tables.join(',')}`);
    ok(`三表存在：${tables.sort().join(' / ')}`);

    // [2] correction_requests 关键列齐全（含 5 群字段 + 通知 + 责任链锚点；非 §2 全集，见 REQ_KEY_COLS 注释）
    const colRows = await all('PRAGMA table_info(correction_requests)');
    const cols = colRows.map(r => r.name);
    const missing = REQ_KEY_COLS.filter(c => !cols.includes(c));
    assert.strictEqual(missing.length, 0, `主表关键列缺失: ${missing.join(',')}`);
    ok(`correction_requests 关键列齐全（${REQ_KEY_COLS.length} 列含 8 态/5 群/通知/责任链锚点）`);

    // [2c] codex 08 M-3：对有 NOT NULL 约束的核心列单独断言 notnull=1（比堆全集更有效）。
    //   方案 §2 主表 NOT NULL 列（v1.81.0 复审优化 H：删 expected_value，location_info 语义改"修正方式"）：
    //   source_system/location_info（修正方式）/requester_name/created_by/status/correction_type（其余可空，不强约束）。
    const REQ_NOTNULL_COLS = ['source_system', 'location_info',
        'requester_name', 'created_by', 'status', 'correction_type'];
    const notNullBroken = REQ_NOTNULL_COLS.filter(c => {
        const def = colRows.find(x => x.name === c);
        return !def || def.notnull !== 1;
    });
    assert.strictEqual(notNullBroken.length, 0, `主表 NOT NULL 约束缺失/未生效: ${notNullBroken.join(',')}`);
    ok(`主表 6 个核心列 NOT NULL 约束生效（source_system/location_info/requester_name/created_by/status/correction_type）`);

    // [3] 5 个钉钉群字段单列断言（旁路字段，G-6 不走 transition）
    const chatCols = ['dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at',
        'dingtalk_chat_created_by', 'dingtalk_chat_name'];
    assert.ok(chatCols.every(c => cols.includes(c)), '5 群字段应全在');
    ok(`5 个 dingtalk_chat_* 群字段齐全（旁路 UPDATE 不动 status）`);

    // [4] 关键索引存在（含 idx_corr_voided 支撑软删过滤）
    const idxRows = (await all(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_corr%'"
    )).map(r => r.name);
    const missingIdx = EXPECTED_INDEXES.filter(i => !idxRows.includes(i));
    assert.strictEqual(missingIdx.length, 0, `索引缺失: ${missingIdx.join(',')}`);
    ok(`7 索引齐全（含 idx_corr_voided 支撑列表 voided_at IS NULL 过滤）`);

    // [5] NOT NULL 生效：created_by 缺失 → 拒（R-3/M-2 责任链/可见性锚点）
    await assert.rejects(
        run(`INSERT INTO correction_requests (source_system, location_info, requester_name)
             VALUES ('BMS', 'loc', '业务张')`),
        /NOT NULL|constraint/i, 'created_by NOT NULL 未生效');
    ok('NOT NULL：建单缺 created_by 被拒（可见性/权限锚点强制）');

    // [6] NOT NULL 生效：核心需求字段缺失 → 拒（location_info/source_system/requester_name）
    await assert.rejects(
        run(`INSERT INTO correction_requests (source_system, requester_name, created_by)
             VALUES ('BMS', '业务张', 1)`),
        /NOT NULL|constraint/i, 'location_info NOT NULL 未生效');
    ok('NOT NULL：缺 location_info（修正方式）被拒（核心需求字段强制非空）');

    // [7] 合法建单成功 + status 默认 PENDING_ASSIGN + correction_type 默认 single + submission_count 默认 0
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by)
               VALUES ('BMS', '合同表#123 金额错，应为 100', '业务张', 1)`);
    const r1 = await get(`SELECT status, correction_type, submission_count, completion_notify_status, notify_status, requester_notify_status, voided_at
                          FROM correction_requests WHERE source_system='BMS'`);
    assert.strictEqual(r1.status, 'PENDING_ASSIGN', `status 默认应 PENDING_ASSIGN，实际 ${r1.status}`);
    assert.strictEqual(r1.correction_type, 'single', `correction_type 默认应 single，实际 ${r1.correction_type}`);
    assert.strictEqual(r1.submission_count, 0, `submission_count 默认应 0，实际 ${r1.submission_count}`);
    assert.strictEqual(r1.completion_notify_status, 'not_sent', 'completion_notify_status 默认 not_sent');
    assert.strictEqual(r1.notify_status, 'not_sent', 'notify_status 默认 not_sent');
    assert.strictEqual(r1.requester_notify_status, 'not_sent', 'requester_notify_status 默认 not_sent');
    assert.strictEqual(r1.voided_at, null, '新建单 voided_at 应为 NULL（未作废）');
    ok(`默认值：status=PENDING_ASSIGN / type=single / count=0 / 三通知 not_sent / voided_at=NULL`);

    // [7b] v1.81.0 复审优化 H 新增字段：correction_count CHECK（RC-L2）+ closure_type/relay_notify_status 默认值
    //   用 ERP 系统隔离，避免污染 [9] 软删（BMS）/ [14] 积压（HRD）计数
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count)
               VALUES ('ERP', 'cnt-null', '业务张', 1, NULL)`);
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count)
               VALUES ('ERP', 'cnt-5', '业务张', 1, 5)`);
    await assert.rejects(
        run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count)
             VALUES ('ERP', 'cnt-0', '业务张', 1, 0)`),
        /CHECK|constraint/i, 'correction_count=0 应被 CHECK 拒');
    await assert.rejects(
        run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count)
             VALUES ('ERP', 'cnt-neg', '业务张', 1, -3)`),
        /CHECK|constraint/i, 'correction_count=-3 应被 CHECK 拒');
    await assert.rejects(
        run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, correction_count)
             VALUES ('ERP', 'cnt-real', '业务张', 1, 1.5)`),
        /CHECK|constraint/i, 'correction_count=1.5（REAL）应被 typeof CHECK 拒（codex24 M-2）');
    ok('correction_count CHECK（RC-L2 + codex24 M-2）：NULL/正整数可写，0/负数/1.5(REAL) 被拒');

    // [7c] correction_count 后端正则口径自检（codex 24 M-1）：复刻 server.js POST /api/corrections 的
    //   /^[1-9]\d{0,8}$/（endpoint 先 String().trim() 再测）。⚠️ 此正则须与 server.js endpoint 同步。
    const COUNT_RE = /^[1-9]\d{0,8}$/;
    const norm = (s) => String(s).trim();
    const shouldReject = ['5.0', '1e3', '0x10', '0', '-3', '01', '1234567890', 'abc'];
    const shouldAccept = ['1', '5', '999999999', '100', ' 5 '];
    const wrongPass = shouldReject.filter(s => COUNT_RE.test(norm(s)));
    const wrongReject = shouldAccept.filter(s => !COUNT_RE.test(norm(s)));
    assert.strictEqual(wrongPass.length, 0, `correction_count 正则应拒却通过: ${wrongPass.join(',')}`);
    assert.strictEqual(wrongReject.length, 0, `correction_count 正则应放行却拒: ${wrongReject.join(',')}`);
    ok('correction_count 后端正则口径自检（M-1）：拒 5.0/1e3/0x10/0/前导0/10位/非数字，放行 1-999999999（trim 后）');
    const hDefaults = await get(`SELECT closure_type, relay_notify_status, relay_read_at FROM correction_requests WHERE source_system='ERP' AND location_info='cnt-5'`);
    assert.strictEqual(hDefaults.closure_type, 'normal', `closure_type 默认应 normal，实际 ${hDefaults.closure_type}`);
    assert.strictEqual(hDefaults.relay_notify_status, 'not_sent', `relay_notify_status 默认应 not_sent，实际 ${hDefaults.relay_notify_status}`);
    assert.strictEqual(hDefaults.relay_read_at, null, 'relay_read_at 默认应 NULL');
    ok('H 预置字段默认值：closure_type=normal / relay_notify_status=not_sent / relay_read_at=NULL');

    // [8] 8 态枚举全部可写（schema 不限制枚举，后端集中校验——此处验"建表不挡任何合法态"）
    for (let i = 0; i < CORRECTION_STATUSES.length; i++) {
        const st = CORRECTION_STATUSES[i];
        await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, status)
                   VALUES ('CRM', 'loc${i}', '业务李', 1, ?)`, [st]);
    }
    const stCount = await get(`SELECT COUNT(DISTINCT status) AS c FROM correction_requests WHERE source_system='CRM'`);
    assert.strictEqual(stCount.c, CORRECTION_STATUSES.length, `8 态应全部可写，实际 ${stCount.c}`);
    ok(`8 态全部可写入（schema 不挡合法态，枚举校验归后端写入口）`);

    // [9] 软删过滤契约（G-14/L-3）：列表默认 WHERE voided_at IS NULL 只见未作废单
    //     造 1 作废单 + 已有未作废单，验证两种列表口径
    await run(`UPDATE correction_requests SET voided_at=datetime('now','localtime'), void_reason='误建' WHERE source_system='BMS'`);
    const visible = await get(`SELECT COUNT(*) AS c FROM correction_requests WHERE voided_at IS NULL`);
    const voided = await get(`SELECT COUNT(*) AS c FROM correction_requests WHERE voided_at IS NOT NULL`);
    assert.strictEqual(voided.c, 1, `应有 1 作废单，实际 ${voided.c}`);
    assert.ok(visible.c >= CORRECTION_STATUSES.length, '未作废列表应仍含 8 态测试单');
    // 软删不物理删：作废单仍在表里（voided_at 标记），未被 DELETE
    const stillExists = await get(`SELECT id, void_reason FROM correction_requests WHERE source_system='BMS'`);
    assert.ok(stillExists && stillExists.void_reason === '误建', '作废单应物理存在（软删不删行）');
    ok(`软删契约：voided_at 标记不物理删，列表 WHERE voided_at IS NULL 过滤掉作废单`);

    // [10] 附件表 uploaded_by NOT NULL（R-3 归属责任链）
    const rid = (await get(`SELECT id FROM correction_requests WHERE source_system='CRM' LIMIT 1`)).id;
    await assert.rejects(
        run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name)
             VALUES (?, 'fix_proof', 'proof.png')`, [rid]),
        /NOT NULL|constraint/i, 'uploaded_by NOT NULL 未生效');
    ok('附件表 NOT NULL：fix_proof 缺 uploaded_by 被拒（R-3 归属责任链强制）');

    // [11] 合法附件写入（error_proof / fix_proof 两类型）
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name)
               VALUES (?, 'error_proof', 'err.png', 1, '业务张')`, [rid]);
    await run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by, uploaded_by_name)
               VALUES (?, 'fix_proof', 'fix.png', 5, '开发王')`, [rid]);
    const attCount = await get(`SELECT COUNT(*) AS c FROM correction_attachments WHERE correction_request_id=?`, [rid]);
    assert.strictEqual(attCount.c, 2, `应有 2 附件，实际 ${attCount.c}`);
    ok('附件表：error_proof + fix_proof 两类型可写（uploaded_by 非空）');

    // [12] 合规 fix_proof 闸门 SQL 契约（H-2/R-2）：uploaded_by=assigned_to OR users.role='admin'
    //     纯 SQL 契约验证（不依赖 users 表 join，只验"本单 + fix_proof + uploaded_by 非空"基础过滤可用）。
    //     完整 join users 的角色判定归 Commit C 标完成闸门 + Commit G flow 层。
    const fixProofCount = await get(
        `SELECT COUNT(*) AS c FROM correction_attachments
         WHERE correction_request_id=? AND attachment_type='fix_proof' AND uploaded_by IS NOT NULL`, [rid]);
    assert.strictEqual(fixProofCount.c, 1, `合规 fix_proof（本单+类型+非空）应 1 条，实际 ${fixProofCount.c}`);
    ok('闸门 SQL 契约：合规 fix_proof 基础过滤（本单+fix_proof+uploaded_by 非空）成立');

    // [13] 状态历史表 append-only：from_status 首次可 NULL + to_status NOT NULL
    await assert.rejects(
        run(`INSERT INTO correction_status_history (correction_request_id, from_status) VALUES (?, 'PENDING_ASSIGN')`, [rid]),
        /NOT NULL|constraint/i, 'to_status NOT NULL 未生效');
    ok('历史表 NOT NULL：to_status 缺失被拒');
    // 首次流转 from_status=NULL 合法
    await run(`INSERT INTO correction_status_history (correction_request_id, from_status, to_status, operator_id, operator_name)
               VALUES (?, NULL, 'PENDING_ASSIGN', 1, '系统')`, [rid]);
    await run(`INSERT INTO correction_status_history (correction_request_id, from_status, to_status, reason, operator_id, operator_name)
               VALUES (?, 'PENDING_ASSIGN', 'ASSIGNED_PENDING_ESTIMATE', '指派开发王', 1, 'admin')`, [rid]);
    const histRows = await all(`SELECT from_status, to_status FROM correction_status_history WHERE correction_request_id=? ORDER BY id`, [rid]);
    assert.strictEqual(histRows.length, 2, '应有 2 条历史');
    assert.strictEqual(histRows[0].from_status, null, '首条 from_status 应为 NULL');
    ok('历史表 append-only：首次 from_status=NULL 合法 + reason 可记流转说明');

    // [14] 积压筛选口径契约（L-3）：status IN ('FIXED','REFIXED') AND voided_at IS NULL，起点 COALESCE(refixed_at, fixed_at)
    //     造一个 FIXED 单（有 fixed_at）+ 一个 REFIXED 单（有 refixed_at），验 COALESCE 起点正确
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, status, fixed_at)
               VALUES ('HRD', 'fixed单', '业务赵', 1, 'FIXED', '2026-06-10 10:00')`);
    await run(`INSERT INTO correction_requests (source_system, location_info, requester_name, created_by, status, fixed_at, refixed_at)
               VALUES ('HRD', 'refixed单', '业务赵', 1, 'REFIXED', '2026-06-09 10:00', '2026-06-11 15:00')`);
    // 限定 source_system='HRD' 隔离本步数据（[8] 往 CRM 写过 FIXED/REFIXED 态测试单，会干扰全表积压计数；
    //   积压查询口径本身不带 source_system，此处仅为测试隔离——口径契约由 status/voided_at/COALESCE 三段验证）
    const backlog = await all(
        `SELECT location_info, COALESCE(refixed_at, fixed_at) AS backlog_since
         FROM correction_requests
         WHERE status IN ('FIXED','REFIXED') AND voided_at IS NULL AND source_system='HRD'
         ORDER BY location_info`);
    assert.strictEqual(backlog.length, 2, `积压（HRD 隔离）应 2 单，实际 ${backlog.length}`);
    const fixedItem = backlog.find(b => b.location_info === 'fixed单');
    const refixedItem = backlog.find(b => b.location_info === 'refixed单');
    assert.strictEqual(fixedItem.backlog_since, '2026-06-10 10:00', 'FIXED 单起点取 fixed_at');
    assert.strictEqual(refixedItem.backlog_since, '2026-06-11 15:00', 'REFIXED 单起点取 refixed_at（COALESCE 优先 refixed_at）');
    ok(`积压筛选契约（L-3）：status IN(FIXED,REFIXED) + voided_at IS NULL，起点 COALESCE(refixed_at, fixed_at) 正确`);

    // [15] codex 08 L-2：FK 定义正确性（附件/历史必须归属已有 request）。FK 已在脚本头 PRAGMA ON。
    //   插入不存在的 correction_request_id=999999 → 应被 FK 拒（证明 FOREIGN KEY 列名拼对、引用对）。
    await assert.rejects(
        run(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, uploaded_by)
             VALUES (999999, 'fix_proof', 'orphan.png', 5)`),
        /FOREIGN KEY|constraint/i, '附件 FK 未拦截孤儿引用（FK 定义可能拼错或未启用）');
    await assert.rejects(
        run(`INSERT INTO correction_status_history (correction_request_id, to_status)
             VALUES (999999, 'PENDING_ASSIGN')`),
        /FOREIGN KEY|constraint/i, '历史 FK 未拦截孤儿引用');
    ok(`FK 定义正确（L-2，测试期）：附件/历史插入不存在 request_id 被 FK 拒（生产未启用 FK，仅结构声明）`);

    console.log(`\n[全部通过] ${passed}/${passed} ✓ Commit A correction schema 验证通过（三表 + 8 态字段 + 5 群字段 + NOT NULL + 软删过滤 + 闸门/积压 SQL 契约 + FK 定义）`);
    db.close();
}

main().catch(e => { console.error('\n[失败]', e.message); db.close(); process.exit(1); });
