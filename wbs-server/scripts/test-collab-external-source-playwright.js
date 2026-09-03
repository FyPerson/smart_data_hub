/**
 * 数据协作接入外部源「小程序-智荟人力」—— G3 Playwright 贯穿（C5）
 *
 * 方案 SSOT：docs/local/数据协作模块/数据协作接入小程序_方案_20260902_v1.6.md §5.2 G3、§5.3、§3.5
 * 派单 spec：C5 附录（scripts-C5.md §A）+ handoff-C2a-to-C2b.md（G2 结构/夹具/helper/租约/清理/环境坑）
 *
 * 运行面（自包含·零真实库·零真实 3000 端口）——本仓 gotcha #4 的例外做法：
 *   - 复用 G2（scripts/verify-collab-external-source.js）的「全新空 sqlite 文件 + 通用重定向
 *     wrapper（_test-it-asset-ledger-server-wrapper.js）自起独立端口」机制，本文件起在 TEST_PORT=3412
 *     （与 G2 的 3411 不同端口，可与 G2 并行跑不冲突）。
 *   - uploads/collab 物理目录与真实生产共用同一棵目录树（server.js 硬编码，不因 db 而异）——沿用 G2 的
 *     SEQ_BASE 随机区间租约机制（**锁文件命名与 G2 完全相同**：`collab-external-g2-${base}.lock`，
 *     刻意共享同一个租约池，防止 G2/G3 并行跑时各自随机到同一个区间互相污染彼此的残留判定）。
 *   - HTTP 层直连改为 Playwright 驱动真实浏览器操作 Data_Collab.html / Periodic_Fetch.html /
 *     admin.html 三个前端页面（C4 交付物），鉴权走 login.html 中继注入 JWT（feedback_playwright_jwt_inject
 *     先例：鉴权页 goto 前经 login.html 写 localStorage token，再 goto 目标页，直接 goto 会被
 *     checkAuth 销毁 context）。
 *   - 结束时按 PID 树杀 server 子进程、删临时库（含 -journal/-wal/-shm）、删本次种下的 uploads/collab
 *     残留文件（沿用 G2 同款 registerCleanupPath/cleanupUploadArtifacts/F5 收尾全扫描/M8 真实库
 *     保护性快照）。
 *
 * 覆盖面（spec-C5 §A 六条，逐条「坏成什么样会红」写在断言旁注释）：
 *   T1  建单页目标库下拉（外部源/普通行两种文本格式）+ 建单落地（collab.id !== target_db_connection_id）
 *   T2  指派 → 开发提交弹窗外部源版文案 → 提交 SQL+xlsx → toast/详情/列表徽章/导出全链路外部源标识
 *   T3  目标库列排序：按名称升/降序，且与连接 id 顺序相反（防 DTO 对象参与字典序退化成 [object Object]）
 *   T4  周期取数创建下拉不含外部源（C4 客户端过滤）
 *   T5  admin 连接管理列表：external 行显示徽章 + 隐藏测试/删除按钮，普通行不受影响
 *   T6  全程 console 0 error 汇总（各 session 分别采集）+ 全程同源 HTTP 4xx/5xx 汇总（M3）
 *
 * 〔L1·codex 12b 质量审〕本文件**没有**与 G2 共享的公共 helper 模块——区间租约（acquireSeqBaseLease/
 * releaseSeqBaseLease/attemptLeaseTakeover）、残留扫描（precheckNoResidualInRange/collectResidualHits）、
 * 真实库保护性快照（snapshotRealDbState/diffRealDbSnapshots）等整套基建都是从 G2 逐字复制
 * （非抽取成 lib）过来的独立副本，G2/G3 各自维护一份。这是刻意选择（详见 handoff-C2a-to-C2b.md
 * §7.9），代价是：**任何一边修了这套基建的逻辑，另一边不会自动跟着改**——同款改动必须两边
 * 同步应用，不能只改一边就完事。为了不让这条纪律只停留在注释里，文件尾 `runStaticDriftSentinel()`
 * 会在启动时把本文件与 G2 对应函数体的源码文本（剥注释 + 折叠空白后）逐一比对，一旦发现分叉
 * 会打印 WARN 并计入一条 fail，而不是指望人工记得同步。
 *
 * 夹具设计（3 条 db_connections，插入顺序即 id 升序，故意让「名称」升序与之相反，供 T3 排序断言用——
 * 已用 `"...".localeCompare(..., 'zh-Hans-CN')` 实测验证过实际排序结果，不是纯理论推导）：
 *   插入顺序（id 升序）：① pxZzz（sqlserver, PX_ZZZ, 名称"MMM-PX_ZZZ备用库"）
 *                        ② bms（sqlserver, BMS, 名称"AAA-BMS大数据仓库"）
 *                        ③ external（external, MINIAPP_ZHHL, 名称"小程序-智荟人力"——production 真实
 *                           连接名，供 T1 下拉文本字面匹配）
 *   名称升序（实测）：小程序-智荟人力(③) < AAA-BMS大数据仓库(②) < MMM-PX_ZZZ备用库(①)
 *     —— 恰是插入顺序（id 升序）的镜像反转，T3 用这个性质区分「正确按名称排序」vs「坏法退化」。
 *
 * 运行：node scripts/test-collab-external-source-playwright.js
 */
'use strict';

