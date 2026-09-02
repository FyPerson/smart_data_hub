/**
 * v1.71.0 Commit E submit-export endpoint e2e（方案 §6 + codex 39 取舍审落地）
 *
 * 覆盖（25 例，含 S03 钉钉 80 字截断不影响主流程）：
 *   T1: 当前 exporter 提交 EXPORTING → DONE + export_summary 落库 + supersede 旧 active (v1.72.10)
 *   T2: 不传 export_summary 走 null 路径（可选）
 *   T3: export_summary 空白串 trim 后 null
 *   T4: export_summary 正常字符串落库 + 响应回显
 *   T5: 附件入库 — result_data + screenshot 各 1 active；attachment_type='screenshot'（codex 39 H-3）
 *   T6: 附件 uploaded_by = exporter（codex 39 H-3 区分截图来源依据）
 *   T7: operation_logs SUBMIT_EXPORT reason JSON 完整（含 superseded_attachments + newly_uploaded）
 *   T8: 响应 superseded_attachments 字段（codex 39 L-3 供 Commit F 消费）
 *   T9: sql_validation_status + sql_validation_error 清空（codex 39 M-5）
 *   T10: 权限 — 非 exporter（dev1/admin/contact/publisher）提交 → 403 ONLY_EXPORTER_CAN_SUBMIT
 *   T11: 状态守卫 — PENDING 提交 → 409 INVALID_STATE_FOR_EXPORT_SUBMIT
 *   T12: 状态守卫 — SUBMITTED 提交 → 409 INVALID_STATE_FOR_EXPORT_SUBMIT
 *   T13: 状态守卫 — DONE 提交 → 409 INVALID_STATE_FOR_EXPORT_SUBMIT
 *   T14: 软删除守卫 → 409 PARENT_SOFT_ARCHIVED
 *   T15: 归档锁定守卫 → 409 PARENT_ARCHIVED_LOCKED
 *   T16: 附件缺失 — 缺 result_data → 400 MISSING_REQUIRED_FILES
 *   T17: 附件缺失 — 缺 screenshot → 400 MISSING_REQUIRED_FILES
 *   T18: 附件类型错 — result_data 传 .png → 400 INVALID_RESULT_DATA
 *   T19: 附件类型错 — screenshot 传 .xlsx → 400 INVALID_SCREENSHOT
 *   T20: export_summary > 500 字 → 400 EXPORT_SUMMARY_TOO_LONG
 *   T21: 并发原子性 — 同一单两个 submit-export：1 个 200 + 1 个 409 + log 恰好 1 条
 *   T22: 跨 endpoint 互斥 — submit-export 与 return 并发同 collab_id（mutex 跨 endpoint）
 *   T23: mutex 锁等待证明 — 多独立 collab_id 并发 submit（codex 39 M-6 沿用 Commit D T17 模式）
 *   T24: submission_version 不递增（codex 39 H-1 部分采纳验证）
 *   T25: export_summary > 80 字落库完整 + 响应回显完整（方案 §7.4 S03 钉钉模板截断不影响主流程）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

const createdFixtureIds = [];

// 复用 forward / return e2e 的 EXPORTER fake ding uid 处理（codex 36 审 L-2）
let _exporterOriginalDingUid = undefined;
let _exporterDingUidModified = false;
async function ensureExporterFakeDingUid() {
    if (_exporterOriginalDingUid === undefined) {
        const row = await dbGet(`SELECT dingtalk_user_id FROM users WHERE id=?`, [fx.EXPORTER_ID]);
        _exporterOriginalDingUid = row ? row.dingtalk_user_id : null;
    }
    if (!_exporterDingUidModified) {
        await dbRun(
            `UPDATE users SET dingtalk_user_id = COALESCE(dingtalk_user_id, ?) WHERE id = ?`,
            ['__fake_ding_uid_for_e2e__', fx.EXPORTER_ID]
        );
        _exporterDingUidModified = true;
    }
}
async function restoreExporterDingUid() {
    if (!_exporterDingUidModified) return;
    await dbRun(`UPDATE users SET dingtalk_user_id = ? WHERE id = ?`, [_exporterOriginalDingUid, fx.EXPORTER_ID]);
    _exporterDingUidModified = false;
}

let testTmpDir = null;
function makeTmpFile(filename, content) {
    if (!testTmpDir) testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-submit-export-test-'));
    const p = path.join(testTmpDir, filename);
    fs.writeFileSync(p, content);
    return p;
}

async function apiCall(method, urlPath, token, body) {
    const opts = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

/**
 * multipart 提交 submit-export（result_data + result_data_screenshot + 可选 export_summary）
 * options:
 *   - dataExt: '.xlsx' / '.xls' / '.png'（错类型测试）；默认 .xlsx
 *   - shotExt: '.png' / '.jpg' / '.xlsx'（错类型测试）；默认 .png
 *   - skipData: 不传 result_data
 *   - skipShot: 不传 result_data_screenshot
 *   - exportSummary: 可选字符串
 * 注：100MB result_data / 10MB screenshot 大小边界用例未实现（codex 40 审 L-3 部分采纳：列 v1.72.0+ 候选；
 *     原因是生成 100MB Buffer 会显著拖慢 e2e）
 */
