/**
 * test-sys-commit-cols-playwright.js — commit 编码两列 前端冒烟（C3 起，C5/C5b 阶段续补）
 *
 * 循 test-sys-bug-hold-frontend-playwright.js 套件范式（直接 SQL 造夹具 + JWT 注入 + login.html 中继跳转 +
 * 外部 server:3000 + 真实 task_pool.db，全程不点击会真实外呼钉钉的按钮）。
 *
 * 用法：本地 server（3000）**已重启到含 C1/C2 后端改动的代码**后：
 *   node scripts/test-sys-commit-cols-playwright.js
 *
 * C3 覆盖：
 *   [T1] 列表页 14 列表头就位 + 列序正确（计划开工在末位）
 *   [T2] ⭐ 1920 视口下**不横滚**（D12 预案的触发判据——横滚则需合并两个时间列）
 *   [T3] 渲染三态：≤2 条全显分号隔开 / >2 条「首条 + 等N条」+ title 含完整清单 / 空态
 *   [T4] 「未填」vs「—」两语义按单据状态区分（D6）
 *   [T5] 全程无 console error
 *
 * ⭐ S4（2026-08-04）：GIT/SVN 口径对调 + 复制格式按侧差异化（用户拍板：前端 GIT commit 多条 '\n'
 *   换行，后端 SVN 版本号多条 ',' 拼接无空格）——见 [T13]（siBuildCommitCopyText 纯函数边界 + 前端
 *   多条真实复制）与新增 [T13b]（后端多条真实复制，新夹具 iManyBe）。本文件头部这份摘要是历次续补
 *   累积的产物，早已不完整覆盖 T9-T26（未在此逐条补全，非本次范围）。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

// ⚠️ 必须加载 .env：server 端 JWT_SECRET 来自 .env，脚本不加载会退回 fallback 值 →
//    签名不匹配 → 所有请求 403 → 被 checkAuth 踢回 login.html（本次踩坑，既有套件均有此行）
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SCREENSHOT_DIR = path.join(__dirname, '..', 'test-screenshots');

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

let passed = 0, failed = 0;
function must(cond, msg) {
    if (cond) { passed++; console.log('  ✅ ' + msg); return true; }
    failed++; console.log('  ❌ ' + msg); return false;
}

async function loginPage(browser, token) {
    // clipboard 权限用于 C5b 一键复制断言（读回剪贴板验内容）。localhost 是安全上下文，
    // 故此处走的是 navigator.clipboard 分支；生产 HTTP 走 execCommand 回退分支——见脚本尾「已知限制」。
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await ctx.newPage();
    const consoleErrors = [];
    // S4 复审收口：[T13] 的"未知/缺失 side 回落换行"两条断言会**故意**触发产品侧的 console.error
    //   （siBuildCommitCopyText 对未知 side 显式报错，那正是被测行为本身）。豁免精确到该条消息文本，
    //   不泛化忽略所有 error——对齐本项目 allow409/allow400 的精确豁免范式。
    const SI_EXPECTED_CONSOLE_ERR = /siBuildCommitCopyText 收到未知 side/;
    page.on('console', m => { if (m.type() === 'error' && !SI_EXPECTED_CONSOLE_ERR.test(m.text())) consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}

const RUN_TAG = Date.now();
const createdIssueIds = [];
const createdReleaseIds = [];   // ⚠️ 必须在 try 外声明——finally 的清理要访问它（在 try 内声明会 ReferenceError）

// 夹具统一的 system_name。[T1b] 的「系统」列断言直接引用本常量，不再硬编码 'BMS' 字面量——
// codex 251 L-2：原写法让断言隐式依赖 mkIssue 里 SQL 硬编码的 'BMS'，改 helper 时断言会红得莫名其妙。
const FIXTURE_SYSTEM = 'BMS';
async function mkIssue(title, status) {
    const r = await run(
        `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, intake_required)
         VALUES ('bug', ?, ?, ?, '内部', 1, '管理员', 1)`, [status, title, FIXTURE_SYSTEM]
    );
    createdIssueIds.push(r.lastID);
    return r.lastID;
}
async function mkMember(issueId, userId) {
    const r = await run(
        `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status)
         VALUES (?, ?, ?, 0, 'pending')`, [issueId, userId, '开发' + userId]
    );
    return r.lastID;
}
const seedCommit = (issueId, daId, userId, component, ref) =>
    run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`, [issueId, daId, userId, component, ref]);

(async () => {
    let browser;
    try {
        // users 表用 `status`（非 is_active）标活跃态——列名以 PRAGMA table_info 实测为准，不凭印象写
        const admin = await get(`SELECT id, username, display_name, role FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`);
        if (!admin) throw new Error('库中无 active admin 用户，无法造 token');
        const adminTok = jwt.sign({ id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role }, JWT_SECRET, { expiresIn: '1h' });

        // ── 夹具：三种 commit 数量形态 + 两种空态 ──────────────────────────
        const iTwo = await mkIssue(`CC-两条-${RUN_TAG}`, '处理中');
        const mTwo = await mkMember(iTwo, 5);
        await seedCommit(iTwo, mTwo, 5, 'frontend', 'fe-aaa111');
        await seedCommit(iTwo, mTwo, 5, 'frontend', 'fe-bbb222');
        await seedCommit(iTwo, mTwo, 5, 'backend', 'be-ccc333');

        const iMany = await mkIssue(`CC-五条-${RUN_TAG}`, '处理中');
        const mMany = await mkMember(iMany, 6);
        for (let n = 1; n <= 5; n++) await seedCommit(iMany, mMany, 6, 'frontend', `fe-many-${n}`);

        // S4（复制格式按侧差异化，2026-08-04）：后端多条夹具——[T13] 既有 iMany 只覆盖前端多条复制，
        //   后端多条（','拼接）此前从无任何夹具能测（iTwo 后端只有 1 条，join 分隔符对单值不可见）。
        const iManyBe = await mkIssue(`CC-后端多条-${RUN_TAG}`, '处理中');
        const mManyBe = await mkMember(iManyBe, 6);
        for (let n = 1; n <= 3; n++) await seedCommit(iManyBe, mManyBe, 6, 'backend', `be-many-${n}`);

        const iPending = await mkIssue(`CC-待上线空-${RUN_TAG}`, '待上线');   // 空态 → 「未填」
        await mkMember(iPending, 7);
        const iOther = await mkIssue(`CC-处理中空-${RUN_TAG}`, '处理中');     // 空态 → 「—」
        await mkMember(iOther, 8);

        // ── S1 夹具（时间格式统一 20260804·D1/D2）：**刻意填上 module_name** ──
        //   mkIssue 默认不填模块（NULL），那种单原本渲染成 `BMS · —`；拿它断言虽也能红/绿，
        //   但证不到 D1 真正要改的那一半——「存量填了模块的单，列表里也不再显示模块」。
        //   要让断言有判别力，夹具必须落在"填了"这一侧。
        const iMod = await mkIssue(`CC-模块列-${RUN_TAG}`, '处理中');
        await run(`UPDATE sys_issues SET module_name = ? WHERE id = ?`, ['报价模块', iMod]);
        //   S2 夹具（时间格式统一 20260804·D13）：补一条时间线记录供 [T25] 验"正文到分 + title 到秒"。
        //   ⚠️ 必须显式插——mkIssue 是裸 INSERT 进 sys_issues，不走建单端点，**不会产生任何 timeline 事件**
        //     （首版 [T25] 就是栽在这：`.si-tl-time` 取到 null，红得像"实现坏了"，实则夹具没数据）。
        //   created_at 走表默认值 datetime('now','localtime') = **真实秒级**，正是本组要的判据源。
        //   清理由 finally 的 `DELETE FROM sys_issue_timeline WHERE issue_id = ?` 覆盖。
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, summary, operator_id, operator_name)
                   VALUES (?, 'created', ?, 1, '管理员')`, [iMod, `S2 时间轴夹具-${RUN_TAG}`]);

        browser = await chromium.launch();
        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Sys_Iteration.html`);
        // 循既有套件范式：列表是异步加载且可能无行，用 networkidle + 固定延时，不要 waitForSelector('tr')
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);

        // ── [T1] 表头 14 列 + 列序 ───────────────────────────────────────
        // ⚠️ locator 精确到列表表格 id（codex 247 M-1「确认表头 locator 只覆盖列表表格」→ 补做实查发现的真缺陷）：
        //   原写法首选择器 `#siTable` **在本页根本不存在**（真实 id 是 sysIterationListTable），一直靠兜底的
        //   `table thead th` 生效。本页另有两个动态拼接的表格（`.si-commit-table` 上线单 commit 表 / 值班排班表），
        //   只是断言时它们尚未插入 DOM，所以「恰好正确」。这个隐含前提在 D4（改上线单管理弹窗）时会被打破。
        //   三处同款（[T1]/[T2]/[T8]）一并按模式收口，不做症状式单点修补。
        // 同一次采集里把 data-sort-by 一起取回（codex 247 M-2）：纯文案断言挡不住「文案对但列错绑」——
        //   两列若被换成别的字段、或出现重复文案，只比文本仍会通过。
        const headCells = await page.$$eval('#sysIterationListTable thead th',
            ths => ths.map(t => ({ text: t.textContent.replace(/[⇅\s]/g, ''), sortBy: t.getAttribute('data-sort-by') || null })));
        const headers = headCells.map(h => h.text);
        must(headers.length === 14, `[T1] 列表表头应为 14 列，实得 ${headers.length}：${JSON.stringify(headers)}`);
        must(headers.includes('期望完成'), '[T1] 表头含「期望完成」列（D11）');
        must(headers.includes('前端号') && headers.includes('后端号'), '[T1] 表头含「前端号」「后端号」两列');
        must(headers[headers.length - 1] === '计划开工', `[T1] 「计划开工」应在**末列**（D13），实得末列=${headers[headers.length - 1]}`);
        // D1（四处优化①）：表头「预计完成时间」→「预计完成」，与右邻「期望完成」等字长。
        //   下面两条比旧的 indexOf 相邻判据更强：① 精确锁定左邻列文案（顺带蕴含等字长）② 显式挡旧文案回退。
        //   codex 247 L-1：先显式断言 idxExpect > 0 再读左邻——否则「缺列」或「列跑到首位」会被报成
        //   「左邻文案错（undefined）」，不假绿但诊断指错方向。
        const idxExpect = headers.indexOf('期望完成');
        must(idxExpect > 0, `[T1] 「期望完成」应存在且不在首列（读左邻的前提），实得 index=${idxExpect}`);
        must(headCells[idxExpect - 1].text === '预计完成',
            `[T1] ①改名：「期望完成」左邻列表头应为「预计完成」（等字长 4 字），实得「${headCells[idxExpect - 1].text}」`);
        must(headCells[idxExpect - 1].sortBy === 'dev_estimated_at' && headCells[idxExpect].sortBy === 'deadline',
            `[T1] ⭐ 文案↔字段键绑定（codex 247 M-2）：「预计完成」须绑 dev_estimated_at、「期望完成」须绑 deadline`
            + `——挡住「文案改对了但列被换成别的字段」，实得 ${headCells[idxExpect - 1].sortBy} / ${headCells[idxExpect].sortBy}`);
        must(!headers.includes('预计完成时间'),
            `[T1] ⭐ ①防回退：列表页表头不得再出现旧文案「预计完成时间」，实得 ${JSON.stringify(headers)}`);

        // ── [T1b] S1 模块列收窄（时间格式统一 20260804·D1/D2）─────────────
        //   ⚠️ headers 采集时已 replace(/[⇅\s]/g, '') 去空白 ⇒ 旧文案「系统 · 模块」在此形态下是「系统·模块」，
        //     防回退断言必须按去空白后的形态写，照原文写会永远为真（断言自身失效）。
        const SYS_COL_IDX = 5;   // 0-based：ID/类型/优先级/状态/标题/**系统**/开发/建单人/预计完成/期望完成/前端号/后端号/创建时间/计划开工
        must(headers[SYS_COL_IDX] === '系统' && headCells[SYS_COL_IDX].sortBy === 'system_name',
            `[T1b] 第 6 列表头应为「系统」且绑 system_name，实得「${headers[SYS_COL_IDX]}」/ ${headCells[SYS_COL_IDX].sortBy}`);
        must(!headers.includes('系统·模块'),
            `[T1b] ⭐ 防回退：表头不得再出现旧文案「系统 · 模块」，实得 ${JSON.stringify(headers)}`);
        must(headers.length === 14,
            `[T1b] 收窄只改列内容不改列数，仍应为 14 列，实得 ${headers.length}`);
        // ⭐ 行内断言（比表头强）：表头改对但行渲染仍拼 module_name，是最可能的半吊子形态。
        //   夹具 iMod 的 module_name='报价模块'，只有拼接确实拆掉才会得到纯 'BMS'。
        const modCellText = await page.evaluate(({ id, idx }) => {
            const rows = [...document.querySelectorAll('#siTbody tr')];
            const tr = rows.find(r => r.querySelector('td') && r.querySelector('td').textContent.trim() === '#' + id);
            if (!tr) return null;
            const tds = [...tr.querySelectorAll('td')];
            return tds[idx] ? tds[idx].textContent.trim() : null;
        }, { id: iMod, idx: SYS_COL_IDX });
        must(modCellText !== null, `[T1b] 夹具单 #${iMod} 应出现在列表里（后续断言的前提），实得 ${modCellText}`);
        must(modCellText === FIXTURE_SYSTEM,
            `[T1b] ⭐ 填了 module_name('报价模块') 的单，「系统」列也只显示 system_name（应为 ${FIXTURE_SYSTEM}），实得 "${modCellText}"`);
        //   ⚠️ 不再补一条「不含 · 且不含 报价模块」——它与上一条**诊断方向相同**（都指向"拼接没拆"），
        //     且上一条通过时它恒真，属虚增通过数的冗余。上面的 `!== null` 前提断言则不同：它红时指向的是
        //     "夹具没进列表"这一**另一种失败模式**（循 [T1] codex 247 L-1 的前提断言范式），故保留。
        //   换成有独立判别力的：锁住 D2 的**另一半**（只收窄列表页，详情抽屉的模块字段必须保留），
        //   防的是未来有人把"收窄"顺手做成"删字段"。静态源码比对，循 [T8] 的 [A4-static] 合同锁范式。
        //   ⚠️ 静态锁的取舍（codex 251 L-1 提醒它对排版敏感）：明知它会因无行为变化的排版调整误报，仍选静态锁——
        //     这三处本次**零改动**，风险是"未来有人顺手删"，此时误报(红)的代价远小于漏报(绿)；且改成运行时断言
        //     要走"开抽屉→点编辑→读 input"三跳交互，成本超过它锁住的东西。窗口放宽到 120 字符容纳属性微调。
        const pageSrcT1b = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
        must(/<div class="u-kv-item"><label>模块<\/label>[\s\S]{0,120}?iss\.module_name/.test(pageSrcT1b),
            '[T1b] ⭐ D2：详情抽屉的「模块」kv 必须保留（收窄只针对列表页，不是删字段）');
        //   ⚠️ 建单有**两个入口**（3574「派生迭代（基于本单新建）」/ 3681「新建迭代单」），各带一处输入项 + 一处
        //     payload 组装。这类多点模式先后踩了两层坑，最终按**入口分区**锁：
        //     ① 存在性断言（`.test()`）挡不住"只删其中一处"——反证实测删掉「新建迭代单」那处仍为 true，锁形同虚设；
        //     ② 全局计数（`=== 2`）只保证总数，挡不住"删掉入口A、在入口B重复一份"（codex 251-B M-1）。
        //     故用 siModal 标题把源码切成两段，各段内锁"恰好一处"——这才真正表达 D2 的"两个入口都要保留"。
        //     输入项两处的第三参数本可靠正则区分（派生预填 iss.module_name / 新建给空串），但 payload 两处字符串
        //     **完全相同**，只能靠分区；两类统一走分区，口径一致，不留一半强一半弱。
        const idxDerive = pageSrcT1b.indexOf("siModal('派生迭代（基于本单新建）'");
        const idxCreate = pageSrcT1b.indexOf("siModal('新建迭代单'");
        must(idxDerive > 0 && idxCreate > idxDerive,
            `[T1b] 两个建单入口的 siModal 标题都应可定位且派生在前（分区断言的前提），实得 ${idxDerive} / ${idxCreate}`);
        const idxAfterCreate = pageSrcT1b.indexOf('siModal(', idxCreate + 10);
        const segOf = (from, to) => pageSrcT1b.slice(from, to > 0 ? to : pageSrcT1b.length);
        const lockEntry = (seg, label) => {
            const nInput = (seg.match(/fText\('module_name',\s*'模块（选填）'/g) || []).length;
            must(nInput === 1,
                `[T1b] ⭐ D2：「${label}」入口须保留恰好一处「模块（选填）」输入项，实得 ${nInput} 处`);
            const nPayload = (seg.match(/body\.module_name\s*=\s*v\.module_name/g) || []).length;
            must(nPayload === 1,
                `[T1b] ⭐ D2：「${label}」入口的提交 payload 须恰好装一次 module_name（否则填了存不进去），实得 ${nPayload} 处`);
        };
        lockEntry(segOf(idxDerive, idxCreate), '派生迭代');
        lockEntry(segOf(idxCreate, idxAfterCreate), '新建迭代单');
        //   codex 251 M-1（采纳）：D2 明确编辑表单也在保留之列，原先只锁了抽屉+建单——
        //   删掉编辑表单的输入项或从提交 payload 里摘掉 module_name，全套断言仍会绿。补两条堵上：
        must(/fText\('module_name',\s*'模块',\s*iss\.module_name/.test(pageSrcT1b),
            '[T1b] ⭐ D2：编辑表单的「模块」输入项必须保留且回填 iss.module_name');
        must(/module_name:\s*v\.module_name,/.test(pageSrcT1b),
            '[T1b] ⭐ D2：编辑提交 payload 必须仍含 module_name（否则编辑一次就把模块清空）');

        // ── [T2] ⭐ 1920 视口下不横滚（D12 预案触发判据）─────────────────
        const scrollInfo = await page.evaluate(() => {
            // 精确 id（同 [T1] 的收口理由）：原 `#siTable || table` 兜底会在页面出现第二个表格时测错对象——
            //   横滚判据测错表 = D12 预案的触发条件被静默跳过，比直接红更危险。取不到就让它抛，红总比错好。
            const tbl = document.querySelector('#sysIterationListTable');
            const wrap = tbl.closest('.u-corr-table-wrap') || tbl.parentElement;
            return {
                docScrollW: document.documentElement.scrollWidth,
                docClientW: document.documentElement.clientWidth,
                wrapScrollW: wrap.scrollWidth,
                wrapClientW: wrap.clientWidth,
                tableW: Math.round(tbl.getBoundingClientRect().width),
            };
        });
        const noPageHScroll = scrollInfo.docScrollW <= scrollInfo.docClientW + 1;
        must(noPageHScroll,
            `[T2] ⭐ 1920 下页面**不应横滚**：documentElement scrollWidth=${scrollInfo.docScrollW} vs clientWidth=${scrollInfo.docClientW}（表宽 ${scrollInfo.tableW}）——若红则触发 D12 预案：合并「预计完成/期望完成」为一列双行`);
        // ⭐ codex 审 243 MED-1：仅断言页面级会漏判——表格若在 overflow-x 容器内，**页面不滚而容器自己滚**，
        //   D12 的触发条件就被静默跳过。本条把已经收集但从未断言的 wrapScrollW/wrapClientW 用上。
        const noWrapHScroll = scrollInfo.wrapScrollW <= scrollInfo.wrapClientW + 1;
        must(noWrapHScroll,
            `[T2b] ⭐ 表格容器自身也不应横滚：wrap scrollWidth=${scrollInfo.wrapScrollW} vs clientWidth=${scrollInfo.wrapClientW}——页面级不滚但容器滚，同样要触发 D12 预案`);
        if (!noPageHScroll || !noWrapHScroll) {
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
            const p = path.join(SCREENSHOT_DIR, `commitcols-hscroll-${RUN_TAG}.png`);
            await page.screenshot({ path: p, fullPage: false });
            console.log(`     📸 横滚证据截图: ${p}`);
        }

        // ── [T3] 渲染三态 ────────────────────────────────────────────────
        const cellOf = async (issueId, which) => page.evaluate(({ id, which }) => {
            const rows = [...document.querySelectorAll('#siTbody tr')];
            // ID 列渲染为 `#123`（带 # 前缀），不是纯数字——按 '#'+id 精确匹配，不用 includes（防 #12 命中 #123）
            const tr = rows.find(r => r.querySelector('td') && r.querySelector('td').textContent.trim() === '#' + id);
            if (!tr) return null;
            const tds = [...tr.querySelectorAll('td')];
            const idx = which === 'fe' ? 10 : 11;   // 0-based：前端号=第 11 列、后端号=第 12 列
            const td = tds[idx];
            return { text: td.textContent.trim(), html: td.innerHTML, title: (td.querySelector('[title]') || {}).title || '' };
        }, { id: issueId, which });

        const twoFe = await cellOf(iTwo, 'fe');
        must(twoFe && twoFe.text === 'fe-aaa111; fe-bbb222', `[T3] ≤2 条全量显示且分号隔开，实得 "${twoFe && twoFe.text}"`);
        const twoBe = await cellOf(iTwo, 'be');
        must(twoBe && twoBe.text === 'be-ccc333', `[T3] 后端组只含 backend ref，实得 "${twoBe && twoBe.text}"`);

        const manyFe = await cellOf(iMany, 'fe');
        must(manyFe && /^fe-many-1\s+等5条$/.test(manyFe.text), `[T3] >2 条显示「首条 + 等5条」，实得 "${manyFe && manyFe.text}"`);
        must(manyFe && manyFe.title.includes('fe-many-5') && manyFe.title.includes('fe-many-1'),
            `[T3] 「等N条」的 title 应含完整清单（含被收起的 fe-many-5），实得 title="${manyFe && manyFe.title}"`);

        // ── [T4] 空态两语义（D6）────────────────────────────────────────
        const pendFe = await cellOf(iPending, 'fe');
        must(pendFe && pendFe.text === '未填', `[T4] 「待上线」单空 commit 应显示「未填」，实得 "${pendFe && pendFe.text}"`);
        const otherFe = await cellOf(iOther, 'fe');
        must(otherFe && otherFe.text === '—', `[T4] 非待上线单空 commit 应显示「—」，实得 "${otherFe && otherFe.text}"`);

        // ── [T6] siNormalizeCommitRefs 边界契约（codex 审 243 rec-1）───────
        //   直接在浏览器里调页面函数，逐个锁住签名 `string|array|null|undefined -> array|null`。
        //   比只靠整页冒烟更能锁边界：整页冒烟只会走到"后端给了什么"这一条路径。
        const norm = await page.evaluate(() => {
            const f = window.siNormalizeCommitRefs;
            if (typeof f !== 'function') return { __missing: true };
            const j = (v) => JSON.stringify(v === undefined ? '__undefined__' : v);
            return {
                nul: j(f(null)), und: j(f(undefined)),
                arr: j(f(['a', 'b'])), json: j(f('["a","b"]')),
                empty: j(f('')), blank: j(f('   ')),
                badJson: j(f('not json')), objJson: j(f('{"a":1}')),
                numeric: j(f(42)), mixed: j(f(['a', 1, null, '   ', 'b'])),
                emptyArr: j(f([])), emptyJsonArr: j(f('[]')),
            };
        });
        must(!norm.__missing, '[T6] siNormalizeCommitRefs 应是全局可调函数');
        must(norm.nul === 'null' && norm.und === 'null', `[T6] null/undefined → null（读不出来），实得 ${norm.nul}/${norm.und}`);
        must(norm.arr === '["a","b"]' && norm.json === '["a","b"]', `[T6] 真数组与 JSON 字符串两种形态归一到同一结果，实得 ${norm.arr}/${norm.json}`);
        must(norm.empty === 'null' && norm.blank === 'null', `[T6] ⭐ 空串/全空白 → null 而非 []（畸形值不得冒充「确实没有」·codex 243 MED-2），实得 ${norm.empty}/${norm.blank}`);
        must(norm.badJson === 'null' && norm.objJson === 'null' && norm.numeric === 'null',
            `[T6] 非法 JSON / 非数组 JSON / 非字符串非数组 → 一律 null，实得 ${norm.badJson}/${norm.objJson}/${norm.numeric}`);
        must(norm.mixed === '["a","b"]', `[T6] 混合数组剔除非字符串与空白元素，实得 ${norm.mixed}`);
        must(norm.emptyArr === '[]' && norm.emptyJsonArr === '[]', `[T6] 空数组与 '[]' → []（确实没有，与 null 严格区分），实得 ${norm.emptyArr}/${norm.emptyJsonArr}`);

        // ── [T7] XSS：commit_ref 是用户可填自由文本，进文本位与 title 属性位（codex 审 243 rec-2）──
        const XSS_REF = `"><img src=x onerror="window.__xss=1">&<'`;
        const iXss = await mkIssue(`CC-XSS-${RUN_TAG}`, '处理中');
        const mXss = await mkMember(iXss, 9);
        await seedCommit(iXss, mXss, 9, 'frontend', XSS_REF);
        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(600);
        const xssCell = await cellOf(iXss, 'fe');
        const xssProbe = await page.evaluate(() => ({ fired: !!window.__xss, imgs: document.querySelectorAll('#siTbody img').length }));
        must(xssProbe.fired === false, '[T7] ⭐ 恶意 commit_ref 未触发脚本执行（window.__xss 未被置位）');
        must(xssProbe.imgs === 0, `[T7] 恶意 payload 未产出真实 DOM 元素（tbody 内 img 数应为 0，实得 ${xssProbe.imgs}）`);
        must(xssCell && xssCell.text === XSS_REF, `[T7] 恶意串应原样作为**文本**呈现（转义生效而非吞掉），实得 "${xssCell && xssCell.text}"`);
        must(xssCell && xssCell.title === XSS_REF, `[T7] title 属性位同样完整且未被引号击穿，实得 "${xssCell && xssCell.title}"`);

        // ── [T8] 排序类型注册完整性（通用守卫·防复发）─────────────────────
        //   本次真踩到：新增「期望完成」列时漏把 deadline 登进 SI_SORT_FIELD_TYPES，该列排序会拿不到
        //   类型、退化成非日期序。这不是"这一列"的问题，是**每次加可排序列都可能重犯**的模式，
        //   故断言写成通用形式：页面上每个 u-sortable 的 data-sort-by 都必须在映射表里登记。
        //   ⚠️ 实现方式：**读源码静态比对**，不走 page.evaluate 取 window.SI_SORT_FIELD_TYPES——它是 `const`
        //   声明，const/let 不挂 window（本项目 playwright_suite_gotchas 第一条，本次实测复现）。
        //   同 verify-sys-commit-cols 的 [A4-static] 合同锁范式。
        const declared = await page.evaluate(() =>
            // 精确 id（同 [T1] 收口）：兜底 `table thead th.u-sortable` 会把未来出现的第二个表格的可排序列
            //   也算进"本页声明"，让 [T8] 的登记完整性判据跑偏到别的表上。
            [...document.querySelectorAll('#sysIterationListTable thead th.u-sortable')]
                .map(th => th.getAttribute('data-sort-by')).filter(Boolean));
        const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
        const mapBody = (pageSrc.match(/const\s+SI_SORT_FIELD_TYPES\s*=\s*\{([\s\S]*?)\n\s*\};/) || [])[1] || '';
        const keys = [...mapBody.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map(m => m[1]);
        const sortReg = { missing: declared.filter(d => !keys.includes(d)), declared, keys };
        must(keys.length > 0, `[T8] 应能从源码解析出 SI_SORT_FIELD_TYPES 的键集（解析失败说明正则与代码结构脱节），实得 ${keys.length} 个`);
        must(sortReg.missing.length === 0,
            `[T8] 每个可排序列都应在 SI_SORT_FIELD_TYPES 登记，未登记的：${JSON.stringify(sortReg.missing)}（本次 deadline 曾漏登记）`);
        must(sortReg.declared.includes('deadline'), '[T8] 「期望完成」列确实声明了 data-sort-by="deadline"');
        must(!sortReg.declared.includes('frontend_commit_refs') && !sortReg.declared.includes('backend_commit_refs'),
            '[T8] commit 两列刻意不可排序（按 JSON 串排序无业务含义·锚点 §9 P2），不应出现在可排序集合里');

        // ══ 四处优化 ②「期望完成到时分」的页面层断言（D2）══════════════════════════════
        // ── [T17] ⭐ 混存排序真行为（存量纯日期 + 新值带时分）────────────────────────
        //   为什么必须有这一条：verify 侧 [E1] 是源码合同锁、[E2] 是纯 JS 反证，两者都证明不了
        //   「页面上真的排对了」——共享排序层换实现、或 data-sort-by 被改，两条静态锁照样全绿而列表在错。
        //   夹具取 2099 远期值：**降序时必落在首页首屏**，规避分页导致 findIndex 找不到行的干扰。
        //   判据方向只验降序即可抓住回退：若 deadline 被改回 'date' 类型，new Date('2099-12-31') 按 UTC
        //   午夜解析 = 本地 08:00 > 本地 07:00 ⇒ 降序时纯日期反而排到 07:00 前面 ⇒ 本条必红。
        const iLegacyDay = await mkIssue(`CC-存量纯日期-${RUN_TAG}`, '处理中');
        const iSameDayAM = await mkIssue(`CC-同日早时分-${RUN_TAG}`, '处理中');
        await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, ['2099-12-31', iLegacyDay]);
        await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, ['2099-12-31 07:00', iSameDayAM]);
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(600);
        const deadlineTh = '#sysIterationListTable thead th[data-sort-by="deadline"]';
        // 方向以表头箭头为准（不猜首次点击是升还是降）：最多点两次拿到降序态
        const dirOf = () => page.$eval(deadlineTh, th => th.textContent.includes('↑') ? 'asc' : (th.textContent.includes('↓') ? 'desc' : 'none'));
        let sortDir = 'none';
        for (let n = 0; n < 2 && sortDir !== 'desc'; n++) {
            await page.click(deadlineTh);
            await page.waitForTimeout(300);
            sortDir = await dirOf();
        }
        must(sortDir === 'desc', `[T17] 前置：点击「期望完成」表头应能进入降序态，实得 ${sortDir}`);
        const rowTexts = await page.$$eval('#siTbody tr', trs => trs.map(tr => tr.textContent || ''));
        const ixLegacy = rowTexts.findIndex(t => t.includes(`CC-存量纯日期-${RUN_TAG}`));
        const ixEarly = rowTexts.findIndex(t => t.includes(`CC-同日早时分-${RUN_TAG}`));
        must(ixLegacy >= 0 && ixEarly >= 0,
            `[T17] 两条 2099 夹具应都出现在降序首页（找不到多半是分页或筛选干扰，非排序错），实得 idx 纯日期=${ixLegacy} / 早时分=${ixEarly}`);
        must(ixEarly < ixLegacy,
            `[T17] ⭐ 降序下「2099-12-31 07:00」应排在「2099-12-31」**之前**（纯日期视同当天最早）。`
            + `若本条红＝deadline 排序类型被改回 'date'，UTC/本地混解析把纯日期算成了当天 08:00。实得 idx 早时分=${ixEarly} / 纯日期=${ixLegacy}`);

        // ── [T18] ② 建单弹窗：控件升 datetime-local + 选填不带必填星号 ────────────────
        await page.evaluate(() => window.siOpenCreate && window.siOpenCreate());
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        const createDl = await page.$eval('#f_deadline', el => {
            const grp = el.closest('.u-form-group');
            return { type: el.type, label: grp ? grp.querySelector('label').textContent : '', hasReq: !!(grp && grp.querySelector('.u-req')) };
        });
        must(createDl.type === 'datetime-local',
            `[T18] ⭐ 建单弹窗「期望完成」控件应为 datetime-local（②的核心交付物），实得 type=${createDl.type}`);
        must(!createDl.hasReq,
            `[T18] 「期望完成」是选填（E3 不强制到分钟），不得渲染必填星号——原 fDateTime 把星号硬编码在 label 里，这条挡住复用时误带星号。实得 label=「${createDl.label}」`);
        must(createDl.label.includes('期望完成'),
            `[T18] 建单弹窗 label 应用统一叫法「期望完成」，实得「${createDl.label}」`);

        // ── [T19] ② 编辑弹窗：存量**纯日期**预填必须补 T00:00（防静默清空）────────────
        //   不补的话控件是空的，用户根本没动这个字段、点保存就把原值清掉了——静默数据丢失。
        //   verify 的 [F3] 只锁了源码里有这个分支，这条证明它在真实页面上确实生效。
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        await page.evaluate((id) => window.siModalEditInRevision && window.siModalEditInRevision({
            id, title: 'T19 夹具', description: '', system_name: 'BMS', module_name: '', priority: 'P2',
            deadline: '2099-12-31', requester_dept: '', requester_name: '', requester_phone: '',
            status: '待受理', type: 'bug', needs_feasibility: 0,
        }), iLegacyDay);
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        const editDl = await page.$eval('#f_deadline', el => ({ type: el.type, value: el.value }));
        must(editDl.type === 'datetime-local',
            `[T19] 编辑弹窗控件也应为 datetime-local（E4：两处同步改，否则"建单能填分钟、一编辑就丢"），实得 ${editDl.type}`);
        must(editDl.value === '2099-12-31T00:00',
            `[T19] ⭐ 存量纯日期应预填为 2099-12-31T00:00（siToLocalInput 兼容分支真实生效）；`
            + `若实得空串＝控件没预填上，用户不动该字段点保存就会静默清空原 deadline。实得 "${editDl.value}"`);
        // ── [T20] ⭐ codex 248 HIGH-1 的端到端证据：编辑存量单但不碰 deadline，库里纯日期必须原样 ──
        //   三层各证一半、缺一层就有静默失败的口子：verify [F4] 只锁了源码里有 dirty 比对那一行；
        //   verify [D1] 测的是"后端没收到该字段时保留"——可**前端到底传没传**，只有走一遍真实提交才知道。
        //   （首版正是栽在这个缝里：[D1] 绿着，而前端编辑路径永远会传 deadline，等于测了条用户走不到的路。）
        const iDirty = await mkIssue(`CC-dirty-${RUN_TAG}`, '待受理');
        await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, ['2099-11-30', iDirty]);
        await page.evaluate((id) => window.siModalEditInRevision && window.siModalEditInRevision({
            id, title: '原标题', description: '', system_name: 'BMS', module_name: '', priority: 'P2',
            deadline: '2099-11-30', requester_dept: '', requester_name: '', requester_phone: '',
            status: '待受理', type: 'bug', needs_feasibility: 0,
        }), iDirty);
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        const dirtyPrefill = await page.$eval('#f_deadline', el => el.value);
        must(dirtyPrefill === '2099-11-30T00:00', `[T20] 前置：存量纯日期应预填 T00:00，实得 "${dirtyPrefill}"`);
        await page.fill('#f_title', `CC-dirty-改过标题-${RUN_TAG}`);   // ⚠️ 只改标题，deadline 一个字都不碰
        await page.click('#siMConfirm');
        await page.waitForTimeout(1500);
        const afterDirty = await get('SELECT title, deadline FROM sys_issues WHERE id = ?', [iDirty]);
        must(afterDirty && /改过标题/.test(afterDirty.title || ''),
            `[T20] 前置：标题应已改（证明这次提交真的走通了，不是整体没生效导致 deadline "恰好"没变），实得 "${afterDirty && afterDirty.title}"`);
        must(afterDirty.deadline === '2099-11-30',
            `[T20] ⭐ 只改标题、没碰 deadline ⇒ 库里必须仍是纯日期 '2099-11-30'。`
            + `若实得 '2099-11-30 00:00' 即 dirty 判断失效、存量精度被**被动伪造**（codex 248 HIGH-1，E2 明确要防的）。实得 "${afterDirty.deadline}"`);

        // 复位：关掉编辑弹窗 + 清掉排序态，不把页面状态带进下面的 [T9-T11]
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(300);

        // ── [T9-T11] C5：批次详情成员列表两列 ─────────────────────────────
        //   degraded 态**只可能出现在这个端点**（列表端点的 SQL 聚合恒返回 '[]' 不返 null），
        //   故「不可用」渲染分支的真实覆盖点在这里，列表页测不到。
        const relIds = createdReleaseIds;
        const mkRel = async (status) => {
            const r = await run(
                `INSERT INTO sys_releases (release_no, title, status, is_hotfix, created_by, created_by_name)
                 VALUES (?, ?, ?, 0, ?, '管理员')`, [`RCC-${RUN_TAG}-${relIds.length + 1}`, `冒烟批次${relIds.length + 1}`, status, admin.id]);
            relIds.push(r.lastID);
            return r.lastID;
        };
        const attach = (issueId, relId, st) => run(`UPDATE sys_issues SET release_id = ?, status = ? WHERE id = ?`, [relId, st, issueId]);

        // 计划中批次：i2Two（前2后1）+ iMany（前5）+ iPending（空·待上线）
        const relPlan = await mkRel('计划中');
        await attach(iTwo, relPlan, '待上线');
        await attach(iMany, relPlan, '待上线');
        await attach(iManyBe, relPlan, '待上线');
        await attach(iPending, relPlan, '待上线');

        // 已发布批次 + 只有 timeline 无快照 → degraded（commits=null → 「不可用」）
        const relDeg = await mkRel('已发布');
        const iDeg = await mkIssue(`CC-批次degraded-${RUN_TAG}`, '已上线');
        await attach(iDeg, relDeg, '已上线');
        await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, action_code, ref_id, summary, operator_id, operator_name)
                   VALUES (?, 'scope_change', 'release_published', ?, ?, ?, '管理员')`,
            [iDeg, relDeg, JSON.stringify({ schema_version: 2, type: 'bug', title_snapshot: 'CC-批次degraded', status_at_publish: '已上线', commits: null }), admin.id]);

        // ⭐ codex 审 244 LOW-1：siOpenBatchDetail 是 async，原实现没 return 它的 Promise、只靠固定
        //   waitForTimeout(700)——真实库/真实 server 下会偶发失败，或在连续切批次时读到**上一轮的 DOM**。
        //   改为 return Promise 让 evaluate 等它 resolve，再 waitForFunction 等目标行真正出现。
        const batchRowOf = async (relId, issueId) => {
            await page.evaluate((rid) => {
                document.getElementById('siBatchOverlay').classList.add('open');
                return window.siOpenBatchDetail(rid);
            }, relId);
            await page.waitForFunction(
                (iid) => [...document.querySelectorAll('#siBatchBody .si-att-item, .si-att-item')]
                    .some(el => new RegExp('^#' + iid + '(?!\\d)').test((el.querySelector('.si-att-name') || el).textContent.trim())),
                issueId, { timeout: 10000 }
            ).catch(() => { /* 交由下方断言给出可读失败信息，不在此吞掉上下文 */ });
            return page.evaluate((iid) => {
                // codex rec-2：查询范围收窄到批次面板，避免页面其他隐藏区域的同类 class 干扰
                const scope = document.querySelector('#siBatchBody') || document;
                const items = [...scope.querySelectorAll('.si-att-item')];
                const row = items.find(el => new RegExp('^#' + iid + '(?!\\d)').test((el.querySelector('.si-att-name') || el).textContent.trim()));
                if (!row) return null;
                const cs = [...row.querySelectorAll('.si-batch-commit')];
                const rowBox = row.getBoundingClientRect();
                const badge = row.querySelector('.u-status-badge, .si-muted[title*="状态"]');
                const lastCell = cs[cs.length - 1];
                return {
                    count: cs.length, fe: (cs[0] || {}).textContent || '', be: (cs[1] || {}).textContent || '',
                    feTitle: (cs[0] || {}).title || '',
                    // 布局证据（codex LOW-2）：状态徽章右边界不得越过行右边界（即未被 commit 列挤出可视区）
                    badgeRight: badge ? Math.round(badge.getBoundingClientRect().right) : null,
                    rowRight: Math.round(rowBox.right),
                    commitRight: lastCell ? Math.round(lastCell.getBoundingClientRect().right) : null,
                };
            }, issueId);
        };

        const bTwo = await batchRowOf(relPlan, iTwo);
        must(bTwo && bTwo.count === 2, `[T9] 批次成员行应有前端/后端两个 commit 区块，实得 ${bTwo && bTwo.count}`);
        must(bTwo && bTwo.fe === '前端fe-aaa111; fe-bbb222', `[T9] 前端组值正确（含标签），实得 "${bTwo && bTwo.fe}"`);
        must(bTwo && bTwo.be === '后端be-ccc333', `[T9] 后端组值正确，实得 "${bTwo && bTwo.be}"`);

        const bMany = await batchRowOf(relPlan, iMany);
        must(bMany && bMany.fe === '前端fe-many-1 等5条', `[T10] 批次详情同样走收起渲染，实得 "${bMany && bMany.fe}"`);
        must(bMany && bMany.feTitle.includes('fe-many-5'), `[T10] title 含完整清单，实得 "${bMany && bMany.feTitle}"`);

        const bPend = await batchRowOf(relPlan, iPending);
        must(bPend && bPend.fe === '前端未填', `[T10] 待上线空 commit 在批次详情同样显示「未填」，实得 "${bPend && bPend.fe}"`);

        const bDeg = await batchRowOf(relDeg, iDeg);
        must(bDeg && bDeg.fe === '前端不可用' && bDeg.be === '后端不可用',
            `[T11] ⭐ degraded 批次（快照缺失）应显示「不可用」而非「—」——只有本端点能触发该分支，实得 fe="${bDeg && bDeg.fe}" be="${bDeg && bDeg.be}"`);

        // ── [T12] 布局边界：超长 ref 不得把状态徽章挤出可视区（codex 审 244 LOW-2）──────
        //   本次最主要的风险是 flex 溢出，而 T9-T11 全是文本断言——**溢出回归仍会让它们全绿**。
        //   故补真实几何断言 + 一条超长 ref 夹具（远超 190px 上限）。
        const iLong = await mkIssue(`CC-超长ref-${RUN_TAG}`, '待上线');
        const mLong = await mkMember(iLong, 12);
        await seedCommit(iLong, mLong, 12, 'frontend', 'feature/very-long-branch-name-that-should-be-truncated-by-css-ellipsis-1234567890abcdef');
        await seedCommit(iLong, mLong, 12, 'backend', 'release/another-extremely-long-reference-string-for-overflow-testing-0987654321fedcba');
        await attach(iLong, relPlan, '待上线');
        const bLong = await batchRowOf(relPlan, iLong);
        must(bLong && bLong.badgeRight !== null && bLong.rowRight !== null,
            '[T12] 应能取到状态徽章与行的几何信息（取不到说明结构变了，断言失去意义）');
        must(bLong && bLong.badgeRight <= bLong.rowRight + 1,
            `[T12] ⭐ 超长 ref 下状态徽章右边界(${bLong && bLong.badgeRight}) 不得越过行右边界(${bLong && bLong.rowRight})——即 commit 列未把它挤出可视区`);
        must(bLong && bLong.commitRight <= bLong.rowRight + 1,
            `[T12] commit 区块自身也不得越界（max-width + ellipsis 生效），commitRight=${bLong && bLong.commitRight} rowRight=${bLong && bLong.rowRight}`);
        must(bLong && bLong.feTitle.includes('feature/very-long-branch-name'),
            `[T12] 被 ellipsis 截断后，**外层** .si-batch-commit 上仍挂着完整 ref 的 title（codex 244 MED-1），实得 "${(bLong && bLong.feTitle || '').slice(0, 40)}..."`);
        await page.evaluate(() => { const o = document.getElementById('siBatchOverlay'); if (o) o.classList.remove('open'); });

        // ── [T13] C5b 一键复制（D10）+ **四处优化 D3**（E5 拆两按钮只复制编号 / E6 空组不渲染）
        //   + **S4**（GIT/SVN 对调 + 复制格式按侧差异化，2026-08-04 用户拍板）──
        //   纯函数边界先锁（整页冒烟只走"这批数据恰好长什么样"一条路径）
        const copyFn = await page.evaluate(() => {
            const f = window.siBuildCommitCopyText;
            if (typeof f !== 'function') return { __missing: true };
            //   codex 249 LOW-2 收口后入参是**已归一化数组**（不是 raw）：调用方本就要解析一次取 title 条数，
            //   再让本函数内部解析第二次，会给"title 说 N 条、实际复制 M 条"留漂移口子。
            //   ⭐ S4：签名升级为 (refs, side)——按 side 差异化分隔符（前端 '\n' 换行 / 后端 ',' 拼接）。
            return {
                arity: f.length,
                feTwo: f(['a', 'b'], '前端'),
                beTwo: f(['a', 'b'], '后端'),
                one: f(['c'], '前端'),
                empty: f([], '前端'),
                degraded: f(null, '后端'),
                feWithSemicolon: f(['a;b', 'c'], '前端'),
                beWithSemicolon: f(['a;b', 'c'], '后端'),
                // codex 审 18 复审建议：锁住未知 side 的回落方向（换行而非逗号），防后续误改回"静默按后端"
                unknownSide: f(['a', 'b'], 'frontend'),
                missingSide: f(['a', 'b'], undefined),
            };
        });
        must(!copyFn.__missing, '[T13] siBuildCommitCopyText 应是全局可调函数');
        // ⭐ S4 复审收口：未知/缺失 side 必须回落**换行**并显式报错，不得静默按后端逗号处理——
        //   静默退化会让前端复制格式在文案改动/国际化后悄悄变成逗号且毫无症状。换行是两者中对人更
        //   无害的一侧（粘到哪都是一行一个）。⚠️ 这两条会故意触发产品侧 console.error（那正是被测行为），
        //   故文件顶部 SI_EXPECTED_CONSOLE_ERR 对该条消息做了**精确文本豁免**，[T5] 仍拦其余所有 error。
        must(copyFn.unknownSide === 'a\nb',
            `[T13] ⭐ S4：未知 side（'frontend'）回落换行而非逗号，实得 ${JSON.stringify(copyFn.unknownSide)}`);
        must(copyFn.missingSide === 'a\nb',
            `[T13] ⭐ S4：缺失 side（undefined）同样回落换行，实得 ${JSON.stringify(copyFn.missingSide)}`);
        must(copyFn.arity === 2,
            `[T13] ⭐ S4：签名升级为 (refs, side) 双参——按 side 差异化分隔符（前端 '\\n' 换行 / 后端 ','`
            + ` 拼接，用户 2026-08-04 拍板；原 (feRaw, beRaw) 双组版那种"带前缀两行文本"隐患不复现，因 side`
            + ` 只是分隔符判据、不是把两组数据揉进一次调用），实得 arity=${copyFn.arity}`);
        must(copyFn.feTwo === 'a\nb',
            `[T13] ⭐ S4：前端多条 → '\\n' 换行拼接（一行一个，贴代码工具更好认），实得 ${JSON.stringify(copyFn.feTwo)}`);
        must(copyFn.beTwo === 'a,b',
            `[T13] ⭐ S4：后端多条 → ',' 拼接、无空格（贴运维汇报的惯用写法），实得 ${JSON.stringify(copyFn.beTwo)}`);
        must(copyFn.one === 'c', `[T13] 单条 → 纯编号（无分隔符可体现），实得 ${JSON.stringify(copyFn.one)}`);
        must(copyFn.empty === '' && copyFn.degraded === '',
            `[T13] 该组空 / 不可用 → 空串（调用方据此**不渲染该侧按钮**·E6），实得 ${JSON.stringify(copyFn.empty)}/${JSON.stringify(copyFn.degraded)}`);
        must(!/前端|后端/.test(copyFn.feTwo + copyFn.beTwo + copyFn.one),
            `[T13] ⭐ D3 防回退：复制文本里不得再出现「前端」「后端」字样，实得 ${JSON.stringify(copyFn.feTwo)}/${JSON.stringify(copyFn.beTwo)}`);
        must(copyFn.feWithSemicolon === 'a;b\nc' && copyFn.beWithSemicolon === 'a;b,c',
            `[T13] commit_ref 内部含分号时原样保留、不被错拆（两侧口径分别核对，非仅前端侧对照），`
            + `实得 fe=${JSON.stringify(copyFn.feWithSemicolon)} be=${JSON.stringify(copyFn.beWithSemicolon)}`);

        //   ⭐ 按钮渲染按**组**独立判定（E6）：两组都有 → 两个按钮；只有一组有 → 只渲染那一侧；都空 → 0 个
        await batchRowOf(relPlan, iTwo);   // relPlan 同时含 iTwo（前2后1）/ iMany（前5后0）/ iPending（皆空）
        const btnSides = await page.evaluate(({ bothId, feOnlyId, emptyId }) => {
            const scope = document.querySelector('#siBatchBody') || document;
            const pick = (iid) => {
                const row = [...scope.querySelectorAll('.si-att-item')].find(el => new RegExp('^#' + iid + '(?!\\d)').test((el.querySelector('.si-att-name') || el).textContent.trim()));
                if (!row) return null;
                return [...row.querySelectorAll('.si-batch-copy')].map(b => b.getAttribute('data-side'));
            };
            return { both: pick(bothId), feOnly: pick(feOnlyId), empty: pick(emptyId) };
        }, { bothId: iTwo, feOnlyId: iMany, emptyId: iPending });
        must(JSON.stringify(btnSides.both) === '["前端","后端"]',
            `[T13] ⭐ D3/E5：前后端都有 commit 的单 → **两个**按钮（前端一个、后端一个，按序），实得 ${JSON.stringify(btnSides.both)}`);
        must(JSON.stringify(btnSides.feOnly) === '["前端"]',
            `[T13] ⭐ D3/E6：只有前端 commit 的单 → **只渲染前端侧按钮**（后端组空，不给一个点了没反应的按钮），实得 ${JSON.stringify(btnSides.feOnly)}`);
        must(JSON.stringify(btnSides.empty) === '[]',
            `[T13] 两组皆空 → 0 个按钮，实得 ${JSON.stringify(btnSides.empty)}`);

        //   ⭐ 点击前端侧按钮 → 剪贴板 = 该组完整清单（不是屏幕上被收起/截断的文本，也不含另一组）
        await batchRowOf(relPlan, iMany);
        const clip = await page.evaluate(async (iid) => {
            const scope = document.querySelector('#siBatchBody') || document;
            const row = [...scope.querySelectorAll('.si-att-item')].find(el => new RegExp('^#' + iid + '(?!\\d)').test((el.querySelector('.si-att-name') || el).textContent.trim()));
            const btn = row && row.querySelector('.si-batch-copy[data-side="前端"]');
            if (!btn) return { err: 'no-button' };
            const shown = row.querySelector('.si-batch-commit').textContent;   // 屏幕上是「前端fe-many-1 等5条」
            btn.click();
            await new Promise(r => setTimeout(r, 350));
            const text = await navigator.clipboard.readText();
            return { text, shown, feedback: btn.textContent, title: btn.getAttribute('title') };
        }, iMany);
        must(!clip.err, `[T13] 应能按 data-side 定位到前端侧复制按钮，实得 ${clip.err || 'ok'}`);
        //   ⭐ S4：前端多条按 '\n' 换行拼接（不再是 '; '）。⚠️ Windows 下 navigator.clipboard 走系统剪贴板，
        //   写入的 '\n' 读回会被操作系统正规化成 '\r\n'（实测验证过，与 siBuildCommitCopyText 的实现无关，
        //   是 Chromium clipboard API 在本机的行为）——比较前统一把 '\r\n' 折回 '\n' 再判等，否则会在 Windows
        //   上误报红（execCommand 回退分支不经过这层系统剪贴板往返，见 [T14]，故那边不需要这个归一化）。
        const clipTextNorm = (clip.text || '').replace(/\r\n/g, '\n');
        must(clipTextNorm === 'fe-many-1\nfe-many-2\nfe-many-3\nfe-many-4\nfe-many-5',
            `[T13] ⭐ S4：复制内容 = 该组**完整 5 条纯编号**、'\\n' 换行拼接（屏幕上只显示 "${clip.shown}"，`
            + `收起的部分必须也在剪贴板里；不含「前端: 」前缀），实得 ${JSON.stringify(clip.text)}`);
        const feManyLines = clipTextNorm.split('\n');
        must(feManyLines.length === 5 && feManyLines.every((s, i) => s === `fe-many-${i + 1}`),
            `[T13] ⭐ S4 抓退化：按 '\\n' 切分后行数=条数=5 且每行是完整编号（不是被别的分隔符切碎的半截，`
            + `也不是两侧共用了同一个分隔符），实得 ${JSON.stringify(feManyLines)}`);
        // ⚠️ 边界（codex 审 18 LOW）：下面这条负断言只对**本夹具**成立（其值 fe-many-N 不含逗号/分号）。
        //   commit_ref 在产品上是允许包含逗号与分号的（本文件另有用例专门验证"内部含分号原样保留"），
        //   所以它是**夹具级退化探针**，不可上升为产品语义。真正的强判据是上面那条 split 逐行精确比对。
        must(!/,|; /.test(clip.text || ''),
            `[T13] ⭐ S4 抓退化（夹具级探针）：前端复制文本不得混入逗号或旧的 '; '，实得 ${JSON.stringify(clip.text)}`);
        must(/^复制前端 commit 编码（5 条/.test(clip.title || ''),
            `[T13] D3：两个按钮同为 📋，靠 title 区分侧别与条数，实得 ${JSON.stringify(clip.title)}`);
        must(clip.feedback === '✓ 已复制', `[T13] 点击后行内就地反馈「✓ 已复制」（不飘旗），实得 "${clip.feedback}"`);

        //   ⭐ codex 249 LOW-3：后端侧按钮此前只靠渲染列表间接覆盖，从没被真点过。iTwo = 前 2 后 1。
        await batchRowOf(relPlan, iTwo);
        const clipBe = await page.evaluate(async (iid) => {
            const scope = document.querySelector('#siBatchBody') || document;
            const row = [...scope.querySelectorAll('.si-att-item')].find(el => new RegExp('^#' + iid + '(?!\\d)').test((el.querySelector('.si-att-name') || el).textContent.trim()));
            const btn = row && row.querySelector('.si-batch-copy[data-side="后端"]');
            if (!btn) return { err: 'no-backend-button' };
            btn.click();
            await new Promise(r => setTimeout(r, 350));
            return { text: await navigator.clipboard.readText(), title: btn.getAttribute('title') };
        }, iTwo);
        must(!clipBe.err, `[T13] 应能定位到后端侧按钮，实得 ${clipBe.err || 'ok'}`);
        must(clipBe.text === 'be-ccc333',
            `[T13] ⭐ 点后端按钮 → 只拿到**后端**那一条纯编号，**不含前端的 fe-***、也不含「后端: 」前缀，实得 ${JSON.stringify(clipBe.text)}`);
        must(!/fe-/.test(clipBe.text) && !/后端/.test(clipBe.text),
            `[T13] ⭐ 两侧互不串（这正是 E5 拆按钮的目的：分别贴进两个窗口），实得 ${JSON.stringify(clipBe.text)}`);
        must(/^复制后端 commit 编码（1 条/.test(clipBe.title || ''),
            `[T13] 后端按钮 title 的条数应与实际复制内容一致（共用同一份 arr·LOW-2），实得 ${JSON.stringify(clipBe.title)}`);

        // ── [T13b] S4（复制格式按侧差异化，2026-08-04）：后端多条 → ',' 拼接、无空格 ─────────────
        //   iTwo 后端只有 1 条，join 分隔符对单值不可见，测不到"两侧用了同一个分隔符"这种退化；
        //   用新夹具 iManyBe（3 条后端）真点按钮 + 读剪贴板，逐条锁分隔符本身，不止断言"包含某条编号"。
        await batchRowOf(relPlan, iManyBe);
        const clipBeMany = await page.evaluate(async (iid) => {
            const scope = document.querySelector('#siBatchBody') || document;
            const row = [...scope.querySelectorAll('.si-att-item')].find(el => new RegExp('^#' + iid + '(?!\\d)').test((el.querySelector('.si-att-name') || el).textContent.trim()));
            const btn = row && row.querySelector('.si-batch-copy[data-side="后端"]');
            if (!btn) return { err: 'no-backend-button' };
            const shown = row.querySelector('.si-batch-commit').textContent;
            btn.click();
            await new Promise(r => setTimeout(r, 350));
            return { text: await navigator.clipboard.readText(), shown, title: btn.getAttribute('title') };
        }, iManyBe);
        must(!clipBeMany.err, `[T13b] 应能定位到后端侧复制按钮，实得 ${clipBeMany.err || 'ok'}`);
        must(clipBeMany.text === 'be-many-1,be-many-2,be-many-3',
            `[T13b] ⭐ S4：后端多条复制按 ',' 拼接、无空格（用户 2026-08-04 原话口径），实得 ${JSON.stringify(clipBeMany.text)}`);
        const beManyParts = (clipBeMany.text || '').split(',');
        must(beManyParts.length === 3 && beManyParts.every((s, i) => s === `be-many-${i + 1}`),
            `[T13b] ⭐ 抓退化：按 ',' 切分后段数=条数=3 且每段是完整编号（不是被别的分隔符切碎的半截，`
            + `也不是两侧共用了同一个分隔符），实得 ${JSON.stringify(beManyParts)}`);
        // ⚠️ 边界同 [T13]：本条只对本夹具（be-many-N，不含换行/分号）成立，是夹具级退化探针而非产品语义。
        must(!/\n|; /.test(clipBeMany.text || ''),
            `[T13b] ⭐ 抓退化（夹具级探针）：后端复制文本不得混入换行或旧的 '; '（防"两侧用了同一个分隔符"），`
            + `实得 ${JSON.stringify(clipBeMany.text)}`);
        must(/^复制后端 commit 编码（3 条/.test(clipBeMany.title || ''),
            `[T13b] 后端按钮 title 的条数应与实际复制内容一致，实得 ${JSON.stringify(clipBeMany.title)}`);

        //   ⭐ codex 249 MED-1：D3 声称「位置紧邻各自分组即语义」，这条几何断言把该前提真正锁住。
        //   诊断修正见 CSS 注释：.si-att-item 是 nowrap，换行不会发生；真问题是**行级 gap 均匀**
        //   让按钮左右等距、归属模糊。.si-batch-side 用内 3px / 外 8px 的间距差表达归属。
        const geom = await page.evaluate((iid) => {
            const scope = document.querySelector('#siBatchBody') || document;
            const row = [...scope.querySelectorAll('.si-att-item')].find(el => new RegExp('^#' + iid + '(?!\\d)').test((el.querySelector('.si-att-name') || el).textContent.trim()));
            if (!row) return { err: 'no-row' };
            const sides = [...row.querySelectorAll('.si-batch-side')];
            if (sides.length !== 2) return { err: 'sides=' + sides.length };
            const feBtn = sides[0].querySelector('.si-batch-copy');
            const feTxt = sides[0].querySelector('.si-batch-commit');
            const beTxt = sides[1].querySelector('.si-batch-commit');
            if (!feBtn || !feTxt || !beTxt) return { err: 'missing-parts' };
            const r = (el) => el.getBoundingClientRect();
            return {
                topDelta: Math.round(Math.abs(r(feTxt).top - r(beTxt).top)),  // nowrap 前提：两侧在同一行
                toOwn: Math.round(r(feBtn).left - r(feTxt).right),           // 前端按钮 ← 前端文本
                toNext: Math.round(r(beTxt).left - r(feBtn).right),          // 前端按钮 → 后端文本
                btnInsideSide: sides[0].contains(feBtn),
            };
        }, iTwo);
        must(!geom.err, `[T13] 几何采集应成功（每行应恰有 2 个 .si-batch-side），实得 ${geom.err || 'ok'}`);
        must(geom.btnInsideSide === true, '[T13] 复制按钮必须包在自己那侧的 .si-batch-side 内（不可拆分单元）');
        must(geom.topDelta < 2, `[T13] 前后端两侧应在同一行（.si-att-item 为 nowrap；若换行则"紧邻即语义"失效），实得两侧 top 差 ${geom.topDelta}px`);
        must(geom.toOwn < geom.toNext,
            `[T13] ⭐ 归属几何：前端按钮距**自己**分组（${geom.toOwn}px）必须小于距隔壁后端分组（${geom.toNext}px）。`
            + `若两者相等即回到"行级 gap 均匀、归属模糊"的老样子——那时 D3「位置紧邻即语义」的说法就是没有依据的`);

        // ── [T14] ⭐ execCommand 回退分支（**生产实际走的那条**·codex 审 245 LOW-2）──────
        //   生产是 HTTP 非安全上下文 → navigator.clipboard 不可用 → 走 execCommand；而 localhost 测试
        //   是安全上下文，上面 [T13] 测的是 Clipboard API 分支。**主功能的生产路径不能没有覆盖**，
        //   故此处临时屏蔽 navigator.clipboard + 探针化 execCommand，验证隐藏 textarea 收到精确文本并被移除。
        //   ⚠️ 这里刻意用一个**含换行**的字符串：D3 之后实际复制文本已不再有换行（拆按钮后每次只复制一组
        //   纯编号），但 siCopyToClipboard 是通用 helper，"任意文本逐字传递"的能力仍需覆盖——用实际形态
        //   反而测不到换行这条边界。
        const FB_TEXT = 'fb-1; fb-2\nfb-3';
        const fb = await page.evaluate(async (text) => {
            const origExec = document.execCommand;
            const origClip = navigator.clipboard;
            let captured = null, taSeen = false;
            document.execCommand = function (cmd) {
                if (cmd === 'copy') {
                    const ta = [...document.querySelectorAll('textarea')].find(t => t.style.left === '-9999px');
                    taSeen = !!ta; captured = ta ? ta.value : null;
                    return true;
                }
                return origExec.apply(document, arguments);
            };
            Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
            let threw = null;
            try { await window.siCopyToClipboard(text); } catch (e) { threw = e.message; }
            finally {
                Object.defineProperty(navigator, 'clipboard', { value: origClip, configurable: true });
                document.execCommand = origExec;
            }
            const leftover = [...document.querySelectorAll('textarea')].filter(t => t.style.left === '-9999px').length;
            return { captured, taSeen, leftover, threw };
        }, FB_TEXT);
        must(fb.threw === null, `[T14] 回退分支不应抛错，实得 ${fb.threw}`);
        must(fb.taSeen === true, '[T14] 复制期间应存在离屏 textarea（回退分支确实被走到，而非静默走了别的路）');
        must(fb.captured === FB_TEXT, `[T14] ⭐ 离屏 textarea 收到的文本应与入参**逐字一致**（含换行），实得 ${JSON.stringify(fb.captured)}`);
        must(fb.leftover === 0, `[T14] 复制后离屏 textarea 必须被移除（否则每次复制都往 DOM 里堆垃圾），残留 ${fb.leftover} 个`);

        // ── [T15] onclick 参数位注入（codex 审 245 rec-1）────────────────
        //   与 [T7] 不同面：那条测**文本位/title 属性位**，这条测 `onclick="...siCopyBatchCommits(this,<JS字符串>)"`
        //   的 **JS 字符串字面量位**——转义链是 siJsStringAttr = esc(JSON.stringify(x)) 两层。
        const EVIL_REF = `x");alert(1);//" onmouseover="alert(2)`;
        const iEvil = await mkIssue(`CC-onclick注入-${RUN_TAG}`, '待上线');
        const mEvil = await mkMember(iEvil, 13);
        await seedCommit(iEvil, mEvil, 13, 'frontend', EVIL_REF);
        await attach(iEvil, relPlan, '待上线');
        await batchRowOf(relPlan, iEvil);
        const evil = await page.evaluate(async (iid) => {
            const scope = document.querySelector('#siBatchBody') || document;
            const row = [...scope.querySelectorAll('.si-att-item')]
                .find(el => new RegExp('^#' + iid + '(?!\\d)').test((el.querySelector('.si-att-name') || el).textContent.trim()));
            const btn = row && row.querySelector('.si-batch-copy[data-side="前端"]');   // D3：按 side 精确定位
            if (!btn) return { err: 'no-button' };
            window.__evil = 0;
            btn.click();
            await new Promise(r => setTimeout(r, 350));
            return { fired: window.__evil, text: await navigator.clipboard.readText(), onmouseover: btn.getAttribute('onmouseover') };
        }, iEvil);
        must(!evil.err && evil.fired === 0, `[T15] ⭐ onclick 参数位注入未执行（alert 未触发、__evil 未被改写），实得 ${JSON.stringify(evil)}`);
        must(evil.onmouseover === null, '[T15] 注入串未撑破属性边界产生额外事件属性（onmouseover 应不存在）');
        must(evil.text === EVIL_REF,
            `[T15] 恶意串应**原样**进入剪贴板（转义只影响传输不篡改内容）。D3 后不再有「前端: 」前缀，实得 ${JSON.stringify(evil.text)}`);

        // ── [T16] latest-wins：连点不残留双态、旧定时器不抢还原（codex 审 245 LOW-1 的验证）──
        //   修了竞态却不测，等于没证明修好。连点三次后：① 成功/失败两个 class 不得并存
        //   ② 反馈仍应显示（旧定时器不得提前把它还原成 📋）③ 到期后正常还原。
        await batchRowOf(relPlan, iTwo);
        const race = await page.evaluate(async (iid) => {
            const scope = document.querySelector('#siBatchBody') || document;
            const row = [...scope.querySelectorAll('.si-att-item')]
                .find(el => new RegExp('^#' + iid + '(?!\\d)').test((el.querySelector('.si-att-name') || el).textContent.trim()));
            const btn = row && row.querySelector('.si-batch-copy[data-side="前端"]');   // D3：按 side 精确定位
            if (!btn) return { err: 'no-button' };
            btn.click(); btn.click(); btn.click();          // 连点三次
            await new Promise(r => setTimeout(r, 500));
            const during = {
                both: btn.classList.contains('si-batch-copied') && btn.classList.contains('si-batch-copyfail'),
                text: btn.textContent,
            };
            await new Promise(r => setTimeout(r, 1500));    // 越过 1.6s 还原窗口
            return { during, after: { text: btn.textContent, cls: btn.className } };
        }, iTwo);
        must(!race.err && race.during.both === false, `[T16] 连点后成功/失败两个 class 不得并存（原实现会并存且失败色按 CSS 顺序胜出），实得 ${JSON.stringify(race.during)}`);
        must(race.during.text === '✓ 已复制', `[T16] 连点期间反馈仍在（旧定时器不得提前抢还原），实得 "${race.during.text}"`);
        must(race.after.text === '📋' && !/si-batch-copied|si-batch-copyfail/.test(race.after.cls),
            `[T16] 到期后由最新一次的定时器正常还原标签与样式，实得 text="${race.after.text}" cls="${race.after.cls}"`);

        // ── [T21] ⭐ 四处优化 D4（E7）：上线单管理弹窗放大 + 1920/1440/1280 三档不溢出 ──────
        //   放在全部断言最后：本组要改视口，不能让它污染前面按 1920 采集的几何量（[T2]/[T12]/[T13] 归属）。
        //   判据不是"宽度等于某个数"，而是三档各自的**期望值 + 不溢出**——只断言"变宽了"太弱，
        //   一个写错的 clamp() 或被通用类覆盖都可能照样"比 720 宽"。
        //   ⚠️ **验收范围 = PC 桌面三档**（平台是内网 PC 端约 10 人使用）。窄于 1280 的视口不在本次承诺内，
        //   但 CSS 用 clamp 下限 720px 兜底，保证任何视口都不会比改造前更窄（codex 250 MED-1）。
        //   ⚠️ codex 250 MED-2：**显式打开弹窗**，不再依赖"前面的 batchRowOf 恰好还开着"这个隐式前置状态——
        //   否则本组失败时分不清是"尺寸规则坏了"还是"前面某个用例把弹窗关了"，属测试顺序耦合。
        await page.evaluate(() => document.getElementById('siBatchOverlay').classList.add('open'));
        await page.waitForTimeout(150);
        const sizeCases = [
            { w: 1920, h: 1080, expect: 1280, why: '78vw=1497 > 上限 ⇒ 取 1280px' },
            { w: 1440, h: 900, expect: Math.round(1440 * 0.78), why: '78vw=1123 未撞上限' },
            { w: 1280, h: 800, expect: Math.round(1280 * 0.78), why: '78vw=998 未撞上限' },
        ];
        for (const c of sizeCases) {
            await page.setViewportSize({ width: c.w, height: c.h });
            await page.waitForTimeout(200);
            const box = await page.evaluate(() => {
                const el = document.getElementById('siBatchBox');
                if (!el) return { err: 'no-box' };
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return {
                    open: document.getElementById('siBatchOverlay').classList.contains('open'),
                    w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right),
                    maxH: cs.maxHeight,
                    docScrollW: document.documentElement.scrollWidth,
                    docClientW: document.documentElement.clientWidth,
                    vh: window.innerHeight,
                };
            });
            must(!box.err && box.open === true, `[T21] ${c.w} 档：批次弹窗应处于打开态（本组已显式打开，不依赖前面用例的残留状态），实得 ${box.err || 'open=' + box.open}`);
            must(Math.abs(box.w - c.expect) <= 2,
                `[T21] ⭐ ${c.w} 档弹窗宽度应为 ${c.expect}px（${c.why}），实得 ${box.w}px —— 若等于 720 说明 #siBatchBox 规则没生效/被覆盖`);
            must(box.left >= 0 && box.right <= c.w,
                `[T21] ⭐ ${c.w} 档弹窗不得溢出视口，实得 left=${box.left} right=${box.right} (视口 ${c.w})`);
            must(box.docScrollW <= box.docClientW + 1,
                `[T21] ⭐ ${c.w} 档页面不得因弹窗变宽而横滚，实得 scrollWidth=${box.docScrollW} vs clientWidth=${box.docClientW}`);
            //   ⚠️ 高度这条要小心自欺：夹具内容量撑不满弹窗（实测约 560px），单纯断言"高度 ≤ 92vh"
            //   在当前数据下**恒真**——把 max-height 写成 50vh 也照样通过，等于没测 E7 的"高度同步放宽"。
            //   故改用 computed style 合同锁：直接验 max-height 解析值 == 92vh，与内容多少无关。
            must(Math.abs(parseFloat(box.maxH) - box.vh * 0.92) <= 1,
                `[T21] ⭐ ${c.w} 档 max-height 合同锁：computed 值应 = 92vh（${Math.round(box.vh * 0.92)}px），实得 ${box.maxH} —— 若为 90vh 说明 E7「高度同步放宽」没落地`);
            must(box.h <= Math.round(box.vh * 0.92) + 2,
                `[T21] ${c.w} 档实际高度不得超过该上限（当前夹具内容仅 ${box.h}px，未撑满，故本条是弱判据，真正的锁在上一行）`);
        }
        //   通用类不得被连带改宽：#siDutyRosterBox 同样是 .si-modal.wide，内容是窄表格，跟着变宽反而空旷
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.waitForTimeout(200);
        const wideWidth = await page.evaluate(() => {
            const probe = document.createElement('div');
            probe.className = 'si-modal wide';
            probe.style.position = 'absolute'; probe.style.visibility = 'hidden';
            document.body.appendChild(probe);
            const w = Math.round(probe.getBoundingClientRect().width);
            probe.remove();
            return w;
        });
        must(wideWidth === 720,
            `[T21] ⭐ 通用类 .si-modal.wide 必须仍是 720px（只提权 #siBatchBox 一个 id）——否则值班排班等同类弹窗会被连带改宽，实得 ${wideWidth}px`);

        // ══ 时间格式统一 S2「显示层统一到分」（锚点 D3/D6/D7/D9/D12/D13）════════════════
        // ── [T22] app.js 'minute' 分支：新增分支正确 + ⭐**既有四种 style 一个字节都不许变** ──
        //   为什么后半条比前半条重要：app.js 被四个页面共用（Model_Center 16 处 / My_Workspace 4 /
        //   admin.js 3 / Sys_Iteration 17），而 D11 拍板**本次只统一系统迭代页**。改坏 'full' 不会在
        //   本页露出任何症状（本页已经不用 'full' 了），却会让另外三页集体丢秒——典型的静默跨页回归。
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(400);
        const fmtProbe = await page.evaluate(() => {
            const f = window.formatDateTimeUnified;
            if (typeof f !== 'function') return { __missing: true };
            const IN = '2026-01-02 03:04:05';
            return {
                minute: f(IN, 'minute'),
                full: f(IN, 'full'),
                short: f(IN, 'short'),
                dateOnly: f(IN, 'dateOnly'),
                timeOnly: f(IN, 'timeOnly'),
                dflt: f(IN),
                empty: f(''),
                bad: f('不是时间', 'minute'),
            };
        });
        must(!fmtProbe.__missing, '[T22] 前置：formatDateTimeUnified 应挂在 window 上可供探测');
        must(fmtProbe.minute === '2026-01-02 03:04',
            `[T22] ⭐ 新增 'minute' 分支返回 YYYY-MM-DD HH:mm（无秒），实得 "${fmtProbe.minute}"`);
        must(fmtProbe.full === '2026-01-02 03:04:05' && fmtProbe.short === '2026-01-02 03:04:05' && fmtProbe.dflt === '2026-01-02 03:04:05',
            `[T22] ⭐ D9/D11：'full'/'short'/默认三条既有路径必须仍带秒（改坏了另三页集体丢秒且本页看不出来），`
            + `实得 full="${fmtProbe.full}" short="${fmtProbe.short}" 默认="${fmtProbe.dflt}"`);
        must(fmtProbe.dateOnly === '2026-01-02' && fmtProbe.timeOnly === '03:04:05',
            `[T22] D9：'dateOnly'/'timeOnly' 两条既有路径行为不变，实得 "${fmtProbe.dateOnly}" / "${fmtProbe.timeOnly}"`);
        must(fmtProbe.empty === '-' && fmtProbe.bad === '无效时间',
            `[T22] 空值与非法值的既有返回约定不变（'-' / '无效时间'，siFmtDT 依赖后者做原样回退），实得 "${fmtProbe.empty}" / "${fmtProbe.bad}"`);

        // ── [T23] 列表页时间列真的砍到分（走真实渲染，不是只测 helper）──────────────
        //   [T22] 只证明 helper 对，证明不了页面用上了它——siFmtDT 少改一处传参，列表照样显示到秒。
        //   created_at 库里是 datetime('now','localtime') 的**真实秒级**值，故"渲染出来无秒"是确凿判据。
        const NO_SEC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
        const colText = async (issueId, idx) => page.evaluate(({ id, i }) => {
            const tr = [...document.querySelectorAll('#siTbody tr')]
                .find(r => r.querySelector('td') && r.querySelector('td').textContent.trim() === '#' + id);
            if (!tr) return null;
            const tds = [...tr.querySelectorAll('td')];
            return tds[i] ? tds[i].textContent.trim() : null;
        }, { id: issueId, i: idx });
        const IDX_CREATED = 12;   // 0-based：…/前端号 10/后端号 11/**创建时间 12**/计划开工 13
        const IDX_DEADLINE = 9;
        //   取 iSameDayAM 而非更早的 iMod：reload 后列表按 ID 降序，iMod 之后还创建了 7 条夹具，
        //   拿它取行有被挤出首屏的风险（那会红成"砍秒没生效"，诊断指错方向）。iSameDayAM 同时也是
        //   [T24] 的对象，必然在首屏。
        const createdCell = await colText(iSameDayAM, IDX_CREATED);
        must(createdCell !== null && NO_SEC.test(createdCell),
            `[T23] ⭐ 「创建时间」列显示到分不带秒（库里是真实秒级值，故本条能确凿证明砍秒生效），实得 "${createdCell}"`);

        // ── [T24] ⭐ deadline 两形态并存（D6/D7）+ 反 UTC 午夜陷阱 ─────────────────────
        //   复用 [T17] 的两条 2099 夹具：iLegacyDay='2099-12-31'（存量纯日期）/ iSameDayAM='2099-12-31 07:00'。
        //   ⚠️ 本条守的是两件事：
        //     ① 纯日期**原样输出**——不补 '00:00'（补零＝赋予它本没有的精度，正是 v1.136.0 D2 dirty 判断防的伪造）
        //     ② 不过 `new Date()`——`new Date('2099-12-31')` 按 UTC 午夜解析，东八区会渲染成 '2099-12-31 08:00'，
        //        那既凭空造了时分、又把日期语义整体挪了 8 小时。若 siFmtDeadline 被"顺手简化"成直接调 siFmtDT，本条必红。
        const legacyCell = await colText(iLegacyDay, IDX_DEADLINE);
        const earlyCell = await colText(iSameDayAM, IDX_DEADLINE);
        must(legacyCell === '2099-12-31',
            `[T24] ⭐ 存量纯日期 deadline 原样显示，不补时分、不过 Date 解析。实得 "${legacyCell}"`
            + `（若为 "2099-12-31 08:00" ＝ 踩了 UTC 午夜陷阱；若为 "2099-12-31 00:00" ＝ 补了本不存在的精度）`);
        must(earlyCell === '2099-12-31 07:00',
            `[T24] 带时分的 deadline 显示到分，实得 "${earlyCell}"`);
        //   ⭐ codex 252 M-1 采纳：**S3 之后 deadline 会带 ':00' 秒**（写入层补秒），显示层必须仍到分。
        //     这是真实的覆盖缺口——现在库里还没有那种值，等 S3 落地才出现，届时若显示层漏改就是回归。
        //     一并锁 'T' 分隔与带时区后缀两种形态：deadline 是**业务本地时间字符串**，时区后缀不该被
        //     换算成另一个时刻（siFmtDeadline 全程走字符串归一、不进 Date，正是为此）。
        //   ⭐⭐ **跨层契约**（codex 253 LOW-2）：下面这组输入/期望与后端 `deadlineToMinuteText` 是**同一组向量**
        //     （见 `scripts/verify-sys-time-precision.js` 的 `CONTRACT` 表）。deadline 的文本规则前后端各有一份
        //     实现，天然会漂移 ⇒ 同一组向量钉在两侧，改任一侧的规则必须两边一起改，否则一侧红。
        //     ⚠️ 唯一允许的差异：空值——前端返 '—'（直接进 DOM 的占位符），后端返 null（供拼接判断）。
        const dlProbe = await page.evaluate(() => {
            const f = window.siFmtDeadline;
            if (typeof f !== 'function') return { __missing: true };
            return {
                minuteForm: f('2026-08-10 14:30'),
                s3Form: f('2026-08-10 14:30:00'),
                tSep: f('2026-08-10T14:30:00'),
                tz: f('2026-08-10T14:30:00+08:00'),
                pureDate: f('2026-08-10'),
                empty: f(''),
                junk: f('不是时间'),
                tailJunk: f('2026-08-10 14:30garbage'),   // 部分匹配：不锚定结尾就会被截成合法值
                zulu: f('2026-08-10T14:30:00Z'),
                //   形态合法 / 语义非法：本函数**刻意不做**语义校验（codex 252-B M-1 讨论后的定论），
                //   写死成断言让它成为"已知有意行为"，而不是藏在代码里的矛盾。
                semanticBad: f('2026-99-99 99:99:99'),
                //   单位数时区偏移：上游 normalizeDeadlineDT 强制 'YYYY-MM-DD HH:MM'、根本不产时区后缀，
                //   时区分支本身已是纯防御 ⇒ 不再为"非标准人写格式"扩宽（codex 252-B L-1 不采纳，记理由）。
                oddTz: f('2026-08-10T14:30:00+8:00'),
            };
        });
        must(!dlProbe.__missing, '[T24] 前置：siFmtDeadline 应挂在 window 上可供探测');
        must(dlProbe.minuteForm === '2026-08-10 14:30',
            `[T24] 跨层契约：分钟级原样，实得 "${dlProbe.minuteForm}"`);
        must(dlProbe.s3Form === '2026-08-10 14:30',
            `[T24] ⭐ S3 形态 '2026-08-10 14:30:00'（写入层补秒后）显示仍到分，实得 "${dlProbe.s3Form}"`);
        must(dlProbe.tSep === '2026-08-10 14:30' && dlProbe.tz === '2026-08-10 14:30',
            `[T24] 'T' 分隔与带时区后缀都归一到同一本地字面量，不做时区换算，实得 "${dlProbe.tSep}" / "${dlProbe.tz}"`);
        must(dlProbe.pureDate === '2026-08-10' && dlProbe.empty === '—' && dlProbe.junk === '不是时间',
            `[T24] 纯日期原样 / 空值 '—' / 认不出的形态原样露出（不化妆成 '—'），实得 "${dlProbe.pureDate}" / "${dlProbe.empty}" / "${dlProbe.junk}"`);
        must(dlProbe.tailJunk === '2026-08-10 14:30garbage',
            `[T24] ⭐ 带尾部垃圾的脏值必须**原样露出**、不得被截成合法值——正则少个结尾锚点就会把它化妆成`
            + ` '2026-08-10 14:30'，掩盖真问题且与"原样露出"的声称自相矛盾。实得 "${dlProbe.tailJunk}"`);
        must(dlProbe.zulu === '2026-08-10 14:30',
            `[T24] 'Z' 后缀（UTC 标记）同样只取本地字面量、不做换算——deadline 是业务本地时间字符串，实得 "${dlProbe.zulu}"`);
        must(dlProbe.semanticBad === '2026-99-99 99:99',
            `[T24] 职责边界：siFmtDeadline 只做**形态**归一、不做**语义**校验（语义校验在写入端 normalizeDeadlineDT，`
            + `显示层重复一遍只会制造两处规则漂移）。本条把这个已知行为锁死，免得被当成 bug 顺手"修"掉。实得 "${dlProbe.semanticBad}"`);
        must(dlProbe.oddTz === '2026-08-10T14:30:00+8:00',
            `[T24] 单位数时区偏移 '+8:00' 不在支持形态内、原样露出——上游根本不产时区后缀，时区分支已是纯防御，`
            + `不为不存在的输入继续扩宽（codex 252-B L-1 不采纳记理由）。实得 "${dlProbe.oddTz}"`);

        // ── [T25] D13 审计三处：正文到分 + title 保完整到秒 ────────────────────────────
        //   时间轴走真实渲染（开抽屉即可到达）；删除留痕与通知已读要 admin 面板/通知数据才到得了，
        //   用源码合同锁覆盖——如实标注这是弱一档的证据，不假装三处都跑了真实渲染。
        const WITH_SEC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
        await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), iMod);
        await page.waitForTimeout(800);
        const tlTime = await page.evaluate(() => {
            const el = document.querySelector('.si-tl-time');
            return el ? { text: el.textContent.trim(), title: el.getAttribute('title') || '' } : null;
        });
        must(tlTime !== null, '[T25] 前置：详情抽屉时间轴应至少有一条记录（建单事件），否则本组无对象可验');
        must(tlTime && NO_SEC.test(tlTime.text),
            `[T25] ⭐ 时间轴正文显示到分，实得 "${tlTime && tlTime.text}"`);
        must(tlTime && WITH_SEC.test(tlTime.title),
            `[T25] ⭐ D13：时间轴 title 保留完整到秒（审计取证能力不因砍秒而丢失），实得 title="${tlTime && tlTime.title}"`);
        //   ⚠️ 正则**只锁语义**（`title=` + `siFmtDTSec` + 该处的字段名），不锁整段模板文本
        //     （codex 252-B L-2 采纳）：绑死模板会让无行为变化的重排、换行、抽 helper 都误报，
        //     而这三条锁真正要守的只有一件事——"这个字段的 title 走的是保秒的那个 helper"。
        const srcT25 = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
        const titleLock = (field) => new RegExp(`title="[^"]*siFmtDTSec\\(\\s*[A-Za-z_$][\\w$]*\\.${field}\\s*\\)`).test(srcT25);
        must(titleLock('deleted_at'),
            '[T25] D13：删除留痕的 title 走 siFmtDTSec(*.deleted_at) 保到秒（源码合同锁·弱一档证据）');
        must((srcT25.match(/title="[^"]*siFmtDTSec\(\s*[A-Za-z_$][\w$]*\.deleted_at\s*\)/g) || []).length === 2,
            '[T25] D13：删除留痕**两处**（列表行 + 详情 kv）都挂了 title——只锁存在性会漏掉"删其中一处"');
        must(/siNotifyStatusText[\s\S]{0,600}?title="\$\{tipOf\(/.test(srcT25)
            && /tipOf\s*=\s*\([\s\S]{0,80}?siFmtDTSec/.test(srcT25),
            '[T25] D13：通知已读状态串的 title 经 tipOf 走 siFmtDTSec 保到秒（源码合同锁·弱一档证据）');

        // ── [T26] D12 缓存串 + 配套守卫 ───────────────────────────────────────────────
        //   改共享静态资源必 bump 缓存串；但 bump 只解决"下次加载"，挡不住浏览器此刻仍持有旧 app.js——
        //   旧版没有 'minute' 分支会 fallthrough 回带秒的默认分支，**页面看着正常、秒悄悄回来了**。
        //   守卫把这种静默失败变成 console.error。本条锁"守卫存在且探测串与实现一致"。
        const bumpedPages = await page.evaluate(() => document.querySelector('script[src*="assets/js/app.js"]').getAttribute('src'));
        must(/app\.js\?v=v1\.137\.0_timefmt$/.test(bumpedPages),
            `[T26] ⭐ D12：app.js 缓存串必须已 bump（本次动了共享静态资源），实得 "${bumpedPages}"`);
        must(/formatDateTimeUnified\('2026-01-02 03:04:05', 'minute'\)/.test(srcT25)
            && /probe !== '2026-01-02 03:04'/.test(srcT25),
            '[T26] ⭐ 陈旧缓存守卫存在，且其探测输入/期望输出与 [T22] 用的是同一组值（守卫自身写错就成了永不触发的摆设）');

        // ── [T5] 无 console error ────────────────────────────────────────
        //   ⚠️ 本条同时是 [T26] 守卫的"反向验证"：测试环境加载的是新 app.js，守卫**不该**触发；
        //     若守卫的探测逻辑写反了，这里会因多出一条 console.error 而红。
        must(page._consoleErrors.length === 0, `[T5] 全程无 console error，实得：${JSON.stringify(page._consoleErrors.slice(0, 3))}`);

    } catch (e) {
        failed++;
        console.error('\n[异常]', e && e.message);
    } finally {
        if (browser) await browser.close();
        // 清理夹具（含子表）
        for (const id of createdIssueIds) {
            await run('DELETE FROM sys_issue_dev_commits WHERE issue_id = ?', [id]).catch(() => {});
            await run('DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?', [id]).catch(() => {});
            await run('DELETE FROM sys_issue_timeline WHERE issue_id = ?', [id]).catch(() => {});
            await run('DELETE FROM sys_issues WHERE id = ?', [id]).catch(() => {});
        }
        for (const rid of createdReleaseIds) {
            await run('DELETE FROM sys_issue_release_commit_snapshots WHERE release_id = ?', [rid]).catch(() => {});
            await run('DELETE FROM sys_releases WHERE id = ?', [rid]).catch(() => {});
        }
        const left = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE title LIKE ?`, [`CC-%-${RUN_TAG}`]);
        const leftRel = await get(`SELECT COUNT(*) AS c FROM sys_releases WHERE release_no LIKE ?`, [`RCC-${RUN_TAG}-%`]);
        console.log(`\n  🧹 夹具已清理（残留 issue ${left ? left.c : '?'} 条 / release ${leftRel ? leftRel.c : '?'} 条，均应为 0）`);
        db.close();
        console.log(`\n  合计 ${passed} PASS / ${failed} FAIL`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
