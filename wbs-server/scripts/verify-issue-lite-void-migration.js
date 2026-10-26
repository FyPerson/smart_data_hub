/**
 * 迁移 verify · 数据开发台账 作废与查询优化 Commit A（7b 闸门）
 * 方案：docs/local/数据开发换壳/数据开发台账作废与查询优化_临时实施计划_20260722_v0.1.md §8.1
 *
 * 证明：生产旧 37 列 issue_lite 表经真实服务启动迁移（safeAlterAddColumn ×4 + idx_voided）后——
 *   ① 41 列齐（作废 4 列补到位）② idx_issue_lite_voided 存在 ③ 原行数守恒
 *   ④ 旧行 voided_at 全 NULL ⑤ 旧行原列值逐行逐列无损（含 completed_at/notify/群字段）
 *   ⑥ status CHECK 仍 4 态（表未重建）⑦ readiness：health/ready 里 issue_lite 模块就绪 ⑧ 二次启动幂等
 * 关键：专测"生产已有 37 列表 ALTER"场景（issue_lite DDL 内联在服务启动代码里，无法 require 隔离，
 *   故走「旧库 → 起真实服务 → 复查」e2e，非复刻迁移逻辑——避免脚本与生产路径分叉）。
 *
 * 用法：
 *   node scripts/verify-issue-lite-void-migration.js            # 自造旧 37 列样本库（3 行覆盖 3 态）
 *   node scripts/verify-issue-lite-void-migration.js --db <生产副本.db>   # 7b：用生产副本真实样本跑
 *   ⚠️ --db 的副本必须是冷备（停服后拷贝）或 SQLite backup API 产物——热拷贝可能缺 WAL 尾部提交，
 *     脚本会对副本跑 PRAGMA quick_check + issue_lite 存在性核对，异常即终止（codex 13 M-5）。
 *
 * [#106 S4b1] 彻底不再碰业务库：原来「把检出里的业务库备份成 .migbak、换入待迁移库、起真服务、还原」的整套换库 / 拒跑 / 杀端口逻辑全部删除。
 *   现在待迁移库（自造样本或 --db 副本）放在系统临时目录（mkdtemp），作为 lib/test-instance.js 的来源库（sourceDbPath，sourceEncryptionKey: null
 *   表示不解密、白名单配置丢弃——本验证只看 issue_lite），由启动器 VACUUM INTO 出一份隔离实例库后起临时隔离实例；隔离化只动身份表 / system_configs /
 *   db_connections，不碰 issue_lite 的行，所以「逐行逐列无损」口径不变。
 *   二次启动：先对第一个实例的库做只读 VACUUM INTO 快照，停掉第一个实例，再以该快照作来源起第二个实例（快照带实例身份表 = 隔离库来源，启动器自行处理）。
 *   本脚本不经 test-env.ready()：它需要两个来源库不同的实例，且来源库运行时才造出来；实例的起停由本脚本直接用启动器完成，finally 里 stop 两个实例并删除临时目录。
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const testInstance = require('./lib/test-instance');

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
const ok = (cond, label, detail) => {
    if (cond) console.log('  ✓ ' + label);
    else { failures.push(label + (detail ? ` — ${detail}` : '')); console.log('  ✗ ' + label + (detail ? ` — ${detail}` : '')); }
};

function openDb(file, mode) {
    return new Promise((resolve, reject) => {
        const d = new sqlite3.Database(file, mode, (err) => err ? reject(err) : resolve(d));
    });
}
const dAll = (d, sql, p = []) => new Promise((res, rej) => d.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const dRun = (d, sql, p = []) => new Promise((res, rej) => d.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const dClose = (d) => new Promise((res) => d.close(() => res()));

// 造旧 37 列样本库：3 行覆盖 待处理 / 已完成(通知+群字段全) / 已归档（文件在临时目录里新建）
async function buildOldSampleDb(file) {
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

// 对运行中的实例库做只读 VACUUM INTO，拿一份一致的快照（目标文件必须不存在）
async function vacuumCopy(srcFile, dstFile) {
    const d = await openDb(srcFile, sqlite3.OPEN_READONLY);
    try { await dRun(d, 'VACUUM INTO ?', [dstFile]); } finally { await dClose(d); }
}

// 用启动器起一个临时隔离实例（来源库 = sourceDbPath；不解密来源配置）。只等 core + issue_lite 两个模块就绪（本验证只看 issue_lite）
function startFrom(sourceDbPath) {
    return testInstance.startTestInstance({ sourceDbPath, sourceEncryptionKey: null, modules: ['core', 'issue_lite'] });
}

// readiness：真实请求 GET /api/health/ready，issue_lite 模块 ready（不钉日志文案）
async function issueLiteReady(baseUrl) {
    try {
        const r = await fetch(`${baseUrl}/api/health/ready`);
        const b = await r.json().catch(() => null);
        const m = b && b.modules && b.modules.issue_lite;
        return { ready: !!m && m.ready === true, detail: JSON.stringify(m) };
    } catch (e) { return { ready: false, detail: `请求失败：${e.message}` }; }
}

// 删临时目录：逐个 unlinkSync / rmdirSync（不用 fs.rmSync：Node v24 对含中文路径静默不删），删后 existsSync 确认；返回残留描述（空串 = 已删净）
function removeTmpDir(dir) {
    if (!dir) return '';
    try {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const st = fs.lstatSync(full);
            if (st.isDirectory()) { removeTmpDir(full); continue; }
            fs.unlinkSync(full);
        }
        fs.rmdirSync(dir);
    } catch (e) { /* 以下面的存在性检查为准 */ }
    return fs.existsSync(dir) ? `临时目录仍存在：${dir}` : '';
}

