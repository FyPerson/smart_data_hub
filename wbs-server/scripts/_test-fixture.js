/**
 * 协作单 e2e 共享 fixture helper（2026-05-19）
 *
 * 给 submit/bypass/friction 三套 e2e 复用，避免每个脚本各自维护 fixture。
 * v3 二级转派后，原本依赖 id=3 固定协作单的 e2e 都失效——本 helper 通过 v3 创建流程
 * 动态造单，然后 UPDATE 直接推进状态到测试需要的态。
 *
 * 用法：
 *   const fx = require('./_test-fixture');
 *   const ctx = await fx.createPendingFixture();
 *   // ctx = { id, oaNo, adminToken, contactToken, dev1Token }
 *   // 测试结束后：
 *   await fx.cleanup(ctx.id);
 *
 * fixture 角色（沿用 test-collab-two-level-e2e.js 的用户 id）：
 *   admin (id=1)
 *   示例用户A demo_user_a (id=3, user) 作为 contact_person
 *   示例用户B demo_user_b (id=19, user) 作为 developer
 *   示例发布者 13857133559 (id=7, publisher) — v1.71.0 attachment 按人锁 e2e 用（验证 publisher 收权）
 *   刘林航 15270240365 (id=8, user) — v1.71.0 三级转发 e2e 作 exporter（数据导出人）
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

const ADMIN_ID = 1;
const CONTACT_ID = 3;
const DEV1_ID = 19;
const PUBLISHER_ID = 7;
const EXPORTER_ID = 8;  // v1.71.0 三级转发 e2e 用（user 角色，与 dev1 不同人）
const VIEWER_ID = 2;    // v1.72.5 admin 直派给 viewer e2e 用（沈倩静）
const VIEWER2_ID = 4;   // v1.72.5 跨单越权测试用（甄妮，另一个 viewer）
const TARGET_DB_CONN_ID = 2;

async function signAs(userId) {
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
 * 造一条 PENDING 状态的协作单：
 *   1. admin 创建 → PENDING_ASSIGN
 *   2. contact 调 assign 指派 dev1 → PENDING
 *
 * 返回 { id, oaNo, adminToken, contactToken, dev1Token }
 */
async function createPendingFixture() {
    const adminToken = await signAs(ADMIN_ID);
    const contactToken = await signAs(CONTACT_ID);
    const dev1Token = await signAs(DEV1_ID);

    const oaNo = `OA_FX_${Date.now()}`;
    const createRes = await apiCall('POST', '/api/collab/requests', adminToken, {
        oa_request_no: oaNo,
        requester_dept: '市场营销部',
        requester_name: 'fixture',
        description: 'e2e fixture',
        deadline: '2026-12-31 18:00:00',
        contact_person_id: CONTACT_ID,
        target_db_connection_id: TARGET_DB_CONN_ID
    });
    if (createRes.status !== 200) {
        throw new Error(`fixture 创建失败: ${createRes.status} ${JSON.stringify(createRes.body)}`);
    }
    const id = createRes.body.id;

    const assignRes = await apiCall('POST', `/api/collab/requests/${id}/assign`, contactToken, { developer_id: DEV1_ID });
    if (assignRes.status !== 200) {
        throw new Error(`fixture 指派失败: ${assignRes.status} ${JSON.stringify(assignRes.body)}`);
    }

    return { id, oaNo, adminToken, contactToken, dev1Token };
}

/**
 * 直接 UPDATE 推进协作单到指定状态（bypass-e2e / friction-e2e 用，模拟"开发已提交"等中间态）
 * 不走 submit 真实路径，避免触发 smoke test + mssql 真连
 *
 * @param {number} id
 * @param {object} patch  可设字段：status / sql_validation_status / sql_validation_error /
 *                                 sql_validated_at / done_at / submitted_at / last_submitted_at /
 *                                 attachment_dir / friction_occurred / friction_cause_category /
 *                                 friction_note / friction_recorded_at / bypass_validation /
 *                                 bypass_reason / bypass_by / bypass_by_name
 */
async function setCollabState(id, patch) {
    const allowedFields = [
        'status', 'sql_validation_status', 'sql_validation_error',
        'sql_validated_at', 'done_at', 'submitted_at', 'last_submitted_at',
        'attachment_dir', 'validation_started_at',
        'friction_occurred', 'friction_cause_category', 'friction_note', 'friction_recorded_at',
        'bypass_validation', 'bypass_reason', 'bypass_by', 'bypass_by_name',
        'submission_version'
    ];
    const sets = [];
    const params = [];
    for (const f of allowedFields) {
        if (f in patch) {
            sets.push(`${f}=?`);
            params.push(patch[f]);
        }
    }
    if (sets.length === 0) return;
    params.push(id);

    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(`UPDATE collab_requests SET ${sets.join(', ')} WHERE id=?`, params, (err) => {
            db.close();
            err ? reject(err) : resolve();
        });
    });
}

/**
 * 删除测试协作单 + 级联清子表（FK CASCADE）
 */
async function cleanup(id) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.serialize(() => {
            db.run('PRAGMA foreign_keys = ON');
            db.run('DELETE FROM collab_requests WHERE id = ?', [id], (err) => {
                db.close();
                err ? reject(err) : resolve();
            });
        });
    });
}

module.exports = {
    BASE,
    DB_PATH,
    JWT_SECRET,
    ADMIN_ID,
    CONTACT_ID,
    DEV1_ID,
    PUBLISHER_ID,
    EXPORTER_ID,
    VIEWER_ID,
    VIEWER2_ID,
    TARGET_DB_CONN_ID,
    signAs,
    apiCall,
    createPendingFixture,
    setCollabState,
    cleanup,
};
