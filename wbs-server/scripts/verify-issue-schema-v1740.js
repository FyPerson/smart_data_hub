/**
 * v1.74.0 需求跟踪 C1 — schema 重建验证脚本（T1 测试集，7 例 + 扩展断言）
 *
 * 用途：本地临时 DB 上验证 C1 建表 SQL 的结构正确性（不碰 task_pool.db）。
 *       即用即留（C7 阶段并入 e2e）；可重复跑。
 *
 * 检查项（方案 §6.2 T1）：
 *   1. 4 张表全部创建成功（issues / issue_comments / issue_attachments / issue_status_history）
 *   2. issues 表字段齐全（41 字段，逐字段核对关键列；含 v1.74.0 C1 fix 补 acceptance_url）
 *   3. 索引正确（issues 4 + comments 1 + attachments 1 + status_history 1 = 7 个）
 *   4. CHECK priority 约束生效（拒非法 priority）
 *   5. CHECK status 约束生效（拒非法 status，含新 2 态合法）
 *   6. CHECK notify_status / requester_notify_status 约束生效（含 NOT NULL，codex 06 M-2/L-1）
 *   7. FK 子句存在（issue_comments/attachments/status_history → issues ON DELETE CASCADE）
 *
 * 注：本项目未开 PRAGMA foreign_keys=ON（对齐 collab 范式），CASCADE 实际由 DELETE endpoint
 *     显式删子表实现；本脚本仅验证建表 SQL 的 FK 子句声明存在（sqlite_master DDL 文本断言）。
 * ⚠️ 本脚本的 DDL 是 server.js initTable 内 issues 建表块的副本，server.js DDL 变更时需同步本文件。
 */

'use strict';

const sqlite3 = require('sqlite3').verbose();

// 临时内存 DB（隔离，不碰 task_pool.db）
const db = new sqlite3.Database(':memory:');

let exitCode = 0;
const results = [];

function assert(cond, name, detail) {
    if (cond) {
        results.push(`✅ ${name}`);
    } else {
        results.push(`❌ ${name}${detail ? ' — ' + detail : ''}`);
        exitCode = 1;
    }
}

function run(sql) {
    return new Promise((resolve, reject) => {
        db.run(sql, (err) => (err ? reject(err) : resolve()));
    });
}

function get(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
}