const { spawn, execSync, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');
const XLSX = require('xlsx');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const TEST_PORT = 3412;
const BASE = `http://localhost:${TEST_PORT}`;
const REAL_DB = path.join(ROOT, 'task_pool.db');
const TEMP_DB = path.join(os.tmpdir(), `collab-external-source-pw-test-${process.pid}.db`);
const WRAPPER_PATH = path.join(__dirname, '_test-it-asset-ledger-server-wrapper.js'); // 通用重定向 wrapper，非 IT 资产专属
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';

// ============================================================================
// 区间租约（逐字对齐 G2 verify-collab-external-source.js:81-181，锁文件命名故意相同——
// 共享同一个租约池，见文件头注释）
// ============================================================================
const SEQ_BASE_LOCK_STALE_MS = 2 * 60 * 60 * 1000; // 2 小时
function canTakeOverStaleLock(holder, isStale) {
    if (!isStale) return false;
    if (!holder || typeof holder.pid !== 'number') return false;
    try {
        process.kill(holder.pid, 0);
        return false;
    } catch (killErr) {
        return !!(killErr && killErr.code === 'ESRCH');
    }
}
function releaseLeaseAtPath(lockPath, token) {
    try {
        if (!lockPath || !fs.existsSync(lockPath)) return { deleted: false, reason: 'not-exists' };
        const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (holder && holder.token === token) {
            fs.unlinkSync(lockPath);
            return { deleted: true };
        }
        return { deleted: false, reason: 'token-mismatch' };
    } catch (_) {
        return { deleted: false, reason: 'error' };
    }
}
// H1（12b 质量审，逐字对齐 G2 verify-collab-external-source.js 的同名函数——L1 静态漂移哨兵会在
// 启动时核对两边这个函数体是否分叉，见文件尾 runStaticDriftSentinel）：接管陈旧锁前重读锁文件
// 核对是否已被他人抢先接管，创建自己的锁后回读确认 token 确实是自己的，任何一步判定失败都不
// 删除任何文件——防"A 读到旧持有者 → B 抢先接管 → A 拿着过时判断把 B 刚建的新锁删掉"这类
// 交错竞态（G2/G3 共享同一个锁文件前缀池，这个竞态在两边都可能发生，修法必须同步）。
function attemptLeaseTakeover(lockPath, firstReadHolder, myToken) {
    let holderNow = null;
    try { holderNow = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
    catch (_) { return { ok: false, reason: 'reread-failed' }; }
    const unchanged = !!(holderNow && firstReadHolder &&
        holderNow.pid === firstReadHolder.pid &&
        holderNow.token === firstReadHolder.token &&
        holderNow.ts === firstReadHolder.ts);
    if (!unchanged) return { ok: false, reason: 'holder-changed' };

    let fd = null;
    try {
        fs.unlinkSync(lockPath);
        fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: myToken, ts: Date.now(), takeover: true }));
        fs.closeSync(fd);
        fd = null;
    } catch (_) {
        // 〔15-M1 采纳〕wx 创建已成功（fd 非 null）而 write/close 失败：该文件是本进程刚独占创建的
        // （wx 语义保证此刻他人不可能持有同名文件），留下空/半截锁会让后续运行解析失败、保守拒绝
        // 接管，一次可恢复的写失败就变成长期假故障——先关 fd 再删掉本进程自己的产物（Windows 上
        // 打开中的文件不能 unlink，顺序不可倒）
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) { /* 已关/关失败都不影响下面的所有权校验与删除 */ }
            // 〔16-M1 采纳〕删前最终所有权校验：内容可解析且 token 是自己的 → 本进程产物；不可解析（半截写入）→
            // 也是本进程产物（不可解析的锁任何人都保守不接管，见 canTakeOverStaleLock）；可解析但 token 不是自己的
            // → 本进程曾被暂停超过陈旧阈值、锁已被他人接管，绝不删除（与 ①/③ 同一条「只删自己的」协议）
            // 〔P26·codex 17 三条收紧〕a) 只有「可解析的对象且 token 是自己的」才算 mine-parsable，falsy/非对象/缺
            // token 一律按非本进程处理；b) 读失败分两类：ENOENT=已不存在（等价 cleaned），其他 I/O 错误=所有权
            // 未确认不删；只有「读到了但 JSON.parse 失败」才是本进程半截产物；c) unlink ENOENT 归等价 cleaned
            let owner = 'other';
            let raw = null;
            try { raw = fs.readFileSync(lockPath, 'utf8'); }
            catch (e) { return { ok: false, reason: e && e.code === 'ENOENT' ? 'takeover-write-failed-cleaned' : 'takeover-write-failed-read-failed' }; }
            try {
                const cur = JSON.parse(raw);
                owner = (cur !== null && typeof cur === 'object' && cur.token === myToken) ? 'mine' : 'other';
            } catch (_) { owner = 'mine'; /* 读到了但解析失败——本进程半截产物 */ }
            if (owner === 'other') return { ok: false, reason: 'takeover-write-failed-not-owner' };
            // 〔16-M2 采纳〕只有 unlink 真成功（或 ENOENT 已不存在）才报 cleaned；其他删失败给独立 reason，不掩盖残留
            try { fs.unlinkSync(lockPath); }
            catch (e) { return { ok: false, reason: e && e.code === 'ENOENT' ? 'takeover-write-failed-cleaned' : 'takeover-write-failed-cleanup-failed' }; }
            return { ok: false, reason: 'takeover-write-failed-cleaned' };
        }
        // unlink/openSync 失败（如竞态窗口被抢先创建）——不做任何删除动作，直接判失败换基线
        return { ok: false, reason: 'takeover-write-failed' };
    }

    let confirm = null;
    try { confirm = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
    catch (_) { return { ok: false, reason: 'confirm-read-failed' }; }
    if (!confirm || confirm.token !== myToken) return { ok: false, reason: 'overwritten-after-create' };
    return { ok: true };
}
function acquireSeqBaseLease() {
    const maxAttempts = 5;
    const myToken = crypto.randomBytes(8).toString('hex');
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const base = 900000 + Math.floor(Math.random() * 90) * 1000; // [900000, 989000] 步长 1000
        const lockPath = path.join(os.tmpdir(), `collab-external-g2-${base}.lock`); // 刻意与 G2 同前缀，共享租约池
        try {
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: myToken, ts: Date.now() }));
            fs.closeSync(fd);
            return { base, lockPath, token: myToken };
        } catch (e) {
            if (e.code === 'EEXIST') {
                let holder = null;
                try { holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) { /* 解析失败——holder 为 null，保守不接管 */ }
                let stale = false;
                try {
                    const st = fs.statSync(lockPath);
                    stale = (Date.now() - st.mtimeMs) > SEQ_BASE_LOCK_STALE_MS;
                } catch (_) { /* statSync 失败——当非陈旧处理 */ }
                if (canTakeOverStaleLock(holder, stale)) {
                    const takeover = attemptLeaseTakeover(lockPath, holder, myToken);
                    if (takeover.ok) return { base, lockPath, token: myToken };
                    // 接管失败（含被他人抢先接管）——attemptLeaseTakeover 内部已保证不删除任何文件
                }
                continue;
            }
            throw e;
        }
    }
    console.error(`[test-collab-external-source-playwright] 区间租约获取失败：连续 5 次随机基线均已被占用（其他实例正在运行？），拒绝启动`);
    process.exit(1);
}
function releaseSeqBaseLease() {
    const result = releaseLeaseAtPath(SEQ_BASE_LOCK_PATH, SEQ_BASE_LOCK_TOKEN);
    if (!result.deleted && result.reason === 'token-mismatch') {
        console.error('[test-collab-external-source-playwright] 区间租约释放跳过：锁文件已被其他持有者接管（token 不匹配），不删除');
    }
}
const { base: SEQ_BASE, lockPath: SEQ_BASE_LOCK_PATH, token: SEQ_BASE_LOCK_TOKEN } = acquireSeqBaseLease();
const SEQ_RANGE_END = SEQ_BASE + 1000;
process.on('exit', releaseSeqBaseLease);

let pass = 0, fail = 0, skipCount = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}
function skip(name, reason) { skipCount++; console.log(`  ⚠ SKIP ${name}  （${reason}）`); }
function section(title) { console.log(`\n=== ${title} ===`); }

// ============================================================================
// 通用 helper：加密、JWT、HTTP、sqlite 直连（逐字对齐 G2）
// ============================================================================
function encryptPassword(password) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}
function signAs(user) {
    return jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET, { expiresIn: '1h' }
    );
}
async function apiCall(method, urlPath, token, body) {
    const opts = { method, headers: {} };
    if (token) opts.headers.authorization = `Bearer ${token}`;
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null;
    try { j = await r.json(); } catch (_) { /* 非 JSON 响应留 null */ }
    return { status: r.status, body: j };
}
let tdb = null;
function tdbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        tdb.run(sql, params, function (err) { err ? reject(err) : resolve({ changes: this.changes, lastID: this.lastID }); });
    });
}
function tdbGet(sql, params = []) {
    return new Promise((resolve, reject) => { tdb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))); });
}

