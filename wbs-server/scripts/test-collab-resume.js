/**
 * 启动恢复扫描集成测试（D3 模块 5 step-7）
 *
 * 验证 codex 十一审 #2 #5 #7 落地：
 *   - 启动时扫 status='SUBMITTED' AND sql_validation_status='running' AND validation_started_at < NOW-90s
 *   - 命中的恢复为 failed + sql_validation_error='服务重启时校验流程被中断，请重新提交（这不代表您的 SQL 有问题）'
 *   - 不命中的（running 但未超时 / 不是 SUBMITTED / validation_started_at NULL）保持原状
 *
 * 用法：node scripts/test-collab-resume.js
 *
 * [#106 S4c-C] 迁移到临时隔离实例（锚点 §9 Q4 裁定：双实例）。启动期扫描必须重启服务才触发，所以需要两个实例：
 *   1. 实例 A（临时隔离实例，来源 = 本检出的库快照）：经 API 造 4 张协作单，再在 A 的库里把它们种成 4 个场景
 *      场景 1：SUBMITTED + running + validation_started_at = 5 分钟前 → 应被恢复为 failed
 *      场景 2：SUBMITTED + running + validation_started_at 在未来 → 不应被恢复（未超 90s）
 *              （原为 5 秒前；改为未来时刻，让「未超时」不依赖实例 B 的启动耗时——启动超过 85 秒时 5 秒前的行也会超过 90 秒窗口而被恢复，造成假红）
 *              注意：未来时刻对「阈值被删 / 缩到很小」没有判别力（任何阈值下它都不满足 `< now-阈值`），所以另有场景 2b 守住阈值的近边界。
 *      场景 2b：SUBMITTED + running + validation_started_at = 5 秒前 → 仍应保持 running（5 秒 < 90 秒阈值）。
 *              判别力（覆盖范围写准）：能检测「时间过滤被删」和「阈值缩到约 5 秒以下」——这两种实现下这一行会被恢复为 failed，本断言判红；
 *              **不能**证明 90 秒阈值没被改成 60 秒、30 秒等介于 5 秒与 90 秒之间的值（5 秒前的行在这些阈值下同样不被恢复）。要钉住 90 秒本身需要
 *              一条行龄约 60–85 秒的近边界行，本脚本不做（行龄与 B 的启动耗时耦合，会引入时间门之外的新抖动）。
 *              时间门：该行在 B 扫描时的年龄 ≈ 5 秒 + 「种行时刻 → B 扫描时刻」的耗时。种行后立即记 seedMs，B 的恢复日志行出现后记 scanUpperMs
 *              （扫描在此之前已完成，是扫描时刻的上界）；若 (scanUpperMs - seedMs)/1000 + 5 >= 85，行龄已逼近 90 秒阈值，边界无法判定 → 计失败
 *              （提示「实例 B 启动过慢」，不记 SKIP、不静默通过）。
 *      场景 3：DONE + running + validation_started_at = 5 分钟前 → 不应被恢复（状态不是 SUBMITTED）
 *   2. 以 A 的库为来源（sourceDbPath = A 的实例库；来源已是隔离库，sourceEncryptionKey 传 null）起实例 B，B 启动时触发恢复扫描；
 *   3. 轮询 B 的 <实例数据根>/server.log，等 `[collab-resume]` 日志行出现（有界超时，到达即继续；超时 = 失败）；随后**有界等待日志稳定**
 *      （B 的 server.log 大小连续 STABLE_MS 不变，上限 STABLE_CAP_MS，超上限计失败），再读完整窗口断言恢复条数与「无扫描异常」。
 *      残余（缺服务端终结信号）：服务端恢复流程先打印恢复条数，之后还要 await 脏数据诊断查询，异常（「启动恢复扫描异常」）在其后才打印
 *      （server.js:22835-22853），没有「整个流程结束」的日志。本阶段不改产品代码，所以只能用「日志稳定」近似终结：稳定判定本身有极小的漏报窗口
 *      （诊断查询在稳定期内仍未返回），已知并接受；加了服务端终结信号后应改为等该信号。
 *      恢复条数的预期不受既有数据影响：在实例 A 里种场景**之前**，先把非本次夹具的 `status='SUBMITTED' AND sql_validation_status='running'` 行的
 *      validation_started_at 统一改到远未来（只改 A 的实例库，改了几行会打印），所以 B 的恢复条数只取决于本次夹具——预期恒为 1（场景 1）；
 *      种完后再现查一次满足恢复条件的行数，必须恰为 1（规范化没生效就在这里失败，而不是在条数对拍处含糊地红）；
 *   4. 读 B 的库验证各场景；依次收掉 B 与 A（任一步没收干净计入失败）。
 *
 * 启动器接受实例库作来源：scripts/lib/test-instance.js resolveSource（显式 sourceDbPath 分支，不要求来源是业务库）→ createIsolatedDb →
 *   utils/instance-db.js prepareIsolatedDb 对带 _sdh_instance 身份表的来源按隔离库处理，只拒绝「隔离库来源 + 字符串来源键」，传 null 合法。
 *
 * 本文件直接调用启动器（同 verify-issue-lite-void-migration.js 先例），不经 test-env / _test-fixture：A 与 B 都由本脚本自管，
 * 所以批跑 needsService: false（不依赖外部服务）。needsService:false 的成员用 spawnSync、没有批跑超时（scripts/lib/test-batch.js:23），
 * 所以本脚本不能靠外部超时兜底：全部 fetch 带 AbortSignal.timeout（FETCH_TIMEOUT_MS），日志等待有界（LOG_WAIT_MS），实例启动自带 readyTimeoutMs。
 */

