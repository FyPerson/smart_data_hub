/**
 * 数据开发 issue_lite · 归档保留完成痕迹 fix 验证（2026-07-23）
 *
 * 背景（生产实证 bug·v1.122.0 起存在）：状态端点清痕分支只判"离开已完成"，
 * 已完成→已归档 误走 reopen 清痕逻辑，把 completed_at/complete_note/board_url/req_notify_* 全抹。
 * 修复=条件补 `status !== '已归档'`。
 *
 * 用法：node scripts/verify-issue-lite-archive-keeps-completion.js
 * 前置：本地 server 已启动（默认 localhost:3000，可用 TEST_BASE_URL 覆盖，如 http://localhost:3100）
 *
 * 覆盖：
 *   1. 标记完成 → completed_at/complete_note 写入（既有行为回归锚）
 *   2. 已完成 → 已归档：completed_at/complete_note/board_url + req_notify_* 四字段逐一保留（本次修复，
 *      归档前预置可辨识值、归档后逐字段断言相等）
 *   3. 已完成 → 处理中（reopen）：完成痕迹 + 通知态仍清（防修反）
 *   4. 归档后详情 completed_at 非空（前端完成时间展示 + 完成通知门 13120 的数据前提恢复；
 *      通知端点本身不真调——会真发钉钉，非本 verify 可触发面）
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

let pass = 0, fail = 0;
function expect(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); pass++; } else { console.log(`  ✗ ${msg}`); fail++; } }

const dbGet = (db, sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
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

(async () => {
    console.log('=== issue_lite 归档保留完成痕迹 fix 验证 ===\n');
    const db = new sqlite3.Database(DB_PATH);
    const created = [];
    try {
        const adminToken = await fx.signAs(fx.ADMIN_ID);
        const userToken = await fx.signAs(fx.CONTACT_ID);
        const mk = { title: 'FIX-归档保留完成痕迹', requester_name: 'FIX测试', requester_dept: '信息技术部', requester_phone: '13800000002' };

        // ---- 1. 标记完成写入（回归锚）----
        console.log('1. 标记完成写入');
        let r = await api('POST', '/api/issue-lite', userToken, mk);
        const idA = r.json.issue && r.json.issue.id; created.push(idA);
        expect(!!idA, `建单成功 #${idA}`);
        r = await api('PUT', `/api/issue-lite/${idA}/status`, userToken, { status: '已完成', complete_note: '本次修复验证的完成说明十字以上', board_url: 'http://192.168.1.100/board/fix-verify' });
        expect(r.status === 200, `标记完成 → 200（实际 ${r.status}：${r.json.error || 'ok'}）`);
        let row = await dbGet(db, 'SELECT status, completed_at, complete_note, board_url FROM issue_lite WHERE id = ?', [idA]);
        expect(!!row.completed_at && !!row.complete_note && !!row.board_url, `completed_at/complete_note/board_url 已写入（${row.completed_at}）`);
        // M-1（codex 审）：归档前预置全部四个 req_notify_* 可辨识值，归档后逐字段断言相等（防"只清部分字段"漏测）
        await dbRun(db, `UPDATE issue_lite SET req_notify_status='sent', req_notify_at='2026-07-23 12:00:00',
                          req_notify_message_key='msgkey-fix-verify', req_notify_read_at='2026-07-23 12:30:00' WHERE id = ?`, [idA]);
        const before = await dbGet(db, `SELECT completed_at, complete_note, board_url, req_notify_status, req_notify_at,
                          req_notify_message_key, req_notify_read_at FROM issue_lite WHERE id = ?`, [idA]);

        // ---- 2. 已完成 → 已归档：全保留（本次修复）----
        console.log('\n2. 归档保留完成痕迹（修复目标）');
        r = await api('PUT', `/api/issue-lite/${idA}/status`, adminToken, { status: '已归档' });
        expect(r.status === 200, `归档 → 200（实际 ${r.status}：${r.json.error || 'ok'}）`);
        const after = await dbGet(db, `SELECT status, completed_at, complete_note, board_url, req_notify_status,
                          req_notify_at, req_notify_message_key, req_notify_read_at FROM issue_lite WHERE id = ?`, [idA]);
        expect(after.status === '已归档', '状态已归档');
        for (const k of ['completed_at', 'complete_note', 'board_url', 'req_notify_status', 'req_notify_at', 'req_notify_message_key', 'req_notify_read_at']) {
            expect(after[k] === before[k] && after[k] !== null, `${k} 逐字段保留（${after[k]}）`);
        }
        r = await api('GET', `/api/issue-lite/${idA}`, userToken);
        expect(!!r.json.completed_at, '归档后详情返回 completed_at 非空（前端完成时间可展示）');

        // ---- 3. reopen 仍清（防修反）----
        console.log('\n3. reopen 清痕不回退（防修反）');
        r = await api('POST', '/api/issue-lite', userToken, { ...mk, title: 'FIX-reopen仍清' });
        const idB = r.json.issue && r.json.issue.id; created.push(idB);
        await api('PUT', `/api/issue-lite/${idB}/status`, userToken, { status: '已完成', complete_note: 'reopen路径的完成说明十字以上' });
        await dbRun(db, `UPDATE issue_lite SET req_notify_status='sent' WHERE id = ?`, [idB]);
        r = await api('PUT', `/api/issue-lite/${idB}/status`, userToken, { status: '处理中' });
        expect(r.status === 200, `reopen（已完成→处理中）→ 200（实际 ${r.status}）`);
        row = await dbGet(db, 'SELECT completed_at, complete_note, req_notify_status FROM issue_lite WHERE id = ?', [idB]);
        expect(row.completed_at === null && row.complete_note === null && row.req_notify_status === null, 'reopen 完成痕迹+通知态仍清空（D-M-3 语义不回退）');
    } finally {
        for (const id of created.filter(Boolean)) {
            await dbRun(db, 'DELETE FROM issue_lite_attachments WHERE issue_lite_id = ?', [id]).catch(() => {});
            await dbRun(db, 'DELETE FROM issue_lite WHERE id = ?', [id]).catch(() => {});
        }
        db.close();
    }
    console.log(`\n== Summary: ${pass} pass / ${fail} fail ==`);
    process.exit(fail > 0 ? 1 : 0);
})();
