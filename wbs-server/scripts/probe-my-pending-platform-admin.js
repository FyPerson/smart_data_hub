/**
 * probe-my-pending-platform-admin.js
 *
 * 「待我处理」归属收紧（2026-08-27 用户拍板）的**活体验证**——沙箱真执行断言证的是谓词本身，
 * 本探针证的是**页面渲染面**：一个 role='admin' 但用户名不在 SI_PLATFORM_ADMIN_USERNAMES 里的
 * 账号（生产实例＝示例用户B/示例客服A/示例客服B/示例客服C/示例管理员A），打开系统迭代页时「待我处理」卡里不再混入
 * 与他无关的待指派/待验证/待归档单。
 *
 * 用法：外部 server:3000 已起后 —— node scripts/probe-my-pending-platform-admin.js
 *
 * 为什么必须有这一层（feedback_layer_green_not_feature_ready）：谓词绿 ≠ 卡片渲染对。卡的数字
 * 来自 siRenderStats 里对 vis 的 filter，中间还隔着列表加载/可见性过滤/统计卡装配三段，任何一段
 * 把 admin 身份另行兜底都会让收紧在页面上失效，而沙箱断言看不见那三段。
 *
 * 双向证明（feedback_probe_test_bidirectional_proof）：
 *   ① 正向——平台管理员 admin 打开页面，卡里**含**这张造出来的待指派单（证探针夹具真的可被看见，
 *      不是因为单子不存在才"看不到"）
 *   ② 反向——非平台管理员（临时造的 role=admin 账号）打开页面，卡里**不含**该单
 *   两条缺一不可：只跑②会把"夹具没造成功/页面没加载出来"误判成"收紧生效"。
 *
 * 夹具纪律：临时用户与临时单据均带固定前缀，finally 里按 id 精确删除（非前缀通配——通配会抹掉
 * 上一次失败保留的现场，见 codex 475 预筛⑤同款订正）。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

// [codex 478 LOW-1 收口] 平台管理员**按 username 解析**，不硬编码 id。
//   被测逻辑（siIsPlatformAdmin）只以用户名白名单判定，探针若硬编码 id=1 是"平台管理员"，一旦部署
//   环境里 id=1 不是 admin，正向用例会在错账号上造夹具并给出误报。白名单值与前端常量保持一致；
//   下方启动时会断言解析到的账号 role='admin' 且 status 可用，不一致直接 fail 并提示环境配置问题。
const PLATFORM_ADMIN_USERNAME = 'admin';
const PROBE_USERNAME = 'probe_bizadmin_tmp';        // 临时账号：role=admin 但不在白名单
const PROBE_TITLE = 'PMPA-探针-待指派单-勿动';
const OWN_TITLE   = 'PMPA-探针-临时账号自有待修改单-勿动';
const OWN_VERIFY_TITLE = 'PMPA-探针-临时账号自有待验证单-勿动';

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

let pass = 0, fail = 0;
const failMsgs = [];
function must(cond, msg) {
    if (cond) { console.log('  ✅ ' + msg); pass++; }
    else { console.log('  ❌ ' + msg); fail++; failMsgs.push(msg); }
    return cond;
}

async function signAs(userId) {
    const u = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!u) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, JWT_SECRET, { expiresIn: '1h' });
}

// [平台测试铁律] JWT 注入 + login.html 中继跳转——鉴权页直接 goto 会被 checkAuth 销毁 context。
async function loginPage(browser, token) {
    const page = await browser.newPage();
    // 收集页面侧错误——渲染空白最常见的原因就是某个未捕获异常把渲染链打断了，不收集就只能靠猜。
    page.__errors = [];
    page.on('console', m => { if (m.type() === 'error') page.__errors.push('console: ' + m.text()); });
    page.on('pageerror', e => page.__errors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate(t => { localStorage.setItem('token', t); }, token);
    return page;
}

// 卡/行定位与就绪等待全部照抄 test-sys-my-pending-playwright.js 已验证的范式（:218-226 / :322-326）——
//   不自创第二套：那边的 networkidle+400ms 是跑通过 144 断言的既有节奏，而 waitForSelector('#siTbody tr')
//   在"当前用户一行都看不到"的合法场景下会永远等不到，把正常结果误判成超时。
function statCardLoc(page) {
    return page.locator('.u-stat-card[onclick="siSetStatFilter(\'my_pending\')"]');
}
function issueRowLoc(page, issueId) {
    return page.locator(`tr[onclick="siOpenDrawer(${issueId})"]`);
}
// 打开系统迭代页，读「待我处理」卡的数字 + 点开该卡筛选后目标单是否真出现在列表里。
//   读数字**和**读行两件都做：数字对而内容错（或反之）的情况单看一样抓不到。
async function readMyPending(browser, token, label, targetIssueId) {
    const page = await loginPage(browser, token);
    await page.goto(`${BASE_URL}/Sys_Iteration.html`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
    const hasCard = (await statCardLoc(page).count()) > 0;
    let num = 0, rowVisible = false;
    if (hasCard) {
        const txt = await statCardLoc(page).locator('.u-stat-num').textContent().catch(() => null);
        num = txt == null ? 0 : (Number(txt.trim()) || 0);
        await statCardLoc(page).click();
        await page.waitForTimeout(400);
        rowVisible = (await issueRowLoc(page, targetIssueId).count()) === 1;
    }
    console.log(`  · ${label}：卡${hasCard ? '存在' : '不存在'}，计数=${num}，探针单#${targetIssueId} 在卡内=${rowVisible}`);
    await page.close();
    return { hasCard, num, rowVisible };
}

(async () => {
    let probeUserId = null, probeIssueId = null, ownIssueId = null, ownVerifyIssueId = null, browser = null, platformAdminId = null;
    try {
        // ── 前置：按 username 解析平台管理员，并核实其角色（codex 478 LOW-1） ──
        const pa = await dbGet('SELECT id, username, display_name, role, status FROM users WHERE username=?', [PLATFORM_ADMIN_USERNAME]);
        must(!!pa, `前置：库里应存在 username='${PLATFORM_ADMIN_USERNAME}' 的账号（前端 SI_PLATFORM_ADMIN_USERNAMES 白名单值）`);
        if (!pa) throw new Error(`未找到 username='${PLATFORM_ADMIN_USERNAME}'——环境配置与前端白名单不一致，探针无法进行`);
        must(pa.role === 'admin', `前置：平台管理员账号 role 应为 admin（实得 "${pa.role}"）——role 门与 username 门须同时成立，否则被测判据的正例本身不成立`);
        // [codex 478 复审 LOW-1] status 必须**真断言**而非只打印——首版注释声称"会断言 status 可用"
        //   但代码里只是 console.log，属注释虚构声称（注释是审查输入）。判据取项目正式口径：
        //   登录端点 server.js:4328 `WHERE username = ? AND status = 'active'`，非 active 即不可登录，
        //   而 signAs 直接签 JWT 会绕过登录闸 ⇒ 在停用账号上跑出的结果不代表真实可用的平台管理员。
        must(pa.status === 'active', `前置：平台管理员账号 status 应为 'active'（实得 "${pa.status}"）——登录端点(server.js:4328)只放行 active，探针的 signAs 绕过了该闸，若在停用账号上取证结论不代表线上真实情形`);
        platformAdminId = pa.id;
        console.log(`  · 平台管理员解析：#${platformAdminId} ${pa.username}/${pa.display_name} role=${pa.role} status=${pa.status}`);

        // ── 夹具①：临时 role=admin 账号（不在白名单） ──
        const existed = await dbGet('SELECT id FROM users WHERE username=?', [PROBE_USERNAME]);
        if (existed) throw new Error(`临时账号 ${PROBE_USERNAME} 已存在(id=${existed.id})——疑似上次异常退出留下的现场，请人工确认后再跑（本探针不自动接管既有行）`);
        const insUser = await dbRun(
            `INSERT INTO users (username, password, display_name, role, status, created_at)
             VALUES (?, 'x-probe-not-a-real-login', '探针业务方管理员', 'admin', 'active', datetime('now','localtime'))`,
            [PROBE_USERNAME]
        );
        probeUserId = insUser.lastID;
        must(probeUserId > 0, `夹具①：临时 role=admin 账号已建 (id=${probeUserId}, username=${PROBE_USERNAME})`);

        // ── 夹具①b：一张**真正属于临时账号**的待办（codex 478 复审 MED-2 收口） ──
        //   为什么必须有它：临时账号本来一张待办都没有 ⇒ 「待我处理」卡根本不渲染 ⇒ readMyPending 里
        //   hasCard=false 时 num 归 0 ⇒ `probeDelta === 0` 在基线和现值都为 0 的情况下**恒成立**，
        //   是一条没有鉴别力的断言（断言永远成立的典型形态）：它既证明不了"探针单没被算进去"，
        //   也发现不了"卡其实渲染了但定位器失效"这类问题。
        //   造一张走分支⑤（建单人=我 ∧ status='待修改'）的单，把临时账号的卡真正点亮，之后
        //   probeDelta===0 才是在"卡确实渲染、计数确实在动"的前提下说"这张探针单没算进来"。
        const insOwn = await dbRun(
            `INSERT INTO sys_issues (title, type, status, system_name, priority, source, intake_required, created_by, created_by_name, created_at, updated_at)
             VALUES (?, 'improvement', '待修改', 'BMS', 'P2', '内部', 1, ?, '探针业务方管理员', datetime('now','localtime'), datetime('now','localtime'))`,
            [OWN_TITLE, probeUserId]
        );
        ownIssueId = insOwn.lastID;
        must(ownIssueId > 0, `夹具①b：属于临时账号的「待修改」单已建 (id=${ownIssueId}, created_by=#${probeUserId})——用于点亮他自己的卡，消除 probeDelta 恒真`);

        // ── 夹具①c：属于临时账号的**「待验证」**单（2026-08-27 生产 #89 真实形态） ──
        //   #89 = 示例用户B(role=admin·非平台管理员)自己建的 bug 单处于「待验证」等他验收，收紧后整卡不渲染、
        //   验收无入口。依据 transitions.js:915「验收通过：待验证 → 待上线（**建单人**）」+ 生产 timeline
        //   实证（近 14 条 accept/close 中 13 条是建单人本人）⇒ 建单人半区 ①b 必须放行这一形态。
        //   本夹具把该真实形态钉进活体层：沙箱断言证谓词，这里证**页面真的把它渲染进卡**。
        const insOwnVerify = await dbRun(
            `INSERT INTO sys_issues (title, type, status, system_name, priority, source, intake_required, created_by, created_by_name, created_at, updated_at)
             VALUES (?, 'bug', '待验证', 'BMS', 'P2', '内部', 1, ?, '探针业务方管理员', datetime('now','localtime'), datetime('now','localtime'))`,
            [OWN_VERIFY_TITLE, probeUserId]
        );
        ownVerifyIssueId = insOwnVerify.lastID;
        must(ownVerifyIssueId > 0, `夹具①c：属于临时账号的「待验证」单已建 (id=${ownVerifyIssueId})——复刻生产 #89 形态（建单人=他本人，等他验收）`);

        browser = await chromium.launch();
        const adminTok = await signAs(platformAdminId);
        const probeTok = await signAs(probeUserId);

        // ── 基线：**在造探针单之前**读两个账号的卡计数（codex 478 MED-2） ──
        //   有了基线，下方判的就是"这张单带来的增量"这个因果量，而不是两个账号总数的大小关系——
        //   后者受各自其他身份的待办影响，不是业务契约。targetIssueId 传 0（不存在的 id，恒不命中）。
        console.log('\n— 基线（探针单尚未创建） —');
        const baseAdmin = await readMyPending(browser, adminTok, 'admin 基线', 0);
        const baseProbe = await readMyPending(browser, probeTok, `${PROBE_USERNAME} 基线`, 0);
        const baselineAdmin = baseAdmin.num, baselineProbe = baseProbe.num;
        must(!baseAdmin.rowVisible && !baseProbe.rowVisible, '基线：id=0 这个不存在的单在两边都不该命中（证行定位器不会凭空命中）');
        // [codex 478 复审 MED-2] 鉴别力前提：临时账号的卡**必须已经点亮**，否则下方 probeDelta===0 恒真。
        must(baseProbe.hasCard && baselineProbe >= 1,
            `基线：临时账号的「待我处理」卡应已因自有单(#${ownIssueId})渲染且计数≥1（实得 卡存在=${baseProbe.hasCard} 计数=${baselineProbe}）——若卡不渲染，probeDelta===0 就是没有鉴别力的恒真断言`);

        // ── 夹具②：一张「待指派」单，建单人=平台管理员，与临时账号无任何关联 ──
        const insIssue = await dbRun(
            // intake_required=1 是 DDL CHECK 焊死的（角色权限重构 C0：全类型必经受理，0 为非法态），
            //   夹具必须满足真实约束——不能为了造数方便绕过，那样造出来的单不代表线上任何真实形态。
            `INSERT INTO sys_issues (title, type, status, system_name, priority, source, intake_required, created_by, created_by_name, created_at, updated_at)
             VALUES (?, 'improvement', '待指派', 'BMS', 'P2', '内部', 1, ?, '管理员', datetime('now','localtime'), datetime('now','localtime'))`,
            [PROBE_TITLE, platformAdminId]
        );
        probeIssueId = insIssue.lastID;
        must(probeIssueId > 0, `夹具②：「待指派」单已建 (id=${probeIssueId})，建单人=#${platformAdminId}，与临时账号无关联`);

        console.log('\n— ① 正向：平台管理员 admin 应能在「待我处理」里看到这张待指派单 —');
        const asAdmin = await readMyPending(browser, adminTok, 'admin(白名单内)', probeIssueId);
        must(asAdmin.hasCard, '① admin 的「待我处理」卡应渲染出来');
        must(asAdmin.rowVisible,
            `① admin 的卡内应含探针单 #${probeIssueId}——若缺失说明夹具没进可见集合，下方②的"看不到"就不成立（探针本身失效，非收紧生效）`);

        console.log('\n— ② 反向：role=admin 但非平台管理员，不应看到这张与他无关的待指派单 —');
        const asProbe = await readMyPending(browser, probeTok, `${PROBE_USERNAME}(role=admin·白名单外)`, probeIssueId);
        const adminDelta = asAdmin.num - baselineAdmin;
        const probeDelta = asProbe.num - baselineProbe;
        must(!asProbe.rowVisible,
            `② 非平台管理员的卡内不应含探针单 #${probeIssueId}（改动前该单必然出现——正是示例用户B看到别人待指派单的原因）`);
        // [codex 478 MED-2 收口] 原写 `asProbe.num < asAdmin.num`——两个账号的**总数大小关系不是业务
        //   契约**：临时账号将来若因其他身份分支（开发/对接人/值班）持有待办，或 admin 侧数据变动，
        //   这条会给出与本次改动无关的误报。真正的因果判据是**造夹具带来的增量**：同一张单，平台
        //   管理员 +1、非平台管理员 +0。故改为基线差值断言（基线在造夹具前已读，见上方 baseline*）。
        must(adminDelta === 1,
            `② 平台管理员的计数增量应恰为 +1（基线 ${baselineAdmin} → 现在 ${asAdmin.num}，实得 ${adminDelta}）——增量不为 1 说明夹具没被正确计入，②的"看不到"失去参照`);
        must(probeDelta === 0,
            `② 非平台管理员的计数增量应恰为 0（基线 ${baselineProbe} → 现在 ${asProbe.num}，实得 ${probeDelta}）——本次新增的单不该让他的卡涨数`);
        // [codex 478 复审 MED-2] 上一条要有意义，必须证明他的卡此刻**确实在渲染且确实在计数**——
        //   否则 0→0 只是"卡根本没出现"的副产品。这条把"卡活着"与"探针单没进来"两件事同时钉住。
        must(asProbe.hasCard && asProbe.num >= 1,
            `② 非平台管理员的卡此刻应仍渲染且计数≥1（自有单 #${ownIssueId} 撑着，实得 卡存在=${asProbe.hasCard} 计数=${asProbe.num}）——卡若消失则上一条 +0 失去鉴别力`);
        const probeOwnVisible = await (async () => {
            const page = await loginPage(browser, probeTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            let vis = false;
            if ((await statCardLoc(page).count()) > 0) {
                await statCardLoc(page).click();
                await page.waitForTimeout(400);
                vis = (await issueRowLoc(page, ownIssueId).count()) === 1;
            }
            await page.close();
            return vis;
        })();
        must(probeOwnVisible,
            `② 非平台管理员的卡内应含**他自己的**单 #${ownIssueId}（分支⑤ 建单人=我 ∧ 待修改）——证明收紧只摘掉了与他无关的单，没有把他自己的待办一并摘掉（不误伤的正面证据）`);

        console.log('\n— ②b ⭐生产 #89 形态：建单人自己的「待验证」单必须在卡内（①b 半区活体验证） —');
        const probeVerifyVisible = await (async () => {
            const page = await loginPage(browser, probeTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);
            let vis = false, cardNum = 0;
            if ((await statCardLoc(page).count()) > 0) {
                const txt = await statCardLoc(page).locator('.u-stat-num').textContent().catch(() => null);
                cardNum = txt == null ? 0 : (Number(txt.trim()) || 0);
                await statCardLoc(page).click();
                await page.waitForTimeout(400);
                vis = (await issueRowLoc(page, ownVerifyIssueId).count()) === 1;
            }
            console.log(`  · 非平台管理员视角：卡计数=${cardNum}，自有待验证单#${ownVerifyIssueId} 在卡内=${vis}`);
            await page.close();
            return vis;
        })();
        must(probeVerifyVisible,
            `②b 建单人自己的「待验证」单 #${ownVerifyIssueId} 必须出现在他的卡里——这是生产 #89 的真实形态（示例用户B建的 bug 单待他验收）。依据 transitions.js:915「验收通过：待验证 → 待上线（建单人）」+ 生产 timeline 实证 13/14 为建单人本人操作。此条红=①b 半区失效，验收又将无入口`);

        console.log('\n— ③ 不误伤：临时账号的列表可见面不受影响（收紧的是归属判定，不是访问权） —');
        // 这条**刻意走 API 不走 DOM**：可见面是后端 GET /sys-issues 的 WHERE 段决定的，用 DOM 行数证会
        //   混进渲染时机、默认筛选、分页三个无关变量（初版就是这么写的，读到 0 行——不是可见面出了问题，
        //   而是判据选错了层）。要证"后端还认这个 admin"，直接问后端最干净。
        const listResp = await fetch(`${BASE_URL}/api/sys-issues`, { headers: { Authorization: `Bearer ${probeTok}` } });
        const listBody = await listResp.json().catch(() => null);
        const rows = Array.isArray(listBody) ? listBody : (listBody && (listBody.items || listBody.rows || listBody.data)) || [];
        must(listResp.status === 200, `③ 临时账号 GET /sys-issues 应 200（实得 ${listResp.status}）`);
        must(rows.length > 0, `③ 临时账号仍能取到全量列表（${rows.length} 条）——收紧只动「待我处理」卡的归属判定，后端可见面与写权限一字未改`);

        // ③b DOM 层补证——**对照式**，不是绝对值断言。
        //   ⚠️⚠️ **结论订正（2026-08-27，务必读完再改这段）**：本段注释此前写着"admin 也是 0 行，属
        //   页面固有行为"——**那个结论是错的**。真相是选择器名写错了：列表 tbody 的真实 id 是
        //   `siTbody`，而初版三处都写成了 `siTableBody`，于是**永远选不到任何行**，两个账号自然都读到
        //   0，"表现一致"的对照断言因两边恒为 0 而**恒成立 ⇒ 假绿**。是后来写另一个探针时同款选择器
        //   再次读到 0、去 grep 真实 id 才发现（Sys_Iteration.html:2963 `getElementById('siTbody')`）。
        //   留下这段订正而不是抹掉，是因为**错误结论比错误代码更危险**：它当时已被写进注释与 commit
        //   message，会让后来人相信"这里本来就读不到行"从而不再追查。
        //   两重教训：① 红灯第一诊断是"谁错了"（feedback_test_assertion_self_error），而"谁"包括
        //   **测试自己的选择器**，不能一发现"基准账号也这样"就归因为"固有行为"——两边同时错也会表现
        //   为一致；② 对照式断言的前提是"判据本身有鉴别力"，否则它退化成恒真（同 codex 478 复审
        //   MED-2 那条 probeDelta===0 的形态，一日之内第二次踩）。
        //   现在选择器已修正，本条恢复为真正的对照：两个账号在同一判据下表现须一致，一致即无连坐；
        //   若临时账号空而 admin 不空，才是真回归。
        async function domRenderState(tok) {
            const p = await loginPage(browser, tok);
            await p.goto(`${BASE_URL}/Sys_Iteration.html`);
            let rendered = true;
            await p.waitForFunction(() => {
                const tb = document.getElementById('siTbody');
                return !!tb && tb.children.length > 0;
            }, { timeout: 12000 }).catch(() => { rendered = false; });
            const rowsN = await p.$$eval('#siTbody tr', trs => trs.length);
            const activeStat = await p.evaluate(() => (typeof siActiveStat === 'string' ? siActiveStat : '(取不到)'));
            const errs = p.__errors.slice();
            await p.close();
            return { rendered, rowsN, activeStat, errs };
        }
        const domProbe = await domRenderState(probeTok);
        const domAdmin = await domRenderState(adminTok);
        console.log(`  · DOM 对照：非平台管理员 渲染=${domProbe.rendered}/行=${domProbe.rowsN}/stat="${domProbe.activeStat}" ｜ admin 渲染=${domAdmin.rendered}/行=${domAdmin.rowsN}/stat="${domAdmin.activeStat}"`);
        if (domProbe.errs.length) { console.log('  · 非平台管理员页面错误：'); domProbe.errs.slice(0, 5).forEach(e => console.log('      ' + e)); }
        must(domProbe.rendered === domAdmin.rendered && domProbe.rowsN === domAdmin.rowsN,
            `③b 两账号的列表初始渲染表现应一致（非平台管理员 ${domProbe.rowsN} 行 vs admin ${domAdmin.rowsN} 行）——不一致说明列表渲染被身份判定连坐`);
        must(domProbe.activeStat === '' && domAdmin.activeStat === '',
            `③b 两账号的默认筛选都应是"全部"（siActiveStat=""）——若默认停在某张卡上，收紧后该卡为空会让用户一进来就看到空列表（实得 probe="${domProbe.activeStat}" admin="${domAdmin.activeStat}"）`);
        must(domProbe.errs.length === 0,
            `③b 非平台管理员打开页面不应有 JS 错误（实得 ${domProbe.errs.length} 条）——siIsPlatformAdmin 在 currentUser 未就绪时也必须安全返回 false，不得抛错打断渲染链`);
    } catch (e) {
        fail++; failMsgs.push('异常：' + e.message);
        console.error('\n❌ 探针异常：', e.stack || e.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        // 按 id 精确清理（非前缀通配——通配会抹掉上次失败保留的现场）。
        // [codex 478 MED-3 收口] 每步**各自独立 try**：初版把两次 DELETE 与残留核实放在同一个 try 里，
        //   探针单删除一旦失败（外键约束/库锁/异常）就跳去 catch，临时账号既不会被删、残留也不会被核实
        //   ⇒ 留下的 probe_bizadmin_tmp 会让**下一次跑探针直接抛错**（脚本设计为"已存在即拒绝接管"），
        //   一次偶发失败变成需要人工介入才能恢复。现在前一步失败不阻断后一步，且每个对象分别核实残留。
        async function cleanupStep(label, fn) {
            try { await fn(); return true; }
            catch (e) {
                console.error(`  ⚠️ 清理失败（${label}）：${e.message}`);
                fail++; failMsgs.push(`清理失败（${label}）：${e.message}`);
                return false;
            }
        }
        console.log('');
        if (probeIssueId) {
            await cleanupStep(`删探针单 #${probeIssueId}`, async () => {
                await dbRun('DELETE FROM sys_issues WHERE id=?', [probeIssueId]);
                console.log(`  🧹 已删探针单 #${probeIssueId}`);
            });
        }
        if (ownIssueId) {
            await cleanupStep(`删临时账号自有单 #${ownIssueId}`, async () => {
                await dbRun('DELETE FROM sys_issues WHERE id=?', [ownIssueId]);
                console.log(`  🧹 已删临时账号自有单 #${ownIssueId}`);
            });
        }
        if (ownVerifyIssueId) {
            await cleanupStep(`删临时账号自有待验证单 #${ownVerifyIssueId}`, async () => {
                await dbRun('DELETE FROM sys_issues WHERE id=?', [ownVerifyIssueId]);
                console.log(`  🧹 已删临时账号自有待验证单 #${ownVerifyIssueId}`);
            });
        }
        if (probeUserId) {
            await cleanupStep(`删临时账号 #${probeUserId}`, async () => {
                await dbRun('DELETE FROM users WHERE id=?', [probeUserId]);
                console.log(`  🧹 已删临时账号 #${probeUserId}`);
            });
        }
        // 残留核实同样独立成步——即便上面任一删除失败，这里也要如实报出"到底谁还留着"，
        //   给人工介入一份准确的清单（而不是因为前一步抛错就什么都不知道）。
        await cleanupStep('残留核实', async () => {
            const leftIssue = probeIssueId ? await dbGet('SELECT id FROM sys_issues WHERE id=?', [probeIssueId]) : null;
            const leftOwn = ownIssueId ? await dbGet('SELECT id FROM sys_issues WHERE id=?', [ownIssueId]) : null;
            const leftOwnVerify = ownVerifyIssueId ? await dbGet('SELECT id FROM sys_issues WHERE id=?', [ownVerifyIssueId]) : null;
            const leftUser = probeUserId ? await dbGet('SELECT id, username FROM users WHERE id=?', [probeUserId]) : null;
            // ⚠️ leftDesc 必须与上方 must() 的判据**覆盖同一组对象**——漏一个就会出现"断言判红但提示
            //   说残留 0"的自相矛盾（本文件曾漏 leftOwnVerify 一次，靠核对文件实际内容才发现）。
            const leftDesc = [
                leftIssue ? `探针单#${leftIssue.id}` : null,
                leftOwn ? `自有单#${leftOwn.id}` : null,
                leftOwnVerify ? `自有待验证单#${leftOwnVerify.id}` : null,
                leftUser ? `账号#${leftUser.id}(${leftUser.username})` : null,
            ].filter(Boolean).join('、');
            must(!leftIssue && !leftOwn && !leftOwnVerify && !leftUser,
                leftDesc
                    ? `🧹 夹具清理到磁盘核实：仍有残留=${leftDesc}——⚠️ 需人工删除，否则下次跑本探针会因"临时账号已存在"直接拒绝启动`
                    : '🧹 夹具清理到磁盘核实：探针单与临时账号均已不存在（残留 0）');
        });
        db.close();
    }

    console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
    if (fail) { console.log('失败清单：'); failMsgs.forEach(m => console.log('  - ' + m)); process.exit(1); }
})();