'use strict';

const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const fs = require('fs');
const testInstance = require('./lib/test-instance');

// 与 _test-fixture.js 的 createPendingFixture 同一组固定 id（对接人 id=3、目标库连接 id=2、admin id=1）
const ADMIN_ID = 1;
const CONTACT_ID = 3;
const TARGET_DB_CONN_ID = 2;

const LOG_WAIT_MS = 20000;   // 等 B 的 [collab-resume] 日志行的有界超时
const FETCH_TIMEOUT_MS = 30000;   // 单次 HTTP 请求的上限（不需服务成员没有批跑超时，靠脚本内部有界等待）
const STABLE_MS = 2000;           // 判定 B 的日志「稳定」：server.log 大小连续这么久不变
const STABLE_CAP_MS = 15000;      // 等稳定的上限；超过计失败
const BOUNDARY_SECONDS = 5;       // 场景 2b 的行龄（秒）
const BOUNDARY_LIMIT_SECONDS = 85;   // 行龄逼近 90 秒阈值的判定线：(扫描上界 - 种行时刻)/1000 + BOUNDARY_SECONDS 达到它就无法判定边界

// [#106 S4c 收口] 带打开回调、不带 OPEN_CREATE（mode 由调用方传 READWRITE / READONLY）：与 _test-fixture.js 的 openInstanceDb 同源写法（本脚本自起 / 自管实例，不经 fx）
function openDb(file, mode) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
    });
}
const closeDb = (db) => new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));

// 单条语句：每次打开 / 关闭（带回调，关库错误不丢；语句错误优先）。file = 实例库路径
async function dbRun(file, sql, params = []) {
    const db = await openDb(file, sqlite3.OPEN_READWRITE);
    db.configure('busyTimeout', 5000);
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            const self = this;
            db.close((ce) => { const e = err || ce; e ? reject(e) : resolve(self); });
        });
    });
}
async function dbGet(file, sql, params = []) {
    const db = await openDb(file, sqlite3.OPEN_READONLY);
    db.configure('busyTimeout', 5000);   // 实例仍在运行，可能正持有写锁（回滚日志模式下读也会被挡）：首跑实测过一次 SQLITE_BUSY，读连接也要等锁
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => { db.close((ce) => { const e = err || ce; e ? reject(e) : resolve(row); }); });
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

// 用实例 A 的密钥签 admin token（与 test-env.signToken 同形态：读实例库 users 行，1 小时）
async function signAdminToken(inst) {
    const user = await dbGet(inst.dbPath, 'SELECT id, username, display_name, role FROM users WHERE id=?', [ADMIN_ID]);
    if (!user) throw new Error(`实例 A 的库里没有 user id=${ADMIN_ID}`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, inst.jwtSecret, { expiresIn: '1h' });
}

// 经 API 在实例 A 造一张协作单（与 createPendingFixture 的建单请求同形态），返回单 id
async function createCollabRequest(inst, token, tag) {
    const r = await fetch(`${inst.baseUrl}/api/collab/requests`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        body: JSON.stringify({
            oa_request_no: `OA_RESUME_${Date.now()}_${tag}`,
            requester_dept: '市场营销部',
            requester_name: 'resume-fixture',
            description: 'collab-resume fixture',
            deadline: '2026-12-31 18:00:00',
            contact_person_id: CONTACT_ID,
            target_db_connection_id: TARGET_DB_CONN_ID,
        }),
    });
    const body = await r.json().catch(() => null);
    if (r.status !== 200 || !body || !Number.isInteger(body.id)) throw new Error(`实例 A 建协作单失败（${tag}）：${r.status} ${JSON.stringify(body)}`);
    return body.id;
}

