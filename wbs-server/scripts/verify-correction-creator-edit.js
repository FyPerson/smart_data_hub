/**
 * 数据修正 · 建单人编辑权限（E3）权限矩阵 e2e（2026-07-23）
 *
 * 用法：node scripts/verify-correction-creator-edit.js
 * 前置：本地 server 已启动（默认 localhost:3000，可用 TEST_BASE_URL 覆盖，如 http://localhost:3100）
 *
 * 覆盖：
 *   PUT /api/corrections/:id
 *     1. admin 编辑自发现单 → 200 + history 同态留痕（from=to）+ 持久化 + can_edit 投影
 *     2. H-1 比对制：全同值 → updated:0 且不新增 history
 *     3. 权限矩阵：建单人(user) 200 / 非建单人 user 403 / viewer 403 / publisher 403
 *     4. 输入面四防线：数组 body 400 / 空对象 400 / location_info null·'' 400 / reason null 400
 *     5. OA 不进白名单：仅传 oa_number → 400 NO_EDITABLE_FIELDS（字段被忽略）
 *     6. correction_count：single 锁 1（改值 400 / 同值 no-op）；batch 改值 200 / <2 400 / 非法 400
 *     7. source_system：非白名单 400 / 其他缺说明 400 / 其他+说明 200 / 切回非其他 → other 归 NULL
 *     8. expected_deadline：非法 400 / 合法改值 200 / null 清空
 *     9. requesters 现有行：改姓名电话 200 + 子表持久化 + 主业务方同步主表兼容列 / 未知行 400 /
 *        重复行 400 / 空名 400 / requester_dept 改 200
 *    10. 自发现锁：requester_dept / requesters 变更 → 400 SELF_DISCOVERED_REQUESTER_LOCKED
 *    11. 终态锁：ARCHIVED 409 / voided 409（admin 也不例外）
 *    12. 跨系统子单：error_proof_note 409 / requesters 409 / 撞主单系统 400 / 自身 location_info 200
 *   DELETE /api/corrections/:id/attachments/:attId
 *    13. 建单人删 error_proof → 200 + DB 行删 + 物理文件删 + history 留痕；fix_proof/oa_proof 409；
 *        非建单人 403；单不匹配 404；终态单 409
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

const dbGet = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbAll = (db, sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (db, sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

async function api(method, urlPath, token, body) {
    const res = await fetch(`${BASE}${urlPath}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

// DB 直插修正单（绕开 POST 仅 admin/multipart 限制，造 creator=user、真OA、终态、组单等形态）
async function seedCorrection(db, o) {
    const r = await dbRun(db,
        `INSERT INTO correction_requests
            (source_system, source_system_other, location_info, correction_count, reason, oa_number, process_type,
             correction_type, requester_dept, requester_name, requester_phone, status, created_by, created_by_name,
             correction_group_id, error_proof_note, voided_at, expected_deadline)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [o.source_system || 'BMS', o.source_system_other || null, o.location_info || 'E3-seed 修正方式',
         o.correction_count != null ? o.correction_count : 1, o.reason || 'E3-seed 原因', o.oa_number || null,
         o.process_type || null, o.correction_type || 'single', o.requester_dept || null,
         o.requester_name || 'E3业务方', o.requester_phone || null, o.status || 'PENDING_ASSIGN',
         o.created_by, o.created_by_name || `用户#${o.created_by}`, o.correction_group_id || null,
         o.error_proof_note || null, o.voided_at || null, o.expected_deadline || null]);
    return r.lastID;
}
async function seedRequester(db, rid, name, phone, isPrimary, seq) {
    const r = await dbRun(db,
        `INSERT INTO correction_requesters (correction_request_id, requester_name, requester_phone, is_primary, seq)
         VALUES (?,?,?,?,?)`, [rid, name, phone, isPrimary ? 1 : 0, seq]);
    return r.lastID;
}
async function seedAttachment(db, rid, type, fileName, originalName, uploadedBy) {
    const r = await dbRun(db,
        `INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name)
         VALUES (?,?,?,?,?,?)`, [rid, type, fileName, originalName, uploadedBy, `用户#${uploadedBy}`]);
    return r.lastID;
}
async function lastHistory(db, rid) {
    return dbGet(db, 'SELECT from_status, to_status, reason, operator_id FROM correction_status_history WHERE correction_request_id = ? ORDER BY id DESC LIMIT 1', [rid]);
}
async function historyCount(db, rid) {
    const r = await dbGet(db, 'SELECT COUNT(*) AS c FROM correction_status_history WHERE correction_request_id = ?', [rid]);
    return r.c;
}

(async () => {
    console.log('=== 数据修正 建单人编辑权限（E3）权限矩阵 e2e ===\n');
    const db = new sqlite3.Database(DB_PATH);
    const created = [];       // correction ids（清理用）
    const tmpFiles = [];      // 物理临时文件
    try {
        const adminToken = await fx.signAs(fx.ADMIN_ID);       // id=1 admin
        const userToken = await fx.signAs(fx.CONTACT_ID);      // id=3 user（建单人）
        const otherToken = await fx.signAs(fx.DEV1_ID);        // id=19 user（非建单人）
        const viewerToken = await fx.signAs(fx.VIEWER_ID);     // id=2 viewer
        const pubToken = await fx.signAs(fx.PUBLISHER_ID);     // id=7 publisher

        // ---- 1. admin API 建单（自发现留空 OA）+ 基础编辑 + 留痕 + 投影 ----
        console.log('1. admin 编辑自发现单 + 同态留痕 + can_edit 投影');
        let r = await api('POST', '/api/corrections', adminToken, {
            source_system: 'BMS', correction_type: 'single', location_info: 'E3-初始修正方式', reason: 'E3-初始原因'
        });
        expect(r.status === 200, `admin 建单成功（${r.status}${r.json.error ? '：' + r.json.error : ''}）`);
        const idA = r.json.id; created.push(idA);
        const histBase = await historyCount(db, idA);
        r = await api('PUT', `/api/corrections/${idA}`, adminToken, { location_info: 'E3-已编辑修正方式', reason: 'E3-已编辑原因', process_type: '月结流程' });
        expect(r.status === 200 && r.json.updated === 3, `admin 编辑 3 字段 → 200 updated=3（实际 ${r.status}/${r.json.updated}：${r.json.error || 'ok'}）`);
        let row = await dbGet(db, 'SELECT * FROM correction_requests WHERE id = ?', [idA]);
        expect(row.location_info === 'E3-已编辑修正方式' && row.reason === 'E3-已编辑原因' && row.process_type === '月结流程', '编辑字段持久化');
        let h = await lastHistory(db, idA);
        expect(h && h.from_status === 'PENDING_ASSIGN' && h.to_status === 'PENDING_ASSIGN' && /编辑录入信息/.test(h.reason) && /修正方式/.test(h.reason), `history 同态留痕（${h && h.reason}）`);
        expect(await historyCount(db, idA) === histBase + 1, 'history 净增 1 行');
        r = await api('GET', `/api/corrections/${idA}`, adminToken);
        expect(r.json.can_edit === true, '详情投影 can_edit=true');

        // ---- 2. 比对制全同值 no-op ----
        console.log('\n2. 比对制全同值 no-op');
        const histBefore = await historyCount(db, idA);
        r = await api('PUT', `/api/corrections/${idA}`, adminToken, { location_info: 'E3-已编辑修正方式', reason: 'E3-已编辑原因' });
        expect(r.status === 200 && r.json.updated === 0, `全同值 → 200 updated:0（实际 ${r.status}/${r.json.updated}）`);
        expect(await historyCount(db, idA) === histBefore, '全同值不新增 history');

        // ---- 3. 权限矩阵 ----
        console.log('\n3. 权限矩阵');
        const idB = await seedCorrection(db, { created_by: fx.CONTACT_ID, oa_number: null });
        created.push(idB);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { location_info: '建单人自改' });
        expect(r.status === 200, `建单人(user)编辑自己的单 → 200（实际 ${r.status}：${r.json.error || 'ok'}）`);
        r = await api('PUT', `/api/corrections/${idB}`, otherToken, { location_info: 'hack' });
        expect(r.status === 403, `非建单人 user → 403（实际 ${r.status}）`);
        r = await api('PUT', `/api/corrections/${idB}`, viewerToken, { location_info: 'hack' });
        expect(r.status === 403, `viewer → 403（实际 ${r.status}）`);
        r = await api('PUT', `/api/corrections/${idB}`, pubToken, { location_info: 'hack' });
        expect(r.status === 403, `publisher（非建单人）→ 403（实际 ${r.status}）`);
        // M-3（首审）：列表与详情可见性对齐——建单人在列表能看到自己创建的未指派单
        r = await api('GET', '/api/corrections', userToken);
        expect(r.status === 200 && Array.isArray(r.json.items) && r.json.items.some(x => Number(x.id) === idB), 'M-3：建单人列表可见自己创建的未指派单');
        r = await api('GET', '/api/corrections', otherToken);
        expect(r.status === 200 && !r.json.items.some(x => Number(x.id) === idB), 'M-3：非建单人 user 列表仍不可见该单');

        // ---- 4. 输入面四防线 ----
        console.log('\n4. 输入面');
        r = await api('PUT', `/api/corrections/${idB}`, userToken, [1, 2]);
        expect(r.status === 400 && r.json.code === 'INVALID_BODY', `数组 body → 400 INVALID_BODY（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, {});
        expect(r.status === 400 && r.json.code === 'NO_EDITABLE_FIELDS', `空对象 → 400 NO_EDITABLE_FIELDS（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { location_info: null });
        expect(r.status === 400, `location_info:null → 400（实际 ${r.status}）`);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { location_info: '   ' });
        expect(r.status === 400, `location_info 空白 → 400（实际 ${r.status}）`);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { reason: null });
        expect(r.status === 400 && r.json.code === 'REASON_REQUIRED', `reason:null → 400 REASON_REQUIRED（实际 ${r.status}/${r.json.code}）`);

        // ---- 5. OA 不进白名单 ----
        console.log('\n5. OA 不进白名单');
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { oa_number: '999888' });
        expect(r.status === 400 && r.json.code === 'NO_EDITABLE_FIELDS', `仅传 oa_number → 400 NO_EDITABLE_FIELDS（OA 被忽略，实际 ${r.status}/${r.json.code}）`);
        row = await dbGet(db, 'SELECT oa_number FROM correction_requests WHERE id = ?', [idB]);
        expect(row.oa_number == null, 'oa_number 未被写入');

        // ---- 6. correction_count ----
        console.log('\n6. correction_count');
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { correction_count: 2 });
        expect(r.status === 400 && r.json.code === 'COUNT_LOCKED_FOR_SINGLE', `single 改条数 → 400 COUNT_LOCKED_FOR_SINGLE（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { correction_count: '1' });
        expect(r.status === 400 && r.json.code === 'NO_EDITABLE_FIELDS' || (r.status === 200 && r.json.updated === 0), `single 条数同值 1 → no-op（实际 ${r.status}/${r.json.updated ?? r.json.code}）`);
        const idC = await seedCorrection(db, { created_by: fx.CONTACT_ID, correction_type: 'batch', correction_count: 5 });
        created.push(idC);
        r = await api('PUT', `/api/corrections/${idC}`, userToken, { correction_count: '8' });
        expect(r.status === 200 && r.json.updated === 1, `batch 改条数 5→8 → 200（实际 ${r.status}）`);
        row = await dbGet(db, 'SELECT correction_count FROM correction_requests WHERE id = ?', [idC]);
        expect(Number(row.correction_count) === 8, 'batch 条数持久化 =8');
        r = await api('PUT', `/api/corrections/${idC}`, userToken, { correction_count: '1' });
        expect(r.status === 400 && r.json.code === 'BATCH_COUNT_MIN', `batch 条数 1 → 400 BATCH_COUNT_MIN（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idC}`, userToken, { correction_count: 'abc' });
        expect(r.status === 400 && r.json.code === 'INVALID_CORRECTION_COUNT', `batch 条数非法 → 400（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idC}`, userToken, { correction_count: [8] });
        expect(r.status === 400 && r.json.code === 'INVALID_CORRECTION_COUNT', `L-5：条数嵌套数组 [8] → 400（实际 ${r.status}/${r.json.code}）`);

        // ---- 7. source_system ----
        console.log('\n7. source_system 成对校验');
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { source_system: '不存在系统' });
        expect(r.status === 400 && r.json.code === 'INVALID_SOURCE_SYSTEM', `非白名单 → 400（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { source_system: '其他' });
        expect(r.status === 400 && r.json.code === 'SOURCE_SYSTEM_OTHER_REQUIRED', `其他缺说明 → 400（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { source_system: '其他', source_system_other: 'E3自建系统' });
        expect(r.status === 200, `其他+说明 → 200（实际 ${r.status}）`);
        row = await dbGet(db, 'SELECT source_system, source_system_other FROM correction_requests WHERE id = ?', [idB]);
        expect(row.source_system === '其他' && row.source_system_other === 'E3自建系统', '其他+说明持久化');
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { source_system: 'CRM' });
        expect(r.status === 200, `切回 CRM → 200（实际 ${r.status}）`);
        row = await dbGet(db, 'SELECT source_system, source_system_other FROM correction_requests WHERE id = ?', [idB]);
        expect(row.source_system === 'CRM' && row.source_system_other == null, '非「其他」时 other 归 NULL（不变量）');

        // ---- 8. expected_deadline ----
        console.log('\n8. expected_deadline');
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { expected_deadline: '2026-13-99 10:00' });
        expect(r.status === 400 && r.json.code === 'INVALID_EXPECTED_DEADLINE', `非法日期 → 400（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { expected_deadline: '2026-08-01 10:00' });
        expect(r.status === 200, `合法改值 → 200（实际 ${r.status}）`);
        row = await dbGet(db, 'SELECT expected_deadline FROM correction_requests WHERE id = ?', [idB]);
        expect(row.expected_deadline === '2026-08-01 10:00:00', `分钟精度归一为秒（实际 ${row.expected_deadline}）`);
        r = await api('PUT', `/api/corrections/${idB}`, userToken, { expected_deadline: null });
        expect(r.status === 200, `null 清空 → 200（实际 ${r.status}）`);
        row = await dbGet(db, 'SELECT expected_deadline FROM correction_requests WHERE id = ?', [idB]);
        expect(row.expected_deadline == null, '清空持久化');

        // ---- 9. requesters 现有行编辑（真OA单）----
        console.log('\n9. requesters 现有行编辑');
        const idD = await seedCorrection(db, { created_by: fx.CONTACT_ID, oa_number: '364265', requester_name: '张三', requester_phone: '13800000001', requester_dept: '财务共享服务中心' });
        created.push(idD);
        const rq1 = await seedRequester(db, idD, '张三', '13800000001', true, 1);
        const rq2 = await seedRequester(db, idD, '李四', null, false, 2);
        r = await api('PUT', `/api/corrections/${idD}`, userToken, { requesters: [{ id: rq1, name: '张三改', phone: '13900000009' }, { id: rq2, name: '李四', phone: '13700000007' }] });
        expect(r.status === 200 && r.json.updated >= 2, `改主行姓名电话+次行电话 → 200（实际 ${r.status}/${r.json.updated}）`);
        let rqRow = await dbGet(db, 'SELECT requester_name, requester_phone FROM correction_requesters WHERE id = ?', [rq1]);
        expect(rqRow.requester_name === '张三改' && rqRow.requester_phone === '13900000009', '主行子表持久化');
        row = await dbGet(db, 'SELECT requester_name, requester_phone FROM correction_requests WHERE id = ?', [idD]);
        expect(row.requester_name === '张三改' && row.requester_phone === '13900000009', '主业务方同步主表兼容列（写读同源）');
        h = await lastHistory(db, idD);
        expect(h && /业务方#1姓名/.test(h.reason) && /业务方#2电话/.test(h.reason), `history 记行级标签（${h && h.reason}）`);
        r = await api('PUT', `/api/corrections/${idD}`, userToken, { requesters: [{ id: 999999, name: 'x' }] });
        expect(r.status === 400 && r.json.code === 'REQUESTER_ROW_NOT_FOUND', `未知行 → 400（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idD}`, userToken, { requesters: [{ id: rq1, name: 'a' }, { id: rq1, name: 'b' }] });
        expect(r.status === 400 && r.json.code === 'REQUESTER_ROW_DUPLICATE', `重复行 → 400（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idD}`, userToken, { requesters: [{ id: rq1, name: '  ' }] });
        expect(r.status === 400 && r.json.code === 'REQUESTER_NAME_REQUIRED', `空名 → 400（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idD}`, userToken, { requester_dept: '人力资源部' });
        expect(r.status === 200, `真OA单改部门 → 200（实际 ${r.status}）`);
        row = await dbGet(db, 'SELECT requester_dept FROM correction_requests WHERE id = ?', [idD]);
        expect(row.requester_dept === '人力资源部', '部门持久化');

        // ---- 9b. HIGH-1 手机号变更重置通知 + MED-2 phone 分层 ----
        console.log('\n9b. 手机号变更通知重置（HIGH-1）+ phone 缺省分层（MED-2）');
        await dbRun(db, `UPDATE correction_requesters SET completion_notify_status='sent', completion_notified_at='2026-07-23 09:00:00', completion_notify_message_key='mk-old', completion_read_at='2026-07-23 09:30:00' WHERE id = ?`, [rq1]);
        await dbRun(db, `UPDATE correction_requests SET requester_notify_status='sent', requester_notified_at='2026-07-23 09:00:00', requester_notify_message_key='mk-est-old', requester_read_at='2026-07-23 09:10:00', completion_notify_status='sent', completion_notified_at='2026-07-23 09:05:00', completion_notify_message_key='mk-done-old' WHERE id = ?`, [idD]);
        r = await api('PUT', `/api/corrections/${idD}`, userToken, { requesters: [{ id: rq1, name: '张三再改' }] });
        expect(r.status === 200, `仅传 name（缺省 phone）→ 200（实际 ${r.status}）`);
        rqRow = await dbGet(db, 'SELECT requester_name, requester_phone, completion_notify_status, completion_notify_message_key FROM correction_requesters WHERE id = ?', [rq1]);
        expect(rqRow.requester_name === '张三再改' && rqRow.requester_phone === '13900000009', 'MED-2：缺省 phone 不清空手机号（未提供=不修改）');
        expect(rqRow.completion_notify_status === 'sent' && rqRow.completion_notify_message_key === 'mk-old', '仅改姓名不重置通知状态（收件人锚=手机号）');
        r = await api('PUT', `/api/corrections/${idD}`, userToken, { requesters: [{ id: rq1, name: '张三再改', phone: '13600000006' }] });
        expect(r.status === 200, `改主行手机号 → 200（实际 ${r.status}）`);
        rqRow = await dbGet(db, 'SELECT requester_phone, completion_notify_status, completion_notified_at, completion_notify_message_key, completion_read_at FROM correction_requesters WHERE id = ?', [rq1]);
        expect(rqRow.requester_phone === '13600000006' && rqRow.completion_notify_status === 'not_sent' && rqRow.completion_notified_at == null && rqRow.completion_notify_message_key == null && rqRow.completion_read_at == null, 'HIGH-1：行完成通知四件套+已读全重置');
        row = await dbGet(db, 'SELECT requester_phone, requester_notify_status, requester_notified_at, requester_notify_message_key, requester_read_at, completion_notify_status, completion_notified_at, completion_notify_message_key FROM correction_requests WHERE id = ?', [idD]);
        expect(row.requester_phone === '13600000006' && row.requester_notify_status === 'not_sent' && row.requester_notified_at == null && row.requester_notify_message_key == null && row.requester_read_at == null, 'HIGH-1：主表预计通知四件套+已读全重置（主业务方）');
        expect(row.completion_notify_status === 'not_sent' && row.completion_notified_at == null && row.completion_notify_message_key == null, 'L-1（二审）：主表完成通知兼容列同步重置（归档弹窗读主表）');
        h = await lastHistory(db, idD);
        expect(/通知状态已重置/.test(h.reason), `history 标注通知重置（${h && h.reason}）`);

        // ---- 10. 自发现锁 ----
        console.log('\n10. 自发现单业务方锁定');
        r = await api('PUT', `/api/corrections/${idA}`, adminToken, { requester_dept: '财务部' });
        expect(r.status === 400 && r.json.code === 'SELF_DISCOVERED_REQUESTER_LOCKED', `自发现改部门 → 400（实际 ${r.status}/${r.json.code}）`);
        const rqSelf = await dbGet(db, 'SELECT id FROM correction_requesters WHERE correction_request_id = ? AND is_primary = 1', [idA]);
        r = await api('PUT', `/api/corrections/${idA}`, adminToken, { requesters: [{ id: rqSelf.id, name: '改名' }] });
        expect(r.status === 400 && r.json.code === 'SELF_DISCOVERED_REQUESTER_LOCKED', `自发现改业务方行 → 400（实际 ${r.status}/${r.json.code}）`);

        // ---- 11. 终态锁 ----
        console.log('\n11. 终态锁');
        const idE = await seedCorrection(db, { created_by: fx.CONTACT_ID, status: 'ARCHIVED' });
        created.push(idE);
        r = await api('PUT', `/api/corrections/${idE}`, userToken, { location_info: 'x' });
        expect(r.status === 409 && r.json.code === 'TERMINAL_STATE_LOCKED', `ARCHIVED → 409（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idE}`, adminToken, { location_info: 'x' });
        expect(r.status === 409, `ARCHIVED admin 也 409（实际 ${r.status}）`);
        r = await api('GET', `/api/corrections/${idE}`, adminToken);
        expect(r.json.can_edit === false, 'ARCHIVED 投影 can_edit=false');
        const idF = await seedCorrection(db, { created_by: fx.CONTACT_ID, voided_at: '2026-07-23 10:00:00', status: 'VOIDED' });
        created.push(idF);
        r = await api('PUT', `/api/corrections/${idF}`, adminToken, { location_info: 'x' });
        expect(r.status === 409 && r.json.code === 'VOIDED_LOCKED', `已作废 → 409 VOIDED_LOCKED（实际 ${r.status}/${r.json.code}）`);

        // ---- 12. 跨系统子单 ----
        console.log('\n12. 跨系统子单守卫');
        const idG = await seedCorrection(db, { created_by: fx.CONTACT_ID, source_system: 'BMS' });
        created.push(idG);
        await dbRun(db, 'UPDATE correction_requests SET correction_group_id = ? WHERE id = ?', [idG, idG]);
        await seedRequester(db, idG, '组主业务方', null, true, 1);
        const idH = await seedCorrection(db, { created_by: fx.CONTACT_ID, source_system: 'CRM', correction_group_id: idG });
        created.push(idH);
        r = await api('PUT', `/api/corrections/${idH}`, userToken, { error_proof_note: '子单想改说明' });
        expect(r.status === 409 && r.json.code === 'ERROR_PROOF_ON_MASTER_ONLY', `子单改 error_proof_note → 409（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idH}`, userToken, { requesters: [{ id: 1, name: 'x' }] });
        expect(r.status === 409 && r.json.code === 'REQUESTERS_ON_MASTER_ONLY', `子单改业务方 → 409（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idH}`, userToken, { source_system: 'BMS' });
        expect(r.status === 400 && r.json.code === 'CROSS_SYSTEM_SAME_SYSTEM', `子单撞主单系统 → 400（实际 ${r.status}/${r.json.code}）`);
        r = await api('PUT', `/api/corrections/${idH}`, userToken, { location_info: '子单自身修正方式可改' });
        expect(r.status === 200, `子单改自身 location_info → 200（实际 ${r.status}）`);

        // ---- 13. 附件删除 ----
        console.log('\n13. DELETE 待修复数据附件');
        const attDir = path.join(UPLOAD_ROOT, 'correction', String(idD));
        fs.mkdirSync(attDir, { recursive: true });
        const f1 = path.join(attDir, 'e3-del-test.png');
        fs.writeFileSync(f1, 'fake-png'); tmpFiles.push(f1);
        const att1 = await seedAttachment(db, idD, 'error_proof', `correction/${idD}/e3-del-test.png`, 'e3-del-test.png', fx.CONTACT_ID);
        const att2 = await seedAttachment(db, idD, 'fix_proof', `correction/${idD}/e3-fix.png`, 'e3-fix.png', fx.DEV1_ID);
        const att3 = await seedAttachment(db, idD, 'oa_proof', `correction/${idD}/e3-oa.png`, 'e3-oa.png', fx.CONTACT_ID);
        r = await api('DELETE', `/api/corrections/${idD}/attachments/${att2}`, userToken);
        expect(r.status === 409 && r.json.code === 'ATTACHMENT_TYPE_NOT_DELETABLE', `fix_proof → 409（实际 ${r.status}/${r.json.code}）`);
        r = await api('DELETE', `/api/corrections/${idD}/attachments/${att3}`, userToken);
        expect(r.status === 409 && r.json.code === 'ATTACHMENT_TYPE_NOT_DELETABLE', `oa_proof → 409（实际 ${r.status}/${r.json.code}）`);
        r = await api('DELETE', `/api/corrections/${idD}/attachments/${att1}`, otherToken);
        expect(r.status === 403, `非建单人删 error_proof → 403（实际 ${r.status}）`);
        r = await api('DELETE', `/api/corrections/${idD}/attachments/${att2}`, otherToken);
        expect(r.status === 403, `L-4：非建单人删 fix_proof → 403（鉴权先于类型披露，实际 ${r.status}）`);
        r = await api('DELETE', `/api/corrections/${idB}/attachments/${att1}`, userToken);
        expect(r.status === 404, `附件不属于该单 → 404（实际 ${r.status}）`);
        const histD = await historyCount(db, idD);
        r = await api('DELETE', `/api/corrections/${idD}/attachments/${att1}`, userToken);
        expect(r.status === 200 && r.json.ok === true, `建单人删 error_proof → 200（实际 ${r.status}：${r.json.error || 'ok'}）`);
        const attGone = await dbGet(db, 'SELECT id FROM correction_attachments WHERE id = ?', [att1]);
        expect(!attGone, 'DB 行已删');
        expect(!fs.existsSync(f1), '物理文件已删');
        h = await lastHistory(db, idD);
        expect(await historyCount(db, idD) === histD + 1 && /删除待修复数据附件/.test(h.reason) && /e3-del-test\.png/.test(h.reason), `history 留痕（${h && h.reason}）`);
        // 终态单附件不可删
        const attE = await seedAttachment(db, idE, 'error_proof', `correction/${idE}/e3-arch.png`, 'e3-arch.png', fx.CONTACT_ID);
        r = await api('DELETE', `/api/corrections/${idE}/attachments/${attE}`, userToken);
        expect(r.status === 409 && r.json.code === 'TERMINAL_STATE_LOCKED', `终态单附件 → 409（实际 ${r.status}/${r.json.code}）`);

        console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
    } catch (e) {
        console.error('\n💥 执行异常:', e && e.message);
        fail++;
    } finally {
        // 清理：附件 → 业务方行 → history → 主表；临时文件/目录
        try {
            for (const id of created) {
                await dbRun(db, 'DELETE FROM correction_attachments WHERE correction_request_id = ?', [id]);
                await dbRun(db, 'DELETE FROM correction_requesters WHERE correction_request_id = ?', [id]);
                await dbRun(db, 'DELETE FROM correction_status_history WHERE correction_request_id = ?', [id]);
                await dbRun(db, 'DELETE FROM correction_requests WHERE id = ?', [id]);
                const d = path.join(UPLOAD_ROOT, 'correction', String(id));
                try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
            }
        } catch (ce) { console.error('清理失败:', ce && ce.message); }
        db.close();
        process.exit(fail > 0 ? 1 : 0);
    }
})();