// ============================================================================
// 进程/端口/文件清理（逐字对齐 G2，禁全杀 node）
// ============================================================================
function getProcessCommandLine(pid) {
    try {
        const out = execSync(
            `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
            { encoding: 'utf8', shell: 'cmd.exe' }
        );
        return out.trim();
    } catch (_) { return ''; }
}
function normalizePathForMatch(s) { return String(s || '').toLowerCase().replace(/\//g, '\\'); }
function killPort(port, phase) {
    try {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set();
        out.split(/\r?\n/).forEach((line) => {
            const cols = line.trim().split(/\s+/);
            if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3])) {
                const m = cols[1].match(/:(\d+)$/);
                if (m && Number(m[1]) === port) pids.add(cols[4]);
            }
        });
        pids.forEach((pid) => {
            const cmdLine = getProcessCommandLine(pid);
            const owned = normalizePathForMatch(cmdLine).includes(normalizePathForMatch(WRAPPER_PATH));
            if (!owned) {
                if (phase === 'startup') {
                    console.error(`[test-collab-external-source-playwright] 端口 ${port} 被无关进程占用（PID ${pid}），拒绝启动`);
                    process.exit(1);
                }
                console.log(`  ⚠️ 跳过 PID ${pid}（端口 ${port} 占用者非本套件 wrapper 进程，不误杀）`);
                return;
            }
            try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) { /* ignore */ }
        });
    } catch (_) { /* ignore */ }
}
function killChildTree(c) {
    if (!c || !c.pid) return;
    try { execSync(`taskkill /T /F /PID ${c.pid}`, { shell: 'cmd.exe' }); } catch (_) { /* ignore */ }
}
function closeTdb() {
    return new Promise((resolve) => {
        if (!tdb) return resolve();
        tdb.close(() => resolve());
    });
}
function cleanupTempDb() {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
        const p = TEMP_DB + suffix;
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {
            console.log(`  ⚠️ 临时库文件删除失败（句柄未释放）：${p}（${e.message}）`);
        }
    }
}
function forceRemoveDir(p) {
    const collabRootAbs = path.resolve(ROOT, 'uploads', 'collab');
    const target = path.resolve(p);
    if (target !== collabRootAbs && !target.startsWith(collabRootAbs + path.sep)) {
        throw new Error(`forceRemoveDir: 拒绝删除 uploads/collab 之外的路径：${target}`);
    }
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch (_) { /* 兜底走下面 PowerShell */ }
    if (!fs.existsSync(target)) return;
    try {
        execFileSync('powershell', [
            '-NoProfile', '-Command',
            'Remove-Item -LiteralPath $env:G3_RM_TARGET -Recurse -Force -ErrorAction Stop',
        ], { env: { ...process.env, G3_RM_TARGET: target } });
    } catch (_) { /* 留给复查逻辑记录为残留 */ }
}
function leadingDigitsOf(name) {
    const m = /^(\d+)/.exec(name);
    return m ? Number(m[1]) : NaN;
}
// M4（12b 质量审，逐字对齐 G2 的同名函数——见 L1 静态漂移哨兵）：递归残留扫描（深度 ≤3，受控——
// 不跟随符号链接），沿路径每一层的每个条目名称都单独判断"提取前导数字 id 是否落在本次区间"，
// 不只判断顶层名称；`_pending` 是 uploads/collab 的直接子目录，天然被同一次递归覆盖。
function collectResidualHits(dirPath, depth, maxDepth, hits) {
    const inRange = (n) => Number.isInteger(n) && n > SEQ_BASE && n < SEQ_RANGE_END;
    let entries;
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; // 受控：不跟随符号链接，避免潜在环路
        const idNum = leadingDigitsOf(entry.name);
        const fullPath = path.join(dirPath, entry.name);
        if (inRange(idNum)) hits.push(fullPath);
        if (entry.isDirectory() && depth < maxDepth) {
            collectResidualHits(fullPath, depth + 1, maxDepth, hits);
        }
    }
}
function precheckNoResidualInRange() {
    const collabBase = path.join(ROOT, 'uploads', 'collab');
    const hits = [];
    try {
        if (fs.existsSync(collabBase)) collectResidualHits(collabBase, 1, 3, hits);
    } catch (e) {
        hits.push(`(预检异常: ${e.message})`);
    }
    return hits;
}
const registeredCleanupPaths = [];
function registerCleanupPath(p) { registeredCleanupPaths.push(p); }
function computeFinalDirName(id, description) {
    return require(path.join(ROOT, 'utils', 'collab-attachment-versioning'))._internal.computeAttachmentDirName(id, description);
}
function cleanupUploadArtifacts() {
    const collabBase = path.join(ROOT, 'uploads', 'collab');
    let attempted = 0;
    const remaining = [];
    const idInRange = (idNum) => Number.isInteger(idNum) && idNum > SEQ_BASE && idNum < SEQ_RANGE_END;
    try {
        for (const p of registeredCleanupPaths) {
            const base = path.basename(p);
            const idNum = Number(base) || Number((/^(\d+)_/.exec(base) || [])[1]);
            if (!idInRange(idNum)) continue;
            if (!fs.existsSync(p)) continue;
            attempted++;
            forceRemoveDir(p);
            if (fs.existsSync(p)) remaining.push(p);
        }
    } catch (e) {
        console.log(`  ⚠️ 清理 uploads/collab 残留时异常：${e.message}`);
    }
    ok('清理闭环：上传残留文件尝试删 ≥1 且登记清单内复查残留 = 0（不静默，仅删精确登记路径）',
        attempted >= 1 && remaining.length === 0,
        `attempted=${attempted}, remaining=${remaining.length}${remaining.length ? '：' + remaining.slice(0, 5).join('; ') : ''}`);
}

let termCleanupStarted = false;
let child = null;
let sharedBrowser = null;
function handleTermSignal(sig) {
    return async () => {
        if (termCleanupStarted) return;
        termCleanupStarted = true;
        console.log(`\n[test-collab-external-source-playwright] 收到 ${sig}，执行清理后退出`);
        if (sharedBrowser) { try { await sharedBrowser.close(); } catch (_) { /* ignore */ } }
        killChildTree(child);
        await closeTdb();
        cleanupTempDb();
        releaseSeqBaseLease();
        process.exit(130);
    };
}
process.on('SIGINT', handleTermSignal('SIGINT'));
process.on('SIGTERM', handleTermSignal('SIGTERM'));

// ============================================================================
// §SETUP：起临时 server（逐字对齐 G2 的冷启动竞态规避）
// ============================================================================
async function startServerOnce() {
    let log = '';
    const c = spawn(process.execPath, [WRAPPER_PATH], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(TEST_PORT), IA_TEST_DB_PATH: TEMP_DB, LOG_LEVEL: 'INFO' },
    });
    let exited = false;
    c.on('exit', () => { exited = true; });
    c.stdout.on('data', (d) => { log += d.toString(); });
    c.stderr.on('data', (d) => { log += d.toString(); });
    const deadline1 = Date.now() + 20000;
    let listening = false;
    while (Date.now() < deadline1) {
        if (/Task Pool Server running/.test(log)) { listening = true; break; }
        if (exited) break;
        await new Promise((r) => setTimeout(r, 300));
    }
    const deadline2 = Date.now() + 10000;
    let schemaReady = false;
    while (Date.now() < deadline2) {
        if (/schema 就绪|健康检查通过：collab_quality_record/.test(log)) { schemaReady = true; break; }
        if (exited) break;
        await new Promise((r) => setTimeout(r, 300));
    }
    const stabilizeDeadline = Date.now() + 2500;
    while (Date.now() < stabilizeDeadline && !exited) {
        await new Promise((r) => setTimeout(r, 200));
    }
    return { child: c, listening, schemaReady, exited, getLog: () => log };
}
async function startServer() {
    const maxAttempts = 2;
    let result = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        result = await startServerOnce();
        if (!result.exited) {
            if (attempt > 1) {
                console.log(`  ⚠️ server 第 1 次冷启动崩溃（全新空库启动期竞态，见 G2 头注释），第 ${attempt} 次针对同一临时库重启后稳定`);
            }
            return result;
        }
        console.log(`  ⚠️ server 第 ${attempt} 次启动在稳定观察窗内退出，日志尾部：\n${result.getLog().slice(-800)}`);
        killChildTree(result.child);
        await new Promise((r) => setTimeout(r, 300));
    }
    return result;
}

// ============================================================================
// §SEED：3 条 db_connections + 3 用户（见文件头注释的名称/id 顺序设计）
// ============================================================================
async function insertConn(row) {
    const r = await tdbRun(
        `INSERT INTO db_connections (name, type, host, port, database, default_schema, username, password, is_default, connection_type, source_system_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [row.name, row.type, row.host, row.port, row.database, row.default_schema ?? null,
         row.username, row.password, row.connection_type, row.source_system_code ?? null]
    );
    return r.lastID;
}
async function seedData() {
    tdb = new sqlite3.Database(TEMP_DB);
    await new Promise((resolve, reject) => tdb.run('PRAGMA busy_timeout = 5000', (e) => (e ? reject(e) : resolve())));

    const users = {};
    async function ensureUser(username, role, displayName) {
        const existing = await tdbGet('SELECT id, username, display_name, role FROM users WHERE username = ?', [username]);
        if (existing) return existing;
        const r = await tdbRun(
            `INSERT INTO users (username, password, display_name, role, status) VALUES (?, ?, ?, ?, 'active')`,
            [username, 'not-used-jwt-only', displayName, role]
        );
        return { id: r.lastID, username, display_name: displayName, role };
    }
    users.admin = await ensureUser('admin', 'admin', '管理员');
    users.developer = await ensureUser('g3_developer', 'user', 'G3测试开发');
    users.business = await ensureUser('g3_business', 'user', 'G3测试业务对接人');

    // 插入顺序即 id 升序：pxZzz(低) → bms(中) → external(高)，名称升序恰好镜像反转（见文件头注释）
    const conn = {};
    conn.pxZzz = await insertConn({
        name: 'MMM-PX_ZZZ备用库', type: 'sqlserver', host: '10.255.255.1', port: 1, database: 'pxdb', default_schema: null,
        username: 'testuser', password: encryptPassword('testpass'), connection_type: 'source', source_system_code: 'PX_ZZZ',
    });
    conn.bms = await insertConn({
        name: 'AAA-BMS大数据仓库', type: 'sqlserver', host: '10.255.255.1', port: 1, database: 'bmsdb', default_schema: null,
        username: 'testuser', password: encryptPassword('testpass'), connection_type: 'source', source_system_code: 'BMS',
    });
    conn.external = await insertConn({
        name: '小程序-智荟人力', type: 'external', host: '-', port: 0, database: '-', default_schema: null,
        username: '-', password: encryptPassword('-'), connection_type: 'source', source_system_code: 'MINIAPP_ZHHL',
    });

    await tdbRun(`INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES('collab_requests', ?)`, [SEQ_BASE]);
    await tdbRun(`INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES('collab_attachments', ?)`, [SEQ_BASE]);

    return { users, conn };
}

// ============================================================================
// §API fixture helper：reqBms/reqPx 直接走 HTTP API 建单（不需要浏览器交互，节省步骤——
// 唯一必须走浏览器 UI 的建单是 T1 的 reqExt，因为 T1 要验证的正是「建单页表单」本身）
// ============================================================================
async function apiCreateRequest(ctx, targetConnId, oaNo, description) {
    const adminToken = signAs(ctx.users.admin);
    const createRes = await apiCall('POST', '/api/collab/requests', adminToken, {
        oa_request_no: oaNo,
        requester_dept: '市场营销部',
        requester_name: 'G3测试业务方',
        description,
        deadline: '2027-12-31 18:00:00',
        contact_person_id: ctx.users.business.id,
        target_db_connection_id: targetConnId,
    });
    if (createRes.status !== 200) {
        throw new Error(`fixture 建单失败(${oaNo}): ${createRes.status} ${JSON.stringify(createRes.body)}`);
    }
    const id = createRes.body.id;
    const collabBase = path.join(ROOT, 'uploads', 'collab');
    registerCleanupPath(path.join(collabBase, '_pending', String(id)));
    registerCleanupPath(path.join(collabBase, computeFinalDirName(id, description)));
    return { id, oaNo };
}
async function apiAssignDeveloper(ctx, id) {
    const businessToken = signAs(ctx.users.business);
    const r = await apiCall('POST', `/api/collab/requests/${id}/assign`, businessToken, { developer_id: ctx.users.developer.id });
    if (r.status !== 200) throw new Error(`fixture 指派失败(#${id}): ${r.status} ${JSON.stringify(r.body)}`);
    return r;
}

// ============================================================================
// §Playwright helper：登录中继（鉴权页 goto 前经 login.html 写 token，防 checkAuth 销毁 context）
// ============================================================================
// M3（12b 质量审）：console error 只能抓到前端主动 console.error 的错误——服务端真的返回了
// 4xx/5xx 但前端吞掉不打印的情况，T6 原有的 console 判据完全测不出。每个 BrowserContext 的
// page 都挂一个 response 监听，只记同源（BASE 同源）且 status>=400 的请求，按会话分桶累计，
// 最终 T6 断言总数为 0。若某个已知交互必然产生预期内的非 2xx（如登录中继/下载），在
// HTTP_ERROR_WHITELIST 里显式登记 URL 模式 + 理由，不写在这里的任何 4xx/5xx 都计入失败——
// 目前为空：本套件全程都是正常路径，预期全部同源请求都是 2xx/3xx。
const HTTP_ERROR_WHITELIST = [
    // { pattern: /\/api\/xxx/, reason: '……' },
];
function isSameOrigin(url) {
    try { return new URL(url).origin === new URL(BASE).origin; } catch (_) { return false; }
}
function isWhitelistedHttpError(url) {
    return HTTP_ERROR_WHITELIST.some((w) => w.pattern.test(url));
}
async function loginAs(browser, token, targetPath) {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    const httpErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror:' + e.message));
    page.on('dialog', (d) => d.accept());
    page.on('response', (resp) => {
        const url = resp.url();
        const status = resp.status();
        if (status >= 400 && isSameOrigin(url) && !isWhitelistedHttpError(url)) {
            httpErrors.push({ url, status });
        }
    });
    await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
    await page.evaluate((t) => localStorage.setItem('token', t), token);
    await page.goto(`${BASE}${targetPath}`, { waitUntil: 'load' });
    return { ctx, page, errors, httpErrors };
}
const allConsoleErrors = []; // { session, errors: [] } 汇总，T6 统一判定
const allHttpErrors = []; // { session, errors: [{url, status}] } 汇总，T6 统一判定（M3）
function recordHttpErrors(sessionName, errors) {
    allHttpErrors.push({ session: sessionName, errors: errors.slice() });
}
function recordConsoleErrors(sessionName, errors) {
    allConsoleErrors.push({ session: sessionName, errors: errors.slice() });
}

function xlsxContent() { return 'fake xlsx binary content not validated (external_skip / smoke-未达比对阶段)'; }
function sqlContent() { return 'SELECT 1 AS health_check'; }

// M5（12b 质量审，逐字对齐 G2 的同名函数——见 L1 静态漂移哨兵不覆盖此二者，仅作为并行硬化保留
// 一致）：元数据快照只能证明"属性没变"，证明不了"内容没变"；只对主库文件（无后缀）额外算一次
// sha1 内容哈希——-wal/-shm/-journal 是 WAL 辅助文件，体量可能不小且哪怕本次运行未碰真实库，
// SQLite 自身/其他无关进程的检查点动作也可能重写其内容，这三个仍只比对元数据。
function fileSha1(p) {
    try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); }
    catch (_) { return null; }
}
function snapshotRealDbState() {
    const snap = {};
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const p = REAL_DB + suffix;
        const isMain = suffix === '';
        try {
            const st = fs.statSync(p);
            snap[suffix || '(main)'] = { exists: true, size: st.size, mtimeMs: st.mtimeMs, sha1: isMain ? fileSha1(p) : undefined };
        } catch (_) {
            snap[suffix || '(main)'] = { exists: false, size: null, mtimeMs: null, sha1: isMain ? null : undefined };
        }
    }
    return snap;
}
function diffRealDbSnapshots(before, after) {
    const diffs = [];
    for (const key of Object.keys(before)) {
        const b = before[key], a = after[key];
        if (b.exists !== a.exists || b.size !== a.size || b.mtimeMs !== a.mtimeMs || b.sha1 !== a.sha1) {
            diffs.push(`${key}: before=${JSON.stringify(b)} after=${JSON.stringify(a)}`);
        }
    }
    return diffs;
}