function all(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

// 期望尝试插入失败（CHECK/约束拒绝）→ 返回 true 表示"按预期被拒"
function expectInsertRejected(sql, params = []) {
    return new Promise((resolve) => {
        db.run(sql, params, (err) => resolve(!!err));
    });
}

// ── C1 建表 SQL（与 server.js initTable 内的 issues 块保持一致）──
const DDL = {
    issues: `CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        raw_requirement TEXT DEFAULT '',
        description TEXT DEFAULT '',
        type TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '业务方',
        data_domain TEXT,
        priority TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0','P1','P2','P3')),
        priority_reviewed_at DATETIME,
        status TEXT NOT NULL DEFAULT '待处理'
            CHECK (status IN ('待处理','处理中','待验证','已关闭','已暂缓','已拒绝')),
        requester_dept TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        requester_phone TEXT,
        oa_number TEXT,
        deadline DATE,
        acceptance_url TEXT,
        assigned_to INTEGER,
        assigned_to_name TEXT,
        created_by INTEGER NOT NULL,
        created_by_name TEXT NOT NULL,
        closed_at DATETIME,
        last_transition_reason TEXT,
        notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (notify_status IN ('not_sent','sent','failed')),
        notified_at DATETIME,
        notify_message_key TEXT,
        notify_error TEXT,
        read_at DATETIME,
        requester_notify_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (requester_notify_status IN ('not_sent','sent','failed')),
        requester_notified_at DATETIME,
        requester_notify_message_key TEXT,
        requester_notify_error TEXT,
        requester_read_at DATETIME,
        pending_reassign_from_id INTEGER,
        pending_reassign_from_name TEXT,
        pending_reassign_to_id INTEGER,
        pending_reassign_to_name TEXT,
        reassigned_at DATETIME,
        related_table TEXT,
        error_time DATETIME,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        updated_at DATETIME DEFAULT (datetime('now','localtime'))
    )`,
    comments: `CREATE TABLE issue_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        user_name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    )`,
    attachments: `CREATE TABLE issue_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        file_size INTEGER,
        mime_type TEXT,
        uploaded_by INTEGER NOT NULL,
        uploaded_by_name TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    )`,
    statusHistory: `CREATE TABLE issue_status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        reason TEXT,
        operator_id INTEGER NOT NULL,
        operator_name TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
    )`,
    indexes: [
        `CREATE INDEX idx_issues_status ON issues(status)`,
        `CREATE INDEX idx_issues_assigned ON issues(assigned_to)`,
        `CREATE INDEX idx_issues_type ON issues(type)`,
        `CREATE INDEX idx_issues_deadline ON issues(deadline)`,
        `CREATE INDEX idx_issue_comments_issue ON issue_comments(issue_id)`,
        `CREATE INDEX idx_issue_attachments_issue ON issue_attachments(issue_id)`,
        `CREATE INDEX idx_issue_status_history_issue ON issue_status_history(issue_id, created_at)`,
    ],
};

// issues 表必须存在的关键字段（核对增量字段未漏）
const EXPECTED_ISSUE_COLS = [
    'id', 'title', 'raw_requirement', 'description', 'type', 'source', 'data_domain',
    'priority', 'priority_reviewed_at', 'status',
    'requester_dept', 'requester_name', 'requester_phone', 'oa_number', 'deadline', 'acceptance_url',
    'assigned_to', 'assigned_to_name', 'created_by', 'created_by_name',
    'closed_at', 'last_transition_reason',
    'notify_status', 'notified_at', 'notify_message_key', 'notify_error', 'read_at',
    'requester_notify_status', 'requester_notified_at', 'requester_notify_message_key',
    'requester_notify_error', 'requester_read_at',
    'pending_reassign_from_id', 'pending_reassign_from_name',
    'pending_reassign_to_id', 'pending_reassign_to_name', 'reassigned_at',
    'related_table', 'error_time', 'created_at', 'updated_at',
];

async function main() {
    // ── 建表 ──
    await run(DDL.issues);
    await run(DDL.comments);
    await run(DDL.attachments);
    await run(DDL.statusHistory);
    for (const idx of DDL.indexes) await run(idx);

    // 检查 1：4 张表存在
    const tables = (await all(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
         ('issues','issue_comments','issue_attachments','issue_status_history')`
    )).map(r => r.name).sort();
    assert(tables.length === 4, '检查1 四张表全部创建', `实际: ${tables.join(',')}`);

    // 检查 2：issues 字段齐全
    const cols = (await all(`PRAGMA table_info(issues)`)).map(c => c.name);
    const missing = EXPECTED_ISSUE_COLS.filter(c => !cols.includes(c));
    const extra = cols.filter(c => !EXPECTED_ISSUE_COLS.includes(c));
    assert(missing.length === 0, '检查2 issues 字段齐全（无缺失）', `缺失: ${missing.join(',')}`);
    assert(extra.length === 0, '检查2b issues 无多余字段', `多余: ${extra.join(',')}`);
    assert(cols.length === EXPECTED_ISSUE_COLS.length,
        `检查2c issues 字段数=${EXPECTED_ISSUE_COLS.length}`, `实际 ${cols.length}`);

    // 检查 3：索引齐全（7 个自建索引，排除 sqlite_autoindex）
    const indexes = (await all(
        `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`
    )).map(r => r.name).sort();
    const EXPECTED_IDX = [
        'idx_issue_attachments_issue', 'idx_issue_comments_issue',
        'idx_issue_status_history_issue', 'idx_issues_assigned',
        'idx_issues_deadline', 'idx_issues_status', 'idx_issues_type',
    ];
    const idxMissing = EXPECTED_IDX.filter(i => !indexes.includes(i));
    assert(idxMissing.length === 0, '检查3 索引齐全（7 个）', `缺失: ${idxMissing.join(',')} | 实际: ${indexes.join(',')}`);

    // 检查 4：CHECK priority 约束 — 合法插入成功 + 非法被拒
    const okPriority = await expectInsertRejected(
        `INSERT INTO issues (title,type,priority,status,requester_dept,requester_name,created_by,created_by_name)
         VALUES ('t','数据质量','P9','待处理','其他','张三',1,'admin')`);
    assert(okPriority === true, '检查4 CHECK priority 拒非法值 P9');
    const legalPriority = await expectInsertRejected(
        `INSERT INTO issues (title,type,priority,status,requester_dept,requester_name,created_by,created_by_name)
         VALUES ('t','数据质量','P0','待处理','其他','张三',1,'admin')`);
    assert(legalPriority === false, '检查4b CHECK priority 放行合法值 P0');

    // 检查 5：CHECK status 约束 — 新 2 态合法 + 非法被拒
    const okStatusPaused = await expectInsertRejected(
        `INSERT INTO issues (title,type,status,requester_dept,requester_name,created_by,created_by_name)
         VALUES ('t','数据质量','已暂缓','其他','张三',1,'admin')`);
    assert(okStatusPaused === false, '检查5 CHECK status 放行新态"已暂缓"');
    const okStatusRejected = await expectInsertRejected(
        `INSERT INTO issues (title,type,status,requester_dept,requester_name,created_by,created_by_name)
         VALUES ('t','数据质量','已拒绝','其他','张三',1,'admin')`);
    assert(okStatusRejected === false, '检查5b CHECK status 放行新态"已拒绝"');
    const badStatus = await expectInsertRejected(
        `INSERT INTO issues (title,type,status,requester_dept,requester_name,created_by,created_by_name)
         VALUES ('t','数据质量','瞎填','其他','张三',1,'admin')`);
    assert(badStatus === true, '检查5c CHECK status 拒非法值"瞎填"');

    // 检查 6：CHECK notify_status 约束（非法值被拒）
    const badNotify = await expectInsertRejected(
        `INSERT INTO issues (title,type,status,requester_dept,requester_name,created_by,created_by_name,notify_status)
         VALUES ('t','数据质量','待处理','其他','张三',1,'admin','瞎填')`);
    assert(badNotify === true, '检查6 CHECK notify_status 拒非法值');
    // 检查 6b：CHECK requester_notify_status 镜像约束（codex 06 L-1：补漏）
    const badReqNotify = await expectInsertRejected(
        `INSERT INTO issues (title,type,status,requester_dept,requester_name,created_by,created_by_name,requester_notify_status)
         VALUES ('t','数据质量','待处理','其他','张三',1,'admin','瞎填')`);
    assert(badReqNotify === true, '检查6b CHECK requester_notify_status 拒非法值');
    // 检查 6c：notify_status NOT NULL（codex 06 M-2：显式写 NULL 应被拒，堵 CHECK-NULL 空洞）
    const nullNotify = await expectInsertRejected(
        `INSERT INTO issues (title,type,status,requester_dept,requester_name,created_by,created_by_name,notify_status)
         VALUES ('t','数据质量','待处理','其他','张三',1,'admin',NULL)`);
    assert(nullNotify === true, '检查6c notify_status NOT NULL 拒 NULL');
    const nullReqNotify = await expectInsertRejected(
        `INSERT INTO issues (title,type,status,requester_dept,requester_name,created_by,created_by_name,requester_notify_status)
         VALUES ('t','数据质量','待处理','其他','张三',1,'admin',NULL)`);
    assert(nullReqNotify === true, '检查6d requester_notify_status NOT NULL 拒 NULL');

    // 检查 7：FK 子句声明存在（DDL 文本断言）
    for (const t of ['issue_comments', 'issue_attachments', 'issue_status_history']) {
        const ddl = (await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`, [t])).sql;
        assert(/REFERENCES issues\(id\) ON DELETE CASCADE/.test(ddl),
            `检查7 ${t} FK CASCADE 子句存在`);
    }

    // ── 输出 ──
    console.log('\n══════ v1.74.0 C1 schema 验证（T1）══════');
    results.forEach(r => console.log('  ' + r));
    const pass = results.filter(r => r.startsWith('✅')).length;
    const fail = results.filter(r => r.startsWith('❌')).length;
    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(exitCode === 0 ? '  🎉 C1 schema 全部通过\n' : '  🚫 存在失败项\n');

    db.close();
    process.exit(exitCode);
}

main().catch(e => {
    console.error('验证脚本异常:', e);
    process.exit(1);
});
