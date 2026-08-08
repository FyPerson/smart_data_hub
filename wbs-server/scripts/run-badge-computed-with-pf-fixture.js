/**
 * 状态徽章统一 S5b · Periodic_Fetch computed 补跑编排
 *
 * 为什么需要这个脚本：
 *   computed harness（test-badge-computed-playwright.js）对 Periodic_Fetch 一直是
 *   `[SKIP:EMPTY_TABLE]` —— 本机库里一个周期任务都没有。SKIP 是"没验到"不是"验过了"：
 *   PF 是 S3 收编的**新语义模式**页（直接输出 `u-status-badge sem-*`，不走别名规则），
 *   恰恰是最该被 computed 证一次的那一页，却从头到尾零实测覆盖。
 *   本脚本负责把那一页的数据依赖补上：造数 → 跑全量 computed → 清理 → 断言 0 残留。
 *
 * ⚠️⚠️ **定位：空表开发库的验证工具，不是通用测试夹具。**（codex 26 号 H2）
 *   pre-clean 后会**硬断言** periodic_tasks / periodic_task_runs 为空，非空即停止并报原因。
 *   理由：脚本要断言"跑完库回到原样"，而它做不到"在一堆既有数据里精确复原"——
 *   既有周期任务会改变列表首卡、改变 computed 抽到的徽章、也让 0 残留断言失去判据。
 *   与其在有数据的库上给出一个含义不明的绿灯，不如当场停下来说清楚它不适用。
 *   ⇒ 别在生产库或有真实周期任务的库上跑它。
 *
 * ⚠️ **环境前提登记**（S5b-fix3·26C-2，写下来是为了让下一个人知道哪些保证是"靠前提"而非"靠代码"）：
 *   本工具 = **本机单写者开发库专用**，运行期间**无并发写入者**（不会有别的进程/人同时往
 *   periodic_tasks / periodic_task_runs 写东西）。
 *   基于这条前提，**完整事务化（BEGIN/COMMIT 包住 seed 与 cleanup）按前提登记、不做**：
 *   代价是清理路径要跨多条语句、还夹着 HTTP 调用（建单走真实 API），把它们套进一个长事务
 *   会在本项目的单连接 sqlite3 上引入 SQLITE_BUSY 风险，收益却只在"有并发写入者"时才存在。
 *   已做的替代保障：清理按阶段失败即停 + 阶段④只删阶段①留档的 id（消除重求值窗口）+
 *   收尾 0 残留与基线比对。若哪天要在共享库上跑它，这条前提失效，事务化必须重新评估。
 *
 * 用法：
 *   PORT=3000 node scripts/run-badge-computed-with-pf-fixture.js
 *   node scripts/run-badge-computed-with-pf-fixture.js --skip-cleanup   （反向证明专用，见下）
 *
 * 造数范式沿用 test-unify-visual-playwright.js（真实 API 建任务 + db 直插 runs + 幂等
 *   pre-clean + 收尾 0 残留断言），**两处有意不同**：
 *   ① 不做 fixed-id re-id。视觉基线需要固定 id 是因为它逐像素比对，行内 `#id` 一变就漂移；
 *      computed 只读 getComputedStyle，与 id 无关。省掉 re-id 就同时省掉"固定 id 被真实数据
 *      占用"这一整类风险，清理条件改用「本轮实际拿到的 id + 前缀标记」双保险。
 *   ② fixture 前缀用 `[BADGE-COMPUTED]` 而非 `[UNIFY-BASELINE]`。两个 harness 的 pre-clean
 *      都按前缀删，前缀撞车会互删对方的夹具（本脚本 pre-clean 时对方正好在跑 = 数据被抽走）。
 *
 * 造哪些数据（目标：把 PF 的 6 个已登记修饰类一次跑满）：
 *   · 任务 A（active，created_at 较新 ⇒ 列表第一张卡）：5 条 run，状态覆盖
 *     queued / running / success / failed / empty_result → sem-wait / active / done / failed / review
 *   · 任务 B（disabled）：卡头渲染「已禁用」徽章 → sem-voided
 *   合计 6/6。任务 A 排第一是必需的——computed harness 的 openFn 只展开**第一张**卡，
 *   历史表里的 5 个状态徽章只有展开后才存在（故 created_at 显式回填，不靠同秒插入的排序运气）。
 *
 * ⚠️ 写库范围：只 periodic_tasks / periodic_task_runs 两表。收尾按视觉 harness 的 12 表面
 *   做 0 残留断言（另 10 表本脚本不写入，纳入是为了抓「意外附带写入」——真出现就是异常）。
 * ⚠️ server 需先手动起好（与 computed harness 同一条端口纪律，本脚本同样不 spawn server）。
 */
'use strict';

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || '3000';
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = process.env.BADGE_DB_PATH || path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET;
const SKIP_CLEANUP = process.argv.includes('--skip-cleanup');

