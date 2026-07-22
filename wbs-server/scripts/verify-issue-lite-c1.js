/**
 * C1 verify · 数据开发换壳（issue_lite）schema 建表
 * 换壳方案 v0.1 §4 / docs/local/HANDOFF.md 附录 A C1
 *
 * 验证点：
 *   ① 启服务后 stdout 出现 "[数据开发换壳 C1] ✅ issue_lite 表就绪"
 *   ② 本地 task_pool.db 里 issue_lite 表存在且 41 关键列全部到位（PRAGMA，含作废 4 列）
 *   ③ 三条索引 idx_issue_lite_status / idx_issue_lite_assignee / idx_issue_lite_voided 存在
 *
 * 用法：node scripts/verify-issue-lite-c1.js
 *   自启服务于 PORT=3399（不碰生产 3000），检查完按端口精确杀（禁全杀 node）。
 *   issue_lite 是纯增量表，在本地 dev 库建它无害（C2/C3 后续测试也复用）。
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const sqlite3 = require('sqlite3');

const TEST_PORT = 3399;
const DB_FILE = path.join(__dirname, '..', 'task_pool.db');
const REQUIRED_COLS = [
    'id', 'title', 'description', 'oa_number',
    'requester_name', 'requester_dept', 'requester_phone',
    'req_date', 'estimated_at', 'assignee_id', 'assignee_name', 'status',
    'complete_note', 'board_url',
    'notify_target_id', 'notify_status', 'notify_at', 'notify_message_key', 'notify_read_at',
    'est_notify_status', 'est_notify_at', 'est_notify_message_key', 'est_notify_read_at',
    'req_notify_status', 'req_notify_at', 'req_notify_message_key', 'req_notify_read_at',
    'dingtalk_chat_id', 'dingtalk_open_conversation_id', 'dingtalk_chat_created_at',
    'dingtalk_chat_created_by', 'dingtalk_chat_name',
    'created_by', 'created_by_name', 'created_at', 'completed_at', 'updated_at',
    // 作废软作废 4 列（作废与查询优化 v0.1 Commit A）
    'voided_at', 'voided_by', 'voided_by_name', 'void_reason'
];
// D1: 校验 status CHECK 为 4 态
const EXPECT_STATUS_CHECK = /CHECK\s*\(\s*status\s+IN\s*\(\s*'待处理'\s*,\s*'处理中'\s*,\s*'已完成'\s*,\s*'已归档'\s*\)/;

// codex 15 C-1 范式（F 收口 sweep）：netstat 本地地址列精确端口比较（findstr :3399 子串匹配会误命中 33990-33999）
function killPort(port) {
    try {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set();
        out.split(/\r?\n/).forEach(line => {
            const cols = line.trim().split(/\s+/);
            if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3])) {
                const m = cols[1].match(/:(\d+)$/);
                if (m && Number(m[1]) === port) pids.add(cols[4]);
            }
        });
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) {} });
    } catch (_) {}
}

function checkDb() {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READONLY, (err) => {
            if (err) return resolve({ ok: false, msg: `打开 db 失败：${err.message}` });
        });
        db.all(`PRAGMA table_info("issue_lite")`, (err, rows) => {
            if (err) { db.close(); return resolve({ ok: false, msg: `PRAGMA 失败：${err.message}` }); }
            const cols = (rows || []).map(r => r.name);
            const missing = REQUIRED_COLS.filter(c => !cols.includes(c));
            db.all(`SELECT name, type, sql FROM sqlite_master WHERE tbl_name='issue_lite' AND type IN ('index','trigger')`, (e2, idxRows) => {
                const idxNames = (idxRows || []).filter(r => r.type === 'index').map(r => r.name);
                let idxMissing = ['idx_issue_lite_status', 'idx_issue_lite_assignee', 'idx_issue_lite_voided'].filter(i => !idxNames.includes(i));
                // datadev 占位号触发器（codex 19 uxH-3·复审 uxL-1）：不止查名——断言定义含 AFTER INSERT +
                //   WHEN NEW.oa_number IS NULL + 'datadev-' || NEW.id（防 IF NOT EXISTS 保留同名陈旧定义）
                const trg = (idxRows || []).find(r => r.type === 'trigger' && r.name === 'trg_issue_lite_datadev_oa');
                const trgSql = (trg && trg.sql) || '';
                const trgOk = /AFTER\s+INSERT/i.test(trgSql) && /WHEN\s+NEW\.oa_number\s+IS\s+NULL/i.test(trgSql)
                    && /'datadev-'\s*\|\|\s*NEW\.id/i.test(trgSql);
                if (!trgOk) idxMissing = idxMissing.concat(['trg_issue_lite_datadev_oa(定义不符或缺失)']);
                db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='issue_lite'`, (e3, row) => {
                    db.close();
                    if (missing.length) return resolve({ ok: false, msg: `issue_lite 缺列：${missing.join(',')}` });
                    if (idxMissing.length) return resolve({ ok: false, msg: `缺索引：${idxMissing.join(',')}` });
                    if (!row || !EXPECT_STATUS_CHECK.test(row.sql)) return resolve({ ok: false, msg: `status CHECK 非 4 态（待处理/处理中/已完成/已归档）` });
                    resolve({ ok: true, msg: `issue_lite 列齐(${cols.length}) + 索引齐 + status 4 态 CHECK`, cols });
                });
            });
        });
    });
}

(async () => {
    killPort(TEST_PORT); // 起前先清端口
    let stdout = '';
    const child = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' },
    });
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stdout += d.toString(); });

    // 等待就绪（最多 12s，轮询日志出现 ready 行）
    const deadline = Date.now() + 12000;
    let ready = false;
    while (Date.now() < deadline) {
        if (/数据开发换壳 C1] ✅ issue_lite 表就绪/.test(stdout)) { ready = true; break; }
        if (/数据开发换壳 C1] 🚫/.test(stdout)) break;
        await new Promise(r => setTimeout(r, 400));
    }

    const dbRes = await checkDb();

    // 清理：按端口精确杀（child + 端口双保险）
    try { child.kill('SIGKILL'); } catch (_) {}
    killPort(TEST_PORT);

    const logOk = ready;
    console.log('─────── C1 verify 结果 ───────');
    console.log(`① 启动日志 ready 行：${logOk ? '✅ PASS' : '❌ FAIL（未见 ready 日志）'}`);
    console.log(`② db 表结构：${dbRes.ok ? '✅ PASS · ' + dbRes.msg : '❌ FAIL · ' + dbRes.msg}`);
    if (!logOk) {
        const tail = stdout.split(/\r?\n/).filter(l => /数据开发换壳|Error|error|listen|EADDR/.test(l)).slice(-10).join('\n');
        console.log('  日志摘录：\n' + (tail || '(无相关日志)'));
    }
    const pass = logOk && dbRes.ok;
    console.log(`\n总判定：${pass ? '✅ C1 PASS' : '❌ C1 FAIL'}`);
    process.exit(pass ? 0 : 1);
})();