(async () => {
    process.exitCode = 1;   // 失败退出码先设上：中途被杀 / 未捕获异常 / 事件循环提前排空，退出码都不会是 0；最后全部成功才改成 0（见文末）
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

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-void-mig-'));
    const tmpOld = path.join(tmpDir, 'old-sample.db');
    const tmpSnap = path.join(tmpDir, 'migrated-snapshot.db');
    let inst1 = null;
    let inst2 = null;
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
        if (failures.length) throw new Error('副本健康检查未通过，终止（不起实例）');

        // 迁移前快照 + 前置断言：旧库恰为 37 列基线（codex 13 M-4 精确列数；已迁过/schema 漂移直接暴露）
        const before = await snapshotRows(tmpOld);
        const preHasVoid = VOID_COLS.filter(c => before.cols.includes(c));
        ok(before.cols.length === 37 && preHasVoid.length === 0,
            `迁移前旧库恰 37 列且无作废列（实际 ${before.cols.length} 列）`,
            preHasVoid.length ? `已含 ${preHasVoid.join(',')}（非旧库？）` : '');
        ok(before.rows.length > 0, `旧库有样本行（${before.rows.length} 行）`);
        if (failures.length) throw new Error('迁移前基线断言未通过，终止（不起实例）');

        // [2] 起真实服务触发迁移（临时隔离实例，来源 = 旧样本库快照）
        inst1 = await startFrom(tmpOld);
        const r1 = await issueLiteReady(inst1.baseUrl);
        ok(r1.ready, 'readiness：首次启动 health/ready 里 issue_lite 模块就绪', r1.detail);
        // 等 serialize 队列里 ALTER/INDEX 全落盘（模块就绪在 PRAGMA 复查后置位，已隐含；再留短余量防未刷盘）
        await new Promise(r => setTimeout(r, 800));

        // [3] 迁移后断言（读实例库）
        const after = await snapshotRows(inst1.dbPath);
        const missing = VOID_COLS.filter(c => !after.cols.includes(c));
        ok(after.cols.length === 41 && missing.length === 0,
            `作废 4 列补齐且恰 41 列（${before.cols.length} → ${after.cols.length} 列）`, missing.join(','));
        const d2 = await openDb(inst1.dbPath, sqlite3.OPEN_READONLY);
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

        // [4] 二次启动幂等（duplicate column 被吞、readiness 仍 ready、全行值不变——codex 13 M-4）：
        //     对第一个实例的库做只读 VACUUM INTO 快照 → 停掉第一个实例 → 以快照作来源起第二个实例
        await vacuumCopy(inst1.dbPath, tmpSnap);
        await inst1.stop();
        inst1 = null;
        inst2 = await startFrom(tmpSnap);
        const r2 = await issueLiteReady(inst2.baseUrl);
        ok(r2.ready, 'readiness：二次启动仍 ready（ALTER 幂等）', r2.detail);
        await new Promise(r => setTimeout(r, 800));
        const again = await snapshotRows(inst2.dbPath);
        ok(again.cols.length === after.cols.length && again.cols.join('|') === after.cols.join('|'),
            `二次启动后列集不变（${again.cols.length} 列）`);
        ok(JSON.stringify(again.rows) === JSON.stringify(after.rows),
            `二次启动后全行值与首次迁移后快照逐字节一致（${again.rows.length} 行）`);
    } catch (e) {
        failures.push('执行异常：' + (e && e.message));
        console.log('  ✗ 执行异常 — ' + (e && e.message));
        // 诊断信息（保留在最终版）：启动器的 TestInstanceError 带 code、服务日志尾部 logTail（已脱敏）、数据根 dataDir（清理未完成时才有）
        if (e && e.code) console.log('    [诊断] e.code = ' + e.code);
        if (e && e.dataDir) console.log('    [诊断] e.dataDir = ' + e.dataDir);
        if (e && e.logTail) console.log('    [诊断] e.logTail =\n' + String(e.logTail).split('\n').map((l) => '      | ' + l).join('\n'));
    } finally {
        // 收尾：先停实例（stop() 先收进程、等退出、再删实例数据根并确认），再删临时目录；任何一步没做到都计入失败，不静默
        for (const [label, inst] of [['第一个实例', inst1], ['第二个实例', inst2]]) {
            if (!inst) continue;
            try { await inst.stop(); } catch (e) { failures.push(`收掉${label}失败：${e && e.message}`); console.log(`  ✗ 收掉${label}失败 — ${e && e.message}`); }
        }
        const left = removeTmpDir(tmpDir);
        if (left) { failures.push(left); console.log('  ✗ ' + left); }
    }

    console.log(`\n总判定：${failures.length === 0 ? '✅ 迁移 verify PASS' : `❌ FAIL（${failures.length} 项）`}`);
    failures.forEach(f => console.log('  - ' + f));
    // 收尾：设退出码，让事件循环自然结束；10 秒 unref 兜底强退（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
    const exitCode = failures.length === 0 ? 0 : 1;
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), 10000).unref();
})().catch((e) => {
    console.error('迁移 verify 异常：', e && e.stack || e);
    process.exit(1);
});
