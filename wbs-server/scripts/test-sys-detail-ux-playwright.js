/**
 * test-sys-detail-ux-playwright.js — 系统迭代详情抽屉 UX 补全 前端冒烟（F 线，本文件起）
 *
 * 循 test-sys-commit-cols-playwright.js 套件范式（外部 server:3000 已运行的真实 task_pool.db +
 * JWT 注入 + login.html 中继跳转 + 直接 SQL 造夹具 + must() 断言计数 + finally 段清理 + 非零退出码）。
 * 与该文件同款契约：本脚本**不**自带端口探测/自启动逻辑——依赖调用方在跑本脚本前已把 server 跑在
 * localhost:3000（含本次改动的最新代码），server 未起时 page.goto/fetch 会失败并落入顶层 catch，
 * 计入 failed 且非零退出，不会被误判为"全部跳过=通过"。
 *
 * 用法：本地 server（3000）已重启到含本文件覆盖改动的代码后：
 *   node scripts/test-sys-detail-ux-playwright.js
 *
 * F1 覆盖：
 *   [T1] 开发成员 chip 逐人完成时刻——code_submitted 且 resolved_at 有值的成员，chip 内出现
 *        .si-dev-chip-time，文本含 HH:MM 且精确等于 siFmtDT(resolved_at)，title 含秒且精确等于
 *        siFmtDTSec(resolved_at)。
 *   [T2] 对照组（同一单内）——① pending 成员（resolved_at 为 NULL）chip 内不出现 .si-dev-chip-time；
 *        ② excused 成员（resolved_at 有值，真实后端 excuse 端点也会写非空 resolved_at）chip 内同样
 *        不出现 .si-dev-chip-time——单靠"resolved_at 是否有值"无法解释该断言，只有"status 是否属于
 *        code_submitted/no_code 两态"才能，堵住"选择器/条件退化成只看 resolved_at 真值"的假绿。
 *
 * F2 新增：
 *   [T4] 估时弹窗（siModalEstimate）回填提示「最近一次估时/评估由 X 于 Y 填写」——正面：dev_estimated_at 有值 +
 *        一条 estimate timeline 事件，弹窗内 .u-hint 精确等于「最近一次估时/评估由 <operator_name> 于
 *        <siFmtDT(created_at) 分钟精度> 填写」；对照：dev_estimated_at 为空（无 estimate 事件）时
 *        该 .u-hint 不出现（选择器非恒真）。弹窗直调 `siModalEstimate(siDetail.issue)`（bare 标识符，
 *        非 window.siDetail——siDetail 用 let 声明不挂 window，同既有套件 siModalSubmit(siDetail.issue)
 *        范式），先真开抽屉让 siCurTimeline 走真实详情接口填充，再开弹窗，端到端覆盖页级变量镜像链路。
 *
 * F3 新增：
 *   [T5]「开发」列排序键与显示同源——3 单夹具（roster 单名 A/roster 单名 Z/零 roster 只有
 *        assigned_to_name 回退值 M）搜索收窄可见集后先断言前置锚点（3 单都在当前视图内，防分页
 *        误伤），首次点表头断言 desc（源码实测：切新列首点固定 desc，非常见的"首点 asc"直觉，
 *        见 [T5] 段内机制查证注释）、二次点断言 asc；两个方向都验相对行序 Z/M/A 与派生字段
 *        （dev_roster_sort）字典序一致，另断言「开发」列文本本身精确等于派生串所本的姓名
 *        （显示与排序真正同源，非恰好排对但显示还是旧值）。
 *
 *   [T3] 全程无 console error（置于文件末尾，覆盖前面全部交互）。
 *
 * F3b（Opus 预筛回卷六件小修，一批交付）新增/修正：
 *   [T1]〔MED-3〕补 no_code 正面态——production 条件是
 *        `statusKey === 'code_submitted' || statusKey === 'no_code'`，此前只测过 code_submitted 半支。
 *   [T4]〔F2-LOW-3①〕对照隔离夹具——dev_estimated_at 有值但 timeline 只有 'created' 事件（无
 *        estimate/feasibility）→ .u-hint 仍不出现，单独钉死"事件缺失不伪造"（原对照组测的是
 *        dev_estimated_at 为空这条件本身短路，没测到这一半）。
 *   [T4]〔F2-LOW-3②〕可行性弹窗（siModalFeasibility）正例——nf=1 feature 单 + feasibility 事件 +
 *        dev_estimated_at 有值 → 首个 .u-hint 精确等于「最近一次估时/评估由 X 于 Y 填写」（feature 单工期字段
 *        自带 .u-hint，故用"首个+精确等值"而非存在性）+ #f_conclusion/#f_requirement_confirm/
 *        #f_estimated_effort_days 三字段仍在（同一用例覆盖 hint 生效 + feasibilityFields 重构未丢字段）。
 *   ⚠️ 陷阱记录（T5 首跑真实踩过）：一段用例（drawer/modal）结束后必须显式
 *        `if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer();`——
 *        只关 modal 不关 drawer，遗留的 #siOverlay.open 会拦截后续对列表/表头的 pointer 事件，
 *        page.click 类断言会恒超时（非选择器错，是遮罩没退场）。本批新增两段均已照此处理。
 *
 * F4 新增（时间线渲染层三合一：C5a 补映射 + C5b 噪音折叠 + C5d 存量转译）：
 *   [T6] 一单直插 7 条 timeline 行，逐行按 operator_name 唯一值定位（不依赖 DOM 顺序）：
 *        ① status_change+action_code=intake_accept → 徽章「受理」（C5a 9 码补映射之一）；
 *        ② note+action_code=notify_sent 成功形态（含 message_key 与 (id13)）→ 正文两者均摘除、
 *           折叠后精确等于「发送开发通知 → 测试员：成功」、title 挂完整原文（C5b）；
 *        ③ estimate 裸值行 → 正文紧跟徽章后以「预计完成：」开头（C5b）；
 *        ④ 存量 W-GATE 唯一硬编码 summary 两条（to_status=待验证/处理中）→ 方向感知转译分别精确
 *           等于「全部在册开发已完成，自动流转」/「出现新的待提交成员，自动退回开发中」，title 均
 *           含机制名原文「W-GATE 自动门禁转移」（C5d，方向判据=to_status 是否落在 DEV 族状态集合，
 *           出处 routes/sys-iteration/status-families.js:55-59 SYS_DEV_STATUSES）；
 *        ⑤ 对照组：未知 action_code（zz_unknown_probe_<RUN_TAG>）→ 徽章仍裸显该码本身，证明 C5a/C5d
 *           的新增分支没有把"查不到就裸显"这条兜底吞掉；
 *        ⑥ notify_sent 失败形态（who 也含 (id99)）→ (id99) 仍摘除，但「失败=…」段保留在正文（当场
 *           要看到失败原因，只对成功形态的 message_key 折叠，不对失败原因折叠）。
 *
 * F5 新增（C5c 发布留痕展开视图结构化 + 预筛 LOW-4 两小件）：
 *   [T5]〔预筛 LOW-4②〕补 3 人 roster 夹具——证排序键用**全量** join 串而非显示截断后的
 *        「前2名+等+1」串（构造原理见 [T5] 段内该夹具处大段注释：node -e 实测 localeCompare
 *        ('zh-Hans-CN') 找出一个"锚点"值卡在 fullKey 与 truncatedDisplay 之间，3 人夹具真实渲染
 *        位置落在锚点哪一侧即可反证用的是全量串还是截断串）；另断言其「开发」列文本确为截断形态。
 *   [T7] 发布留痕（release_published）展开视图结构化——正例：一条合法快照 JSON（commits 两条，一条
 *        dev_user_id 映射得到真名〔用 seed 的 admin.id〕、一条映射不到〔99999→回退显 #99999，
 *        不伪造〕）→ 展开后 commits 小表行数=2、两行姓名/组件/commit_ref 精确匹配、顶部「发布时
 *        状态：已上线」小字、小表下方二级折叠「查看原始快照」含 schema_version；对照：非法 JSON
 *        → 维持现状「原始记录（解析失败）」文案不动、且不渲染结构化小表（info.ok===false 分支
 *        未被新代码路径影响）。<details> 展开用 page.evaluate 直接置 `.open = true`（验证展开后
 *        内容对不对，不测原生 HTML 折叠交互机制本身）。
 *
 * F6 新增（估时并发乐观锁前端接线：F2 提示+B1 后端拦截+本件自动刷新，组合缺口闭环）：
 *   [T8] 全程走真实 UI 提交路径（page.fill + page.click('#siMConfirm')，非直接 fetch）：
 *        ①正常路径——dev_estimated_at 故意播成 16 字符无秒存量形态，断言预填值 + 改新值提交成功后
 *        库值落新提交值（后端补秒）；②stale 路径——开弹窗后直改库模拟"他人先提交"，提交应 409，
 *        断言 toast 精确文案 + 弹窗已关闭 + 库值仍为"他人"的值（未被覆盖）；③对照重试——弹窗内
 *        expected 已随 STALE 分支的 siAfterAction() 刷新，断言重开弹窗预填=新现值，提交应成功
 *        （证明 STALE 不是永久卡死）。新增 `siConsoleErrorsExcludingKnown409` 精确预算豁免
 *        [T8]② 故意触发的 1 条 `/estimate` 409（同 test-sys-bug-hold-frontend-playwright.js 对
 *        403 的既有精确预算写法，非盲目放行）。
 *
 * F7 新增（C6 bug 产生原因前端·F 线末件）：
 *   [T9] ①bug 单提交弹窗断言「bug 产生原因」textarea 存在（label 文本+必填星号）+ 切到 no_code
 *        模式后字段仍可见（恒显不随 mode 隐藏）；②其余必填项填好、独留该字段空 → 前端拦下（精确
 *        文案「请填写 bug 产生原因」）+ 弹窗未关；③补填后真实提交 → 200 →（a）服务端落库交叉核对
 *        `sys_issue_dev_events.payload_json.bug_cause_note` 精确等于提交值（b）重开抽屉断言开发
 *        成员区出现「bug 产生原因」逐人块且文本精确匹配（写读端到端）；④对照：feature 单开提交
 *        弹窗，断言该字段**不存在**（非 bug 类型零变化）。
 *
 * F8 新增/修正（预筛第四轮回卷·F 侧四件收口批）：
 *   [T9]③b〔MED-1 延伸〕成员区 bug 原因块改读 bug_cause_records 契约（含已移出历史轮次，对齐
 *        noCodeRecords 同款 codex 264 号 M-2 裁定）——直插一条 removed_at 非空的 dev_assignee 行 +
 *        其 submit 事件带 bug_cause_note，断言成员区块含该行且带「（已移出）」muted 后缀；在册行
 *        不带后缀（对照）。⚠️ 后端 bug_cause_records 由 agent-B 并行实现，本次未集成，本组断言
 *        无法实跑验证，夹具按已定死契约字段反推，集成后由主会话实跑核对。
 *   [T8]②〔MED-2〕直改库之后、fill 之前插一次 `siRenderDrawer(siOpenId)` 重渲——这是本组断言的
 *        判别力来源：没有它，"闭包捕获 expected"与"onConfirm 里现读 siDetail"两种实现会同绿（因为
 *        siDetail 从未刷新，现读也读到旧值）；加了这行后，只有真正闭包捕获的实现才会在 expected
 *        已过期的情况下仍正确送出旧值触发 409，退化成现读会送出刷新后的新值而意外 200，被下方
 *        dbAfterB（库值应仍是"他人"值未被覆盖）断言当场抓到。
 *   〔LOW-3〕siRenderTimeline 的 created 行截断改码点口径（`[...e.summary]` 而非裸 `.length`/
 *        `.slice()`）——UTF-16 码元口径会劈开代理对字符（多数 emoji），对齐全仓其余长度口径
 *        （work_note 1000/bug_cause_note 500 均码点计数）。
 *   〔LOW-5〕[T9]③ 服务端交叉核对查询从 `WHERE issue_id=? ORDER BY id DESC LIMIT 1` 收窄为加
 *        `dev_assignee_id=? AND action IN ('submit','no_code')`（对齐 verify-sys-bug-cause.js:270
 *        既有更强先例）——当前单人单轮场景裸查询本就成立，收窄是防未来夹具扩展（同单多人/多轮）时
 *        误捞错行的方向性加固，非修一个当下就存在的真实 bug。
 *
 * F 线后续阶段会继续往本文件追加断言（不新建平行文件）。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

// ⚠️ 必须加载 .env：server 端 JWT_SECRET 来自 .env，脚本不加载会退回 fallback 值 →
//    签名不匹配 → 所有请求 403 → 被 checkAuth 踢回 login.html（同款套件均有此行）
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'test-screenshots');

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

let passed = 0, failed = 0;
let fatalError = null;
function must(cond, msg) {
    if (cond) { passed++; console.log('  ✅ ' + msg); return true; }
    failed++; console.log('  ❌ ' + msg); return false;
}

async function loginPage(browser, token) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    // F6：[T8]② 故意提交 stale expected_dev_estimated_at 触发真实 409——Chromium 会把失败的 fetch 计一条
    // "Failed to load resource...409" console error（同款证据见 test-sys-bug-hold-frontend-playwright.js
    // consoleErrorsExcludingKnown 对 403 的处理，本文件借同一手法处理 409）。记录响应 URL，供文件末尾
    // [T3] 按**观测到的精确条数**豁免（非无差别吞掉所有 409 噪音——见 siConsoleErrorsExcludingKnown409）。
    const urls409 = [];
    page.on('response', r => { if (r.status() === 409) urls409.push(r.url()); });
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    page._409Urls = urls409;
    return page;
}
// 豁免仅限「URL 含 /estimate 的 409」——本文件唯一故意触发 409 的地方是 [T8]② 的估时并发锁 stale 分支。
// 〔F9·MED-4〕预算从"观测到多少吞多少"改固定值 1——该分支应恰好触发 1 次 409，不是"随便触发几次都照单
// 全收"。[T8] 结束处已显式断言 page._409Urls 过滤后恰 1 条命中 /estimate（该处注释与这里的固定值必须
// 保持同一数字，改一处两处都要改）；超出这个固定预算的 409（不论是否命中 /estimate）一律不再豁免、
// 照常计入 console error——防未来某次改动意外多触发几次 409 却被"动态预算"悄悄照单吃掉。
const SI_409_BUDGET_ESTIMATE = 1;
function siConsoleErrorsExcludingKnown409(page) {
    const errs = page._consoleErrors || [];
    // 〔codex 328-R2 收口〕来源绑定：console 的 409 error 文本不带 URL，无法逐条对应到端点——用响应侧
    //   证据（page._409Urls）做门：仅当观测到的**全部** 409 响应都来自 /estimate 时才应用预算豁免；
    //   只要出现任何非 /estimate 的 409，说明有预算外的新问题，一条都不豁免，让 [T3] 全量暴露。
    const urls = page._409Urls || [];
    const allFromEstimate = urls.length > 0 && urls.every(u => u.includes('/estimate'));
    let budget = allFromEstimate ? SI_409_BUDGET_ESTIMATE : 0;
    return errs.filter(e => {
        if (budget > 0 && /Failed to load resource.*409/.test(e)) { budget--; return false; }
        return true;
    });
}

const RUN_TAG = Date.now();
const createdIssueIds = [];

const FIXTURE_SYSTEM = 'BMS';
async function mkIssue(title, status) {
    const r = await run(
        `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required)
         VALUES ('bug', ?, ?, ?, '内部', 1, '管理员', 1)`, [status, title, FIXTURE_SYSTEM]
    );
    createdIssueIds.push(r.lastID);
    return r.lastID;
}
// 本文件自用 mkMember：与 test-sys-commit-cols-playwright.js 的默认 pending 版不同——[T1]/[T2] 需要直接
// 造出 dev_status/resolved_at 各异的四种成员形态（code_submitted 有值 / pending 空 / excused 有值 /
// no_code 有值——F3b MED-3 补的第 4 态），不经真实 submit/excuse 端点（那是端到端流程测试的范围，
// 本文件只测"给定后端字段，前端如何渲染"）。noCodeReason 可选（F3b 新增第 6 参）：no_code 态在真实
// 后端（P4 配对不变量，scripts/lib/sys-multidev-probes.js）要求 no_code_reason 非空，本参数让夹具
// 数据形状贴近真实存量，非本文件断言直接消费。
async function mkMember(issueId, userId, userName, devStatus, resolvedAt, noCodeReason) {
    const r = await run(
        `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, no_code_reason)
         VALUES (?, ?, ?, 0, ?, ?, ?)`, [issueId, userId, userName, devStatus || 'pending', resolvedAt || null, noCodeReason || null]
    );
    return r.lastID;
}

(async () => {
    let browser;
    try {
        // users 表用 `status`（非 is_active）标活跃态——列名以 PRAGMA table_info 实测为准，不凭印象写
        const admin = await get(`SELECT id, username, display_name, role FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`);
        if (!admin) throw new Error('库中无 active admin 用户，无法造 token');
        const adminTok = jwt.sign({ id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role }, JWT_SECRET, { expiresIn: '1h' });

        // ── 夹具：一单四名开发，逐人不同 dev_status/resolved_at 组合 ──────────────────
        //   〔F3b MED-3〕补第 4 名 no_code——production 代码的显示条件是
        //   `statusKey === 'code_submitted' || statusKey === 'no_code'`，F1 首版只造了 code_submitted
        //   一个正面夹具，`|| statusKey === 'no_code'` 这半支从未被断言覆盖过（删掉它全部用例仍会绿）。
        const NAME_SUBMITTED = `完成测试甲-${RUN_TAG}`;
        const NAME_PENDING = `待提交测试乙-${RUN_TAG}`;
        const NAME_EXCUSED = `开脱测试丙-${RUN_TAG}`;
        const NAME_NOCODE = `无代码测试丁-${RUN_TAG}`;
        const RESOLVED_AT_SUBMITTED = '2026-08-01 09:15:42';
        const RESOLVED_AT_EXCUSED = '2026-08-01 10:00:07';
        const RESOLVED_AT_NOCODE = '2026-08-01 11:30:15';

        const iDetail = await mkIssue(`DUX-逐人完成时刻-${RUN_TAG}`, '处理中');
        await mkMember(iDetail, 9001, NAME_SUBMITTED, 'code_submitted', RESOLVED_AT_SUBMITTED);
        await mkMember(iDetail, 9002, NAME_PENDING, 'pending', null);
        await mkMember(iDetail, 9003, NAME_EXCUSED, 'excused', RESOLVED_AT_EXCUSED);
        await mkMember(iDetail, 9004, NAME_NOCODE, 'no_code', RESOLVED_AT_NOCODE, 'F3b MED-3 探针夹具：no_code 正面态覆盖');

        browser = await chromium.launch();
        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Sys_Iteration.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iDetail);
        await page.waitForTimeout(600);

        // 正面锚点：先确认抽屉真的切到了 iDetail（防抽屉未开/切换失败时，下面的选择器断言落空却被
        // 误读成"符合预期"）。
        const drawerTitleText = await page.evaluate(() => {
            const el = document.getElementById('siDTitle');
            return el ? el.textContent.trim() : null;
        });
        must(!!drawerTitleText && new RegExp(`^#${iDetail}(?!\\d)`).test(drawerTitleText),
            `[T0] 前置：抽屉确已切到 #${iDetail}（siDTitle 应以该编号开头），实得 "${drawerTitleText}"`);

        // 逐 chip 采集：按姓名文本定位所属 chip，再在 chip 内部找 .si-dev-chip-time
        const chipProbe = await page.evaluate(() => {
            const chips = [...document.querySelectorAll('#siDBody .si-dev-chip-list .si-dev-chip')];
            return chips.map(c => {
                const timeEl = c.querySelector('.si-dev-chip-time');
                return {
                    text: c.textContent,
                    hasTime: !!timeEl,
                    timeText: timeEl ? timeEl.textContent : null,
                    timeTitle: timeEl ? timeEl.getAttribute('title') : null,
                };
            });
        });
        const chipOf = (name) => chipProbe.find(c => c.text.includes(name));

        // ── [T1] code_submitted 且 resolved_at 有值 → chip 内出现 .si-dev-chip-time ──────────
        console.log('\n── [T1] 逐人完成时刻——code_submitted 正面用例 ──');
        const submittedChip = chipOf(NAME_SUBMITTED);
        must(!!submittedChip, `[T1] 前置：应能在 chip 列表内按姓名定位到「${NAME_SUBMITTED}」，实得 ${JSON.stringify(chipProbe)}`);
        must(!!submittedChip && submittedChip.hasTime === true,
            `[T1] ⭐ code_submitted 成员 chip 内应出现 .si-dev-chip-time，实得 hasTime=${submittedChip && submittedChip.hasTime}`);
        must(!!submittedChip && /\d{2}:\d{2}/.test(submittedChip.timeText || ''),
            `[T1] .si-dev-chip-time 文本应含 HH:MM，实得 "${submittedChip && submittedChip.timeText}"`);
        const expectMinute = '·' + RESOLVED_AT_SUBMITTED.slice(0, 16);   // 同既有套件范式：锁定当前展示格式，不真调 siFmtDT
        must(!!submittedChip && submittedChip.timeText === expectMinute,
            `[T1] ⭐ .si-dev-chip-time 文本应精确等于 siFmtDT(resolved_at) 前缀「·」，期望="${expectMinute}"，实得 "${submittedChip && submittedChip.timeText}"`);
        must(!!submittedChip && !!submittedChip.timeTitle && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(submittedChip.timeTitle),
            `[T1] title 应含秒（YYYY-MM-DD HH:MM:SS 形态），实得 "${submittedChip && submittedChip.timeTitle}"`);
        must(!!submittedChip && submittedChip.timeTitle === RESOLVED_AT_SUBMITTED,
            `[T1] ⭐ title 应精确等于 siFmtDTSec(resolved_at)，期望="${RESOLVED_AT_SUBMITTED}"，实得 "${submittedChip && submittedChip.timeTitle}"`);

        // ── [T1]〔F3b MED-3〕no_code 且 resolved_at 有值 → chip 内同样应出现 .si-dev-chip-time ──
        //   补齐 `statusKey === 'code_submitted' || statusKey === 'no_code'` 的另一半正面覆盖（见上方
        //   夹具区注释）。
        const nocodeChip = chipOf(NAME_NOCODE);
        must(!!nocodeChip, `[T1] 前置：应能在 chip 列表内按姓名定位到「${NAME_NOCODE}」，实得 ${JSON.stringify(chipProbe)}`);
        must(!!nocodeChip && nocodeChip.hasTime === true,
            `[T1] ⭐〔F3b MED-3〕no_code 成员 chip 内应出现 .si-dev-chip-time，实得 hasTime=${nocodeChip && nocodeChip.hasTime}`);
        const expectMinuteNoCode = '·' + RESOLVED_AT_NOCODE.slice(0, 16);
        must(!!nocodeChip && nocodeChip.timeText === expectMinuteNoCode,
            `[T1] ⭐〔F3b MED-3〕no_code 的 .si-dev-chip-time 文本应精确等于 siFmtDT(resolved_at) 前缀「·」，`
            + `期望="${expectMinuteNoCode}"，实得 "${nocodeChip && nocodeChip.timeText}"`);
        must(!!nocodeChip && nocodeChip.timeTitle === RESOLVED_AT_NOCODE,
            `[T1] ⭐〔F3b MED-3〕no_code 的 title 应精确等于 siFmtDTSec(resolved_at)，期望="${RESOLVED_AT_NOCODE}"，`
            + `实得 "${nocodeChip && nocodeChip.timeTitle}"`);

        // ── [T2] 对照组：同单内 pending / excused 两种"不该显示"的形态 ────────────────────
        console.log('\n── [T2] 对照组——pending（resolved_at 空）+ excused（resolved_at 有值但态不符） ──');
        const pendingChip = chipOf(NAME_PENDING);
        must(!!pendingChip, `[T2] 前置：应能在 chip 列表内按姓名定位到「${NAME_PENDING}」，实得 ${JSON.stringify(chipProbe)}`);
        must(!!pendingChip && pendingChip.hasTime === false,
            `[T2] ⭐ pending 成员（resolved_at 为空）chip 内不应出现 .si-dev-chip-time，实得 hasTime=${pendingChip && pendingChip.hasTime}`);
        const excusedChip = chipOf(NAME_EXCUSED);
        must(!!excusedChip, `[T2] 前置：应能在 chip 列表内按姓名定位到「${NAME_EXCUSED}」，实得 ${JSON.stringify(chipProbe)}`);
        must(!!excusedChip && excusedChip.hasTime === false,
            `[T2] ⭐ excused 成员（resolved_at 有值但非 code_submitted/no_code 两态）chip 内不应出现 `
            + `.si-dev-chip-time——若此断言被"只判 resolved_at 真值"的退化条件放过会转红，`
            + `实得 hasTime=${excusedChip && excusedChip.hasTime}`);

        // ── [T4] 估时弹窗回填提示——「最近一次估时/评估由 X 于 Y 填写」───────────────────────────
        //   siModalEstimate 直调（同 test-issue-commit-groups-playwright.js 等既有套件的
        //   `siModalSubmit(siDetail.issue)` 范式——bare identifier，非 window.siDetail：siDetail 用
        //   `let` 声明，顶层 let/const 不挂到 window 上，只有函数声明才会；页面脚本无 IIFE 包裹，
        //   page.evaluate 注入的代码与页面脚本同一全局作用域，裸标识符可直接读到）。夹具 type 恒为
        //   'bug'（mkIssue 固定写死），effortApplicable=false ⇒ 弹窗内不会多出 estimated_effort_days
        //   的 `.u-hint`（工期字段的 hint 也用同一个类），本组 `#siMBody .u-hint` 定位不会撞车。
        console.log('\n── [T4] 估时弹窗回填提示 ──');
        const NAME_ESTIMATOR = `估时填写测试-${RUN_TAG}`;
        const ESTIMATE_EVENT_AT = '2026-08-05 14:25:33';
        const iEstPos = await mkIssue(`DUX-估时提示-${RUN_TAG}`, '处理中');
        await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, ['2026-08-05 18:00:00', iEstPos]);
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name, created_at)
                   VALUES (?, 'estimate', ?, 9101, ?, ?)`, [iEstPos, '2026-08-05 18:00', NAME_ESTIMATOR, ESTIMATE_EVENT_AT]);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iEstPos);
        await page.waitForTimeout(600);
        const drawerTitleEst = await page.evaluate(() => {
            const el = document.getElementById('siDTitle');
            return el ? el.textContent.trim() : null;
        });
        must(!!drawerTitleEst && new RegExp(`^#${iEstPos}(?!\\d)`).test(drawerTitleEst),
            `[T4] 前置：抽屉确已切到 #${iEstPos}（siDTitle 应以该编号开头），实得 "${drawerTitleEst}"`);

        await page.evaluate(() => { siModalEstimate(siDetail.issue); });
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        const hintProbePos = await page.evaluate(() => {
            const overlayOpen = document.getElementById('siModalOverlay').classList.contains('open');
            const hasDtField = !!document.getElementById('f_dev_estimated_at');   // 正面锚点：弹窗确已渲染出真实表单字段
            const hintEl = document.querySelector('#siMBody .u-hint');
            return { overlayOpen, hasDtField, hintText: hintEl ? hintEl.textContent : null };
        });
        must(hintProbePos.overlayOpen === true && hintProbePos.hasDtField === true,
            `[T4] 前置：估时弹窗确已打开且渲染出表单字段（防"弹窗没开、下面的存在性断言碰巧为真"的假绿），实得 ${JSON.stringify(hintProbePos)}`);
        must(!!hintProbePos.hintText && hintProbePos.hintText.includes(`最近一次估时/评估由 ${NAME_ESTIMATOR} 于`),
            `[T4] ⭐ 弹窗内应出现「最近一次估时/评估由 ${NAME_ESTIMATOR} 于」提示，实得 "${hintProbePos.hintText}"`);
        const expectEstMinute = ESTIMATE_EVENT_AT.slice(0, 16);   // 同既有套件范式：锁定当前展示格式（siFmtDT 分钟精度），不真调该函数
        must(!!hintProbePos.hintText && !/\d{2}:\d{2}:\d{2}/.test(hintProbePos.hintText),
            `[T4] 提示内时间不应带秒（应为 siFmtDT 分钟精度而非 siFmtDTSec），实得 "${hintProbePos.hintText}"`);
        must(!!hintProbePos.hintText && hintProbePos.hintText.trim() === `最近一次估时/评估由 ${NAME_ESTIMATOR} 于 ${expectEstMinute} 填写`,
            `[T4] ⭐ 提示文本应精确等于「最近一次估时/评估由 X 于 Y 填写」形态（Y=该 estimate 事件 created_at 的分钟精度），`
            + `期望="最近一次估时/评估由 ${NAME_ESTIMATOR} 于 ${expectEstMinute} 填写"，实得 "${hintProbePos.hintText}"`);

        await page.evaluate(() => { window.siCloseModal && window.siCloseModal(); });
        await page.waitForTimeout(200);

        // ── [T4] 对照组：dev_estimated_at 为空（无 estimate/feasibility 事件）→ 提示行不存在 ──────
        const iEstNeg = await mkIssue(`DUX-估时提示对照-${RUN_TAG}`, '处理中');
        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iEstNeg);
        await page.waitForTimeout(600);
        const drawerTitleEstNeg = await page.evaluate(() => {
            const el = document.getElementById('siDTitle');
            return el ? el.textContent.trim() : null;
        });
        must(!!drawerTitleEstNeg && new RegExp(`^#${iEstNeg}(?!\\d)`).test(drawerTitleEstNeg),
            `[T4] 前置：对照单抽屉确已切到 #${iEstNeg}，实得 "${drawerTitleEstNeg}"`);

        await page.evaluate(() => { siModalEstimate(siDetail.issue); });
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        const hintProbeNeg = await page.evaluate(() => {
            const overlayOpen = document.getElementById('siModalOverlay').classList.contains('open');
            const hasDtField = !!document.getElementById('f_dev_estimated_at');
            const hintEl = document.querySelector('#siMBody .u-hint');
            return { overlayOpen, hasDtField, hasHint: !!hintEl };
        });
        must(hintProbeNeg.overlayOpen === true && hintProbeNeg.hasDtField === true,
            `[T4] 前置：对照单估时弹窗确已打开且渲染出表单字段，实得 ${JSON.stringify(hintProbeNeg)}`);
        must(hintProbeNeg.hasHint === false,
            `[T4] ⭐ 对照组：dev_estimated_at 为空（无 estimate 事件）时弹窗内不应出现 .u-hint 提示行`
            + `（选择器非恒真——若判断条件退化成恒真，这条会转红），实得 hasHint=${hintProbeNeg.hasHint}`);

        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── [T4]〔F3b F2-LOW-3①〕对照隔离夹具：dev_estimated_at 有值，但 timeline 只有 created 事件
        //   （无 estimate/feasibility）→ 弹窗内仍不应出现 .u-hint。上面 [T4] 对照组测的是
        //   dev_estimated_at 为空这一条件本身就短路返回（`if (!iss.dev_estimated_at) return '';`），
        //   没测到"事件缺失"这另一半判断；本组把 dev_estimated_at 单独钉成有值，专门堵"只判
        //   dev_estimated_at 真值、不核对 timeline 里是否真有匹配事件"这种退化写法。
        const iEstNoEvent = await mkIssue(`DUX-估时提示无事件-${RUN_TAG}`, '处理中');
        await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, ['2026-08-05 20:00:00', iEstNoEvent]);
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
                   VALUES (?, 'created', ?, 1, '管理员')`, [iEstNoEvent, `F3b 对照隔离夹具-${RUN_TAG}`]);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iEstNoEvent);
        await page.waitForTimeout(600);
        const drawerTitleNoEvent = await page.evaluate(() => {
            const el = document.getElementById('siDTitle');
            return el ? el.textContent.trim() : null;
        });
        must(!!drawerTitleNoEvent && new RegExp(`^#${iEstNoEvent}(?!\\d)`).test(drawerTitleNoEvent),
            `[T4]〔F3b F2-LOW-3①〕前置：对照隔离夹具抽屉确已切到 #${iEstNoEvent}，实得 "${drawerTitleNoEvent}"`);

        await page.evaluate(() => { siModalEstimate(siDetail.issue); });
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        const hintProbeNoEvent = await page.evaluate(() => {
            const overlayOpen = document.getElementById('siModalOverlay').classList.contains('open');
            const hasDtField = !!document.getElementById('f_dev_estimated_at');
            const hintEl = document.querySelector('#siMBody .u-hint');
            return { overlayOpen, hasDtField, hasHint: !!hintEl };
        });
        must(hintProbeNoEvent.overlayOpen === true && hintProbeNoEvent.hasDtField === true,
            `[T4]〔F3b F2-LOW-3①〕前置：对照隔离夹具估时弹窗确已打开且渲染出表单字段，实得 ${JSON.stringify(hintProbeNoEvent)}`);
        must(hintProbeNoEvent.hasHint === false,
            `[T4]〔F3b F2-LOW-3①〕⭐ dev_estimated_at 有值但 timeline 无匹配事件时 .u-hint 仍不应出现`
            + `（单独钉死"事件缺失不伪造"——不能只判 dev_estimated_at 真值），实得 hasHint=${hintProbeNoEvent.hasHint}`);

        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── [T4]〔F3b F2-LOW-3②〕可行性弹窗正例：nf=1 feature 单 + 一条 feasibility 事件 +
        //   dev_estimated_at 有值 → siModalFeasibility 打开，断言首个 .u-hint 精确等值 +
        //   feasibilityFields 重构未丢三个既有字段。mkIssue 固定写死 type='bug'，本夹具需要
        //   type='feature'/needs_feasibility=1，故不经 mkIssue，直接仿其 SQL 形状插入并手动登记
        //   createdIssueIds（finally 段清理据此按 issue_id 统一处理，不需要额外分支）。
        console.log('\n── [T4]〔F3b F2-LOW-3②〕可行性弹窗回填提示——正例 ──');
        const NAME_FEAS_ESTIMATOR = `可行性填写测试-${RUN_TAG}`;
        const FEASIBILITY_EVENT_AT = '2026-08-06 10:20:05';
        const iFeasPos = (await run(
            `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required, needs_feasibility)
             VALUES ('feature', ?, ?, ?, '内部', 1, '管理员', 1, 1)`,
            ['待受理', `DUX-可行性提示-${RUN_TAG}`, FIXTURE_SYSTEM]
        )).lastID;
        createdIssueIds.push(iFeasPos);
        await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, ['2026-08-06 12:00:00', iFeasPos]);
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name, created_at)
                   VALUES (?, 'feasibility', ?, 9102, ?, ?)`, [iFeasPos, '结论：可行', NAME_FEAS_ESTIMATOR, FEASIBILITY_EVENT_AT]);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iFeasPos);
        await page.waitForTimeout(600);
        const drawerTitleFeas = await page.evaluate(() => {
            const el = document.getElementById('siDTitle');
            return el ? el.textContent.trim() : null;
        });
        must(!!drawerTitleFeas && new RegExp(`^#${iFeasPos}(?!\\d)`).test(drawerTitleFeas),
            `[T4]〔F3b F2-LOW-3②〕前置：可行性正例抽屉确已切到 #${iFeasPos}，实得 "${drawerTitleFeas}"`);

        await page.evaluate(() => { siModalFeasibility(siDetail.issue); });
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        const feasHintProbe = await page.evaluate(() => {
            const overlayOpen = document.getElementById('siModalOverlay').classList.contains('open');
            const hasConclusion = !!document.getElementById('f_conclusion');
            const hasReqConfirm = !!document.getElementById('f_requirement_confirm');
            const hasEffortDays = !!document.getElementById('f_estimated_effort_days');
            const hints = [...document.querySelectorAll('#siMBody .u-hint')];
            return {
                overlayOpen, hasConclusion, hasReqConfirm, hasEffortDays,
                hintCount: hints.length,
                firstHintText: hints.length ? hints[0].textContent : null,
            };
        });
        must(feasHintProbe.overlayOpen === true,
            `[T4]〔F3b F2-LOW-3②〕前置：可行性弹窗确已打开，实得 ${JSON.stringify(feasHintProbe)}`);
        must(feasHintProbe.hasConclusion === true && feasHintProbe.hasReqConfirm === true && feasHintProbe.hasEffortDays === true,
            `[T4]〔F3b F2-LOW-3②〕⭐ feasibilityFields 重构未丢字段：#f_conclusion/#f_requirement_confirm/`
            + `#f_estimated_effort_days 三字段仍应在，实得 ${JSON.stringify(feasHintProbe)}`);
        // ⚠️ feature 单工期字段自带 .u-hint（fNumber 的 hint 参数，恒必填故恒渲染），弹窗内恒有 ≥1 个
        // .u-hint——单纯"存在性"挡不住回归，须用"首个 .u-hint 精确等值文本"定位（新增的提示字段排在
        // feasibilityFields 数组最前，DOM 序上先于工期字段那个）。
        const expectFeasMinute = FEASIBILITY_EVENT_AT.slice(0, 16);
        must(feasHintProbe.hintCount >= 1,
            `[T4]〔F3b F2-LOW-3②〕弹窗内应至少有 1 个 .u-hint（工期字段自带的那个恒在），实得 ${feasHintProbe.hintCount}`);
        must(feasHintProbe.firstHintText === `最近一次估时/评估由 ${NAME_FEAS_ESTIMATOR} 于 ${expectFeasMinute} 填写`,
            `[T4]〔F3b F2-LOW-3②〕⭐ 首个 .u-hint 应精确等于「最近一次估时/评估由 X 于 Y 填写」，`
            + `期望="最近一次估时/评估由 ${NAME_FEAS_ESTIMATOR} 于 ${expectFeasMinute} 填写"，实得 "${feasHintProbe.firstHintText}"`);

        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── [T5]「开发」列排序键与显示同源 ─────────────────────────────────────────
        //   机制查证（unify-helpers.js，跑本文件前已读源码核实，非猜测）：
        //   ① compareRow(a,b,field,...)（:111-122）直接读 `a[field]`/`b[field]`，无 accessor/getter 机制
        //      ——排序键必须是真实挂在行对象上的字段，故 F3 在 siLoadList 里逐行补 dev_roster_sort
        //      （Sys_Iteration.html 该处调用点），不是只在渲染期现算。
        //   ② fieldTypes 是 `{ field: 'number'|'date'|'statusOrder'|'labelMap'|'string' }` 的静态表，
        //      直接传给 compareByType 分派比较器；'string' 分支（:106-107）是 String(va).localeCompare
        //      (String(vb), 'zh-Hans-CN')。
        //   ③ ⚠️ 点击语义与直觉相反——attachTableSort 的表头点击处理（:304-321）：切到新列
        //      `currentSortBy !== field` 时**无条件**置 `currentSortDir = 'desc'`（非常见的"首点进 asc"
        //      直觉），同列二次点击才翻 asc，三次点回落 defaultSort。故下面断言顺序是"首点 desc、
        //      二次点 asc"，与调用方最初设想的"先升序后降序"相反——已按源码实测口径改写，非维持原假设。
        console.log('\n── [T5]「开发」列排序键与显示同源 ──');
        const NAME_SORT_A = `SORTA-${RUN_TAG}`;
        const NAME_SORT_Z = `SORTZ-${RUN_TAG}`;
        const NAME_SORT_M_FALLBACK = `SORTM回退-${RUN_TAG}`;   // 走 assigned_to_name 回退链，非 roster 直接值
        const iSortA = await mkIssue(`DUX-列排序A-${RUN_TAG}`, '处理中');
        await mkMember(iSortA, 9201, NAME_SORT_A, 'pending', null);
        const iSortZ = await mkIssue(`DUX-列排序Z-${RUN_TAG}`, '处理中');
        await mkMember(iSortZ, 9202, NAME_SORT_Z, 'pending', null);
        const iSortMFallback = await mkIssue(`DUX-列排序M回退-${RUN_TAG}`, '处理中');
        await run(`UPDATE sys_issues SET assigned_to_name = ? WHERE id = ?`, [NAME_SORT_M_FALLBACK, iSortMFallback]);
        // iSortMFallback 故意**零 roster 行**（不调 mkMember）——验证 dev_roster_sort 的回退链
        // （siDevRosterSortValue：无在册成员 → 回退 assigned_to_name）真的参与排序，不是只在显示层兜底。

        // 〔预筛 LOW-4②〕3 人 roster 夹具——证排序键用**全量** join 串而非显示截断后的「前2名+等+1」串。
        //   构造依据（node -e 实测 localeCompare('zh-Hans-CN') 逐字验证，非手推）：显示截断串固定以
        //   "等+1" 收尾、真实排序串以"、第3人姓名"收尾——对同一份 2 人共享前缀，这两种后缀在该
        //   locale 下比较结果恒为「"、"开头的后缀 < "等+1"开头的后缀」，即 fullKey < truncatedDisplay。
        //   造一个"锚点"值卡在两者之间（fullKey < 锚点 < truncatedDisplay），3 人夹具的真实渲染位置
        //   落在锚点哪一侧就能反证用的是全量串还是截断串：真实排序键=全量串 ⇒ 升序时 3 人夹具应排在
        //   锚点**之前**；若代码退化成用显示层截断串排序，会错误排到锚点**之后**。
        //   member1/member2 与既有 M 单 assigned_to_name 共享前缀"SORTM回退-{TAG}、ZZZ-{TAG}"，
        //   member3（filler）只进真实排序键，不出现在"前2名+等+1"显示文本里（SI_DEV_ROSTER_MAX_SHOW=2）。
        const NAME_SORT3_1 = `SORTM回退-${RUN_TAG}`;
        const NAME_SORT3_2 = `ZZZ-${RUN_TAG}`;
        const NAME_SORT3_3 = `filler-${RUN_TAG}`;
        const NAME_SORT_ANCHOR = `SORTM回退-${RUN_TAG}、ZZZ-${RUN_TAG}9`;
        const iSort3 = await mkIssue(`DUX-列排序3人-${RUN_TAG}`, '处理中');
        await mkMember(iSort3, 9203, NAME_SORT3_1, 'pending', null);
        await mkMember(iSort3, 9204, NAME_SORT3_2, 'pending', null);
        await mkMember(iSort3, 9205, NAME_SORT3_3, 'pending', null);
        const iSortAnchor = await mkIssue(`DUX-列排序锚点-${RUN_TAG}`, '处理中');
        await run(`UPDATE sys_issues SET assigned_to_name = ? WHERE id = ?`, [NAME_SORT_ANCHOR, iSortAnchor]);

        // 〔F9·LOW〕浏览器端排序前提断言——上面"fullKey < 锚点 < truncatedDisplay"是用 `node -e` 跑
        // Node 自带 ICU 实测出来的结论；真正参与页面排序比较的是 Chromium 内置的 ICU 实现，两者在个别
        // locale/字符集上可能存在版本或实现差异。下面业务断言（idx3Asc < idxAnchorAsc 等）建立在这条
        // 前提成立之上，若浏览器端前提不成立，业务断言失败会被误读成"排序逻辑坏了"，实则是环境差异——
        // 在业务断言前显式核验，给出明确的"排序前提在本浏览器环境不成立"诊断，不是环境相关假红。
        const sortPremise = await page.evaluate(({ n1, n2, n3, anchor }) => {
            const fullKey = `${n1}、${n2}、${n3}`;
            const truncatedDisplay = `${n1}、${n2}等+1`;
            const cmpFullAnchor = fullKey.localeCompare(anchor, 'zh-Hans-CN');
            const cmpAnchorTrunc = anchor.localeCompare(truncatedDisplay, 'zh-Hans-CN');
            return { ok: cmpFullAnchor < 0 && cmpAnchorTrunc < 0, cmpFullAnchor, cmpAnchorTrunc, fullKey, truncatedDisplay };
        }, { n1: NAME_SORT3_1, n2: NAME_SORT3_2, n3: NAME_SORT3_3, anchor: NAME_SORT_ANCHOR });
        must(!!sortPremise && sortPremise.ok === true,
            `[T5] 前置：浏览器端 localeCompare('zh-Hans-CN') 应满足 fullKey < 锚点 < truncatedDisplay（Node ICU `
            + `侧已用 node -e 实测验证，这里核验 Chromium ICU 是否给出一致结果——不一致时以下夹具构造失败，`
            + `非排序逻辑问题），实得 ${JSON.stringify(sortPremise)}`);

        // T4 结束时估时弹窗与详情抽屉的遮罩（#siOverlay.open）仍在，会拦截表头的 pointer 事件——
        // 先关弹窗再关抽屉并等遮罩退场，否则 page.click 表头恒超时（首跑实证：57 次重试全被 overlay 拦截）。
        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(400);
        // 重取列表（三个夹具在 page.goto 之后才插入，siList 是页面初次加载时的快照，须显式刷新才含它们）
        await page.evaluate(() => window.siLoadList && window.siLoadList());
        await page.waitForTimeout(600);
        // 用列表搜索框收窄可见集（同 test-sys-commit-cols-playwright.js [T30] 的既有范式：siMatchSearch
        // 按 title 子串匹配，本轮全部夹具标题都嵌 RUN_TAG），防分页把某个夹具挤到第 2 页而不自知。
        await page.fill('#siFSearch', String(RUN_TAG));
        await page.waitForTimeout(400);   // siDebounceSearch 250ms 防抖 + siRenderTable 渲染

        // 读取当前 tbody 每行的 id（第 1 列）+「开发」列文本（第 7 列，0-based index 6，见
        // renderSysIterationRows 的 <td> 顺序：id/type/pri/status/title/system/开发/建单人…）。
        const readDevColOrder = () => page.evaluate(() => {
            const rows = [...document.querySelectorAll('#siTbody tr')];
            return rows.map(r => {
                const tds = r.querySelectorAll('td');
                const idText = tds[0] ? tds[0].textContent.trim() : '';
                const devText = tds[6] ? tds[6].textContent.trim() : '';
                return { id: idText.replace('#', ''), devText };
            });
        });
        const idxOf = (order, id) => order.findIndex(r => Number(r.id) === Number(id));

        const preClickOrder = await readDevColOrder();
        must([iSortA, iSortZ, iSortMFallback, iSort3, iSortAnchor].every(id => idxOf(preClickOrder, id) >= 0),
            `[T5] 前置锚点：搜索收窄后 5 个排序夹具都应在当前视图内（防某个被分页挤出导致后续断言假绿），`
            + `实得 ${JSON.stringify(preClickOrder.map(r => r.id))}`);

        // 首次点击「开发」表头
        await page.click('#sysIterationListTable thead th[data-sort-by="dev_roster_sort"]');
        await page.waitForTimeout(300);
        const dirAfterFirstClick = await page.$eval(
            '#sysIterationListTable thead th[data-sort-by="dev_roster_sort"] .u-sort-icon', el => el.textContent);
        must(dirAfterFirstClick === '↓',
            `[T5] 前置：首次点「开发」表头应进入 desc（共享排序层"切新列首点必 desc"机制，见上方机制查证③），`
            + `图标实得 "${dirAfterFirstClick}"`);
        const descOrder = await readDevColOrder();
        const idxADesc = idxOf(descOrder, iSortA), idxZDesc = idxOf(descOrder, iSortZ), idxMDesc = idxOf(descOrder, iSortMFallback);
        must(idxADesc >= 0 && idxZDesc >= 0 && idxMDesc >= 0,
            `[T5] 降序视图下 3 个夹具仍都应可见，实得 idxA=${idxADesc} idxZ=${idxZDesc} idxM=${idxMDesc}`);
        must(idxZDesc < idxMDesc && idxMDesc < idxADesc,
            `[T5] ⭐ 降序应为 Z（roster 直接值）> M（assigned_to_name 回退值——证回退链真参与排序，非仅显示层兜底）`
            + ` > A（roster 直接值），实得 idxZ=${idxZDesc} idxM=${idxMDesc} idxA=${idxADesc}（视图内 id 序=${JSON.stringify(descOrder.map(r => r.id))}）`);
        const idx3Desc = idxOf(descOrder, iSort3), idxAnchorDesc = idxOf(descOrder, iSortAnchor);
        must(idx3Desc >= 0 && idxAnchorDesc >= 0,
            `[T5]〔预筛 LOW-4②〕降序视图下 3 人夹具与锚点夹具都应可见，实得 idx3=${idx3Desc} idxAnchor=${idxAnchorDesc}`);
        must(idxAnchorDesc < idx3Desc,
            `[T5]〔预筛 LOW-4②〕⭐ 降序：锚点单应排在 3 人夹具**之前**（升序方向相反，见下方二次点击后的`
            + `同款断言）——真实排序键用全量 3 人 join 串，若代码退化成用显示层截断串「前2名+等+1」排序，`
            + `3 人夹具会跑到锚点错误的一侧，实得 idxAnchor=${idxAnchorDesc} idx3=${idx3Desc}`);

        // 二次点击「开发」表头——同列二次点击才翻 asc（机制查证③）
        await page.click('#sysIterationListTable thead th[data-sort-by="dev_roster_sort"]');
        await page.waitForTimeout(300);
        const dirAfterSecondClick = await page.$eval(
            '#sysIterationListTable thead th[data-sort-by="dev_roster_sort"] .u-sort-icon', el => el.textContent);
        must(dirAfterSecondClick === '↑', `[T5] 二次点「开发」表头应翻 asc，图标实得 "${dirAfterSecondClick}"`);
        const ascOrder = await readDevColOrder();
        const idxAAsc = idxOf(ascOrder, iSortA), idxZAsc = idxOf(ascOrder, iSortZ), idxMAsc = idxOf(ascOrder, iSortMFallback);
        must(idxAAsc >= 0 && idxZAsc >= 0 && idxMAsc >= 0,
            `[T5] 升序视图下 3 个夹具仍都应可见，实得 idxA=${idxAAsc} idxZ=${idxZAsc} idxM=${idxMAsc}`);
        must(idxAAsc < idxMAsc && idxMAsc < idxZAsc,
            `[T5] ⭐ 升序应为 A（roster 直接值）< M（assigned_to_name 回退值参与排序）< Z（roster 直接值），`
            + `实得 idxA=${idxAAsc} idxM=${idxMAsc} idxZ=${idxZAsc}（视图内 id 序=${JSON.stringify(ascOrder.map(r => r.id))}）`);
        const idx3Asc = idxOf(ascOrder, iSort3), idxAnchorAsc = idxOf(ascOrder, iSortAnchor);
        must(idx3Asc >= 0 && idxAnchorAsc >= 0,
            `[T5]〔预筛 LOW-4②〕升序视图下 3 人夹具与锚点夹具都应可见，实得 idx3=${idx3Asc} idxAnchor=${idxAnchorAsc}`);
        must(idx3Asc < idxAnchorAsc,
            `[T5]〔预筛 LOW-4②〕⭐ 升序：3 人夹具应排在锚点单**之前**——真实排序键（全量 3 人 join 串）经`
            + `node -e 实测 localeCompare('zh-Hans-CN') 严格小于锚点值；若代码退化成用显示层截断串`
            + `「前2名+等+1」排序，截断串反而大于锚点值，3 人夹具会错误排到锚点**之后**，本条能抓到这个`
            + `退化，实得 idx3=${idx3Asc} idxAnchor=${idxAnchorAsc}`);
        const devText3 = ascOrder[idx3Asc] ? ascOrder[idx3Asc].devText : null;
        must(devText3 === `${NAME_SORT3_1}、${NAME_SORT3_2}等+1`,
            `[T5]〔预筛 LOW-4②〕⭐ 3 人夹具「开发」列文本应显示截断形态「前2名+等+1」，`
            + `期望="${NAME_SORT3_1}、${NAME_SORT3_2}等+1"，实得 "${devText3}"`);

        // 显示同源：「开发」列文本本身应精确等于派生串所本的姓名，不是"恰好排对但显示还是旧值"
        const devTextA = ascOrder[idxAAsc].devText;
        must(devTextA === NAME_SORT_A,
            `[T5] ⭐ 显示同源：A 单「开发」列文本应精确等于 roster 姓名 "${NAME_SORT_A}"，实得 "${devTextA}"`);
        const devTextM = ascOrder[idxMAsc].devText;
        must(devTextM === NAME_SORT_M_FALLBACK,
            `[T5] ⭐ 显示同源：M 单（零 roster）「开发」列文本应精确等于 assigned_to_name 回退值 "${NAME_SORT_M_FALLBACK}"，实得 "${devTextM}"`);

        // 复位搜索框，不把过滤态残留带进后续用例（同既有套件收尾范式）
        await page.fill('#siFSearch', '');
        await page.waitForTimeout(400);

        // ── [T6] 时间线渲染层三合一（C5a 补映射 + C5b 噪音折叠 + C5d 存量转译） ──────────────
        //   一单夹具直插 7 条 timeline 行（6 类 + ⑤对照组），逐行按 operator_name 唯一值定位——
        //   不依赖 DOM 顺序/索引，即便未来渲染顺序调整（如加排序/分组）断言仍稳。
        console.log('\n── [T6] 时间线渲染层三合一 ──');
        const iTimeline = await mkIssue(`DUX-时间线折叠-${RUN_TAG}`, '处理中');
        const OP_INTAKE_ACCEPT = `TL操作员甲受理-${RUN_TAG}`;
        const OP_NOTIFY_OK = `TL操作员乙通知成功-${RUN_TAG}`;
        const OP_ESTIMATE = `TL操作员丙估时-${RUN_TAG}`;
        const OP_WGATE_FORWARD = `TL操作员丁前进-${RUN_TAG}`;
        const OP_WGATE_BACKWARD = `TL操作员戊回退-${RUN_TAG}`;
        const OP_UNKNOWN = `TL操作员己未知码-${RUN_TAG}`;
        const OP_NOTIFY_FAIL = `TL操作员庚通知失败-${RUN_TAG}`;
        // 唯一存量硬编码定值——精确等值，出处见 Sys_Iteration.html SI_TL_WGATE_LEGACY_SUMMARY 声明处
        // （git 历史逐字核对，同 docs/local/系统迭代/时间线写入点码表_20260810.md §W-GATE 存量转译白名单）。
        const WGATE_LEGACY_SUMMARY = 'W-GATE 自动门禁转移（成员在册完成态变化）';

        // ①：status_change + action_code=intake_accept
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name, action_code)
                   VALUES (?, 'status_change', '待受理', '待指派', '受理通过', 1, ?, 'intake_accept')`, [iTimeline, OP_INTAKE_ACCEPT]);
        // ②：note + action_code=notify_sent，成功形态，含 message_key 与 (id13)
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
                   VALUES (?, 'note', ?, 'notify_sent', 1, ?)`,
            [iTimeline, '发送开发通知 → 测试员(id13)：成功（message_key=abcXYZ123）', OP_NOTIFY_OK]);
        // ③：estimate 裸值行
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
                   VALUES (?, 'estimate', '2026-08-10 18:00', 1, ?)`, [iTimeline, OP_ESTIMATE]);
        // ④a：存量 W-GATE，to_status=待验证（VERIFY，前进方向）
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
                   VALUES (?, 'status_change', '开发中', '待验证', ?, 1, ?)`, [iTimeline, WGATE_LEGACY_SUMMARY, OP_WGATE_FORWARD]);
        // ④b：存量 W-GATE，to_status=处理中（DEV 族，回弹方向）
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name)
                   VALUES (?, 'status_change', '待验证', '处理中', ?, 1, ?)`, [iTimeline, WGATE_LEGACY_SUMMARY, OP_WGATE_BACKWARD]);
        // ⑤：对照组——未知 action_code，SI_TL_LABEL 里找不到
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, operator_id, operator_name, action_code)
                   VALUES (?, 'status_change', '开发中', '处理中', '未知机制探针', 1, ?, ?)`,
            [iTimeline, OP_UNKNOWN, `zz_unknown_probe_${RUN_TAG}`]);
        // ⑥：note + action_code=notify_sent，失败形态，who 也含 (id99)（真实产线 who 恒 (idN) 形态）
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
                   VALUES (?, 'note', ?, 'notify_sent', 1, ?)`,
            [iTimeline, '发送开发通知 → 测试员(id99)：失败（失败=钉钉超时）', OP_NOTIFY_FAIL]);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iTimeline);
        await page.waitForTimeout(600);
        const drawerTitleTl = await page.evaluate(() => {
            const el = document.getElementById('siDTitle');
            return el ? el.textContent.trim() : null;
        });
        must(!!drawerTitleTl && new RegExp(`^#${iTimeline}(?!\\d)`).test(drawerTitleTl),
            `[T6] 前置：抽屉确已切到 #${iTimeline}（siDTitle 应以该编号开头），实得 "${drawerTitleTl}"`);

        // 逐行采集：evtText=徽章文本，opText=操作人（用于定位），bodyText/bodyInnerHTML=正文全量，
        // summarySpanTitle/summarySpanText=C5b/C5d 折叠后挂 title 的包裹 span（未触发折叠/转译的行没有
        // 这个 span，两字段为 null——.si-tl-evt/.si-tl-op/.si-tl-att 均不带 title 属性，`span[title]`
        // 在 .si-tl-body 内只可能命中本批新增的包裹 span，不会误中其它既有元素）。
        const tlRows = await page.evaluate(() => {
            const items = [...document.querySelectorAll('#siDBody .si-timeline .si-tl-item')];
            return items.map(it => {
                const evtEl = it.querySelector('.si-tl-evt');
                const opEl = it.querySelector('.si-tl-op');
                const body = it.querySelector('.si-tl-body');
                const summarySpan = body ? body.querySelector('span[title]') : null;
                return {
                    evtText: evtEl ? evtEl.textContent.trim() : null,
                    opText: opEl ? opEl.textContent.trim() : null,
                    bodyText: body ? body.textContent : null,
                    bodyInnerHTML: body ? body.innerHTML : null,
                    summarySpanTitle: summarySpan ? summarySpan.getAttribute('title') : null,
                    summarySpanText: summarySpan ? summarySpan.textContent : null,
                };
            });
        });
        const rowOf = (opName) => tlRows.find(r => r.opText && r.opText.includes(opName));

        // 前置锚点：7 条夹具行都应能按 operator_name 在渲染结果里定位到（防某条因异常被吞、后面的
        // 存在性断言在错误的"undefined vs undefined"上假绿）
        const allOps = [OP_INTAKE_ACCEPT, OP_NOTIFY_OK, OP_ESTIMATE, OP_WGATE_FORWARD, OP_WGATE_BACKWARD, OP_UNKNOWN, OP_NOTIFY_FAIL];
        must(allOps.every(op => !!rowOf(op)),
            `[T6] 前置：7 条夹具 timeline 行应都能按 operator_name 在渲染结果里定位到，实得 ${JSON.stringify(tlRows.map(r => r.opText))}`);

        // ① C5a：status_change+action_code=intake_accept 徽章应为「受理」（非裸码）
        const rowIntakeAccept = rowOf(OP_INTAKE_ACCEPT);
        must(!!rowIntakeAccept && rowIntakeAccept.evtText === '受理',
            `[T6]① ⭐ C5a：intake_accept 徽章应为「受理」，实得 "${rowIntakeAccept && rowIntakeAccept.evtText}"`);

        // ② C5b：notify_sent 成功形态——message_key/(id13) 均从正文摘除，title 挂原文
        const rowNotifyOk = rowOf(OP_NOTIFY_OK);
        must(!!rowNotifyOk && !rowNotifyOk.bodyText.includes('message_key='),
            `[T6]② ⭐ C5b：notify_sent 成功行正文不应含 "message_key="，实得 bodyText="${rowNotifyOk && rowNotifyOk.bodyText}"`);
        must(!!rowNotifyOk && !rowNotifyOk.bodyText.includes('(id13)'),
            `[T6]② ⭐ C5b：notify_sent 成功行正文不应含 "(id13)"，实得 bodyText="${rowNotifyOk && rowNotifyOk.bodyText}"`);
        must(!!rowNotifyOk && rowNotifyOk.summarySpanText === '发送开发通知 → 测试员：成功',
            `[T6]② ⭐ C5b：折叠后正文应精确等于「发送开发通知 → 测试员：成功」，实得 "${rowNotifyOk && rowNotifyOk.summarySpanText}"`);
        must(!!rowNotifyOk && !!rowNotifyOk.summarySpanTitle && rowNotifyOk.summarySpanTitle.includes('message_key=abcXYZ123') && rowNotifyOk.summarySpanTitle.includes('(id13)'),
            `[T6]② ⭐ C5b：title 应含完整原文（含 message_key 与 (id13)，凭证不丢），实得 title="${rowNotifyOk && rowNotifyOk.summarySpanTitle}"`);

        // ③ C5b：estimate 行正文以「预计完成：」开头，紧跟在「回填预计」徽章之后
        const rowEstimate = rowOf(OP_ESTIMATE);
        must(!!rowEstimate && rowEstimate.bodyInnerHTML.includes('>回填预计</span>预计完成：2026-08-10 18:00'),
            `[T6]③ ⭐ C5b：estimate 行正文应紧跟在「回填预计」徽章后以「预计完成：」开头，实得 innerHTML="${rowEstimate && rowEstimate.bodyInnerHTML}"`);

        // ④ C5d：存量 W-GATE 两条——方向感知转译 + title 挂机制名原文
        const rowWgateFwd = rowOf(OP_WGATE_FORWARD);
        must(!!rowWgateFwd && rowWgateFwd.summarySpanText === '全部在册开发已完成，自动流转',
            `[T6]④ ⭐ C5d：to_status=待验证（VERIFY，前进）应译「全部在册开发已完成，自动流转」，实得 "${rowWgateFwd && rowWgateFwd.summarySpanText}"`);
        must(!!rowWgateFwd && !!rowWgateFwd.summarySpanTitle && rowWgateFwd.summarySpanTitle.includes('W-GATE 自动门禁转移'),
            `[T6]④ title 应含原机制名「W-GATE 自动门禁转移」，实得 "${rowWgateFwd && rowWgateFwd.summarySpanTitle}"`);
        const rowWgateBwd = rowOf(OP_WGATE_BACKWARD);
        must(!!rowWgateBwd && rowWgateBwd.summarySpanText === '出现新的待提交成员，自动退回开发中',
            `[T6]④ ⭐ C5d：to_status=处理中（DEV 族，回弹）应译「出现新的待提交成员，自动退回开发中」，实得 "${rowWgateBwd && rowWgateBwd.summarySpanText}"`);
        must(!!rowWgateBwd && !!rowWgateBwd.summarySpanTitle && rowWgateBwd.summarySpanTitle.includes('W-GATE 自动门禁转移'),
            `[T6]④ title 应含原机制名「W-GATE 自动门禁转移」，实得 "${rowWgateBwd && rowWgateBwd.summarySpanTitle}"`);

        // ⑤ 对照组：未知 action_code 徽章仍应裸显该码本身——证明 C5a/C5d 没有把兜底吞掉
        const rowUnknown = rowOf(OP_UNKNOWN);
        must(!!rowUnknown && rowUnknown.evtText === `zz_unknown_probe_${RUN_TAG}`,
            `[T6]⑤ ⭐ 对照组：未知 action_code 徽章仍应裸显该码本身（未知码兜底=审计可发现性保留），实得 "${rowUnknown && rowUnknown.evtText}"`);

        // ⑥ C5b：notify_sent 失败形态——(id99) 折叠，「失败=…」段保留在正文（当场要看到失败原因，不折叠）
        const rowNotifyFail = rowOf(OP_NOTIFY_FAIL);
        must(!!rowNotifyFail && !rowNotifyFail.bodyText.includes('(id99)'),
            `[T6]⑥ notify_sent 失败行正文不应含 "(id99)"，实得 bodyText="${rowNotifyFail && rowNotifyFail.bodyText}"`);
        must(!!rowNotifyFail && rowNotifyFail.bodyText.includes('失败=钉钉超时'),
            `[T6]⑥ ⭐ C5b：notify_sent 失败行「失败=…」段应保留在正文（不折叠），实得 bodyText="${rowNotifyFail && rowNotifyFail.bodyText}"`);
        must(!!rowNotifyFail && rowNotifyFail.summarySpanText === '发送开发通知 → 测试员：失败（失败=钉钉超时）',
            `[T6]⑥ ⭐ C5b：折叠后正文应精确等于「发送开发通知 → 测试员：失败（失败=钉钉超时）」（只摘 id，失败段原样），`
            + `实得 "${rowNotifyFail && rowNotifyFail.summarySpanText}"`);

        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── [T7] 发布留痕展开视图结构化（C5c） ─────────────────────────────────────
        //   一单两条 scope_change+action_code=release_published 行：①合法快照 JSON（commits 两条，一条
        //   dev_user_id 映射得到真名——用本次 seed 的 admin.id、一条映射不到——99999 断言显 #99999）
        //   ②非法 JSON（解析失败对照，维持现状文案不变）。<details> 用 page.evaluate 直接置 .open=true
        //   展开（原生 HTML 折叠机制，非本次改动对象，直接置位比算点击坐标更稳，验证的是展开后内容对不对
        //   非展开交互机制本身）。
        console.log('\n── [T7] 发布留痕展开视图结构化 ──');
        const OP_RELEASE = `TL发布留痕-${RUN_TAG}`;
        const OP_RELEASE_BAD = `TL发布留痕解析失败-${RUN_TAG}`;
        const REL_TITLE_SNAPSHOT = `发布留痕结构化夹具-${RUN_TAG}`;
        const REL_REF_FE = `fe-${RUN_TAG}`;
        const REL_REF_BE = `be-${RUN_TAG}`;
        const iRelease = await mkIssue(`DUX-发布留痕结构化-${RUN_TAG}`, '已上线');
        const releaseSnapshot = JSON.stringify({
            schema_version: 2,
            type: 'bug',
            title_snapshot: REL_TITLE_SNAPSHOT,
            status_at_publish: '已上线',
            commits: [
                { commit_id: 1, dev_assignee_id: 1, dev_user_id: admin.id, component: 'frontend', commit_ref: REL_REF_FE, created_at: '2026-08-10 10:00:00', updated_at: '2026-08-10 10:00:00' },
                { commit_id: 2, dev_assignee_id: 2, dev_user_id: 99999, component: 'backend', commit_ref: REL_REF_BE, created_at: '2026-08-10 10:05:00', updated_at: '2026-08-10 10:05:00' },
            ],
        });
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
                   VALUES (?, 'scope_change', ?, 'release_published', 1, ?)`, [iRelease, releaseSnapshot, OP_RELEASE]);
        // 解析失败对照：非法 JSON，siFormatReleasePublishedSummary 应返回 ok:false，维持现状单层 <details>+<pre> 文案不动
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, action_code, operator_id, operator_name)
                   VALUES (?, 'scope_change', ?, 'release_published', 1, ?)`, [iRelease, '这不是合法JSON{', OP_RELEASE_BAD]);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iRelease);
        await page.waitForTimeout(600);
        const drawerTitleRel = await page.evaluate(() => {
            const el = document.getElementById('siDTitle');
            return el ? el.textContent.trim() : null;
        });
        must(!!drawerTitleRel && new RegExp(`^#${iRelease}(?!\\d)`).test(drawerTitleRel),
            `[T7] 前置：抽屉确已切到 #${iRelease}（siDTitle 应以该编号开头），实得 "${drawerTitleRel}"`);

        const releaseInfo = await page.evaluate((opNames) => {
            const items = [...document.querySelectorAll('#siDBody .si-timeline .si-tl-item')];
            const findByOp = (opName) => items.find(it => {
                const op = it.querySelector('.si-tl-op');
                return op && op.textContent.includes(opName);
            });
            const extract = (item) => {
                if (!item) return null;
                const body = item.querySelector('.si-tl-body');
                const outerDetails = body ? body.querySelector('details.si-tl-release-json') : null;
                if (outerDetails) outerDetails.open = true;   // 展开一级
                const innerDetails = outerDetails ? outerDetails.querySelector('details.si-tl-release-json') : null;
                if (innerDetails) innerDetails.open = true;   // 展开二级（原始快照）
                const summaryEl = outerDetails ? outerDetails.querySelector(':scope > summary') : null;
                const statusLineEl = outerDetails ? outerDetails.querySelector(':scope > div.si-muted') : null;
                const table = outerDetails ? outerDetails.querySelector('table.si-commit-table') : null;
                const rows = table ? [...table.querySelectorAll('tbody tr')] : [];
                const rowTexts = rows.map(r => [...r.querySelectorAll('td')].map(td => td.textContent.trim()));
                const rawPre = innerDetails ? innerDetails.querySelector('pre') : null;
                return {
                    hasOuterDetails: !!outerDetails,
                    summaryBrief: summaryEl ? summaryEl.textContent : null,
                    statusLineText: statusLineEl ? statusLineEl.textContent : null,
                    hasTable: !!table,
                    rowCount: rows.length,
                    rowTexts,
                    hasInnerDetails: !!innerDetails,
                    rawText: rawPre ? rawPre.textContent : null,
                };
            };
            return {
                ok: extract(findByOp(opNames.ok)),
                bad: extract(findByOp(opNames.bad)),
            };
        }, { ok: OP_RELEASE, bad: OP_RELEASE_BAD });

        // 正例：结构化小表 + 二级折叠原始快照
        const relOk = releaseInfo.ok;
        must(!!relOk && relOk.hasOuterDetails === true,
            `[T7] 前置：合法快照行应渲染出 details.si-tl-release-json，实得 ${JSON.stringify(relOk)}`);
        must(!!relOk && !!relOk.summaryBrief && relOk.summaryBrief.includes(REL_TITLE_SNAPSHOT) && relOk.summaryBrief.includes('2 条 commit'),
            `[T7] 摘要行应含标题快照与「2 条 commit」，实得 summaryBrief="${relOk && relOk.summaryBrief}"`);
        must(!!relOk && !!relOk.statusLineText && relOk.statusLineText.includes('发布时状态：已上线'),
            `[T7] ⭐ C5c：展开区顶部应有「发布时状态：已上线」小字，实得 "${relOk && relOk.statusLineText}"`);
        must(!!relOk && relOk.rowCount === 2,
            `[T7] ⭐ C5c：commits 小表行数应=2，实得 ${relOk && relOk.rowCount}`);
        const adminDisplayName = admin.display_name || admin.username;
        must(!!relOk && Array.isArray(relOk.rowTexts) && relOk.rowTexts.some(r => r[0] === adminDisplayName && r[1] === '前端' && r[2] === REL_REF_FE),
            `[T7] ⭐ C5c：dev_user_id 映射得到（admin.id）那行应显真名「${adminDisplayName}」+「前端」+ commit_ref，`
            + `实得 ${JSON.stringify(relOk && relOk.rowTexts)}`);
        must(!!relOk && Array.isArray(relOk.rowTexts) && relOk.rowTexts.some(r => r[0] === '#99999' && r[1] === '后端' && r[2] === REL_REF_BE),
            `[T7] ⭐ C5c：dev_user_id 映射不到（99999）那行应回退显「#99999」（不伪造姓名）+「后端」+ commit_ref，`
            + `实得 ${JSON.stringify(relOk && relOk.rowTexts)}`);
        must(!!relOk && relOk.hasInnerDetails === true,
            `[T7] ⭐ C5c：小表下方应有二级折叠「查看原始快照」，实得 ${JSON.stringify(relOk)}`);
        must(!!relOk && !!relOk.rawText && relOk.rawText.includes('schema_version'),
            `[T7] 二级折叠内容应含原始 JSON（含 schema_version 字段，审计原文不丢），实得 rawText 前 100 字="${relOk && relOk.rawText && relOk.rawText.slice(0, 100)}"`);

        // 对照：解析失败维持现状——单层 details+pre「原始记录（解析失败）」文案，无结构化小表
        const relBad = releaseInfo.bad;
        must(!!relBad && relBad.hasOuterDetails === true,
            `[T7] 前置：非法 JSON 行也应渲染出 details.si-tl-release-json（旧结构未被本次改动破坏），实得 ${JSON.stringify(relBad)}`);
        must(!!relBad && !!relBad.summaryBrief && relBad.summaryBrief.includes('原始记录（解析失败）'),
            `[T7] ⭐ C5c 对照：解析失败分支应维持现状文案「原始记录（解析失败）」不动，实得 summaryBrief="${relBad && relBad.summaryBrief}"`);
        must(!!relBad && relBad.hasTable === false,
            `[T7] ⭐ C5c 对照：解析失败行不应渲染结构化 commits 小表（info.ok===false 分支不动，走不到新代码路径），实得 hasTable=${relBad && relBad.hasTable}`);

        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── [T8] 估时并发乐观锁前端接线（B1 后端 e7ecffd + F6 前端） ─────────────────────────
        //   全程走真实 UI 提交路径：page.fill('#f_dev_estimated_at', ...) + page.click('#siMConfirm')
        //   （同既有套件 test-sys-effort-days-playwright.js:157-163 的既有范式，非本文件首创），不绕过
        //   前端逻辑直接 fetch——这组测的就是前端接线本身（onConfirm 里的 expected 捕获+STALE 分支）。
        //   夹具 type 恒 'bug'（mkIssue 固定写死）：B4 的 bug_cause_note 只在 submit 端点校验，本组
        //   全程只走 estimate 端点，不受影响（未复用任何触发 submit 的 helper）。
        console.log('\n── [T8] 估时并发乐观锁前端接线 ──');

        // ── ①正常路径：expected 捕获不经任何格式转手，字节对齐存量 16 字符无秒形态 ──────────────
        //   dev_estimated_at 故意播成 16 字符无秒（模拟码表提到的存量形态）——若前端 expected 捕获误走了
        //   siToLocalInput/siFmtDT 等任何转手函数，这里会恒 409（约束①要防的正是这个）。
        const iEst8a = await mkIssue(`DUX-估时并发锁A-${RUN_TAG}`, '处理中');
        await mkMember(iEst8a, admin.id, `F6估时锁测试甲-${RUN_TAG}`, 'pending', null);
        await run(`UPDATE sys_issues SET assigned_at = ?, dev_estimated_at = ? WHERE id = ?`,
            ['2026-07-25 09:00:00', '2026-08-01 10:00', iEst8a]);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iEst8a);
        await page.waitForTimeout(600);
        await page.evaluate(() => { siModalEstimate(siDetail.issue); });
        await page.waitForSelector('#f_dev_estimated_at', { state: 'visible', timeout: 3000 });
        const prefillA = await page.$eval('#f_dev_estimated_at', el => el.value);
        must(prefillA === '2026-08-01T10:00',
            `[T8]① 前置：弹窗预填应等于 16 字符存量值转 datetime-local 形态，期望="2026-08-01T10:00"，实得"${prefillA}"`);
        await page.fill('#f_dev_estimated_at', '2026-08-15T14:30');
        await page.click('#siMConfirm');
        await page.waitForTimeout(800);
        const modalClosedA = await page.evaluate(() => !document.getElementById('siModalOverlay').classList.contains('open'));
        must(modalClosedA, '[T8]① 提交成功后弹窗应关闭');
        const dbAfterA = await get(`SELECT dev_estimated_at FROM sys_issues WHERE id = ?`, [iEst8a]);
        must(!!dbAfterA && dbAfterA.dev_estimated_at === '2026-08-15 14:30:00',
            `[T8]① ⭐ 正常路径：库值应落新提交值（后端 normalizeSysDatetime 补秒），期望="2026-08-15 14:30:00"，`
            + `实得="${dbAfterA && dbAfterA.dev_estimated_at}"`);

        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── ②stale 路径：开弹窗后模拟他人先提交（直改库），本次提交应 409 且不覆盖他人的值 ──────────
        const iEst8b = await mkIssue(`DUX-估时并发锁B-${RUN_TAG}`, '处理中');
        await mkMember(iEst8b, admin.id, `F6估时锁测试乙-${RUN_TAG}`, 'pending', null);
        await run(`UPDATE sys_issues SET assigned_at = ?, dev_estimated_at = ? WHERE id = ?`,
            ['2026-07-25 09:00:00', '2026-08-01 11:00:00', iEst8b]);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iEst8b);
        await page.waitForTimeout(600);
        await page.evaluate(() => { siModalEstimate(siDetail.issue); });
        await page.waitForSelector('#f_dev_estimated_at', { state: 'visible', timeout: 3000 });
        // 弹窗已捕获 expectedAtOpen='2026-08-01 11:00:00'（闭包，此刻起与后续 siDetail 刷新无关）——
        // 现在模拟"另一个在册开发先我一步提交"：直改库，制造 expected 与库现值不一致的真实并发场景。
        await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, ['2026-08-02 09:00:00', iEst8b]);
        // 〔F8·MED-2〕本行是这组断言的判别力来源——没有它，"闭包捕获"和"onConfirm 里现读 siDetail"两种
        // 实现会**同绿**：不重渲的话 siDetail 一直停在"打开弹窗那一刻"的旧值，即便真实实现退化成现读
        // siDetail.issue.dev_estimated_at，读到的也还是旧值，照样送出过期 expected、照样撞 409，测不出
        // 区别。这里主动重渲抽屉（模拟"页面在等用户操作期间，旁观者视角的数据已刷新"），让 siDetail 追上
        // 库里刚被"他人"改过的新值：闭包捕获的实现此刻 expectedAtOpen 仍是旧值（与刷新后的 siDetail 不同
        // 源）→ 送出去仍是过期 expected → 现有 409/toast/弹窗关闭三条断言原样通过；若退化成现读，
        // onConfirm 里会读到刷新后的新值当 expected 送出 → 与库现值一致 → 后端 200 放行 → 下方 dbAfterB
        // （断言库值仍是"他人"值未被覆盖）会翻红，从而暴露退化。
        await page.evaluate(() => siRenderDrawer(siOpenId));
        await page.waitForTimeout(400);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        await page.fill('#f_dev_estimated_at', '2026-08-20T10:00');
        await page.click('#siMConfirm');
        await page.waitForTimeout(800);
        const toastTextStale = await page.locator('#toast-container').textContent().catch(() => '');
        must(toastTextStale.includes('已被他人更新') && toastTextStale.includes('已刷新为最新值') && toastTextStale.includes('请重新确认'),
            `[T8]② ⭐ STALE toast 应含「已被他人更新」/「已刷新为最新值」/「请重新确认」，实得="${toastTextStale}"`);
        must(toastTextStale.includes('预计完成时间已被他人更新，已刷新为最新值，请重新确认'),
            `[T8]② ⭐ toast 应精确含约束③给定的完整文案，实得="${toastTextStale}"`);
        const modalClosedB = await page.evaluate(() => !document.getElementById('siModalOverlay').classList.contains('open'));
        must(modalClosedB, '[T8]② ⭐ STALE 后弹窗应已关闭（不是留着让用户对着过期 expected 死循环重试）');
        const dbAfterB = await get(`SELECT dev_estimated_at FROM sys_issues WHERE id = ?`, [iEst8b]);
        must(!!dbAfterB && dbAfterB.dev_estimated_at === '2026-08-02 09:00:00',
            `[T8]② ⭐ 库值应仍为"他人"提交的值，本次提交未覆盖，期望="2026-08-02 09:00:00"，`
            + `实得="${dbAfterB && dbAfterB.dev_estimated_at}"`);

        // ── ③对照：重开弹窗（expected=刷新后的新现值）→ 提交应 200 成功（证明非永久卡死） ──────────
        //   STALE 分支内已 siAfterAction() 重拉详情，siDetail 现在应已是 '2026-08-02 09:00:00'；
        //   siModalEstimate(siDetail.issue) 重新捕获的 expectedAtOpen 与库现值一致，理应顺利提交。
        await page.evaluate(() => { siModalEstimate(siDetail.issue); });
        await page.waitForSelector('#f_dev_estimated_at', { state: 'visible', timeout: 3000 });
        const prefillRetry = await page.$eval('#f_dev_estimated_at', el => el.value);
        must(prefillRetry === '2026-08-02T09:00',
            `[T8]③ 前置：重开弹窗预填应已是刷新后的新现值，期望="2026-08-02T09:00"，实得="${prefillRetry}"`);
        await page.fill('#f_dev_estimated_at', '2026-08-25T16:00');
        await page.click('#siMConfirm');
        await page.waitForTimeout(800);
        const modalClosedC = await page.evaluate(() => !document.getElementById('siModalOverlay').classList.contains('open'));
        must(modalClosedC, '[T8]③ ⭐ 重试提交成功后弹窗应关闭（证明 STALE 不是永久卡死，按提示重试能走通）');
        const dbAfterC = await get(`SELECT dev_estimated_at FROM sys_issues WHERE id = ?`, [iEst8b]);
        must(!!dbAfterC && dbAfterC.dev_estimated_at === '2026-08-25 16:00:00',
            `[T8]③ ⭐ 重试成功：库值应落本次新提交值，期望="2026-08-25 16:00:00"，实得="${dbAfterC && dbAfterC.dev_estimated_at}"`);

        // 〔F9·MED-4〕显式钉死 409 预算——本组应恰好触发 1 次 /estimate 的 409（②的 stale 提交，不多不少）。
        // siConsoleErrorsExcludingKnown409 按固定预算 SI_409_BUDGET_ESTIMATE 执行，与这里的数字必须一致
        // （该常量定义处已注明"改一处两处都要改"）。
        const estimate409Urls = (page._409Urls || []).filter(u => u.includes('/estimate'));
        must(estimate409Urls.length === 1,
            `[T8] ⭐ 全程应恰好触发 1 次 /estimate 的 409（②的 stale 提交），实得 ${estimate409Urls.length} 条：${JSON.stringify(estimate409Urls)}`);
        // 〔codex 328-R2 收口〕总量=来源断言：全部 409 都必须来自 /estimate（若出现非 /estimate 的 409，
        //   上一条只查 /estimate 子集会漏——本条钉死"唯一 409 来源"，与豁免函数的来源绑定门同一口径）。
        must((page._409Urls || []).length === 1,
            `[T8] ⭐ 全程 409 总量应恰为 1（且由上一条证明全部来自 /estimate），实得 ${(page._409Urls || []).length} 条：${JSON.stringify(page._409Urls)}`);

        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── [T9] bug 产生原因前端接线（B4 后端 4de09fd + F7 前端·F 线末件） ─────────────────────
        //   ①②③ 全程复用同一个已打开的提交弹窗（连续用户操作叙事：先看到字段→切模式仍在→空提交被拦→
        //   补填后重试成功），④另开一单独立对照。全程走真实 UI（page.fill/page.click('#siMConfirm')），
        //   不绕过前端逻辑。
        console.log('\n── [T9] bug 产生原因前端接线 ──');
        const BUG_CAUSE_TEXT = `根因是并发写入未加锁-${RUN_TAG}`;
        const iBug9 = await mkIssue(`DUX-BUG产生原因-${RUN_TAG}`, '处理中');
        const daBug9 = await mkMember(iBug9, admin.id, `F7bug原因测试-${RUN_TAG}`, 'pending', null);
        // 提交端点 ESTIMATE_REQUIRED 先于本次新增闸门（index.js :6098）——bug 单必须先有 dev_estimated_at
        // 才轮到 bug_cause_note 判定，直接种库，不经 estimate 端点（本组焦点不是估时流程）。
        await run(`UPDATE sys_issues SET dev_estimated_at = ? WHERE id = ?`, ['2026-08-10 18:00:00', iBug9]);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iBug9);
        await page.waitForTimeout(600);
        const drawerTitle9 = await page.evaluate(() => {
            const el = document.getElementById('siDTitle');
            return el ? el.textContent.trim() : null;
        });
        must(!!drawerTitle9 && new RegExp(`^#${iBug9}(?!\\d)`).test(drawerTitle9),
            `[T9] 前置：抽屉确已切到 #${iBug9}（siDTitle 应以该编号开头），实得 "${drawerTitle9}"`);

        await page.evaluate(() => { siModalSubmit(siDetail.issue); });
        await page.waitForSelector('#siSubmitBugCauseNote', { state: 'visible', timeout: 3000 });

        // ── ①字段存在 + label 文本 + 必填星号 ──────────────────────────────────
        const bugFieldInfo = await page.evaluate(() => {
            const ta = document.getElementById('siSubmitBugCauseNote');
            if (!ta) return null;
            const group = ta.closest('.u-form-group');
            const label = group ? group.querySelector('label') : null;
            return { present: true, labelText: label ? label.textContent.trim() : null, hasReqMark: !!(label && label.querySelector('.u-req')) };
        });
        must(!!bugFieldInfo && bugFieldInfo.present === true,
            '[T9]① bug 单提交弹窗应出现「bug 产生原因」textarea（#siSubmitBugCauseNote）');
        must(!!bugFieldInfo && !!bugFieldInfo.labelText && bugFieldInfo.labelText.includes('bug 产生原因'),
            `[T9]① label 文本应含「bug 产生原因」，实得="${bugFieldInfo && bugFieldInfo.labelText}"`);
        must(!!bugFieldInfo && bugFieldInfo.hasReqMark === true,
            '[T9]① label 应带必填星号（.u-req）');

        // ── ①（续）切到 no_code 模式后字段仍可见——恒显不随 mode 隐藏 ─────────────────────
        await page.click('input[name="si-submit-mode"][value="no_code"]');
        await page.waitForTimeout(200);
        const bugFieldVisibleAfterSwitch = await page.evaluate(() => {
            const ta = document.getElementById('siSubmitBugCauseNote');
            return !!ta && ta.offsetParent !== null;
        });
        must(bugFieldVisibleAfterSwitch === true,
            '[T9]① ⭐ 切到 no_code 模式后「bug 产生原因」字段应仍可见（恒显不随 mode 隐藏，未被 siSubmitModeChanged 误连坐）');

        // ── ②空提交：其余必填项都填好，独留 bug_cause_note 空 → 应被前端拦下，弹窗不关 ──────────
        //   刻意先把 no_code_reason 也填好，隔离出"就是 bug_cause_note 这一项在拦"（防未来调整校验顺序后
        //   这条断言其实测的是别的字段在拦，看着绿实则文不对题）。
        //   〔F9·MED-3〕仅"toast 含文案 + 弹窗未关"两条不足以证明是**前端**拦下——后端 BUG_CAUSE_REQUIRED
        //   兜底返回的 error 字段恰好也是「请填写 bug 产生原因」（同 index.js :6121），且既有 `!r.ok` 通用
        //   兜底分支同样"toast+不关弹窗"，若前端校验代码被误删/漏了，请求照样发出、被后端拒绝，这两条
        //   断言原样绿（后端冒充前端）。补两条独立证据钉死"请求根本没发出"：①page.on('request') 实时捕获，
        //   全程不应出现任何 POST .../submit ②该单 sys_issue_dev_events 计数提交前后不变（零新增，双保险）。
        const eventCountBefore9 = await get(`SELECT COUNT(*) AS c FROM sys_issue_dev_events WHERE issue_id = ?`, [iBug9]);
        const submitRequests9 = [];
        const onSubmitReq9 = (req) => {
            if (req.method() === 'POST' && req.url().includes(`/sys-issues/${iBug9}/submit`)) submitRequests9.push(req.url());
        };
        page.on('request', onSubmitReq9);
        await page.check('#siSubmitSelfTested');
        await page.check('#siSubmitTestEnvDeployed');
        await page.fill('#siSubmitNoCodeReason', `F7占位无代码理由-${RUN_TAG}`);
        await page.evaluate(() => { const c = document.getElementById('toast-container'); if (c) c.innerHTML = ''; });
        await page.click('#siMConfirm');
        await page.waitForTimeout(500);
        page.off('request', onSubmitReq9);
        const toastTextEmpty9 = await page.locator('#toast-container').textContent().catch(() => '');
        must(toastTextEmpty9.includes('请填写 bug 产生原因'),
            `[T9]② ⭐ 空 bug_cause_note 提交应被前端拦下并提示「请填写 bug 产生原因」，实得="${toastTextEmpty9}"`);
        const modalStillOpen9 = await page.evaluate(() => document.getElementById('siModalOverlay').classList.contains('open'));
        must(modalStillOpen9 === true, '[T9]② ⭐ 空提交被拦下后弹窗应仍打开（未关，未误放行）');
        must(submitRequests9.length === 0,
            `[T9]② ⭐⭐ 前端拦截判别力①：全程不应发出任何 POST .../submit 请求（证明前端在网络层之前就拦下，`
            + `非"发了但被后端 400 拒绝"这种后端冒充前端的退化），实得 ${JSON.stringify(submitRequests9)}`);
        const eventCountAfter9 = await get(`SELECT COUNT(*) AS c FROM sys_issue_dev_events WHERE issue_id = ?`, [iBug9]);
        must(!!eventCountBefore9 && !!eventCountAfter9 && eventCountBefore9.c === eventCountAfter9.c,
            `[T9]② ⭐⭐ 前端拦截判别力②：空提交前后 sys_issue_dev_events 该单计数应不变，`
            + `期望=${eventCountBefore9 && eventCountBefore9.c}，实得=${eventCountAfter9 && eventCountAfter9.c}`);

        // ── ③补填后真实提交 → 200 → 重开抽屉断言成员区逐人块显示该文本（写读端到端） ──────────
        await page.fill('#siSubmitBugCauseNote', BUG_CAUSE_TEXT);
        await page.click('#siMConfirm');
        await page.waitForTimeout(800);
        const modalClosed9 = await page.evaluate(() => !document.getElementById('siModalOverlay').classList.contains('open'));
        must(modalClosed9 === true, '[T9]③ 补填后提交成功，弹窗应关闭');

        // 服务端落库交叉核对（不只信任前端展示层，同 test-sys-effort-days-playwright.js 既有范式）。
        //   〔F8·LOW-5〕收窄查询——加 dev_assignee_id + action IN ('submit','no_code')（对齐
        //   verify-sys-bug-cause.js:270 既有更强先例：`WHERE issue_id=? AND dev_assignee_id=? AND
        //   action='submit'`；本组固定走 no_code 模式提交，故用 IN 覆盖两个可能落的 action 值，非
        //   照抄单一 'submit'）。当前单人单轮场景裸 issue_id 查询本就成立，收窄是方向性防未来夹具
        //   扩展（同单多人/多轮）时"只按 issue_id + 最新一条"会捞错行的假红风险，不是修一个真的 bug。
        const dbBugCause9 = await get(
            `SELECT json_extract(payload_json, '$.bug_cause_note') AS bcn FROM sys_issue_dev_events
              WHERE issue_id = ? AND dev_assignee_id = ? AND action IN ('submit', 'no_code') ORDER BY id DESC LIMIT 1`,
            [iBug9, daBug9]
        );
        must(!!dbBugCause9 && dbBugCause9.bcn === BUG_CAUSE_TEXT,
            `[T9]③ ⭐ 服务端落库交叉核对：sys_issue_dev_events 最新事件 payload_json.bug_cause_note 应精确等于提交值，`
            + `期望="${BUG_CAUSE_TEXT}"，实得="${dbBugCause9 && dbBugCause9.bcn}"`);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iBug9);
        await page.waitForTimeout(600);
        const bugCauseDisplay = await page.evaluate(() => {
            const blocks = [...document.querySelectorAll('#siDBody .si-worknote-block')];
            const block = blocks.find(b => {
                const t = b.querySelector('.si-worknote-title');
                return t && t.textContent.trim() === 'bug 产生原因';
            });
            if (!block) return { hasBlock: false };
            const item = block.querySelector('.si-worknote-item');
            const who = item ? item.querySelector('.si-worknote-who') : null;
            const text = item ? item.querySelector('.si-worknote-text') : null;
            return { hasBlock: true, who: who ? who.textContent.trim() : null, text: text ? text.textContent : null };
        });
        must(!!bugCauseDisplay && bugCauseDisplay.hasBlock === true,
            `[T9]③ ⭐ 重开抽屉后成员区应出现「bug 产生原因」逐人块，实得 ${JSON.stringify(bugCauseDisplay)}`);
        must(!!bugCauseDisplay && bugCauseDisplay.text === BUG_CAUSE_TEXT,
            `[T9]③ ⭐ 逐人块文本应精确等于本次提交的 bug_cause_note，期望="${BUG_CAUSE_TEXT}"，实得="${bugCauseDisplay && bugCauseDisplay.text}"`);

        // ── ③b（F8·MED-1 延伸）：removed=true 历史实例——直插夹具而非走真实 remove+re-add 流程 ────
        //   （那要经 dev-assignees 移除端点 + 重新加回两轮真实调用，流程重且不是本组要验的东西：本组
        //   验的是"前端读 bug_cause_records 时是否正确带出已移出成员的历史记录 + 加对后缀"，直接构造
        //   该形状的数据更聚焦，同 mkMember 本身即"直插夹具"范式，非本文件独创）。
        //   ⚠️ 后端 bug_cause_records 契约由 agent-B 并行实现，本次未落地故本组断言无法实跑验证——
        //   夹具形状按已定死契约字段 {dev_assignee_id, user_id, user_name, bug_cause_note, submitted_at,
        //   removed} 反推最小闭环：sys_issue_dev_assignees 一行 removed_at 非空 + sys_issue_dev_events
        //   一条 action IN ('submit','no_code') 且 dev_assignee_id 指向该行、payload_json 带
        //   bug_cause_note（与既有 work_note/bug_cause_note 单人最新事件查询同源结构，见 index.js
        //   :5709-5725 workNoteRows 那条 JOIN 子查询）。集成后由主会话实跑验证契约细节是否吻合。
        const daBug9Removed = await mkMember(iBug9, 9301, `F7bug原因测试丙已移出-${RUN_TAG}`, 'pending', null);
        await run(`UPDATE sys_issue_dev_assignees SET removed_at = ? WHERE id = ?`, ['2026-08-05 12:00:00', daBug9Removed]);
        const REMOVED_BUG_CAUSE_TEXT = `已移出成员的历史原因-${RUN_TAG}`;
        await run(
            `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, payload_json, created_at)
             VALUES (?, ?, 'submit', 1, ?, '2026-08-05 11:55:00')`,
            [iBug9, daBug9Removed, JSON.stringify({ mode: 'no_code', bug_cause_note: REMOVED_BUG_CAUSE_TEXT })]
        );

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iBug9);
        await page.waitForTimeout(600);
        const bugCauseDisplay2 = await page.evaluate(() => {
            const blocks = [...document.querySelectorAll('#siDBody .si-worknote-block')];
            const block = blocks.find(b => {
                const t = b.querySelector('.si-worknote-title');
                return t && t.textContent.trim() === 'bug 产生原因';
            });
            if (!block) return { hasBlock: false, items: [] };
            const items = [...block.querySelectorAll('.si-worknote-item')].map(item => {
                const who = item.querySelector('.si-worknote-who');
                const text = item.querySelector('.si-worknote-text');
                return { whoText: who ? who.textContent.trim() : null, text: text ? text.textContent : null };
            });
            return { hasBlock: true, items };
        });
        must(!!bugCauseDisplay2 && bugCauseDisplay2.hasBlock === true,
            `[T9]③b ⭐ 已移出成员的 bug 产生原因也应在成员区块出现（历史轮次可见性，对齐 noCodeRecords 同款`
            + `codex 264 号 M-2 裁定），实得 ${JSON.stringify(bugCauseDisplay2)}`);
        const removedItem = bugCauseDisplay2.items.find(it => it.text === REMOVED_BUG_CAUSE_TEXT);
        must(!!removedItem, `[T9]③b 应能按文本定位到已移出成员那条记录，实得 ${JSON.stringify(bugCauseDisplay2.items)}`);
        must(!!removedItem && removedItem.whoText.includes('（已移出）'),
            `[T9]③b ⭐ 已移出成员那行姓名后应带「（已移出）」muted 后缀，实得 whoText="${removedItem && removedItem.whoText}"`);
        const activeItem = bugCauseDisplay2.items.find(it => it.text === BUG_CAUSE_TEXT);
        must(!!activeItem && !activeItem.whoText.includes('（已移出）'),
            `[T9]③b ⭐ 对照：在册（未移除）成员那行不应带「（已移出）」后缀，实得 whoText="${activeItem && activeItem.whoText}"`);

        // ── ③c（D 组件①·2026-08-12）round_no 有值时显示「（第N轮）」，非旧文案「（已移出）」──────
        //   daBug9Removed（上方③b 夹具）round_no 从未赋值，天然为 NULL——③b 那两条既有断言未改动
        //   （仍断言旧文案「（已移出）」），恰好充当"NULL 降级对照"（见文件头 F 线注释：round_no 为
        //   NULL 时前端优雅降级，不显示破损的「（第null轮）」）。本组另插一条 round_no=2 的历史实例，
        //   证明"有值时显示新文案"这一半，且与③b 的 NULL 行同屏并存互不干扰。
        const daBug9Round2 = await mkMember(iBug9, 9302, `F7bug原因测试丁第2轮-${RUN_TAG}`, 'pending', null);
        await run(`UPDATE sys_issue_dev_assignees SET removed_at = ?, round_no = 2 WHERE id = ?`,
            ['2026-08-05 13:00:00', daBug9Round2]);
        const ROUND2_BUG_CAUSE_TEXT = `第2轮已移出成员的历史原因-${RUN_TAG}`;
        await run(
            `INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, payload_json, created_at)
             VALUES (?, ?, 'submit', 1, ?, '2026-08-05 12:55:00')`,
            [iBug9, daBug9Round2, JSON.stringify({ mode: 'no_code', bug_cause_note: ROUND2_BUG_CAUSE_TEXT })]
        );
        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iBug9);
        await page.waitForTimeout(600);
        const bugCauseDisplay3 = await page.evaluate(() => {
            const blocks = [...document.querySelectorAll('#siDBody .si-worknote-block')];
            const block = blocks.find(b => {
                const t = b.querySelector('.si-worknote-title');
                return t && t.textContent.trim() === 'bug 产生原因';
            });
            if (!block) return { hasBlock: false, items: [] };
            const items = [...block.querySelectorAll('.si-worknote-item')].map(item => {
                const who = item.querySelector('.si-worknote-who');
                const text = item.querySelector('.si-worknote-text');
                return { whoText: who ? who.textContent.trim() : null, text: text ? text.textContent : null };
            });
            return { hasBlock: true, items };
        });
        must(!!bugCauseDisplay3 && bugCauseDisplay3.hasBlock === true,
            `[T9]③c 前置：应能定位到「bug 产生原因」区块，实得 ${JSON.stringify(bugCauseDisplay3)}`);
        const round2Item = bugCauseDisplay3.items.find(it => it.text === ROUND2_BUG_CAUSE_TEXT);
        must(!!round2Item, `[T9]③c 应能按文本定位到 round_no=2 的历史记录，实得 ${JSON.stringify(bugCauseDisplay3.items)}`);
        must(!!round2Item && round2Item.whoText.includes('（第2轮）'),
            `[T9]③c ⭐⭐ D组件①：round_no=2 的已移出成员应显示「（第2轮）」轮次后缀，实得 whoText="${round2Item && round2Item.whoText}"`);
        must(!!round2Item && !round2Item.whoText.includes('（已移出）'),
            `[T9]③c ⭐ 不应残留旧文案「（已移出）」，实得 whoText="${round2Item && round2Item.whoText}"`);
        // 对照：同屏内③b 的 round_no=NULL 行应仍显示旧文案（互不干扰，防"改坏了全局替换成一种文案"）
        const removedItemStill = bugCauseDisplay3.items.find(it => it.text === REMOVED_BUG_CAUSE_TEXT);
        must(!!removedItemStill && removedItemStill.whoText.includes('（已移出）'),
            `[T9]③c ⭐⭐ 对照：round_no 为 NULL 的历史记录（③b 夹具）应仍显示旧文案「（已移出）」（同屏两种形态互不干扰），实得 whoText="${removedItemStill && removedItemStill.whoText}"`);
        must(!!removedItemStill && !removedItemStill.whoText.includes('（第'),
            `[T9]③c ⭐ 对照：NULL round_no 不应显示破损的「（第null轮）」类文本，实得 whoText="${removedItemStill && removedItemStill.whoText}"`);

        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── ④对照：feature 单开提交弹窗 → 字段不存在 ──────────────────────────────
        //   mkIssue 固定写死 type='bug'，本对照需要 type='feature'——不改 mkIssue 签名（同 F5 处理
        //   可行性正例夹具的取舍：直接仿 SQL 形状插入 + 手动登记 createdIssueIds）。只开弹窗读 DOM，
        //   不走真实提交，故不需要在册成员/dev_estimated_at 等提交前置条件。
        const iFeature9 = (await run(
            `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required)
             VALUES ('feature', '开发中', ?, ?, '内部', 1, '管理员', 1)`,
            [`DUX-BUG产生原因对照-${RUN_TAG}`, FIXTURE_SYSTEM]
        )).lastID;
        createdIssueIds.push(iFeature9);

        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iFeature9);
        await page.waitForTimeout(600);
        const drawerTitle9b = await page.evaluate(() => {
            const el = document.getElementById('siDTitle');
            return el ? el.textContent.trim() : null;
        });
        must(!!drawerTitle9b && new RegExp(`^#${iFeature9}(?!\\d)`).test(drawerTitle9b),
            `[T9]④ 前置：对照单抽屉确已切到 #${iFeature9}，实得 "${drawerTitle9b}"`);

        await page.evaluate(() => { siModalSubmit(siDetail.issue); });
        await page.waitForSelector('#siMBody .u-form-group', { state: 'visible', timeout: 3000 });
        const bugFieldAbsent = await page.evaluate(() => !document.getElementById('siSubmitBugCauseNote'));
        must(bugFieldAbsent === true,
            '[T9]④ ⭐ 对照：feature 单提交弹窗不应出现「bug 产生原因」字段（非 bug 类型零变化）');

        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── [T10] OA 豁免默认勾选联动（2026-08-10 用户拍板·improvement 覆盖需求方联动·hotfix）────────
        //   规则终态：type=improvement → 未触碰态恒勾（需求方填不填都不取消）；bug/feature → 维持原
        //   「需求方三字段任一非空→取消勾」联动；用户手动点过勾选框（touched）→ 联动整体停止。
        //   纯 DOM 交互断言（不真提交建单——建单链路由既有套件覆盖，本组只测勾选框默认逻辑本身）。
        console.log('\n── [T10] OA 豁免默认勾选联动 ──');
        await page.evaluate(() => siOpenCreate());
        await page.waitForSelector('#f_oa_exempt', { state: 'attached', timeout: 3000 });
        const t10a = await page.evaluate(() => ({
            type: document.getElementById('f_type').value,
            checked: document.getElementById('f_oa_exempt').checked,
        }));
        must(t10a.checked === true,
            `[T10]① 弹窗初开（需求方三字段恒空）勾选应为 true（既有初始态），实得 type=${t10a.type} checked=${t10a.checked}`);
        // ② 切 improvement + 填需求方姓名 → 勾选仍 true（本次新规则的核心判别断言：旧联动在此会取消勾）
        const t10b = await page.evaluate(() => {
            const typeEl = document.getElementById('f_type');
            typeEl.value = 'improvement'; typeEl.dispatchEvent(new Event('change'));
            const nameEl = document.getElementById('f_requester_name');
            nameEl.value = '联动探针姓名'; nameEl.dispatchEvent(new Event('input'));
            return document.getElementById('f_oa_exempt').checked;
        });
        must(t10b === true,
            `[T10]② ⭐ improvement+需求方已填 → 勾选仍应为 true（improvement 覆盖联动·旧规则此处会取消勾），实得 ${t10b}`);
        // ③ 切回 feature（需求方仍非空）→ 勾选变 false（原联动对非 improvement 类型仍然生效，未被误杀）
        const t10c = await page.evaluate(() => {
            const typeEl = document.getElementById('f_type');
            typeEl.value = 'feature'; typeEl.dispatchEvent(new Event('change'));
            return document.getElementById('f_oa_exempt').checked;
        });
        must(t10c === false,
            `[T10]③ ⭐ 切回 feature（需求方仍非空）→ 勾选应变 false（三字段联动对 bug/feature 仍活·对照组），实得 ${t10c}`);
        // ④ 手动点勾选框（touched）后再切 improvement → 联动不得再覆盖用户的手动状态（停锁不因新规则回归）
        const t10d = await page.evaluate(() => {
            const chk = document.getElementById('f_oa_exempt');
            chk.checked = true; chk.dispatchEvent(new Event('change'));   // 手动勾上 → touched
            chk.checked = false; chk.dispatchEvent(new Event('change'));  // 再手动取消 → 最终手动态=false
            const typeEl = document.getElementById('f_type');
            typeEl.value = 'improvement'; typeEl.dispatchEvent(new Event('change'));
            return document.getElementById('f_oa_exempt').checked;
        });
        must(t10d === false,
            `[T10]④ ⭐ touched 后切 improvement → 联动不得覆盖手动取消态（停锁优先于新规则），实得 ${t10d}`);
        // ⑤〔codex 330 LOW-2〕三维组合补漏：未触碰态下 improvement→清空需求方→切回 feature → 应恢复勾选
        //   （证明 improvement 短路分支没有破坏旧规则的「三字段全空→勾」半边——②③只测了非空侧）。
        //   需重开弹窗取未触碰态（④已 touched·touched 是弹窗实例级闭包变量，重开即重置）。
        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); });
        await page.waitForTimeout(200);
        await page.evaluate(() => siOpenCreate());
        await page.waitForSelector('#f_oa_exempt', { state: 'attached', timeout: 3000 });
        const t10e = await page.evaluate(() => {
            const typeEl = document.getElementById('f_type');
            typeEl.value = 'improvement'; typeEl.dispatchEvent(new Event('change'));
            const nameEl = document.getElementById('f_requester_name');
            nameEl.value = '组合探针'; nameEl.dispatchEvent(new Event('input'));   // improvement 态下填入
            nameEl.value = ''; nameEl.dispatchEvent(new Event('input'));           // 再清空
            typeEl.value = 'feature'; typeEl.dispatchEvent(new Event('change'));   // 切回 feature（三字段全空）
            return document.getElementById('f_oa_exempt').checked;
        });
        must(t10e === true,
            `[T10]⑤ ⭐ 未触碰态 improvement→清空需求方→切回 feature → 应恢复勾选（旧规则空字段半边未被短路破坏），实得 ${t10e}`);
        await page.evaluate(() => { if (window.siCloseModal) siCloseModal(); if (window.siCloseDrawer) siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ── [T3] 全程无 console error（[T8]② 故意触发的 /estimate 409 按观测精确条数豁免，见
        //   siConsoleErrorsExcludingKnown409 定义处注释；非本次范围的 409/其它 error 不豁免）──────────
        const t3Errs = siConsoleErrorsExcludingKnown409(page);
        must(t3Errs.length === 0, `[T3] 全程无 console error，实得：${JSON.stringify(t3Errs.slice(0, 3))}`);

    } catch (e) {
        failed++;
        fatalError = e;
        console.error('\n[异常] 套件中途抛出未捕获异常（完整堆栈，非仅 message）：\n', e && (e.stack || e));
        try {
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        } catch (_) { /* 目录已存在或无法创建，不影响主流程 */ }
    } finally {
        // 〔F9·MED-2〕browser.close() 独立 try/catch——它若抛错，原写法会让整个 finally 段中断，跳过
        // 下面全部数据库清理（cleanupErrs 断言、残留计数、db.close() 全部执行不到，夹具永久留在库里）。
        // 捕获后记进 cleanupErrs，走既有"清理错误不吞、统一断言"纪律，不用单独开一条新的断言通道。
        const cleanupErrs = [];
        if (browser) {
            try { await browser.close(); } catch (e) { cleanupErrs.push({ step: 'browser.close', message: e && e.message }); }
        }
        // 清理夹具（含子表）——SQL 清理错误不吞，收集后统一断言（同既有套件 cleanup 纪律）。
        // 〔F9·HIGH〕补 sys_issue_dev_events——[T9] 真实提交（真走 /submit 端点）与直插夹具（③b 的
        // removed 历史实例）都会在这张表留行，此前清理链没有它，孤儿行会污染后续按 issue_id/
        // dev_assignee_id 查询的其它脚本（该表无 issue_id 外键级联，需要显式清）。顺序放在最前——
        // sys_issue_dev_assignees 删掉后 dev_assignee_id 就成了悬空引用，虽然 SQLite 默认不强制外键，
        // 但按"先删末端明细表、再删被引用的主表"这个既定顺序惯例走，不依赖"反正不强制约束"这层侥幸。
        const safeDelete = async (sql, params, step) => {
            try { await run(sql, params); } catch (e) { cleanupErrs.push({ step, message: e && e.message }); }
        };
        for (const id of createdIssueIds) {
            await safeDelete('DELETE FROM sys_issue_dev_events WHERE issue_id = ?', [id], `dev_events#${id}`);
            await safeDelete('DELETE FROM sys_issue_dev_commits WHERE issue_id = ?', [id], `dev_commits#${id}`);
            await safeDelete('DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?', [id], `dev_assignees#${id}`);
            await safeDelete('DELETE FROM sys_issue_timeline WHERE issue_id = ?', [id], `timeline#${id}`);
            await safeDelete('DELETE FROM sys_issues WHERE id = ?', [id], `issues#${id}`);
        }
        const left = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE title LIKE ?`, [`DUX-%-${RUN_TAG}`]);
        console.log(`\n  🧹 夹具已清理（残留 issue ${left ? left.c : '?'} 条，应为 0）`);
        must(cleanupErrs.length === 0, `夹具清理 SQL 全部无错误，实得 errs=${JSON.stringify(cleanupErrs)}`);
        must(!!left && left.c === 0, `夹具清理后 sys_issues 残留应为 0，实得 ${left ? left.c : '(查询失败)'}`);
        // 〔F9·HIGH〕sys_issue_dev_events 按 issue_id 残留计数断言（对齐既有"清理断言到磁盘"纪律，
        // 不能只删不验证删干净了）。createdIssueIds 为空时 SQL 的 IN () 语法错，短路跳过（同 [T31] 既有写法）。
        let devEventsLeft = null;
        if (createdIssueIds.length) {
            const devEventsLeftRow = await get(
                `SELECT COUNT(*) AS c FROM sys_issue_dev_events WHERE issue_id IN (${createdIssueIds.map(() => '?').join(',')})`,
                createdIssueIds
            );
            devEventsLeft = devEventsLeftRow ? devEventsLeftRow.c : null;
        }
        must(createdIssueIds.length === 0 || devEventsLeft === 0,
            `夹具清理后 sys_issue_dev_events 残留应为 0，实得 ${devEventsLeft === null ? '(查询失败)' : devEventsLeft}`);
        db.close();
        console.log(`\n  合计 ${passed} PASS / ${failed} FAIL${fatalError ? '  ⚠️ FATAL：套件中途抛出未捕获异常，见上方完整堆栈（此次结果不可信赖为"仅这些用例失败"）' : ''}`);
        process.exit(failed === 0 && !fatalError ? 0 : 1);
    }
})().catch(e => {
    // 外层 rejection 兜底——封住"finally 段自身抛错（例如 browser.close()/cleanup() 内部 await 失败）
    // 导致 IIFE 整体 rejected、绕过上面的汇总打印与 process.exit 调用"这条路径（同既有套件纪律）。
    console.error('[顶层兜底] finally 段或未捕获 rejection：\n', e && (e.stack || e));
    process.exit(1);
});
