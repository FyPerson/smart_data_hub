/**
 * 前端统一 C-pre 视觉回归基线 harness
 *
 * 用法：
 *   拍基线：PORT=3100 node scripts/test-unify-visual-playwright.js --shot baseline
 *     （server 可先手动起好；若探测不到已在跑的 server，本脚本会自己 spawn 一个，跑完自动 kill）
 *   比对两组截图（改造前后 / 复现性自证）：
 *     node scripts/test-unify-visual-playwright.js --compare baseline after-c1
 *     （labelA labelB 对应 unify-baseline/ 下两个子目录；按文件名逐名配对做像素比对）
 *
 * ⚠️ 比对标准（两轮自证实测定标，字节级全同在本机 Chromium 上不可达）：
 *   Chromium 光栅化存在随机性 AA 抖动——同库同代码连续两轮，28 张中约 2-4 张出现 ≤30 个像素、
 *   单通道 |Δ|≤2 的亚可见噪声（圆角/图标边缘 AA 合成处，且每轮中招文件随机）。故一致判定用容差：
 *   **单通道 |Δ|≤2 且差异像素占比 ≤0.01% 且差异像素绝对数 ≤30 → 视为一致**（30 = 实测噪声上界
 *   29px + 1 余量；占比上限随图面积浮动，绝对上限钉死噪声规模）。真实内容改动（文字/布局/配色）
 *   产生成百上千像素 + 大通道差，与噪声界限清晰，不会误判。
 *
 * 范围：
 *   - 五页（Data_Correction / Sys_Iteration / Issue_Tracker / Data_Collab / Periodic_Fetch）改造前基线截图
 *   - 每页按 API 建 1-2 个带 [UNIFY-BASELINE] 前缀的 fixture 单，跳指定 id/状态截图，跑完清理 fixture
 *   - 2 viewport（1440×900 桌面 + 768×1024 窄屏）× 各页态（列表/详情/建单，Periodic_Fetch 为 列表/modal）
 *   - JWT 注入走 login.html 中继跳转（鉴权页直接 goto 会被 checkAuth 销毁 context，照抄
 *     test-model-center-sort-playwright.js 范式）；fixture 造数走真实 API（照抄
 *     verify-correction-creator-e2e.js 的裸 http 请求 + seed/cleanup 范式）
 *
 * ⚠️⚠️ 同库契约（codex 审 H-1，逐像素比对的前提）：
 *   改造后对比截图必须使用与基线**同一份 task_pool.db 副本**跑出——列表态截图含库内既有数据
 *   （行内容/统计卡计数/分页），换库、换环境、或主库新快照重放后跑出的截图**不可**与本基线逐名
 *   逐像素比对（只能人工看结构）。
 *
 * 可复现性设计（codex 审 H-1 修复，保证同库同代码重跑逐像素一致）：
 *   1. fixture 可见字段全固定：标题/OA 号/任务名不含 Date.now() 等动态成分；
 *   2. fixture id 固定化：五张父表均为 AUTOINCREMENT（删后不复用 id），API 建单后用 db 直连把
 *      父行 id + 全部子表外键 re-id 到固定高位 id（99001-99006，UPDATE 不 bump sqlite_sequence，
 *      无残留副作用），correction 的 datafix-{id} 占位 OA 号同步改写——否则列表行 #id、详情标题、
 *      run #id 每轮递增导致像素漂移；
 *   3. 可见时间列回填：created_at/updated_at/history.created_at 等会渲染到页面的时间列统一
 *      UPDATE 成 FIXED_TS（server 端 datetime('now')，写入口不可传，只能事后回填）；
 *   4. 客户端动态默认值固定化：Data_Collab 建单弹框 f_deadline 有 now 基智能默认，截图前
 *      evaluate 覆写为固定值。
 *   已知残留限制（不可控，跨日重跑时人工排除）：列表态"超 N 天未XX"类角标依赖 now 与库内
 *   既有行时间差，跨日重跑可能对既有行出现角标增减；同日内重跑不受影响。
 *
 * ⚠️ 只读浏览：截图流程只点「建单/查看详情」类只读入口，不提交任何表单、不点确认/删除/通知类按钮。
 * ⚠️ 纯新增脚本资产：不改 public/ 下任何业务页面。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ============================================================
// 配置
// ============================================================
function parseArgs(argv) {
    const out = { shot: 'baseline', compare: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--shot' && argv[i + 1]) { out.shot = argv[i + 1]; i++; }
        if (argv[i] === '--compare' && argv[i + 1] && argv[i + 2]) { out.compare = [argv[i + 1], argv[i + 2]]; i += 2; }
    }
    return out;
}
const ARGS = parseArgs(process.argv.slice(2));

const PORT = process.env.PORT || '3100';
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const OUTPUT_DIR = path.join(__dirname, 'unify-baseline', ARGS.shot);
const FIXTURE_PREFIX = '[UNIFY-BASELINE]';

// ── H-1 固定值（严禁改回 Date.now() 等动态成分）──────────
const FIXED_TS = '2026-07-01 10:00:00';               // 可见时间列统一回填值
const FIXED_DEADLINE = '2026-12-31 12:00:00';         // correction/collab 期望完成固定值
const FIXED_DEADLINE_INPUT = '2026-12-31T12:00';      // datetime-local input 格式（Data_Collab 建单弹框覆写用）
const COLLAB_OA_CORE = 'UNIFYBASE-FIXED-001';         // 存储后规范化为 'OA-UNIFYBASE-FIXED-001'（唯一索引列，固定序号非时间戳）
const COLLAB_OA_STORED = 'OA-' + COLLAB_OA_CORE;
const PERIODIC_TASK_NAME = `${FIXTURE_PREFIX} 固定周期任务-01`;   // active 部分唯一索引列，固定名

// fixture 标记文本（建单 / 清理共用单一来源）。清理删除条件用这些值做**精确相等匹配**
//   （codex 复审 M-1"：删除永远精确匹配，不用前缀 LIKE——清理面 ≤ 校验面，杜绝前缀误伤）。
const FX_TEXT = {
    correctionLocation: `${FIXTURE_PREFIX} 视觉基线修正方式说明（脚本自动生成，勿在此单上操作）`,
    correctionReason: `${FIXTURE_PREFIX} 视觉回归基线夹具，跑完自动清理`,
    sysTitle: `${FIXTURE_PREFIX} 视觉基线任务单`,
    issueTitle: `${FIXTURE_PREFIX} 视觉基线需求单`,
    collabDesc: `${FIXTURE_PREFIX} 视觉基线协作单说明（脚本自动生成）`,
};

// fixture 固定 id（高位，远离真实数据 id 段；preflight 会校验占用者身份，防误伤真实行）
const FIXED_IDS = {
    correction: 99001,
    sysIssue: 99002,
    issue: 99003,
    collab: 99004,
    periodicTask: 99005,
    periodicRun: 99006,
};

const VIEWPORTS = [
    { label: '1440x900', width: 1440, height: 900 },
    { label: '768x1024', width: 768, height: 1024 },
];

// ============================================================
// sqlite helpers（直连 db 副本：re-id / 时间回填 / 残留校验 / 清理）
// ============================================================
const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 裸 http 请求 helper（对齐 verify-correction-creator-e2e.js req() 范式，带 503 重试——
//   建单时 requireXxxSchemaReady 中间件可能因 server 刚起、DDL 还没跑完而短暂 503）
// ============================================================
function rawReq(token, method, p, body) {
    return new Promise((resolve) => {
        const data = body !== undefined ? JSON.stringify(body) : null;
        const r = http.request(
            {
                host: 'localhost',
                port: PORT,
                method,
                path: p,
                headers: {
                    Authorization: 'Bearer ' + token,
                    'Content-Type': 'application/json',
                    ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
                },
            },
            (res) => {
                let d = '';
                res.on('data', (c) => { d += c; });
                res.on('end', () => resolve({ status: res.statusCode, body: d }));
            }
        );
        r.on('error', (e) => resolve({ status: 0, error: e.message }));
        if (data) r.write(data);
        r.end();
    });
}
function jparse(b) { try { return JSON.parse(b || '{}'); } catch (_) { return {}; } }

async function apiRequest(token, method, p, body) {
    let last = null;
    for (let i = 0; i < 8; i++) {
        const r = await rawReq(token, method, p, body);
        last = r;
        if (r.status !== 503 && r.status !== 0) return r;
        await sleep(400);
    }
    return last;
}

// ============================================================
// admin JWT（照抄 test-model-center-sort-playwright.js signAs 范式，动态查库不硬编码 id）
// ============================================================
async function signAsAdmin() {
    const user = await dbGet("SELECT id, username, display_name, role FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1");
    if (!user) throw new Error('db 副本中找不到 admin 用户，无法签发 JWT');
    const token = jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET,
        { expiresIn: '2h' }
    );
    return { token, user };
}

// ============================================================
// server 探测 / 自起（若已有 server 在跑就复用，不重复 spawn）
// ============================================================
function probeVersion() {
    return new Promise((resolve) => {
        const r = http.get(`${BASE_URL}/api/version`, { timeout: 2000 }, (res) => {
            let d = ''; res.on('data', (c) => { d += c; });
            res.on('end', () => resolve(res.statusCode === 200));
        });
        r.on('error', () => resolve(false));
        r.on('timeout', () => { r.destroy(); resolve(false); });
    });
}

async function ensureServerRunning() {
    if (await probeVersion()) {
        console.log(`  探测到 ${BASE_URL} 已有 server 在跑，复用（不自行 spawn，跑完不 kill）`);
        return { proc: null, spawnedByScript: false };
    }
    console.log(`  ${BASE_URL} 无响应，自行 spawn server（PORT=${PORT}）...`);
    const proc = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, PORT },
    });
    let log = '';
    proc.stdout.on('data', (d) => { log += d; });
    proc.stderr.on('data', (d) => { log += d; });
    let ready = false;
    for (let i = 0; i < 60; i++) {
        if (await probeVersion()) { ready = true; break; }
        await sleep(300);
    }
    if (!ready) {
        proc.kill('SIGKILL');
        throw new Error(`server 在 ${BASE_URL} 60 次探测(18s)内未就绪，最近日志：\n${log.slice(-800)}`);
    }
    await sleep(800); // 额外缓冲：各模块 schema readiness（sys-iteration/periodic-fetch 等）DDL 收尾
    return { proc, spawnedByScript: true };
}

// ============================================================
// fixture 依赖数据探测（动态查库，不硬编码 id——db 副本可能随主库快照变化）
// ============================================================
async function pickSourceConnectionId() {
    const row = await dbGet(
        "SELECT id, name FROM db_connections WHERE connection_type='source' AND type IN ('sqlserver','mysql') ORDER BY id ASC LIMIT 1"
    );
    if (!row) throw new Error('db 副本中找不到任何 source 类型 db_connections（collab/periodic fixture 依赖此表有 ≥1 条记录）');
    return row;
}
async function pickContactPersonId() {
    const row = await dbGet(
        "SELECT id, display_name FROM users WHERE role IN ('user','publisher','admin') AND status='active' ORDER BY id ASC LIMIT 1"
    );
    if (!row) throw new Error('db 副本中找不到可用对接人（role IN user/publisher/admin 且 status=active）');
    return row;
}

// ============================================================
// preflight：固定 id 占用者身份校验（防 re-id / 清理误伤真实数据）
//   固定 id 行若已存在且**不带** fixture 标记 → 真实数据占位 → 硬 fail 终止，且不执行任何清理。
//   带标记 → 上一轮崩溃残留 → 交给 pre-clean 删。
// ============================================================
async function preflightFixedIds() {
    const checks = [
        ['correction_requests', FIXED_IDS.correction, "location_info LIKE '[UNIFY-BASELINE]%' OR reason LIKE '[UNIFY-BASELINE]%'"],
        ['sys_issues', FIXED_IDS.sysIssue, "title LIKE '[UNIFY-BASELINE]%'"],
        ['issues', FIXED_IDS.issue, "title LIKE '[UNIFY-BASELINE]%'"],
        ['collab_requests', FIXED_IDS.collab, `description LIKE '[UNIFY-BASELINE]%' OR oa_request_no = '${COLLAB_OA_STORED}'`],
        ['periodic_tasks', FIXED_IDS.periodicTask, "task_name LIKE '[UNIFY-BASELINE]%'"],
        ['periodic_task_runs', FIXED_IDS.periodicRun, "task_name_snapshot LIKE '[UNIFY-BASELINE]%'"],
    ];
    for (const [table, id, markerWhere] of checks) {
        const row = await dbGet(`SELECT COUNT(*) c FROM ${table} WHERE id = ? AND NOT (${markerWhere})`, [id]);
        if (row && row.c > 0) {
            throw new Error(`preflight 失败：${table} 固定 id=${id} 已被**非 fixture** 数据占用（同库契约破坏或 id 段冲突），终止且不清理`);
        }
    }
}

// ============================================================
// fixture 建单（5 个，均带 FIXTURE_PREFIX + 全固定可见字段）
// ============================================================
async function createFixtures(adminToken) {
    const rawIds = {};

    // 1. 数据修正单（留空 OA = 自发现模式，绕开 OA 截图 multipart 必填；expected_deadline 固定传值
    //    覆盖后端 now 基智能默认——它渲染在详情"期望完成"字段）
    {
        const body = {
            source_system: 'BMS',
            correction_type: 'single',
            location_info: FX_TEXT.correctionLocation,
            reason: FX_TEXT.correctionReason,
            expected_deadline: FIXED_DEADLINE,
        };
        const r = await apiRequest(adminToken, 'POST', '/api/corrections', body);
        if (r.status !== 200) throw new Error(`建数据修正单 fixture 失败：status=${r.status} body=${(r.body || '').slice(0, 300)}`);
        rawIds.correction = jparse(r.body).id;
    }

    // 2. 系统迭代单（type=bug，最短建单路径，不带 assign_mode；不传 deadline → 详情渲染"—"静态）
    {
        const body = {
            type: 'bug',
            title: FX_TEXT.sysTitle,
            system_name: 'BMS',
            source: '内部',
        };
        const r = await apiRequest(adminToken, 'POST', '/api/sys-issues', body);
        if (r.status !== 201) throw new Error(`建系统迭代单 fixture 失败：status=${r.status} body=${(r.body || '').slice(0, 300)}`);
        rawIds.sysIssue = jparse(r.body).id;
    }

    // 3. 需求跟踪单
    {
        const body = {
            title: FX_TEXT.issueTitle,
            type: '数据治理需求',
            requester_dept: '信息技术部',
            requester_name: `${FIXTURE_PREFIX}测试人`,
        };
        const r = await apiRequest(adminToken, 'POST', '/api/issues', body);
        if (r.status !== 200) throw new Error(`建需求跟踪单 fixture 失败：status=${r.status} body=${(r.body || '').slice(0, 300)}`);
        rawIds.issue = jparse(r.body).id;
    }

    // 4. 数据协作单（normal 模式；OA 号固定值——唯一索引列，pre-clean 保证每轮创建前该值已释放）
    {
        const conn = await pickSourceConnectionId();
        const contact = await pickContactPersonId();
        const body = {
            oa_request_no: COLLAB_OA_CORE,
            requester_dept: '信息技术部',
            requester_name: `${FIXTURE_PREFIX}测试人`,
            description: FX_TEXT.collabDesc,
            deadline: FIXED_DEADLINE,
            contact_person_id: contact.id,
            target_db_connection_id: conn.id,
        };
        const r = await apiRequest(adminToken, 'POST', '/api/collab/requests', body);
        if (r.status !== 200) throw new Error(`建数据协作单 fixture 失败：status=${r.status} body=${(r.body || '').slice(0, 300)}`);
        rawIds.collab = jparse(r.body).id;
    }

    // 5. 周期取数任务 + 直接落一条 run 记录（真实执行需连生产库，超出本 harness 范围——
    //    run 详情 modal 只读展示落库字段，直接按 schema 插入固定态快照，语义等价于"已成功跑过一次"）
    {
        const conn = await pickSourceConnectionId();
        const scriptTemplate = "SELECT id, order_no, created_at FROM dbo.some_orders WHERE created_at >= '{{MONTH_START}}' AND created_at < '{{MONTH_END}}'";
        const body = {
            task_name: PERIODIC_TASK_NAME,
            description: `${FIXTURE_PREFIX} 视觉回归基线夹具，跑完自动清理`,
            source_connection_id: conn.id,
            script_template: scriptTemplate,
        };
        const r = await apiRequest(adminToken, 'POST', '/api/periodic-tasks', body);
        if (r.status !== 201) throw new Error(`建周期取数任务 fixture 失败：status=${r.status} body=${(r.body || '').slice(0, 300)}`);
        rawIds.periodicTask = jparse(r.body).id;

        const rendered = scriptTemplate
            .split('{{MONTH_START}}').join('2026-06-01')
            .split('{{MONTH_END}}').join('2026-07-01');
        const runResult = await dbRun(
            `INSERT INTO periodic_task_runs
                (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot,
                 triggered_by, date_range_start, date_range_end, started_at, finished_at, duration_ms, row_count,
                 result_file_path, file_status, status, error_msg)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'present', 'success', NULL)`,
            [
                rawIds.periodicTask, rendered, PERIODIC_TASK_NAME, conn.name,
                1, '2026-06-01', '2026-07-01',
                '2026-06-01 09:00:00', '2026-06-01 09:00:05', 5000, 128,
                'periodic-results/UNIFY-BASELINE-fixture.xlsx',
            ]
        );
        rawIds.periodicRun = runResult.lastID;
    }

    return rawIds;
}

// ============================================================
// H-1.2 fixture 固定 id 化：把 API 建出的自增 id re-id 到 FIXED_IDS（父行 + 子表外键 + datafix OA 号）。
//   UPDATE rowid 不 bump sqlite_sequence（区别于显式 id INSERT），对 db 副本无自增序列残留副作用。
//   changes 硬校验：父行必须恰好 1 行，子表至少 1 行（建单事务保证 history/requesters/timeline/oplog 首行存在）。
// ============================================================
async function assertChanges(result, atLeast, label) {
    if (!result || result.changes < atLeast) {
        throw new Error(`re-id/回填失败：${label}（changes=${result ? result.changes : 'null'}，期望 ≥${atLeast}）`);
    }
}

async function reassignFixtureIds(rawIds) {
    // 数据修正：子表 2 张 + 父行 + datafix-{id} 占位 OA 号同步改写
    await assertChanges(await dbRun('UPDATE correction_status_history SET correction_request_id=? WHERE correction_request_id=?', [FIXED_IDS.correction, rawIds.correction]), 1, 'correction_status_history re-id');
    await assertChanges(await dbRun('UPDATE correction_requesters SET correction_request_id=? WHERE correction_request_id=?', [FIXED_IDS.correction, rawIds.correction]), 1, 'correction_requesters re-id');
    await assertChanges(await dbRun('UPDATE correction_requests SET id=?, oa_number=? WHERE id=?', [FIXED_IDS.correction, `datafix-${FIXED_IDS.correction}`, rawIds.correction]), 1, 'correction_requests re-id');

    // 系统迭代
    await assertChanges(await dbRun('UPDATE sys_issue_timeline SET issue_id=? WHERE issue_id=?', [FIXED_IDS.sysIssue, rawIds.sysIssue]), 1, 'sys_issue_timeline re-id');
    await assertChanges(await dbRun('UPDATE sys_issues SET id=? WHERE id=?', [FIXED_IDS.sysIssue, rawIds.sysIssue]), 1, 'sys_issues re-id');

    // 需求跟踪
    await assertChanges(await dbRun('UPDATE issue_status_history SET issue_id=? WHERE issue_id=?', [FIXED_IDS.issue, rawIds.issue]), 1, 'issue_status_history re-id');
    await dbRun('UPDATE issue_comments SET issue_id=? WHERE issue_id=?', [FIXED_IDS.issue, rawIds.issue]);   // 建单无评论，0 行合法
    await assertChanges(await dbRun('UPDATE issues SET id=? WHERE id=?', [FIXED_IDS.issue, rawIds.issue]), 1, 'issues re-id');

    // 数据协作
    await assertChanges(await dbRun('UPDATE collab_operation_logs SET collab_request_id=? WHERE collab_request_id=?', [FIXED_IDS.collab, rawIds.collab]), 1, 'collab_operation_logs re-id');
    await assertChanges(await dbRun('UPDATE collab_requests SET id=? WHERE id=?', [FIXED_IDS.collab, rawIds.collab]), 1, 'collab_requests re-id');

    // 周期取数（run 是直插行，id 也 re-id 到固定值——modal 标题渲染 "run #id 详情"）
    await assertChanges(await dbRun('UPDATE periodic_task_runs SET task_id=? WHERE task_id=?', [FIXED_IDS.periodicTask, rawIds.periodicTask]), 1, 'periodic_task_runs.task_id re-id');
    await assertChanges(await dbRun('UPDATE periodic_task_runs SET id=? WHERE id=?', [FIXED_IDS.periodicRun, rawIds.periodicRun]), 1, 'periodic_task_runs.id re-id');
    await assertChanges(await dbRun('UPDATE periodic_tasks SET id=? WHERE id=?', [FIXED_IDS.periodicTask, rawIds.periodicTask]), 1, 'periodic_tasks re-id');
}

// ============================================================
// H-1.2 可见时间列回填：server 端 datetime('now','localtime') 生成的时间列统一 UPDATE 成 FIXED_TS。
//   updated_at 类列只在**非 NULL** 时回填（建单即 NULL 的保持 NULL——NULL 本身是确定态，
//   强行填值反而改变页面渲染分支）。
// ============================================================
async function backfillFixedTimes() {
    const jobs = [
        // [table, whereCol, fixedId, alwaysCols, nullableCols]
        ['correction_requests', 'id', FIXED_IDS.correction, ['created_at'], []],
        ['correction_status_history', 'correction_request_id', FIXED_IDS.correction, ['created_at'], []],
        ['correction_requesters', 'correction_request_id', FIXED_IDS.correction, ['created_at'], []],
        ['sys_issues', 'id', FIXED_IDS.sysIssue, ['created_at'], ['updated_at']],
        ['sys_issue_timeline', 'issue_id', FIXED_IDS.sysIssue, ['created_at'], []],
        ['issues', 'id', FIXED_IDS.issue, ['created_at'], ['updated_at']],
        ['issue_status_history', 'issue_id', FIXED_IDS.issue, ['created_at'], []],
        ['collab_requests', 'id', FIXED_IDS.collab, ['created_at'], []],
        ['collab_operation_logs', 'collab_request_id', FIXED_IDS.collab, ['created_at'], []],
        ['periodic_tasks', 'id', FIXED_IDS.periodicTask, ['created_at'], ['updated_at']],
        // periodic_task_runs 的 started_at/finished_at 已在 INSERT 里写死固定值，无需回填
    ];
    for (const [table, whereCol, fixedId, alwaysCols, nullableCols] of jobs) {
        for (const col of alwaysCols) {
            const r = await dbRun(`UPDATE ${table} SET ${col}=? WHERE ${whereCol}=?`, [FIXED_TS, fixedId]);
            await assertChanges(r, 1, `${table}.${col} 时间回填`);
        }
        for (const col of nullableCols) {
            await dbRun(`UPDATE ${table} SET ${col}=? WHERE ${whereCol}=? AND ${col} IS NOT NULL`, [FIXED_TS, fixedId]);
        }
    }
}

// ============================================================
// fixture 清理（对齐 verify-correction-creator-e2e.js cleanup() 重试范式）
//   M-1：每条 SQL 失败**累计记录**，由调用方决定 fail（不再只打日志静默放行）。
//   M-1"（codex 复审）：删除条件**永远精确匹配**——固定 id / 固定 OA 号 / 固定任务名 /
//   FX_TEXT 标记文本全部用相等比较，不用前缀 LIKE（清理面 ≤ preflight 校验面 + 建单签名面）。
//   精确文本条件兜住"建单后、re-id 前崩溃"的残留（那时行还是自增 id，只有签名文本可定位）；
//   固定 id 条件兜住 re-id 后的行（preflight 已验证固定 id 段不属于真实数据，直删安全）。
// ============================================================
async function cleanupFixtures() {
    const F = FIXED_IDS;
    const T = FX_TEXT;
    const stmts = [
        // 数据修正（子表先删）
        ['DELETE FROM correction_status_history WHERE correction_request_id = ? OR correction_request_id IN (SELECT id FROM correction_requests WHERE location_info = ? OR reason = ?)', [F.correction, T.correctionLocation, T.correctionReason]],
        ['DELETE FROM correction_requesters WHERE correction_request_id = ? OR correction_request_id IN (SELECT id FROM correction_requests WHERE location_info = ? OR reason = ?)', [F.correction, T.correctionLocation, T.correctionReason]],
        ['DELETE FROM correction_requests WHERE id = ? OR location_info = ? OR reason = ?', [F.correction, T.correctionLocation, T.correctionReason]],
        // 系统迭代
        ['DELETE FROM sys_issue_timeline WHERE issue_id = ? OR issue_id IN (SELECT id FROM sys_issues WHERE title = ?)', [F.sysIssue, T.sysTitle]],
        ['DELETE FROM sys_issues WHERE id = ? OR title = ?', [F.sysIssue, T.sysTitle]],
        // 需求跟踪
        ['DELETE FROM issue_status_history WHERE issue_id = ? OR issue_id IN (SELECT id FROM issues WHERE title = ?)', [F.issue, T.issueTitle]],
        ['DELETE FROM issue_comments WHERE issue_id = ? OR issue_id IN (SELECT id FROM issues WHERE title = ?)', [F.issue, T.issueTitle]],
        ['DELETE FROM issues WHERE id = ? OR title = ?', [F.issue, T.issueTitle]],
        // 数据协作
        ['DELETE FROM collab_operation_logs WHERE collab_request_id = ? OR collab_request_id IN (SELECT id FROM collab_requests WHERE oa_request_no = ? OR description = ?)', [F.collab, COLLAB_OA_STORED, T.collabDesc]],
        ['DELETE FROM collab_requests WHERE id = ? OR oa_request_no = ? OR description = ?', [F.collab, COLLAB_OA_STORED, T.collabDesc]],
        // 周期取数
        ['DELETE FROM periodic_task_runs WHERE id = ? OR task_id = ? OR task_name_snapshot = ? OR task_id IN (SELECT id FROM periodic_tasks WHERE task_name = ?)', [F.periodicRun, F.periodicTask, PERIODIC_TASK_NAME, PERIODIC_TASK_NAME]],
        ['DELETE FROM periodic_tasks WHERE id = ? OR task_name = ?', [F.periodicTask, PERIODIC_TASK_NAME]],
    ];
    const failures = [];
    for (const [sql, params] of stmts) {
        let ok = false;
        let lastErr = null;
        for (let i = 0; i < 6; i++) {
            try { await dbRun(sql, params); ok = true; break; } catch (e) { lastErr = e; await sleep(300); }
        }
        if (!ok) {
            failures.push(`${sql.slice(0, 80)}... — ${lastErr && lastErr.message}`);
            console.error(`  [cleanup-FAIL] ${sql.slice(0, 100)} — ${lastErr && lastErr.message}`);
        }
    }
    return failures;
}

// ============================================================
// 残留校验（M-1：覆盖全部 touched 表——5 张父表按标记，7 张子表按固定 id + 标记快照列）
// ============================================================
async function assertNoResidual() {
    const F = FIXED_IDS;
    const checks = [
        // 父表（标记字段）
        ['correction_requests', "location_info LIKE '[UNIFY-BASELINE]%' OR reason LIKE '[UNIFY-BASELINE]%'"],
        ['sys_issues', "title LIKE '[UNIFY-BASELINE]%'"],
        ['issues', "title LIKE '[UNIFY-BASELINE]%'"],
        ['collab_requests', `description LIKE '[UNIFY-BASELINE]%' OR oa_request_no LIKE 'OA-UNIFYBASE-%'`],
        ['periodic_tasks', "task_name LIKE '[UNIFY-BASELINE]%'"],
        // 子表（固定 id / 标记快照列）
        ['correction_status_history', `correction_request_id = ${F.correction}`],
        ['correction_requesters', `correction_request_id = ${F.correction}`],
        ['sys_issue_timeline', `issue_id = ${F.sysIssue}`],
        ['issue_status_history', `issue_id = ${F.issue}`],
        ['issue_comments', `issue_id = ${F.issue}`],
        ['collab_operation_logs', `collab_request_id = ${F.collab}`],
        ['periodic_task_runs', `id = ${F.periodicRun} OR task_id = ${F.periodicTask} OR task_name_snapshot LIKE '[UNIFY-BASELINE]%'`],
    ];
    const residual = [];
    for (const [table, where] of checks) {
        const row = await dbGet(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`);
        if (row && row.c > 0) residual.push(`${table}: ${row.c} 行残留`);
    }
    return residual;
}

// ============================================================
// 页面态配置（url / 等待策略 / 硬 ready 条件 / 动态输入固定化）
// ============================================================
function buildPageConfigs() {
    const F = FIXED_IDS;
    return [
        {
            key: 'Data_Correction',
            file: 'Data_Correction.html',
            listSelector: '#corrTableBody tr',
            states: [
                { name: 'list', query: '' },
                {
                    name: 'detail', query: `?id=${F.correction}`,
                    openSelector: '#drawer.open', bodySelector: '#drawerBody',
                    expectText: { selector: '#drawer', text: FIXTURE_PREFIX },
                },
                {
                    name: 'create', query: '',
                    openFn: 'openCreateModal', openSelector: '#createModal.open',
                },
            ],
        },
        {
            key: 'Sys_Iteration',
            file: 'Sys_Iteration.html',
            listSelector: '#siTbody tr',
            states: [
                { name: 'list', query: '' },
                {
                    name: 'detail', query: `?issue=${F.sysIssue}`,
                    openSelector: '#siDrawer.open', bodySelector: '#siDBody',
                    expectText: { selector: '#siDrawer', text: FIXTURE_PREFIX },
                },
                {
                    name: 'create', query: '',
                    openFn: 'siOpenCreate', openSelector: '#siModalOverlay.open',
                },
            ],
        },
        {
            key: 'Issue_Tracker',
            file: 'Issue_Tracker.html',
            listSelector: '#issueTableBody tr',
            states: [
                { name: 'list', query: '' },
                {
                    name: 'detail', query: `?id=${F.issue}`,
                    openSelector: '#drawer.open', bodySelector: '#drawerBody',
                    expectText: { selector: '#drawer', text: FIXTURE_PREFIX },
                },
                {
                    name: 'create', query: '',
                    openFn: 'openCreateModal', openSelector: '#createModal.open',
                },
            ],
        },
        {
            key: 'Data_Collab',
            file: 'Data_Collab.html',
            listSelector: '#listBody tr',
            states: [
                { name: 'list', query: '' },
                {
                    name: 'detail', query: `?id=${F.collab}`,
                    // 前端统一 C4：detailModal 居中弹窗 → detailDrawer 右侧抽屉，open 态 class show→open（跟随 C4 手术）
                    openSelector: '#detailDrawer.open', bodySelector: '#detailBody',
                    expectText: { selector: '#detailDrawer', text: FIXTURE_PREFIX },
                },
                {
                    name: 'create', query: '',
                    // 前端统一 C4：newModal open 态 class show→open（跟随 C4 手术，元素/id 未变）
                    openFn: 'openNewModal', openSelector: '#newModal.open',
                    // H-1.4：f_deadline 有 now 基智能默认（<15:00 当天17:00 / ≥15:00 次日12:00），
                    // 跨日重跑值漂移 → 截图前覆写为固定值
                    fixInputs: [{ id: 'f_deadline', value: FIXED_DEADLINE_INPUT }],
                },
            ],
        },
        {
            key: 'Periodic_Fetch',
            file: 'Periodic_Fetch.html',
            listSelector: '#pfTaskList .pf-card',
            states: [
                { name: 'list', query: '' },
                {
                    name: 'modal', query: '',
                    openFn: 'pfViewRunDetail', openFnArg: F.periodicRun,
                    openSelector: '#pfModalOverlay.open', bodySelector: '#pfMBody',
                    expectText: { selector: '#pfModalOverlay', text: FIXTURE_PREFIX },
                },
            ],
        },
    ];
}

// ============================================================
// Playwright 截图主流程
// ============================================================
// M-2：正文 ready 是硬条件——非空 + 无 loading 文案 + 关键 fixture 文本出现，超时直接 throw
//   （由调用方按 页面_态_viewport 记为硬失败），不再 .catch 吞掉。
async function waitDetailReady(page, { openSelector, bodySelector, expectText, timeout = 10000 }) {
    await page.waitForSelector(openSelector, { state: 'visible', timeout });
    if (bodySelector) {
        try {
            await page.waitForFunction((sel) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                const t = (el.textContent || '').trim();
                return t.length > 0 && !t.includes('加载中');
            }, bodySelector, { timeout });
        } catch (e) {
            throw new Error(`正文 ready 超时：${bodySelector} 在 ${timeout}ms 内未达到「非空且无'加载中'」（${e.message.split('\n')[0]}）`);
        }
    }
    if (expectText) {
        try {
            await page.waitForFunction(({ selector, text }) => {
                const el = document.querySelector(selector);
                return !!el && (el.textContent || '').includes(text);
            }, expectText, { timeout });
        } catch (e) {
            throw new Error(`关键内容超时：${expectText.selector} 在 ${timeout}ms 内未出现「${expectText.text}」（${e.message.split('\n')[0]}）`);
        }
    }
    await page.waitForTimeout(300); // 渲染收尾缓冲（截图本身已 animations:'disabled'，不靠这段等过渡）
}

async function runVisualHarness() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const { token: adminToken } = await signAsAdmin();
    // H-1 可复现性：确定性渲染参数——强制软件光栅 + sRGB 色彩 + 关闭 LCD 亚像素/hinting，
    //   消除 GPU/字体 AA 合成在圆角、图标边缘产生的 ±1 单通道舍入抖动（两轮自证时实测来源）。
    //   ⚠️ 这些参数改变文字渲染形态（灰度 AA 替代亚像素 AA）——基线与改造后对比必须都用本脚本跑，
    //   不能拿手动浏览器截图与本基线比。
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--disable-gpu', '--force-color-profile=srgb', '--disable-lcd-text', '--font-render-hinting=none',
            '--num-raster-threads=1', '--disable-composited-antialiasing', '--force-device-scale-factor=1',
        ],
    });
    const consoleErrorsByKey = {}; // key = `${page}_${state}_${viewport}` -> string[]
    let activeKey = '(init)';
    const shots = [];
    const problems = [];

    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                (consoleErrorsByKey[activeKey] = consoleErrorsByKey[activeKey] || []).push(msg.text());
                console.log(`  [browser-err @ ${activeKey}] ${msg.text()}`);
            }
        });
        page.on('pageerror', (err) => {
            (consoleErrorsByKey[activeKey] = consoleErrorsByKey[activeKey] || []).push(err.message);
            console.log(`  [page-error @ ${activeKey}] ${err.message}`);
        });

        console.log('\n2. JWT 注入登录（login.html 中继跳转）...');
        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate((token) => localStorage.setItem('token', token), adminToken);

        const pageConfigs = buildPageConfigs();

        for (const pc of pageConfigs) {
            console.log(`\n3. 页面 ${pc.key}`);
            for (const st of pc.states) {
                for (const vp of VIEWPORTS) {
                    activeKey = `${pc.key}_${st.name}_${vp.label}`;
                    try {
                        await page.setViewportSize({ width: vp.width, height: vp.height });
                        const url = `${BASE_URL}/${pc.file}${st.query || ''}`;
                        await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
                        await page.waitForSelector(pc.listSelector, { timeout: 10000 });
                        await page.waitForTimeout(300);

                        if (st.openFn) {
                            if (st.openFnArg !== undefined) {
                                await page.evaluate(({ fn, arg }) => window[fn](arg), { fn: st.openFn, arg: st.openFnArg });
                            } else {
                                await page.evaluate((fn) => window[fn](), st.openFn);
                            }
                        }
                        if (st.openSelector) {
                            await waitDetailReady(page, {
                                openSelector: st.openSelector,
                                bodySelector: st.bodySelector,
                                expectText: st.expectText,
                            });
                        }
                        // H-1.4：覆写客户端动态默认输入值（如 Data_Collab 建单 f_deadline 的 now 基默认）。
                        //   M-2"（codex 复审）：覆写失败=可复现性破坏，必须硬失败——元素不存在（页面结构
                        //   变化/id 改名）或写后读回不等（datetime-local 值格式非法被浏览器丢弃）都 throw，
                        //   由外层按 页面_态_viewport 记为硬失败，与 waitDetailReady 同哲学，不静默跳过。
                        if (st.fixInputs && st.fixInputs.length) {
                            for (const fi of st.fixInputs) {
                                const rb = await page.evaluate(({ id, value }) => {
                                    const el = document.getElementById(id);
                                    if (!el) return { found: false };
                                    el.value = value;
                                    return { found: true, readBack: el.value };
                                }, fi);
                                if (!rb.found) {
                                    throw new Error(`fixInputs 覆写失败：#${fi.id} 元素不存在（页面结构变化？）`);
                                }
                                if (rb.readBack !== fi.value) {
                                    throw new Error(`fixInputs 覆写失败：#${fi.id} 写后读回 '${rb.readBack}' ≠ 期望 '${fi.value}'（值被浏览器拒收？）`);
                                }
                            }
                            await page.waitForTimeout(100);
                        }

                        const fileName = `${pc.key}_${st.name}_${vp.label}.png`;
                        const outPath = path.join(OUTPUT_DIR, fileName);
                        // M-2：animations:'disabled' 快进 CSS 动画/过渡到终态；caret:'hide'（默认值，显式声明）防光标闪烁引入像素差
                        await page.screenshot({ path: outPath, animations: 'disabled', caret: 'hide' });
                        const size = fs.statSync(outPath).size;
                        shots.push({ key: activeKey, fileName, size });
                        console.log(`  [shot] ${fileName}（${(size / 1024).toFixed(1)} KB）`);
                    } catch (e) {
                        problems.push(`${activeKey}: ${e.message}`);
                        console.log(`  [FAIL] ${activeKey}: ${e.message}`);
                    }
                }
            }
        }
    } finally {
        await browser.close();
    }

    return { shots, consoleErrorsByKey, problems };
}

// ============================================================
// --compare 模式：两组截图按名逐张像素比对（改造前后对比 / 复现性自证的官方比对器）
//   一致判定（文件头"比对标准"）：单通道 |Δ| ≤ TOL_CHANNEL 且差异像素占比 ≤ TOL_RATIO
//   且差异像素绝对数 ≤ TOL_PIXELS（L-1"：占比上限随图面积浮动，绝对上限钉死噪声规模）。
//   任一图超容差 / 两组文件名清单不一致 → FAIL 退出码 1。
// ============================================================
const TOL_CHANNEL = 2;        // 单通道最大容差（跨轮实测 AA 噪声 |Δ|≤2，真实内容改动 Δ 可达 255——最强判别轴）
const TOL_RATIO = 0.0001;     // 差异像素占比上限 0.01%（≈78px@768×1024 / ≈130px@1440×900）
// 差异像素绝对上限（codex 复审 L-1" 提出加绝对上限；首标 30=当时 3 组样本上界 29+1，样本量不足——
//   第 4 组跨轮比对实测同类噪声达 54px：4 个 select 圆角弧 × 上下沿同轮齐抖、坐标散布在控件角、
//   Δ 分布 {1:50, 2:4}，纯 AA 类。按"钉死在噪声上界之上、真实改动之下"意图重标定为 100：
//   高于实测噪声上界（54px，留 ~2x 余量防更多圆角同轮抖动），远低于任何真实内容改动
//   （一条 1px 边框变色即 ≥300px 且往往 Δ>2；文字/布局改动成百上千 px）。
const TOL_PIXELS = 100;

async function runCompare(labelA, labelB) {
    const dirA = path.join(__dirname, 'unify-baseline', labelA);
    const dirB = path.join(__dirname, 'unify-baseline', labelB);
    console.log(`=== 截图比对：${labelA} vs ${labelB}（容差：单通道≤${TOL_CHANNEL} 且 差异像素≤${TOL_RATIO * 100}% 且 ≤${TOL_PIXELS}px）===\n`);
    for (const d of [dirA, dirB]) {
        if (!fs.existsSync(d)) { console.error(`目录不存在：${d}`); return 1; }
    }
    const fa = fs.readdirSync(dirA).filter((f) => f.endsWith('.png')).sort();
    const fb = fs.readdirSync(dirB).filter((f) => f.endsWith('.png')).sort();
    if (JSON.stringify(fa) !== JSON.stringify(fb)) {
        console.error(`文件名清单不一致：仅在 ${labelA}：${fa.filter((f) => !fb.includes(f)).join(',') || '（无）'}；仅在 ${labelB}：${fb.filter((f) => !fa.includes(f)).join(',') || '（无）'}`);
        return 1;
    }

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let identical = 0, withinTol = 0, failed = 0;
    try {
        for (const f of fa) {
            const bufA = fs.readFileSync(path.join(dirA, f));
            const bufB = fs.readFileSync(path.join(dirB, f));
            if (bufA.equals(bufB)) { identical++; console.log(`  [same ] ${f}（字节级一致）`); continue; }
            const r = await page.evaluate(async ({ a, b }) => {
                const load = (b64) => new Promise((res) => { const img = new Image(); img.onload = () => res(img); img.src = 'data:image/png;base64,' + b64; });
                const [ia, ib] = await Promise.all([load(a), load(b)]);
                if (ia.width !== ib.width || ia.height !== ib.height) {
                    return { sizeMismatch: true, wa: ia.width, ha: ia.height, wb: ib.width, hb: ib.height };
                }
                const w = ia.width, h = ia.height;
                const mk = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
                const da = mk(ia), db2 = mk(ib);
                let count = 0, maxDelta = 0;
                for (let i = 0; i < da.length; i += 4) {
                    const d = Math.max(Math.abs(da[i] - db2[i]), Math.abs(da[i + 1] - db2[i + 1]), Math.abs(da[i + 2] - db2[i + 2]));
                    if (d > 0) { count++; if (d > maxDelta) maxDelta = d; }
                }
                return { total: w * h, diffPixels: count, maxChannelDelta: maxDelta };
            }, { a: bufA.toString('base64'), b: bufB.toString('base64') });
            if (r.sizeMismatch) {
                failed++;
                console.log(`  [FAIL ] ${f}：尺寸不一致（${r.wa}×${r.ha} vs ${r.wb}×${r.hb}）`);
            } else if (r.maxChannelDelta <= TOL_CHANNEL && r.diffPixels / r.total <= TOL_RATIO && r.diffPixels <= TOL_PIXELS) {
                withinTol++;
                console.log(`  [tol  ] ${f}：容差内（${r.diffPixels}px / maxΔ=${r.maxChannelDelta}，AA 噪声级）`);
            } else {
                failed++;
                console.log(`  [FAIL ] ${f}：超容差（${r.diffPixels}px / ${(r.diffPixels / r.total * 100).toFixed(3)}% / maxΔ=${r.maxChannelDelta}）`);
            }
        }
    } finally {
        await browser.close();
    }
    console.log(`\n=== ${failed === 0 ? 'PASS' : 'FAIL'}：${fa.length} 对——字节级一致 ${identical} / 容差内 ${withinTol} / 超容差 ${failed} ===`);
    return failed === 0 ? 0 : 1;
}

// ============================================================
// 主流程
// ============================================================
(async () => {
    if (ARGS.compare) {
        let code = 1;
        try { code = await runCompare(ARGS.compare[0], ARGS.compare[1]); }
        catch (e) { console.error('比对异常：', e.message); code = 1; }
        finally { db.close(); }
        process.exit(code);
    }

    console.log('=== 前端统一 C-pre 视觉基线 harness ===');
    console.log(`  BASE_URL=${BASE_URL}  shot 标签=${ARGS.shot}  输出目录=${OUTPUT_DIR}`);

    let serverHandle = { proc: null, spawnedByScript: false };
    let exitCode = 0;
    let cleanupAllowed = false;   // preflight 通过后才允许清理（防固定 id 被真实数据占用时误删）

    try {
        serverHandle = await ensureServerRunning();

        const { token: adminToken } = await signAsAdmin();

        console.log('\n0. preflight：固定 id 占用者身份校验 + pre-clean 上轮残留...');
        await preflightFixedIds();
        cleanupAllowed = true;
        const preCleanFailures = await cleanupFixtures();   // 幂等 pre-clean：释放 OA 唯一索引/任务名占用
        if (preCleanFailures.length > 0) {
            throw new Error(`pre-clean 失败 ${preCleanFailures.length} 条：${preCleanFailures.join('；')}`);
        }

        console.log('\n1. 建 5 个 fixture 单（[UNIFY-BASELINE] 前缀 + 可见字段全固定）...');
        const rawIds = await createFixtures(adminToken);
        console.log(`  API 原始 ids: ${JSON.stringify(rawIds)}`);
        await reassignFixtureIds(rawIds);
        await backfillFixedTimes();
        console.log(`  re-id → 固定 ids: ${JSON.stringify(FIXED_IDS)}，可见时间列已回填 ${FIXED_TS}`);

        const { shots, consoleErrorsByKey, problems } = await runVisualHarness();

        console.log('\n4. 清理 fixture...');
        const cleanupFailures = await cleanupFixtures();
        if (cleanupFailures.length > 0) {
            problems.push(`清理失败 ${cleanupFailures.length} 条 SQL：${cleanupFailures.join('；')}`);
        }
        const residual = await assertNoResidual();
        if (residual.length > 0) {
            problems.push(`fixture 清理后仍有残留：${residual.join('；')}`);
            console.log(`  [FAIL] 残留：${residual.join('；')}`);
        } else {
            console.log('  12 张 touched 表（5 父 + 7 子）0 残留');
        }

        console.log('\n=== 汇总 ===');
        console.log(`  截图：${shots.length} 张，输出目录 ${OUTPUT_DIR}`);
        const errKeys = Object.keys(consoleErrorsByKey);
        console.log(`  console error：${errKeys.length ? errKeys.join('、') : '（全程 0 console error）'}`);
        console.log(`  硬失败：${problems.length ? problems.join('；') : '（无）'}`);

        if (problems.length > 0) exitCode = 1;
    } catch (err) {
        console.error('\nharness 异常终止：', err.message);
        exitCode = 1;
    } finally {
        if (serverHandle.proc && serverHandle.spawnedByScript) {
            serverHandle.proc.kill('SIGKILL');
            await sleep(500);
        }
        // 兜底：即便中途异常也尝试清一次残留 fixture（仅 preflight 通过后——固定 id 归属已确认）
        if (cleanupAllowed) {
            try {
                const finalFailures = await cleanupFixtures();
                if (finalFailures.length > 0) {
                    console.error(`  [finally-cleanup] ${finalFailures.length} 条清理 SQL 失败`);
                    exitCode = 1;
                }
            } catch (_) { exitCode = 1; }
        }
        db.close();
    }

    console.log(`\n${exitCode === 0 ? 'PASS' : 'FAIL'}：前端统一 C-pre 视觉基线 harness 结束（退出码 ${exitCode}）`);
    process.exit(exitCode);
})();