async function postSubmitExport(reqId, token, options = {}) {
    const fd = new FormData();
    const dataExt = options.dataExt || '.xlsx';
    const shotExt = options.shotExt || '.png';

    if (!options.skipData) {
        const dataName = `result${dataExt}`;
        const dataBuf = Buffer.from('e2e result data content ' + Date.now());
        const dataPath = makeTmpFile(dataName, dataBuf);
        const buf = fs.readFileSync(dataPath);
        fd.append('result_data', new Blob([buf]), dataName);
    }
    if (!options.skipShot) {
        const shotName = `screenshot${shotExt}`;
        const shotBuf = Buffer.from('e2e screenshot content ' + Date.now());
        const shotPath = makeTmpFile(shotName, shotBuf);
        const buf = fs.readFileSync(shotPath);
        fd.append('result_data_screenshot', new Blob([buf]), shotName);
    }
    if (options.exportSummary !== undefined) {
        fd.append('export_summary', options.exportSummary);
    }

    const r = await fetch(`${BASE}/api/collab/requests/${reqId}/submit-export`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd
    });
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

function dbRun(sql, params) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(sql, params, function (err) { db.close(); err ? rej(err) : res({ lastID: this.lastID, changes: this.changes }); });
    });
}
function dbGet(sql, params) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(sql, params, (err, row) => { db.close(); err ? rej(err) : res(row); });
    });
}
function dbAll(sql, params) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(DB_PATH);
        db.all(sql, params, (err, rows) => { db.close(); err ? rej(err) : res(rows); });
    });
}

let passed = 0;
let failed = 0;
function assert(cond, label) {
    if (cond) { console.log(`  ✓ ${label}`); passed++; }
    else { console.log(`  ✗ ${label}`); failed++; }
}

/**
 * 造一个 EXPORTING 状态的 fixture（dev1 已转发给 EXPORTER）
 */
async function makeExportingFixture() {
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    await ensureExporterFakeDingUid();
    await dbRun(
        `UPDATE collab_requests SET dingtalk_chat_id = ?, dingtalk_open_conversation_id = ? WHERE id = ?`,
        [`chat_e2e_${Date.now()}_${Math.random()}`, `cidp_e2e_${Date.now()}_${Math.random()}`, ctx.id]
    );
    const forwardRes = await apiCall('POST', `/api/collab/requests/${ctx.id}/forward-to-exporter`, ctx.adminToken, {
        exporter_id: fx.EXPORTER_ID,
        contact_user_ids: [fx.CONTACT_ID]
    });
    if (forwardRes.status !== 200) {
        throw new Error(`fixture forward 失败: ${forwardRes.status} ${JSON.stringify(forwardRes.body)}`);
    }
    return ctx;
}

