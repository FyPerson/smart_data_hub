/**
 * v1.120.0 Commit B 验证：admin-submit-on-behalf 放开 EXPORTING（直派大文件行政闭环）
 * 2026-09-06 决策记录 D2 二次放开：EXPORTING 分支从「仅真直派单」放开到**任意 EXPORTING 单**
 *   （normal 已转发单 / fallback 重流转单 / 真直派单三种来源一视同仁）。
 *
 * 背景：直派单交付物可能是十几 G 大文件线下传递，导出人不便自助提交时，
 *   由 admin 在 EXPORTING 态直接行政闭环。v1.120.0 首次放开 admin-submit-on-behalf 状态守卫接纳
 *   EXPORTING——当时仅限「真直派单」= assign_mode='admin_direct' && forwarded_to_exporter_at IS NULL；
 *   2026-09-06 用户拍板（决策记录 D2）该判据整体去掉，任意 EXPORTING 单 admin 均可行政闭环，
 *   留证沿用现有：reason≥10 字 + sql_validation_status='admin_closed' + flow 字段。
 *
 * 覆盖：
 *   B1  正向：真直派 EXPORTING + admin 无附件行政闭环（reason≥10字）→ DONE + admin_closed + flow=exporting_to_done_admin_closure
 *   B2  正向【2026-09-06 由 409 翻转】：normal EXPORTING 单 + admin 无附件闭环 → DONE + admin_closed + flow（对齐 B1 断言形状）
 *   B3  正向【2026-09-06 由 409 翻转】：admin_direct 但 forwarded 非 NULL（fallback 重流转）EXPORTING + admin 无附件闭环 → DONE + admin_closed + flow
 *   B4  回归：SUBMITTED → DONE 仍正常（老路径不破）
 *   B5  回归：DONE→DONE 无附件仍拒 MISSING_ATTACHMENT_FOR_DONE_FIX（老守卫不破）
 *   B6  正向：真直派 EXPORTING + admin 带附件闭环 → DONE（有附件路径也支持）
 *   B7  负向：reason<10字 → 400 REASON_TOO_SHORT（老校验对 EXPORTING 同样生效）
 *   B8  【codex 02-B MED】未来 deadline + 无附件 EXPORTING 闭环 → done_at 用 now 非 deadline
 *   B9  【codex 02-B HIGH 自证】同单并发两次 admin 闭环 → 仅 1 个成功、另 1 个 409、无双成功/无交叉回滚
 *   B10 【末次审 MED-3】真直派 EXPORTING 单有历史 active 附件 + admin 无本次上传闭环 → done_at 用 now 非历史附件时间
 *   B11 【轻复审 HIGH】真直派 EXPORTING + 历史 active 附件 + admin 本次也上传 → done_at 仍 now 非历史
 *   B12 正向【2026-09-06 新增】：fallback 重流转单（admin_direct + forwarded 非 NULL）+ admin 带附件闭环 → DONE（对齐 B6 断言形状）
 *   B13 【codex 08 HIGH-1】同单并发两次带附件 + expected_status=EXPORTING → 恰 1 个 200、另 1 个 409 STATE_CHANGED、附件/日志恒 1
 *   B14 【codex 08 HIGH-1·顺序语义】闭环后过期意图（expected_status=EXPORTING）带附件重发 → 409 且附件不入库；声明 DONE → 200 合法修正
 *   B15 负向：expected_status 非法值/空串/纯空白/重复字段 → 400 INVALID_EXPECTED_STATUS；无附件不传 → 既有行为不变
 *   B16 【codex 08-R HIGH 收紧】带附件不传 expected_status → 400 EXPECTED_STATUS_REQUIRED（附件不入库）；混合并发一带一不带 → 200/400，附件/日志恒 1；SUBMITTED 带附件同样须传
 *   （B2 自 2026-09-06 起用 normal + forwarded 非 NULL 的 #45 真实形态；normal + forwarded NULL 在生产不可达，不再作夹具）
 *
 * 前置：dev 服务器需在 BASE 运行（直改本地 dev 库，测完 cleanup）。
 * 运行：node scripts/verify-collab-admin-close-exporting.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = fx.BASE;
const DB_PATH = fx.DB_PATH;
const EXPORTER_ID = fx.EXPORTER_ID;
const ADMIN_ID = fx.ADMIN_ID;

const created = [];
let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; fails.push(name); console.log(`  ✗ ${name}  ${detail || ''}`); }
}
function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); });
    });
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.all(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); });
    });
}
function dbRun(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(sql, params, function (e) { db.close(); e ? reject(e) : resolve(this); });
    });
}

// 造 EXPORTING 单（assignMode + 可选 forwarded 时间戳）
async function makeExporting(assignMode, forwardedAt) {
    const f = await fx.createPendingFixture();
    created.push(f.id);
    const exporterRow = await dbGet('SELECT display_name FROM users WHERE id=?', [EXPORTER_ID]);
    await fx.setCollabState(f.id, {
        status: 'EXPORTING',
        exporter_user_id: EXPORTER_ID,
        exporter_name: exporterRow ? exporterRow.display_name : 'exporter',
        assign_mode: assignMode,
        submission_version: 0,
    });
    if (forwardedAt) {
        await dbRun('UPDATE collab_requests SET forwarded_to_exporter_at=? WHERE id=?', [forwardedAt, f.id]);
    }
    return f;
}
// 造 SUBMITTED / DONE 单
async function makeState(status, patch) {
    const f = await fx.createPendingFixture();
    created.push(f.id);
    await fx.setCollabState(f.id, Object.assign({ status, submission_version: 1 }, patch || {}));
    return f;
}

// admin-submit-on-behalf：multipart（reason + 可选 result_data/result_script）
let tmpDir = null;
function mkFile(name, content) {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admincl-'));
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
}
async function adminSubmit(id, adminToken, { reason, withData = false, expectedStatus = null } = {}) {
    const form = new FormData();
    form.append('reason', reason);
    if (expectedStatus !== null) form.append('expected_status', expectedStatus);   // codex 08 HIGH-1：乐观前置（可选）
    if (withData) {
        const p = mkFile('admin_result.xlsx', 'PK\x03\x04 fake');
        form.append('result_data', new Blob([fs.readFileSync(p)]), 'admin_result.xlsx');
    }
    const r = await fetch(`${BASE}/api/collab/requests/${id}/admin-submit-on-behalf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        body: form,
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
}

async function main() {
    try { await fetch(`${BASE}/`, { method: 'GET' }); }
    catch (e) { console.error(`\n✗ 服务器不可达 ${BASE}，请先起 dev 服务\n`); process.exit(2); }

    const adminToken = await fx.signAs(ADMIN_ID);
    const REASON = '直派单十几G大文件已线下移交业务方，走内网共享盘，admin 代为行政闭环';

    console.log('\n=== B1 正向：真直派 EXPORTING + admin 无附件行政闭环 → DONE ===');
    {
        const f = await makeExporting('admin_direct', null);
        const res = await adminSubmit(f.id, adminToken, { reason: REASON });
        ok('B1 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status, done_at FROM collab_requests WHERE id=?', [f.id]);
        ok('B1 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('B1 sql_validation_status=admin_closed', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
        ok('B1 done_at 已写', !!(row && row.done_at), JSON.stringify(row));
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        ok('B1 ADMIN_SUBMIT_ON_BEHALF 日志恰 1 条', logs.length === 1, `got ${logs.length}`);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B1 flow=exporting_to_done_admin_closure', j.flow === 'exporting_to_done_admin_closure', j.flow);
        }
    }

    console.log('\n=== B2 正向【2026-09-06 翻转】：normal 已转发 EXPORTING 单（#45 形态·forwarded 非 NULL）+ admin 无附件行政闭环 → DONE ===');
    {
        // Opus 预筛 M1：normal + forwarded NULL 是生产不可达形态（normal 进 EXPORTING 必经 forward-to-exporter 写非 NULL，
        //   见 server.js submit-export 守卫①推导）；改用生产 #45 的真实形态，让「normal 已转发」在后端 verify 层有覆盖。
        const f = await makeExporting('normal', '2026-09-01 17:29:37');
        const res = await adminSubmit(f.id, adminToken, { reason: REASON });
        ok('B2 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status, done_at FROM collab_requests WHERE id=?', [f.id]);
        ok('B2 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('B2 sql_validation_status=admin_closed', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
        ok('B2 done_at 已写', !!(row && row.done_at), JSON.stringify(row));
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        ok('B2 ADMIN_SUBMIT_ON_BEHALF 日志恰 1 条', logs.length === 1, `got ${logs.length}`);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B2 flow=exporting_to_done_admin_closure', j.flow === 'exporting_to_done_admin_closure', j.flow);
        }
    }

    console.log('\n=== B3 正向【2026-09-06 翻转】：admin_direct 但已 forward（fallback 重流转）EXPORTING + admin 无附件闭环 → DONE ===');
    {
        const f = await makeExporting('admin_direct', '2026-07-21 09:00:00');
        const res = await adminSubmit(f.id, adminToken, { reason: REASON });
        ok('B3 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status, done_at FROM collab_requests WHERE id=?', [f.id]);
        ok('B3 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('B3 sql_validation_status=admin_closed', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
        ok('B3 done_at 已写', !!(row && row.done_at), JSON.stringify(row));
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        ok('B3 ADMIN_SUBMIT_ON_BEHALF 日志恰 1 条', logs.length === 1, `got ${logs.length}`);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B3 flow=exporting_to_done_admin_closure', j.flow === 'exporting_to_done_admin_closure', j.flow);
        }
    }

    console.log('\n=== B4 回归：SUBMITTED → DONE 仍正常（老路径不破）===');
    {
        const f = await makeState('SUBMITTED');
        const res = await adminSubmit(f.id, adminToken, { reason: REASON });
        ok('B4 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status FROM collab_requests WHERE id=?', [f.id]);
        ok('B4 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B4 flow=submitted_to_done_admin_closure（未串味）', j.flow === 'submitted_to_done_admin_closure', j.flow);
        }
    }

    console.log('\n=== B5 回归：DONE→DONE 无附件仍拒 MISSING_ATTACHMENT_FOR_DONE_FIX ===');
    {
        const f = await makeState('DONE', { sql_validation_status: 'passed', done_at: '2026-07-01 10:00:00' });
        const res = await adminSubmit(f.id, adminToken, { reason: REASON });
        ok('B5 响应 400', res.status === 400, `got ${res.status}`);
        ok('B5 code=MISSING_ATTACHMENT_FOR_DONE_FIX', res.body && res.body.code === 'MISSING_ATTACHMENT_FOR_DONE_FIX', JSON.stringify(res.body));
    }

    console.log('\n=== B6 正向：真直派 EXPORTING + admin 带附件闭环 → DONE ===');
    {
        const f = await makeExporting('admin_direct', null);
        const res = await adminSubmit(f.id, adminToken, { reason: REASON, withData: true, expectedStatus: 'EXPORTING' });   // 带附件须声明意图（codex 08-R）
        ok('B6 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('B6 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        const atts = await dbAll("SELECT attachment_type FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('B6 admin 附件入库', atts.length === 1 && atts[0].attachment_type === 'result_data', `got ${atts.length}`);
    }

    console.log('\n=== B7 负向：reason<10字 → 400 REASON_TOO_SHORT（EXPORTING 同样生效）===');
    {
        const f = await makeExporting('admin_direct', null);
        const res = await adminSubmit(f.id, adminToken, { reason: '太短' });
        ok('B7 响应 400', res.status === 400, `got ${res.status}`);
        ok('B7 code=REASON_TOO_SHORT', res.body && res.body.code === 'REASON_TOO_SHORT', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('B7 状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
    }

    console.log('\n=== B8【codex 02-B MED】：未来 deadline + 无附件 EXPORTING 闭环 → done_at 用 now 非 deadline ===');
    {
        const f = await makeExporting('admin_direct', null);
        // 设一个明确在未来的 deadline
        await dbRun('UPDATE collab_requests SET deadline=? WHERE id=?', ['2099-12-31 18:00:00', f.id]);
        const res = await adminSubmit(f.id, adminToken, { reason: REASON });
        ok('B8 响应 200', res.status === 200, `got ${res.status}`);
        const row = await dbGet('SELECT done_at, deadline FROM collab_requests WHERE id=?', [f.id]);
        ok('B8 done_at 不等于未来 deadline', row && row.done_at !== '2099-12-31 18:00:00', `done_at=${row && row.done_at}`);
        // done_at 应接近现在（今年）
        ok('B8 done_at 是实际闭环时间（非未来）', row && row.done_at && row.done_at < '2099-01-01', `done_at=${row && row.done_at}`);
        ok('B8 done_at_source=now', res.body && res.body.done_at_source === 'now', JSON.stringify(res.body && res.body.done_at_source));
    }

    console.log('\n=== B9【codex 02-B HIGH 自证】：同单并发两次 admin 闭环 → 仅 1 个成功、另 1 个 409、无双成功/无交叉回滚 ===');
    {
        const f = await makeExporting('admin_direct', null);
        // 并发发两次 admin-submit-on-behalf
        const [r1, r2] = await Promise.all([
            adminSubmit(f.id, adminToken, { reason: REASON + '·并发A' }),
            adminSubmit(f.id, adminToken, { reason: REASON + '·并发B' }),
        ]);
        const okCount = [r1, r2].filter(r => r.status === 200).length;
        const rejectedCount = [r1, r2].filter(r => r.status !== 200).length;
        ok('B9 恰好 1 个成功（200）', okCount === 1, `okCount=${okCount} r1=${r1.status} r2=${r2.status}`);
        // mutex 串行化后第二个请求等锁→拿锁时单已 DONE→走状态守卫拒绝（DONE 无附件=400 MISSING_ATTACHMENT_FOR_DONE_FIX，
        //   或并发时序下 changes=0=409）；只要「非 200 被拒」即证明无双成功
        ok('B9 恰好 1 个被拒（非 200，无双成功）', rejectedCount === 1, `rejectedCount=${rejectedCount} r1=${r1.status} r2=${r2.status}`);
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('B9 最终 status=DONE（未交叉回滚成半态）', row && row.status === 'DONE', JSON.stringify(row));
        const logs = await dbAll("SELECT id FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        ok('B9 审计日志恰 1 条（无双写）', logs.length === 1, `got ${logs.length}`);
    }

    console.log('\n=== B10【末次审 MED-3】：真直派 EXPORTING 单有历史 active 附件 + admin 无本次上传闭环 → done_at 用 now 非历史附件时间 ===');
    {
        const f = await makeExporting('admin_direct', null);
        // 塞一条历史 active 附件（created_at 在过去）——模拟 fallback/reassign 边界残留
        await dbRun(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, submission_version, status, created_at)
             VALUES (?, 'result_data', 'collab/_test/old.xlsx', '历史附件.xlsx', ?, 'tester', 1, 'active', '2020-01-01 08:00:00')`,
            [f.id, EXPORTER_ID]
        );
        const res = await adminSubmit(f.id, adminToken, { reason: REASON }); // 无本次上传
        ok('B10 响应 200', res.status === 200, `got ${res.status}`);
        const row = await dbGet('SELECT done_at FROM collab_requests WHERE id=?', [f.id]);
        ok('B10 done_at 不取历史附件时间 2020', row && row.done_at && row.done_at > '2021-01-01', `done_at=${row && row.done_at}`);
        ok('B10 done_at_source=now（本次闭环时间）', res.body && res.body.done_at_source === 'now', JSON.stringify(res.body && res.body.done_at_source));
    }

    console.log('\n=== B11【轻复审 HIGH】：真直派 EXPORTING + 历史 active 附件 + admin 本次也上传 → done_at 仍 now 非历史 ===');
    {
        const f = await makeExporting('admin_direct', null);
        // 历史 active 附件（created_at 更"晚"，模拟异常时间戳，测 MAX 不会取到它）
        await dbRun(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, submission_version, status, created_at)
             VALUES (?, 'result_data', 'collab/_test/futureold.xlsx', '异常历史附件.xlsx', ?, 'tester', 1, 'active', '2099-06-01 08:00:00')`,
            [f.id, EXPORTER_ID]
        );
        const res = await adminSubmit(f.id, adminToken, { reason: REASON, withData: true, expectedStatus: 'EXPORTING' }); // 本次也上传（带附件须声明意图·codex 08-R）
        ok('B11 响应 200', res.status === 200, `got ${res.status}`);
        const row = await dbGet('SELECT done_at FROM collab_requests WHERE id=?', [f.id]);
        // done_at 应是本次 now（今年），不是 2099 历史异常附件时间
        ok('B11 done_at 不取历史异常附件 2099', row && row.done_at && row.done_at < '2099-01-01', `done_at=${row && row.done_at}`);
        ok('B11 done_at_source=now', res.body && res.body.done_at_source === 'now', JSON.stringify(res.body && res.body.done_at_source));
    }

    console.log('\n=== B12【2026-09-06 新增】：fallback 重流转单（admin_direct + forwarded 非 NULL）+ admin 带附件闭环 → DONE ===');
    {
        const f = await makeExporting('admin_direct', '2026-07-21 09:00:00');
        const res = await adminSubmit(f.id, adminToken, { reason: REASON, withData: true, expectedStatus: 'EXPORTING' });   // 带附件须声明意图（codex 08-R）
        ok('B12 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status FROM collab_requests WHERE id=?', [f.id]);
        ok('B12 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('B12 sql_validation_status=admin_closed', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
        const atts = await dbAll("SELECT attachment_type FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('B12 admin 附件入库', atts.length === 1 && atts[0].attachment_type === 'result_data', `got ${atts.length}`);
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        ok('B12 ADMIN_SUBMIT_ON_BEHALF 日志恰 1 条', logs.length === 1, `got ${logs.length}`);   // Opus 预筛 M2：计数断言先行，flow 断言不再可被静默跳过
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B12 flow=exporting_to_done_admin_closure', j.flow === 'exporting_to_done_admin_closure', j.flow);
        }
    }

    console.log('\n=== B13【codex 08 HIGH-1】：同单并发两次「带附件 + expected_status=EXPORTING」admin 闭环 → 恰 1 个 200、另 1 个 409 STATE_CHANGED、active 附件恒 1、日志恒 1（不被重解释成 DONE 修正）===');
    {
        const f = await makeExporting('normal', '2026-09-01 17:29:37');
        const [r1, r2] = await Promise.all([
            adminSubmit(f.id, adminToken, { reason: REASON + '·并发带附件A', withData: true, expectedStatus: 'EXPORTING' }),
            adminSubmit(f.id, adminToken, { reason: REASON + '·并发带附件B', withData: true, expectedStatus: 'EXPORTING' }),
        ]);
        const okList = [r1, r2].filter(r => r.status === 200);
        const rejList = [r1, r2].filter(r => r.status !== 200);
        ok('B13 恰好 1 个成功（200）', okList.length === 1, `r1=${r1.status} r2=${r2.status}`);
        ok('B13 另 1 个 409 STATE_CHANGED（排队请求拿锁后重读到 DONE，被乐观前置拦下而非重解释为 DONE 修正）',
            rejList.length === 1 && rejList[0].status === 409 && rejList[0].body && rejList[0].body.code === 'STATE_CHANGED',
            JSON.stringify(rejList.map(r => [r.status, r.body && r.body.code])));
        const atts = await dbAll("SELECT id FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('B13 active 附件恒 1（第二个请求的附件没有替换第一个）', atts.length === 1, `got ${atts.length}`);
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        ok('B13 ADMIN_SUBMIT_ON_BEHALF 日志恒 1 条（无 done_to_done_admin_fix 幽灵日志）', logs.length === 1, `got ${logs.length}`);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B13 唯一日志 flow=exporting_to_done_admin_closure', j.flow === 'exporting_to_done_admin_closure', j.flow);
        }
    }

    console.log('\n=== B14【codex 08 HIGH-1·顺序语义】：EXPORTING 闭环成功后，再以 expected_status=EXPORTING 带附件重发 → 409 STATE_CHANGED 且附件不入库；改传 expected_status=DONE → 200 走合法 DONE 修正 ===');
    {
        const f = await makeExporting('admin_direct', null);
        const first = await adminSubmit(f.id, adminToken, { reason: REASON + '·B14 首闭', expectedStatus: 'EXPORTING' });
        ok('B14 首次 EXPORTING 闭环 200', first.status === 200, `got ${first.status} ${JSON.stringify(first.body)}`);
        const stale = await adminSubmit(f.id, adminToken, { reason: REASON + '·B14 过期意图', withData: true, expectedStatus: 'EXPORTING' });
        ok('B14 过期意图（仍声称 EXPORTING）带附件重发 → 409', stale.status === 409, `got ${stale.status} ${JSON.stringify(stale.body)}`);
        ok('B14 code=STATE_CHANGED 且响应带 current_status=DONE', stale.body && stale.body.code === 'STATE_CHANGED' && stale.body.current_status === 'DONE', JSON.stringify(stale.body));
        const attsAfterStale = await dbAll("SELECT id FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('B14 过期意图的附件未入库（active 附件 0）', attsAfterStale.length === 0, `got ${attsAfterStale.length}`);
        const fix = await adminSubmit(f.id, adminToken, { reason: REASON + '·B14 合法修正', withData: true, expectedStatus: 'DONE' });
        ok('B14 显式声明 DONE 修正 → 200', fix.status === 200, `got ${fix.status} ${JSON.stringify(fix.body)}`);
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF' ORDER BY id", [f.id]);
        ok('B14 日志恰 2 条（首闭 + 合法修正，过期意图零留痕）', logs.length === 2, `got ${logs.length}`);
        if (logs.length === 2) {
            const flows = logs.map(l => { try { return JSON.parse(l.reason).flow; } catch (_) { return 'PARSE_ERROR'; } });
            ok('B14 日志 flow 序列 = exporting_to_done_admin_closure → done_to_done_admin_fix', flows[0] === 'exporting_to_done_admin_closure' && flows[1] === 'done_to_done_admin_fix', JSON.stringify(flows));
        }
    }

    console.log('\n=== B15 负向：expected_status 非法值 → 400 INVALID_EXPECTED_STATUS（fail-closed 不静默忽略）；不传 expected_status → 既有行为不变 ===');
    {
        const f = await makeExporting('admin_direct', null);
        const bad = await adminSubmit(f.id, adminToken, { reason: REASON + '·B15 非法值', expectedStatus: 'PENDING' });
        ok('B15 非法 expected_status → 400', bad.status === 400, `got ${bad.status} ${JSON.stringify(bad.body)}`);
        ok('B15 code=INVALID_EXPECTED_STATUS', bad.body && bad.body.code === 'INVALID_EXPECTED_STATUS', JSON.stringify(bad.body));
        const row0 = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('B15 非法值请求未改状态（仍 EXPORTING）', row0 && row0.status === 'EXPORTING', JSON.stringify(row0));
        const plain = await adminSubmit(f.id, adminToken, { reason: REASON + '·B15 不传前置' });
        ok('B15 不传 expected_status（无附件）→ 200（既有调用零改动）', plain.status === 200, `got ${plain.status} ${JSON.stringify(plain.body)}`);
        // codex 08-R LOW：字段存在即校验——空串 / 纯空白 / 重复字段（multer 收成数组）都不是「未传」，一律 400
        for (const v of [{ label: '空串', value: '' }, { label: '纯空白', value: '   ' }]) {
            const f2 = await makeExporting('admin_direct', null);
            const r = await adminSubmit(f2.id, adminToken, { reason: REASON + '·B15 ' + v.label, expectedStatus: v.value });
            ok(`B15 expected_status=${v.label} → 400 INVALID_EXPECTED_STATUS（不当未传放行）`, r.status === 400 && r.body && r.body.code === 'INVALID_EXPECTED_STATUS', `got ${r.status} ${JSON.stringify(r.body)}`);
            const rowV = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f2.id]);
            ok(`B15 ${v.label} 请求未改状态`, rowV && rowV.status === 'EXPORTING', JSON.stringify(rowV));
        }
        {
            const f3 = await makeExporting('admin_direct', null);
            const form = new FormData();
            form.append('reason', REASON + '·B15 重复字段');
            form.append('expected_status', 'EXPORTING');
            form.append('expected_status', 'EXPORTING');
            const r = await fetch(`${BASE}/api/collab/requests/${f3.id}/admin-submit-on-behalf`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: form });
            let j = null; try { j = await r.json(); } catch (_) {}
            ok('B15 重复 expected_status 字段（数组）→ 400 INVALID_EXPECTED_STATUS', r.status === 400 && j && j.code === 'INVALID_EXPECTED_STATUS', `got ${r.status} ${JSON.stringify(j)}`);
        }
    }

    console.log('\n=== B16【codex 08-R HIGH 收紧】：带附件但不传 expected_status → 400 EXPECTED_STATUS_REQUIRED（附件不入库）；混合并发（一带一不带）→ 带的 200、不带的 400，附件/日志恒 1 ===');
    {
        const f = await makeExporting('normal', '2026-09-01 17:29:37');
        const noIntent = await adminSubmit(f.id, adminToken, { reason: REASON + '·B16 带附件无意图', withData: true });
        ok('B16 带附件不传 expected_status → 400', noIntent.status === 400, `got ${noIntent.status} ${JSON.stringify(noIntent.body)}`);
        ok('B16 code=EXPECTED_STATUS_REQUIRED', noIntent.body && noIntent.body.code === 'EXPECTED_STATUS_REQUIRED', JSON.stringify(noIntent.body));
        const row0 = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('B16 状态未变（仍 EXPORTING）', row0 && row0.status === 'EXPORTING', JSON.stringify(row0));
        const atts0 = await dbAll("SELECT id FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('B16 附件未入库', atts0.length === 0, `got ${atts0.length}`);
        // 混合并发：旧客户端形态（无意图+附件）与新前端形态（有意图+附件）同时到达
        const [r1, r2] = await Promise.all([
            adminSubmit(f.id, adminToken, { reason: REASON + '·B16 混合·有意图', withData: true, expectedStatus: 'EXPORTING' }),
            adminSubmit(f.id, adminToken, { reason: REASON + '·B16 混合·无意图', withData: true }),
        ]);
        ok('B16 混合并发：有意图方 200', r1.status === 200, `got ${r1.status} ${JSON.stringify(r1.body)}`);
        ok('B16 混合并发：无意图方 400 EXPECTED_STATUS_REQUIRED（无论先后都不能覆盖交付物）', r2.status === 400 && r2.body && r2.body.code === 'EXPECTED_STATUS_REQUIRED', `got ${r2.status} ${JSON.stringify(r2.body)}`);
        const atts = await dbAll("SELECT id FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('B16 active 附件恒 1', atts.length === 1, `got ${atts.length}`);
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        ok('B16 日志恒 1 条', logs.length === 1, `got ${logs.length}`);
        // 对照：SUBMITTED→DONE 无附件仍可不传意图（既有 B4 路径），带附件则须传
        const s1 = await makeState('SUBMITTED');
        const sNo = await adminSubmit(s1.id, adminToken, { reason: REASON + '·B16 SUBMITTED 带附件无意图', withData: true });
        ok('B16 SUBMITTED 带附件不传意图 → 400 EXPECTED_STATUS_REQUIRED', sNo.status === 400 && sNo.body && sNo.body.code === 'EXPECTED_STATUS_REQUIRED', `got ${sNo.status} ${JSON.stringify(sNo.body)}`);
        const sYes = await adminSubmit(s1.id, adminToken, { reason: REASON + '·B16 SUBMITTED 带附件有意图', withData: true, expectedStatus: 'SUBMITTED' });
        ok('B16 SUBMITTED 带附件传意图 → 200', sYes.status === 200, `got ${sYes.status} ${JSON.stringify(sYes.body)}`);
    }

    console.log('\n=== 清理测试单 ===');
    for (const id of created) { try { await fx.cleanup(id); } catch (e) { console.log(`  清理 #${id} 失败: ${e.message}`); } }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }

    console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
    if (fail > 0) { console.log('失败项：', fails.join(' | ')); process.exit(1); }
    console.log('✓ Commit B 全部通过\n');
}

main().catch(e => { console.error('脚本异常:', e); process.exit(1); });
