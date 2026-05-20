/**
 * MySQL smoke test 端到端集成测试 (v1.68.0)
 *
 * 用真实 HRD MySQL 连接（fy 账号 @ 192.168.1.12:3306 newhrd）走完 submit endpoint 路径，
 * 验证路由式多方言改造在 MySQL 路径的正确性。
 *
 * 验证：
 *   T1：MySQL 协作单提交合法 SELECT → smoke test 通过 → status=DONE
 *   T2：MySQL 协作单提交 LOAD_FILE → 静态校验拒（layer 0 词法）
 *   T3：MySQL 协作单提交 SELECT INTO OUTFILE → 静态校验拒（layer 0）
 *   T4：MySQL 协作单提交跨库 mysql.user → 静态校验拒（layer 2）
 *   T5：MySQL 协作单提交合法 SELECT 含反引号标识符 → 通过
 *
 * 前提：
 *   - F1 已验：HRD MySQL 只读账号无写权限（探针 2026-05-20 确认）
 *   - mcp-hrd/config.json 提供 host/port/database/user/password
 *   - 本地服务运行中（localhost:3000）
 *
 * 测试副作用：
 *   - 临时在 db_connections 插一条 HRD MySQL 连接（测后删）
 *   - 临时在 collab_requests 造测试协作单（测后清）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';

// HRD MySQL 连接配置：从 mcp-hrd/config.json 读（密钥不入代码，方便 GitHub 同步 + 后续凭证轮换）
const HRD_CONFIG_PATH = path.join(__dirname, '..', '..', 'mcp-hrd', 'config.json');
let HRD_CONFIG;
try {
    const cfg = JSON.parse(fs.readFileSync(HRD_CONFIG_PATH, 'utf8')).hrd;
    HRD_CONFIG = {
        name: '_test_hrd_mysql_smoke',
        type: 'mysql',
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        username: cfg.user,
        password: cfg.password,
    };
} catch (e) {
    console.error(`无法读取 ${HRD_CONFIG_PATH}: ${e.message}`);
    console.error('请确认 mcp-hrd/config.json 存在且含 hrd.{host,port,database,user,password}');
    process.exit(1);
}

let createdConnId = null;
const createdFixtureIds = [];
let testTmpDir = null;

function encryptPassword(password) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function dbRun(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(sql, params, function (err) {
            db.close();
            err ? reject(err) : resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(sql, params, (err, row) => {
            db.close();
            err ? reject(err) : resolve(row);
        });
    });
}

async function setupMysqlConnection() {
    // 插入一条 HRD MySQL source 连接，仅本 e2e 使用
    const encPw = encryptPassword(HRD_CONFIG.password);
    const ins = await dbRun(
        `INSERT INTO db_connections (name, type, host, port, database, username, password, default_schema, connection_type, source_system_code, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, '', 'source', 'HRD', 0)`,
        [HRD_CONFIG.name, HRD_CONFIG.type, HRD_CONFIG.host, HRD_CONFIG.port, HRD_CONFIG.database, HRD_CONFIG.username, encPw]
    );
    createdConnId = ins.lastID;
    return createdConnId;
}

async function teardownMysqlConnection() {
    if (createdConnId) {
        try { await dbRun('DELETE FROM db_connections WHERE id=?', [createdConnId]); }
        catch (e) { console.warn('删除测试连接失败:', e.message); }
    }
}

function makeTmpFile(filename, content) {
    if (!testTmpDir) testTmpDir = fs.mkdtempSync(path.join(tmpdir(), 'collab-mysql-test-'));
    const p = path.join(testTmpDir, filename);
    fs.writeFileSync(p, content);
    return p;
}

async function postSubmit(reqId, token, sqlContent, dataContent) {
    const fd = new FormData();
    fd.append('files', new Blob([Buffer.from(sqlContent)]), 'script.sql');
    fd.append('files', new Blob([Buffer.from(dataContent)]), 'data.xlsx');
    const res = await fetch(`${BASE}/api/collab/requests/${reqId}/submit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
    });
    let body;
    try { body = await res.json(); } catch (_) { body = { _raw: await res.text() }; }
    return { status: res.status, body };
}

async function makeMysqlFixture(connId) {
    // 用 fixture 造一个 PENDING 协作单，但 target_db_connection_id 改成 MySQL 连接
    const ctx = await fx.createPendingFixture();
    createdFixtureIds.push(ctx.id);
    await dbRun('UPDATE collab_requests SET target_db_connection_id=? WHERE id=?', [connId, ctx.id]);
    return ctx;
}

let passed = 0;
let failed = 0;

function assert(cond, label) {
    if (cond) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.log(`  ✗ ${label}`);
        failed++;
    }
}

async function runTests() {
    console.log('=== 准备：插入 HRD MySQL 连接 ===');
    const connId = await setupMysqlConnection();
    console.log(`  ✓ db_connections id=${connId} 已建（_test_hrd_mysql_smoke @ ${HRD_CONFIG.host}:${HRD_CONFIG.port}/${HRD_CONFIG.database}）\n`);

    console.log('=== T1: MySQL 协作单提交合法 SELECT → smoke test 通过 → DONE ===');
    {
        const ctx = await makeMysqlFixture(connId);
        const sqlText = 'SELECT 1 AS test_value';
        const res = await postSubmit(ctx.id, ctx.dev1Token, sqlText, 'xlsx mock');
        assert(res.status === 200, `T1 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        if (res.status === 200) {
            assert(res.body.current_status === 'DONE', `T1 current_status=DONE`);
            assert(res.body.sql_validation_status === 'passed', `T1 sql_validation_status=passed`);
        }
        const row = await dbGet('SELECT status, sql_validation_status FROM collab_requests WHERE id=?', [ctx.id]);
        assert(row.status === 'DONE', `T1 db status=DONE`);
    }

    console.log('\n=== T2: MySQL 协作单提交 LOAD_FILE → 静态校验拒 ===');
    {
        const ctx = await makeMysqlFixture(connId);
        const sqlText = "SELECT LOAD_FILE('/etc/passwd') AS f";
        const res = await postSubmit(ctx.id, ctx.dev1Token, sqlText, 'xlsx mock');
        // 静态校验失败 → 走"业务失败"路径，status=SUBMITTED + sql_validation_status=failed
        assert(res.status === 200 || res.status === 400, `T2 静态校验拒 status=${res.status}`);
        const row = await dbGet('SELECT status, sql_validation_status, sql_validation_error FROM collab_requests WHERE id=?', [ctx.id]);
        // SQL 静态拒 → sql_validation_status='failed'
        const isRejected = row.sql_validation_status === 'failed' && /LOAD_FILE|禁用关键字/i.test(row.sql_validation_error || '');
        assert(isRejected, `T2 db 已拒（status=${row.status} validation=${row.sql_validation_status} err=${(row.sql_validation_error || '').slice(0, 80)}）`);
    }

    console.log('\n=== T3: MySQL 协作单提交 INTO OUTFILE → 静态校验拒 ===');
    {
        const ctx = await makeMysqlFixture(connId);
        const sqlText = "SELECT 1 INTO OUTFILE '/tmp/x.txt'";
        const res = await postSubmit(ctx.id, ctx.dev1Token, sqlText, 'xlsx mock');
        assert(res.status === 200 || res.status === 400, `T3 静态校验拒 status=${res.status}`);
        const row = await dbGet('SELECT status, sql_validation_status, sql_validation_error FROM collab_requests WHERE id=?', [ctx.id]);
        const isRejected = row.sql_validation_status === 'failed' && /OUTFILE|禁用关键字/i.test(row.sql_validation_error || '');
        assert(isRejected, `T3 db 已拒（validation=${row.sql_validation_status} err=${(row.sql_validation_error || '').slice(0, 80)}）`);
    }

    console.log('\n=== T4: MySQL 协作单提交跨库 mysql.user → 静态校验拒（layer 2 跨库） ===');
    {
        const ctx = await makeMysqlFixture(connId);
        const sqlText = 'SELECT user FROM mysql.user';
        const res = await postSubmit(ctx.id, ctx.dev1Token, sqlText, 'xlsx mock');
        assert(res.status === 200 || res.status === 400, `T4 静态校验拒 status=${res.status}`);
        const row = await dbGet('SELECT sql_validation_status, sql_validation_error FROM collab_requests WHERE id=?', [ctx.id]);
        const isRejected = row.sql_validation_status === 'failed' && /跨库|newhrd/i.test(row.sql_validation_error || '');
        assert(isRejected, `T4 db 已拒（validation=${row.sql_validation_status} err=${(row.sql_validation_error || '').slice(0, 80)}）`);
    }

    console.log('\n=== T5: MySQL 反引号标识符合法 SELECT → smoke test 通过 ===');
    {
        const ctx = await makeMysqlFixture(connId);
        // 用 information_schema 之外的简单查询；newhrd 库下应有员工表，但不假设表名
        // 改用纯计算查询，避开真实表名依赖
        const sqlText = 'SELECT `id`, NOW() AS `now_time` FROM (SELECT 1 AS `id`) `t`';
        const res = await postSubmit(ctx.id, ctx.dev1Token, sqlText, 'xlsx mock');
        assert(res.status === 200, `T5 status=200, got ${res.status} body=${JSON.stringify(res.body).slice(0, 200)}`);
        if (res.status === 200) {
            assert(res.body.current_status === 'DONE', `T5 current_status=DONE`);
        }
    }
}

(async () => {
    try {
        await runTests();
    } catch (e) {
        console.error('\n[FATAL]', e);
        failed++;
    } finally {
        for (const id of createdFixtureIds) {
            try { await fx.cleanup(id); } catch (e) { console.warn(`cleanup ${id} failed: ${e.message}`); }
        }
        await teardownMysqlConnection();
        if (testTmpDir) {
            try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) { }
        }
        console.log(`\n=== 结果：${passed} passed / ${failed} failed ===`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