// ============================================================================
// T1：建单页目标库下拉 + 建单落地（浏览器驱动，admin 会话）
// ============================================================================
async function runT1CreateFlow(ctx, adminPage) {
    section('T1：建单页目标库下拉 + 建单落地');
    await adminPage.evaluate(() => openNewModal());
    await adminPage.waitForTimeout(800);

    const optionTexts = await adminPage.locator('#f_target_db option').allInnerTexts();
    const extOptText = optionTexts.find((t) => t.includes('小程序-智荟人力'));
    // 坏法：C4 下拉未按 type 分支，external 行会落到通用格式 "名称 · - / -"（host/database 占位值 '-'）
    ok('T1a 下拉含「小程序-智荟人力（外部源）」精确文本', extOptText === '小程序-智荟人力（外部源）', `实得选项集：${JSON.stringify(optionTexts)}`);
    ok('T1b 外部源 option 文本不含 "- / -" 占位值残留', !!extOptText && !extOptText.includes('- / -'), extOptText);

    const bmsOptText = optionTexts.find((t) => t.includes('AAA-BMS大数据仓库'));
    const pxOptText = optionTexts.find((t) => t.includes('MMM-PX_ZZZ备用库'));
    // 坏法：external 分支误吞掉了普通行，普通行也被改成"纯名称"格式（丢失 host/database 信息）
    ok('T1c 普通行(BMS) option 文本含 " · " 与真实 host/database（未被 external 分支误伤）',
        !!bmsOptText && bmsOptText.includes(' · ') && bmsOptText.includes('10.255.255.1'), bmsOptText);
    ok('T1d 普通行(PX_ZZZ) option 文本含 " · " 与真实 host/database', !!pxOptText && pxOptText.includes(' · ') && pxOptText.includes('10.255.255.1'), pxOptText);

    await adminPage.selectOption('#f_dept', '市场营销部');
    await adminPage.fill('#f_oa_no', '700001');
    await adminPage.fill('#f_requester', 'G3测试业务方');
    await adminPage.fill('#f_desc', 'G3外部源建单UI验证');
    await adminPage.selectOption('#f_target_db', String(ctx.conn.external));
    await adminPage.selectOption('#f_contact', String(ctx.users.business.id));

    const respPromise = adminPage.waitForResponse((r) => r.url().includes('/api/collab/requests') && r.request().method() === 'POST');
    await adminPage.click('#btnSubmit');
    const resp = await respPromise;
    const respBody = await resp.json().catch(() => null);
    ok('T1e UI 建单请求 200', resp.status() === 200, `实得 ${resp.status()} ${JSON.stringify(respBody)}`);
    const reqExtId = respBody && respBody.id;
    // 坏法：提交弹窗/后续消费点若按协作单 id（900000+ 区间）而非 target_db_connection_id（1~3 区间）
    // 去查 targetDbMap，两者数值区间天然不重叠，本断言本身只确认前提成立——真正的坏法防御在 T2 的
    // 提示文案断言里（若真的查错了 key，会直接查不到 external 记录、退化成非外部源默认文案）。
    ok('T1f collab.id !== target_db_connection_id', Number.isInteger(reqExtId) && reqExtId !== ctx.conn.external, `id=${reqExtId} target=${ctx.conn.external}`);

    // M1（12b 质量审）：只看响应 200 不能排除"后端忽略/悄悄改写了请求体里的目标库，仍照常 200
    // 返回"这类坏法——加两条更硬的证据：① 核对 POST 请求体本身确实携带了 external 连接 id（不是
    // 只看响应回显了什么）；② 建单后直查临时库落库值，确认服务端真的把这个字段原样写进去了。
    let t1ReqBody = null;
    try { t1ReqBody = resp.request().postDataJSON(); }
    catch (_) { try { t1ReqBody = JSON.parse(resp.request().postData() || 'null'); } catch (__) { t1ReqBody = null; } }
    ok('M1a POST /api/collab/requests 请求体 target_db_connection_id 字段确为 external 连接 id（坏法：前端选中值与实际提交字段不一致，如取错 select/键名对不上）',
        !!t1ReqBody && Number(t1ReqBody.target_db_connection_id) === ctx.conn.external, JSON.stringify(t1ReqBody));

    if (reqExtId) {
        const collabBase = path.join(ROOT, 'uploads', 'collab');
        registerCleanupPath(path.join(collabBase, '_pending', String(reqExtId)));
        registerCleanupPath(path.join(collabBase, computeFinalDirName(reqExtId, 'G3外部源建单UI验证')));

        const t1DbRow = await tdbGet('SELECT target_db_connection_id FROM collab_requests WHERE id=?', [reqExtId]);
        ok('M1b 建单后临时库 collab_requests.target_db_connection_id === ctx.conn.external（坏法：后端忽略/改写请求体里的目标库字段，仍 200 但落库值不对）',
            !!t1DbRow && Number(t1DbRow.target_db_connection_id) === ctx.conn.external, JSON.stringify(t1DbRow));
    }
    await adminPage.waitForTimeout(500);
    const modalStillOpen = await adminPage.locator('#newModal.open').isVisible().catch(() => false);
    ok('T1g 建单弹窗已关闭（提交成功）', !modalStillOpen);
    return reqExtId;
}

