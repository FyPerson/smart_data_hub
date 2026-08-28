/**
 * 建单优化批 C1/C2 前端 Playwright 冒烟——对接人下拉 + title 派生 + intake 通知按钮三态
 * （方案 v1.2 §3.6/§4.8/§6b.1，对齐 test-sys-release-c7-playwright.js 套件范式）
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-intake-liaison-playwright.js
 *
 * 覆盖：
 *   T1 建单弹窗结构+校验：无 #f_title 输入框 / 描述必填拦截（留空点确定→toast「描述必填」+弹窗不关）/
 *       对接人下拉默认选中「示例对接人」（本地唯一 active 受理人=13）
 *   T2 无 title 建单成功：description 首行经 esc/trim 后 = 落库 title（列表 + 详情 + DB 三处核对，非猜测）
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
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
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

            await shotOnFail(page, (await page.locator('#f_title').count()) === 0, 't1-no-title-field', '建单弹窗无 #f_title 输入框（标题输入框已撤）');
            const descField = page.locator('#f_description');
            await shotOnFail(page, (await descField.count()) === 1, 't1-description-field-exists', '建单弹窗存在 #f_description 描述 textarea');
            const descLabel = await page.locator('label:has-text("描述")').first().textContent();
            await shotOnFail(page, descLabel.includes('*'), 't1-description-required-star', `描述字段 label 含必填星号（实得："${descLabel.trim()}"）`);
            const descPlaceholder = await descField.getAttribute('placeholder');
            await shotOnFail(page, descPlaceholder && descPlaceholder.includes('标题将自动取首行'), 't1-description-placeholder', `描述 placeholder 提示标题自动取首行（实得："${descPlaceholder}"）`);

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
    if (fail > 0) { console.log('  ❌ 建单优化批 C1/C2 前端 Playwright 冒烟存在失败项'); process.exit(1); }
    console.log('  🎉 建单优化批 C1/C2 前端 Playwright 冒烟全部通过');
}

main().catch(e => { console.error('实测脚本异常:', e && e.stack || e); process.exit(1); });
