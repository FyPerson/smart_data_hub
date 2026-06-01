/**
 * v1.74.0 C7 — T6 钉钉通知 endpoint 落库 e2e（进程内 require server + mock 钉钉传输层）
 *
 * 用法：node scripts/test-issue-c7-notify-e2e.js
 *   ⚠️ 本脚本**自己 require('../server') 在独立 PORT 起一个进程内实例**（不依赖 localhost:3000 主 server），
 *   因为要 mock dingtalkNotify 传输层方法——主 server 是独立进程，进程外 mock 不到。
 *
 * 为何必须进程内（盘点 2026-06-01 + 用户拍板 A+C）：
 *   issue notify endpoint（notify-developer 等）→ sendIssueDingtalkRaw（server.js 内部 async）
 *   → dingtalkNotify.getAccessToken / sendMarkdownToUser（模块单例）。helper 层（verify-issue-notify）
 *   只验 sendIssueMarkdown 返回对象的 reason 分类，**从不碰 endpoint 的落库 SQL**
 *   （notify_status='failed'/notify_error=reason，server.js:10602/10608）——这是 H-4 核心断言点的零覆盖区。
 *   进程内 require + 替换 require-cache 单例方法 → mock 生效 + 真打 endpoint + 真验落库。
 *
 * 覆盖（T6 endpoint 落库，正负闭环）：
 *   sent           成功 → notify_status='sent' + notify_message_key 落库 + notify_error=NULL，HTTP 200
 *   token_expired  getAccessToken 抛 {errcode:42001} → 重试再失败 → notify_status='failed'+notify_error='token_expired'，HTTP 502
 *   network        getAccessToken 抛 AbortError → notify_status='failed'+notify_error='network'，HTTP 502
 *   user_invalid   sendMarkdownToUser 返 {errcode:88} → notify_status='failed'+notify_error='user_invalid'，HTTP 502
 *   message_key_missing  sendMarkdownToUser 返 {errcode:0} 无 processQueryKey → failed+'message_key_missing'，HTTP 502
 *   no_phone       目标用户无 phone（id=8 刘林航）→ sendIssueDingtalkRaw 短路 → failed+'no_phone'，**零 mock 兜底**
 *
 * 前提（已核实 2026-06-01）：
 *   - 生产 dingtalk config（app_key/secret/robot_code）已填 → 不会 no_config 早退，能走到 no_phone/发送
 *   - users: id=19 示例用户B 有 phone（走完整 mock 路径）/ id=8 刘林航 无 phone（走 no_phone 短路）
 *
 * 安全：造的测试 issue 用后即删；不触发 C1 硬门槛（require 时 issue 4 表 0 行放行重建空表，无损）。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// 进程内 server 用独立端口（避开主 server 3000 + 用时间戳尾数降低并发跑时撞端口概率）
const TEST_PORT = process.env.C7_NOTIFY_PORT || String(3100 + (process.pid % 200));
process.env.PORT = TEST_PORT;
const BASE = `http://localhost:${TEST_PORT}`;
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

const ADMIN_ID = 1;
const DEV_WITH_PHONE = 19;   // 示例用户B（有 phone）
const DEV_NO_PHONE = 8;      // 刘林航（无 phone → no_phone 短路）

// ---- mock 钉钉传输层（在 require server 之前替换单例方法，确保 sendIssueDingtalkRaw 用 mock）----
const dingtalkNotify = require(path.join(__dirname, '..', 'utils', 'dingtalk-notify'));
// 默认成功态；各用例临时改写 scenario 控制行为
let scenario = 'sent';
dingtalkNotify.getAccessToken = async () => {
    if (scenario === 'token_expired') { const e = new Error('token expired'); e.errcode = 42001; throw e; }
    if (scenario === 'network') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    return 'mock_access_token';
};
dingtalkNotify.getUserIdByMobile = async () => 'mock_ding_user_id';
dingtalkNotify.clearCachedToken = () => { /* no-op：token_expired 重试路径会调 */ };
dingtalkNotify.sendMarkdownToUser = async () => {
    if (scenario === 'user_invalid') return { errcode: 88, errmsg: 'user not exist' };
    if (scenario === 'message_key_missing') return { errcode: 0 }; // 成功但无 processQueryKey
    // token_expired 场景：getAccessToken 已抛，到不了这里
    return { errcode: 0, processQueryKey: 'mock_pqk_' + Date.now() };
};

// require server（启动进程内实例，listen TEST_PORT）。用 mock 后 require，确保启动期任何推送也走 mock。
require(path.join(__dirname, '..', 'server'));