// ============================================================================
// T3：目标库列排序（admin 会话，复用 T1 的 adminPage）
// ============================================================================
async function runT3SortTest(adminPage, oaExt, oaBms, oaPx) {
    section('T3：目标库列排序——按名称升/降序，且与连接 id 顺序相反');
    await adminPage.evaluate(() => loadList());
    await adminPage.waitForTimeout(800);

    async function currentOrder() {
        const rows = await adminPage.locator('#collabListTable tbody tr').all();
        const order = [];
        for (const row of rows) {
            const text = await row.innerText();
            if (text.includes(oaExt)) order.push('EXT');
            else if (text.includes(oaBms)) order.push('BMS');
            else if (text.includes(oaPx)) order.push('PX');
        }
        return order;
    }

    await adminPage.click('#collabListTable th[data-sort-by="target_db_connection_id"]'); // 第一次点击：新字段 → dir=desc
    await adminPage.waitForTimeout(400);
    const descOrder = await currentOrder();
    // 坏法：排序 getter 直接用 DTO 对象参与 localeCompare（String(DTO) 全等于 "[object Object]"）→
    // 比较器恒返回 0（稳定排序不改变原序）→ 这里得到的顺序会等于「未排序前的原始列表序」，与按名称
    // 排出来的 [PX, BMS, EXT] 不同（除非原始序恰好巧合相同，概率极低——三条互不相同的 target 名）。
    ok('T3a 首次点击（desc）行序 = [PX, BMS, EXT]（按名称降序，恰为连接 id 升序）', JSON.stringify(descOrder) === JSON.stringify(['PX', 'BMS', 'EXT']), JSON.stringify(descOrder));

    await adminPage.click('#collabListTable th[data-sort-by="target_db_connection_id"]'); // 第二次点击（同字段）：dir=asc
    await adminPage.waitForTimeout(400);
    const ascOrder = await currentOrder();
    ok('T3b 再次点击（asc）行序 = [EXT, BMS, PX]（按名称升序，恰为连接 id 降序）', JSON.stringify(ascOrder) === JSON.stringify(['EXT', 'BMS', 'PX']), JSON.stringify(ascOrder));

    const isMirror = descOrder.length === 3 && ascOrder.length === 3 && descOrder[0] === ascOrder[2] && descOrder[1] === ascOrder[1] && descOrder[2] === ascOrder[0];
    const isDifferent = JSON.stringify(descOrder) !== JSON.stringify(ascOrder);
    // 坏法兜底：即使恰巧两次点击顺序字符串不同，也要求严格互为镜像——防止只改了一半排序逻辑的半吊子实现蒙混过关
    ok('T3c 两次点击顺序互为镜像且不同（防 tie-fallback 坏法：全部退化为原序会导致两次点击结果相同）', isMirror && isDifferent, `desc=${JSON.stringify(descOrder)} asc=${JSON.stringify(ascOrder)}`);
}