// 种场景之前，把 A 库里非本次夹具的 SUBMITTED + running 行的 validation_started_at 统一改到远未来，返回改了几行
// （只改 A 的实例库；让 B 的恢复条数只取决于本次 4 个夹具。validation_started_at 为 NULL 的行不动：它们不满足 `< 阈值`，本来就不会被恢复）
async function neutralizeExistingRunning(instA, fixtureIds) {
    const placeholders = fixtureIds.map(() => '?').join(',');
    const r = await dbRun(instA.dbPath,
        `UPDATE collab_requests
            SET validation_started_at = datetime('now','localtime','+36500 days')
          WHERE status = 'SUBMITTED' AND sql_validation_status = 'running'
            AND validation_started_at IS NOT NULL
            AND id NOT IN (${placeholders})`, fixtureIds);
    return r.changes;
}

// 四个场景（id 由 A 里新建的 4 张单承担，顺序 = 场景 1 / 2 / 2b / 3），种在 A 的库里；返回场景 2b 种完的时刻 seedMs（Date.now()）
async function setupTestRows(instA, ids) {
    const [id1, id2, id2b, id3] = ids;
    // 场景 1：SUBMITTED + running + 5 分钟前 → 应被恢复为 failed
    await dbRun(instA.dbPath,
        `UPDATE collab_requests
            SET status='SUBMITTED', sql_validation_status='running',
                validation_started_at=datetime('now','localtime','-300 seconds'),
                sql_validation_error=NULL
          WHERE id=?`, [id1]);
    // 场景 2：SUBMITTED + running + 未来时刻 → 不应被恢复（未超 90s；见文件头说明）
    await dbRun(instA.dbPath,
        `UPDATE collab_requests
            SET status='SUBMITTED', sql_validation_status='running',
                validation_started_at=datetime('now','localtime','+300 seconds'),
                sql_validation_error=NULL
          WHERE id=?`, [id2]);
    // 场景 3：DONE + running（不应发生但防御性）+ 5 分钟前 → 不应被恢复（状态不是 SUBMITTED）
    await dbRun(instA.dbPath,
        `UPDATE collab_requests
            SET status='DONE', sql_validation_status='running',
                validation_started_at=datetime('now','localtime','-300 seconds'),
                sql_validation_error=NULL
          WHERE id=?`, [id3]);
    // 场景 2b：SUBMITTED + running + 5 秒前 → 仍应保持 running（阈值近边界；判别力与时间门见文件头）。放在最后种，缩短「种行 → 记 seedMs」的间隔
    await dbRun(instA.dbPath,
        `UPDATE collab_requests
            SET status='SUBMITTED', sql_validation_status='running',
                validation_started_at=datetime('now','localtime','-${BOUNDARY_SECONDS} seconds'),
                sql_validation_error=NULL
          WHERE id=?`, [id2b]);
    const seedMs = Date.now();   // 紧接种行之后记；datetime('now') 取整到秒，行龄最多再多 1 秒，被 85 与 90 之间的 5 秒余量覆盖
    console.log(`✅ 测试数据已 setup（实例 A 库：id=${id1} 应恢复 / id=${id2} 不恢复 / id=${id2b} 不恢复（5 秒前） / id=${id3} 不恢复）`);
    return seedMs;
}

// 轮询实例 B 的服务日志，直到出现 [collab-resume] 行（到达信号 + 有界超时，不用固定 sleep）；返回含该标记的全部行
async function waitResumeLines(logFile, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let text = '';
        try { text = fs.readFileSync(logFile, 'utf8'); } catch (_) { /* 日志还没出现：继续等，超时再判失败 */ }
        const lines = text.split(/\r?\n/).filter((l) => l.includes('[collab-resume]'));
        if (lines.length > 0) return lines;
        if (Date.now() >= deadline) return [];
        await new Promise((r) => setTimeout(r, 250));
    }
}

// 恢复日志首行出现之后，有界等待 B 的 server.log 稳定（大小连续 stableMs 不变，上限 capMs）；返回 { stable, size, waitedMs }
async function waitLogStable(logFile, stableMs, capMs) {
    const t0 = Date.now();
    let lastSize = -1;
    let sameSince = Date.now();
    for (;;) {
        let size = -1;
        try { size = fs.statSync(logFile).size; } catch (_) { /* 读不到：按「大小变了」处理，继续等 */ }
        const now = Date.now();
        if (size !== lastSize) { lastSize = size; sameSince = now; }
        else if (size >= 0 && now - sameSince >= stableMs) return { stable: true, size, waitedMs: now - t0 };
        if (now - t0 >= capMs) return { stable: false, size, waitedMs: now - t0 };
        await new Promise((r) => setTimeout(r, 250));
    }
}