function dbGet(sql, params) {
    return new Promise((resolve, reject) => { const db = new sqlite3.Database(DB_PATH); db.get(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); }); });
}
function signAs(id, role, name) {
    return jwt.sign({ id, username: 'u' + id, display_name: name || ('user' + id), role }, JWT_SECRET, { expiresIn: '1h' });
}
async function apiCall(method, urlPath, token, body) {
    const opts = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null; try { j = await r.json(); } catch (_) {}
    return { status: r.status, body: j };
}

let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; } }
function must(cond, msg) { if (!cond) throw new Error(msg); }

// 轮询 issue endpoint 直到 schema ready（非 503）
async function waitReady(token) {
    for (let i = 0; i < 60; i++) {
        try { const r = await fetch(`${BASE}/api/issues`, { headers: { Authorization: `Bearer ${token}` } }); if (r.status !== 503) return; } catch (_) {}
        await new Promise(s => setTimeout(s, 150));
    }
    throw new Error('schema 未在 9s 内 ready（issue endpoint 持续 503）');
}

const created = [];
async function createAssignedIssue(adminToken, assignedTo) {
    // 造一条已指派 + 处于"处理中"（可通知态）的 issue
    const r = await apiCall('POST', '/api/issues', adminToken, {
        title: 'C7 通知落库测试', type: '数据质量', requester_dept: '市场营销部', requester_name: '张三',
        description: 'x', assigned_to: assignedTo
    });
    must(r.status === 200 && r.body.id, 'createIssue 失败 ' + JSON.stringify(r.body));
    created.push(r.body.id);
    return r.body.id;
}

