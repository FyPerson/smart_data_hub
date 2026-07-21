/**
 * v1.120.0 Commit A 验证：submit-export 放开附件必填（直派大文件行政闭环）
 *
 * 背景：直派单（assign_mode='admin_direct'）交付物可能是十几 G 大文件无法上传平台，
 *   只能线下传递。放开 submit-export 附件必填，允许「无附件提交」——但仅限直派单，
 *   且无附件时 export_summary 必填（≥10 字）。
 *
 * 覆盖：
 *   T1 正向：直派 EXPORTING 单 + 无附件 + 概要≥10字 → 200 DONE + export_summary 落库 + 无新增附件行
 *   T2 负向：normal 单（非直派）+ 无附件 → 400 NO_FILE_ONLY_FOR_DIRECT
 *   T3 负向：直派单 + 无附件 + 概要<10字 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT
 *   T4 负向：直派单 + 无附件 + 完全不带概要 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT
 *   T5 回归：直派单 + 两附件齐全 → 200 DONE（老路径不破，附件正常入库）
 *   T6 负向：直派单 + 只传 1 个附件（半残）→ 400 PARTIAL_ATTACHMENTS
 *
 * 前置：dev 服务器需在 BASE 运行（本脚本直改本地 dev 库，测完 cleanup）。
 * 运行：node scripts/verify-collab-direct-close-no-file.js
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

// 造一个 EXPORTING 单：先 createPendingFixture → 直改到 EXPORTING + exporter + assign_mode
async function makeExportingFixture(assignMode) {
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
    const exporterToken = await fx.signAs(EXPORTER_ID);
    return { ...f, exporterToken };
}

// 无附件提交：JSON body
async function submitExportNoFile(id, token, exportSummary) {
    const body = {};
    if (exportSummary !== undefined) body.export_summary = exportSummary;
    const opts = {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
    const r = await fetch(`${BASE}/api/collab/requests/${id}/submit-export`, opts);
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
}

// 有附件提交：multipart（result_data + result_data_screenshot [+ 可选只传一个]）
let tmpDir = null;
function mkFile(name, content) {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'directclose-'));
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, content);
    return p;
}
async function submitExportWithFiles(id, token, { withData = true, withShot = true, exportSummary } = {}) {
    const form = new FormData();
    if (withData) {
        const p = mkFile('result.xlsx', 'PK\x03\x04 fake xlsx');
        form.append('result_data', new Blob([fs.readFileSync(p)]), 'result.xlsx');
    }
    if (withShot) {
        const p = mkFile('shot.png', '\x89PNG\r\n fake png');
        form.append('result_data_screenshot', new Blob([fs.readFileSync(p)]), 'shot.png');
    }
    if (exportSummary !== undefined) form.append('export_summary', exportSummary);
    const r = await fetch(`${BASE}/api/collab/requests/${id}/submit-export`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
    });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
}

async function main() {
    // 预检：服务器可达
    try {
        await fetch(`${BASE}/`, { method: 'GET' });
    } catch (e) {
        console.error(`\n✗ 服务器不可达 ${BASE}，请先起 dev 服务：node server.js\n`);
        process.exit(2);
    }

    console.log('\n=== T1 正向：直派单 + 无附件 + 概要≥10字 → DONE ===');
    {
        const f = await makeExportingFixture('admin_direct');
        const summary = '导出全量客户明细约 13G，文件过大无法上传，已通过公司内网共享盘 \\\\fileserver\\export 线下移交给业务方';
        const res = await submitExportNoFile(f.id, f.exporterToken, summary);
        ok('T1 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        ok('T1 current_status=DONE', res.body && res.body.current_status === 'DONE', JSON.stringify(res.body));
        const row = await dbGet('SELECT status, export_summary, done_at FROM collab_requests WHERE id=?', [f.id]);
        ok('T1 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('T1 export_summary 落库完整', row && row.export_summary === summary, `got: ${row && row.export_summary}`);
        ok('T1 done_at 已写', !!(row && row.done_at), JSON.stringify(row));
        const atts = await dbAll("SELECT * FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('T1 无新增 active 附件行', atts.length === 0, `got ${atts.length} 行`);
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SUBMIT_EXPORT'", [f.id]);
        ok('T1 SUBMIT_EXPORT 日志恰 1 条', logs.length === 1, `got ${logs.length} 条`);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('T1 日志 flow=exporter_direct_done', j.flow === 'exporter_direct_done', j.flow);
            ok('T1 日志 has_summary=true', j.has_summary === true, JSON.stringify(j));
            ok('T1 日志 newly_uploaded 为空', Array.isArray(j.newly_uploaded) && j.newly_uploaded.length === 0, JSON.stringify(j.newly_uploaded));
        }
    }

    console.log('\n=== T2 负向：normal 单 + 无附件 → 400 NO_FILE_ONLY_FOR_DIRECT ===');
    {
        const f = await makeExportingFixture('normal');
        const res = await submitExportNoFile(f.id, f.exporterToken, '这是一段足够长的导出概要说明用于测试正常流转单被拒');
        ok('T2 响应 400', res.status === 400, `got ${res.status}`);
        ok('T2 code=NO_FILE_ONLY_FOR_DIRECT', res.body && res.body.code === 'NO_FILE_ONLY_FOR_DIRECT', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T2 状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
    }

    console.log('\n=== T3 负向：直派单 + 无附件 + 概要<10字 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT ===');
    {
        const f = await makeExportingFixture('admin_direct');
        const res = await submitExportNoFile(f.id, f.exporterToken, '太短了');
        ok('T3 响应 400', res.status === 400, `got ${res.status}`);
        ok('T3 code=EXPORT_SUMMARY_REQUIRED_DIRECT', res.body && res.body.code === 'EXPORT_SUMMARY_REQUIRED_DIRECT', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T3 状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
    }

    console.log('\n=== T4 负向：直派单 + 无附件 + 完全不带概要 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT ===');
    {
        const f = await makeExportingFixture('admin_direct');
        const res = await submitExportNoFile(f.id, f.exporterToken, undefined);
        ok('T4 响应 400', res.status === 400, `got ${res.status}`);
        ok('T4 code=EXPORT_SUMMARY_REQUIRED_DIRECT', res.body && res.body.code === 'EXPORT_SUMMARY_REQUIRED_DIRECT', JSON.stringify(res.body));
    }

    console.log('\n=== T5 回归：直派单 + 两附件齐全 + 概要≥10字 → DONE（老路径不破）===');
    {
        const f = await makeExportingFixture('admin_direct');
        const res = await submitExportWithFiles(f.id, f.exporterToken, { withData: true, withShot: true, exportSummary: '有附件的正常提交导出全量客户明细' });
        ok('T5 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T5 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        const atts = await dbAll("SELECT attachment_type FROM collab_attachments WHERE collab_request_id=? AND status='active' ORDER BY attachment_type", [f.id]);
        ok('T5 两附件入库（result_data + screenshot）', atts.length === 2, `got ${atts.length}: ${atts.map(a=>a.attachment_type).join(',')}`);
    }

    console.log('\n=== T5b【2026-07-21 概要必填】：直派单 + 两附件齐全 + 概要<10字 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT ===');
    {
        const f = await makeExportingFixture('admin_direct');
        const res = await submitExportWithFiles(f.id, f.exporterToken, { withData: true, withShot: true, exportSummary: '太短' });
        ok('T5b 响应 400', res.status === 400, `got ${res.status} ${JSON.stringify(res.body)}`);
        ok('T5b code=EXPORT_SUMMARY_REQUIRED_DIRECT', res.body && res.body.code === 'EXPORT_SUMMARY_REQUIRED_DIRECT', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T5b 状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
    }

    console.log('\n=== T5c【回归】：normal 单 + 两附件齐全 + 无概要 → DONE（非直派单概要仍可选）===');
    {
        const f = await makeExportingFixture('normal');
        const res = await submitExportWithFiles(f.id, f.exporterToken, { withData: true, withShot: true }); // 不传概要
        ok('T5c 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T5c 库内 status=DONE（normal 概要可选不阻塞）', row && row.status === 'DONE', JSON.stringify(row));
    }

    console.log('\n=== T6 负向：直派单 + 只传 1 个附件 → 400 PARTIAL_ATTACHMENTS ===');
    {
        const f = await makeExportingFixture('admin_direct');
        const res = await submitExportWithFiles(f.id, f.exporterToken, { withData: true, withShot: false, exportSummary: '只传了 result_data' });
        ok('T6 响应 400', res.status === 400, `got ${res.status}`);
        ok('T6 code=PARTIAL_ATTACHMENTS', res.body && res.body.code === 'PARTIAL_ATTACHMENTS', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T6 状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
    }

    console.log('\n=== T7 负向【HIGH-1 收严】：admin_direct 单但已被三级转发（forwarded_to_exporter_at 非 NULL）+ 无附件 → 400 NO_FILE_ONLY_FOR_DIRECT ===');
    // 模拟绕过链：admin_direct 单 fallback 切回流转后重新 forward-to-exporter 到 EXPORTING，
    // 此时 assign_mode 仍 admin_direct 但 forwarded_to_exporter_at 非 NULL → 应被守卫识破拒绝
    {
        const f = await makeExportingFixture('admin_direct');
        // 造"已被三级转发"痕迹：设 forwarded_to_exporter_at
        await dbRun('UPDATE collab_requests SET forwarded_to_exporter_at=? WHERE id=?', ['2026-07-21 09:00:00', f.id]);
        const res = await submitExportNoFile(f.id, f.exporterToken, '这单曾 fallback 后重新流转，实际是正常流转语义，不该无附件闭环');
        ok('T7 响应 400', res.status === 400, `got ${res.status} ${JSON.stringify(res.body)}`);
        ok('T7 code=NO_FILE_ONLY_FOR_DIRECT', res.body && res.body.code === 'NO_FILE_ONLY_FOR_DIRECT', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T7 状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
    }

    console.log('\n=== T8 正向【HIGH-1 判据不误伤】：真直派单 forwarded_to_exporter_at IS NULL + 无附件 → DONE ===');
    // 确认收严判据不误伤真直派单（create 即 EXPORTING，从未 forward，forwarded_to_exporter_at 恒 NULL）
    {
        const f = await makeExportingFixture('admin_direct');
        const row0 = await dbGet('SELECT forwarded_to_exporter_at FROM collab_requests WHERE id=?', [f.id]);
        ok('T8 前置：真直派单 forwarded_to_exporter_at IS NULL', row0 && row0.forwarded_to_exporter_at == null, JSON.stringify(row0));
        const res = await submitExportNoFile(f.id, f.exporterToken, '真直派单十几G大文件线下移交，走内网共享盘给业务方');
        ok('T8 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T8 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
    }

    console.log('\n=== T9【MED-2 审计不失真】：无附件提交且单上无既有附件 → 日志 superseded_attachments 为空 ===');
    {
        const f = await makeExportingFixture('admin_direct');
        const res = await submitExportNoFile(f.id, f.exporterToken, '无附件提交审计校验，确认不误报已覆盖附件');
        ok('T9 响应 200', res.status === 200, `got ${res.status}`);
        ok('T9 响应 superseded_attachments 为空', res.body && Array.isArray(res.body.superseded_attachments) && res.body.superseded_attachments.length === 0, JSON.stringify(res.body && res.body.superseded_attachments));
        const logs = await dbAll("SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='SUBMIT_EXPORT'", [f.id]);
        if (logs.length === 1) {
            const j = JSON.parse(logs[0].reason);
            ok('T9 日志 superseded_attachments 为空', Array.isArray(j.superseded_attachments) && j.superseded_attachments.length === 0, JSON.stringify(j.superseded_attachments));
        } else { ok('T9 日志恰 1 条', false, `got ${logs.length}`); }
    }

    console.log('\n=== T10 正向【codex复审 MED-2：reassign 换人不误伤】：真直派单模拟 reassign 换人（forwarded 仍 NULL）+ 无附件 → DONE ===');
    // admin-direct-reassign 只换 exporter、不动 forwarded_to_exporter_at，换人后仍是真直派单，应仍能无附件闭环
    {
        const f = await makeExportingFixture('admin_direct');
        // 模拟 reassign：换 exporter 但 forwarded_to_exporter_at 保持 NULL（reassign 的真实行为）
        const otherExporter = await dbGet("SELECT id, display_name FROM users WHERE role IN ('user','publisher') AND id!=? LIMIT 1", [EXPORTER_ID]);
        if (otherExporter) {
            await dbRun('UPDATE collab_requests SET exporter_user_id=?, exporter_name=? WHERE id=?', [otherExporter.id, otherExporter.display_name, f.id]);
            const newToken = await fx.signAs(otherExporter.id);
            const row0 = await dbGet('SELECT forwarded_to_exporter_at FROM collab_requests WHERE id=?', [f.id]);
            ok('T10 前置：reassign 后 forwarded 仍 NULL', row0 && row0.forwarded_to_exporter_at == null, JSON.stringify(row0));
            const res = await submitExportNoFile(f.id, newToken, '改派后的新导出人提交，大文件线下移交业务方');
            ok('T10 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
            const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
            ok('T10 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        } else {
            console.log('  (跳过 T10：无第二个 user/publisher 账号)');
        }
    }

    console.log('\n=== T11【codex复审 MED-3：带 active 附件的真直派单无附件提交，审计正确显示未覆盖】===');
    // 极端边界：真直派单若存在 active 附件（正常不可达，防御性验证），无附件提交时
    // 日志/响应的 superseded_attachments 应为空（如实反映"本次未覆盖任何附件"，不误报）
    {
        const f = await makeExportingFixture('admin_direct');
        // 人为塞一条 active result_data 附件（模拟异常残留）
        await dbRun(
            `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, submission_version, status)
             VALUES (?, 'result_data', 'collab/_test/preexist.xlsx', '预存附件.xlsx', ?, 'tester', 1, 'active')`,
            [f.id, EXPORTER_ID]
        );
        const res = await submitExportNoFile(f.id, f.exporterToken, '带预存附件的真直派单无附件提交，审计应显示未覆盖');
        ok('T11 响应 200', res.status === 200, `got ${res.status}`);
        ok('T11 响应 superseded_attachments 为空（未误报覆盖）', res.body && Array.isArray(res.body.superseded_attachments) && res.body.superseded_attachments.length === 0, JSON.stringify(res.body && res.body.superseded_attachments));
        // 预存的 active 附件应仍 active（无附件路径不 supersede，如实保留）
        const stillActive = await dbAll("SELECT id FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('T11 预存 active 附件仍保留（无附件路径不动附件）', stillActive.length === 1, `got ${stillActive.length}`);
    }

    // cleanup
    console.log('\n=== 清理测试单 ===');
    for (const id of created) {
        try { await fx.cleanup(id); } catch (e) { console.log(`  清理 #${id} 失败: ${e.message}`); }
    }
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }

    console.log(`\n========== 结果：${pass} 通过 / ${fail} 失败 ==========`);
    if (fail > 0) { console.log('失败项：', fails.join(' | ')); process.exit(1); }
    console.log('✓ Commit A 全部通过\n');
}

main().catch(e => { console.error('脚本异常:', e); process.exit(1); });
