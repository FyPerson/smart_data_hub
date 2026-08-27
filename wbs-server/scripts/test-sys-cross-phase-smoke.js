/**
 * test-sys-cross-phase-smoke.js — 跨阶段状态联动冒烟（方案 20260825_v1.3 契约 §6 460-M3·末次合并审必跑件）
 *
 * 背景：R（上线单管理体验优化，Phase R）的删除/编辑会改写 sys_issues.release_id、清执行人记录；
 *   P（「待我处理」全角色卡，Phase P）的两派生列 my_dev_pending/is_my_intake_liaison 与「待我处理」
 *   统计读的是同一批 issue（GET /sys-issues 同一张 SELECT，见 index.js buildSysIssuesListSelect）。
 *   两阶段各自的守卫/套件都已单独绿（P 侧 test-sys-my-pending-playwright.js、R 侧
 *   verify-sys-release-edit.js/verify-sys-release-delete.js/test-sys-release-mgmt-playwright.js）——
 *   但"各自通过"不等于"联动正确"：R 的写操作有没有意外波及 P 消费的字段/计数，从未有测试跨过这条
 *   阶段边界去验证。本脚本补这一环。
 *
 * ⚠️ 取舍声明（脚本头显式写明，非事后找补）：本脚本只做 **HTTP 行为级 + db 断言**（node 直连
 *   task_pool.db + 原生 fetch，不起 Playwright/浏览器）——前端「待我处理」卡片的派生渲染逻辑（点卡
 *   筛选/计数徽章/空态防困等）已由 test-sys-my-pending-playwright.js（MPPW- 套件）覆盖，本脚本的职责
 *   边界是**数据面**：GET /sys-issues 这张 SELECT 返回给前端消费的原始字段，在 R 的写操作前后是否
 *   如实、未被意外扰动——不重复验证前端怎么把这些字段渲染成卡片/筛选结果。
 *
 * ⭐ [Opus 预筛 2f7ed61 回卷·拦截-1 收口] fetchSnapshot **不再**按 status 过滤——早前版本查询串死写
 *   `?status=待上线`，导致凡进 map 的行 status 恒=「待上线」，用例 1d/1e、用例 2b 里"status 不变"的
 *   断言退化成同义反复（恒真，测不出任何真回归）。现改为拉全量按 id 过滤，**status 变回被验对象**——
 *   这也是支持下方"用例 1 含 1 张已作废夹具"（提示-2）的必要前提：已作废单不在「待上线」筛选范围内，
 *   status 过滤存在时该夹具会从 map 里直接消失，断言无从谈起。
 *
 * 用法：外部 server:3000 已起（本文件不自拉服务，同 test-sys-release-mgmt-playwright.js 头部契约）后：
 *   node scripts/test-sys-cross-phase-smoke.js
 *
 * ⚠️ 一次只跑一个写 db 的套件——本文件直连 task_pool.db 造夹具 + 写 sys_issues/sys_issue_dev_assignees/
 *   sys_releases/sys_release_audit，与其余 test-sys-*-playwright.js／test-sys-*-smoke.js 一样不支持并发
 *   跑多份实例。
 *
 * 数据隔离：全部造数标题/批次号恒 XPHS- 前缀（与 RELMG-/MPPW-/FLPW- 等既有前缀区分）。
 *
 * 覆盖：
 *   用例 1（R 删除 → P 数据面正确）：造 5 张「待上线」成员单（1 张 dev 在册 pending / 1 张挂
 *     intake_liaison / 2 张素单 / 1 张后续作废）→ 真实 API 建「计划中」批次挂全部 5 张成员 → 真实
 *     POST /sys-issues/:id/void 把第 5 张转「已作废」（同 test-sys-release-mgmt-playwright.js RELMG-
 *     ④组先例，void 不清 release_id，S11 既有事实）→ GET /sys-issues 基线快照（无 status 过滤，5 张
 *     全部可见，第 5 张此时已是「已作废」）→ 真实 DELETE /sys-releases/:id（reason 必填）→ 重新 GET
 *     /sys-issues 逐字段比对（my_dev_pending/is_my_intake_liaison/system_name 不变；4 张非作废成员
 *     release_id=NULL 且 status 回「待上线」；第 5 张 release_id=NULL 但 status **仍「已作废」**——
 *     D10：终态不因批次删除而位移，不再有已作废盲区）+ HTTP 层夹具计数与 db 直查计数一致 + db 直查
 *     release_id/status 两字段（按非作废/已作废两类分别断言）+ sys_release_audit 恰 1 条
 *     action='delete'（action 值域=CHECK (action IN ('edit','delete'))，index.js:1412；DELETE 端点写
 *     字面量 'delete'，index.js:16427，现场 grep 核实，非凭印象）+ DELETE 响应 member_count=5（474
 *     契约=批次总成员数，含已作废那张）+ 审计 member_issue_ids 含全部 5 张（S11 收口点验证：已作废
 *     成员不因分支化处置而漏记留痕）。
 *   用例 2（R 编辑 → P 数据面不受影响）：复用用例 1 里 4 张**非作废**成员单（已作废那张是不可恢复
 *     终态，status≠「待上线」，add-issues 端点会真实拒绝——不可复用，见 mkNonVoidedIds 处注释），
 *     真实 API 建第二个批次并重新挂全部 4 张成员 → 建批次2+加单两次真实写操作后**复检**夹具前提
 *     （my_dev_pending===1／is_my_intake_liaison===1 仍成立，防两次真实写操作悄悄改变了这两列，
 *     使下方 8 条比对退化成 0===0 空转）→ PATCH 编辑前快照（HTTP + db 直查双路）→ 真实
 *     PATCH /sys-releases/:id 只改 title（三道门契约：status='计划中'∧通知未发起∧提交值合法，均由
 *     本次调用天然满足，不复测门本身——门的正确性已由 verify-sys-release-edit.js 覆盖，本脚本只验
 *     "门通过后描述性字段编辑不得外溢到成员单数据面"这一跨阶段问题）→ 编辑后快照（HTTP + db 直查
 *     双路）→ 逐字段与编辑前快照完全一致 + db 直查 sys_release_audit 恰 1 条 action='edit'
 *     （index.js:16249，同上现场 grep 核实）。
 *
 * 若两用例任一真实翻红：可能是跨阶段真缺陷，脚本会保留现场（不清理已产生的数据）并以非 0 退出码
 * 停手报告，不自行改产品代码（同交付纪律）。⚠️ 保留的夹具会抬高 admin 角色『待我处理』基线（dev 在册
 * 行 + intake_liaison 均指向 ADMIN_ID），下次跑 test-sys-my-pending-playwright.js（MPPW-）①组的
 * admin 基线读数会受其影响（同 08-27 值班基线漂移一类的环境漂移面，非该套件自身回归）——排查完成、
 * 确认非本脚本引入的真缺陷后，应尽快手工清理本次保留的现场，恢复 MPPW- 的基线可比性。
 */