function readResumeLines(logFile) {
    let text = '';
    try { text = fs.readFileSync(logFile, 'utf8'); } catch (_) { return []; }
    return text.split(/\r?\n/).filter((l) => l.includes('[collab-resume]'));
}

async function main() {
    process.exitCode = 1;  // 失败退出码先设上：中途被杀 / 未捕获异常 / 事件循环提前排空，退出码都不会是 0；最后由入口按结果改写
    console.log('=== D3 模块 5 启动恢复扫描集成测试（双实例）===\n');
    let instA = null;
    let instB = null;
    const stopFailures = [];

    try {
        // 1. 实例 A：造数
        console.log('正在启动实例 A（造数用）...');
        instA = await testInstance.startTestInstance({});
        const tokenA = await signAdminToken(instA);
        const ids = [];
        for (const tag of ['S1', 'S2', 'S2b', 'S3']) ids.push(await createCollabRequest(instA, tokenA, tag));
        const neutralized = await neutralizeExistingRunning(instA, ids);
        console.log(`✅ 已把 A 库里非夹具的 SUBMITTED+running 行（${neutralized} 行）的 validation_started_at 改到远未来（B 的恢复条数只取决于本次夹具）`);
        const seedMs = await setupTestRows(instA, ids);
        // 启动期扫描预期恢复的行数恒为 1（场景 1）：既有行已被改到远未来，场景 2 在未来，场景 2b 才 5 秒前，场景 3 状态是 DONE。
        // 种完后现查一次满足恢复条件的行数，必须恰为 1——规范化没生效（或有别的行满足条件）就在这里明确失败
        const expectedRecovered = 1;
        const expectRow = await dbGet(instA.dbPath,
            `SELECT COUNT(*) AS c FROM collab_requests
              WHERE status = 'SUBMITTED' AND sql_validation_status = 'running'
                AND validation_started_at < datetime('now','localtime','-90 seconds')`);
        assert(expectRow.c === expectedRecovered, `A 库里满足恢复条件的行应恰为 ${expectedRecovered}（场景 1），实得 ${expectRow.c}：既有 running 行的规范化没有生效`);

        // 2. 实例 B：以 A 的库为来源起（触发启动期恢复扫描）
        console.log('\n正在启动实例 B（来源 = 实例 A 的库，触发恢复扫描）...');
        instB = await testInstance.startTestInstance({ sourceDbPath: instA.dbPath, sourceEncryptionKey: null, modules: ['core'] });
        console.log('实例 B 已就绪\n');

        // 3. B 的服务日志：[collab-resume] 行
        const firstLines = await waitResumeLines(instB.logFile, LOG_WAIT_MS);
        const scanUpperMs = Date.now();   // 恢复日志首行已出现（或等待超时）：扫描在此之前完成，是扫描时刻的上界（场景 2b 时间门用；记在等稳定之前，不被等待放宽）
        // 首行出现后有界等日志稳定，再读完整窗口：服务端恢复流程在打印恢复条数之后还会 await 脏数据诊断查询，异常在其后才打印（server.js:22835-22853），没有终结信号
        const stab = firstLines.length > 0 ? await waitLogStable(instB.logFile, STABLE_MS, STABLE_CAP_MS) : { stable: false, size: -1, waitedMs: 0 };
        const resumeLines = firstLines.length > 0 ? readResumeLines(instB.logFile) : [];
        for (const l of resumeLines) console.log('[server-log]', l.trim());
        await check('B 的 server.log 出现 [collab-resume] 启动恢复日志（有界等待，超时即失败）', async () => {
            assert(firstLines.length > 0, `${LOG_WAIT_MS}ms 内没等到 [collab-resume] 日志行（日志：${instB.logFile}）`);
        });
        await check(`B 的恢复日志条数为 ${expectedRecovered}（仅场景 1）且日志稳定后无扫描异常`, async () => {
            assert(stab.stable, `B 的 server.log 在 ${STABLE_CAP_MS}ms 内没有稳定（大小连续 ${STABLE_MS}ms 不变），恢复流程是否结束无法判定（已等 ${stab.waitedMs}ms）`);
            const hit = resumeLines.map((l) => /启动恢复 (\d+) 个 running 超时协作单为 failed/.exec(l)).find((m) => m);
            assert(hit, `没有「启动恢复 N 个 running 超时协作单为 failed」行：${JSON.stringify(resumeLines)}`);
            assert(Number(hit[1]) === expectedRecovered, `恢复条数应为 ${expectedRecovered}，日志为 ${hit[1]}`);
            assert(!resumeLines.some((l) => /启动恢复扫描异常/.test(l)), `扫描报异常：${JSON.stringify(resumeLines)}`);
        });

        // 4. 验证 3 个场景（读 B 的库）
        const [id1, id2, id2b, id3] = ids;
        await check(`场景 1 (id=${id1}) 超时 running 应被恢复为 failed`, async () => {
            const row = await dbGet(instB.dbPath, `SELECT status, sql_validation_status, sql_validation_error FROM collab_requests WHERE id=?`, [id1]);
            assert(row.sql_validation_status === 'failed', `expected failed, got ${row.sql_validation_status}`);
            assert(/服务重启/.test(row.sql_validation_error || ''), `error 应含"服务重启": ${row.sql_validation_error}`);
            assert(row.status === 'SUBMITTED', `status 应保持 SUBMITTED, got ${row.status}`);
        });

        await check(`场景 2 (id=${id2}) 未超时 running 不应被恢复`, async () => {
            const row = await dbGet(instB.dbPath, `SELECT status, sql_validation_status FROM collab_requests WHERE id=?`, [id2]);
            assert(row.sql_validation_status === 'running', `expected still running, got ${row.sql_validation_status}`);
        });

        await check(`场景 2b (id=${id2b}) 5 秒前 running（阈值近边界）不应被恢复；行龄逼近 90 秒阈值时边界无法判定，计失败`, async () => {
            assert(resumeLines.length > 0, '没等到恢复日志行，扫描时刻上界不可信，边界无法判定');
            const ageUpperSec = (scanUpperMs - seedMs) / 1000 + BOUNDARY_SECONDS;
            assert(ageUpperSec < BOUNDARY_LIMIT_SECONDS,
                `实例 B 启动过慢，阈值边界无法判定：种行到扫描完成约 ${((scanUpperMs - seedMs) / 1000).toFixed(1)} 秒，行龄上界 ${ageUpperSec.toFixed(1)} 秒 ≥ ${BOUNDARY_LIMIT_SECONDS} 秒（阈值 90 秒）`);
            const row = await dbGet(instB.dbPath, `SELECT status, sql_validation_status FROM collab_requests WHERE id=?`, [id2b]);
            assert(row.status === 'SUBMITTED', `status 应保持 SUBMITTED, got ${row.status}`);
            assert(row.sql_validation_status === 'running', `5 秒前的 running 行不应被恢复（阈值被删或缩到 5 秒以下的信号），got ${row.sql_validation_status}`);
        });

        await check(`场景 3 (id=${id3}) 状态 DONE 即使 running+超时也不应被改`, async () => {
            const row = await dbGet(instB.dbPath, `SELECT status, sql_validation_status FROM collab_requests WHERE id=?`, [id3]);
            assert(row.status === 'DONE', `status 应保持 DONE, got ${row.status}`);
            assert(row.sql_validation_status === 'running', `sql_validation_status 应保持 running（防御性测试，业务上不该有），got ${row.sql_validation_status}`);
        });
    } catch (e) {
        failed++;
        failures.push({ name: '执行异常', error: e && e.message });
        console.log(`❌ 执行异常: ${e && e.message}`);
        if (e && e.code) console.log(`    [诊断] e.code = ${e.code}`);
        if (e && e.dataDir) console.log(`    [诊断] e.dataDir = ${e.dataDir}`);
        if (e && e.logTail) console.log('    [诊断] e.logTail =\n' + String(e.logTail).split('\n').map((l) => '      | ' + l).join('\n'));
    } finally {
        // 依次收掉 B 与 A（stop() 先收进程、等退出、再删实例数据根并确认）；任何一步没做到都计入失败，不静默
        for (const [label, inst] of [['实例 B', instB], ['实例 A', instA]]) {
            if (!inst) continue;
            try { await inst.stop(); } catch (e) { stopFailures.push(`收掉${label}失败：${e && e.message}`); }
        }
        for (const m of stopFailures) {
            failed++;
            failures.push({ name: '收尾', error: m });
            console.log(`❌ ${m}`);
        }
    }

    console.log(`\n=== 总数: ${passed + failed}, 通过: ${passed}, 失败: ${failed} ===`);
    if (failures.length > 0) {
        console.log('\n失败详情:');
        failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
        return 1;
    }
    console.log('\n全部通过 ✅');
    return 0;
}

main().then((exitCode) => {
    // 收尾：设退出码，让事件循环自然结束；10 秒 unref 兜底强退（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), 10000).unref();
}).catch(e => {
    console.error('测试异常:', e);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 10000).unref();
});
