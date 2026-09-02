/**
 * submit-export 放开附件必填（大文件行政闭环）验证
 *
 * 背景：导出交付物可能是十几 G 大文件无法上传平台，只能线下传递。
 *   · v1.120.0 Commit A：放开 submit-export 附件必填，允许「无附件提交」——但仅限真直派单
 *     （assign_mode='admin_direct' && forwarded_to_exporter_at IS NULL），且无附件时概要必填 ≥10 字。
 *   · v1.164.2（2026-09-01）：无附件提交**放开到任意 EXPORTING 单的导出人本人**（守卫②废除）。
 *     触发实证 = 生产协作单 #45（normal 单经三级转发，大文件线下移交，三条到 DONE 的通道全被挡死）。
 *     概要必填条件相应扩为「真直派单（无论有无附件）|| 任意单无附件」。
 *     ⚠️ admin-submit-on-behalf 的 EXPORTING 分支仍要求真直派，本次**不放开**（防 admin 越过 exporter）。
 *
 * 覆盖（正向 = 应闭环成功；负向 = 应被拒且状态不变）：
 *   T1  正向：真直派单 + 无附件 + 概要≥10字 → 200 DONE + 概要落库 + 无新增附件行 + 日志字段
 *   T2  正向【v1.164.2 翻转】：normal 单（已三级转发·复刻 #45 形态）+ 无附件 + 概要≥10字 → 200 DONE
 *   T2b 负向【v1.164.2 新增】：normal 单 + 无附件 + 概要<10字 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT
 *   T2c 负向【v1.164.2 新增】：normal 单 + 无附件 + 不带概要 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT
 *   T3  负向：真直派单 + 无附件 + 概要<10字 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT
 *   T4  负向：真直派单 + 无附件 + 完全不带概要 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT
 *   T5  回归：真直派单 + 两附件齐全 + 概要≥10字 → 200 DONE（老路径不破，附件正常入库）
 *   T5b 负向：真直派单 + 两附件齐全 + 概要<10字 → 400（直派单有附件也必填概要）
 *   T5c 回归：normal 单 + 两附件齐全 + 无概要 → 200 DONE（有附件时 normal 概要仍可选）
 *   T6  负向：只传 1 个附件（半残）→ 400 PARTIAL_ATTACHMENTS
 *   T7  正向【v1.164.2 翻转】：admin_direct 但已被三级转发 + 无附件 + 概要≥10字 → 200 DONE
 *   T7b 正向【判据区分力】：admin_direct 但已被三级转发 + 两附件 + 无概要 → 200 DONE
 *        （与 T5b 成对：钉住 isGenuineDirectExporting 仍按双字段判定，被简化成单看 assign_mode 即判红）
 *   T8  正向：真直派单 forwarded_to_exporter_at IS NULL + 无附件 → DONE（HIGH-1 判据不误伤）
 *   T9  审计：无附件提交且单上无既有附件 → 日志 superseded_attachments 为空
 *   T10 正向：真直派单模拟 reassign 换人（forwarded 仍 NULL）+ 无附件 → DONE
 *   T11 审计：带 active 附件的真直派单无附件提交，审计正确显示未覆盖
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

    console.log('\n=== T2 正向【v1.164.2 放开·原为负向】：normal 单（已三级转发）+ 无附件 + 概要≥10字 → DONE ===');
    // ⚠️ 本用例 2026-09-01 由负向翻转为正向：原断言「normal 单无附件 → 400 NO_FILE_ONLY_FOR_DIRECT」，
    //   随 submit-export 守卫②废除而失效（错误码 NO_FILE_ONLY_FOR_DIRECT 已全仓不再产生）。
    //   夹具精确复刻生产协作单 #45 形态：assign_mode='normal' + forwarded_to_exporter_at 非 NULL
    //   （经三级转发到导出人），这正是放开前唯一无法闭环的组合。
    {
        const f = await makeExportingFixture('normal');
        await dbRun('UPDATE collab_requests SET forwarded_to_exporter_at=? WHERE id=?', ['2026-09-01 17:29:37', f.id]);
        const summary = '导出报表元素全量数据约 13G，文件过大无法上传平台，已通过内网共享盘线下移交业务方，平台只做闭环登记';
        const res = await submitExportNoFile(f.id, f.exporterToken, summary);
        ok('T2 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        ok('T2 current_status=DONE', res.body && res.body.current_status === 'DONE', JSON.stringify(res.body));
        const row = await dbGet('SELECT status, export_summary, done_at, sql_validation_status FROM collab_requests WHERE id=?', [f.id]);
        ok('T2 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('T2 export_summary 落库完整', row && row.export_summary === summary, `got: ${row && row.export_summary}`);
        ok('T2 done_at 已写', !!(row && row.done_at), JSON.stringify(row));
        ok('T2 sql_validation_status=admin_closed（行政闭环语义）', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
        const atts = await dbAll("SELECT * FROM collab_attachments WHERE collab_request_id=? AND status='active'", [f.id]);
        ok('T2 无新增 active 附件行', atts.length === 0, `got ${atts.length} 行`);
    }

    console.log('\n=== T2b 负向【v1.164.2 新增·防放开过头】：normal 单 + 无附件 + 概要<10字 → 400 EXPORT_SUMMARY_REQUIRED_DIRECT ===');
    // 放开「不限单类型」后，「无附件必须有概要留痕」成为唯一拦截线——必须有负向用例钉住，
    //   否则守卫③若被误写成只判 isGenuineDirectExporting，normal 单可无附件且无概要静默闭环（零留痕）。
    {
        const f = await makeExportingFixture('normal');
        const res = await submitExportNoFile(f.id, f.exporterToken, '太短了');
        ok('T2b 响应 400', res.status === 400, `got ${res.status} ${JSON.stringify(res.body)}`);
        ok('T2b code=EXPORT_SUMMARY_REQUIRED_DIRECT', res.body && res.body.code === 'EXPORT_SUMMARY_REQUIRED_DIRECT', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T2b 状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
    }

    console.log('\n=== T2c 负向【v1.164.2 新增·防放开过头】：normal 单 + 无附件 + 完全不带概要 → 400 ===');
    {
        const f = await makeExportingFixture('normal');
        const res = await submitExportNoFile(f.id, f.exporterToken, undefined);
        ok('T2c 响应 400', res.status === 400, `got ${res.status} ${JSON.stringify(res.body)}`);
        ok('T2c code=EXPORT_SUMMARY_REQUIRED_DIRECT', res.body && res.body.code === 'EXPORT_SUMMARY_REQUIRED_DIRECT', JSON.stringify(res.body));
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T2c 状态未变（仍 EXPORTING）', row && row.status === 'EXPORTING', JSON.stringify(row));
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

    console.log('\n=== T7 正向【v1.164.2 放开·原为负向】：admin_direct 单但已被三级转发 + 无附件 + 概要≥10字 → DONE ===');
    // ⚠️ 本用例 2026-09-01 由负向翻转为正向。原断言依据 codex 02 审 HIGH-1「fallback 后重新流转的
    //   admin_direct 单是正常流转语义，不该无附件闭环」——该收严意图**未被推翻，只是换了载体**：
    //   HIGH-1 真正要防的「admin 越过 exporter 闭环」仍由 admin-submit-on-behalf 的 EXPORTING 分支
    //   （仍要求 assign_mode='admin_direct' && forwarded_to_exporter_at IS NULL）原样守住。
    //   本端点恒由 ONLY_EXPORTER_CAN_SUBMIT 保证是 exporter 本人自助，无越权维度，故放开。
    {
        const f = await makeExportingFixture('admin_direct');
        // 造"已被三级转发"痕迹：设 forwarded_to_exporter_at
        await dbRun('UPDATE collab_requests SET forwarded_to_exporter_at=? WHERE id=?', ['2026-07-21 09:00:00', f.id]);
        const res = await submitExportNoFile(f.id, f.exporterToken, '这单曾 fallback 后重新流转，交付物为大文件线下移交，平台只做闭环登记');
        ok('T7 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status, sql_validation_status FROM collab_requests WHERE id=?', [f.id]);
        ok('T7 库内 status=DONE', row && row.status === 'DONE', JSON.stringify(row));
        ok('T7 sql_validation_status=admin_closed', row && row.sql_validation_status === 'admin_closed', JSON.stringify(row));
    }

    console.log('\n=== T7b 正向【judge 判据区分力】：admin_direct 单但已被三级转发 + 两附件齐全 + 无概要 → DONE（非真直派，概要可选）===');
    // 钉住 isGenuineDirectExporting 仍在按「assign_mode + forwarded_to_exporter_at」双字段判定：
    //   若有人把它简化成 assign_mode==='admin_direct'，本例会因概要必填被误拒 400 → 判红。
    //   与 T5b（真直派 + 两附件 + 概要<10字 → 400）成对，构成该判据的双向证明。
    {
        const f = await makeExportingFixture('admin_direct');
        await dbRun('UPDATE collab_requests SET forwarded_to_exporter_at=? WHERE id=?', ['2026-07-21 09:00:00', f.id]);
        const res = await submitExportWithFiles(f.id, f.exporterToken, { withData: true, withShot: true }); // 不传概要
        ok('T7b 响应 200', res.status === 200, `got ${res.status} ${JSON.stringify(res.body)}`);
        const row = await dbGet('SELECT status FROM collab_requests WHERE id=?', [f.id]);
        ok('T7b 库内 status=DONE（已转发的 admin_direct 单概要可选）', row && row.status === 'DONE', JSON.stringify(row));
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