const FX = '[BADGE-COMPUTED]';
const TASK_A_NAME = `${FX} PF 徽章覆盖-五态`;
const TASK_B_NAME = `${FX} PF 徽章覆盖-已禁用`;
// 〔S5b-fix·M6〕每轮唯一 nonce，写进 description。
//   固定标题只能证明"库里有一行叫这个名字的任务"，证明不了"这行是我这一轮建的"——
//   上一轮崩溃留下的同名残留会替本轮的造数背书，而本轮可能其实一条都没建成。
const NONCE = `R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TASK_DESC = `${FX} computed 覆盖夹具·nonce=${NONCE}，跑完自动清理`;
// 任务 A 必须排第一（列表 ORDER BY created_at DESC）。显式回填而非依赖插入顺序：
//   created_at 精确到秒，同秒建两条时 ORDER BY 是不稳定的，"大多数时候对"不是判据。
const TS_A = '2026-07-02 10:00:00';
const TS_B = '2026-07-01 10:00:00';
const SCRIPT_TEMPLATE = "SELECT id, order_no, created_at FROM dbo.some_orders WHERE created_at >= '{{MONTH_START}}' AND created_at < '{{MONTH_END}}'";

// PF 的 5 个 run 状态（= periodic_task_runs 的 CHECK 全集）→ 页面 6 类里的 5 类。
//   started_at 各不相同：卡头「上次运行」取 runs[0]（ORDER BY started_at DESC），
//   给它一个确定的赢家，免得同值并列时抓到哪条全看实现。
const RUN_FIXTURES = [
    { status: 'success', started: '2026-06-05 09:00:00', finished: '2026-06-05 09:00:05', rows: 128, file: 'periodic-results/BADGE-COMPUTED-a.xlsx', fileStatus: 'present', err: null },
    { status: 'failed', started: '2026-06-04 09:00:00', finished: '2026-06-04 09:00:03', rows: null, file: null, fileStatus: 'missing', err: '夹具：模拟执行失败（脚本自动生成）' },
    { status: 'empty_result', started: '2026-06-03 09:00:00', finished: '2026-06-03 09:00:02', rows: 0, file: 'periodic-results/BADGE-COMPUTED-c.xlsx', fileStatus: 'present', err: null },
    { status: 'running', started: '2026-06-02 09:00:00', finished: null, rows: null, file: null, fileStatus: 'missing', err: null },
    { status: 'queued', started: '2026-06-01 09:00:00', finished: null, rows: null, file: null, fileStatus: 'missing', err: null },
];

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { (e ? rej(e) : res(this)); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, label, detail) {
    if (cond) { pass++; console.log(`  [OK] ${label}`); }
    else { fail++; failures.push({ label, detail }); console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); }
}

// 〔S5b-fix·H3〕本进程见过的**全部** run id（pre-clean 那一轮的也算）。
//   periodic_task_pushes 挂在 run 上，而 SQLite 的外键强制**默认关闭**（见开局 PRAGMA 打印）：
//   删掉 run 不会级联删 push，也不会报错，push 就成了指向空气的孤儿行——
//   一条"0 残留"的绿灯下面躺着脏数据。故 run id 一律留档，删完还要拿它们回头核对。
const seenRunIds = new Set();

// ── 裸 http（照抄视觉 harness 的 503 重试范式：schema readiness 中间件在 server 刚起时会短暂 503）──
function rawReq(token, method, p, body) {
    return new Promise((resolve) => {
        const data = body !== undefined ? JSON.stringify(body) : null;
        const r = http.request({
            host: 'localhost', port: PORT, method, path: p,
            headers: {
                Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
            },
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: d }));
        });
        r.on('error', (e) => resolve({ status: 0, error: e.message }));
        if (data) r.write(data);
        r.end();
    });
}
const jparse = (b) => { try { return JSON.parse(b || '{}'); } catch (_) { return {}; } };
async function api(token, method, p, body) {
    let last = null;
    for (let i = 0; i < 8; i++) {
        const r = await rawReq(token, method, p, body);
        last = r;
        if (r.status !== 503 && r.status !== 0) return r;
        await sleep(400);
    }
    return last;
}

function probeServer() {
    return new Promise((resolve) => {
        const req = http.get({ host: 'localhost', port: PORT, path: '/login.html', timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode > 0);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

// 〔S5b-fix·M5〕返回 {user, token}：run 行的 triggered_by 要写**真实**的 admin id。
//   原来硬编码 1，在 admin 不是 1 号的库上会插出一条指向别人（甚至指向不存在用户）的留痕行——
//   页面照样渲染得出来，所以红不了，但夹具已经在伪造审计字段了。
async function signAsAdmin() {
    const user = await dbGet("SELECT id, username, display_name, role FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1");
    if (!user) throw new Error('库里找不到 admin 用户，无法签发 JWT');
    const token = jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET, { expiresIn: '2h' }
    );
    return { user, token };
}

// ── 清理（幂等）：本轮 id + 前缀标记双条件。前缀那一半兜的是"建完还没记下 id 就崩了"的残留。──
//   〔S5b-fix·H3〕删除顺序 pushes → runs → tasks（子在前）。SQLite 默认不强制外键，
//   反过来删不会报错、只会留孤儿。删完再用**留档的 run id**回头核对子记录归零。
//
// 〔S5b-fix2·H3 收口〕改成**严格分阶段、失败即停**，而不是"每步 try 一下、错了记一笔继续往下删"。
//   上一版把三条 DELETE 排成一队挨个 try：收集 run id 失败照删、删 pushes 失败照删 runs——
//   而"删 pushes 失败"恰恰是唯一一种**继续下去就会造出孤儿**的情形。它把最该刹车的地方
//   变成了最不刹车的地方。
//   现在的取舍写死为一句话：**宁可留下带标记的数据（还能再清一次），也绝不制造孤儿**——
//   带标记的残留是可见、可重跑、可收敛的；指向空气的 push 行没有任何标记，一旦产生，
//   下次跑这个脚本也再也定位不到它。
//
// 〔S5b-fix3·26C-1〕返回值不再用一个笼统的 parentsDeleted，改成 **{runsDeleted, tasksDeleted} 两格**。
//   原来 stop() 一律写死 parentsDeleted:false —— 可阶段⑤（删 tasks）失败时 runs **已经删了**，
//   报告却说"父记录未删"。这不是措辞问题：读报告的人据此判断"库里还剩什么、要不要手工收拾"，
//   报错一格就会朝错误方向收拾。谁删了谁没删，如实各报各的。
// 〔S5b-fix3·26C-2〕阶段④删 runs 改按**阶段①留档的 id 集合**（IN 子句），不再重新求值 runMatch。
//   重新求值等于把"要删哪些行"在①和④之间算了两次：中间新出现的行会被④删掉，而它从没进过
//   留档、也就从没走过③的子记录核对 —— 那正是造孤儿的路径。按 id 删把这个窗口彻底关掉：
//   ④ 删的一定是 ③ 验过的那一批，一行不多。（新出现的行留给 0 残留断言判红，方向 fail-closed。）
async function cleanupFixtures(ids) {
    const taskIds = [ids.taskA, ids.taskB].filter((x) => Number.isInteger(x));
    const idIn = taskIds.length ? `task_id IN (${taskIds.join(',')})` : '0';
    const idIn2 = taskIds.length ? `id IN (${taskIds.join(',')})` : '0';
    const runMatch = `${idIn} OR task_name_snapshot LIKE '${FX}%'
        OR task_id IN (SELECT id FROM periodic_tasks WHERE task_name LIKE '${FX}%')`;
    const errs = [];
    const stop = (stage, remainingPushes, runIdCount, runsDeleted) =>
        ({ errs, stage, remainingPushes, runIdCount, runsDeleted: !!runsDeleted, tasksDeleted: false });

    // ── 阶段① 收集待删 run 的 id 并留档 ──
    //   删完就查不到了，而子记录的核对非它不可。捞不出来就等于**后面无从验证**——
    //   此时继续删 = 闭着眼睛动子表的父记录，必须当场中止，一张表都不许动。
    try {
        const rows = await dbAll(`SELECT id FROM periodic_task_runs WHERE ${runMatch}`);
        rows.forEach((r) => seenRunIds.add(r.id));
    } catch (e) {
        errs.push(`阶段①收集 run id 失败 — ${e.message}（已中止，未删除任何表）`);
        return stop('collect-run-ids', null, seenRunIds.size, false);
    }
    const runIdList = [...seenRunIds];

    // ── 阶段② 删子表 pushes ──
    if (runIdList.length) {
        try {
            await dbRun(`DELETE FROM periodic_task_pushes WHERE run_id IN (${runIdList.join(',')})`);
        } catch (e) {
            errs.push(`阶段②删 periodic_task_pushes 失败 — ${e.message}（已中止，未删除 runs/tasks）`);
            return stop('delete-pushes', null, runIdList.length, false);
        }
    }

    // ── 阶段③ 用留档 id 回头核对：**本轮待删 run 的子记录**是否已清空（删父记录前）──
    //   〔S5b-fix3·26C-3〕这条查的是"这批 run 名下还剩几行 push"，**不是**全库孤儿普查，
    //   故字段名叫 remainingPushes 而不是 orphanPushes。叫错名字会让报告承诺一件它没做的事。
    //   真正的全库孤儿普查另有一条（见 globalOrphanPushes），两者范围不同、结论也不同。
    //   核对必须挡在删 runs 之前：删完再验就只剩"已经造成了"这一种结论。
    let remainingPushes = 0;
    if (runIdList.length) {
        try {
            const row = await dbGet(`SELECT COUNT(*) c FROM periodic_task_pushes WHERE run_id IN (${runIdList.join(',')})`);
            remainingPushes = row ? row.c : null;
        } catch (e) {
            errs.push(`阶段③核对子记录失败 — ${e.message}（已中止，未删除 runs/tasks）`);
            return stop('verify-remaining', null, runIdList.length, false);
        }
        if (remainingPushes !== 0) {
            errs.push(`阶段③本轮待删 run 名下仍有 ${remainingPushes} 行 push（已中止，未删除 runs/tasks）`);
            return stop('verify-remaining', remainingPushes, runIdList.length, false);
        }
    }

    // ── 阶段④ 删 runs（**只删③验过的那批 id**）──
    if (runIdList.length) {
        try {
            await dbRun(`DELETE FROM periodic_task_runs WHERE id IN (${runIdList.join(',')})`);
        } catch (e) {
            errs.push(`阶段④删 periodic_task_runs 失败 — ${e.message}（已中止，未删除 tasks）`);
            return stop('delete-runs', remainingPushes, runIdList.length, false);
        }
    }

    // ── 阶段⑤ 删 tasks ──
    //   tasks 没有子记录核对的负担（它的子表 runs 刚删完），故仍按 id + 前缀匹配，
    //   让"上轮崩溃留下的同名任务"也能被这一条捞走。
    try {
        await dbRun(`DELETE FROM periodic_tasks WHERE ${idIn2} OR task_name LIKE '${FX}%'`);
    } catch (e) {
        errs.push(`阶段⑤删 periodic_tasks 失败 — ${e.message}（runs 已删、tasks 未删）`);
        return { errs, stage: 'delete-tasks', remainingPushes, runIdCount: runIdList.length, runsDeleted: true, tasksDeleted: false };
    }
    return { errs, stage: null, remainingPushes, runIdCount: runIdList.length, runsDeleted: true, tasksDeleted: true };
}

// ── 全库孤儿 push 普查（S5b-fix3·26C-3 追加）──────────
//   阶段③只管"本轮这批 run 名下还剩几行 push"，它证明不了库里没有孤儿。加这一条 NOT EXISTS
//   全表查，才对得起"孤儿"这个词。
//   ⚠️ 口径故意不是"非零就拦"：库里既有的孤儿是别人留下的历史问题，本脚本没有能力也没有
//   立场替它做主（删掉可能销毁证据）。判据改为**基线对比**——记下开跑前的孤儿数，收尾时
//   不得增加。"我没让它更糟"是本脚本能诚实给出的最强结论，就写这么强。
async function globalOrphanPushes() {
    try {
        const row = await dbGet(`SELECT COUNT(*) c FROM periodic_task_pushes p
             WHERE NOT EXISTS (SELECT 1 FROM periodic_task_runs r WHERE r.id = p.run_id)`);
        return row ? row.c : null;
    } catch (e) { return `查询失败：${e.message}`; }
}

// ── 0 残留断言（12 表，沿用视觉 harness 的表面；另 10 表本脚本不写入，纳入是为了抓意外附带写入）──
//   条件一律锚在**本 fixture 自己的标记**上：这样非零就真的等于"我漏了东西"，
//   而不是"库里本来就有别的数据"。pushes 那一行额外用留档 run id（标记列它没有）。
async function residualRows() {
    const like = `'${FX}%'`;
    const runIdList = [...seenRunIds];
    const pushWhere = runIdList.length
        ? `run_id IN (${runIdList.join(',')}) OR run_id IN (SELECT id FROM periodic_task_runs WHERE task_name_snapshot LIKE ${like})`
        : `run_id IN (SELECT id FROM periodic_task_runs WHERE task_name_snapshot LIKE ${like})`;
    const checks = [
        ['periodic_tasks', `task_name LIKE ${like}`],
        ['periodic_task_runs', `task_name_snapshot LIKE ${like} OR task_id IN (SELECT id FROM periodic_tasks WHERE task_name LIKE ${like})`],
        ['periodic_task_pushes', pushWhere],
        ['correction_requests', `location_info LIKE ${like} OR reason LIKE ${like}`],
        ['correction_status_history', `correction_request_id IN (SELECT id FROM correction_requests WHERE location_info LIKE ${like} OR reason LIKE ${like})`],
        ['correction_requesters', `correction_request_id IN (SELECT id FROM correction_requests WHERE location_info LIKE ${like} OR reason LIKE ${like})`],
        ['sys_issues', `title LIKE ${like}`],
        ['sys_issue_timeline', `issue_id IN (SELECT id FROM sys_issues WHERE title LIKE ${like})`],
        ['issues', `title LIKE ${like}`],
        ['issue_status_history', `issue_id IN (SELECT id FROM issues WHERE title LIKE ${like})`],
        ['issue_comments', `issue_id IN (SELECT id FROM issues WHERE title LIKE ${like})`],
        ['collab_requests', `description LIKE ${like}`],
    ];
    const residual = [];
    for (const [table, where] of checks) {
        let row;
        try { row = await dbGet(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`); }
        catch (e) { residual.push(`${table}: 查询失败（${e.message}）`); continue; }
        if (row && row.c > 0) residual.push(`${table}: ${row.c} 行残留`);
    }
    return { residual, tableCount: checks.length };
}