async function main() {
    const adminToken = signAs(ADMIN_ID, 'admin', '管理员');
    console.log(`\n══════ v1.74.0 C7 T6 通知 endpoint 落库 e2e（进程内 :${TEST_PORT}）══════`);
    await waitReady(adminToken);

    // ---- sent：成功落库 ----
    await check('N1 sent：notify-developer 成功 → notify_status=sent + message_key 落库 + error=NULL（200）', async () => {
        scenario = 'sent';
        const id = await createAssignedIssue(adminToken, DEV_WITH_PHONE);
        const r = await apiCall('POST', `/api/issues/${id}/notify-developer`, adminToken);
        must(r.status === 200 && r.body.success, `应 200 success，实际 ${r.status} ${JSON.stringify(r.body)}`);
        const row = await dbGet('SELECT notify_status, notify_message_key, notify_error FROM issues WHERE id=?', [id]);
        must(row.notify_status === 'sent', `notify_status 应 sent，实际 ${row.notify_status}`);
        must(row.notify_message_key && /mock_pqk/.test(row.notify_message_key), `message_key 应落库，实际 ${row.notify_message_key}`);
        must(row.notify_error === null, `notify_error 应 NULL，实际 ${row.notify_error}`);
    });

    // ---- token_expired：getAccessToken 两次都失效 → failed ----
    await check('N2 token_expired：getAccessToken 抛 42001 重试再失败 → failed+token_expired（502）', async () => {
        scenario = 'token_expired';
        const id = await createAssignedIssue(adminToken, DEV_WITH_PHONE);
        const r = await apiCall('POST', `/api/issues/${id}/notify-developer`, adminToken);
        must(r.status === 502 && r.body.success === false, `应 502 失败，实际 ${r.status} ${JSON.stringify(r.body)}`);
        const row = await dbGet('SELECT notify_status, notify_error, notify_message_key FROM issues WHERE id=?', [id]);
        must(row.notify_status === 'failed', `notify_status 应 failed，实际 ${row.notify_status}`);
        must(row.notify_error === 'token_expired', `notify_error 应 token_expired，实际 ${row.notify_error}`);
        must(row.notify_message_key === null, 'message_key 应 NULL');
    });

    // ---- network：getAccessToken 抛 AbortError → failed+network ----
    await check('N3 network：getAccessToken 抛 AbortError → failed+network（502）', async () => {
        scenario = 'network';
        const id = await createAssignedIssue(adminToken, DEV_WITH_PHONE);
        const r = await apiCall('POST', `/api/issues/${id}/notify-developer`, adminToken);
        must(r.status === 502, `应 502，实际 ${r.status} ${JSON.stringify(r.body)}`);
        const row = await dbGet('SELECT notify_status, notify_error FROM issues WHERE id=?', [id]);
        must(row.notify_status === 'failed', `notify_status 应 failed，实际 ${row.notify_status}`);
        must(row.notify_error === 'network', `notify_error 应 network，实际 ${row.notify_error}`);
    });

    // ---- user_invalid：sendMarkdownToUser 返 errcode=88 → failed+user_invalid ----
    await check('N4 user_invalid：sendMarkdownToUser 返 errcode=88 → failed+user_invalid（502）', async () => {
        scenario = 'user_invalid';
        const id = await createAssignedIssue(adminToken, DEV_WITH_PHONE);
        const r = await apiCall('POST', `/api/issues/${id}/notify-developer`, adminToken);
        must(r.status === 502, `应 502，实际 ${r.status} ${JSON.stringify(r.body)}`);
        const row = await dbGet('SELECT notify_status, notify_error FROM issues WHERE id=?', [id]);
        must(row.notify_status === 'failed', `notify_status 应 failed，实际 ${row.notify_status}`);
        must(row.notify_error === 'user_invalid', `notify_error 应 user_invalid，实际 ${row.notify_error}`);
    });

    // ---- message_key_missing：发成功但无 processQueryKey → failed+message_key_missing（H-2 一致性）----
    await check('N5 message_key_missing：errcode=0 无 processQueryKey → failed+message_key_missing（502，codex 12 H-2）', async () => {
        scenario = 'message_key_missing';
        const id = await createAssignedIssue(adminToken, DEV_WITH_PHONE);
        const r = await apiCall('POST', `/api/issues/${id}/notify-developer`, adminToken);
        must(r.status === 502, `应 502，实际 ${r.status} ${JSON.stringify(r.body)}`);
        const row = await dbGet('SELECT notify_status, notify_error, notify_message_key FROM issues WHERE id=?', [id]);
        must(row.notify_status === 'failed', `notify_status 应 failed，实际 ${row.notify_status}`);
        must(row.notify_error === 'message_key_missing', `notify_error 应 message_key_missing，实际 ${row.notify_error}`);
        must(row.notify_message_key === null, 'message_key 不应落（按失败处理避免"已发送查不到已读"不一致）');
    });

    // ---- no_phone：目标用户无 phone → sendIssueDingtalkRaw 短路（零 mock，纯真实路径）----
    await check('N6 no_phone：被指派人(id=8)无 phone → failed+no_phone（502，零 mock 兜底·短路）', async () => {
        scenario = 'sent'; // 即使 mock 成功，no_phone 在调钉钉前就短路，到不了 send
        const id = await createAssignedIssue(adminToken, DEV_NO_PHONE);
        const r = await apiCall('POST', `/api/issues/${id}/notify-developer`, adminToken);
        must(r.status === 502, `应 502，实际 ${r.status} ${JSON.stringify(r.body)}`);
        const row = await dbGet('SELECT notify_status, notify_error FROM issues WHERE id=?', [id]);
        must(row.notify_status === 'failed', `notify_status 应 failed，实际 ${row.notify_status}`);
        must(row.notify_error === 'no_phone', `notify_error 应 no_phone，实际 ${row.notify_error}`);
    });

    // ---- 失败后重发成功：failed → sent，notify_error 被清 NULL（正负闭环的"恢复"边）----
    await check('N7 失败后重发成功：failed → sent，notify_error 清 NULL（恢复闭环）', async () => {
        scenario = 'network';
        const id = await createAssignedIssue(adminToken, DEV_WITH_PHONE);
        await apiCall('POST', `/api/issues/${id}/notify-developer`, adminToken); // 先失败
        let row = await dbGet('SELECT notify_status, notify_error FROM issues WHERE id=?', [id]);
        must(row.notify_status === 'failed' && row.notify_error === 'network', '先置 failed/network');
        scenario = 'sent';
        const r = await apiCall('POST', `/api/issues/${id}/notify-developer`, adminToken); // 再成功
        must(r.status === 200, `重发应 200，实际 ${r.status}`);
        row = await dbGet('SELECT notify_status, notify_error, notify_message_key FROM issues WHERE id=?', [id]);
        must(row.notify_status === 'sent', `应恢复 sent，实际 ${row.notify_status}`);
        must(row.notify_error === null, `notify_error 应清 NULL，实际 ${row.notify_error}`);
        must(row.notify_message_key, 'message_key 应落');
    });

    // 清理：删测试 issue
    for (const id of created) await apiCall('DELETE', `/api/issues/${id}`, adminToken);

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C7 T6 通知 endpoint 落库 e2e 全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('T6 通知 e2e 异常:', e); process.exit(1); });