async function runTests() {
    const publisherToken = await fx.signAs(fx.PUBLISHER_ID);
    const exporterToken = await fx.signAs(fx.EXPORTER_ID);

    console.log('\n=== T1: 当前 exporter 提交 EXPORTING → DONE (v1.72.10) ===');
    {
        const ctx = await makeExportingFixture();
        const res = await postSubmitExport(ctx.id, exporterToken, { exportSummary: '测试提交概要' });
        assert(res.status === 200, `T1 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        assert(res.body && res.body.current_status === 'DONE', `T1 current_status=DONE`);
        const row = await dbGet(`SELECT status, export_summary, done_at, sql_validation_status FROM collab_requests WHERE id=?`, [ctx.id]);
        assert(row.status === 'DONE', `T1 db status=DONE`);
        assert(row.export_summary === '测试提交概要', `T1 db export_summary 落库`);
        assert(row.done_at !== null && row.done_at !== '', `T1 db done_at 已写`);
        assert(row.sql_validation_status === 'admin_closed', `T1 db sql_validation_status='admin_closed' (与 admin-submit-on-behalf 一致)`);
    }

    console.log('\n=== T2: 不传 export_summary 走 null 路径 ===');
    {
        const ctx = await makeExportingFixture();
        const res = await postSubmitExport(ctx.id, exporterToken);
        assert(res.status === 200, `T2 status=200`);
        assert(res.body && res.body.export_summary === null, `T2 响应 export_summary=null`);
        const row = await dbGet(`SELECT export_summary FROM collab_requests WHERE id=?`, [ctx.id]);
        assert(row.export_summary === null, `T2 db export_summary=NULL`);
    }

    console.log('\n=== T3: export_summary 空白串 trim 后 null ===');
    {
        const ctx = await makeExportingFixture();
        const res = await postSubmitExport(ctx.id, exporterToken, { exportSummary: '   ' });
        assert(res.status === 200, `T3 status=200`);
        assert(res.body.export_summary === null, `T3 响应 export_summary=null`);
    }

    console.log('\n=== T4: export_summary 正常字符串落库 + 响应回显 ===');
    {
        const ctx = await makeExportingFixture();
        const summary = '本次导出范围：合同表 2026 Q1 全部 152 字段，按 customer_id 排序';
        const res = await postSubmitExport(ctx.id, exporterToken, { exportSummary: summary });
        assert(res.status === 200, `T4 status=200`);
        assert(res.body.export_summary === summary, `T4 响应回显正确`);
        const row = await dbGet(`SELECT export_summary FROM collab_requests WHERE id=?`, [ctx.id]);
        assert(row.export_summary === summary, `T4 db 落库正确`);
    }

    console.log('\n=== T5: 附件入库 — result_data + screenshot 各 1 active；attachment_type=screenshot（codex 39 H-3）===');
    {
        const ctx = await makeExportingFixture();
        const res = await postSubmitExport(ctx.id, exporterToken);
        assert(res.status === 200, `T5 status=200`);
        const atts = await dbAll(
            `SELECT attachment_type, status, uploaded_by FROM collab_attachments
              WHERE collab_request_id=? AND status='active' ORDER BY attachment_type`,
            [ctx.id]
        );
        assert(atts.length === 2, `T5 active 附件 2 条，got ${atts.length}`);
        const types = atts.map(a => a.attachment_type).sort();
        assert(types[0] === 'result_data' && types[1] === 'screenshot',
            `T5 attachment_type=[result_data, screenshot]（不新增 result_data_screenshot）, got [${types.join(',')}]`);
    }

    console.log('\n=== T6: 附件 uploaded_by = exporter（codex 39 H-3 区分截图来源依据）===');
    {
        const ctx = await makeExportingFixture();
        await postSubmitExport(ctx.id, exporterToken);
        const atts = await dbAll(
            `SELECT attachment_type, uploaded_by FROM collab_attachments WHERE collab_request_id=? AND status='active'`,
            [ctx.id]
        );
        for (const a of atts) {
            assert(a.uploaded_by === fx.EXPORTER_ID,
                `T6 ${a.attachment_type}.uploaded_by=EXPORTER_ID=${fx.EXPORTER_ID}, got ${a.uploaded_by}`);
        }
    }

    console.log('\n=== T7: operation_logs SUBMIT_EXPORT reason JSON 完整 ===');
    {
        const ctx = await makeExportingFixture();
        await postSubmitExport(ctx.id, exporterToken, { exportSummary: '操作概要测试 with audit' });
        const log = await dbGet(
            `SELECT operation_type, operator_id, reason FROM collab_operation_logs
              WHERE collab_request_id=? AND operation_type='SUBMIT_EXPORT'`,
            [ctx.id]
        );
        assert(log && log.operator_id === fx.EXPORTER_ID, `T7 log operator_id=EXPORTER_ID`);
        const r = JSON.parse(log.reason);
        assert(r.exporter_user_id === fx.EXPORTER_ID, `T7 reason.exporter_user_id`);
        assert(r.export_summary === '操作概要测试 with audit', `T7 reason.export_summary 原文落库（不截断）`);
        assert(r.has_summary === true, `T7 reason.has_summary=true`);
        assert(r.summary_length === '操作概要测试 with audit'.length, `T7 reason.summary_length`);
        assert(Array.isArray(r.newly_uploaded) && r.newly_uploaded.length === 2,
            `T7 reason.newly_uploaded 2 条（result_data + screenshot）, got ${r.newly_uploaded ? r.newly_uploaded.length : 'undef'}`);
        assert(Array.isArray(r.superseded_attachments), `T7 reason.superseded_attachments 数组（无旧 active 时为空）`);
    }

    console.log('\n=== T8: 响应 superseded_attachments 字段（codex 39 L-3 供 Commit F 消费）===');
    {
        const ctx = await makeExportingFixture();
        // 首次提交（无旧 active）
        const res1 = await postSubmitExport(ctx.id, exporterToken);
        assert(res1.status === 200, `T8a 首提 200`);
        assert(Array.isArray(res1.body.superseded_attachments) && res1.body.superseded_attachments.length === 0,
            `T8a 首提 superseded_attachments=[] (无旧 active)`);

        // 把状态强制改回 EXPORTING 模拟"return 后再次 forward 后第二次提交"
        await dbRun(`UPDATE collab_requests SET status='EXPORTING' WHERE id=?`, [ctx.id]);
        const res2 = await postSubmitExport(ctx.id, exporterToken);
        assert(res2.status === 200, `T8b 二提 200`);
        assert(res2.body.superseded_attachments.length === 2,
            `T8b 二提 superseded_attachments 2 条（result_data + screenshot 各 1）, got ${res2.body.superseded_attachments.length}`);
        const supTypes = res2.body.superseded_attachments.map(a => a.attachment_type).sort();
        assert(supTypes[0] === 'result_data' && supTypes[1] === 'screenshot',
            `T8b supTypes=[result_data, screenshot], got [${supTypes.join(',')}]`);
        for (const sa of res2.body.superseded_attachments) {
            assert(sa.uploaded_by === fx.EXPORTER_ID, `T8b superseded.uploaded_by=EXPORTER`);
            assert(typeof sa.id === 'number', `T8b superseded.id 数字`);
            assert(typeof sa.original_name === 'string', `T8b superseded.original_name 字符串`);
        }
    }

    console.log('\n=== T9: sql_validation_status 重写为 admin_closed + error 清空（codex 39 M-5；v1.72.10 status 从 NULL 改 admin_closed）===');
    {
        const ctx = await makeExportingFixture();
        // 模拟"之前 dev 走 POST /submit 留下了校验失败"
        await dbRun(
            `UPDATE collab_requests SET sql_validation_status='failed', sql_validation_error='历史 SQL 错误' WHERE id=?`,
            [ctx.id]
        );
        await postSubmitExport(ctx.id, exporterToken);
        const row = await dbGet(`SELECT sql_validation_status, sql_validation_error FROM collab_requests WHERE id=?`, [ctx.id]);
        // v1.72.10：submit-export 写 sql_validation_status='admin_closed'（与 admin-submit-on-behalf 一致）
        // 核心语义不变：旧 failed 不残留，error 清空
        assert(row.sql_validation_status === 'admin_closed', `T9 sql_validation_status 重写为 admin_closed (v1.72.10), got ${row.sql_validation_status}`);
        assert(row.sql_validation_error === null, `T9 sql_validation_error 清空为 NULL, got ${row.sql_validation_error}`);
    }

    console.log('\n=== T10: 非 exporter 提交 → 403 ONLY_EXPORTER_CAN_SUBMIT ===');
    {
        // T10a dev1（本单 developer 但不是 exporter）→ 403
        const ctx1 = await makeExportingFixture();
        const res1 = await postSubmitExport(ctx1.id, ctx1.dev1Token);
        assert(res1.status === 403 && res1.body.code === 'ONLY_EXPORTER_CAN_SUBMIT', `T10a dev1 拒`);
        // T10b admin 提交 → 403（走 admin-submit-on-behalf 兜底）
        const ctx2 = await makeExportingFixture();
        const res2 = await postSubmitExport(ctx2.id, ctx2.adminToken);
        assert(res2.status === 403 && res2.body.code === 'ONLY_EXPORTER_CAN_SUBMIT', `T10b admin 拒`);
        // T10c contact → 403
        const ctx3 = await makeExportingFixture();
        const res3 = await postSubmitExport(ctx3.id, ctx3.contactToken);
        assert(res3.status === 403 && res3.body.code === 'ONLY_EXPORTER_CAN_SUBMIT', `T10c contact 拒`);
        // T10d publisher → 403
        const ctx4 = await makeExportingFixture();
        const res4 = await postSubmitExport(ctx4.id, publisherToken);
        assert(res4.status === 403 && res4.body.code === 'ONLY_EXPORTER_CAN_SUBMIT', `T10d publisher 拒`);
    }

    console.log('\n=== T11: 状态守卫 — PENDING 提交 → 409 ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        // 给 exporter_user_id 写值 + status 留 PENDING
        await dbRun(`UPDATE collab_requests SET exporter_user_id=?, exporter_name='测试' WHERE id=?`, [fx.EXPORTER_ID, ctx.id]);
        const res = await postSubmitExport(ctx.id, exporterToken);
        assert(res.status === 409 && res.body.code === 'INVALID_STATE_FOR_EXPORT_SUBMIT',
            `T11 code=INVALID_STATE_FOR_EXPORT_SUBMIT, got ${res.status}/${res.body && res.body.code}`);
    }

    console.log('\n=== T12: 状态守卫 — SUBMITTED 提交 → 409 ===');
    {
        const ctx = await makeExportingFixture();
        await fx.setCollabState(ctx.id, { status: 'SUBMITTED' });
        const res = await postSubmitExport(ctx.id, exporterToken);
        assert(res.status === 409 && res.body.code === 'INVALID_STATE_FOR_EXPORT_SUBMIT', `T12 SUBMITTED 拒`);
    }

    console.log('\n=== T13: 状态守卫 — DONE 提交 → 409 ===');
    {
        const ctx = await makeExportingFixture();
        await fx.setCollabState(ctx.id, { status: 'DONE' });
        const res = await postSubmitExport(ctx.id, exporterToken);
        assert(res.status === 409 && res.body.code === 'INVALID_STATE_FOR_EXPORT_SUBMIT', `T13 DONE 拒`);
    }

    console.log('\n=== T14: 软删除守卫 → 409 PARENT_SOFT_ARCHIVED ===');
    {
        const ctx = await makeExportingFixture();
        await dbRun(
            `UPDATE collab_requests SET archived_at=?, archived_reason=?, archived_by=? WHERE id=?`,
            [new Date().toISOString(), 'e2e soft archive', 1, ctx.id]
        );
        const res = await postSubmitExport(ctx.id, exporterToken);
        assert(res.status === 409 && res.body.code === 'PARENT_SOFT_ARCHIVED', `T14 code=PARENT_SOFT_ARCHIVED`);
    }

    console.log('\n=== T15: 归档锁定守卫 — status=ARCHIVED → 409 PARENT_ARCHIVED_LOCKED ===');
    {
        const ctx = await makeExportingFixture();
        await fx.setCollabState(ctx.id, { status: 'ARCHIVED' });
        const res = await postSubmitExport(ctx.id, exporterToken);
        assert(res.status === 409 && res.body.code === 'PARENT_ARCHIVED_LOCKED', `T15 code=PARENT_ARCHIVED_LOCKED`);
    }

    console.log('\n=== T16: 附件缺失 — 缺 result_data → 400 MISSING_REQUIRED_FILES ===');
    {
        const ctx = await makeExportingFixture();
        const res = await postSubmitExport(ctx.id, exporterToken, { skipData: true });
        assert(res.status === 400 && res.body.code === 'MISSING_REQUIRED_FILES', `T16 缺 result_data 拒`);
    }

    console.log('\n=== T17: 附件缺失 — 缺 screenshot → 400 MISSING_REQUIRED_FILES ===');
    {
        const ctx = await makeExportingFixture();
        const res = await postSubmitExport(ctx.id, exporterToken, { skipShot: true });
        assert(res.status === 400 && res.body.code === 'MISSING_REQUIRED_FILES', `T17 缺 screenshot 拒`);
    }

    console.log('\n=== T18: 附件类型错 — result_data 传 .png → 400 INVALID_RESULT_DATA ===');
    {
        const ctx = await makeExportingFixture();
        // multer fileFilter 联合白名单含 .png（用于 screenshot），所以会被 multer 接受
        // 进 endpoint 后 validateCollabAttachmentRule('result_data', '.png') 应拒
        const res = await postSubmitExport(ctx.id, exporterToken, { dataExt: '.png' });
        assert(res.status === 400 && res.body.code === 'INVALID_RESULT_DATA', `T18 result_data 错类型拒 code=${res.body && res.body.code}`);
    }

    console.log('\n=== T19: 附件类型错 — screenshot 传 .xlsx → 400 INVALID_SCREENSHOT ===');
    {
        const ctx = await makeExportingFixture();
        const res = await postSubmitExport(ctx.id, exporterToken, { shotExt: '.xlsx' });
        assert(res.status === 400 && res.body.code === 'INVALID_SCREENSHOT', `T19 screenshot 错类型拒 code=${res.body && res.body.code}`);
    }

    console.log('\n=== T19b: 导出截图传 .pdf → 400（v1.77.0 screenshot 规则放开 PDF 但导出截图入口单独排除）===');
    {
        const ctx = await makeExportingFixture();
        const res = await postSubmitExport(ctx.id, exporterToken, { shotExt: '.pdf' });
        assert(res.status === 400 && res.body.code === 'INVALID_SCREENSHOT', `T19b 导出截图 PDF 拒 code=${res.body && res.body.code}`);
        assert(/不支持 PDF/.test(res.body.error || ''), `T19b 错误文案明示不支持 PDF`);
    }

    console.log('\n=== T20: export_summary > 500 字 → 400 EXPORT_SUMMARY_TOO_LONG ===');
    {
        const ctx = await makeExportingFixture();
        const long = '长'.repeat(501);
        const res = await postSubmitExport(ctx.id, exporterToken, { exportSummary: long });
        assert(res.status === 400 && res.body.code === 'EXPORT_SUMMARY_TOO_LONG', `T20 超长拒`);
        assert(res.body.max_length === 500 && res.body.actual_length === 501, `T20 返回 max/actual length`);
    }

    console.log('\n=== T21: 并发原子性 — 同一单两个 submit-export ===');
    {
        const ctx = await makeExportingFixture();
        const [res1, res2] = await Promise.all([
            postSubmitExport(ctx.id, exporterToken, { exportSummary: 'concurrent A' }),
            postSubmitExport(ctx.id, exporterToken, { exportSummary: 'concurrent B' })
        ]);
        console.log(`     debug T21 res1=${res1.status}/${res1.body && res1.body.code || ''}, res2=${res2.status}/${res2.body && res2.body.code || ''}`);
        const okCount = [res1, res2].filter(r => r.status === 200).length;
        const conflictCount = [res1, res2].filter(r =>
            r.status === 409 && r.body && (r.body.code === 'INVALID_STATE_FOR_EXPORT_SUBMIT' || r.body.code === 'CONCURRENT_STATE_CHANGE')
        ).length;
        assert(okCount === 1, `T21 仅 1 个 200，got okCount=${okCount}`);
        assert(conflictCount === 1, `T21 另一个 409，got conflictCount=${conflictCount}`);
        const logs = await dbAll(
            `SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SUBMIT_EXPORT'`,
            [ctx.id]
        );
        assert(logs.length === 1, `T21 log 恰好 1 条 SUBMIT_EXPORT，got ${logs.length}`);
        const finalRow = await dbGet(`SELECT status FROM collab_requests WHERE id=?`, [ctx.id]);
        assert(finalRow.status === 'DONE', `T21 最终 status=DONE (v1.72.10)`);
    }

    console.log('\n=== T22: 跨 endpoint 互斥 — submit-export 与 return 并发（mutex 跨 endpoint）===');
    {
        const ctx = await makeExportingFixture();
        const [submitRes, returnRes] = await Promise.all([
            postSubmitExport(ctx.id, exporterToken, { exportSummary: 'cross-endpoint' }),
            apiCall('POST', `/api/collab/requests/${ctx.id}/return-to-dev`, exporterToken, { return_reason: 'other' })
        ]);
        console.log(`     debug T22 submit=${submitRes.status}/${submitRes.body && submitRes.body.code || ''}, return=${returnRes.status}/${returnRes.body && returnRes.body.code || ''}`);
        // 两种合法结果：
        //   (a) submit 先 → submit 200 + return 409（status=DONE 已不能 return，v1.72.10）
        //   (b) return 先 → return 200 + submit 409（status=PENDING 已不能 submit）
        const submitOk = submitRes.status === 200;
        const returnOk = returnRes.status === 200;
        const submitRejected = submitRes.status === 409 && submitRes.body && submitRes.body.code === 'INVALID_STATE_FOR_EXPORT_SUBMIT';
        const returnRejected = returnRes.status === 409 && returnRes.body && returnRes.body.code === 'INVALID_STATE_FOR_RETURN';
        const validOutcome = (submitOk && returnRejected) || (returnOk && submitRejected);
        assert(validOutcome, `T22 合法串行结果：got submit=${submitRes.status}/${submitRes.body && submitRes.body.code} return=${returnRes.status}/${returnRes.body && returnRes.body.code}`);

        // log 数与实际成功事件一致
        const submitLogs = await dbAll(`SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SUBMIT_EXPORT'`, [ctx.id]);
        const returnLogs = await dbAll(`SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='RETURN_TO_DEV'`, [ctx.id]);
        assert(submitLogs.length === (submitOk ? 1 : 0), `T22 SUBMIT_EXPORT log ${submitOk ? 1 : 0} 条`);
        assert(returnLogs.length === (returnOk ? 1 : 0), `T22 RETURN_TO_DEV log ${returnOk ? 1 : 0} 条`);
    }

    console.log('\n=== T23: mutex 锁等待证明 — 多独立 collab_id 并发 submit（codex 39 M-6）===');
    {
        const N = 5;
        const fixtures = [];
        for (let i = 0; i < N; i++) fixtures.push(await makeExportingFixture());

        // 单次基线
        const baselineCtx = await makeExportingFixture();
        const t0 = Date.now();
        const baselineRes = await postSubmitExport(baselineCtx.id, exporterToken);
        const baselineMs = Date.now() - t0;
        assert(baselineRes.status === 200, `T23 baseline submit 成功`);
        console.log(`     debug T23 单次 submit-export 基线=${baselineMs}ms`);

        const tStart = Date.now();
        const results = await Promise.all(fixtures.map(ctx => postSubmitExport(ctx.id, exporterToken)));
        const wallClockMs = Date.now() - tStart;
        const parallelEstimate = baselineMs;
        const serialEstimate = baselineMs * N;
        console.log(`     debug T23 ${N} 独立 collab 并发 wall-clock=${wallClockMs}ms`
            + `（串行预期 ≈ ${serialEstimate}ms / 并行预期 ≈ ${parallelEstimate}ms）`);

        const okCount = results.filter(r => r.status === 200).length;
        assert(okCount === N, `T23 ${N} 个独立 collab submit 全成功，got okCount=${okCount}`);

        // submit-export 含文件 IO，比 return 单事务慢，阈值放宽到 max(30, 1.5 × parallel)
        const mutexThreshold = Math.max(30, Math.ceil(parallelEstimate * 1.5));
        assert(wallClockMs >= mutexThreshold,
            `T23 mutex 锁等待证据：${N} 独立 collab wall-clock=${wallClockMs}ms ≥ ${mutexThreshold}ms`);
    }

    console.log('\n=== T24: submission_version 不递增（codex 39 H-1 部分采纳验证）===');
    {
        const ctx = await makeExportingFixture();
        const before = await dbGet(`SELECT submission_version FROM collab_requests WHERE id=?`, [ctx.id]);
        await postSubmitExport(ctx.id, exporterToken);
        const after = await dbGet(`SELECT submission_version FROM collab_requests WHERE id=?`, [ctx.id]);
        assert((before.submission_version || 0) === (after.submission_version || 0),
            `T24 submission_version 不递增（保 dev 提交次数语义），before=${before.submission_version} after=${after.submission_version}`);
    }

    console.log('\n=== T25: export_summary > 80 字落库完整 + 响应回显完整（方案 §7.4 S03 钉钉模板截断）===');
    {
        // S03 验证不变量：endpoint 不截 summary（完整入库 + 完整回显）；
        //   截断逻辑在 endpoint 的钉钉 markdown 拼接段（server.js line ~13123 slice(0,80)+'...'）—
        //   是 best-effort 副作用，不阻塞业务返回。本测试通过"db/响应完整" + "endpoint 200" 间接验证截断不影响主流程。
        const ctx = await makeExportingFixture();
        const longSummary = '本次导出范围：合同表 2026 Q1 全部 152 字段，按 customer_id 排序；过滤 status=active；脱敏字段：phone/id_card；输出 xlsx 单 sheet 共 13260 行。'.slice(0, 200);
        assert(longSummary.length > 80, `T25 fixture: longSummary.length=${longSummary.length} > 80`);
        const res = await postSubmitExport(ctx.id, exporterToken, { exportSummary: longSummary });
        assert(res.status === 200, `T25 status=200`);
        assert(res.body && res.body.export_summary === longSummary, `T25 响应回显完整（不截断），got len=${res.body && res.body.export_summary && res.body.export_summary.length}`);
        const row = await dbGet(`SELECT export_summary FROM collab_requests WHERE id=?`, [ctx.id]);
        assert(row.export_summary === longSummary, `T25 db 落库完整（不截断），got len=${row.export_summary && row.export_summary.length}`);
        // 同步验证 operation_logs reason JSON 原文存档（不截断 — 操作日志原文便于复盘，钉钉 80 字截断仅 markdown 拼接阶段）
        const log = await dbGet(
            `SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SUBMIT_EXPORT'`,
            [ctx.id]
        );
        const parsed = JSON.parse(log.reason);
        assert(parsed.export_summary === longSummary, `T25 log reason.export_summary 原文存档`);
        assert(parsed.summary_length === longSummary.length, `T25 log reason.summary_length=${longSummary.length}`);
    }
}

(async () => {
    try {
        await runTests();
    } catch (e) {
        console.error('\n!! e2e 运行异常：', e.message, e.stack);
        failed++;
    } finally {
        for (const id of createdFixtureIds) {
            try { await fx.cleanup(id); } catch (e) { console.error('cleanup failed:', e.message); }
        }
        try { await restoreExporterDingUid(); } catch (e) { console.error('restore EXPORTER ding uid failed:', e.message); }
        if (testTmpDir) {
            try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) { }
        }
        console.log(`\n== Summary: ${passed} pass / ${failed} fail ==`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
