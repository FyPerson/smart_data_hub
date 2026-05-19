/**
 * v3 二级转派 endpoint 集成测试（2026-05-18）
 *
 * 用法：node scripts/test-collab-two-level-e2e.js
 *
 * 前置：
 *   - 本地 server 已启动（localhost:3000）
 *   - 本地 task_pool.db schema 已含 v3 五字段
 *   - 用户：admin(id=1) / 示例用户A demo_user_a(id=3, user) / 示例用户B demo_user_b(id=19, user) / 示例发布者 13857133559(id=7, publisher)
 *   - source db_connection: id=2 业务系统BMS
 *
 * 测试场景：
 *   T01 admin 创建协作单 → 状态 PENDING_ASSIGN, developer_id=0, contact_person_id=对接人
 *   T02 admin 创建时传 developer_id → 400（按拍板 #10 禁止越权）
 *   T03 admin 创建时不传 contact_person_id → 400
 *   T04 PUT 编辑 PENDING_ASSIGN 状态（admin）→ 200
 *   T05 PUT 编辑时改 developer_id → 400 USE_ASSIGN_ENDPOINT
 *   T06 对接人调 assign 指派开发 → 200，状态 PENDING_ASSIGN → PENDING
 *   T07 对接人再次 assign 改派 → 200，previous_developer_id 记录
 *   T08 对接人改派给对接人自己 → 400 SAME_AS_CONTACT
 *   T09 其他非对接人/非 admin 用户 assign → 403 NOT_ASSIGNER
 *   T10 admin assign 兜底（非本单对接人）→ 200
 *   T11 PUT 编辑 PENDING 状态 → 200（v1.66.2 改：PENDING+submission_version=0 允许编辑）
 *   T11b PUT 改 contact_person_id @PENDING → 400 CANNOT_CHANGE_CONTACT_IN_PENDING（v1.66.2 加）
 *   T12 GET list ?my_role=contact → 仅返本人作为对接人的单
 *   T13 GET list ?my_role=developer → 仅返指派给本人的单
 *   T14 submit 时占位 developer_id=0 → 防御阻断（实际通过状态 PENDING_ASSIGN 阻断）
 */

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

// 测试角色 id
const ADMIN_ID = 1;
const CONTACT_ID = 3;        // 示例用户A user
const DEV1_ID = 19;          // 示例用户B user
const DEV2_ID = 8;           // 刘林航 user
const OTHER_USER_ID = 12;    // 饶璐 user（不是 contact 也不是 admin）
const TARGET_DB_CONN_ID = 2; // 业务系统BMS

const tokens = {};
let createdId = null;