// ============================================================================
// T2：指派 → 开发提交（外部源版文案）→ toast/详情/列表徽章/导出
// ============================================================================
async function runT2SubmitFlow(browser, ctx, reqExtId, adminPage) {
    section('T2：指派 → 开发提交（外部源免验全链路）');
    await apiAssignDeveloper(ctx, reqExtId);

    const devToken = signAs(ctx.users.developer);
    const { ctx: devCtx, page: devPage, errors: devErrors, httpErrors: devHttpErrors } = await loginAs(browser, devToken, `/Data_Collab.html?id=${reqExtId}`);
    await devPage.waitForTimeout(1500);

    const uploadBtn = devPage.locator('button:has-text("上传交付物")').first();
    const btnVisible = await uploadBtn.isVisible().catch(() => false);
    ok('T2a 开发视角「上传交付物」按钮可见（PENDING 态 + 本人为 developer）', btnVisible);
    if (btnVisible) {
        await uploadBtn.click();
        await devPage.waitForTimeout(500);
        const modalOpen = await devPage.locator('#submitDeliveryModal.open').isVisible().catch(() => false);
        ok('T2b 提交弹窗已打开', modalOpen);

        const scriptHint = await devPage.locator('#submitScriptSmokeHint').textContent().catch(() => '');
        const generalHint = await devPage.locator('#submitGeneralSmokeHint').textContent().catch(() => '');
        // 〔对齐 codex 13-L1 既有拍板〕script 提示前半段是文件格式/大小/数量约束（与是否 external
        // 无关，external 单一样要遵守），不能整句覆盖——只有后半段 smoke 描述才替换成外部源说明；
        // general 提示原文通篇都是 smoke 描述，整句替换即是"只换 smoke 那一句"。
        // 坏法：两处提示只切换了其中一处（另一处沿用非外部源默认文案），或按 collab.id 而非
        // target_db_connection_id 查 targetDbMap 导致查无记录、回落默认非外部源文案，或 script
        // 提示误整句覆盖丢失了文件格式约束前缀。
        ok('T2c 提交弹窗 SQL 脚本提示为外部源版文案（保留文件格式前缀 + 外部源说明后缀）',
            (scriptHint || '').trim() === '扩展名 .sql / .txt，每个 ≤ 1MB，最多 5 个。该单目标库为外部源，平台不执行 SQL 校验，请确认结果文件为实际导出数据。', scriptHint);
        ok('T2d 提交弹窗通用提示为外部源版文案（两处提示都变，非只改其一）', (generalHint || '').trim() === '该单目标库为外部源，平台不执行 SQL 校验，请确认结果文件为实际导出数据。', generalHint);

        await devPage.setInputFiles('#f_delivery_script', {
            name: 'g3_script.sql', mimeType: 'text/plain', buffer: Buffer.from(sqlContent()),
        });
        await devPage.setInputFiles('#f_delivery_data', {
            name: 'g3_result.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(xlsxContent()),
        });
        await devPage.click('#btnSubmitDelivery');
        await devPage.waitForTimeout(2000);

        const toastText = await devPage.locator('#toast-container').innerText().catch(() => '');
        // 坏法：toast 判断走错字段（如误读 sql_validation_status undefined），仍显示"正在跑 smoke test"旧文案
        ok('T2e 提交成功 toast 含「外部源免验」', toastText.includes('外部源免验'), toastText);

        const modalClosed = !(await devPage.locator('#submitDeliveryModal.open').isVisible().catch(() => true));
        ok('T2f 提交弹窗已关闭（提交成功）', modalClosed);

        await devPage.waitForTimeout(800);
        const valBoxCount = await devPage.locator('#detailBody .val-external-bg').count();
        ok('T2g 详情验收区显示 .val-external-bg 底色区块', valBoxCount === 1, `实得 ${valBoxCount} 个`);
        if (valBoxCount === 1) {
            const boxText = await devPage.locator('#detailBody .val-external-bg').innerText();
            ok('T2h 详情验收区标题含「外部源免验」', boxText.includes('外部源免验'), boxText);
            ok('T2i 详情验收区 meta 含「外部源·未执行校验」', boxText.includes('外部源·未执行校验'), boxText);
        }
        const detailTagCount = await devPage.locator('#detailBody .db-tag-external').count();
        ok('T2j 详情目标库字段含「外部源」标签（.db-tag-external）', detailTagCount >= 1, `实得 ${detailTagCount} 个`);
    }
    recordConsoleErrors('T2-developer', devErrors);
    recordHttpErrors('T2-developer', devHttpErrors);
    await devCtx.close();

    // 列表侧断言（admin 会话，复用 T1/T3 的 adminPage）
    section('T2 续：列表验收徽章 + 目标库列标签 + 导出');
    await adminPage.evaluate(() => loadList());
    await adminPage.waitForTimeout(800);
    const extRow = adminPage.locator('#collabListTable tbody tr', { hasText: '700001' });
    const extRowCount = await extRow.count();
    ok('T2k 列表能定位到 reqExt 行', extRowCount === 1, `实得 ${extRowCount} 行`);
    if (extRowCount === 1) {
        const badgeCount = await extRow.locator('.val-badge.val-external').count();
        // 坏法：SQL_VALIDATION_LABELS 未登记 external_skipped，或登记了但 cls 拼错，徽章渲染不出来/class 不匹配
        ok('T2l 列表验收列徽章 class 含 val-external', badgeCount === 1, `实得 ${badgeCount} 个`);
        if (badgeCount === 1) {
            const badgeText = await extRow.locator('.val-badge.val-external').innerText();
            ok('T2m 列表验收列徽章文本含「外部源免验」', badgeText.includes('外部源免验'), badgeText);
        }
        const listTagCount = await extRow.locator('.db-tag-external').count();
        ok('T2n 列表目标库列含「外部源」标签', listTagCount === 1, `实得 ${listTagCount} 个`);
    }

    // 导出：真实点击 → 拦截下载 → 用 xlsx 包解析文件内容（非 page.evaluate 读内存函数，走完整真实路径）
    const downloadPromise = adminPage.waitForEvent('download');
    await adminPage.click('#btnExportCollab');
    const download = await downloadPromise;
    const downloadPath = await download.path();
    let exportOk = false, exportDetail = '';
    if (downloadPath) {
        try {
            const wb = XLSX.readFile(downloadPath);
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
            const header = rows[0] || [];
            const oaIdx = header.indexOf('OA 流程号');
            const dbIdx = header.indexOf('目标业务库');
            const valIdx = header.indexOf('验收状态');
            const dataRow = rows.slice(1).find((r) => String(r[oaIdx]).includes('700001'));
            if (dataRow) {
                const dbCell = dataRow[dbIdx];
                const valCell = dataRow[valIdx];
                // 坏法：目标库列 getter 直接塞 DTO 对象（转成 "[object Object]"）或漏查 targetDbMap 回落 "#id"
                exportOk = dbCell === '小程序-智荟人力' && valCell === '外部源免验';
                exportDetail = `目标库列="${dbCell}" 验收状态列="${valCell}"`;
            } else {
                exportDetail = `导出文件中未找到 OA=700001 的行（header=${JSON.stringify(header)}）`;
            }
        } catch (e) {
            exportDetail = `解析导出文件异常：${e.message}`;
        }
    } else {
        exportDetail = '下载未产生本地文件路径';
    }
    ok('T2o 导出 xlsx：目标库列="小程序-智荟人力"、验收状态列="外部源免验"（真实点击+下载+解析）', exportOk, exportDetail);
}

// ============================================================================
// T4：周期取数创建下拉不含外部源
// ============================================================================
async function runT4PeriodicFetch(browser, ctx) {
    section('T4：周期取数创建下拉不含外部源');
    const adminToken = signAs(ctx.users.admin);
    const { ctx: pfCtx, page: pfPage, errors: pfErrors, httpErrors: pfHttpErrors } = await loginAs(browser, adminToken, '/Periodic_Fetch.html');
    await pfPage.waitForTimeout(1500);

    const optionTexts = await pfPage.locator('#pfNewConn option').allInnerTexts();
    // 坏法：C4 客户端过滤缺失（externalSourceSqlFilter 只在后端拒绝创建，前端下拉仍展示 external 选项）
    ok('T4a 周期取数创建下拉不含「小程序-智荟人力」', !optionTexts.some((t) => t.includes('小程序-智荟人力')), JSON.stringify(optionTexts));
    ok('T4b 周期取数创建下拉含普通行 BMS（确认过滤只排除 external，非整体清空）', optionTexts.some((t) => t.includes('AAA-BMS大数据仓库')), JSON.stringify(optionTexts));
    ok('T4c 周期取数创建下拉含普通行 PX_ZZZ', optionTexts.some((t) => t.includes('MMM-PX_ZZZ备用库')), JSON.stringify(optionTexts));

    // M2（12b 质量审）：只看展示文本测不出"文本被过滤掉了、但 option 的 value 仍然指向 external
    // 连接 id"这类界面级伪装（例如过滤逻辑只砍了显示文案却没砍掉底层 option 节点，或者砍错了
    // 判断维度）——直接读 DOM 里全部 option 的 value 集合，按值比对，不经过任何文本匹配。
    const optionValues = await pfPage.locator('#pfNewConn option').evaluateAll((opts) => opts.map((o) => o.value));
    ok('M2 周期取数创建下拉 option value 集合不含 external 连接 id（不只看展示文本，坏法：文本被过滤但 value 仍可选中 external）',
        !optionValues.includes(String(ctx.conn.external)), JSON.stringify(optionValues));

    recordConsoleErrors('T4-periodic-fetch', pfErrors);
    recordHttpErrors('T4-periodic-fetch', pfHttpErrors);
    await pfCtx.close();
}