'use strict';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const net = require('net');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const TITLE_PREFIX = 'XPHS-';
const ADMIN_ID = 1;   // 同时充当「dev 在册人」「intake_liaison」两个身份的目标 uid——GET /sys-issues 的
                       // my_dev_pending/is_my_intake_liaison 两列是相对**调用者自身 uid** 计算的
                       // （index.js :8399-8408），用 admin 自己的 id 当夹具关联目标，可用同一枚 JWT
                       // 既满足 admin 专属端点（POST/PATCH/DELETE /sys-releases 均 requireAdmin），又让
                       // 这两个派生列对同一份 GET 响应天然非零，不必再造第二个真实用户身份。

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}
async function fetchJson(url, tok, opts = {}) {
    const r = await fetch(`${BASE_URL}${url}`, {
        method: opts.method || 'GET',
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let body = null; try { body = await r.json(); } catch (_) { /* ignore */ }
    return { status: r.status, body };
}

let pass = 0, fail = 0;
const failDetails = [];
function must(cond, msg) {
    if (cond) { console.log('  ✅ ' + msg); pass++; }
    else { console.log('  ❌ ' + msg); fail++; failDetails.push(msg); }
    return cond;
}

// ── server 编排探测（照抄 test-sys-release-mgmt-playwright.js：TCP 监听 + 应用层 readiness） ──────
function ensureServerListening(timeoutMs = 3000) {
    const u = new URL(BASE_URL);
    const host = u.hostname;
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ port, host });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error(`端口 ${host}:${port} 探测超时（${timeoutMs}ms）——server 未就绪或响应异常`)); }, timeoutMs);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.once('error', (e) => { clearTimeout(timer); reject(new Error(`端口 ${host}:${port} 未监听（${e.message}）——请先启动 node server.js 再跑本文件（本脚本不自起 server）`)); });
    });
}
async function ensureAppReadinessEndpoint() {
    const r = await fetch(`${BASE_URL}/api/sys-issues/_readiness`).catch((e) => {
        throw new Error(`应用 readiness 探测请求失败（${e.message}）——端口监听者可能不是目标 server.js`);
    });
    if (r.status !== 401) {
        throw new Error(`应用 readiness 探测异常：期望 401（authenticateToken 未登录，证明路由存在且是本模块），实得 ${r.status}——监听该端口的可能不是目标 server.js（孤儿进程/端口被其它服务占用）`);
    }
}

// ── 夹具：直连 SQL 造「待上线」成员单（同 test-sys-release-mgmt-playwright.js mkPendingIssue 范式，
//   补 intake_required=1——sys_issues.intake_required 列定义为 INTEGER NOT NULL DEFAULT 0
//   （index.js:13667 一带），trg_sys_issues_intake_gate_ins 触发器对非 1 值一律 RAISE(ABORT)，
//   本表没有"靠 DEFAULT 落 1"这回事，一切直连 SQL 造夹具必须显式补这一列）──────────────────────────
let seq = 0;
async function mkPendingIssue(titleTag, systemName, intakeLiaisonId) {
    seq++;
    const title = `${TITLE_PREFIX}${titleTag}-${seq}`;
    const r = await dbRun(
        `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required, intake_liaison_id)
         VALUES ('bug', '待上线', ?, ?, '内部', ?, '管理员', 1, ?)`,
        [title, systemName, ADMIN_ID, intakeLiaisonId == null ? null : intakeLiaisonId]
    );
    return { id: r.lastID, title, systemName };
}