async function loginAs(userId) {
    const user = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get('SELECT id, username, display_name, role FROM users WHERE id=?', [userId],
            (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
        db.get(sql, params, (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
}

async function apiCall(method, path, token, body = null) {
    const opts = {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${BASE}${path}`, opts);
    let json = null;
    try { json = await resp.json(); } catch { /* may be empty */ }
    return { status: resp.status, body: json };
}

const results = [];
function record(name, pass, detail = '') {
    results.push({ name, pass, detail });
    console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
    console.log('=== v3 二级转派 e2e ===\n');

    // 准备 token
    tokens.admin = await loginAs(ADMIN_ID);
    tokens.contact = await loginAs(CONTACT_ID);
    tokens.dev1 = await loginAs(DEV1_ID);
    tokens.dev2 = await loginAs(DEV2_ID);
    tokens.other = await loginAs(OTHER_USER_ID);

    // T01 创建协作单（admin 填对接人）
    console.log('T01 admin 创建协作单 → PENDING_ASSIGN');
    const oaNo = `TEST-V3-${Date.now()}`;
    const createBody = {
        oa_request_no: oaNo,
        requester_dept: '信息技术部',
        requester_name: '测试申请人',
        description: 'v3 二级转派端到端测试',
        deadline: '2026-12-31 18:00:00',
        contact_person_id: CONTACT_ID,
        target_db_connection_id: TARGET_DB_CONN_ID
    };
    const r1 = await apiCall('POST', '/api/collab/requests', tokens.admin, createBody);
    if (r1.status === 200 && r1.body && r1.body.id) {
        createdId = r1.body.id;
        const row = await dbGet('SELECT status, developer_id, developer_name, contact_person_id, contact_person_name FROM collab_requests WHERE id=?', [createdId]);
        const ok = row.status === 'PENDING_ASSIGN' && row.developer_id === 0
            && row.developer_name === '(待指派)' && row.contact_person_id === CONTACT_ID;
        record('T01 创建成功 + 占位值正确', ok, `id=${createdId} status=${row.status} dev=${row.developer_id}/${row.developer_name} contact=${row.contact_person_id}`);
    } else {
        record('T01 创建成功 + 占位值正确', false, `status=${r1.status} body=${JSON.stringify(r1.body)}`);
        console.log('T01 失败，中止后续测试');
        return;
    }

    // T02 admin 创建时传 developer_id → 400
    console.log('T02 admin 创建时传 developer_id → 400');
    const r2 = await apiCall('POST', '/api/collab/requests', tokens.admin, {
        ...createBody, oa_request_no: oaNo + '-T02', developer_id: DEV1_ID
    });
    record('T02 越权直填 developer_id 被拒', r2.status === 400, `status=${r2.status} err=${r2.body && r2.body.error}`);

    // T03 admin 创建时缺 contact_person_id → 400
    console.log('T03 admin 创建时缺 contact_person_id → 400');
    const { contact_person_id, ...noContact } = createBody;
    const r3 = await apiCall('POST', '/api/collab/requests', tokens.admin, { ...noContact, oa_request_no: oaNo + '-T03' });
    record('T03 缺 contact_person_id 被拒', r3.status === 400 && r3.body && r3.body.error.includes('对接人'), `status=${r3.status} err=${r3.body && r3.body.error}`);

    // T04 PUT 编辑 PENDING_ASSIGN 状态（admin）→ 200
    console.log('T04 PUT 编辑 PENDING_ASSIGN（admin）→ 200');
    const r4 = await apiCall('PUT', `/api/collab/requests/${createdId}`, tokens.admin, {
        description: 'v3 二级转派端到端测试（已编辑）'
    });
    record('T04 admin PUT PENDING_ASSIGN', r4.status === 200, `status=${r4.status} body=${JSON.stringify(r4.body)}`);

    // T05 PUT 编辑时改 developer_id → 400 USE_ASSIGN_ENDPOINT
    console.log('T05 PUT 改 developer_id → 400');
    const r5 = await apiCall('PUT', `/api/collab/requests/${createdId}`, tokens.admin, { developer_id: DEV1_ID });
    record('T05 PUT 改 developer_id 走 assign', r5.status === 400 && r5.body && r5.body.code === 'USE_ASSIGN_ENDPOINT', `status=${r5.status} code=${r5.body && r5.body.code}`);

    // T06 对接人 assign 指派开发
    console.log('T06 对接人 assign 指派 dev1');
    const r6 = await apiCall('POST', `/api/collab/requests/${createdId}/assign`, tokens.contact, { developer_id: DEV1_ID });
    if (r6.status === 200) {
        const row = await dbGet('SELECT status, developer_id, developer_name, assigned_at, assigned_by, previous_developer_id FROM collab_requests WHERE id=?', [createdId]);
        const ok = row.status === 'PENDING' && row.developer_id === DEV1_ID && row.assigned_by === CONTACT_ID && row.previous_developer_id === null;
        record('T06 首次指派', ok, `status=${row.status} dev=${row.developer_id} assigned_by=${row.assigned_by} prev=${row.previous_developer_id}`);
    } else {
        record('T06 首次指派', false, `status=${r6.status} body=${JSON.stringify(r6.body)}`);
    }

    // T07 对接人改派 dev1 → dev2
    console.log('T07 对接人改派 dev1 → dev2');
    const r7 = await apiCall('POST', `/api/collab/requests/${createdId}/assign`, tokens.contact, { developer_id: DEV2_ID });
    if (r7.status === 200) {
        const row = await dbGet('SELECT status, developer_id, previous_developer_id FROM collab_requests WHERE id=?', [createdId]);
        const ok = row.status === 'PENDING' && row.developer_id === DEV2_ID && row.previous_developer_id === DEV1_ID;
        record('T07 改派记录前任', ok, `dev=${row.developer_id} prev=${row.previous_developer_id} is_reassign=${r7.body && r7.body.is_reassign}`);
    } else {
        record('T07 改派记录前任', false, `status=${r7.status} body=${JSON.stringify(r7.body)}`);
    }

    // T08 对接人改派给对接人自己 → 400
    console.log('T08 对接人改派给自己 → 400 SAME_AS_CONTACT');
    const r8 = await apiCall('POST', `/api/collab/requests/${createdId}/assign`, tokens.contact, { developer_id: CONTACT_ID });
    record('T08 不能指派对接人本人', r8.status === 400 && r8.body && r8.body.code === 'SAME_AS_CONTACT', `status=${r8.status} code=${r8.body && r8.body.code}`);

    // T09 其他用户 assign → 403
    console.log('T09 非对接人/非 admin 用户 assign → 403');
    const r9 = await apiCall('POST', `/api/collab/requests/${createdId}/assign`, tokens.other, { developer_id: DEV1_ID });
    record('T09 权限拒绝', r9.status === 403 && r9.body && r9.body.code === 'NOT_ASSIGNER', `status=${r9.status} code=${r9.body && r9.body.code}`);

    // T10 admin 兜底 assign
    console.log('T10 admin 兜底 assign（非本单对接人）→ 200');
    const r10 = await apiCall('POST', `/api/collab/requests/${createdId}/assign`, tokens.admin, { developer_id: DEV1_ID });
    if (r10.status === 200) {
        const row = await dbGet('SELECT developer_id, assigned_by, previous_developer_id FROM collab_requests WHERE id=?', [createdId]);
        const ok = row.developer_id === DEV1_ID && row.assigned_by === ADMIN_ID && row.previous_developer_id === DEV2_ID;
        record('T10 admin 兜底改派', ok, `dev=${row.developer_id} assigned_by=${row.assigned_by} prev=${row.previous_developer_id}`);
    } else {
        record('T10 admin 兜底改派', false, `status=${r10.status} body=${JSON.stringify(r10.body)}`);
    }

    // T11 PUT 编辑 PENDING 状态 → 200（v1.66.2 改：PENDING+submission_version=0 允许编辑文本字段）
    console.log('T11 PUT 编辑 PENDING+未提交 → 200');
    const r11 = await apiCall('PUT', `/api/collab/requests/${createdId}`, tokens.admin, { description: 'v1.66.2 PENDING 状态可编辑文本' });
    record('T11 PENDING+未提交允许编辑', r11.status === 200, `status=${r11.status} body=${JSON.stringify(r11.body).slice(0,80)}`);

    // T11b PUT 改 contact_person_id @PENDING → 400（v1.66.2 加：PENDING 不允许换对接人）
    console.log('T11b PUT 改对接人 @PENDING → 400 CANNOT_CHANGE_CONTACT_IN_PENDING');
    const r11b = await apiCall('PUT', `/api/collab/requests/${createdId}`, tokens.admin, { contact_person_id: OTHER_USER_ID });
    record('T11b PENDING 拒绝换对接人',
        r11b.status === 400 && r11b.body && r11b.body.code === 'CANNOT_CHANGE_CONTACT_IN_PENDING',
        `status=${r11b.status} code=${r11b.body && r11b.body.code}`);

    // T12 GET list ?my_role=contact
    console.log('T12 my_role=contact 仅返本人对接的单');
    const r12 = await apiCall('GET', '/api/collab/requests?my_role=contact', tokens.contact);
    const allMine12 = r12.status === 200 && Array.isArray(r12.body) && r12.body.every(r => r.contact_person_id === CONTACT_ID);
    record('T12 my_role=contact 过滤正确', allMine12, `status=${r12.status} count=${r12.body && r12.body.length} all_mine=${allMine12}`);

    // T13 GET list ?my_role=developer（用 dev1，应包含 createdId）
    console.log('T13 my_role=developer 仅返指派给本人的单');
    const r13 = await apiCall('GET', '/api/collab/requests?my_role=developer', tokens.dev1);
    const found13 = r13.status === 200 && Array.isArray(r13.body) && r13.body.some(r => r.id === createdId);
    const allMine13 = r13.status === 200 && r13.body.every(r => r.developer_id === DEV1_ID);
    record('T13 my_role=developer 过滤正确', found13 && allMine13, `status=${r13.status} count=${r13.body && r13.body.length} contains_self=${found13}`);

    // T14 创建一个新 PENDING_ASSIGN 单测试 my_role=admin 仅 admin 可用
    console.log('T14 my_role=admin 非 admin 拒绝');
    const r14 = await apiCall('GET', '/api/collab/requests?my_role=admin', tokens.contact);
    record('T14 my_role=admin 仅 admin 可用', r14.status === 403, `status=${r14.status}`);

    // 汇总
    console.log('\n=== 结果汇总 ===');
    const passed = results.filter(r => r.pass).length;
    const total = results.length;
    console.log(`通过 ${passed}/${total}`);
    if (passed < total) {
        console.log('\n失败用例：');
        results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.name} — ${r.detail}`));
        process.exit(1);
    }
    console.log('✅ 全部通过');
}

main().catch(e => {
    console.error('测试异常:', e);
    process.exit(1);
});
