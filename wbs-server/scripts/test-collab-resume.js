/**
 * 启动恢复扫描集成测试（D3 模块 5 step-7）
 *
 * 验证 codex 十一审 #2 #5 #7 落地：
 *   - 启动时扫 status='SUBMITTED' AND sql_validation_status='running' AND validation_started_at < NOW-90s
 *   - 命中的恢复为 failed + sql_validation_error='服务重启时 smoke test 被中断，请重新提交'
 *   - 不命中的（running 但未超时 / 不是 SUBMITTED / validation_started_at NULL）保持原状
 *
 * 用法：node scripts/test-collab-resume.js
 *
 * 流程：
 *   1. 手工 INSERT 3 个测试场景到 collab_requests
 *   2. 启动 server（触发 setImmediate 恢复扫描）
 *   3. 等 server 启动完成
 *   4. 查 DB 验证状态变化
 *   5. 清理测试数据
 */

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { spawn } = require('child_process');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.run(sql, params, function(err) {
            db.close();
            err ? reject(err) : resolve(this);
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get(sql, params, (err, row) => {
            db.close();
            err ? reject(err) : resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.all(sql, params, (err, rows) => {
            db.close();
            err ? reject(err) : resolve(rows);
        });
    });
}

let passed = 0, failed = 0;
const failures = [];
async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (e) {
        failed++;
        failures.push({ name, error: e.message });
        console.log(`❌ ${name}: ${e.message}`);
    }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function setupTestRows() {
    // 选 id 6/7/8 三条 PENDING 协作单当测试单
    // 场景 1（id=6）：状态 SUBMITTED + sql_validation_status='running' + validation_started_at = 5 分钟前 → 应被恢复为 failed
    // 场景 2（id=7）：状态 SUBMITTED + sql_validation_status='running' + validation_started_at = 5 秒前 → 不应被恢复（未超 90s）
    // 场景 3（id=8）：状态 DONE + sql_validation_status='running'（不应发生但防御性）+ validation_started_at = 5 分钟前 → 不应被恢复（状态不是 SUBMITTED）
    await dbRun(
        `UPDATE collab_requests
            SET status='SUBMITTED', sql_validation_status='running',
                validation_started_at=datetime('now','localtime','-300 seconds'),
                sql_validation_error=NULL
          WHERE id=6`
    );
    await dbRun(
        `UPDATE collab_requests
            SET status='SUBMITTED', sql_validation_status='running',
                validation_started_at=datetime('now','localtime','-5 seconds'),
                sql_validation_error=NULL
          WHERE id=7`
    );
    await dbRun(
        `UPDATE collab_requests
            SET status='DONE', sql_validation_status='running',
                validation_started_at=datetime('now','localtime','-300 seconds'),
                sql_validation_error=NULL
          WHERE id=8`
    );
    console.log('✅ 测试数据已 setup（id=6 应恢复 / id=7 不恢复 / id=8 不恢复）');
}

async function startServer() {
    return new Promise((resolve, reject) => {
        const proc = spawn('node', ['server.js'], {
            cwd: path.join(__dirname, '..'),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let resumeSeen = false;
        let serverReady = false;
        const timer = setTimeout(() => {
            if (!resumeSeen || !serverReady) {
                proc.kill();
                reject(new Error(`server 启动超时 (resumeSeen=${resumeSeen}, serverReady=${serverReady})`));
            }
        }, 15000);
        // logger 输出去向不定（可能 stdout 或 stderr），两个都监听
        function onChunk(s) {
            if (/Server running/.test(s)) serverReady = true;
            if (/\[collab-resume\]/.test(s)) {
                resumeSeen = true;
                console.log('[server-log]', s.trim().split('\n').filter(l => /resume/.test(l)).join(' / '));
            }
            if (serverReady && resumeSeen) {
                clearTimeout(timer);
                setTimeout(() => resolve(proc), 300);
            }
        }
        proc.stdout.on('data', d => onChunk(d.toString()));
        proc.stderr.on('data', d => onChunk(d.toString()));
        proc.on('error', reject);
    });
}

async function main() {
    console.log('=== D3 模块 5 启动恢复扫描集成测试 ===\n');

    // 1. 准备测试数据
    await setupTestRows();

    // 2. 启动 server（触发 collab-resume 扫描）
    console.log('\n正在启动 server...');
    const proc = await startServer();
    console.log('server 启动 + 恢复扫描完成\n');

    // 3. 验证 3 个场景
    await check('场景 1 (id=6) 超时 running 应被恢复为 failed', async () => {
        const row = await dbGet(`SELECT status, sql_validation_status, sql_validation_error FROM collab_requests WHERE id=6`);
        assert(row.sql_validation_status === 'failed', `expected failed, got ${row.sql_validation_status}`);
        assert(/服务重启/.test(row.sql_validation_error || ''), `error 应含"服务重启": ${row.sql_validation_error}`);
        assert(row.status === 'SUBMITTED', `status 应保持 SUBMITTED, got ${row.status}`);
    });

    await check('场景 2 (id=7) 未超时 running 不应被恢复', async () => {
        const row = await dbGet(`SELECT status, sql_validation_status FROM collab_requests WHERE id=7`);
        assert(row.sql_validation_status === 'running', `expected still running, got ${row.sql_validation_status}`);
    });

    await check('场景 3 (id=8) 状态 DONE 即使 running+超时也不应被改', async () => {
        const row = await dbGet(`SELECT status, sql_validation_status FROM collab_requests WHERE id=8`);
        assert(row.status === 'DONE', `status 应保持 DONE, got ${row.status}`);
        assert(row.sql_validation_status === 'running', `sql_validation_status 应保持 running（防御性测试，业务上不该有），got ${row.sql_validation_status}`);
    });

    // 4. 清理
    proc.kill();
    await new Promise(r => setTimeout(r, 500));

    // 重置测试单
    await dbRun(`UPDATE collab_requests SET status='PENDING', sql_validation_status=NULL, sql_validation_error=NULL, validation_started_at=NULL WHERE id IN (6,7,8)`);
    console.log('\n✅ 测试数据已清理');

    console.log(`\n=== 总数: ${passed + failed}, 通过: ${passed}, 失败: ${failed} ===`);
    if (failures.length > 0) {
        console.log('\n失败详情:');
        failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
        process.exit(1);
    }
    console.log('\n全部通过 ✅');
    process.exit(0);
}

main().catch(e => {
    console.error('测试异常:', e);
    process.exit(1);
});