// GET /sys-issues（⭐ 拦截-1：不再传 status 过滤，拉全量按 id 过滤）→ 只取本次夹具关心的 5 个字段
// （对齐方案要求：my_dev_pending/is_my_intake_liaison/system_name/release_id/status），构造 id→row
// 映射。status 现在是被验对象本身，不能再拿它当查询过滤条件——否则"status 恒等于过滤值"这条同义
// 反复会污染所有 status 相关断言。
// ⭐ [现场实测发现·非 P 侧缺陷] 首跑撞见：不传任何参数时，第 5 张已作废夹具单在响应里彻底缺席
// （map.size=4 非 5）——现场 grep 定位到 index.js:8776-8779，GET /sys-issues **默认过滤作废**
// （`status != '已作废'`），仅当 `include_voided=1` 且调用者是 admin∨受理人时才放行——这是
// 2026-08-17 用户拍板的既有产品行为（一般列表不该被死单据占位），不是本次 R/P 联动引入的回归。
// 本函数用 admin token 调用，补 `include_voided=1` 参数即可让已作废夹具与其余夹具同等可见，
// 与"status 变回被验对象"的本意一致（选择性隐藏 vs 数据本身错误是两回事，此处要的是后者）。
// [S12-预筛自查] 该 5 字段的数值型两列（my_dev_pending/is_my_intake_liaison）经 sqlite3 CASE/EXISTS
// 投影，Node 侧驱动会原样返回 JS number（0/1），用 Number(...) 强转仅作防御性归一，不改变语义。
async function fetchSnapshot(tok, ids) {
    const r = await fetchJson('/api/sys-issues?' + new URLSearchParams({ include_voided: '1' }).toString(), tok);
    if (r.status !== 200) throw new Error(`GET /sys-issues 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const items = (r.body && r.body.items) || [];
    const idSet = new Set(ids.map(Number));
    const map = new Map();
    for (const it of items) {
        if (!idSet.has(Number(it.id))) continue;
        map.set(Number(it.id), {
            my_dev_pending: Number(it.my_dev_pending),
            is_my_intake_liaison: Number(it.is_my_intake_liaison),
            system_name: it.system_name,
            release_id: it.release_id == null ? null : Number(it.release_id),
            status: it.status,
        });
    }
    return { map, httpMatchedCount: map.size, rawItemsTotal: items.length };
}

async function main() {
    await ensureServerListening();
    console.log('  ✅ 端口 Listen 探测通过（server 已就绪）');
    await ensureAppReadinessEndpoint();
    console.log('  ✅ 应用 readiness 端点探测通过（确认监听者是目标 server.js，非孤儿/误占用进程）');

    const adminTok = await signAs(ADMIN_ID);
    const createdIssueIds = [];
    let release1Id = null, release1No = null;
    let release2Id = null, release2No = null;
    let devAssigneeRowId = null;
    let keepFixturesOnFailure = false;

    try {
        console.log('\n══════ 跨阶段状态联动冒烟（R 删除/编辑 × P 派生列，XPHS-）══════');

        // ── 夹具：5 张「待上线」成员单——1 张 dev 在册 pending / 1 张挂 intake_liaison / 2 张素单 /
        //   1 张后续会走真实 void 端点转已作废（提示-2 采纳） ──────────────────────────────────────
        const issueDevPending = await mkPendingIssue('dev-pending', 'BMS');
        createdIssueIds.push(issueDevPending.id);
        const issueIntakeLiaison = await mkPendingIssue('intake-liaison', 'HRD', ADMIN_ID);
        createdIssueIds.push(issueIntakeLiaison.id);
        const issuePlain1 = await mkPendingIssue('plain', '电子签');
        createdIssueIds.push(issuePlain1.id);
        const issuePlain2 = await mkPendingIssue('plain', '其他');
        createdIssueIds.push(issuePlain2.id);
        const issueVoided = await mkPendingIssue('voided', 'RPA程序');
        createdIssueIds.push(issueVoided.id);
        // nonVoidedIds＝用例 1 的 4 张非作废成员（这 4 张贯穿全程保持「待上线」态，也是用例 2 唯一可
        //   复用的集合——已作废是不可恢复终态，status≠「待上线」，add-issues 端点会在 WHERE 子句上真实
        //   拒绝它（index.js :15856-15857：`status='待上线' AND release_id IS NULL`），复用会撞 409，
        //   不是本脚本要测的东西，故用例 2 建批次时只挂 nonVoidedIds。
        const nonVoidedIds = [issueDevPending.id, issueIntakeLiaison.id, issuePlain1.id, issuePlain2.id];
        const allIds = [...nonVoidedIds, issueVoided.id];   // 5 张，用例 1 专用（含已作废那张）

        // dev 在册行——直连 SQL（无"已待上线单反向指派开发"的正常业务入口，同 RELMG- 对 sys_issues.status
        // 直写的既有取舍：这是**前置关联夹具**，非本脚本要验证的动作本身；R 的 DELETE/PATCH 才是真实
        // API 调用对象）。dev_status 列 DEFAULT 'pending'（index.js:1609），显式写出不依赖默认值。
        const devRow = await dbRun(
            `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, dev_status)
             VALUES (?, ?, '管理员', 'pending')`,
            [issueDevPending.id, ADMIN_ID]
        );
        devAssigneeRowId = devRow.lastID;
        console.log(`  （夹具：5 张成员单已建 [dev-pending #${issueDevPending.id} / intake-liaison #${issueIntakeLiaison.id} / plain #${issuePlain1.id},#${issuePlain2.id} / voided #${issueVoided.id}]，dev 在册行 #${devAssigneeRowId}）`);

        // ═══════════════════════════════════════════════════════════════
        // 用例 1：R 删除 → P 数据面正确
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── 用例1a：真实 API 建「计划中」批次挂全部 5 张成员，第 5 张真实 void 转已作废 ──');
        const create1R = await fetchJson('/api/sys-releases', adminTok, {
            method: 'POST', body: { title: `${TITLE_PREFIX}batch1-${Date.now()}`, release_no: `XPHS-REL1-${Date.now()}` },
        });
        if (create1R.status !== 201) throw new Error(`[夹具-建批次1] 应 201，实得 ${create1R.status} ${JSON.stringify(create1R.body)}`);
        release1Id = create1R.body.id; release1No = create1R.body.release_no;
        const add1R = await fetchJson(`/api/sys-releases/${release1Id}/add-issues`, adminTok, { method: 'POST', body: { issue_ids: allIds } });
        if (add1R.status !== 200 || !add1R.body || add1R.body.count !== allIds.length) throw new Error(`[夹具-加单] 应 200 且 count=${allIds.length}，实得 ${add1R.status} ${JSON.stringify(add1R.body)}`);
        console.log(`  （批次1 #${release1Id} / ${release1No} 已建，${allIds.length} 张成员已挂）`);
        keepFixturesOnFailure = true;   // 真实数据已产生，此后任一断言翻红都要保留现场（不清理）

        // 提示-2：第 5 张走真实 POST /sys-issues/:id/void（同 RELMG- ④组先例）——void 是"任意态→已作废"
        //   的终态转移且不清 release_id（S11 既有事实），转态后仍挂在本批次名下，构成 O4 §3 步骤③要
        //   处理的"已作废但仍挂批次"前置形态，本脚本借它验证 P 侧派生列对这类终态成员是否也如实透传。
        const voidR = await fetchJson(`/api/sys-issues/${issueVoided.id}/void`, adminTok, { method: 'POST', body: { reason: 'XPHS-跨阶段冒烟-用例1作废夹具' } });
        if (voidR.status !== 200) throw new Error(`[夹具-作废] 应 200，实得 ${voidR.status} ${JSON.stringify(voidR.body)}`);
        console.log(`  （第 5 张 #${issueVoided.id} 已真实 void 转「已作废」，release_id 仍挂 #${release1Id}）`);

        console.log('\n── 用例1b：GET /sys-issues 基线快照（无 status 过滤，5 张全可见）──');
        const baseline = await fetchSnapshot(adminTok, allIds);
        must(baseline.map.size === allIds.length, `基线快照应覆盖全部 ${allIds.length} 张夹具单，实得 ${baseline.map.size}`);
        // 正向前提断言（防"层内全绿"）：夹具设计意图是让两派生列产出非零值——若这里断言不过，后面
        // "删除后与基线一致"的比对会退化成"0===0"式空转比对，测不出真实联动缺陷。
        const bDev = baseline.map.get(issueDevPending.id);
        const bLiaison = baseline.map.get(issueIntakeLiaison.id);
        must(bDev && bDev.my_dev_pending === 1, `[夹具前提] #${issueDevPending.id} 基线 my_dev_pending 应=1（dev 在册 pending 生效），实得 ${bDev && bDev.my_dev_pending}`);
        must(bLiaison && bLiaison.is_my_intake_liaison === 1, `[夹具前提] #${issueIntakeLiaison.id} 基线 is_my_intake_liaison 应=1（intake_liaison_id 生效），实得 ${bLiaison && bLiaison.is_my_intake_liaison}`);
        must(bDev && bDev.is_my_intake_liaison === 0, `[夹具前提] #${issueDevPending.id} 基线 is_my_intake_liaison 应=0（未挂 intake_liaison，交叉验证两列相互独立）`);
        must(bLiaison && bLiaison.my_dev_pending === 0, `[夹具前提] #${issueIntakeLiaison.id} 基线 my_dev_pending 应=0（未在册 dev，交叉验证两列相互独立）`);
        for (const id of nonVoidedIds) {
            const row = baseline.map.get(id);
            must(row && row.release_id === release1Id, `[夹具前提] #${id} 基线 release_id 应=批次1 #${release1Id}，实得 ${row && row.release_id}`);
            must(row && row.status === '待上线', `[夹具前提] #${id} 基线 status 应仍「待上线」（加单不改 status），实得 ${row && row.status}`);
        }
        const bVoided = baseline.map.get(issueVoided.id);
        must(bVoided && bVoided.release_id === release1Id, `[夹具前提] #${issueVoided.id}（已作废）基线 release_id 应仍=批次1 #${release1Id}（void 不清指针，S11 既有事实），实得 ${bVoided && bVoided.release_id}`);
        must(bVoided && bVoided.status === '已作废', `[夹具前提] #${issueVoided.id} 基线 status 应=「已作废」（真实 void 端点转态生效），实得 ${bVoided && bVoided.status}`);

        console.log('\n── 用例1c：执行 R 的 DELETE /sys-releases/:id ──');
        const del1R = await fetchJson(`/api/sys-releases/${release1Id}`, adminTok, { method: 'DELETE', body: { reason: 'XPHS-跨阶段冒烟-用例1删除' } });
        must(del1R.status === 200 && del1R.body && del1R.body.ok === true && del1R.body.member_count === allIds.length, `DELETE 应 200 且 {ok:true,member_count:${allIds.length}}（474 契约=批次总成员数，含已作废那张），实得 ${del1R.status} ${JSON.stringify(del1R.body)}`);

        console.log('\n── 用例1d：重新 GET /sys-issues，逐字段比对基线 ──');
        const afterDelete = await fetchSnapshot(adminTok, allIds);
        must(afterDelete.map.size === allIds.length, `删除后快照应仍覆盖全部 ${allIds.length} 张夹具单，实得 ${afterDelete.map.size}`);
        for (const id of allIds) {
            const b = baseline.map.get(id);
            const a = afterDelete.map.get(id);
            must(a && b && a.my_dev_pending === b.my_dev_pending, `#${id} my_dev_pending 删除前后应一致（身份谓词不受批次删除影响），删除前=${b && b.my_dev_pending} 删除后=${a && a.my_dev_pending}`);
            must(a && b && a.is_my_intake_liaison === b.is_my_intake_liaison, `#${id} is_my_intake_liaison 删除前后应一致，删除前=${b && b.is_my_intake_liaison} 删除后=${a && a.is_my_intake_liaison}`);
            must(a && b && a.system_name === b.system_name, `#${id} system_name 删除前后应一致，删除前=${b && b.system_name} 删除后=${a && a.system_name}`);
            must(a && a.release_id === null, `#${id} 删除后 release_id 应=NULL（D10：退回「待上线」/清指针），实得 ${a && a.release_id}`);
            const expectedStatus = (id === issueVoided.id) ? '已作废' : '待上线';
            const statusNote = (id === issueVoided.id) ? '（D10：已作废是不可恢复终态，不因批次删除而位移，不得误判为退回待上线——提示-2 收口的正是这条）' : '';
            must(a && a.status === expectedStatus, `#${id} 删除后 status 应仍「${expectedStatus}」${statusNote}，实得 ${a && a.status}`);
        }
        // 统计一致性（HTTP 层等价面）：HTTP 响应里匹配到的夹具单计数，应与 db 直查同条件（按 id，不再
        //   按 status——status 已是被验对象，见拦截-1）计数一致。
        const dbCount1 = await dbGet(`SELECT COUNT(*) c FROM sys_issues WHERE id IN (${allIds.map(() => '?').join(',')})`, allIds);
        must(afterDelete.httpMatchedCount === (dbCount1 ? dbCount1.c : -1) && afterDelete.httpMatchedCount === allIds.length, `HTTP 响应匹配的夹具单计数（${afterDelete.httpMatchedCount}）应与 db 直查计数（${dbCount1 && dbCount1.c}）一致，且均=${allIds.length}`);

        console.log('\n── 用例1e：db 直查复核（release_id/status 两字段·分非作废/已作废两类 + sys_release_audit 恰 1 条 delete + member_issue_ids 含全部 5 张）──');
        const dbRows1 = await dbAll(`SELECT id, release_id, status FROM sys_issues WHERE id IN (${allIds.map(() => '?').join(',')})`, allIds);
        const badNonVoided1 = dbRows1.filter(r => nonVoidedIds.includes(r.id) && (r.release_id !== null || r.status !== '待上线'));
        must(dbRows1.length === allIds.length && badNonVoided1.length === 0, `db 直查 ${nonVoidedIds.length} 张非作废成员单应 release_id=NULL 且 status=「待上线」，异常 ${badNonVoided1.length} 张：${JSON.stringify(badNonVoided1)}`);
        const voidedRow1 = dbRows1.find(r => r.id === issueVoided.id);
        must(voidedRow1 && voidedRow1.release_id === null && voidedRow1.status === '已作废', `db 直查已作废成员单 #${issueVoided.id} 应 release_id=NULL 且 status 仍「已作废」（终态不位移），实得 ${JSON.stringify(voidedRow1)}`);
        const auditCount1Row = await dbGet(`SELECT COUNT(*) c FROM sys_release_audit WHERE release_no=? AND action='delete'`, [release1No]);
        must(auditCount1Row && auditCount1Row.c === 1, `sys_release_audit 应恰 1 条 release_no=${release1No} 的 action='delete'，实得 ${auditCount1Row && auditCount1Row.c}`);
        const auditRow1 = await dbGet(`SELECT member_count, member_issue_ids FROM sys_release_audit WHERE release_no=? AND action='delete'`, [release1No]);
        let auditMemberIds1 = [];
        try { auditMemberIds1 = JSON.parse((auditRow1 && auditRow1.member_issue_ids) || '[]').map(Number); } catch (e) { /* 解析失败保持空数组，下方断言据此判红 */ }
        const auditMemberIdSet1 = new Set(auditMemberIds1);
        const expectedIdSet1 = new Set(allIds);
        const auditIdsMatch = auditMemberIdSet1.size === expectedIdSet1.size && [...expectedIdSet1].every((id) => auditMemberIdSet1.has(id));
        must(auditIdsMatch, `sys_release_audit.member_issue_ids 应恰含全部 ${allIds.length} 张成员（含已作废那张，S11 收口点验证——已作废成员不因分支化处置而漏记留痕），实得 ${JSON.stringify([...auditMemberIdSet1])}`);
        // ⭐ [codex 476 真轮·MED 采纳] 审计行自身校验——DDL 新增 CHECK (member_count = json_array_length
        //   (member_issue_ids)) 已在 DB 层堵住结构性不一致，此处从 db 直查角度独立复核同一条不变量
        //   （两层防线：DB 约束保证"写不进去坏数据"，本处应用层测试保证"这条真实业务写入的数据确实一致"，
        //   两者验证的是同一件事的不同层面，不是重复）。DELETE 端点用例1的语义=批次总成员数（含已作废
        //   那张，474 契约），故期望恰=allIds.length（5）。
        must(auditRow1 && auditRow1.member_count === auditMemberIds1.length && auditMemberIds1.length === allIds.length,
            `审计行自身一致性：member_count（${auditRow1 && auditRow1.member_count}）应恰=JSON.parse(member_issue_ids).length（${auditMemberIds1.length}）应恰=预期成员数 ${allIds.length}（DELETE 端点=批次总成员数，含已作废）`);

        // ═══════════════════════════════════════════════════════════════
        // 用例 2：R 编辑 → P 数据面不受影响
        // ═══════════════════════════════════════════════════════════════
        console.log('\n── 用例2a：复用 4 张非作废成员单，真实 API 建批次2 并重新挂全部成员 ──');
        const create2R = await fetchJson('/api/sys-releases', adminTok, {
            method: 'POST', body: { title: `${TITLE_PREFIX}batch2-${Date.now()}`, release_no: `XPHS-REL2-${Date.now()}` },
        });
        if (create2R.status !== 201) throw new Error(`[夹具-建批次2] 应 201，实得 ${create2R.status} ${JSON.stringify(create2R.body)}`);
        release2Id = create2R.body.id; release2No = create2R.body.release_no;
        const add2R = await fetchJson(`/api/sys-releases/${release2Id}/add-issues`, adminTok, { method: 'POST', body: { issue_ids: nonVoidedIds } });
        if (add2R.status !== 200 || !add2R.body || add2R.body.count !== nonVoidedIds.length) throw new Error(`[夹具-加单2] 应 200 且 count=${nonVoidedIds.length}，实得 ${add2R.status} ${JSON.stringify(add2R.body)}`);
        console.log(`  （批次2 #${release2Id} / ${release2No} 已建，${nonVoidedIds.length} 张非作废成员已重新挂上）`);

        const beforeEdit = await fetchSnapshot(adminTok, nonVoidedIds);
        must(beforeEdit.map.size === nonVoidedIds.length, `编辑前快照应覆盖全部 ${nonVoidedIds.length} 张夹具单，实得 ${beforeEdit.map.size}`);
        // 拦截-2：建批次2 + 加单两次真实写操作之后，两派生列前提须复证——不能想当然沿用用例 1 的旧观测，
        //   否则下方"编辑前后一致"的 8 条比对可能已经悄悄退化成 0===0（若两次写操作意外清零了这两列）。
        const beforeEditDev = beforeEdit.map.get(issueDevPending.id);
        const beforeEditLiaison = beforeEdit.map.get(issueIntakeLiaison.id);
        must(beforeEditDev && beforeEditDev.my_dev_pending === 1, `[夹具前提复检] #${issueDevPending.id} 建批次2+加单两次真实写操作后 my_dev_pending 应仍=1，实得 ${beforeEditDev && beforeEditDev.my_dev_pending}`);
        must(beforeEditLiaison && beforeEditLiaison.is_my_intake_liaison === 1, `[夹具前提复检] #${issueIntakeLiaison.id} 建批次2+加单两次真实写操作后 is_my_intake_liaison 应仍=1，实得 ${beforeEditLiaison && beforeEditLiaison.is_my_intake_liaison}`);

        // 拦截-1b：db 直查双路——与上方 HTTP 快照独立观测，防"GET /sys-issues 端点自身的显示层问题"与
        //   "真实数据问题"互相掩盖（同 verify_tool_output_before_conclusion 既有纪律：显示对不等于数据对）。
        const beforeEditDb = await dbAll(`SELECT id, release_id, status FROM sys_issues WHERE id IN (${nonVoidedIds.map(() => '?').join(',')})`, nonVoidedIds);

        // 三道门契约天然满足：status='计划中'（刚建）∧ 通知未发起（从未调用 PUT executors）∧ 提交值合法
        //（title 长度远低于 SYS_RELEASE_TITLE_MAX=200）——门本身的正确性已由 verify-sys-release-edit.js
        //   逐条覆盖，本脚本不复测，只借一次会真实通过三道门的合法 PATCH 调用去验证跨阶段外溢面。
        const patchR = await fetchJson(`/api/sys-releases/${release2Id}`, adminTok, { method: 'PATCH', body: { title: `${TITLE_PREFIX}batch2-edited-${Date.now()}` } });
        must(patchR.status === 200 && patchR.body && patchR.body.changed === true, `PATCH 改 title 应 200 且 changed=true，实得 ${patchR.status} ${JSON.stringify(patchR.body)}`);

        console.log('\n── 用例2b：GET /sys-issues + db 直查双路，逐字段比对编辑前快照（应完全一致）──');
        const afterEdit = await fetchSnapshot(adminTok, nonVoidedIds);
        must(afterEdit.map.size === nonVoidedIds.length, `编辑后快照应仍覆盖全部 ${nonVoidedIds.length} 张夹具单，实得 ${afterEdit.map.size}`);
        for (const id of nonVoidedIds) {
            const b = beforeEdit.map.get(id);
            const a = afterEdit.map.get(id);
            must(a && b && a.my_dev_pending === b.my_dev_pending, `#${id} my_dev_pending 编辑前后应一致，编辑前=${b && b.my_dev_pending} 编辑后=${a && a.my_dev_pending}`);
            must(a && b && a.is_my_intake_liaison === b.is_my_intake_liaison, `#${id} is_my_intake_liaison 编辑前后应一致，编辑前=${b && b.is_my_intake_liaison} 编辑后=${a && a.is_my_intake_liaison}`);
            must(a && b && a.system_name === b.system_name, `#${id} system_name 编辑前后应一致，编辑前=${b && b.system_name} 编辑后=${a && a.system_name}`);
            must(a && b && a.release_id === b.release_id && a.release_id === release2Id, `#${id} release_id 编辑前后应一致且仍=批次2 #${release2Id}（描述性字段编辑不改成员归属），编辑前=${b && b.release_id} 编辑后=${a && a.release_id}`);
            must(a && b && a.status === b.status && a.status === '待上线', `#${id} status 编辑前后应一致且仍「待上线」，编辑前=${b && b.status} 编辑后=${a && a.status}`);
        }
        // 拦截-1b（续）：db 直查复核——编辑后 release_id/status 逐张与编辑前 db 快照完全一致（与上方
        //   HTTP 层比对同构，独立观测路径）。
        const afterEditDb = await dbAll(`SELECT id, release_id, status FROM sys_issues WHERE id IN (${nonVoidedIds.map(() => '?').join(',')})`, nonVoidedIds);
        const beforeEditDbMap = new Map(beforeEditDb.map((r) => [r.id, r]));
        const afterEditDbMap = new Map(afterEditDb.map((r) => [r.id, r]));
        const dbMismatch2 = nonVoidedIds.filter((id) => {
            const bRow = beforeEditDbMap.get(id), aRow = afterEditDbMap.get(id);
            return !bRow || !aRow || bRow.release_id !== aRow.release_id || bRow.status !== aRow.status;
        });
        must(beforeEditDb.length === nonVoidedIds.length && afterEditDb.length === nonVoidedIds.length && dbMismatch2.length === 0, `db 直查（独立于 HTTP 层）：全部 ${nonVoidedIds.length} 张成员单编辑前后 release_id/status 应逐张一致，异常 ${dbMismatch2.length} 张：${JSON.stringify(dbMismatch2)}（编辑前=${JSON.stringify(beforeEditDb)} 编辑后=${JSON.stringify(afterEditDb)}）`);

        console.log('\n── 用例2c：db 直查复核 sys_release_audit 恰 1 条 edit + 审计行自身一致性 ──');
        const auditCount2Row = await dbGet(`SELECT COUNT(*) c FROM sys_release_audit WHERE release_no=? AND action='edit'`, [release2No]);
        must(auditCount2Row && auditCount2Row.c === 1, `sys_release_audit 应恰 1 条 release_no=${release2No} 的 action='edit'，实得 ${auditCount2Row && auditCount2Row.c}`);
        // ⭐ [codex 476 真轮·MED 采纳] 审计行自身校验（同用例1e）。edit 审计的 member_count 语义现场
        //   grep 核实（index.js:16253-16256 PATCH 端点）：memberIds 来自事务内 `SELECT id FROM sys_issues
        //   WHERE release_id=?`——即 PATCH 当下批次的**当前挂靠成员数**，与 DELETE 端点"批次总成员数"
        //   同源写法但独立计算（各自事务内各查一次），非同一批常量。批次2 只挂了 nonVoidedIds（4 张，
        //   已作废那张因 add-issues 会拒绝而未重新挂上，见用例2a 处注释），故期望恰=4，非 allIds.length。
        const auditRow2 = await dbGet(`SELECT member_count, member_issue_ids FROM sys_release_audit WHERE release_no=? AND action='edit'`, [release2No]);
        let auditMemberIds2 = [];
        try { auditMemberIds2 = JSON.parse((auditRow2 && auditRow2.member_issue_ids) || '[]').map(Number); } catch (e) { /* 解析失败保持空数组，下方断言据此判红 */ }
        const auditMemberIdSet2 = new Set(auditMemberIds2);
        const expectedIdSet2 = new Set(nonVoidedIds);
        const auditIdsMatch2 = auditMemberIdSet2.size === expectedIdSet2.size && [...expectedIdSet2].every((id) => auditMemberIdSet2.has(id));
        must(auditIdsMatch2, `sys_release_audit（edit）.member_issue_ids 应恰含批次2 当前挂靠的 ${nonVoidedIds.length} 张成员，实得 ${JSON.stringify([...auditMemberIdSet2])}`);
        must(auditRow2 && auditRow2.member_count === auditMemberIds2.length && auditMemberIds2.length === nonVoidedIds.length,
            `审计行自身一致性：member_count（${auditRow2 && auditRow2.member_count}）应恰=JSON.parse(member_issue_ids).length（${auditMemberIds2.length}）应恰=预期成员数 ${nonVoidedIds.length}（PATCH 端点=批次当前挂靠成员数，index.js:16253-16256）`);

        console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
    } catch (e) {
        console.error('实测脚本异常:', e && e.stack || e);
        fail++;
        failDetails.push('顶层异常: ' + (e && e.message || e));
    } finally {
        if (fail > 0 && keepFixturesOnFailure) {
            console.log(`\n  ⚠️ 检测到 ${fail} 项失败——按交付纪律保留现场，跳过清理（夹具单 ID：${JSON.stringify(createdIssueIds)}；批次：#${release1Id}(${release1No})/#${release2Id}(${release2No})），不自行改产品代码，人工排查后手工清理。保留的夹具会抬高 admin 角色『待我处理』基线（dev 在册行 + intake_liaison 均指向 ADMIN_ID），下次跑 test-sys-my-pending-playwright.js（MPPW-）①组的 admin 基线读数会受其影响，排查完成后应尽快手工清理。`);
            db.close();
            console.log(`\n=== FAIL：${pass} 项通过 / ${fail} 项失败（现场已保留） ===`);
            failDetails.forEach(m => console.log('  - ' + m));
            process.exit(1);
        }
        let cleanupErrorCount = 0;
        const CHILD_TABLES = ['sys_issue_dev_commits', 'sys_fast_release_executors', 'sys_issue_timeline', 'sys_issue_dev_events', 'sys_issue_dev_assignees'];
        const RESIDUAL_CHECK_TABLES = [...CHILD_TABLES, 'sys_issue_attachments', 'sys_issue_release_commit_snapshots', 'sys_issue_delete_audit'];
        for (const id of createdIssueIds) {
            try {
                for (const t of CHILD_TABLES) await dbRun(`DELETE FROM ${t} WHERE issue_id=?`, [id]);
                await dbRun('DELETE FROM sys_issues WHERE id=?', [id]);
            } catch (e) { cleanupErrorCount++; console.warn(`夹具清理失败 issue #${id}: ${e.message}`); }
        }
        // 批次兜底清理——批次1 正常路径下已被用例1c 的真实 DELETE 端点删除，批次2 从未被删除端点碰过
        // （用例2 只测 PATCH），两者在此统一兜底 delete，不因"哪个已经删过"而分叉写两套清理逻辑。
        for (const relId of [release1Id, release2Id]) {
            if (!relId) continue;
            try {
                await dbRun('DELETE FROM sys_release_executors WHERE release_id=?', [relId]);
                await dbRun('DELETE FROM sys_issue_release_commit_snapshots WHERE release_id=?', [relId]);
                await dbRun('DELETE FROM sys_releases WHERE id=?', [relId]);
            } catch (e) { cleanupErrorCount++; console.warn(`批次兜底清理失败 #${relId}: ${e.message}`); }
        }
        // ⭐ 拦截-5：release_no 精确清（IN (?,?)），不用 LIKE 'XPHS-%' 通配——通配会连带抹掉"上一次失败
        //   运行按交付纪律保留下来的现场"，与上方 keepFixturesOnFailure 的保留意图自相矛盾（同 RELMG-
        //   :455/:475 一带的精确清范式对齐，非本脚本自创写法）。
        const xphsReleaseNos = [release1No, release2No].filter(Boolean);
        if (xphsReleaseNos.length) {
            try { await dbRun(`DELETE FROM sys_release_audit WHERE release_no IN (${xphsReleaseNos.map(() => '?').join(',')})`, xphsReleaseNos); }
            catch (e) { cleanupErrorCount++; console.warn(`sys_release_audit 清理失败: ${e.message}`); }
        }

        const idList = createdIssueIds.length ? createdIssueIds : [-1];
        const placeholders = idList.map(() => '?').join(',');
        let totalResidual = 0;
        const residualDetail = {};
        for (const t of [...RESIDUAL_CHECK_TABLES, 'sys_issues']) {
            const col = t === 'sys_issues' ? 'id' : 'issue_id';
            const r = await dbGet(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IN (${placeholders})`, idList);
            const c = r ? r.c : 0;
            residualDetail[t] = c;
            totalResidual += c;
        }
        const relIdList = [release1Id, release2Id].filter(Boolean);
        if (relIdList.length) {
            const relResidual = await dbGet(`SELECT COUNT(*) c FROM sys_releases WHERE id IN (${relIdList.map(() => '?').join(',')})`, relIdList);
            residualDetail.sys_releases = (relResidual && relResidual.c) || 0;
            totalResidual += residualDetail.sys_releases;
        }
        // ⭐ 拦截-5（续）：残留检查同步改精确匹配（release_no IN (?,?)），不再用 LIKE 通配——理由同上，
        //   通配式残留检查同样会把"保留现场"误判为残留污染。
        let auditResidualCount = 0;
        if (xphsReleaseNos.length) {
            const auditResidual = await dbGet(`SELECT COUNT(*) c FROM sys_release_audit WHERE release_no IN (${xphsReleaseNos.map(() => '?').join(',')})`, xphsReleaseNos);
            auditResidualCount = (auditResidual && auditResidual.c) || 0;
        }
        residualDetail.sys_release_audit = auditResidualCount;
        totalResidual += auditResidualCount;

        console.log(`  🧹 夹具清理完成（成员单 ${createdIssueIds.length} 条 + 批次 #${release1Id}/#${release2Id}，清理异常 ${cleanupErrorCount} 次，逐表残留=${JSON.stringify(residualDetail)}，合计残留 ${totalResidual} 行，均应为 0）`);
        if (cleanupErrorCount > 0 || totalResidual > 0) {
            fail++;
            failDetails.push(`夹具清理不干净：清理异常 ${cleanupErrorCount} 次 / 逐表残留 ${JSON.stringify(residualDetail)}（合计 ${totalResidual} 行）——本地库已被本次测试运行污染，需人工核实`);
        }
        db.close();
        console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (fail > 0) { console.log('失败清单：'); failDetails.forEach(m => console.log('  - ' + m)); process.exit(1); }
    }
}

main().catch((e) => { console.error('顶层异常:', e && e.stack || e); process.exit(1); });