// 环境快照（H2 基线用）：只取本脚本会动的两表 + 其子表
async function snapshotCounts() {
    const out = {};
    for (const t of ['periodic_tasks', 'periodic_task_runs', 'periodic_task_pushes']) {
        const r = await dbGet(`SELECT COUNT(*) c FROM ${t}`);
        out[t] = r ? r.c : null;
    }
    return out;
}
const sameCounts = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
const fmtCounts = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(' / ');

// 〔S5b-fix·H1〕seed 逐步回写已取得的 id（不是等全部成功再一次性返回）。
//   原实现在"任务 A 建好、任务 B 失败"时，taskA 的 id 从没进过 ids —— 兜底清理拿不到它，
//   只能靠前缀那一半去捞。前缀兜得住是运气好（名字带前缀），换一个不带标记的写入就漏了。
//   现在每拿到一个 id 立刻写进 ids，任何一步炸掉，finally 都握着已产生的全部句柄。
async function seed(token, adminUser, ids) {
    const conn = await dbGet("SELECT id, name FROM db_connections WHERE connection_type='source' AND type IN ('sqlserver','mysql') ORDER BY id ASC LIMIT 1");
    if (!conn) throw new Error("库里找不到 connection_type='source' 的 db_connections，PF 建任务端点会 400");
    ids.connName = conn.name;

    const mk = async (name, slot) => {
        const r = await api(token, 'POST', '/api/periodic-tasks', {
            task_name: name,
            description: TASK_DESC,
            source_connection_id: conn.id,
            script_template: SCRIPT_TEMPLATE,
        });
        if (r.status !== 201) throw new Error(`建任务「${name}」失败：status=${r.status} body=${(r.body || '').slice(0, 300)}`);
        ids[slot] = jparse(r.body).id;          // ← 立刻回写，后续任一步失败都不丢句柄
        return ids[slot];
    };
    await mk(TASK_A_NAME, 'taskA');
    await mk(TASK_B_NAME, 'taskB');

    // 任务 B 走**真实禁用端点**（不是直接 UPDATE status）：那条端点带双条件守卫 + changes 检查，
    //   绕过去造数就等于在验一个用户走不到的分支。
    const dis = await api(token, 'POST', `/api/periodic-tasks/${ids.taskB}/disable`, {});
    if (dis.status !== 200) throw new Error(`禁用任务 B 失败：status=${dis.status} body=${(dis.body || '').slice(0, 200)}`);

    // 列表排序回填（ORDER BY created_at DESC ⇒ A 在前）
    await dbRun('UPDATE periodic_tasks SET created_at = ? WHERE id = ?', [TS_A, ids.taskA]);
    await dbRun('UPDATE periodic_tasks SET created_at = ? WHERE id = ?', [TS_B, ids.taskB]);

    // runs 直插（真实跑数要连生产库，超出本 harness 范围；run 行只被只读渲染消费，
    //   按 schema 插固定态快照与"跑过一次"语义等价）。triggered_by 用真实 admin id（M5）。
    const rendered = SCRIPT_TEMPLATE.split('{{MONTH_START}}').join('2026-06-01').split('{{MONTH_END}}').join('2026-07-01');
    for (const rf of RUN_FIXTURES) {
        const res = await dbRun(
            `INSERT INTO periodic_task_runs
                (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot,
                 triggered_by, date_range_start, date_range_end, started_at, finished_at, duration_ms, row_count,
                 result_file_path, file_status, status, error_msg)
             VALUES (?, ?, ?, ?, 1, ?, '2026-06-01', '2026-07-01', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ids.taskA, rendered, TASK_A_NAME, conn.name, adminUser.id, rf.started, rf.finished,
                rf.finished ? 5000 : null, rf.rows, rf.file, rf.fileStatus, rf.status, rf.err]
        );
        if (res && res.lastID) seenRunIds.add(res.lastID);   // 留档（H3）
    }
    return ids;
}

// ── 跑 computed harness 子进程，透传输出并解析尾部统计 ──
function runComputed() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'test-badge-computed-playwright.js')], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT },
        });
        let out = '';
        child.stdout.on('data', (c) => { out += c; process.stdout.write(c); });
        child.stderr.on('data', (c) => { out += c; process.stderr.write(c); });
        child.on('close', (code) => resolve({ code, out }));
    });
}

function parseComputed(out) {
    const tail = (out.match(/^=== (PASS|FAIL)：.*$/m) || [''])[0];
    const nums = tail.match(/(\d+) 项通过 \/ (\d+) 项失败(?: \/ (\d+) 项跳过)?/);
    const pfSkip = (out.match(/^\s*\[SKIP:(\w+)\].*Periodic_Fetch.*$/m) || [])[1] || null;
    const pfCover = (out.match(/Periodic_Fetch[\s\S]{0,600}?覆盖 (\d+)\/(\d+) 类/) || []);
    return {
        tail,
        pass: nums ? +nums[1] : null,
        fail: nums ? +nums[2] : null,
        skip: nums && nums[3] !== undefined ? +nums[3] : 0,
        pfSkip,
        pfCovered: pfCover[1] ? +pfCover[1] : null,
        pfRegistered: pfCover[2] ? +pfCover[2] : null,
    };
}

(async function main() {
    console.log('=== S5b · Periodic_Fetch computed 补跑编排 ===\n');
    if (!JWT_SECRET) { console.log('FAIL：.env 里没有 JWT_SECRET'); process.exit(1); }
    if (!(await probeServer())) {
        console.log(`未探测到 ${BASE_URL} 上的 server。本脚本有意不自行 spawn（端口纪律）：`);
        console.log(`  cd wbs-server && PORT=${PORT} node server.js`);
        process.exit(2);
    }
    console.log(`0. server 探测到（${BASE_URL}）·db=${DB_PATH}·nonce=${NONCE}`);
    // 〔H3〕外键强制开关：SQLite 默认 OFF，本连接同样不开。打印出来是为了让"删 run 不级联删 push"
    //   这个前提可见——本脚本的删除顺序正是建立在它之上，而不是假设数据库会替我们兜底。
    const fkRow = await dbGet('PRAGMA foreign_keys');
    const fkOn = !!(fkRow && (fkRow.foreign_keys === 1 || fkRow.foreign_keys === true));
    console.log(`   PRAGMA foreign_keys = ${fkOn ? 'ON' : 'OFF'}`
        + `（${fkOn ? '删 run 会被外键拦/级联' : 'OFF ⇒ 删 run 不会级联删 push，故本脚本按 pushes→runs→tasks 顺序删并回头核对孤儿'}）`);

    const { user: adminUser, token } = await signAsAdmin();
    console.log(`   admin=#${adminUser.id}（${adminUser.username}）·run 行 triggered_by 用它`);

    const ids = { taskA: null, taskB: null, connName: null };
    let baseline = null;
    let orphanBaseline = null;

    try {
        console.log('\n1. pre-clean（幂等，清上轮崩溃残留）...');
        const pre = await cleanupFixtures(ids);
        check(pre.errs.length === 0 && pre.stage === null && pre.runsDeleted && pre.tasksDeleted,
            'pre-clean 五阶段全部走完（收集 run id → 删 pushes → 核对子记录 → 删 runs → 删 tasks）',
            pre.errs.join('；') + (pre.stage ? `｜中止于阶段 \`${pre.stage}\`（runs ${pre.runsDeleted ? '已' : '未'}删 / tasks ${pre.tasksDeleted ? '已' : '未'}删）` : ''));
        // 〔S5b-fix·M6〕pre-clean 失败就**不许造数**。清不干净还往上叠，等于在一堆来路不明的
        //   残留上跑验证：computed 抽到的可能是上一轮的行，收尾的 0 残留也永远清不掉。
        if (pre.errs.length || pre.stage !== null) {
            throw new Error(`pre-clean 未走完（中止于 ${pre.stage || 'SQL 失败'}），按 M6 约定立即终止，不造数`);
        }
        // 〔S5b-fix3·26C-3〕措辞对齐**实际检查范围**：这条查的是"本轮待删 run 名下的子记录是否清空"，
        //   不是全库孤儿普查。原文案写成"孤儿 push（run 已不存在）"「库是干净的」，承诺了它没做的事。
        check(pre.remainingPushes === 0, 'pre-clean 后本轮待删 run 的子记录已清空（按留档 run id 核对）',
            `仍剩 ${pre.remainingPushes} 行 push（收集到 ${pre.runIdCount} 个 run id）`);
        // **硬门禁**：这批 run 名下还挂着 push，说明清理没能把子记录处理干净。继续造数会在这堆
        //   处理不掉的数据上叠新数据，收尾的 0 残留断言永远也回不到零。停下来交给人。
        if (pre.remainingPushes !== 0) {
            throw new Error(`pre-clean 后本轮待删 run 名下仍有 ${pre.remainingPushes} 行 push 清不掉，按 H3 硬门禁停止，不造数`);
        }
        // 全库孤儿基线（范围与上一条不同：这条才是"库里有没有指向空气的 push"）。
        //   非零不拦——那是既有历史问题，本脚本无权替它做主；只记基线，收尾比对不得增加。
        orphanBaseline = await globalOrphanPushes();
        console.log(`   全库孤儿 push 基线（NOT EXISTS 普查）= ${orphanBaseline}`
            + (orphanBaseline ? '（非本脚本产生，仅记录基线，收尾只要求不增加）' : ''));

        console.log('\n2. 环境基线断言（本编排定位=空表开发库验证工具）...');
        baseline = await snapshotCounts();
        console.log(`   基线：${fmtCounts(baseline)}`);
        const envOk = baseline.periodic_tasks === 0 && baseline.periodic_task_runs === 0;
        check(envOk, 'pre-clean 后 periodic_tasks / periodic_task_runs 均为空（空表前提成立）',
            envOk ? '' : `实际 ${fmtCounts(baseline)} —— **本编排定位=空表开发库验证工具**：`
                + '既有周期任务会顶掉列表首卡、改变 computed 抽到的徽章，收尾的"回到基线"也不再等价于"没留下脏数据"。'
                + '请换一个无周期任务的开发库，或先自行处理这些既有数据');
        if (!envOk) throw new Error('空表前提不成立，按 H2 约定停止（不造数）');

        console.log('\n3. 造数：2 个任务 + 5 条 run（覆盖 queued/running/success/failed/empty_result + disabled）...');
        await seed(token, adminUser, ids);
        console.log(`   任务 A=#${ids.taskA}（active·5 runs）／任务 B=#${ids.taskB}（disabled）／连接=${ids.connName}`);

        // 写读同源核对：我写的是 DB_PATH，页面读的是 server —— 两者若不是同一份库，
        //   下面 computed 会以 EMPTY_TABLE 静默跳过，而报告看着像"跑过了"。先用真实端点证一次。
        //   〔M6〕核对到**精确任务名 + 本轮 nonce**：只比 id 存在的话，一条上轮残留的同名任务
        //   也能让这条断言变绿，而它恰恰是本断言最该排除的干扰。
        const list = await api(token, 'GET', '/api/periodic-tasks', undefined);
        const items = (jparse(list.body).items) || [];
        const seenA = items.find((t) => t.id === ids.taskA);
        const seenB = items.find((t) => t.id === ids.taskB);
        const nameOk = seenA && seenA.task_name === TASK_A_NAME && seenB && seenB.task_name === TASK_B_NAME;
        const nonceOk = seenA && seenB && String(seenA.description || '').includes(NONCE) && String(seenB.description || '').includes(NONCE);
        check(list.status === 200 && !!seenA && !!seenB && nameOk && nonceOk,
            '两个任务经真实列表端点可见，且任务名精确匹配 + 携带本轮 nonce（证明写入的 db = server 读的 db，且不是上轮残留）',
            `status=${list.status} items=${items.length} A=${seenA ? 'Y' : 'N'} B=${seenB ? 'Y' : 'N'} `
            + `名字匹配=${nameOk ? 'Y' : 'N'} nonce(${NONCE})=${nonceOk ? 'Y' : 'N'}`);
        check(!!seenB && seenB.status === 'disabled', '任务 B 经真实端点确认为 disabled 态',
            seenB ? `实际 status=${seenB.status}` : '列表里找不到任务 B');
        check(items.length > 0 && items[0].id === ids.taskA,
            '任务 A 排列表第一（computed 的 openFn 只展开第一张卡，历史徽章只在它里面）',
            items.length ? `第一条实际是 #${items[0].id}（${items[0].task_name}）` : '列表为空');

        console.log('\n4. 跑 computed 全量（PF 数据存活期）...\n');
        const r1 = await runComputed();
        const s1 = parseComputed(r1.out);
        console.log(`\n   → 数据存活期：${s1.tail}`);
        check(r1.code === 0, 'computed 全量（数据存活期）退出码 0', `exit=${r1.code}`);
        check(s1.pfSkip === null, 'Periodic_Fetch 本轮不再 SKIP（数据依赖已补上）',
            s1.pfSkip ? `仍记 SKIP:${s1.pfSkip} —— 造的数没被页面读到` : '');
        check(s1.pfCovered !== null && s1.pfCovered === s1.pfRegistered,
            `Periodic_Fetch 修饰类全覆盖（${s1.pfCovered}/${s1.pfRegistered}）`,
            s1.pfCovered === null ? '输出里找不到 PF 的覆盖行' : `仅覆盖 ${s1.pfCovered}/${s1.pfRegistered}`);

        if (SKIP_CLEANUP) {
            console.log('\n5. ⚠️ --skip-cleanup：**故意跳过清理**（反向证明专用，用于证 0 残留断言会红）');
        } else {
            console.log('\n5. 清理 fixture（pushes → runs → tasks）...');
            const cl = await cleanupFixtures(ids);
            check(cl.errs.length === 0 && cl.stage === null, 'cleanup 五阶段全部走完（无中止）',
                cl.errs.join('；') + (cl.stage ? `｜中止于阶段 \`${cl.stage}\`` : ''));
            check(cl.remainingPushes === 0, `cleanup 删 runs 前核对本轮 run 子记录已清空（按留档的 ${cl.runIdCount} 个 run id）`,
                // remainingPushes===null 表示"没走到核对这一步"（前面阶段已中止），与"核对到 N 行"是两回事，
                //   报告里必须分得开：一个是没验，一个是验出来了。
                (cl.remainingPushes === null ? '未核对（阶段提前中止，见上一条）' : `核对到 ${cl.remainingPushes} 行 push 仍挂在这批 run 上`)
                + ' —— 已在删 runs/tasks 之前刹住（宁留标记数据可再清，不造孤儿）');
            // 〔S5b-fix3·26C-1〕两表分开报。阶段⑤失败时 runs 是**已经删了**的，
            //   笼统一句"父记录未删"会让人往错误方向收拾库。
            check(cl.runsDeleted === true && cl.tasksDeleted === true, 'cleanup 已删除 runs 与 tasks 两表',
                `runs ${cl.runsDeleted ? '已删' : '未删'} / tasks ${cl.tasksDeleted ? '已删' : '未删'}`
                + `（中止于阶段 \`${cl.stage}\`）—— 剩余数据仍带 ${FX} 标记，重跑本脚本可再清`);
        }

        console.log('\n6. 0 残留断言...');
        const { residual, tableCount } = await residualRows();
        check(residual.length === 0, `${tableCount} 张表 0 残留（本 fixture 标记面 + 留档 run id）`,
            residual.length ? residual.join('；') : '');

        // 〔S5b-fix·H2〕恢复判据 = **回到 pre-clean 时记录的基线**，不是硬编码的空表期望。
        //   两者当前恰好同值（空表前提已断言），但判据必须是"复原"而不是"变成某个我猜的样子"——
        //   哪天前提放宽了，硬编码那条会继续绿，而它已经不再证明任何事情。
        const after = await snapshotCounts();
        const restored = sameCounts(baseline, after);
        const orphanAfter = await globalOrphanPushes();
        if (SKIP_CLEANUP) {
            console.log(`   （--skip-cleanup 模式：跳过恢复核对；当前 ${fmtCounts(after)}·全库孤儿 push=${orphanAfter}）`);
        } else {
            check(restored, `库已恢复到 pre-clean 基线（${fmtCounts(baseline)}）`,
                restored ? '' : `实际 ${fmtCounts(after)}`);
            // 〔S5b-fix3·26C-3〕全库孤儿普查的收尾判据：**不得增加**。
            //   写成"必须为 0"就等于替既有历史数据下判决；写成"不得增加"才是本脚本真正负责的范围。
            check(orphanAfter === orphanBaseline, `全库孤儿 push 未增加（基线 ${orphanBaseline} → 收尾 ${orphanAfter}）`,
                `本脚本运行期间全库孤儿 push 从 ${orphanBaseline} 变成 ${orphanAfter} —— 删除顺序或范围出了问题`);

            console.log('\n7. 清理后再跑一次 computed（期望值由基线推导，不硬编码）...\n');
            const r2 = await runComputed();
            const s2 = parseComputed(r2.out);
            // 基线里 periodic_tasks=0 ⇒ PF 列表 0 行 ⇒ 合法 SKIP:EMPTY_TABLE；
            //   基线非空则不该 SKIP。期望值从基线推，判据才跟着前提走。
            const expectPfSkip = baseline.periodic_tasks === 0 ? 'EMPTY_TABLE' : null;
            console.log(`\n   → 清理后：${s2.tail}`);
            check(r2.code === 0, 'computed 全量（清理后）退出码 0', `exit=${r2.code}`);
            check(s2.pfSkip === expectPfSkip,
                `Periodic_Fetch 回到基线态（基线 periodic_tasks=${baseline.periodic_tasks} ⇒ 期望 ${expectPfSkip || '不 SKIP'}）`,
                `实际 pfSkip=${s2.pfSkip || '(无 SKIP)'}`);
        }
    } catch (e) {
        check(false, '编排执行未抛异常', e && e.message);
    } finally {
        // 〔S5b-fix·H1〕**无条件**兜底清理（非 --skip-cleanup 模式）。
        //   原来这里被 `seeded` 开关挡着：而"造数中途炸了"恰恰是最需要清理、也最可能没置上
        //   那个开关的一种情形。按前缀清是幂等的，什么都没建时它就是一条 no-op ——
        //   为了省一次 no-op 而给失败路径留个漏，划不来。
        //   --skip-cleanup 是**显式的反向证明意图**，这里同样尊重它，不偷偷补清。
        if (!SKIP_CLEANUP) {
            const finalRes = await cleanupFixtures(ids);
            // 〔S5b-fix2·H3〕兜底路径也要把**两件事**都报出来：errs（哪一步炸了）+ 子记录核对结果。
            //   只报其中一个，另一半就成了没人看见的静默状态——而兜底恰恰是主流程已经出事时才
            //   走到的分支，最不该在这里省话。
            // 〔S5b-fix3·26C-1〕两表**分开**报：阶段⑤失败时 runs 已删、tasks 未删，
            //   笼统一句"父记录未删"会把人引向错误的手工收拾方式。
            const parts = [];
            if (finalRes.errs.length) parts.push(`${finalRes.errs.length} 条 SQL 失败：${finalRes.errs.join('；')}`);
            if (finalRes.stage) {
                parts.push(`中止于阶段 \`${finalRes.stage}\`（runs ${finalRes.runsDeleted ? '已删' : '未删'} / tasks ${finalRes.tasksDeleted ? '已删' : '未删'}）`);
            }
            if (finalRes.remainingPushes !== 0) {
                parts.push((finalRes.remainingPushes === null ? '本轮 run 子记录未核对（阶段提前中止）' : `本轮 run 名下仍剩 ${finalRes.remainingPushes} 行 push`)
                    + `（留档 run id ${finalRes.runIdCount} 个）`);
            }
            if (parts.length) {
                console.error(`  [finally-cleanup] ${parts.join('｜')} —— 剩余数据仍带 ${FX} 标记，重跑本脚本可再清`);
            } else {
                console.log(`  [finally-cleanup] 兜底清理走完五阶段（runs 已删 / tasks 已删）·本轮 run 子记录已清空（留档 run id ${finalRes.runIdCount} 个）`);
            }
        }
        db.close();
    }

    console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：编排断言 ${pass} 项通过 / ${fail} 项失败 ===`);
    if (fail > 0) failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}${f.detail ? ' — ' + f.detail : ''}`));
    process.exit(fail === 0 ? 0 : 1);
})();