// ============================================================================
// T5：admin 连接管理列表——external 行徽章 + 隐藏测试/删除按钮
// ============================================================================
async function runT5AdminConnList(browser, ctx) {
    section('T5：admin 连接管理列表——external 行标记与按钮隐藏');
    const adminToken = signAs(ctx.users.admin);
    const { ctx: adminMgmtCtx, page: mgmtPage, errors: mgmtErrors, httpErrors: mgmtHttpErrors } = await loginAs(browser, adminToken, '/admin.html');
    await mgmtPage.waitForTimeout(1500);

    const extRow = mgmtPage.locator('#dbConnectionList tr', { hasText: '小程序-智荟人力' });
    const extRowCount = await extRow.count();
    ok('T5a 定位到 external 行', extRowCount === 1, `实得 ${extRowCount} 行`);
    if (extRowCount === 1) {
        const rowText = await extRow.innerText();
        // 坏法：dialectLabel 分支判断反了（isExternal 取反），或徽章文案拼错
        ok('T5b external 行显示「外部源」徽章', rowText.includes('外部源'), rowText);
        const testBtnCount = await extRow.locator('button:has-text("测试")').count();
        const delBtnCount = await extRow.locator('button:has-text("删除")').count();
        // 坏法：action-btns 条件判断 `!isExternal` 写反/漏写，external 行仍露出可操作按钮
        ok('T5c external 行无「测试」按钮', testBtnCount === 0, `实得 ${testBtnCount} 个`);
        ok('T5d external 行无「删除」按钮', delBtnCount === 0, `实得 ${delBtnCount} 个`);
    }

    const bmsRow = mgmtPage.locator('#dbConnectionList tr', { hasText: 'AAA-BMS大数据仓库' });
    const bmsRowCount = await bmsRow.count();
    ok('T5e 定位到普通行(BMS)', bmsRowCount === 1, `实得 ${bmsRowCount} 行`);
    if (bmsRowCount === 1) {
        const testBtnCount = await bmsRow.locator('button:has-text("测试")').count();
        const delBtnCount = await bmsRow.locator('button:has-text("删除")').count();
        // 坏法：external 分支的按钮隐藏逻辑误伤了普通行（条件写反的另一面）
        ok('T5f 普通行(BMS) 有「测试」按钮（未被 external 分支误伤）', testBtnCount === 1, `实得 ${testBtnCount} 个`);
        ok('T5g 普通行(BMS) 有「删除」按钮（未被 external 分支误伤）', delBtnCount === 1, `实得 ${delBtnCount} 个`);
    }

    recordConsoleErrors('T5-admin-conn-list', mgmtErrors);
    recordHttpErrors('T5-admin-conn-list', mgmtHttpErrors);
    await adminMgmtCtx.close();
}

// ============================================================================
// L1（12b 质量审）静态漂移哨兵：G2/G3 的区间租约与残留扫描基建是逐字复制（非公共 helper），
// 同款改动必须两边同步——这里在启动时把本文件对应函数体的源码文本与 G2 文件比对，防"只改一边"。
// ============================================================================
// 提取某个具名函数的源码文本（从 `function fnName(` 起，按大括号配平找到该函数体的收尾 `}`）。
// 用大括号配平而不是缩进锚点，是因为两个文件里同名函数的缩进层级/上下文不保证完全一致，配平
// 对格式差异更稳健；本文件里这几个函数内部出现的 `{`/`}` 全部是真实的代码结构或彼此平衡的模板
// 插值（如 `${base}`），不存在会破坏配平计数的孤立花括号。
function extractFnSourceText(src, fnName) {
    const re = new RegExp('(?:async\\s+)?function\\s+' + fnName + '\\s*\\(');
    const m = re.exec(src);
    if (!m) return null;
    const start = m.index;
    let i = src.indexOf('{', m.index);
    if (i < 0) return null;
    let depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    if (depth !== 0) return null; // 未配平——多半是正则没找对起点，宁可判"提取失败"也不要返回半截文本
    return src.slice(start, i);
}
// 剥注释（acorn 词法分析，比正则更不容易被字符串/模板字面量里的类注释文本误伤）——把注释字符
// 原地替换成等长空白（保留换行，不改变后续折叠空白的效果），不是直接删字符。
function stripJsCommentsForDrift(source) {
    let acorn;
    try { acorn = require('acorn'); } catch (_) { return source; } // acorn 不可用——降级返回原文，比对仍会走折叠空白
    try {
        const comments = [];
        acorn.parse(source, {
            ecmaVersion: 2022, sourceType: 'script', allowReturnOutsideFunction: true,
            onComment: (block, text, start, end) => comments.push([start, end]),
        });
        if (!comments.length) return source;
        comments.sort((a, b) => a[0] - b[0]);
        let out = '', last = 0;
        for (const [start, end] of comments) {
            if (start < last) continue;
            out += source.slice(last, start);
            out += source.slice(start, end).replace(/[^\n\r]/g, ' ');
            last = end;
        }
        return out + source.slice(last);
    } catch (_) {
        return source; // 解析失败（如提取到的片段不是合法独立语法单元）——降级返回原文，不静默跳过整个哨兵
    }
}
// 归一化：剥注释 + 折叠全部空白 + 抹平两个脚本各自的识别 tag（`[verify-collab-external-source]`
// / `[test-collab-external-source-playwright]` 这两个 console.error 前缀字面量按设计就该不同，
// 不算逻辑分叉）。
function normalizeForDriftCompare(text) {
    if (text == null) return null;
    return stripJsCommentsForDrift(text)
        .replace(/\[verify-collab-external-source\]/g, '[SCRIPT]')
        .replace(/\[test-collab-external-source-playwright\]/g, '[SCRIPT]')
        .replace(/\s+/g, ' ')
        .trim();
}
// spec 原文点名的三个函数是 acquireSeqBaseLease/releaseSeqBaseLease/precheckNoResidualInRange；
// 这里额外加了 attemptLeaseTakeover（H1 修复的核心判定逻辑本体——acquireSeqBaseLease 只是调用
// 它，若只比对外层调用壳，attemptLeaseTakeover 内部真正被改动的逻辑反而不在漂移哨兵覆盖范围内）
// 与 collectResidualHits（M4 递归扫描的核心实现——同样是 precheckNoResidualInRange 现在只剩的
// 一层薄封装，实际递归逻辑在这个被调用的函数里）。两个加项都是同一个道理的自然延伸，不扩大到
// 本文件其余无关函数。
const DRIFT_SENTINEL_FN_NAMES = [
    'acquireSeqBaseLease', 'releaseSeqBaseLease', 'precheckNoResidualInRange',
    'attemptLeaseTakeover', 'collectResidualHits',
];
function runStaticDriftSentinel() {
    const g2Path = path.join(__dirname, 'verify-collab-external-source.js');
    let g2Src = null;
    try { g2Src = fs.readFileSync(g2Path, 'utf8'); } catch (e) {
        // 〔15-M2 采纳〕G2 缺失/不可读一律计 fail——哨兵"静默跳过"就是假绿：路径错、打包遗漏、权限
        // 变化都会让双份基建的漂移永远发现不了，而套件照样 0 fail 结束
        ok('L1 静态漂移哨兵：G2 文件可读（缺失/不可读=哨兵失效，计 fail 不跳过）', false, `${g2Path}：${e.message}`);
        return;
    }
    const g3Src = fs.readFileSync(__filename, 'utf8');
    const mismatches = [];
    for (const fnName of DRIFT_SENTINEL_FN_NAMES) {
        const g2Norm = normalizeForDriftCompare(extractFnSourceText(g2Src, fnName));
        const g3Norm = normalizeForDriftCompare(extractFnSourceText(g3Src, fnName));
        if (g2Norm === null || g3Norm === null) {
            mismatches.push(`${fnName}：某一侧函数体未能提取（G2=${g2Norm === null ? '缺失/提取失败' : '正常'} G3=${g3Norm === null ? '缺失/提取失败' : '正常'}）`);
            continue;
        }
        if (g2Norm !== g3Norm) mismatches.push(`${fnName}：折叠空白 + 剥注释后源码文本不一致`);
    }
    if (mismatches.length) {
        console.log(`  ⚠ WARN L1 静态漂移哨兵：本文件与 G2 的基建函数已分叉（坏法：同款改动只改了一边）：\n    ${mismatches.join('\n    ')}`);
    }
    ok('L1 静态漂移哨兵：acquireSeqBaseLease/releaseSeqBaseLease/precheckNoResidualInRange/attemptLeaseTakeover/collectResidualHits 与 G2 逐一致（折叠空白+剥注释比对；坏法：只改一边导致两份复制基建悄悄分叉）',
        mismatches.length === 0, mismatches.join('; '));
}

