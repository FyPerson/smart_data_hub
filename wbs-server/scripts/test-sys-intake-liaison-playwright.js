/**
 * 建单优化批 C1/C2 前端 Playwright 冒烟——对接人下拉 + title 派生 + intake 通知按钮三态
 * （方案 v1.2 §3.6/§4.8/§6b.1，对齐 test-sys-release-c7-playwright.js 套件范式）
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-intake-liaison-playwright.js
 *
 * 覆盖：
 *   T1 建单弹窗结构+校验：#f_title 存在且为**选填**（label 无必填星号）/ 描述必填拦截（留空点确定→toast
 *       「描述必填」+弹窗不关）/ 对接人下拉默认选中「示例对接人」（本地唯一 active 受理人=13）
 *       ⭐ #69（2026-09-11）：原为「无 #f_title 输入框」，随建单弹窗放出选填标题框**整条翻转**——
 *         推翻建单优化批 C2「撤标题输入框」决策，详见 docs/local/系统迭代/系统迭代_建单优化批_方案_20260801_v1.3.md §6b 顶部标注。
 *   T2 **不填 title** 建单成功：description 首行经 esc/trim 后 = 落库 title（列表 + 详情 + DB 三处核对，非猜测）
 *       ——#69 后该用例语义由"后端无条件派生"变为"标题留空时的派生兜底路径"，覆盖面不变且仍是主路径。
 *   T3 详情页「对接人」行显示"示例对接人"
 *   T4 通知按钮三态（**安全改写，见下方说明**）
 *   T5 全程 0 console error
 *
 * ⚠️⚠️ 钉钉安全边界（本脚本执行前实测发现，与任务书原文假设不同，务必先读）：
 *   任务书原文假设"本地无钉钉配置发送会 failed"，让本脚本真点「发送通知」按钮验证。
 *   **实测核验：本地 task_pool.db 的 system_configs 表 dingtalk_app_key/app_secret/robot_code 三项均已
 *   SET（非空）**——sendIssueDingtalkRaw() 不会走 no_config 快速失败分支，而是会真实发起
 *   dingtalkNotify.getAccessToken() 外呼。这与本仓库其余 Playwright 脚本已反复实测确认的结论完全一致：
 *     - test-periodic-fetch-playwright.js:14 "本地 db 副本含生产系统真实凭证，避免任何真实外部副作用"
 *     - test-sys-release-c7-playwright.js:15-20 明确列出"走 sendIssueDingtalkRaw 直连会真实外呼"的按钮
 *       一律不点击
 *   [LOW-4 同步修正·2026-08-07] test-sys-release-panel-c2b2-playwright.js 已整体重写（C6 收口），其
 *   notify-executor 相关用例改走 `system_configs.sys_notify_dry_run='on'` 开关闸下的**真实点击**（该开关
 *   会让 CAS+留痕正常走、唯独跳过真实外呼，见该文件头部"钉钉安全边界"段），不再是"点击即真实外呼故只
 *   断言可见性不点击"的旧策略——不再适合作本条"真实外呼风险"的同类精确引用，故移除该条引用，仅保留
 *   仍然成立的另外两条。
 *   notify-intake 端点同样直连 sendIssueDingtalkRaw（S1 后端实现，见 index.js notify-intake 路由），与
 *   上述被规避的通道属同一风险类别。**本脚本据此不点击真实「发送通知」/「重发」按钮**，改用「直接 SQL
 *   模拟通知态」手法验证三态渲染逻辑（not_sent 初始态用真实建单产出的自然状态；failed 态用 SQL UPDATE
 *   模拟，不经真实外呼）——这是本仓库对"零真实外呼"纪律的既定、可验证解法之一（另一种解法见上条 c2b2
 *   现行的 dry-run 开关闸+真实点击，两种手法效果等价，本脚本未跟随改造，独立成立不依赖 c2b2 具体实现），
 *   非本脚本新发明，也不是回避测试深度（UI 渲染逻辑与真实点击后的渲染逻辑完全一致，siRenderIntakeNotifyRow
 *   只读 iss.intake_notify_status 三态字段，不关心状态如何产生）。
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// [S12b hotfix批1 收口·2026-08-06] 补 TEST_BASE_URL 覆盖（对齐 probe-s1-paste-thumb.js / test-corr-
//   upload-preview-playwright.js 等既有兄弟套件同款约定）——本次改造涉及后端 intake_accept 逻辑
//   （routes/sys-iteration/index.js/transitions.js），需要一个已加载最新后端代码的 server 实例；
//   用户正在观察的 3000 端口 server 全程不可重启/杀，故验证时改指向临时 3100 副本实例，默认值仍是
//   3000（不影响其余不传该环境变量的调用方）。
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET;   // [#82 2026-09-16] 原硬编码回退值已删（字面量不复述）；本脚本已加载 .env，该回退值本就是死代码
// codex 220 L-4：原硬编码指向某次会话的临时目录，会话结束即失效——失败截图会静默写失败（目录不存在）
// 且无从查阅。改用系统临时目录下固定子目录，每次运行前 mkdirSync recursive 确保存在。
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-playwright-shots');

const ADMIN_ID = 1;
const LIAISON_ID = 13;   // 示例对接人（v1.141 C10 起下拉候选=全 eligible 角色成员，她是其中之一；
                         //   SYS_INTAKE_LIAISON_IDS=[13] 现只管 release/roster 级窄集合授权，不再决定候选池）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}

let pass = 0, fail = 0;
// ⭐ 夹具清理未收口清单（codex 568-#69 三轮 M-3·**采纳其反对意见**）：
//   我原先的取舍是"清理问题只高亮打印、不改变套件成败"，理由是别让'功能红'与'夹具没清干净'混在同一个
//   PASS/FAIL 语义里。codex 反对得有道理——只读退出码的调用方（CI / 批量回归脚本）看不见日志颜色，
//   夹具残留的运行会被当成完全成功。其建议同时满足了我原来的顾虑：**用可区分的非零退出码**，
//   功能失败仍是 1，清理未收口单独用 2，两者不互相覆盖（见文件末尾退出逻辑）。
//   故本清单提到模块级作用域，供 finally 之后的退出判定读取。
const cleanupFailures = [];
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `intake-fail-${name}.png`);
        try {
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });   // codex 220 L-4：目录可能不存在，截图前确保存在
            await page.screenshot({ path: p });
            console.log(`     📸 失败截图: ${p}`);
        } catch (_) { /* 截图本身失败不影响主流程 */ }
    }
}
async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}

