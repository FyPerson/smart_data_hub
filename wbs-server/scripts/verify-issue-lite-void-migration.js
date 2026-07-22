/**
 * 迁移 verify · 数据开发台账 作废与查询优化 Commit A（7b 闸门）
 * 方案：docs/local/数据开发换壳/数据开发台账作废与查询优化_临时实施计划_20260722_v0.1.md §8.1
 *
 * 证明：生产旧 37 列 issue_lite 表经真实 server.js 启动迁移（safeAlterAddColumn ×4 + idx_voided）后——
 *   ① 41 列齐（作废 4 列补到位）② idx_issue_lite_voided 存在 ③ 原行数守恒
 *   ④ 旧行 voided_at 全 NULL ⑤ 旧行原列值逐行逐列无损（含 completed_at/notify/群字段）
 *   ⑥ status CHECK 仍 4 态（表未重建）⑦ readiness ready 日志出现 ⑧ 二次启动幂等
 * 关键：专测"生产已有 37 列表 ALTER"场景（issue_lite DDL 内联 server.js，无法 require 隔离，
 *   故走「换入旧库 → 起真实 server → 复查 → 还原」e2e，非复刻迁移逻辑——避免脚本与生产路径分叉）。
 *
 * 用法：
 *   node scripts/verify-issue-lite-void-migration.js            # 自造旧 37 列样本库（3 行覆盖 3 态）
 *   node scripts/verify-issue-lite-void-migration.js --db <生产副本.db>   # 7b：用生产副本真实样本跑
 *   ⚠️ --db 的副本必须是冷备（停服后拷贝）或 SQLite backup API 产物——热拷贝可能缺 WAL 尾部提交，
 *     脚本会对副本跑 PRAGMA quick_check + issue_lite 存在性核对，异常即终止（codex 13 M-5）。
 *
 * 安全（codex 13 H-2/H-3/H-4 加固）：自启服务于 PORT=3399；执行期把 wbs-server/task_pool.db 换成
 *   待迁移库，结束后 finally 还原（备份在同目录 task_pool.db.migbak）。前置守卫全部"存在即拒绝"：
 *   - .migbak 已存在 → 拒绝（上次硬终止残留，唯一原始备份，绝不覆盖；需人工确认还原后删除）
 *   - task_pool.db-wal/-shm 存在 → 拒绝（可能有活跃连接/未 checkpoint 提交，不静默删）
 *   - 本地 3000/3100/3200 任一端口有服务 → 拒绝（并行开发范式三端口都可能占用 dev 库）
 *   注意：finally 只覆盖正常异常传播；进程被强杀/断电时不自动还原——.migbak 即人工恢复依据。
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');

const TEST_PORT = 3399;
const SERVER_DIR = path.join(__dirname, '..');
const DB_FILE = path.join(SERVER_DIR, 'task_pool.db');
const BAK_FILE = DB_FILE + '.migbak';
const VOID_COLS = ['voided_at', 'voided_by', 'voided_by_name', 'void_reason'];
// 旧库（v1.121.x 生产）37 列 —— 忠实换壳 D1 上线版 CREATE TABLE，不含作废 4 列
const OLD_DDL = `CREATE TABLE issue_lite (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL,
    description   TEXT,
    oa_number     TEXT,
    requester_name  TEXT NOT NULL,
    requester_dept  TEXT NOT NULL,
    requester_phone TEXT NOT NULL,
    req_date      TEXT,
    estimated_at  TEXT,
    assignee_id   INTEGER NOT NULL,
    assignee_name TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT '待处理' CHECK (status IN ('待处理','处理中','已完成','已归档')),
    complete_note TEXT,
    board_url     TEXT,
    notify_target_id   INTEGER,
    notify_status      TEXT,
    notify_at          DATETIME,
    notify_message_key TEXT,
    notify_read_at     DATETIME,
    est_notify_status      TEXT,
    est_notify_at          DATETIME,
    est_notify_message_key TEXT,
    est_notify_read_at     DATETIME,
    req_notify_status      TEXT,
    req_notify_at          DATETIME,
    req_notify_message_key TEXT,
    req_notify_read_at     DATETIME,
    dingtalk_chat_id              TEXT,
    dingtalk_open_conversation_id TEXT,
    dingtalk_chat_created_at      DATETIME,
    dingtalk_chat_created_by      INTEGER,
    dingtalk_chat_name            TEXT,
    created_by    INTEGER NOT NULL,
    created_by_name TEXT,
    created_at    DATETIME DEFAULT (datetime('now','localtime')),
    completed_at  DATETIME,
    updated_at    DATETIME DEFAULT (datetime('now','localtime'))
)`;

let failures = [];
// codex 13复审 H-1：子进程未确认退出时置真——此后禁止一切 db 访问/清理/还原（finally 保留现场 + .migbak）
let dbUnsafe = false;
const ok = (cond, label, detail) => {
    if (cond) console.log('  ✓ ' + label);
    else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log('  ✗ ' + label + (detail ? ` — ${detail}` : '')); }
};

// codex 15 C-1：解析 netstat 本地地址列做**精确端口**比较（findstr :3399 子串匹配会误命中 33990-33999）
function listListeningPids(port) {
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
        return pids;
    } catch (_) { return new Set(); }
}
function portListening(port) { return listListeningPids(port).size > 0; }
function killPort(port) {
    listListeningPids(port).forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) {} });
}
function rmSidecars(base) {
    ['-wal', '-shm'].forEach(sfx => { try { fs.unlinkSync(base + sfx); } catch (_) {} });
}

function openDb(file, mode) {
    return new Promise((resolve, reject) => {
        const d = new sqlite3.Database(file, mode, (err) => err ? reject(err) : resolve(d));
    });
}
const dAll = (d, sql, p = []) => new Promise((res, rej) => d.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const dRun = (d, sql, p = []) => new Promise((res, rej) => d.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const dClose = (d) => new Promise((res) => d.close(() => res()));

// 造旧 37 列样本库：3 行覆盖 待处理 / 已完成(通知+群字段全) / 已归档
async function buildOldSampleDb(file) {
    try { fs.unlinkSync(file); } catch (_) {}
    const d = await openDb(file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
    await dRun(d, OLD_DDL);
    await dRun(d, `CREATE INDEX idx_issue_lite_status ON issue_lite(status)`);
    await dRun(d, `CREATE INDEX idx_issue_lite_assignee ON issue_lite(assignee_id)`);
    await dRun(d, `INSERT INTO issue_lite (title, description, oa_number, requester_name, requester_dept, requester_phone,
        req_date, assignee_id, assignee_name, status, created_by, created_by_name, created_at, updated_at)
        VALUES ('样本-待处理', '描述A', 'OA-1001', '张三', '财务部', '13800000001',
        '2026-07-30', 10, '示例开发C', '待处理', 3, '示例用户A', '2026-07-20 10:00:00', '2026-07-20 10:00:00')`);
    await dRun(d, `INSERT INTO issue_lite (title, description, requester_name, requester_dept, requester_phone,
        req_date, estimated_at, assignee_id, assignee_name, status, complete_note, board_url,
        notify_target_id, notify_status, notify_at, notify_message_key, notify_read_at,
        est_notify_status, est_notify_at, est_notify_message_key,
        req_notify_status, req_notify_at, req_notify_message_key, req_notify_read_at,
        dingtalk_chat_id, dingtalk_open_conversation_id, dingtalk_chat_created_at, dingtalk_chat_created_by, dingtalk_chat_name,
        created_by, created_by_name, created_at, completed_at, updated_at)
        VALUES ('样本-已完成', '描述B', '李四', '运营中心', '13800000002',
        '2026-07-25', '2026-07-24', 10, '示例开发C', '已完成', '看板已交付', 'https://bi.example/board/1',
        3, 'sent', '2026-07-21 09:00:00', 'mk-n1-001', '2026-07-21 09:30:00',
        'sent', '2026-07-21 10:00:00', 'mk-est-001',
        'sent', '2026-07-22 15:00:00', 'mk-n2-001', '2026-07-22 15:20:00',
        'chat-1', 'cid-open-1', '2026-07-21 11:00:00', 3, '数据开发-样本群',
        3, '示例用户A', '2026-07-20 11:00:00', '2026-07-22 14:59:00', '2026-07-22 15:00:00')`);
    await dRun(d, `INSERT INTO issue_lite (title, requester_name, requester_dept, requester_phone,
        assignee_id, assignee_name, status, created_by, created_by_name, created_at, completed_at, updated_at)
        VALUES ('样本-已归档', '王五', '人力资源部', '13800000003',
        10, '示例开发C', '已归档', 10, '示例开发C', '2026-07-18 09:00:00', '2026-07-19 18:00:00', '2026-07-19 18:30:00')`);
    await dClose(d);
}

// 快照：迁移前后逐行逐列对比的基准（旧 37 列全取）
async function snapshotRows(file) {
    const d = await openDb(file, sqlite3.OPEN_READONLY);
    const cols = (await dAll(d, `PRAGMA table_info("issue_lite")`)).map(r => r.name);
    const rows = await dAll(d, `SELECT * FROM issue_lite ORDER BY id`);
    await dClose(d);
    return { cols, rows };
}

async function startServerAndWaitReady() {
    let stdout = '';
    let spawnError = null;   // codex 13 H-4：error 事件必须有监听——否则未捕获异常绕过外层 finally
    const child = spawn('node', ['server.js'], {
        cwd: SERVER_DIR,
        env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' },
    });
    child.on('error', (e) => { spawnError = e; });
    const closed = new Promise((resolve) => child.on('close', resolve));
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stdout += d.toString(); });
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
        if (spawnError) break;
        if (/数据开发换壳 C1] ✅ issue_lite 表就绪/.test(stdout)) { ready = true; break; }
        if (/数据开发换壳 C1] 🚫/.test(stdout)) break;
        await new Promise(r => setTimeout(r, 400));
    }
    // 等 serialize 队列里 ALTER/INDEX 全落盘（ready 日志在 PRAGMA 复查后打，已隐含；再留短余量防未刷盘）
    await new Promise(r => setTimeout(r, 800));
    try { child.kill('SIGKILL'); } catch (_) {}
    killPort(TEST_PORT);
    // codex 13 H-4 + 复审 H-1：等子进程真正 close（句柄释放）再动 db 文件；5s 超时后若进程仍未确认
    //   退出（exitCode/signalCode 均空 或 端口仍在听）→ 置 dbUnsafe，此后禁止换库/还原/清 sidecar
    const closeResult = await Promise.race([
        closed.then(() => 'closed'),
        new Promise(r => setTimeout(() => r('timeout'), 5000)),
    ]);
    if (closeResult === 'timeout' && ((child.exitCode === null && child.signalCode === null) || portListening(TEST_PORT))) {
        dbUnsafe = true;
        stdout += '\n[dbUnsafe] 子进程未确认退出（close 超时且 exitCode/signalCode 为空或端口仍监听）';
    }
    if (spawnError) stdout += `\n[spawn error] ${spawnError.message}`;
    return { ready: ready && !spawnError, stdout };
}

(async () => {
    const argIdx = process.argv.indexOf('--db');
    let srcDb = null;
    if (argIdx > -1) {
        srcDb = process.argv[argIdx + 1];
        // codex 13复审 L-1：--db 缺路径不允许静默退化为自造样本模式（会让 7b 假通过）
        if (!srcDb || srcDb.startsWith('--')) {
            console.error('❌ --db 后必须跟生产副本路径（缺失时不退化为自造样本模式）。');
            process.exit(1);
        }
    }
    console.log(`=== 数据开发台账 作废 4 列迁移 verify（${srcDb ? '生产副本：' + srcDb : '自造旧 37 列样本库'}）===\n`);

    // ── 前置守卫（codex 13 H-2/H-3：全部"存在即拒绝"，不静默清理）─────────────
    if (fs.existsSync(BAK_FILE)) {
        console.error(`❌ ${BAK_FILE} 已存在——上次运行可能在换库后被强制终止，它是唯一的原始 dev 库备份，拒绝覆盖。`);
        console.error('   人工处置：确认当前 task_pool.db 是否为测试残留库 → 手动把 .migbak 还原为 task_pool.db → 删除 .migbak 后重跑。');
        process.exit(1);
    }
    for (const p of [3000, 3100, 3200]) {
        if (portListening(p)) {
            console.error(`❌ 本地 ${p} 端口有服务在监听（并行开发范式端口，可能占用 task_pool.db），先停本地服务再跑本脚本。`);
            process.exit(1);
        }
    }
    const sidecars = ['-wal', '-shm'].map(s => DB_FILE + s).filter(f => fs.existsSync(f));
    if (sidecars.length) {
        console.error(`❌ 检测到 ${sidecars.join(' / ')}——可能有活跃连接或未 checkpoint 的提交，拒绝执行（不静默删除）。`);
        console.error('   人工处置：确认无进程使用 dev 库后，用 sqlite3 打开一次让其自然 checkpoint/清理，再重跑。');
        process.exit(1);
    }
    if (!fs.existsSync(DB_FILE)) {
        console.error(`❌ 未找到 ${DB_FILE}（脚本假定 wbs-server 下已有 dev 库可备份还原）。`);
        process.exit(1);
    }
    if (srcDb && !fs.existsSync(srcDb)) {
        console.error(`❌ 指定的生产副本不存在：${srcDb}`);
        process.exit(1);
    }
    if (srcDb) {
        // codex 13复审 M-2：副本自身旁若有 -wal/-shm = 热拷贝物证（主文件缺 WAL 尾部提交）→ 拒绝
        const srcSidecars = ['-wal', '-shm'].map(s => srcDb + s).filter(f => fs.existsSync(f));
        if (srcSidecars.length) {
            console.error(`❌ 副本旁存在 ${srcSidecars.join(' / ')}——这是热拷贝（主文件可能缺 WAL 尾部提交），拒绝执行。`);
            console.error('   请提供停服后的冷备副本或 SQLite backup API 产物。');
            process.exit(1);
        }
    }
    killPort(TEST_PORT);

    // [1] 备份 dev 库 → 换入待迁移旧库
    fs.copyFileSync(DB_FILE, BAK_FILE);
    const tmpOld = path.join(__dirname, '_issue_lite_old_sample.db');
    try {
        if (srcDb) fs.copyFileSync(srcDb, tmpOld);
        else await buildOldSampleDb(tmpOld);

        // 副本健康检查（codex 13 M-5/复审 M-2）：quick_check 只证明**主文件内部一致性**，不证明未遗漏
        //   WAL 提交——热拷贝由上方 srcDb sidecar 守卫拦截（自造样本也顺带跑，零成本）
        const dHealth = await openDb(tmpOld, sqlite3.OPEN_READONLY);
        const qc = await dAll(dHealth, `PRAGMA quick_check`);
        const hasTable = await dAll(dHealth, `SELECT name FROM sqlite_master WHERE type='table' AND name='issue_lite'`);
        await dClose(dHealth);
        ok(qc.length === 1 && String(qc[0].quick_check) === 'ok', 'PRAGMA quick_check = ok（主文件内部一致性）',
            JSON.stringify(qc).slice(0, 200));
        ok(hasTable.length === 1, '副本含 issue_lite 表');
        if (failures.length) throw new Error('副本健康检查未通过，终止（不换库）');

        // 迁移前快照 + 前置断言：旧库恰为 37 列基线（codex 13 M-4 精确列数；已迁过/schema 漂移直接暴露）
        const before = await snapshotRows(tmpOld);
        const preHasVoid = VOID_COLS.filter(c => before.cols.includes(c));
        ok(before.cols.length === 37 && preHasVoid.length === 0,
            `迁移前旧库恰 37 列且无作废列（实际 ${before.cols.length} 列）`,
            preHasVoid.length ? `已含 ${preHasVoid.join(',')}（非旧库？）` : '');
        ok(before.rows.length > 0, `旧库有样本行（${before.rows.length} 行）`);
        if (failures.length) throw new Error('迁移前基线断言未通过，终止（不换库）');

        fs.copyFileSync(tmpOld, DB_FILE);

        // [2] 起真实 server 触发迁移
        const r1 = await startServerAndWaitReady();
        if (dbUnsafe) throw new Error('子进程未确认退出，禁止继续访问 db（见日志 [dbUnsafe]）');
        ok(r1.ready, 'readiness：首次启动出现 ✅ issue_lite 表就绪 日志');
        if (!r1.ready) {
            const tail = r1.stdout.split(/\r?\n/).filter(l => /数据开发换壳|Error|error|EADDR|dbUnsafe/.test(l)).slice(-10).join('\n');
            console.log('  日志摘录：\n' + (tail || '(无相关日志)'));
        }

        // [3] 迁移后断言
        const after = await snapshotRows(DB_FILE);
        const missing = VOID_COLS.filter(c => !after.cols.includes(c));
        ok(after.cols.length === 41 && missing.length === 0,
            `作废 4 列补齐且恰 41 列（${before.cols.length} → ${after.cols.length} 列）`, missing.join(','));
        const d2 = await openDb(DB_FILE, sqlite3.OPEN_READONLY);
        // 类型签名（codex 13 M-1）：同名错型列会被 duplicate 吞掉，按声明类型核对
        const tinfo = await dAll(d2, `PRAGMA table_info("issue_lite")`);
        const typeOf = (n) => { const r = tinfo.find(x => x.name === n); return r ? String(r.type).toUpperCase() : '(缺)'; };
        const expectTypes = { voided_at: 'DATETIME', voided_by: 'INTEGER', voided_by_name: 'TEXT', void_reason: 'TEXT' };
        const badTypes = Object.entries(expectTypes).filter(([c, t]) => typeOf(c) !== t)
            .map(([c, t]) => `${c}: 期望 ${t} 实际 ${typeOf(c)}`);
        ok(badTypes.length === 0, '作废 4 列类型签名正确（DATETIME/INTEGER/TEXT/TEXT）', badTypes.join('; '));
        // 索引结构等价断言（codex 13 M-2 + 复审 M-1）：限定表名 + index_info 恰一列 voided_at + 非部分索引
        const idxDef = await dAll(d2, `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_issue_lite_voided' AND tbl_name='issue_lite'`);
        const idxInfo = await dAll(d2, `PRAGMA index_info('idx_issue_lite_voided')`);
        const idxList = await dAll(d2, `PRAGMA index_list('issue_lite')`);
        const idxEntry = idxList.find(r => r.name === 'idx_issue_lite_voided');
        ok(idxDef.length === 1 && idxInfo.length === 1 && idxInfo[0].name === 'voided_at'
            && !!idxEntry && Number(idxEntry.partial) === 0,
            'idx_issue_lite_voided 结构等价（挂 issue_lite·恰一列 voided_at·非部分索引）',
            `def=${idxDef.length} info=${JSON.stringify(idxInfo)} partial=${idxEntry ? idxEntry.partial : '(缺)'}`);
        const tbl = await dAll(d2, `SELECT sql FROM sqlite_master WHERE type='table' AND name='issue_lite'`);
        ok(/CHECK\s*\(\s*status\s+IN\s*\(\s*'待处理'\s*,\s*'处理中'\s*,\s*'已完成'\s*,\s*'已归档'\s*\)/.test(tbl[0] && tbl[0].sql),
            'status CHECK 仍为 4 态（表未重建，ALTER 增量）');
        await dClose(d2);
        ok(after.rows.length === before.rows.length, `行数守恒（${before.rows.length} → ${after.rows.length}）`);
        ok(after.rows.every(r => r.voided_at === null && r.voided_by === null && r.voided_by_name === null && r.void_reason === null),
            '旧行作废 4 列全 NULL（存量单均为正常态）');
        // 逐行逐列无损（codex 13 M-4）：严格 === 比较（类型敏感——数值 1 与文本 '1' 视为不同）
        let lossless = true, lossDetail = '';
        const afterById = new Map(after.rows.map(r => [r.id, r]));
        for (const b of before.rows) {
            const a = afterById.get(b.id);
            if (!a) { lossless = false; lossDetail = `id=${b.id} 迁移后丢失`; break; }
            for (const c of before.cols) {
                if (a[c] !== b[c]) {
                    lossless = false;
                    lossDetail = `id=${b.id} 列 ${c}：${typeof b[c]}'${b[c]}' → ${typeof a[c]}'${a[c]}'`;
                    break;
                }
            }
            if (!lossless) break;
        }
        ok(lossless, '旧行原列值逐行逐列无损（严格类型敏感比较·含 completed_at/notify/群字段）', lossDetail);

        // [4] 二次启动幂等（duplicate column 被吞、readiness 仍 ready、全行值不变——codex 13 M-4）
        const r2 = await startServerAndWaitReady();
        if (dbUnsafe) throw new Error('子进程未确认退出，禁止继续访问 db（见日志 [dbUnsafe]）');
        ok(r2.ready, 'readiness：二次启动仍 ready（ALTER 幂等）');
        const again = await snapshotRows(DB_FILE);
        ok(again.cols.length === after.cols.length && again.cols.join('|') === after.cols.join('|'),
            `二次启动后列集不变（${again.cols.length} 列）`);
        ok(JSON.stringify(again.rows) === JSON.stringify(after.rows),
            `二次启动后全行值与首次迁移后快照逐字节一致（${again.rows.length} 行）`);
    } finally {
        // [5] 还原 dev 库——仅在"服务已确认停止"时自动还原（codex 13复审 H-1）；
        //     dbUnsafe 时保留现场 + .migbak，绝不在进程可能仍持有 db 时清 sidecar/覆盖主文件
        if (dbUnsafe) {
            console.error(`⚠️ [dbUnsafe] 测试服务未确认退出，跳过自动还原。人工处置（顺序不可颠倒，全程保持无进程打开该库）：`);
            console.error(`   ① 确认 3399 端口进程已停（netstat -ano | findstr :3399）并手动结束，勿重启任何本地服务`);
            console.error(`   ② 先删除测试库残留 task_pool.db-wal / -shm → 再把 ${BAK_FILE} 覆盖还原为 task_pool.db → 确认恢复成功后删除 .migbak`);
        } else {
            try { killPort(TEST_PORT); } catch (_) {}
            rmSidecars(DB_FILE);
            try { fs.copyFileSync(BAK_FILE, DB_FILE); fs.unlinkSync(BAK_FILE); } catch (e) {
                console.error(`⚠️ 还原 dev 库失败：${e.message}（备份保留在 ${BAK_FILE}，需手动还原）`);
            }
            try { fs.unlinkSync(tmpOld); } catch (_) {}
        }
    }

    console.log(`\n总判定：${failures.length === 0 ? '✅ 迁移 verify PASS' : `❌ FAIL（${failures.length} 项）`}`);
    failures.forEach(f => console.log('  - ' + f));
    process.exit(failures.length === 0 ? 0 : 1);
})();
