/**
 * admin-submit-on-behalf 状态准入放开三轮的验证脚本（文件名沿 v1.120.0 首轮，未随后续放开改名）
 *   一轮 v1.120.0 Commit B：放开 EXPORTING（仅真直派单，大文件线下移交场景）
 *   二轮 2026-09-06 决策记录 D2：EXPORTING 从「仅真直派单」放开到**任意 EXPORTING 单**
 *     （normal 已转发单 / fallback 重流转单 / 真直派单三种来源一视同仁）
 *   三轮 2026-09-07 用户拍板：再放开 **PENDING_ASSIGN / PENDING** 两个「尚未提交交付物」态，
 *     准入合计五态；已作废 / 已归档仍拒（见 B17-B24）
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
 * 2026-09-07 放开到任意状态（用户拍板·决策记录《数据协作·admin 行政闭环放开到任意状态》D1-D4 / J1-J7）新增：
 *   B17 正向：PENDING_ASSIGN（未指派）无附件闭环 → DONE + admin_closed + done_at=闭环时刻（非 deadline）+ flow=pending_assign_to_done_admin_closure
 *   B18 正向：PENDING（已指派未提交）无附件闭环 → DONE + flow=pending_to_done_admin_closure（与 B17 严格区分）
 *   B19 正向：normal / 真直派 / fallback 重流转 三来源 PENDING 各闭环一次 → 均 200（D1 不分流转方式，flow 按状态不按来源）
 *   B20 正向：PENDING + 带附件补传（带 expected_status）→ DONE + active 附件 1 + submission_version 不递增 + done_at_source=now（不被本次附件反推）
 *   B21 负向：PENDING 带附件不传 expected_status → 400 EXPECTED_STATUS_REQUIRED，附件零入库、状态不动
 *   B22 负向：PENDING_ASSIGN 单声明 expected_status=PENDING → 409 STATE_CHANGED；对照组声明一致 → 200（证明 409 来自意图错位而非新态没进白名单）
 *   B23 负向：已作废（archived_at）/ 已归档（archived_final_at）的 PENDING 单仍 409（D2 边界没被一起放掉）
 *   B24 负向：未知状态仍 409 STATE_NOT_ALLOWED_FOR_ADMIN_SUBMIT + 文案已同步五态（V9a/V9b 翻转后该守卫的唯一覆盖）
 *   B25 正向【codex 11-M2/M3 补】：真·未指派（developer_id=0）单 + 带附件补传 → DONE + 附件版本按规则 + 日志 done_at_source 同源
 *   ⚠️ B15 同步连锁修正：原拿 'PENDING' 当 expected_status 非法值，白名单扩五态后已合法，改用 'ARCHIVED'
 *
 * ⚠️ 覆盖边界（codex 11 号审 M1·登记接受，勿当已覆盖）：
 *   UPDATE 的**逐状态 WHERE** 守的是「锁内 SELECT → UPDATE」窗口（`POST /:id/assign` 不持
 *   collabExporterTransitionMutex，故该交错真实可达）。此窗口的交错依赖真实并发时序，本仓无确定性注入点，
 *   **本层无用例覆盖**。B22 证明的是另一层（expected_status 乐观前置，守「前端快照 → 锁内 SELECT」窗口）。
 *   变异「WHERE 换回旧三态集合」只能证明该分支活着，证明不了"逐状态 vs 合并两 pending"的差别——
 *   无交错时两种写法行为完全相同。
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

// 2026-09-07 B17-B24 配套 —— 造「尚未提交交付物」的两态单。
//   刻意不复用 makeState：它强写 submission_version=1（模拟"开发提交过"），而待指派/待开发单在生产上
//   submission_version 恒为初始值，强写会让"补传附件后版本号不递增"这条断言失去意义。
//   createPendingFixture 恒止于 PENDING（建单 PENDING_ASSIGN → contact 指派 → PENDING），故：
async function makePending(assignMode, forwardedAt) {
    const f = await fx.createPendingFixture();
    created.push(f.id);
    if (assignMode) await fx.setCollabState(f.id, { assign_mode: assignMode });
    if (forwardedAt) await dbRun('UPDATE collab_requests SET forwarded_to_exporter_at=? WHERE id=?', [forwardedAt, f.id]);
    return f;
}
// ⚠️ codex 11 号审 M2 订正：只把 status 翻回 PENDING_ASSIGN **不等于**造出「尚未指派」形态——
//   createPendingFixture 已经 assign 过 dev1，developer_id/developer_name/assigned_at 都还在，
//   那样的夹具跑绿只证明「状态叫 PENDING_ASSIGN 的单能闭环」，证明不了「真的没有开发的单能闭环」。
//   真实未指派形态（生产实测 #17/#27/#1950…）= developer_id=0 / developer_name='(待指派)' / assigned_at=NULL，
//   两列都是 NOT NULL，故用 0 与 '(待指派)' 而不是 NULL。调用方须在请求前断言该形态（见 B17）。
async function makePendingAssign() {
    const f = await fx.createPendingFixture();
    created.push(f.id);
    await fx.setCollabState(f.id, { status: 'PENDING_ASSIGN' });
    await dbRun(
        "UPDATE collab_requests SET developer_id=0, developer_name='(待指派)', assigned_at=NULL, assigned_by=NULL WHERE id=?",
        [f.id]);
    return f;
}
// done_at 断言用：取 SQLite 自己的 localtime（与 datetime('now','localtime') 同源，避开 JS 时区/时钟偏移）
async function dbNowLocal() {
    const r = await dbGet("SELECT datetime('now','localtime') AS t", []);
    return r && r.t;
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
        // 2026-09-07 连锁修正：原用例拿 'PENDING' 当非法值，白名单扩为五态后 'PENDING' 已合法，
        //   用它测「非法值」会变成永远不成立的断言。改用 'ARCHIVED'——真实存在的协作单状态、
        //   但**永远不在** ADMIN_SUBMIT_EXPECTED_STATUSES 里（归档单由 ARCHIVED_PROTECTED 单独拒），
        //   比随手编个乱码更能守住"白名单是白名单，不是随便什么状态名都收"。
        const bad = await adminSubmit(f.id, adminToken, { reason: REASON + '·B15 非法值', expectedStatus: 'ARCHIVED' });
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

    // ============================================================================================
    // B17-B24：2026-09-07 用户拍板放开到 PENDING_ASSIGN / PENDING（决策记录《admin 行政闭环放开到任意状态》）
    // ============================================================================================
    const PENDING_REASON = '业务方线下已自行取数完成，需求不再走平台开发，admin 代为记账闭环';

    console.log('\n=== B17 正向【2026-09-07 新增】：PENDING_ASSIGN（未指派）无附件闭环 → DONE + admin_closed + done_at=闭环时刻 + flow 逐状态 ===');
    {
        const f = await makePendingAssign();
        // 前置形态断言（codex 11-M2）：先证明夹具确实"没有开发"，后面的 200 才代表"未指派单能闭环"
        const pre = await dbGet('SELECT status, developer_id, developer_name, assigned_at FROM collab_requests WHERE id=?', [f.id]);
        ok('B17 夹具确为真·未指派形态（developer_id=0 且 assigned_at 为空）',
            !!(pre && pre.status === 'PENDING_ASSIGN' && Number(pre.developer_id) === 0 && pre.assigned_at == null),
            JSON.stringify(pre));
        const before = await dbNowLocal();
        const res = await adminSubmit(f.id, adminToken, { reason: PENDING_REASON });
        const after = await dbNowLocal();
        ok('B17 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status, sql_validation_error, done_at, deadline FROM collab_requests WHERE id=?', [f.id]);
        ok('B17 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('B17 sql_validation_status=admin_closed', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
        ok('B17 sql_validation_error 清空', row && row.sql_validation_error === null, JSON.stringify(row));
        // ⭐ 判别力所在：上下界都要。夹具 deadline='2026-12-31 18:00:00' 在未来，只断言"done_at 非空"
        //   或"≥请求前"都拦不住「pending 分支被删 → 回落 COALESCE(...,deadline,...)」这个变异。
        ok('B17 done_at ∈ [请求前, 请求后]（本次闭环时刻，非 deadline）',
            !!(row && row.done_at && row.done_at >= before && row.done_at <= after),
            `done_at=${row && row.done_at} 窗口=[${before}, ${after}] deadline=${row && row.deadline}`);
        ok('B17 done_at ≠ deadline（未回落到要求完成时间）', !!(row && row.done_at !== row.deadline), JSON.stringify(row));
        ok('B17 响应 done_at_source=now（沿 EXPORTING 既有取值，不新造枚举）', res.body && res.body.done_at_source === 'now', JSON.stringify(res.body && res.body.done_at_source));
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        ok('B17 ADMIN_SUBMIT_ON_BEHALF 日志恰 1 条', logs.length === 1, `got ${logs.length}`);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B17 flow=pending_assign_to_done_admin_closure（不与 PENDING 归并）', j.flow === 'pending_assign_to_done_admin_closure', j.flow);
            ok('B17 日志 reason 原文落库', j.reason === PENDING_REASON, String(j.reason).slice(0, 40));
        }
    }

    console.log('\n=== B18 正向【2026-09-07 新增】：PENDING（已指派未提交）无附件闭环 → DONE + flow 与 B17 不同值 ===');
    {
        const f = await makePending(null, null);
        const before = await dbNowLocal();
        const res = await adminSubmit(f.id, adminToken, { reason: PENDING_REASON });
        const after = await dbNowLocal();
        ok('B18 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status, done_at, deadline FROM collab_requests WHERE id=?', [f.id]);
        ok('B18 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('B18 sql_validation_status=admin_closed', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
        ok('B18 done_at ∈ [请求前, 请求后]（非 deadline）',
            !!(row && row.done_at && row.done_at >= before && row.done_at <= after),
            `done_at=${row && row.done_at} 窗口=[${before}, ${after}] deadline=${row && row.deadline}`);
        ok('B18 响应 done_at_source=now', res.body && res.body.done_at_source === 'now', JSON.stringify(res.body && res.body.done_at_source));
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        ok('B18 日志恰 1 条', logs.length === 1, `got ${logs.length}`);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B18 flow=pending_to_done_admin_closure（与 B17 的 pending_assign_ 严格区分）', j.flow === 'pending_to_done_admin_closure', j.flow);
        }
    }

    console.log('\n=== B19 正向【2026-09-07 新增】：三来源（normal / 直派 / fallback 重流转）PENDING 单各闭环一次 → 均 200（D1 不分流转方式）===');
    {
        const cases = [
            { label: 'normal', assignMode: 'normal', forwarded: null },
            { label: 'admin_direct 真直派', assignMode: 'admin_direct', forwarded: null },
            { label: 'admin_direct 已转发（fallback 重流转）', assignMode: 'admin_direct', forwarded: '2026-07-21 09:00:00' },
        ];
        for (const c of cases) {
            const f = await makePending(c.assignMode, c.forwarded);
            const res = await adminSubmit(f.id, adminToken, { reason: PENDING_REASON + '·' + c.label });
            ok(`B19 ${c.label} → 200`, res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
            const row = await dbGet('SELECT status, sql_validation_status FROM collab_requests WHERE id=?', [f.id]);
            ok(`B19 ${c.label} 库内 DONE + admin_closed`, !!(row && row.status === 'DONE' && row.sql_validation_status === 'admin_closed'), JSON.stringify(row));
            const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
            if (logs.length === 1) {
                const j = JSON.parse(logs[0].reason);
                ok(`B19 ${c.label} flow=pending_to_done_admin_closure（flow 按状态不按来源）`, j.flow === 'pending_to_done_admin_closure', j.flow);
            } else {
                ok(`B19 ${c.label} 日志恰 1 条`, false, `got ${logs.length}`);
            }
        }
    }

    console.log('\n=== B20 正向【2026-09-07 新增】：PENDING + 带附件补传（带 expected_status）→ DONE + 附件 active + submission_version 不递增 ===');
    {
        const f = await makePending(null, null);
        const v0row = await dbGet('SELECT submission_version FROM collab_requests WHERE id=?', [f.id]);
        const before = await dbNowLocal();
        const res = await adminSubmit(f.id, adminToken, { reason: PENDING_REASON + '·补传留档', withData: true, expectedStatus: 'PENDING' });
        const after = await dbNowLocal();
        ok('B20 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status, done_at, submission_version, attachment_dir FROM collab_requests WHERE id=?', [f.id]);
        ok('B20 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('B20 sql_validation_status=admin_closed（补传不等于验收，不跑 smoke·D3）', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
        const atts = await dbAll("SELECT attachment_type, submission_version, status, file_name FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('B20 active 附件恰 1（result_data）', atts.length === 1 && atts[0].attachment_type === 'result_data', JSON.stringify(atts));
        ok('B20 collab_requests.submission_version 未被递增（行政闭环不算 dev 提交）',
            row && String(row.submission_version) === String(v0row && v0row.submission_version),
            `before=${v0row && v0row.submission_version} after=${row && row.submission_version}`);
        // codex 11 号审 M3：原来只 SELECT 出附件 submission_version 却没断言它——附件版本写错也能全绿。
        //   既有规则（server.js:`newSubmissionVersion = collab.submission_version || 1`）对 PENDING 单（版本 0/NULL）
        //   应得 1。**注意主表版本与附件版本不必相等**，这里按规则算期望值，不拿主表值当期望。
        const expectedAttVer = Number(v0row && v0row.submission_version) || 1;
        ok(`B20 附件 submission_version = ${expectedAttVer}（按 \`collab.submission_version || 1\` 规则算，非照抄主表值）`,
            atts.length === 1 && Number(atts[0].submission_version) === expectedAttVer,
            `att=${atts.length === 1 ? atts[0].submission_version : 'n/a'} 主表=${v0row && v0row.submission_version}`);
        ok('B20 attachment_dir 已落', !!(row && row.attachment_dir), JSON.stringify(row && row.attachment_dir));
        // 附件落盘路径须落在主表登记的 attachment_dir 之下（否则详情页取不到文件）
        ok('B20 附件 file_name 落在 attachment_dir 目录下（主表登记与实际存放一致）',
            atts.length === 1 && !!row.attachment_dir && String(atts[0].file_name).includes(String(row.attachment_dir)),
            `file_name=${atts.length === 1 ? atts[0].file_name : 'n/a'} dir=${row && row.attachment_dir}`);
        // ⭐ 带附件场景下 done_at 的判别力靠 done_at_source：此时 COALESCE 首支（active 附件 MAX(created_at)）
        //   恰好也≈now，落在时间窗内，光看 done_at 区分不出「pending 分支被删」；但少了 pending 分支，
        //   附件反推会把来源标成 admin_supplemental_attachment，这条断言才是真正的标尺。
        ok('B20 done_at_source=now（不被本次补传附件反推成 admin_supplemental_attachment）',
            res.body && res.body.done_at_source === 'now', JSON.stringify(res.body && res.body.done_at_source));
        ok('B20 done_at ∈ [请求前, 请求后]', !!(row && row.done_at >= before && row.done_at <= after), `done_at=${row && row.done_at} 窗口=[${before}, ${after}]`);
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B20 flow=pending_to_done_admin_closure', j.flow === 'pending_to_done_admin_closure', j.flow);
            ok('B20 日志 admin_uploaded 记 1 个附件', Array.isArray(j.admin_uploaded) && j.admin_uploaded.length === 1, JSON.stringify(j.admin_uploaded));
        } else {
            ok('B20 日志恰 1 条', false, `got ${logs.length}`);
        }
    }

    console.log('\n=== B21 负向【2026-09-07 新增】：PENDING 带附件但不传 expected_status → 400 EXPECTED_STATUS_REQUIRED（附件不入库、状态不动）===');
    {
        const f = await makePending(null, null);
        const res = await adminSubmit(f.id, adminToken, { reason: PENDING_REASON + '·缺意图', withData: true });
        ok('B21 → 400', res.status === 400, `got ${res.status} ${JSON.stringify(res.body)}`);
        ok('B21 code=EXPECTED_STATUS_REQUIRED', res.body && res.body.code === 'EXPECTED_STATUS_REQUIRED', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('B21 状态未变（仍 PENDING）', row && row.status === 'PENDING', JSON.stringify(row));
        const atts = await dbAll("SELECT id FROM collab_attachments WHERE collab_request_id=?", [f.id]);
        ok('B21 附件零入库（含 superseded 也不该有）', atts.length === 0, `got ${atts.length}`);
    }

    // ⚠️ 口径订正（codex 11 号审 M1）：本组证明的是**乐观前置这一层**（快照 → 锁内 SELECT 窗口），
    //   **不是** UPDATE 的逐状态 WHERE（那层守的是 SELECT → UPDATE 窗口）。两层守不同的时间窗，
    //   本用例请求发出前状态就已不符，走的是锁内 expected_status 比对分支，压根没走到 UPDATE。
    //   逐状态 WHERE 那一层无用例覆盖（交错需真实并发时序，本仓无确定性注入点）——见 server.js 该处「登记接受」。
    console.log('\n=== B22 负向【2026-09-07 新增】：PENDING_ASSIGN 单声明 expected_status=PENDING → 409 STATE_CHANGED（证明乐观前置层，非 WHERE 层）===');
    {
        const f = await makePendingAssign();
        const res = await adminSubmit(f.id, adminToken, { reason: PENDING_REASON + '·意图错位', expectedStatus: 'PENDING' });
        ok('B22 → 409', res.status === 409, `got ${res.status} ${JSON.stringify(res.body)}`);
        ok('B22 code=STATE_CHANGED', res.body && res.body.code === 'STATE_CHANGED', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('B22 状态未变（仍 PENDING_ASSIGN）', row && row.status === 'PENDING_ASSIGN', JSON.stringify(row));
        // 反向：声明与现状一致则放行（证明 409 来自"意图错位"而非"PENDING_ASSIGN 压根不让传"）
        const okRes = await adminSubmit(f.id, adminToken, { reason: PENDING_REASON + '·意图一致', expectedStatus: 'PENDING_ASSIGN' });
        ok('B22 对照组：expected_status=PENDING_ASSIGN → 200（白名单已含新两态）', okRes.status === 200, `got ${okRes.status} ${JSON.stringify(okRes.body)}`);
    }

    console.log('\n=== B23 负向【2026-09-07 新增】：作废单 / 归档单在放开后仍被保护（D2 边界没被一起放掉）===');
    {
        const fVoid = await makePending(null, null);
        await dbRun("UPDATE collab_requests SET archived_at=datetime('now','localtime') WHERE id=?", [fVoid.id]);
        const rVoid = await adminSubmit(fVoid.id, adminToken, { reason: PENDING_REASON + '·作废单' });
        ok('B23 已作废 PENDING 单 → 409', rVoid.status === 409, `got ${rVoid.status} ${JSON.stringify(rVoid.body)}`);
        ok('B23 code=SOFT_ARCHIVED_PROTECTED', rVoid.body && rVoid.body.code === 'SOFT_ARCHIVED_PROTECTED', JSON.stringify(rVoid.body));
        const rowVoid = await dbGet('SELECT status FROM collab_requests WHERE id=?', [fVoid.id]);
        ok('B23 作废单状态未变', rowVoid && rowVoid.status === 'PENDING', JSON.stringify(rowVoid));

        const fArch = await makePendingAssign();
        await dbRun("UPDATE collab_requests SET archived_final_at=datetime('now','localtime') WHERE id=?", [fArch.id]);
        const rArch = await adminSubmit(fArch.id, adminToken, { reason: PENDING_REASON + '·归档单' });
        ok('B23 已归档（archived_final_at）PENDING_ASSIGN 单 → 409', rArch.status === 409, `got ${rArch.status} ${JSON.stringify(rArch.body)}`);
        ok('B23 code=ARCHIVED_PROTECTED', rArch.body && rArch.body.code === 'ARCHIVED_PROTECTED', JSON.stringify(rArch.body));
        const rowArch = await dbGet('SELECT status FROM collab_requests WHERE id=?', [fArch.id]);
        ok('B23 归档单状态未变', rowArch && rowArch.status === 'PENDING_ASSIGN', JSON.stringify(rowArch));
    }

    console.log('\n=== B24 负向【2026-09-07 新增】：未知状态仍撞 STATE_NOT_ALLOWED_FOR_ADMIN_SUBMIT（准入判据没退化成"什么都收"）===');
    {
        // 放开到五态后，作废/归档各有专属守卫在前，本错误码在生产已很难自然触达；但 collab_requests.status
        //   是无 CHECK 的 TEXT 列，将来新增状态时这条判据就是唯一的兜底。原 V9a/V9b 是它仅有的覆盖，
        //   两条已翻转为 200，若不在此补一条，这个守卫会变成"没有任何用例盯着"的死角。
        const f = await makePending(null, null);
        await fx.setCollabState(f.id, { status: 'SOME_FUTURE_STATE' });
        const res = await adminSubmit(f.id, adminToken, { reason: PENDING_REASON + '·未知态' });
        ok('B24 未知状态 → 409', res.status === 409, `got ${res.status} ${JSON.stringify(res.body)}`);
        ok('B24 code=STATE_NOT_ALLOWED_FOR_ADMIN_SUBMIT', res.body && res.body.code === 'STATE_NOT_ALLOWED_FOR_ADMIN_SUBMIT', JSON.stringify(res.body));
        ok('B24 409 文案已同步五态', !!(res.body && typeof res.body.error === 'string' && res.body.error.includes('PENDING_ASSIGN / PENDING / SUBMITTED / DONE / EXPORTING')), JSON.stringify(res.body && res.body.error));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('B24 状态未变', row && row.status === 'SOME_FUTURE_STATE', JSON.stringify(row));
    }

    console.log('\n=== B25 正向【codex 11-M2/M3 补】：真·未指派（developer_id=0）单 + 带附件补传 → DONE，附件版本按规则落 ===');
    {
        const f = await makePendingAssign();
        const pre = await dbGet('SELECT developer_id, submission_version FROM collab_requests WHERE id=?', [f.id]);
        ok('B25 夹具 developer_id=0（真未指派）', Number(pre.developer_id) === 0, JSON.stringify(pre));
        const res = await adminSubmit(f.id, adminToken, { reason: PENDING_REASON + '·未指派补传', withData: true, expectedStatus: 'PENDING_ASSIGN' });
        ok('B25 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status, submission_version, attachment_dir, developer_id FROM collab_requests WHERE id=?', [f.id]);
        ok('B25 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('B25 developer_id 仍为 0（闭环不代填开发，留痕真实）', Number(row.developer_id) === 0, JSON.stringify(row));
        const atts = await dbAll("SELECT submission_version, file_name, status FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('B25 active 附件恰 1', atts.length === 1, `got ${atts.length}`);
        const expVer = Number(pre.submission_version) || 1;
        ok(`B25 附件 submission_version = ${expVer}（规则算，未指派单同样适用）`,
            atts.length === 1 && Number(atts[0].submission_version) === expVer,
            `att=${atts.length === 1 ? atts[0].submission_version : 'n/a'}`);
        ok('B25 附件落在 attachment_dir 之下', atts.length === 1 && String(atts[0].file_name).includes(String(row.attachment_dir)), `${atts.length === 1 ? atts[0].file_name : 'n/a'} / ${row.attachment_dir}`);
        ok('B25 done_at_source=now', res.body && res.body.done_at_source === 'now', JSON.stringify(res.body && res.body.done_at_source));
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='ADMIN_SUBMIT_ON_BEHALF'", [f.id]);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('B25 flow=pending_assign_to_done_admin_closure', j.flow === 'pending_assign_to_done_admin_closure', j.flow);
            // codex 11 重点 6：done_at_source 此前只断言了响应体，日志里那份没人看——两处同源须一致
            ok('B25 日志 done_at_source 与响应体一致（同源=now）', j.done_at_source === 'now', String(j.done_at_source));
        } else {
            ok('B25 日志恰 1 条', false, `got ${logs.length}`);
        }
    }

    console.log('\n=== 清理测试单 ===');
    for (const id of created) { try { await fx.cleanup(id); } catch (e) { console.log(`  清理 #${id} 失败: ${e.message}`); } }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }

    console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
    if (fail > 0) { console.log('失败项：', fails.join(' | ')); process.exit(1); }
    console.log('✓ Commit B 全部通过\n');
}

main().catch(e => { console.error('脚本异常:', e); process.exit(1); });