async function main() {
    // 前置：确认示例对接人(id=13)在本地是 active（T2/T3/T6 都以她为选中对象；C10 后候选池是全 eligible
    //   成员，「唯一受理人」前提已不存在，此处只需她本人在池即可）。
    const activeLiaisons = await dbAll(`SELECT id, display_name, status FROM users WHERE id=? AND status='active'`, [LIAISON_ID]);
    if (activeLiaisons.length !== 1) throw new Error(`前置条件不满足：预期 id=${LIAISON_ID} 受理人为 active，实得 ${JSON.stringify(activeLiaisons)}`);
    console.log(`  前置确认：受理人 ${activeLiaisons[0].display_name}(${LIAISON_ID}) active`);

    const adminTok = await signAs(ADMIN_ID);
    console.log('\n══════ 建单优化批 C1/C2 前端 Playwright 冒烟 ══════');

    const RUN_TAG = Date.now();
    const descFirstLine = `Playwright冒烟首行标题-${RUN_TAG}`;
    const descFull = `${descFirstLine}\n第二行不应影响标题（仅首行截取）`;
    let createdIssueId = null;
    let oaExemptIssueId = null;   // T1.5（建单优化批 C3b）独立夹具，finally 里与 createdIssueId 一并清理
    // T2b/T2c（#69 标题放出为选填）独立夹具。
    // ⭐ 除 id 外**另存一份描述唯一标记**（codex 568-#69 审 M-1）：id 只有在"提交后固定等待 → dbGet 查到行"
    //   这条路走通时才会被赋值，若落库慢于固定等待、或查询本身异常，id 仍为 null 而单据**可能已经建出来**，
    //   finally 就漏清。存下标记后 finally 可按标记补查兜底，把"清理依赖查询成功"这个隐含前提去掉。
    //   （注：shotOnFail 内部调 must() 不抛错，故"断言失败"本身不会跳过清理——已由 T2b 变异实跑验证；
    //     本兜底针对的是上述"id 压根没被赋值"的窗口，两者是不同的失效路径。）
    //   ⭐ 三轮 M-1 补：另记「是否已尝试提交」。只有"提交动作确实发起过、却没拿到 id、补查也零行"这种
    //     组合才是**清理状态未知**（可能服务端已落库而我们不知道）；用例在填表阶段就失败、根本没点提交时，
    //     补查零行是正常的，不能报未知（否则误报会淹没真信号）。marker 不足以区分这两种情形——它在提交
    //     之前就被赋值了。
    let explicitTitleIssueId = null, explicitTitleDescMarker = null, explicitTitleSubmitAttempted = false;
    let blankTitleIssueId = null, blankTitleDescMarker = null, blankTitleSubmitAttempted = false;
    let t6FeatureId = null, t6BugId = null, t6ImprovementId = null;   // T6（工期对接测试与风险等级拆分 v1.1 §3.4/§7/§6b·C5，⭐ 用户拍板批1改造B新增 improvement 分支）独立夹具
    let t7DisplayId = null;   // T7（D22 批2 状态显示改名·2026-08-06）独立夹具

    const browser = await chromium.launch();
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1：建单弹窗结构 + 校验（无标题输入框 / 描述必填拦截 / 对接人默认选中）
        //   + T2：无 title 建单成功（description 首行 = 落库 title）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T1：建单弹窗结构 + 描述必填拦截 + 对接人默认选中 ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('button:has-text("新建迭代单")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            // ⭐ #69（2026-09-11 用户拍板）：建单弹窗**放出选填标题输入框**——本处断言由原「建单弹窗无
            //   #f_title 输入框（标题输入框已撤）」**整条翻转**。原断言是建单优化批 C2「撤标题输入框」
            //   的守卫，#69 推翻该决策后它会真判红，属必须改而非可留可不留。
            const titleField = page.locator('#f_title');
            await shotOnFail(page, (await titleField.count()) === 1, 't1-title-field-exists', '建单弹窗存在 #f_title 标题输入框（#69 放出为选填）');
            // ⚠️ 同时钉住「选填」这一半：只断言"存在"挡不住有人把它误设成必填——那会退回建单优化批 C2
            //   之前"标题必填"的老问题，也与后端 `rawTitle || deriveSysTitleFromDescription(...)` 的兜底
            //   语义矛盾（后端允许不传，前端却拦着不让提交）。label 不含 * 即选填。
            const titleLabel = await page.locator('label:has-text("标题")').first().textContent();
            await shotOnFail(page, !titleLabel.includes('*'), 't1-title-optional-no-star', `标题字段 label 不含必填星号（#69 口径=选填，实得："${titleLabel.trim()}"）`);
            const descField = page.locator('#f_description');
            await shotOnFail(page, (await descField.count()) === 1, 't1-description-field-exists', '建单弹窗存在 #f_description 描述 textarea');
            const descLabel = await page.locator('label:has-text("描述")').first().textContent();
            // 描述**仍必填**（#69 只放开标题，没动描述的主字段地位）——这条断言是防"放开标题时顺手把描述
            //   也改成选填"，那样两个内容字段可以同时为空，后端 DESCRIPTION_REQUIRED 会拒，成为死表单。
            await shotOnFail(page, descLabel.includes('*'), 't1-description-required-star', `描述字段 label 含必填星号（实得："${descLabel.trim()}"）`);
            const descPlaceholder = await descField.getAttribute('placeholder');
            // #69 同步：placeholder 文案由「标题将自动取首行」改为「标题留空则自动取首个非空行」——放出
            //   输入框后派生成了"留空时"的兜底而非无条件行为；且「首个非空行」才与派生实现一致
            //   （codex L-3：描述以空行开头时"首行"是空的，取的实为第一个非空行）。断言跟着改。
            await shotOnFail(page, descPlaceholder && descPlaceholder.includes('标题留空则自动取首个非空行'), 't1-description-placeholder', `描述 placeholder 提示标题留空时自动取首个非空行（实得："${descPlaceholder}"）`);
            // ⭐ D4（用户拍板「第一项就是选填项」）位置断言（codex L-2）：只断言控件存在挡不住它被挪走，
            //   而位置是用户显式拍的口径。取弹窗内第一个 .u-form-group，要求它就是标题字段。
            const firstGroupHasTitle = await page.locator('#siMBody .u-form-group').first().locator('#f_title').count();
            await shotOnFail(page, firstGroupHasTitle === 1, 't1-title-is-first-field', `标题是建单弹窗第一个表单字段（D4 用户拍板口径，实得首字段含 #f_title = ${firstGroupHasTitle}）`);

            const liaisonSel = page.locator('#f_intake_liaison_id');
            await shotOnFail(page, (await liaisonSel.count()) === 1, 't1-liaison-field-exists', '建单弹窗存在 #f_intake_liaison_id 对接人下拉');

            // ⭐ [C10 契约对齐·2026-08-28] v1.141 C10 起候选池=全 eligible 角色 active 成员（后端
            //   resolveActiveSysIntakeLiaisons 角色判据），不再是「唯一受理人」——原三断言（恰 1 候选/
            //   默认选中 13/option 数=候选数）自 C10 起对现行契约失效（本套件写于建单优化批·C10 之前，
            //   之后未再跑过，2026-08-28 OA 恒勾选批顺带发现修正）。现行契约（siIntakeLiaisonFieldHtml）：
            //   候选 ≥1 且含示例对接人(id=13)；多候选时下拉带「（请选择）」空白占位（option 数=候选数+1）且
            //   默认未选中；唯一候选时不加占位、默认选中——两态用同一组断言按候选数分派。
            const liaisonResp = await fetch(`${BASE_URL}/api/sys-issues/intake-liaisons`, { headers: { Authorization: `Bearer ${adminTok}` } });
            const liaisonRespData = await liaisonResp.json().catch(() => null);
            const liaisonCandidates = (liaisonResp.ok && liaisonRespData && Array.isArray(liaisonRespData.items)) ? liaisonRespData.items : null;
            await shotOnFail(page, Array.isArray(liaisonCandidates) && liaisonCandidates.length >= 1 && liaisonCandidates.some(c => c.id === LIAISON_ID), 't1-liaison-candidates-contains-13', `GET intake-liaisons 候选 ≥1 且含示例对接人 id=${LIAISON_ID}（C10 后候选=全 eligible 成员，实得：${JSON.stringify(liaisonCandidates)}）`);
            const liaisonOptionCount = await liaisonSel.locator('option').count();
            const liaisonExpectedOpts = Array.isArray(liaisonCandidates) ? liaisonCandidates.length + (liaisonCandidates.length > 1 ? 1 : 0) : -1;
            await shotOnFail(page, liaisonOptionCount === liaisonExpectedOpts, 't1-liaison-option-count-matches', `对接人下拉 option 数量（${liaisonOptionCount}）= 候选数${Array.isArray(liaisonCandidates) && liaisonCandidates.length > 1 ? '+1 空白占位' : ''}（期望 ${liaisonExpectedOpts}·唯一候选不加占位，见 siIntakeLiaisonFieldHtml）`);
            const liaisonVal = await liaisonSel.inputValue();
            const liaisonExpectedDefault = Array.isArray(liaisonCandidates) && liaisonCandidates.length === 1 ? String(liaisonCandidates[0].id) : '';
            await shotOnFail(page, liaisonVal === liaisonExpectedDefault, 't1-liaison-default-value', `对接人下拉默认值="${liaisonExpectedDefault}"（唯一候选默认选中/多候选默认未选，实得 value="${liaisonVal}"）`);
            // 〔codex 486 MED-2〕候选集合一致性：仅「数量相同 + 含 13」抓不住漏项/错项/错标签的渲染——
            //   从接口 items 派生期望（id 集合 + id→姓名映射）与 DOM 非空 option 双向比对。
            const liaisonDomOpts = await liaisonSel.locator('option').evaluateAll(os => os.filter(o => o.value !== '').map(o => ({ value: o.value, label: (o.textContent || '').trim() })));
            const liaisonApiIds = new Set((liaisonCandidates || []).map(c => String(c.id)));
            const liaisonDomIds = new Set(liaisonDomOpts.map(o => o.value));
            const liaisonSetsEqual = liaisonApiIds.size === liaisonDomIds.size && [...liaisonApiIds].every(v => liaisonDomIds.has(v));
            await shotOnFail(page, liaisonSetsEqual, 't1-liaison-option-set-equals-api', `下拉非空 option value 集合 = 接口候选 id 集合（双向相等，API={${[...liaisonApiIds].join(',')}} DOM={${[...liaisonDomIds].join(',')}}）`);
            const liaisonLabelsMatch = (liaisonCandidates || []).every(c => { const o = liaisonDomOpts.find(x => x.value === String(c.id)); return o && o.label.includes(c.name); });
            await shotOnFail(page, liaisonLabelsMatch, 't1-liaison-option-labels-match', `每个候选 option 文本含接口返回姓名（按 id 对应，实得=${JSON.stringify(liaisonDomOpts)}）`);

            // 描述必填拦截：留空点确定 → toast「描述必填」+ 弹窗不关闭（siModal onConfirm 返回 false）。
            await page.click('#siMConfirm');
            await page.waitForTimeout(300);
            const toastText1 = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, toastText1.includes('描述必填'), 't1-description-required-toast', `留空描述点确定 → toast 含「描述必填」（实得："${toastText1}"）`);
            const modalStillOpen = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalStillOpen === 1, 't1-modal-stays-open', '描述必填拦截后弹窗仍处于打开态（未静默关闭/未误提交）');

            console.log('\n── T2：无 title 建单成功，description 首行 = 落库 title ──');
            await descField.fill(descFull);
            // [C10 契约对齐] 多候选时对接人默认未选中——显式选中示例对接人(id=13)再提交（原「已默认选中直接
            //   提交」是唯一候选时代的假设）；所属系统仍有 META 默认值无需操作。
            await page.selectOption('#f_intake_liaison_id', String(LIAISON_ID));
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);

            const modalClosedAfterSubmit = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, modalClosedAfterSubmit === 0, 't2-modal-closed-after-success', '合法提交后弹窗已关闭（建单成功）');

            const row = await dbGet(`SELECT id, title, description, intake_liaison_id, status FROM sys_issues WHERE description LIKE ?`, [`${descFirstLine}%`]);
            await shotOnFail(page, !!row, 't2-db-row-created', `DB 中已建出对应单据（按描述首行匹配），实得：${JSON.stringify(row)}`);
            if (row) {
                createdIssueId = row.id;
                await shotOnFail(page, row.title === descFirstLine, 't2-db-title-derived', `落库 title = 描述首行（未截断，未超40字符），预期="${descFirstLine}"，实得="${row.title}"`);
                await shotOnFail(page, row.intake_liaison_id === LIAISON_ID, 't2-db-intake-liaison-id', `落库 intake_liaison_id=${LIAISON_ID}（实得=${row.intake_liaison_id}）`);
                await shotOnFail(page, row.status === '待受理', 't2-db-status', `落库 status=待受理（实得=${row.status}）`);
            }

            // 详情页（siOpenDrawer 建单成功后自动打开）header 标题核对。
            const drawerTitle = await page.locator('#siDTitle').textContent().catch(() => '');
            await shotOnFail(page, createdIssueId && drawerTitle.includes(`#${createdIssueId}`) && drawerTitle.includes(descFirstLine), 't2-detail-title', `详情页 header 显示 "#${createdIssueId} ${descFirstLine}"（实得："${drawerTitle}"）`);

            // 列表视图标题核对：关闭详情抽屉回到列表，搜索/滚动定位到该行。
            const listRowText = await page.locator(`tr:has-text("${descFirstLine}")`).count();
            await shotOnFail(page, listRowText > 0, 't2-list-title', `列表视图存在含派生标题的行（"${descFirstLine}"）`);

            console.log('\n── T3：详情页「对接人」行显示"示例对接人" ──');
            const intakeKvText = await page.locator('.u-kv-item:has-text("对接人")').first().textContent();
            await shotOnFail(page, intakeKvText.includes('示例对接人'), 't3-intake-liaison-name', `详情页「对接人」行显示"示例对接人"（实得："${intakeKvText.trim()}"）`);

            await shotOnFail(page, page._consoleErrors.length === 0, 't1t2t3-console-clean', `T1-T3 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // ⭐ T2b（#69·2026-09-11 新增）：**填了标题 → 沿用传入 title，不被描述首行派生覆盖**
        //   为什么必须单独补：T2 覆盖的是"标题留空 → 派生兜底"，而 #69 真正放出的新能力是"填了就用"
        //   这一条路径。它在后端是既有分支（`rawTitle || deriveSysTitleFromDescription(...)`，
        //   routes/sys-iteration/index.js :7258，本次**零改动**），但此前**从无任何自动化用例覆盖**
        //   ——建单弹窗当时根本没有标题输入框，该分支只有 API 直调才走得到。
        //   不补这条，"后端零改动即支持"就只是读代码得到的推断，没有行为层证据；而前端「把 title 装进
        //   body」是本次**全新代码**，更需要真实链路证明。
        //   ⭐ 判别力设计：断言 title === 填入值 **且 ≠ 描述首行**——两种失效都会落到"title = 描述首行"
        //     而判红：① 前端漏传/传错键（body 里没有 title）② 后端改动导致派生值覆盖传入值。
        //   独立夹具、独立 page（不复用 T1-T4 的 createdIssueId，避免与既有断言的流程状态耦合）。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T2b（#69）：填写标题 → 落库 title = 填入值（不走描述首行派生）──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('button:has-text("新建迭代单")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            // 标题与描述首行**刻意不同**，且各自唯一——若两者相同，本用例对"派生覆盖传入值"就失去判别力。
            // ⭐⭐ 请求体捕获（本批变异自证倒逼补的判别层，详见下方 t2b-request-title-trimmed 注释）：
            //   落库值看不出前端有没有 trim（后端 :7265 也 trim，两层冗余），要测前端实现必须看它**发出去
            //   的请求体**。这是本用例真正对前端代码有判别力的那一条。
            //   ⚠️ 用 URL.pathname 精确比较，不用裸 URL 结尾正则（codex 568-#69 二轮 L-3）：
            //     原 `/\/api\/sys-issues$/` 会因**查询串**漏捕，而查询串并非本用例想排除的东西——
            //     真正要排除的是 `/attachments` 等子路径，按 pathname 全等即可精确表达。
            //     ⚠️ 如实声明（三轮 L-1 更正）：pathname 全等**同样不接受尾斜杠**（'/api/sys-issues/' ≠
            //       '/api/sys-issues'），本次并未"修复尾斜杠漏捕"。这里是**刻意只支持无尾斜杠**——
            //       前端 siApi 固定以 '/sys-issues' 拼接、不带尾斜杠，是唯一真实调用形态；若哪天契约放开
            //       尾斜杠，这里和下面的 waitForResponse 判据要同时改。
            //   ⚠️ 覆盖边界：本监听记录**最后一次**匹配的建单请求。本块是独立 page、仅提交一次，故不存在
            //     覆盖问题；若将来在同一 page 内多次建单，需改用 waitForRequest 做一次性精确关联。
            let t2bPostBody = null;
            page.on('request', req => {
                if (req.method() !== 'POST') return;
                let p;
                try { p = new URL(req.url()).pathname; } catch (_) { return; }
                if (p !== '/api/sys-issues') return;   // 全等：排除 /api/sys-issues/:id/attachments 等子路径
                try { t2bPostBody = JSON.parse(req.postData() || 'null'); } catch (_) { /* 非 JSON 忽略 */ }
            });

            // 唯一标记 = 时间戳 + 随机串（codex 568-#69 二轮 L-2）：单用 Date.now() 在同毫秒并发跑两份
            //   套件时可能撞号，导致描述标记不唯一、清理时选错夹具。加随机段成本一行。
            const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const explicitTitle = `T2b自填标题-${stamp}`;
            // ⭐ 输入值**刻意带首尾空白**（codex 568-#69 审 L-2）：用无空白字符串测不出 trim 在不在。
            //   ⚠️ 但要注意它能测出**什么层**（本批变异实测修正过一次错误预期，如实记下）：
            //     删掉前端 trim 后，**落库值不会变**——后端 :7265 也 trim，会把空白抹平。变的是**请求体**。
            //     所以带空白的输入只有配合下方 t2b-request-title-trimmed（断言请求体）才有判别力；
            //     落库层断言在任何单层 trim 失效下都仍绿。
            const explicitTitleTyped = `   ${explicitTitle}   `;
            const t2bDescFirstLine = `T2b描述首行-与标题不同-${stamp}`;
            const t2bDescFull = `${t2bDescFirstLine}\n第二行同样不参与标题`;
            explicitTitleDescMarker = t2bDescFirstLine;   // M-1 兜底：先于提交存标记，供 finally 补查

            await page.fill('#f_title', explicitTitleTyped);
            await page.fill('#f_description', t2bDescFull);
            await page.selectOption('#f_intake_liaison_id', String(LIAISON_ID));

            // ⭐ 等建单响应而不是等固定时长（codex 568-#69 二轮 M-1 收口）：原 `waitForTimeout(800)` 下，
            //   落库慢于 800ms 时 dbGet 查不到 → id 不登记 → finally 漏清。改为有界等待真实响应，并**直接
            //   从响应体取 id 立即登记**，清理不再依赖"查询是否恰好赶上"。
            //   ⚠️ 残余窗口如实列举（三轮 M-1 更正二轮"残窗仅为 id 字段异常"的说法，那句不成立）：
            //     ① 15s 超时 → createResp 为 null；② click 抛错使 Promise.all 提前退出；③ 响应体无 id。
            //     三者都会落到 finally 的标记补查；补查仍零行时**报「清理状态未知」并计入未收口清单**，
            //     不再按"无夹具"静默结束（见 cleanupByIdOrMarker 的 submitAttempted 分支）。
            explicitTitleSubmitAttempted = true;   // 置于 click 之前：点击本身抛错也算"提交可能已发出"
            const [createResp] = await Promise.all([
                page.waitForResponse(r => {
                    try { return new URL(r.url()).pathname === '/api/sys-issues' && r.request().method() === 'POST'; }
                    catch (_) { return false; }
                }, { timeout: 15000 }).catch(() => null),
                page.click('#siMConfirm'),
            ]);
            if (createResp) {
                const respBody = await createResp.json().catch(() => null);
                if (respBody && respBody.id) explicitTitleIssueId = respBody.id;   // 先登记，后断言
            }
            await page.waitForTimeout(400);   // 留给前端收尾（关弹窗 / 刷列表 / 开详情抽屉）

            const t2bModalClosed = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, t2bModalClosed === 0, 't2b-modal-closed', '填标题后合法提交，弹窗已关闭（建单成功）');

            // ⭐ 回读优先按**响应登记的 id**（codex 568-#69 三轮 M-2）：原先无条件用描述前缀查再把结果
            //   赋回 explicitTitleIssueId，会**覆盖**响应拿到的权威 id；描述前缀一旦命中多行，dbGet 任取
            //   一行就可能登记成别人的单，随后 finally 按 id 直删，**绕过**刚加的"命中多行不自动删"保护。
            //   改为：有响应 id 就按 id 精确回读（并保留描述核对），只有没有 id 时才退回描述查询。
            const t2bRow = explicitTitleIssueId
                ? await dbGet(`SELECT id, title, description FROM sys_issues WHERE id = ?`, [explicitTitleIssueId])
                : await dbGet(`SELECT id, title, description FROM sys_issues WHERE description LIKE ?`, [`${t2bDescFirstLine}%`]);
            await shotOnFail(page, !!t2bRow, 't2b-db-row-created', `DB 中已建出对应单据，实得：${JSON.stringify(t2bRow)}`);
            if (t2bRow) {
                // ⛔ 这里**刻意不再把回读结果的 id 赋给 explicitTitleIssueId**（codex 568-#69 四轮 M-2 收口）。
                //   原写法在"无响应 id"分支下会把描述前缀查询任取的一行登记为清理目标，finally 见到 id 就
                //   直删，**绕过** dbAll 的多行保护；且赋值发生在归属核对**之前**，而 shotOnFail 内部不抛错，
                //   核对失败也拦不住那次删除——等于用一条只会累计失败的断言当删除门禁，这是不成立的。
                //   现在：清理变量**只保存响应体返回的权威 id**；没有响应 id 时，一律交给 finally 的
                //   dbAll 补查 + 唯一性保护决定删不删。本回读只服务于断言，不再影响清理。
                // 归属核对：确认断言比较的确实是本用例建的单（防前缀碰撞选错行后，标题断言在别人的单上
                //   比较而给出误导性结论）。它是**断言正确性**的守卫，不兼任清理门禁。
                await shotOnFail(page, String(t2bRow.description || '').startsWith(t2bDescFirstLine), 't2b-row-ownership',
                    `回读到的单据描述以本轮唯一标记开头（归属核对），标记="${t2bDescFirstLine}"，实得描述首段="${String(t2bRow.description || '').slice(0, 60)}"`);
                // [端到端断言] 证明的是"用户填的标题最终成为落库 title"这一结果，**不能定位 trim 发生在哪一层**
                //   （codex 568-#69 二轮 L-4 修正原文案"证明前端做了 trim"的错误因果）。它真正的判别力在于
                //   title 有没有被派生值覆盖——这一点任何单层实现都无法代偿，故仍是本用例的核心断言。
                await shotOnFail(page, t2bRow.title === explicitTitle, 't2b-title-used-as-typed-e2e',
                    `[端到端契约] 落库 title = 用户填入标题去首尾空白后的值（证明标题被采用、未被派生覆盖；trim 由前后端哪一层完成本条不区分），输入="${explicitTitleTyped}"，预期="${explicitTitle}"，实得="${t2bRow.title}"`);
                // ⚠️⚠️ 判别力交底（**本条断言对前端实现没有判别力，刻意保留并如实标注**）：
                //   落库 title 无首尾空白这件事，由**前端 trim 与后端 trim 两层**冗余保证（前端
                //   `v.title.trim()`，后端 index.js:7265 `b.title.trim()`）。本批变异实测：单独删掉前端
                //   trim → 本条仍绿（后端兜住）；单独删掉后端 trim → 本条也仍绿（前端兜住）。**只有两层
                //   同时坏才会红。** 故它锁的是「端到端契约」而非任何一层的实现，不要误当作前端 trim 的守卫。
                //   真正守前端 trim 的是下面那条 t2b-request-title-trimmed（断言对象=请求体，见其注释）。
                await shotOnFail(page, t2bRow.title === t2bRow.title.trim(), 't2b-title-trimmed-e2e',
                    `[端到端契约·非单层守卫] 落库 title 无首尾空白（前后端两层 trim 任一生效即满足），实得=${JSON.stringify(t2bRow.title)}`);
                // 负向那一半：显式钉死"没有退化成派生值"。前一条断言相等时本条必然成立，写出来是为了让
                //   失败信息直接指认"退化成了描述首行"这一具体病因，而不是只报"两个字符串不相等"。
                await shotOnFail(page, t2bRow.title !== t2bDescFirstLine, 't2b-title-not-derived',
                    `落库 title 未退化为描述首行（若相等说明 title 没传出去或被派生覆盖），描述首行="${t2bDescFirstLine}"，实得 title="${t2bRow.title}"`);
            }

            // ⭐⭐ 对前端实现真正有判别力的一条（断言对象=**请求体**，不是落库值）：
            //   前端 `if (v.title && v.title.trim()) body.title = v.title.trim();` 是否真的做了 trim，
            //   只在它发出的 JSON 里可见——落库值被后端 trim 抹平了差异（见上一条交底）。
            //   本批变异实测：把该行改成 `if (v.title) body.title = v.title;` → **本条判红**（请求体里
            //   title 带首尾空白），而所有落库层断言仍绿。这就是补这一层的理由。
            await shotOnFail(page, !!t2bPostBody, 't2b-request-captured',
                `已捕获建单请求体（后续断言的前提，未捕获说明 URL 匹配或时机有误），实得=${JSON.stringify(t2bPostBody)}`);
            if (t2bPostBody) {
                await shotOnFail(page, t2bPostBody.title === explicitTitle, 't2b-request-title-trimmed',
                    `[前端守卫] 请求体 title = 去首尾空白后的值（证明前端确实 trim，输入带空白="${explicitTitleTyped}"），预期="${explicitTitle}"，实得=${JSON.stringify(t2bPostBody.title)}`);
            }

            // 渲染层核对：详情页 header 显示的是自填标题（建单成功后 siOpenDrawer 自动打开）。
            const t2bDrawerTitle = await page.locator('#siDTitle').textContent().catch(() => '');
            // 前置条件改用 t2bRow（四轮 M-2 连带）：explicitTitleIssueId 现在只在"拿到响应 id"时有值，
            //   继续拿它当前置会让"响示例开发N时但单据已建出"的场景误判成断言失败，掩盖真实结论。
            await shotOnFail(page, !!t2bRow && t2bDrawerTitle.includes(explicitTitle), 't2b-detail-title',
                `详情页 header 显示自填标题（实得："${t2bDrawerTitle}"）`);

            await shotOnFail(page, page._consoleErrors.length === 0, 't2b-console-clean',
                `T2b 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // ⭐ T2c（#69·codex 568-#69 审 L-2 补）：**纯空白标题 → 仍走派生兜底**
        //   这是前端提交条件 `if (v.title && v.title.trim()) body.title = v.title.trim();` 的真实边界：
        //   用户在标题框里敲了几个空格再提交。T2（完全不填）与 T2b（填了实内容）都覆盖不到它。
        //   期望行为：空白被 trim 判假 → 不传 title → 后端派生 → 落库 title = 描述首个非空行。
        //   ⚠️ 判别层交底（codex 568-#69 二轮 L-4 修正原注释的错误因果）：若条件误写成 `if (v.title)`
        //     （非空字符串即真），空格串会被装进请求体——但**落库 title 不会变成空格**，因为后端 :7265
        //     先 trim 再 `rawTitle || derive(...)`，空白仍会走派生。即该误写的后果**只在请求体层可见**，
        //     由下方 t2c-request-omits-blank-title 钉住；落库层两条是端到端契约，单层误写不会让它们红。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T2c（#69）：纯空白标题 → 仍走描述派生兜底 ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('button:has-text("新建迭代单")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            // 同 T2b：真正能判前端条件写法的是请求体（纯空白时**不应出现 title 键**）。
            let t2cPostBody = null;
            page.on('request', req => {
                if (req.method() !== 'POST') return;
                let p;
                try { p = new URL(req.url()).pathname; } catch (_) { return; }
                if (p !== '/api/sys-issues') return;   // 同 T2b：pathname 全等，排除子路径
                try { t2cPostBody = JSON.parse(req.postData() || 'null'); } catch (_) { /* 非 JSON 忽略 */ }
            });

            const stampC = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;   // 同 T2b：时间戳+随机段
            const t2cDescFirstLine = `T2c描述首个非空行-${stampC}`;
            blankTitleDescMarker = t2cDescFirstLine;   // M-1 兜底：先于提交存标记
            await page.fill('#f_title', '    ');   // 纯空白
            await page.fill('#f_description', `${t2cDescFirstLine}\n第二行不参与标题`);
            await page.selectOption('#f_intake_liaison_id', String(LIAISON_ID));

            // 同 T2b：等真实响应并直接登记 id（M-1 收口），不用固定时长赌落库时机。
            blankTitleSubmitAttempted = true;   // 同 T2b：置于 click 之前
            const [createRespC] = await Promise.all([
                page.waitForResponse(r => {
                    try { return new URL(r.url()).pathname === '/api/sys-issues' && r.request().method() === 'POST'; }
                    catch (_) { return false; }
                }, { timeout: 15000 }).catch(() => null),
                page.click('#siMConfirm'),
            ]);
            if (createRespC) {
                const respBodyC = await createRespC.json().catch(() => null);
                if (respBodyC && respBodyC.id) blankTitleIssueId = respBodyC.id;
            }
            await page.waitForTimeout(400);

            await shotOnFail(page, (await page.locator('#siModalOverlay.open').count()) === 0, 't2c-modal-closed',
                '纯空白标题不影响提交（描述已填，弹窗关闭=建单成功）');

            // 同 T2b（M-2）：优先按响应登记的 id 精确回读，不让描述前缀查询覆盖权威 id。
            const t2cRow = blankTitleIssueId
                ? await dbGet(`SELECT id, title, description FROM sys_issues WHERE id = ?`, [blankTitleIssueId])
                : await dbGet(`SELECT id, title, description FROM sys_issues WHERE description LIKE ?`, [`${t2cDescFirstLine}%`]);
            await shotOnFail(page, !!t2cRow, 't2c-db-row-created', `DB 中已建出对应单据，实得：${JSON.stringify(t2cRow)}`);
            if (t2cRow) {
                // ⛔ 同 T2b（四轮 M-2）：**不把回读 id 赋给清理变量**，清理只认响应体返回的权威 id。
                // 归属核对（T2c 此前缺这条，四轮 M-2 指出后补齐，与 T2b 对称）。
                await shotOnFail(page, String(t2cRow.description || '').startsWith(t2cDescFirstLine), 't2c-row-ownership',
                    `回读到的单据描述以本轮唯一标记开头（归属核对），标记="${t2cDescFirstLine}"，实得描述首段="${String(t2cRow.description || '').slice(0, 60)}"`);
                // ⚠️ 判别力交底（同 t2b-title-trimmed-e2e）：落库层这两条是**端到端契约**，由前端条件与
                //   后端 `rawTitle || derive(...)` 两层冗余保证，单层变异不会红（本批已实测）。
                await shotOnFail(page, t2cRow.title === t2cDescFirstLine, 't2c-title-derived-not-blank-e2e',
                    `[端到端契约] 纯空白标题 → 落库 title = 描述首个非空行（而非一串空格），预期="${t2cDescFirstLine}"，实得=${JSON.stringify(t2cRow.title)}`);
                await shotOnFail(page, !!(t2cRow.title && t2cRow.title.trim()), 't2c-title-not-whitespace-e2e',
                    `[端到端契约] 落库 title 非空白串，实得=${JSON.stringify(t2cRow.title)}`);
            }
            // ⭐ 对前端条件写法真正有判别力的一条：纯空白时请求体里**不应有 title 键**。
            //   若条件被误写成 `if (v.title)`（非空字符串即真），空格串会被装进 body → 本条判红，
            //   而上面两条落库断言仍绿（后端 trim 后走派生，结果看不出差别）。
            await shotOnFail(page, !!t2cPostBody, 't2c-request-captured',
                `已捕获建单请求体，实得=${JSON.stringify(t2cPostBody)}`);
            if (t2cPostBody) {
                await shotOnFail(page, !('title' in t2cPostBody), 't2c-request-omits-blank-title',
                    `[前端守卫] 纯空白标题时请求体不含 title 键（防误写成 if (v.title) 把空格串传出去），实得 title=${JSON.stringify(t2cPostBody.title)}`);
            }

            await shotOnFail(page, page._consoleErrors.length === 0, 't2c-console-clean',
                `T2c 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T1.5：「本单无需 OA 号」勾选框存在 + 默认恒勾选（2026-08-28 用户拍板·原 C3b「需求方留空↔勾选」
        //   联动与 improvement 覆盖联动均已拆除）+ 手动改后提交落库核对。独立开一个页面/夹具，不复用
        //   T1-T3 的 createdIssueId（避免与既有 35 断言的流程状态耦合，改动面收窄到新增内容本身）。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T1.5：oa_exempt 勾选框存在 + 默认恒勾选（联动已拆）+ 手动改后提交落库核对 ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            await page.click('button:has-text("新建迭代单")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);

            const oaChk = page.locator('#f_oa_exempt');
            await shotOnFail(page, (await oaChk.count()) === 1, 't1.5-checkbox-exists', '建单弹窗存在 #f_oa_exempt 勾选框（本单无需 OA 号）');
            await shotOnFail(page, await oaChk.isChecked(), 't1.5-default-checked', '弹窗打开时勾选框默认勾选（恒勾默认）');

            // 恒勾①：填需求方姓名 + 选需求方部门 → 勾选保持不动（2026-08-28 拍板拆除「任一非空→取消勾」
            //   旧联动——选部门取消勾正是触发本次拍板的用户报障场景）
            //   〔codex 486 MED-1〕部门选择不允许静默跳过：非空候选存在 + 实际选中值非空均为显式前置断言，
            //   部门清单加载失败（下拉 disabled 只剩占位项）时此处必须红，不得退化为「没测部门路径也绿」。
            await page.fill('#f_requester_name', '业务方老王');
            const oaDeptRealOpts = await page.locator('#f_requester_dept option:not([value=""])').count();
            await shotOnFail(page, oaDeptRealOpts >= 1, 't1.5-dept-options-exist', `需求方部门下拉存在非空候选（实得=${oaDeptRealOpts}）`);
            await page.selectOption('#f_requester_dept', { index: 1 });
            const oaDeptVal = await page.locator('#f_requester_dept').inputValue();
            await shotOnFail(page, oaDeptVal.trim() !== '', 't1.5-dept-selected-nonempty', `需求方部门已实际选中非空值（实得="${oaDeptVal}"）`);
            await page.waitForTimeout(150);
            await shotOnFail(page, await oaChk.isChecked(), 't1.5-stays-checked-on-requester-filled', '填入需求方姓名+选部门后，勾选框保持勾选（恒勾·旧联动此处会自动取消）');

            // 恒勾②：清空需求方姓名/部门 → 依旧勾选（勾选框不再被任何字段变化改写，两个方向都不）
            await page.fill('#f_requester_name', '');
            await page.selectOption('#f_requester_dept', '');
            await page.waitForTimeout(150);
            await shotOnFail(page, await oaChk.isChecked(), 't1.5-stays-checked-on-cleared', '清空需求方字段后依旧勾选（无任何字段联动改写勾选框）');

            // 手动改：用户显式取消勾选 → 手动态即最终态，后续字段变化不得写回。
            //   〔codex 486 L-1 措辞校准〕本段锁的是现契约「手动态不被字段事件覆盖」——对旧实现同样绿
            //   （touched 停锁），判别证据在上方恒勾①②（未触碰态旧联动必取消勾）。
            await oaChk.uncheck();
            await page.waitForTimeout(100);
            await shotOnFail(page, !(await oaChk.isChecked()), 't1.5-manual-uncheck', '用户手动取消勾选后，勾选框呈未勾选态');
            await page.fill('#f_requester_name', '业务方老王');   // 再动需求方字段（锁手动态不被字段事件覆盖）
            await page.fill('#f_requester_name', '');
            await page.waitForTimeout(150);
            await shotOnFail(page, !(await oaChk.isChecked()), 't1.5-manual-state-final', '手动取消后需求方字段任意变化不得把勾选写回（手动态即最终态）');

            // 手动改后提交：勾选框保持手动设的"未勾选"，提交后核对落库 oa_exempt=0（与前端手动态一致，
            //   非被联动悄悄改回的 1）。
            const oaExemptTag = `Playwright-oa豁免冒烟-${RUN_TAG}`;
            await page.fill('#f_description', oaExemptTag);
            // [C10 契约对齐] 多候选时对接人默认未选中——显式选中再提交，否则被「对接人必填」拦截
            await page.selectOption('#f_intake_liaison_id', String(LIAISON_ID));
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);
            const oaRow = await dbGet(`SELECT id, oa_exempt, requester_name FROM sys_issues WHERE description LIKE ?`, [`${oaExemptTag}%`]);
            await shotOnFail(page, !!oaRow, 't1.5-db-row-created', `DB 中已建出勾选框测试单据，实得：${JSON.stringify(oaRow)}`);
            if (oaRow) {
                oaExemptIssueId = oaRow.id;
                await shotOnFail(page, oaRow.oa_exempt === 0, 't1.5-db-oa-exempt-matches-manual', `落库 oa_exempt=0（手动取消勾选后提交，与前端手动态一致，非被联动覆盖回 1，实得=${oaRow.oa_exempt}）`);
            }

            await shotOnFail(page, page._consoleErrors.length === 0, 't1.5-console-clean', `T1.5 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T4：通知按钮三态（安全改写：not_sent 用真实建单产出的自然态；failed 态用 SQL 模拟，
        //   不点击真实「发送通知」按钮——见文件头部安全边界说明）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T4：intake 通知按钮三态（not_sent 真实态 → SQL 模拟 failed 态，不点真实发送） ──');
            if (!createdIssueId) throw new Error('T4 前置失败：createdIssueId 未取得（T2 建单断言已失败，跳过 T4 会产生误导性绿灯）');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${createdIssueId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            // not_sent 初始态：按钮文案「发送通知」，状态文字「未发送钉钉通知」。
            const notifyRowInit = page.locator('.u-notify-row:has-text("对接人受理")');
            await shotOnFail(page, (await notifyRowInit.count()) > 0, 't4-row-visible-pending', '「待受理」态下对接人受理通知行可见');
            const initBtnText = await notifyRowInit.locator('button').first().textContent().catch(() => '');
            await shotOnFail(page, initBtnText.includes('发送通知'), 't4-init-btn-label', `初始态按钮文案「发送通知」（实得："${initBtnText}"）`);
            const initStatusText = await notifyRowInit.textContent();
            await shotOnFail(page, initStatusText.includes('未发送'), 't4-init-status-text', `初始态状态文字含「未发送」（实得摘要："${initStatusText.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);

            // 安全改写：SQL 直接模拟 failed 态（不经真实 sendIssueDingtalkRaw 外呼，见文件头说明）。
            await dbRun(`UPDATE sys_issues SET intake_notify_status='failed', intake_notify_error='no_config' WHERE id=?`, [createdIssueId]);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${createdIssueId}`);   // 重新整页加载，读全新 DB 状态
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            const notifyRowFailed = page.locator('.u-notify-row:has-text("对接人受理")');
            const failedStatusText = await notifyRowFailed.textContent();
            await shotOnFail(page, failedStatusText.includes('失败'), 't4-failed-status-text', `SQL 模拟 failed 后状态文字含「失败」（实得摘要："${failedStatusText.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);
            const retryBtnText = await notifyRowFailed.locator('button').first().textContent().catch(() => '');
            // [v1.143 通知统一对齐·2026-08-28] failed 态按钮文案「重发」→「重试」（〔S10〕统一批改词，
            //   见 Sys_Iteration.html intake btnLabel `intakeStatus === 'failed' ? '重试' : '发送通知'`）；
            //   本套件写于统一前，原断言自 v1.143 起对现行文案失效（OA 恒勾选批顺带发现修正）。
            await shotOnFail(page, retryBtnText.includes('重试'), 't4-retry-btn-label', `failed 态按钮文案「重试」（v1.143 统一后文案，实得："${retryBtnText}"）`);
            const retryBtnEnabled = await notifyRowFailed.locator('button').first().isEnabled().catch(() => false);
            await shotOnFail(page, retryBtnEnabled, 't4-retry-btn-enabled', '「重试」按钮可点（非 disabled，验证"重试可点"，但本脚本不实际点击——点击会真实外呼钉钉）');

            // codex 217 HIGH 收口：sent 态零断言补齐——本 commit 最关键语义（sent 是本轮终态，不可重发；
            //   仅回受理门归零才恢复可发）此前完全没有回归锁。SQL 直接模拟 sent（不经真实外呼，同上方 failed
            //   态手法）：status='sent' + message_key 非空 + read_at NULL（未读态）。
            await dbRun(`UPDATE sys_issues SET intake_notify_status='sent', intake_notify_message_key='intake-c2-test-mk', intake_notify_error=NULL, intake_read_at=NULL WHERE id=?`, [createdIssueId]);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${createdIssueId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            const notifyRowSentUnread = page.locator('.u-notify-row:has-text("对接人受理")');
            const sentUnreadBtnCount = await notifyRowSentUnread.locator('button').count();
            await shotOnFail(page, sentUnreadBtnCount === 1, 't4-sent-unread-btn-count', `sent+未读态通知行仅 1 个按钮——无「发送通知/重发」（sent 即本轮终态，不可重发，实得按钮数=${sentUnreadBtnCount}）`);
            const sentUnreadBtnText = await notifyRowSentUnread.locator('button').first().textContent().catch(() => '');
            await shotOnFail(page, sentUnreadBtnText.includes('查询已读'), 't4-sent-unread-btn-is-queryread', `sent+未读态唯一按钮为「查询已读」（实得："${sentUnreadBtnText}"）`);
            const sentUnreadStatusText = await notifyRowSentUnread.textContent();
            await shotOnFail(page, sentUnreadStatusText.includes('已通知'), 't4-sent-unread-status-text', `sent+未读态状态文字含「已通知」（实得摘要："${sentUnreadStatusText.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);

            // codex 复审(20260801_111901) L1：上方「按钮总数=1 且唯一按钮为查询已读」是对"无发送/重发"的间接证明——
            //   未来该行若新增其他按钮或 DOM 顺序调整，失败信息不够直接。此处显式锁死：行数=1 前置 + 两类操作按钮各自计数=0。
            const sentUnreadRowCount = await notifyRowSentUnread.count();
            await shotOnFail(page, sentUnreadRowCount === 1, 't4-sent-unread-row-count-one', `sent+未读态「对接人受理」通知行恰 1 行（按钮计数断言的前提显式化，实得=${sentUnreadRowCount}）`);
            const sentUnreadSendCount = await notifyRowSentUnread.locator('button:has-text("发送通知")').count();
            await shotOnFail(page, sentUnreadSendCount === 0, 't4-sent-unread-no-send-btn', `sent+未读态显式无「发送通知」按钮（实得=${sentUnreadSendCount}）`);
            const sentUnreadRetryCount = await notifyRowSentUnread.locator('button:has-text("重试")').count();
            await shotOnFail(page, sentUnreadRetryCount === 0, 't4-sent-unread-no-retry-btn', `sent+未读态显式无「重试」按钮（v1.143 统一后文案·查旧词「重发」会恒真失去检出力，实得=${sentUnreadRetryCount}）`);

            // 再置 read_at 非空 → 已读态。⚠️ 实现语义核实（写断言前先读 Sys_Iteration.html 源码确认，非按 codex
            //   修法原文直接照抄）：siRenderIntakeNotifyRow 的「查询已读」按钮条件含 `!iss.intake_read_at`——
            //   已读后按钮不渲染（非仅置灰/disabled）；同时 siNotifyStatusText 的 sent+readAt 分支切换文案为
            //   「📖 已读 · 于 <时刻>」（intake 通道不传 notifiedAt，故不含"通知于"前半段）。即：已读态 = 按钮从
            //   有(查询已读)变为无 + 状态文字从「已通知」变为「已读」，两者同时发生，断言两头都锁。
            await dbRun(`UPDATE sys_issues SET intake_read_at=datetime('now','localtime') WHERE id=?`, [createdIssueId]);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${createdIssueId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            const notifyRowSentRead = page.locator('.u-notify-row:has-text("对接人受理")');
            const sentReadBtnCount = await notifyRowSentRead.locator('button').count();
            await shotOnFail(page, sentReadBtnCount === 0, 't4-sent-read-btn-count-zero', `sent+已读态通知行无任何按钮（发送/重发/查询已读全隐藏，实得按钮数=${sentReadBtnCount}）`);
            const sentReadStatusText = await notifyRowSentRead.textContent();
            await shotOnFail(page, sentReadStatusText.includes('已读'), 't4-sent-read-status-text', `sent+已读态状态文字含「已读」（实得摘要："${sentReadStatusText.replace(/\s+/g, ' ').trim().slice(0, 60)}"）`);

            await shotOnFail(page, page._consoleErrors.length === 0, 't4-console-clean', `T4 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T6（工期对接测试与风险等级拆分 方案 v1.1 §3.4/§7/§6b·C5·长任务 S10=C5）：
        //   受理弹窗风险等级必选控件 + 详情页「风险等级」kv 展示（未受理「未定级」/受理后具体值）+ D15
        //   intake 通知行常驻化（单已过受理段后行仍渲染，发送按钮消失/查询已读仍可用）。
        //   ⭐ 用户拍板批1改造A+B（2026-08-06）：① 值域「高/中/低」全仓改名「一级/二级/三级」；
        //   ② 风险等级控件覆盖面从"仅 feature"扩到"feature+improvement"（原「feature 有/bug 无」两分
        //   已反转为「feature/improvement 有·默认选中三级/bug 无」三分——本组新增独立 improvement 分支，
        //   下方 bug 分支相应改为"唯一无控件类型"的收窄表述）。
        //   独立夹具（不复用 T1-T4 的 createdIssueId，避免状态耦合），走 API 直接建单（本组焦点是受理
        //   弹窗与详情展示，非建单表单本身，建单表单已由 T1/T2 覆盖）。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T6：受理弹窗风险等级必选控件（feature/improvement 有默认三级·bug 无）+ 详情页展示 + D15 intake 行常驻化 ──');
            const featRes = await fetch(`${BASE_URL}/api/sys-issues`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
                body: JSON.stringify({ intake_contract_version: 2, type: 'feature', title: 't6', system_name: 'BMS', source: '内部', description: `T6-feature-${RUN_TAG}`, intake_liaison_id: LIAISON_ID })
            });
            const featBody = await featRes.json();
            if (featRes.status !== 201) throw new Error(`T6 前置失败：feature 建单未 201，实得 ${featRes.status} ${JSON.stringify(featBody)}`);
            t6FeatureId = featBody.id;

            const bugRes = await fetch(`${BASE_URL}/api/sys-issues`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
                body: JSON.stringify({ intake_contract_version: 2, type: 'bug', title: 't6-bug', system_name: 'BMS', source: '内部', description: `T6-bug-${RUN_TAG}`, intake_liaison_id: LIAISON_ID })
            });
            const bugBody = await bugRes.json();
            if (bugRes.status !== 201) throw new Error(`T6 前置失败：bug 建单未 201，实得 ${bugRes.status} ${JSON.stringify(bugBody)}`);
            t6BugId = bugBody.id;

            // ⭐【反转】改造B新增：improvement 独立夹具——用于下方新增的 improvement 分支（原口径下
            //   improvement 与 bug 同属"无风险等级控件"，本轮起 improvement 转投 feature 一侧）。
            const impRes = await fetch(`${BASE_URL}/api/sys-issues`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
                body: JSON.stringify({ intake_contract_version: 2, type: 'improvement', title: 't6-improvement', system_name: 'BMS', source: '内部', description: `T6-improvement-${RUN_TAG}`, intake_liaison_id: LIAISON_ID })
            });
            const impBody = await impRes.json();
            if (impRes.status !== 201) throw new Error(`T6 前置失败：improvement 建单未 201，实得 ${impRes.status} ${JSON.stringify(impBody)}`);
            t6ImprovementId = impBody.id;

            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${t6FeatureId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            // 未受理前：详情页「风险等级」kv 显示「未定级」
            const riskKvBefore = await page.locator('.u-kv-item:has-text("风险等级")').first().textContent().catch(() => '');
            await shotOnFail(page, riskKvBefore.includes('未定级'), 't6-risk-kv-undefined-before-accept', `未受理前详情页「风险等级」显示「未定级」（实得："${riskKvBefore.trim()}"）`);

            // 受理弹窗：feature 单必选风险等级控件（改造A：值域一级/二级/三级；用户拍板默认选中"三级"）
            await page.click('#siDActions button:has-text("受理通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            const riskSel = page.locator('#f_risk_level');
            await shotOnFail(page, (await riskSel.count()) === 1, 't6-risk-select-exists', 'feature 受理弹窗存在 #f_risk_level 风险等级下拉');
            const riskOptions = await riskSel.locator('option').allTextContents();
            await shotOnFail(page, JSON.stringify(riskOptions) === JSON.stringify(['请选择', '一级', '二级', '三级']), 't6-risk-select-options', `风险等级下拉选项恰为 请选择/一级/二级/三级（实得：${JSON.stringify(riskOptions)}）`);
            const riskDefault = await riskSel.inputValue();
            await shotOnFail(page, riskDefault === '三级', 't6-risk-select-default-value', `风险等级下拉默认选中"三级"（用户拍板默认体验，服务端必填闸不变），实得="${riskDefault}"`);

            // 手动清空选择（模拟用户改回"请选择"）→ 点确定 → 前端仍拦截（必选闸门未因默认值放松）
            await riskSel.selectOption('');
            await page.click('#siMConfirm');
            await page.waitForTimeout(400);
            const riskEmptyToast = await page.locator('#toast-container').textContent().catch(() => '');
            await shotOnFail(page, riskEmptyToast.includes('请选择风险等级'), 't6-risk-empty-toast', `清空风险等级点确定 → toast「请选择风险等级」（实得："${riskEmptyToast}"）`);
            const riskModalStillOpen = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, riskModalStillOpen === 1, 't6-risk-modal-stays-open', '清空风险等级点确定后弹窗仍打开（前端必选拦截，默认值不代替真实选择）');

            // 选「一级」提交 → 成功（选非默认值，验证真选择被采纳，非靠默认值蒙混过关）
            await riskSel.selectOption('一级');
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);
            const riskModalClosed = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, riskModalClosed === 0, 't6-risk-submit-success', '选定风险等级后点确定 → 受理成功，弹窗关闭');
            const riskRow = await dbGet('SELECT status, risk_level FROM sys_issues WHERE id=?', [t6FeatureId]);
            await shotOnFail(page, !!riskRow && riskRow.status === '待指派', 't6-risk-db-status', `受理后落库 status=待指派，实得=${riskRow && riskRow.status}`);
            await shotOnFail(page, !!riskRow && riskRow.risk_level === '一级', 't6-risk-db-value', `受理后落库 risk_level=一级，实得=${riskRow && riskRow.risk_level}`);

            // 受理后：详情页「风险等级」kv 显示具体值
            await page.waitForTimeout(300);
            const riskKvAfter = await page.locator('.u-kv-item:has-text("风险等级")').first().textContent().catch(() => '');
            await shotOnFail(page, riskKvAfter.includes('一级') && !riskKvAfter.includes('未定级'), 't6-risk-kv-value-after-accept', `受理后详情页「风险等级」显示"一级"（实得："${riskKvAfter.trim()}"）`);

            // D15：单已过受理段（status=待指派）——intake 通知行仍可见（常驻化），但发送按钮不再出现
            const intakeRowAfter = page.locator('.u-notify-row:has-text("对接人受理")');
            await shotOnFail(page, (await intakeRowAfter.count()) > 0, 't6-d15-row-still-visible', 'D15：单已过受理段后，对接人受理通知行仍渲染（常驻化，非 ghost 行消失）');
            const intakeRowAfterSendCount = await intakeRowAfter.locator('button:has-text("发送通知")').count();
            await shotOnFail(page, intakeRowAfterSendCount === 0, 't6-d15-no-send-btn-after-accept', 'D15：已过受理段后「发送通知」按钮不再出现（发送仍仅受理段可点，机制未动）');

            // [284 号 A3] 非 admin 角色视角：intake 通知行"可见"（展示面）与"可操作"（授权面）是两套独立判据——
            //   canSeeNotify（是否渲染整个"钉钉通知"区块）在"admin∨受理人∨(feature/improvement 在册开发)"
            //   三选一命中即真；canOperateIntake/canQueryReadIntake（发送/重发/查已读按钮）固定只认
            //   isAdminUser（siRenderNotify 调用点显式传 isAdminUser 而非 canOperate，见 :2614 附近注释
            //   "权限=仅 admin……受理人是通知对象本人，不给自己发"）。两套判据独立生效，故要证真的分离，
            //   须构造"能看见但不能操作"的组合：把示例开发A(id8，本地真实 active user 角色账号)加为
            //   t6FeatureId 的在册开发（命中 canSeeNotify 的 isRosterMember 分支），同时把 intake 通知
            //   模拟成 sent 态（SQL 直接模拟，不经真实外呼，同 T4/T6 既有手法）——sent 态下 admin 本该
            //   看到「查询已读」按钮，若非 admin 也看到，说明 admin 门失守。
            await dbRun(`UPDATE sys_issues SET intake_notify_status='sent', intake_notify_message_key='t6-a3-mk', intake_read_at=NULL WHERE id=?`, [t6FeatureId]);
            const oaA3 = await fetch(`${BASE_URL}/api/sys-issues/${t6FeatureId}/set-oa-number`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
                body: JSON.stringify({ oa_number: '2026080077' })
            });
            if (oaA3.status !== 200) throw new Error(`T6/A3 前置失败：补 OA 号未 200，实得 ${oaA3.status} ${await oaA3.text().catch(() => '')}`);
            const assignA3 = await fetch(`${BASE_URL}/api/sys-issues/${t6FeatureId}/assign`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
                body: JSON.stringify({ assigned_to: 8 })
            });
            if (assignA3.status !== 200) throw new Error(`T6/A3 前置失败：assign(示例开发A id8) 未 200，实得 ${assignA3.status} ${await assignA3.text().catch(() => '')}`);

            const dev8Tok = await signAs(8);
            const pageDev8 = await loginPage(browser, dev8Tok);
            await pageDev8.goto(`${BASE_URL}/Sys_Iteration.html?issue=${t6FeatureId}`);
            await pageDev8.waitForLoadState('networkidle');
            await pageDev8.waitForTimeout(600);
            const dev8IntakeRow = pageDev8.locator('.u-notify-row:has-text("对接人受理")');
            await shotOnFail(pageDev8, (await dev8IntakeRow.count()) > 0, 't6-a3-nonadmin-row-visible', '[284 A3] 非 admin 在册开发视角：intake 通知行可见（展示面——canSeeNotify 命中 isRosterMember 分支，detail DTO 字段面对在册开发未收窄）');
            const dev8SendCount = await dev8IntakeRow.locator('button:has-text("发送通知"), button:has-text("重试")').count();
            await shotOnFail(pageDev8, dev8SendCount === 0, 't6-a3-nonadmin-no-send-btn', '[284 A3] 非 admin：无发送/重试按钮（v1.143 统一后文案·授权面——canOperateIntake 固定只认 isAdminUser，在册身份不豁免）');
            const dev8QueryReadCount = await dev8IntakeRow.locator('button:has-text("查询已读")').count();
            await shotOnFail(pageDev8, dev8QueryReadCount === 0, 't6-a3-nonadmin-no-query-read-btn', '[284 A3] 非 admin：无查询已读按钮（admin 门——canQueryReadIntake 固定只认 isAdminUser；此刻已是 sent 态，admin 视角本该出现该按钮，对照见上方 T4 sent+未读态断言）');
            // ⚠️ 本文件 T1-T4 全程用 adminTok，这是本文件首次以非 admin 身份打开详情页——首次实测即撞出
            // 已知背景噪音：siLoadIntakeLiaisons 对任意登录用户无条件调 GET intake-liaisons（requireAdmin
            // 门控，:685-687 注释"非 admin 会 403，siLoadIntakeLiaisons 对此静默容错"），JS 层已优雅吞掉，
            // 但浏览器对失败的 fetch 仍会原生打一条「Failed to load resource...403」console.error，与
            // JS 是否捕获无关，非本次改动引入（同项目 test-sys-liaison-test-frontend-playwright.js 的
            // allow403 机制、多处既有 playwright 套件均对此类噪音显式豁免）。
            const dev8UnexpectedErrors = pageDev8._consoleErrors.filter(e => !/Failed to load resource.*403/.test(e));
            await shotOnFail(pageDev8, dev8UnexpectedErrors.length === 0, 't6-a3-console-clean', `[284 A3] 非 admin 视角全程无非预期 JS 报错（intake-liaisons 403 已知背景噪音已豁免）——实得 ${dev8UnexpectedErrors.length} 个${dev8UnexpectedErrors.length ? ': ' + dev8UnexpectedErrors.slice(0, 3).join(' | ') : ''}（原始 ${pageDev8._consoleErrors.length} 个）`);
            await pageDev8.close();

            // ═══════════════════════════════════════════════════════════
            // ⭐【反转·改造B新增】improvement 单：受理弹窗**同 feature 一样有**风险等级必选控件，默认
            //   选中「三级」——原口径下 improvement 与 bug 同属"无控件"一侧，本轮起 improvement 转投
            //   feature 一侧，仅 bug 仍是唯一无控件类型（下方 bug 分支断言随之收窄措辞）。
            // ═══════════════════════════════════════════════════════════
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${t6ImprovementId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);
            const impKvBefore = await page.locator('.u-kv-item:has-text("风险等级")').first().textContent().catch(() => '');
            await shotOnFail(page, impKvBefore.includes('未定级'), 't6-imp-risk-kv-undefined-before-accept', `【反转】未受理前 improvement 详情页「风险等级」显示「未定级」（实得："${impKvBefore.trim()}"）`);

            await page.click('#siDActions button:has-text("受理通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            const impRiskSel = page.locator('#f_risk_level');
            await shotOnFail(page, (await impRiskSel.count()) === 1, 't6-imp-risk-select-exists', '【反转】improvement 受理弹窗存在 #f_risk_level 风险等级下拉（改造B前 improvement 本无此控件）');
            const impRiskOptions = await impRiskSel.locator('option').allTextContents();
            await shotOnFail(page, JSON.stringify(impRiskOptions) === JSON.stringify(['请选择', '一级', '二级', '三级']), 't6-imp-risk-select-options', `improvement 风险等级下拉选项恰为 请选择/一级/二级/三级（实得：${JSON.stringify(impRiskOptions)}）`);
            const impRiskDefault = await impRiskSel.inputValue();
            await shotOnFail(page, impRiskDefault === '三级', 't6-imp-risk-select-default-value', `improvement 风险等级下拉默认选中"三级"（同 feature，实得="${impRiskDefault}"）`);

            // 选「二级」提交 → 成功
            await impRiskSel.selectOption('二级');
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);
            const impModalClosed = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, impModalClosed === 0, 't6-imp-risk-submit-success', 'improvement 选定风险等级后点确定 → 受理成功，弹窗关闭');
            const impRiskRow = await dbGet('SELECT status, risk_level FROM sys_issues WHERE id=?', [t6ImprovementId]);
            await shotOnFail(page, !!impRiskRow && impRiskRow.status === '待指派', 't6-imp-risk-db-status', `【反转】improvement 受理后落库 status=待指派，实得=${impRiskRow && impRiskRow.status}`);
            await shotOnFail(page, !!impRiskRow && impRiskRow.risk_level === '二级', 't6-imp-risk-db-value', `【反转】improvement 受理后落库 risk_level=二级（改造B前恒 NULL），实得=${impRiskRow && impRiskRow.risk_level}`);

            await page.waitForTimeout(300);
            const impKvAfter = await page.locator('.u-kv-item:has-text("风险等级")').first().textContent().catch(() => '');
            await shotOnFail(page, impKvAfter.includes('二级') && !impKvAfter.includes('未定级'), 't6-imp-risk-kv-value-after-accept', `【反转】受理后 improvement 详情页「风险等级」显示"二级"（实得："${impKvAfter.trim()}"）`);

            // bug 单：受理弹窗无风险等级控件（改造B后 bug 是唯一无此控件的类型，走既有零输入确认）
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${t6BugId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);
            await page.click('#siDActions button:has-text("受理通过")');
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            const bugRiskSelCount = await page.locator('#f_risk_level').count();
            await shotOnFail(page, bugRiskSelCount === 0, 't6-bug-no-risk-select', 'bug 单受理弹窗无 #f_risk_level 控件（改造B后 bug 是唯一不涉及风险等级的类型）');
            await page.click('#siMConfirm');
            await page.waitForTimeout(800);
            const bugModalClosed = await page.locator('#siModalOverlay.open').count();
            await shotOnFail(page, bugModalClosed === 0, 't6-bug-confirm-success', 'bug 单确认受理 → 成功，弹窗关闭（既有零输入确认路径不受影响）');
            const bugRow = await dbGet('SELECT status, risk_level FROM sys_issues WHERE id=?', [t6BugId]);
            await shotOnFail(page, !!bugRow && bugRow.status === '待处理', 't6-bug-db-status', `bug 受理后落库 status=待处理，实得=${bugRow && bugRow.status}`);
            await shotOnFail(page, !!bugRow && bugRow.risk_level === null, 't6-bug-db-risk-null', `bug 受理后 risk_level 恒 NULL，实得=${bugRow && bugRow.risk_level}`);

            // D15 查询已读：SQL 模拟已过受理段仍 sent+未读态（不经真实外呼，同 T4 手法），查询已读按钮应可用
            await dbRun(`UPDATE sys_issues SET intake_notify_status='sent', intake_notify_message_key='t6-d15-mk', intake_read_at=NULL WHERE id=?`, [t6BugId]);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${t6BugId}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);
            const bugIntakeRow = page.locator('.u-notify-row:has-text("对接人受理")');
            await shotOnFail(page, (await bugIntakeRow.count()) > 0, 't6-d15-bug-row-visible', 'D15：bug 单已过受理段（待处理）后，对接人受理通知行仍渲染');
            const bugQueryReadBtnText = await bugIntakeRow.locator('button').first().textContent().catch(() => '');
            await shotOnFail(page, bugQueryReadBtnText.includes('查询已读'), 't6-d15-query-read-available', `D15：已过受理段仍可用「查询已读」按钮（实得："${bugQueryReadBtnText}"）`);

            await shotOnFail(page, page._consoleErrors.length === 0, 't6-console-clean', `T6 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T7（D22 批2·2026-08-06）：状态显示改名「待验证」→「待验收」——纯展示映射回归。
        //   存储值/API/筛选器 value 恒不变，仅列表徽章文字 + 筛选器选项文字改「待验收」（siStatusDisplay
        //   统一映射口，见 Sys_Iteration.html 同函数注释）。SQL 直推状态（不走真实 submit 链路，本组只
        //   测"给定 status='待验证' 的单，渲染出来的文字是什么"这一件事）。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T7：状态显示改名「待验证」→「待验收」（列表徽章 + 筛选器，存储值不变） ──');
            const t7Res = await fetch(`${BASE_URL}/api/sys-issues`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminTok}` },
                body: JSON.stringify({ intake_contract_version: 2, type: 'feature', title: 't7-display', system_name: 'BMS', source: '内部', description: `T7-display-${RUN_TAG}`, intake_liaison_id: LIAISON_ID })
            });
            const t7Body = await t7Res.json();
            if (t7Res.status !== 201) throw new Error(`T7 前置失败：建单未 201，实得 ${t7Res.status} ${JSON.stringify(t7Body)}`);
            t7DisplayId = t7Body.id;
            // 直推 status='待验证'（本组只测显示映射，不测如何到达该态——到达路径已由 verify-sys-liaison-test
            // 等套件覆盖）。
            await dbRun(`UPDATE sys_issues SET status='待验证' WHERE id=?`, [t7DisplayId]);

            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            // ① 列表徽章：本单所在行的状态徽章文字应显示「待验收」（非「待验证」）。
            const row = page.locator(`tr:has-text("t7-display")`).first();
            await shotOnFail(page, (await row.count()) > 0, 't7-list-row-exists', '列表存在本单所在行');
            const badgeText = await row.locator('.u-status-badge').first().textContent().catch(() => '');
            await shotOnFail(page, badgeText.trim() === '待验收', 't7-list-badge-display', `列表状态徽章显示「待验收」（非存储值「待验证」），实得："${badgeText.trim()}"`);

            // ② 详情页同一改名（复用同一 siStatusDisplay 口，[1637] 详情 header 徽章）。
            await page.evaluate((id) => window.siOpenDrawer && window.siOpenDrawer(id), t7DisplayId);
            await page.waitForTimeout(500);
            const detailBadgeText = await page.locator('#siDMeta .u-status-badge').first().textContent().catch(() => '');
            await shotOnFail(page, detailBadgeText.trim() === '待验收', 't7-detail-badge-display', `详情页状态徽章显示「待验收」，实得："${detailBadgeText.trim()}"`);
            await page.evaluate(() => window.siCloseDrawer && window.siCloseDrawer());
            await page.waitForTimeout(300);

            // ③ 筛选器：option value 仍是存储值「待验证」，仅 option 文字显示「待验收」——value≠text 分离生效。
            const filterOpt = await page.evaluate(() => {
                const sel = document.getElementById('siFStatus');
                const opt = sel ? [...sel.options].find(o => o.value === '待验证') : null;
                return opt ? { value: opt.value, text: opt.textContent } : null;
            });
            await shotOnFail(page, !!filterOpt, 't7-filter-option-exists', '筛选器存在 value="待验证" 的选项（存储值未变）');
            await shotOnFail(page, !!filterOpt && filterOpt.text === '待验收', 't7-filter-option-text', `筛选器该选项显示文字为「待验收」，实得："${filterOpt && filterOpt.text}"`);

            // ④ 筛选器仍按存储值查询：选中该 option 后，本单（真实 status='待验证'）应仍出现在筛选结果里
            //   （证 value 真的是「待验证」在驱动查询，非误把显示文字"待验收"当成了查询参数）。
            await page.selectOption('#siFStatus', '待验证');
            await page.waitForTimeout(600);
            const rowAfterFilter = page.locator(`tr:has-text("t7-display")`).first();
            await shotOnFail(page, (await rowAfterFilter.count()) > 0, 't7-filter-query-by-storage-value', '按「待验收」选项筛选后（实际传参值="待验证"），本单仍在结果集内——筛选器查询确实按存储值而非显示文字');
            const badgeAfterFilter = await rowAfterFilter.locator('.u-status-badge').first().textContent().catch(() => '');
            await shotOnFail(page, badgeAfterFilter.trim() === '待验收', 't7-filter-result-badge-display', `筛选结果内该行徽章仍显示「待验收」，实得："${badgeAfterFilter.trim()}"`);
            await page.selectOption('#siFStatus', '');
            await page.waitForTimeout(300);

            // ⑤ [290 号 L3 最小版] 提交弹窗"提交前确认"双勾布局回归——纯前端渲染，不依赖真实单据（同批1
            //   checkbox+width:100% 根因诊断范式，siModalSubmit 只需一个形状合法的 iss 对象即可渲染）：
            //   ① 两个 checkbox 尺寸未被共享层 `.u-form-group input{width:100%}` 放大（<40px 级判定，
            //   原 bug 表现为 checkbox 撑满整行）；② 点击对应 <label> 能切换 checkbox 勾选态（label
            //   for= 正确关联，非仅视觉对齐、实际点击目标对不上）。
            await page.evaluate(() => { window.siModalSubmit({ id: 999999, type: 'feature', origin_issue_id: null, first_submitted_at: 'x' }); });
            await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
            await page.waitForTimeout(200);
            const cbBox1 = await page.locator('#siSubmitSelfTested').boundingBox();
            const cbBox2 = await page.locator('#siSubmitTestEnvDeployed').boundingBox();
            await shotOnFail(page, !!cbBox1 && cbBox1.width < 40, 't7-checkbox-width-self-tested', `「已完成自测」checkbox 宽度未被共享层 width:100% 放大（<40px 判定），实得宽度=${cbBox1 && cbBox1.width}`);
            await shotOnFail(page, !!cbBox2 && cbBox2.width < 40, 't7-checkbox-width-test-env', `「已上测试库」checkbox 宽度未被共享层 width:100% 放大（<40px 判定），实得宽度=${cbBox2 && cbBox2.width}`);

            const beforeCheck = await page.evaluate(() => ({
                selfTested: document.getElementById('siSubmitSelfTested').checked,
                testEnv: document.getElementById('siSubmitTestEnvDeployed').checked,
            }));
            await shotOnFail(page, beforeCheck.selfTested === false && beforeCheck.testEnv === false, 't7-checkbox-default-unchecked', `两个 checkbox 默认均未勾选（确认清单式，按人留痕），实得=${JSON.stringify(beforeCheck)}`);
            await page.click('label[for="siSubmitSelfTested"]');
            await page.waitForTimeout(100);
            const afterLabel1 = await page.evaluate(() => document.getElementById('siSubmitSelfTested').checked);
            await shotOnFail(page, afterLabel1 === true, 't7-checkbox-label-toggle-1', `点击「已完成自测」label 后对应 checkbox 切换为已勾选（label for= 关联生效，非仅视觉对齐），实得 checked=${afterLabel1}`);
            await page.click('label[for="siSubmitTestEnvDeployed"]');
            await page.waitForTimeout(100);
            const afterLabel2 = await page.evaluate(() => document.getElementById('siSubmitTestEnvDeployed').checked);
            await shotOnFail(page, afterLabel2 === true, 't7-checkbox-label-toggle-2', `点击「已上测试库」label 后对应 checkbox 切换为已勾选，实得 checked=${afterLabel2}`);
            await page.evaluate(() => { window.siCloseModal && window.siCloseModal(); });
            await page.waitForTimeout(200);

            await shotOnFail(page, page._consoleErrors.length === 0, 't7-console-clean', `T7 全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }
    } finally {
        // 🧹 清理测试夹具（不依赖存量数据，自建自清）
        if (createdIssueId) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [createdIssueId]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [createdIssueId]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [createdIssueId]);
            console.log(`\n  🧹 测试夹具已清理（issue #${createdIssueId}）`);
        }
        if (oaExemptIssueId) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [oaExemptIssueId]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [oaExemptIssueId]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [oaExemptIssueId]);
            console.log(`  🧹 T1.5 测试夹具已清理（issue #${oaExemptIssueId}）`);
        }
        // T2b/T2c（#69）夹具——与上两组同一 try/finally 收口。
        // ⭐ codex 568-#69 审 M-1：不只按 id 清，**id 为空时按描述唯一标记补查**。id 只在"固定等待后
        //   dbGet 查到行"这条路走通时才有值；落库慢于等待、或查询异常时 id 为 null 而单据可能已建出来，
        //   只按 id 清就会漏。标记在提交**之前**就已存下，覆盖得到这个窗口。
        //   （断言失败本身不跳过清理——shotOnFail 内部不抛错，已由变异实跑验证；此处防的是另一条路径。）
        //   ⚠️ 覆盖边界如实声明（codex 568-#69 二轮 M-1 修正原注释的绝对化措辞）：本兜底**不能保证**
        //     覆盖所有迟到落库——若提交请求在进入 finally 时尚未完成，补查仍可能查不到，随后才落库。
        //     它把漏清窗口从"等待期内没查到就必漏"收窄到"finally 时点仍未落库才漏"，是收窄不是消灭。
        //   下面三点是二轮 M-1 点出的真实缺陷，已修：
        //     ① 原 `catch(() => null)` 把"查询失败"和"查无记录"混为一谈并静默退出 → 改为区分，查询失败
        //        明确打日志并**计入失败**（清理不静默）。
        //     ② 原来两个 await 顺序执行，T2b 清理抛错会**阻止 T2c 清理** → 改为各自独立 try/catch，
        //        全部尝试完再统一报告。
        //     ③ 清理失败不再无声——汇总后打印，供跑测的人看见（本套件以 PASS/FAIL 汇总收尾，清理属夹具
        //        卫生问题，打印到位即可，不劫持业务断言的成败语义）。
        const cleanupByIdOrMarker = async (label, id, marker, submitAttempted) => {
            let targetId = id;
            if (!targetId && marker) {
                let found = null;
                try {
                    // 精确匹配优先（marker 是本轮唯一串，描述以它开头）——LIKE 前缀查询在极端碰撞下可能
                    //   取到别的行，故先按等值查完整描述不可行（描述含后续行），仍用前缀但**校验唯一性**。
                    const rows = await dbAll(`SELECT id, description FROM sys_issues WHERE description LIKE ?`, [`${marker}%`]);
                    if (rows.length > 1) {
                        console.log(`  ⚠️ ${label}：描述标记 "${marker}" 命中 ${rows.length} 行（预期 1），不自动删除，需人工核实：${JSON.stringify(rows.map(r => r.id))}`);
                        cleanupFailures.push(`${label}: marker 命中 ${rows.length} 行，未清理`);
                        return;
                    }
                    found = rows[0] || null;
                } catch (e) {
                    console.log(`  ❗ ${label}：按标记补查**失败**（非"查无记录"），夹具可能残留：${e && e.message}`);
                    cleanupFailures.push(`${label}: 补查失败 ${e && e.message}`);
                    return;
                }
                if (found) {
                    targetId = found.id;
                    console.log(`  ⚠️ ${label}：id 未取得但按描述标记补查到 issue #${targetId}（响示例开发N时/点击异常/落库迟到），执行兜底清理`);
                }
            }
            if (!targetId) {
                // ⭐ 三轮 M-1：零行不等于"没有夹具"。提交动作发起过、却既没拿到响应 id、补查也零行时，
                //   服务端仍可能在此之后落库 —— 这是**清理状态未知**，必须报出来，不能按"无夹具"静默结束。
                if (submitAttempted) {
                    console.log(`  ❗ ${label}：已尝试提交但未取得 id，且按标记补查零行 —— **清理状态未知**（可能服务端迟于本次查询才落库），请人工核实标记 "${marker}"`);
                    cleanupFailures.push(`${label}: 清理状态未知（已提交/无 id/补查零行），标记 ${marker}`);
                }
                return;
            }
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [targetId]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [targetId]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [targetId]);
            console.log(`  🧹 ${label} 测试夹具已清理（issue #${targetId}）`);
        };
        for (const [label, id, marker, submitAttempted] of [
            ['T2b', explicitTitleIssueId, explicitTitleDescMarker, explicitTitleSubmitAttempted],
            ['T2c', blankTitleIssueId, blankTitleDescMarker, blankTitleSubmitAttempted],
        ]) {
            // ② 独立捕获：任一夹具清理抛错都不影响其余夹具被尝试清理。
            try { await cleanupByIdOrMarker(label, id, marker, submitAttempted); }
            catch (e) { console.log(`  ❗ ${label} 清理抛错，夹具可能残留：${e && e.message}`); cleanupFailures.push(`${label}: 清理抛错 ${e && e.message}`); }
        }
        if (cleanupFailures.length) {
            console.log(`\n  ❗❗ 夹具清理存在 ${cleanupFailures.length} 项未收口（需人工核实，勿当作"已清理干净"）：\n     - ${cleanupFailures.join('\n     - ')}`);
        }
        // [284 号 M-3 必修] T6 两夹具此前漏清——finally 是唯一收口点，任一断言中途失败也须走到这里
        // （与上两组同一 try/finally 结构，天然覆盖失败路径，非额外新增的容错分支）。
        if (t6FeatureId) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [t6FeatureId]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [t6FeatureId]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [t6FeatureId]);
            console.log(`  🧹 T6 feature 测试夹具已清理（issue #${t6FeatureId}）`);
        }
        if (t6BugId) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [t6BugId]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [t6BugId]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [t6BugId]);
            console.log(`  🧹 T6 bug 测试夹具已清理（issue #${t6BugId}）`);
        }
        // ⭐ 改造B新增：improvement 夹具同 feature/bug 一并在 finally 兜底清理。
        if (t6ImprovementId) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [t6ImprovementId]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [t6ImprovementId]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [t6ImprovementId]);
            console.log(`  🧹 T6 improvement 测试夹具已清理（issue #${t6ImprovementId}）`);
        }
        // ⭐ D22 批2新增：T7 状态显示改名夹具。
        if (t7DisplayId) {
            await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id=?`, [t7DisplayId]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id=?`, [t7DisplayId]);
            await dbRun(`DELETE FROM sys_issues WHERE id=?`, [t7DisplayId]);
            console.log(`  🧹 T7 测试夹具已清理（issue #${t7DisplayId}）`);
        }
        await browser.close();
        db.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    // ⭐ 退出码分层（codex 568-#69 三轮 M-3）：功能失败=1（既有语义不变，优先级最高，不被清理状态覆盖）；
    //   功能全通过但**夹具清理未收口**=2。这样"功能红"与"夹具没清干净"对只读退出码的调用方也可区分，
    //   不会再出现"夹具残留却被当作完全成功"。
    if (fail > 0) {
        console.log('  ❌ 建单优化批 C1/C2 前端 Playwright 冒烟存在失败项');
        if (cleanupFailures.length) console.log(`  ❗ 另有 ${cleanupFailures.length} 项夹具清理未收口（见上方明细）`);
        process.exit(1);
    }
    if (cleanupFailures.length) {
        console.log(`  ❗❗ 功能断言全通过，但有 ${cleanupFailures.length} 项夹具清理未收口——退出码 2（勿当作完全成功）`);
        process.exit(2);
    }
    console.log('  🎉 建单优化批 C1/C2 前端 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('实测脚本异常:', e && e.stack || e); process.exit(1); });