// ============================================================================
// 主 IIFE
// ============================================================================
(async () => {
    console.log('=== G3：数据协作接入外部源 —— Playwright 贯穿（C5）===');
    console.log(`本次运行 id 区间：(${SEQ_BASE}, ${SEQ_RANGE_END})`);

    // L1（12b 质量审）：启动时先跑静态漂移哨兵——不依赖 server/临时库，越早跑越好，免得基建已经
    // 分叉却要等到套件跑完才知道。
    runStaticDriftSentinel();

    const realDbSnapshotBefore = snapshotRealDbState();

    const precheckHits = precheckNoResidualInRange();
    if (precheckHits.length > 0) {
        console.error(`[test-collab-external-source-playwright] 零写预检失败：区间 (${SEQ_BASE}, ${SEQ_RANGE_END}) 内已存在残留，拒绝启动：\n  ${precheckHits.join('\n  ')}`);
        process.exit(1);
    }

    killPort(TEST_PORT, 'startup');
    cleanupTempDb();

    if (path.resolve(TEMP_DB) === path.resolve(REAL_DB)) {
        console.error('[test-collab-external-source-playwright] TEMP_DB 与 REAL_DB 字面同路径，拒绝启动（防误连真实 db）');
        process.exit(1);
    }

    let serverInfo = null;
    let browser = null;
    try {
        serverInfo = await startServer();
        child = serverInfo.child;
        const serverStable = serverInfo.listening && !serverInfo.exited;
        ok('server 已就绪（Task Pool Server running）', serverInfo.listening);
        ok('server 在稳定观察窗内未退出', !serverInfo.exited);
        ok('取数质量双校验 schema 就绪信号已出现', serverInfo.schemaReady,
            serverInfo.schemaReady ? '' : '（未捕获到就绪日志，后续调用靠前端自身重试兜底）');

        if (!serverStable) {
            skip('T1-T5 全部用例', 'server 未就绪/不稳定，无可靠 schema 可用');
        } else {
            const ctx = await seedData();
            browser = await chromium.launch();
            sharedBrowser = browser;

            const adminToken = signAs(ctx.users.admin);
            const { ctx: adminCtx, page: adminPage, errors: adminErrors, httpErrors: adminHttpErrors } = await loginAs(browser, adminToken, '/Data_Collab.html');
            await adminPage.waitForTimeout(1500);

            const reqExtId = await runT1CreateFlow(ctx, adminPage);

            const bms = await apiCreateRequest(ctx, ctx.conn.bms, '700002', 'G3外部源排序断言-BMS');
            const px = await apiCreateRequest(ctx, ctx.conn.pxZzz, '700003', 'G3外部源排序断言-PXZZZ');

            if (reqExtId) {
                await runT3SortTest(adminPage, '700001', bms.oaNo, px.oaNo);
                await runT2SubmitFlow(browser, ctx, reqExtId, adminPage);
            } else {
                skip('T3 排序断言', 'reqExt 建单失败，无法定位第三条排序夹具行');
                skip('T2 全部用例', 'reqExt 建单失败');
            }

            recordConsoleErrors('T1+T3+T2列表/导出-admin', adminErrors);
            recordHttpErrors('T1+T3+T2列表/导出-admin', adminHttpErrors);
            await adminCtx.close();

            await runT4PeriodicFetch(browser, ctx);
            await runT5AdminConnList(browser, ctx);

            await browser.close();
            browser = null;
            sharedBrowser = null;

            section('T6：全程 console 0 error 汇总（各 session 分别采集）');
            let totalConsoleErrors = 0;
            for (const s of allConsoleErrors) {
                totalConsoleErrors += s.errors.length;
                ok(`T6 session「${s.session}」0 console error`, s.errors.length === 0, s.errors.slice(0, 5).join(' | '));
            }
            ok('T6 汇总：全部 session 累计 0 console error', totalConsoleErrors === 0, `累计 ${totalConsoleErrors} 条`);

            // M3（12b 质量审）：console error 判据只能抓前端主动打印的错误，服务端返回 4xx/5xx
            // 但前端吞掉不打印的情况完全测不出——补一份独立的同源 HTTP 响应状态码汇总，按会话
            // 分桶，断言总数为 0（白名单机制见 loginAs 上方 HTTP_ERROR_WHITELIST，当前为空）。
            section('T6 续：全程同源 HTTP 4xx/5xx 汇总（各 session 分别采集，M3）');
            let totalHttpErrors = 0;
            for (const s of allHttpErrors) {
                totalHttpErrors += s.errors.length;
                ok(`T6 session「${s.session}」0 同源 HTTP 4xx/5xx（不在白名单内）`, s.errors.length === 0,
                    s.errors.slice(0, 5).map((e) => `${e.status} ${e.url}`).join(' | '));
            }
            ok('T6 汇总：全部 session 累计 0 同源 HTTP 4xx/5xx（坏法：回归引入的失败请求被前端吞掉不打印 console，仅靠 console 判据测不出）',
                totalHttpErrors === 0, `累计 ${totalHttpErrors} 条`);
        }
    } catch (e) {
        console.error('[test-collab-external-source-playwright] 主流程异常:', e);
        if (process.env.G3_DEBUG && serverInfo) {
            console.error('[test-collab-external-source-playwright] server 日志尾部:\n' + serverInfo.getLog().slice(-4000));
        }
        fail++;
        failures.push(`主流程异常: ${e.message}`);
    } finally {
        if (browser) { try { await browser.close(); } catch (_) { /* ignore */ } sharedBrowser = null; }
        killChildTree(child);
        await closeTdb();
        cleanupTempDb();
        cleanupUploadArtifacts();

        const postCleanupResidual = precheckNoResidualInRange();
        ok('F5 收尾全扫描：id 区间 (SEQ_BASE, SEQ_RANGE_END) 内 uploads/collab 与 _pending 残留 = 0（不依赖登记清单，独立复扫）',
            postCleanupResidual.length === 0,
            postCleanupResidual.length ? postCleanupResidual.join('; ') : '');

        const realDbSnapshotAfter = snapshotRealDbState();
        const realDbDiffs = diffRealDbSnapshots(realDbSnapshotBefore, realDbSnapshotAfter);
        ok('M8 真实 task_pool.db（含 -wal/-shm/-journal）元数据与内容哈希均未变化（存在性/大小/mtime/主库 sha1 逐项比对）',
            realDbDiffs.length === 0, realDbDiffs.length ? realDbDiffs.join(' | ') : '');

        releaseSeqBaseLease();
    }

    console.log(`\n=== 汇总：${pass} 通过 / ${fail} 失败 / ${skipCount} 跳过 ===`);
    if (failures.length) {
        console.log('失败明细：');
        failures.forEach((f) => console.log(`  - ${f}`));
    }
    process.exit(fail === 0 ? 0 : 1);
})();
