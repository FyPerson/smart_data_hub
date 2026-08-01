/**
 * 上线体统一重构 C2b 第2批 + C3 第2批 Playwright 冒烟——排班维护（含区间批量设置）+ 批次详情新面板按钮
 * 显隐随角色/通知态变化 + release_published timeline 折叠渲染 + 【C3 第2批新增】「应急上线」独立按钮新
 * 文案 + 旧按钮（发布批次旧流程 / bug 旧执行上线）已移除断言。
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-release-panel-c2b2-playwright.js
 * JWT 注入范式复用项目既有先例（goto login.html → localStorage token → goto 业务页，见
 * test-issue-c6a-playwright.js / test-model-center-sort-playwright.js）——鉴权页直接 goto 业务页会被
 * checkAuth 销毁 context。
 *
 * ⚠️ 钉钉安全边界（实测确认，写进完成报告 §4）：
 *   - notify-executor（前端「安排上线」按钮）本地已配置真实钉钉凭证（dingtalk_app_key/secret/robot_code
 *     均 SET），点击会真实外呼——本脚本**只断言该按钮的可见性/文案，绝不点击**。
 *   - execute（「执行上线」）/ cancel-schedule（「撤销上线安排」）/ update-planned-date（「改期」）三端点
 *     均已读代码确认**不触发钉钉**：execute 提交后的 dispatchSysNotify 走 isAutoNotifyEnabled()（硬编码
 *     return false）早返回，早于任何外呼；cancel-schedule/update-planned-date 纯 DB 操作零外呼——本脚本
 *     对这三个端点做真实点击全链路验证，安全。
 *   - 「已通知」（sent）态用直接 SQL UPDATE 模拟（不经 notify-executor 产生），规避真实外呼又能覆盖
 *     该态下的按钮显隐断言。
 *   - 【C3 第2批新增·T3】hotfix-publish（「应急上线」）同样已配真实钉钉凭证——本脚本只点开弹窗核对
 *     标题/说明文案，全程不点弹窗自带的「确定」（#siMConfirm），只点 × 关闭，不触发任何 API 调用。
 *
 * 覆盖：
 *   T1 批次：安排上线按钮可见性（not_sent，不点击）+「改期」全链路（含同值 no-op 分支）
 *            + 撤销上线安排全链路（liaison 可见可点·admin 不可见）
 *            + 【C3 断言反转】旧「发布批次（旧流程）」按钮已不在（legacy /publish 全类型 409，死按钮已删）
 *   T2 批次：执行上线按钮权限显隐（仅指定执行人可见，admin/其他人不可见）+ 全链路执行
 *            + release_published timeline 折叠渲染（自定义标签 + details 默认收起 + 过滤开关）
 *   【C3 第2批新增】T3 单据抽屉（issue3-bug）：独立「应急上线」按钮存在 + 弹窗新文案（标题/说明，不提交）
 *            + bug 旧「执行上线」死按钮已从「上线编排」区块移除 +【C9 前端块断言反转·codex 206 审 MED-3】
 *              「指定上线开发」按钮已隐藏（只读历史说明文案仍在，此前"按钮仍在"的旧断言已随之修正）
 *   【C9 前端块新增·codex 206 审 MED-2】T3b 单据抽屉（issue4-bug，已挂 relT3）：「前往上线单」按钮权限镜像——
 *            admin/对接人可见可点，仅凭 isAssignee 分支能看见单据本身的普通用户不可见（但进度文案仍保留）
 *   排班维护：区间批量设置全链路（含浏览器 confirm 对话框自动接受 + 表格断言）
 */
'use strict';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SCREENSHOT_DIR = 'C:\\Users\\FY\\AppData\\Local\\Temp\\claude\\E-------------\\a54adce7-08ae-486c-ad80-5602b9b49bf0\\scratchpad';

const ADMIN_ID = 1;
const LIAISON_ID = 13;    // 示例对接人（受理人白名单）
const EXECUTOR_ID = 8;    // 示例开发A（active·role=user·非白名单，普通有资格值班人）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}
async function api(token, method, p, body) {
    const r = await fetch(`${BASE_URL}${p}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* 无 body */ }
    return { status: r.status, body: j };
}

let pass = 0, fail = 0;
const failShots = [];
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `c2b2-fail-${name}.png`);
        try { await page.screenshot({ path: p }); failShots.push(p); console.log(`     📸 失败截图: ${p}`); } catch (_) { /* 截图本身失败不影响主流程 */ }
    }
}

async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());   // confirm() 自动接受（批量设置等有原生 confirm 弹窗）
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}
async function openBatchDetail(page, batchTitle) {
    await page.goto(`${BASE_URL}/Sys_Iteration.html`);
    await page.waitForLoadState('networkidle');
    await page.click('button:has-text("上线单管理")');
    await page.waitForTimeout(300);
    await page.click(`.si-batch-item:has-text("${batchTitle}")`);
    await page.waitForTimeout(400);
}
async function lastToastText(page) {
    return page.evaluate(() => {
        const nodes = document.querySelectorAll('#toast-container > div');
        return nodes.length ? nodes[nodes.length - 1].textContent.trim() : '';
    });
}

async function main() {
    const adminTok = await signAs(ADMIN_ID);
    const liaisonTok = await signAs(LIAISON_ID);
    const executorTok = await signAs(EXECUTOR_ID);
    console.log('\n══════ 上线体统一重构 C2b 第2批 Playwright 冒烟 ══════');
    console.log(`  actors: admin=${ADMIN_ID} / liaison=${LIAISON_ID}(示例对接人) / executor=${EXECUTOR_ID}(示例开发A)`);

    // ── 夹具：2 条测试迭代单，直接 SQL 推进到「待上线」（跳过完整状态机走行，非本次测试范围）──
    const mkIssue = async (title) => {
        const r = await api(adminTok, 'POST', '/api/sys-issues', {
            type: 'feature', title, system_name: '智数协同', source: '内部', intake_contract_version: 2,
            description: title, intake_liaison_id: 13,
        });
        if (r.status !== 201) throw new Error(`建单失败: ${JSON.stringify(r.body)}`);
        const id = r.body.id;
        await dbRun(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [id]);
        return id;
    };
    const issue1 = await mkIssue('C2b2冒烟测试单T1');
    const issue2 = await mkIssue('C2b2冒烟测试单T2');
    // [C3 第2批 Task E] issue3：bug 类型、待上线、不挂任何批次（release_id 保持 NULL）——专供验证：
    //   ①「应急上线」独立按钮新文案（类型统一后 bug 首次拥有触发 hotfix-publish 的入口，见 Sys_Iteration.html
    //   siRenderActions 的 hotfixBtn） ②bug 旧「执行上线」死按钮（siModalExecuteRelease→execute-release，
    //   现恒 409）已从「上线编排」区块彻底移除。只开弹窗读文案、不点确定提交（真钉钉凭证在位，见脚本头部）。
    const mkBugIssue = async (title) => {
        const r = await api(adminTok, 'POST', '/api/sys-issues', {
            type: 'bug', title, system_name: '智数协同', source: '内部', intake_contract_version: 2,
            description: title, intake_liaison_id: 13,
        });
        if (r.status !== 201) throw new Error(`建 bug 单失败: ${JSON.stringify(r.body)}`);
        const id = r.body.id;
        await dbRun(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [id]);
        return id;
    };
    const issue3 = await mkBugIssue('C2b2冒烟测试单T3-bug');
    // [C9 前端块·codex 206 审 MED-2] issue4：bug 类型、待上线，随后加入 relT3（真实 add-issues，issue4.release_id
    // 会被服务端填上）——专供验证「前往上线单」按钮的权限镜像（admin/对接人可见，其余角色即便能看见单据本身
    // 也不该看见这个必然 403 的按钮）。assigned_to 设为 EXECUTOR_ID（示例开发A，plain user），让他能看见单据详情
    // （isAssignee 可见性分支）但不满足按钮的三条镜像分支中任何一条——真实测的是"看得见单据 ≠ 看得见按钮"。
    const issue4 = await mkBugIssue('C9前端块冒烟-前往上线单权限');
    await dbRun(`UPDATE sys_issues SET assigned_to=?, assigned_to_name=? WHERE id=?`, [EXECUTOR_ID, '示例开发A', issue4]);
    // issue2 会真的走到 /execute（T1 只到「已通知」就撤销，不会真发布）——_publishReleaseCoreInTxn 的「任务
    // 开发名单门」（status-transition-guard 的 roster 门，§6.10「任务开发名单门全类型照校」）要求在册 dev
    // assignee ≥1 且全员非 pending，否则 400 GATE_INVARIANT。issue2 是纯 SQL 建的测试夹具没走真实指派流程，
    // 补一条 dev_assignees 在册行（dev_status='code_submitted'，非 pending）满足该闸门（首次实测踩坑）。
    await dbRun(
        `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status) VALUES (?, ?, ?, 1, 'code_submitted')`,
        [issue2, EXECUTOR_ID, '示例开发A']
    );

    // ── 夹具：2 个测试批次 + 各自加单 ──
    const mkBatch = async (title) => {
        const r = await api(adminTok, 'POST', '/api/sys-releases', { title });
        if (r.status !== 201) throw new Error(`建批次失败: ${JSON.stringify(r.body)}`);
        return r.body.id;
    };
    const relT1 = await mkBatch('C2b2冒烟批次T1');
    const relT2 = await mkBatch('C2b2冒烟批次T2');
    const relT3 = await mkBatch('C9前端块冒烟-前往上线单权限批次');
    const addR1 = await api(adminTok, 'POST', `/api/sys-releases/${relT1}/add-issues`, { issue_ids: [issue1] });
    const addR2 = await api(adminTok, 'POST', `/api/sys-releases/${relT2}/add-issues`, { issue_ids: [issue2] });
    const addR3 = await api(adminTok, 'POST', `/api/sys-releases/${relT3}/add-issues`, { issue_ids: [issue4] });
    if (addR1.status !== 200 || addR2.status !== 200 || addR3.status !== 200) throw new Error('add-issues 夹具失败: ' + JSON.stringify([addR1.body, addR2.body, addR3.body]));
    console.log(`  夹具就绪：issue1=#${issue1} issue2=#${issue2} issue4=#${issue4} relT1=#${relT1} relT2=#${relT2} relT3=#${relT3}`);

    const browser = await chromium.launch();
    const dutyCleanupIds = [];
    try {
        // ═══════════════════════════════════════════════════════════════
        // T1：安排上线按钮可见性（不点击）+ 改期全链路 + 撤销上线安排全链路
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T1：批次详情面板（admin 视角，初始 not_sent 态） ──');
            const page = await loginPage(browser, adminTok);
            await openBatchDetail(page, 'C2b2冒烟批次T1');

            const bodyText1 = await page.textContent('#siBatchBody');
            await shotOnFail(page, bodyText1.includes('未设置'), 't1-planned-date-unset', 'T1 初始「计划上线日期」显示未设置');
            await shotOnFail(page, (await page.locator('#siBatchBody button:has-text("改期")').count()) > 0, 't1-edit-date-btn', 'T1「改期」按钮可见（admin+planning）');
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("安排上线")').count()) > 0, 't1-notify-btn-visible',
                'T1「安排上线」按钮可见（not_sent+成员非空；仅验证可见性不点击——本地已配真实钉钉凭证，见脚本头部说明）');
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("撤销上线安排")').count()) === 0, 't1-cancel-btn-hidden-initial', 'T1 初始「撤销上线安排」不可见（通知态非 sent/stale/failed）');
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("执行上线")').count()) === 0, 't1-execute-btn-hidden-initial', 'T1 初始「执行上线」不可见（无匹配执行人）');
            // [C3 第2批 Task E 断言反转] C2b 时"新旧并存过渡期"已结束——C3 后端已让 legacy /publish 全类型 409，
            //   前端本批同提交把「发布批次（旧流程）」按钮 + 其唯一调用方 siModalPublishBatch 一并删除
            //   （见 index.js 该路由 / Sys_Iteration.html siOpenBatchDetail 两处注释），旧断言"仍在"已过时。
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("发布批次（旧流程）")').count()) === 0, 't1-legacy-publish-btn-gone', 'T1「发布批次（旧流程）」按钮已不在（C3 收口，legacy /publish 全类型 409，前端同批删除死按钮）');

            // 改期：首次设置（真实调用 update-planned-date，无钉钉侧效应，见脚本头部说明）
            await page.click('#siBatchBody button:has-text("改期")');
            await page.waitForTimeout(200);
            await page.fill('#f_planned_date', '2032-01-15');
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);
            const toast1 = await lastToastText(page);
            await shotOnFail(page, toast1.includes('计划上线日期已更新为 2032-01-15'), 't1-replan-toast', `T1 改期成功 toast 文案正确（实得：${toast1}）`);
            const bodyText2 = await page.textContent('#siBatchBody');
            await shotOnFail(page, bodyText2.includes('2032-01-15'), 't1-replan-date-shown', 'T1 改期后「计划上线日期」显示 2032-01-15');

            // 改期：同值提交 → changed=false no-op 分支
            await page.click('#siBatchBody button:has-text("改期")');
            await page.waitForTimeout(200);
            const curVal = await page.inputValue('#f_planned_date');
            await shotOnFail(page, curVal === '2032-01-15', 't1-replan-modal-prefill', 'T1 改期弹窗日期字段正确预填当前值');
            await page.fill('#f_planned_date', '2032-01-15');
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);
            const toast2 = await lastToastText(page);
            await shotOnFail(page, toast2.includes('日期未变化，无需处理'), 't1-replan-noop-toast', `T1 同值改期 → changed=false no-op 分支 toast 正确（实得：${toast2}）`);

            // 直接 SQL 模拟「已通知」态（不经 notify-executor，规避真实外呼）——供撤销上线安排测试。
            await dbRun(
                `UPDATE sys_releases SET release_assignee_id=?, release_assignee_name=?, release_assignee_notify_status='sent',
                    release_assignee_notify_token='c2b2-test-token', release_assignee_notified_at=datetime('now','localtime'),
                    release_assignee_notify_message_key='c2b2-test-mk'
                 WHERE id=?`,
                [EXECUTOR_ID, '示例开发A', relT1]
            );
            await page.reload();
            await page.waitForLoadState('networkidle');
            await page.click('button:has-text("上线单管理")');
            await page.waitForTimeout(300);
            await page.click(`.si-batch-item:has-text("C2b2冒烟批次T1")`);
            await page.waitForTimeout(400);

            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("安排上线")').count()) === 0, 't1-notify-btn-hidden-when-sent', 'T1 已通知（sent）态下「安排上线」按钮消失（不在 not_sent/failed/stale 内）');
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("撤销上线安排")').count()) === 0, 't1-cancel-btn-hidden-for-admin', 'T1 已通知态下 admin 看不到「撤销上线安排」（admin 无此权限，镜像后端 requireLiaisonOnly）');
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("执行上线")').count()) === 0, 't1-execute-btn-hidden-for-admin', 'T1 已通知态下 admin 看不到「执行上线」（admin(1) ≠ 执行人(8)）');
            const bodyText3 = await page.textContent('#siBatchBody');
            await shotOnFail(page, bodyText3.includes('示例开发A'), 't1-assignee-shown', 'T1「上线执行人」显示示例开发A');
            await shotOnFail(page, bodyText3.includes('已通知'), 't1-notify-status-shown', 'T1「通知状态」显示已通知');
            // [2026-07-30 通知三件套] sent 态通知状态格出现「重新通知」+「查询已读」（admin·未读且有 message_key）
            //   ——只断言可见性不点击（重新通知会真实外呼钉钉，本地已配真实凭证，见脚本头部说明）。
            await shotOnFail(page, (await page.locator('#siBatchBody button:has-text("重新通知")').count()) > 0, 't1-resend-btn-visible', 'T1 已通知态「重新通知」按钮可见（通知三件套对齐，仅验证可见性不点击）');
            await shotOnFail(page, (await page.locator('#siBatchBody button:has-text("查询已读")').count()) > 0, 't1-queryread-btn-visible', 'T1 已通知未读态「查询已读」按钮可见（admin-only）');
            await page.close();
        }

        // ── T1（续）：以对接人身份验证「撤销上线安排」可见 + 真实点击全链路 ──
        {
            console.log('\n── T1（续）：撤销上线安排（liaison 示例对接人视角） ──');
            const page = await loginPage(browser, liaisonTok);
            await openBatchDetail(page, 'C2b2冒烟批次T1');
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("撤销上线安排")').count()) > 0, 't1-cancel-btn-visible-liaison', 'T1 对接人视角「撤销上线安排」按钮可见');
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("安排上线")').count()) === 0, 't1-notify-btn-hidden-liaison', '对接人非 admin，「安排上线」按钮本就不可见（admin 专属）');

            await page.click('#siBatchFoot button:has-text("撤销上线安排")');
            await page.waitForTimeout(200);
            await page.fill('#f_reason', 'C2b2冒烟测试-撤销上线安排');
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);
            const toast3 = await lastToastText(page);
            await shotOnFail(page, toast3.includes('已撤销上线安排') && toast3.includes('示例开发A'), 't1-cancel-toast', `撤销上线安排成功 toast 含原执行人姓名（实得：${toast3}）`);
            const bodyText4 = await page.textContent('#siBatchBody');
            await shotOnFail(page, bodyText4.includes('未通知'), 't1-notify-status-reset', '撤销后「通知状态」回到未通知');
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("撤销上线安排")').count()) === 0, 't1-cancel-btn-gone-after', '撤销后「撤销上线安排」按钮消失（not_sent 不再满足 sent/stale/failed 前置）');
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T2：执行上线按钮权限显隐 + 全链路执行 + timeline 折叠渲染
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T2：执行上线权限显隐 + 全链路执行 ──');
            // 直接 SQL 模拟「已通知给示例开发A」态（规避真实外呼，见脚本头部说明）。
            await dbRun(
                `UPDATE sys_releases SET release_assignee_id=?, release_assignee_name=?, release_assignee_notify_status='sent',
                    release_assignee_notify_token='c2b2-test-token-2', release_assignee_notified_at=datetime('now','localtime')
                 WHERE id=?`,
                [EXECUTOR_ID, '示例开发A', relT2]
            );

            // admin 视角：不应看到「执行上线」
            const pageAdmin = await loginPage(browser, adminTok);
            await openBatchDetail(pageAdmin, 'C2b2冒烟批次T2');
            await shotOnFail(pageAdmin, (await pageAdmin.locator('#siBatchFoot button:has-text("执行上线")').count()) === 0, 't2-execute-btn-hidden-admin', 'T2 admin 视角看不到「执行上线」（admin(1) ≠ 执行人(8)）');
            await pageAdmin.close();

            // 执行人本人视角：可见 + 真实点击全链路（execute 端点无钉钉侧效应，见脚本头部说明）
            // ⚠️ 执行人非 admin/对接人，看不到「上线单管理」入口（Playwright 冒烟本环节实测发现的真实缺口，
            //   已修：GET /sys-releases/:id 放行「本批次执行人」+ 前端新增 ?release=<id> 深链，见完成报告）——
            //   走深链直达详情页，不能复用 openBatchDetail() 那套点「上线单管理」的导航路径。
            const pageExec = await loginPage(browser, executorTok);
            await pageExec.goto(`${BASE_URL}/Sys_Iteration.html?release=${relT2}`);
            await pageExec.waitForLoadState('networkidle');
            await pageExec.waitForTimeout(500);
            await shotOnFail(pageExec, (await pageExec.locator('button:has-text("上线单管理")').count()) === 0, 't2-batch-mgmt-hidden-executor', '执行人（非 admin/对接人）看不到「上线单管理」入口（列表端点未放开，符合最小暴露面设计）');
            await shotOnFail(pageExec, (await pageExec.locator('#siBatchFoot button:has-text("执行上线")').count()) > 0, 't2-execute-btn-visible-self', 'T2 执行人本人（示例开发A）经 ?release= 深链直达详情，「执行上线」按钮可见');
            await shotOnFail(pageExec, (await pageExec.locator('#siBatchFoot button:has-text("安排上线")').count()) === 0, 't2-notify-btn-hidden-nonadmin', '非 admin 本就看不到「安排上线」');

            await pageExec.click('#siBatchFoot button:has-text("执行上线")');
            await pageExec.waitForTimeout(200);
            await pageExec.fill('#f_release_note', 'C2b2冒烟测试-执行上线');
            await pageExec.click('#siMConfirm');
            await pageExec.waitForTimeout(600);
            const toast4 = await lastToastText(pageExec);
            await shotOnFail(pageExec, toast4.includes('已上线'), 't2-execute-toast', `执行上线成功 toast 文案正确（实得：${toast4}）`);
            const bodyText5 = await pageExec.textContent('#siBatchBody');
            await shotOnFail(pageExec, bodyText5.includes('已发布'), 't2-status-published', 'T2 执行后批次状态显示已发布');
            const issue2Row = await dbGet('SELECT status FROM sys_issues WHERE id=?', [issue2]);
            await shotOnFail(pageExec, issue2Row && issue2Row.status === '已上线', 't2-issue-status-released', `底层迭代单 #${issue2} status 已真实转为「已上线」（实得：${issue2Row && issue2Row.status}）`);
            await pageExec.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T3：「应急上线」独立按钮新文案（不点确定，只开弹窗读文案）+ bug 旧「执行上线」死按钮已移除
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T3：应急上线按钮新文案 + bug 旧执行上线死按钮移除断言（issue3-bug 详情抽屉） ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issue3}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500);

            // ① 独立「应急上线」按钮存在（类型统一后 bug 首次拥有触发 hotfix-publish 的入口，脱离已删除的
            //   meta 'publish' action，见 Sys_Iteration.html siRenderActions 的 hotfixBtn）。
            const hotfixBtnLoc = page.locator('#siDActions button:has-text("应急上线")');
            await shotOnFail(page, (await hotfixBtnLoc.count()) > 0, 't3-hotfix-btn-present', 'T3「应急上线」独立按钮存在（bug 类型·待上线·无 release_id·admin 可见——旧 meta 驱动按钮已删，改类型统一独立入口）');

            // ② 点击打开弹窗（纯前端渲染，未调用任何 API）——核对标题/说明文案已改写为"返回即已安排"新语义，
            //   随后点击弹窗自带的 × 关闭，**全程不点「确定」**，规避真实钉钉外呼（本地已配真实凭证，见脚本头部）。
            await hotfixBtnLoc.click();
            await page.waitForTimeout(200);
            const modalHead = (await page.textContent('#siMHead') || '').trim();
            await shotOnFail(page, modalHead === '应急上线', 't3-hotfix-modal-title', `T3 弹窗标题为「应急上线」（旧文案「单条上线（hotfix）」已改，实得："${modalHead}"）`);
            const modalNote = await page.textContent('#siMBody');
            await shotOnFail(page, modalNote.includes('建应急上线单') && modalNote.includes('值班开发'), 't3-hotfix-modal-note', 'T3 弹窗说明文案已改为两阶段"返回即已安排"新语义（含"建应急上线单"+"值班开发"关键词，非旧文案"发布后转已上线并通知需求方"）');
            await page.click('#siModalOverlay .si-close');   // 关闭弹窗（不点 #siMConfirm，不触发真实 API 调用）
            await page.waitForTimeout(200);
            await shotOnFail(page, (await page.locator('#siModalOverlay.open').count()) === 0, 't3-hotfix-modal-closed', 'T3 弹窗已关闭（未点确定，未发起任何请求）');

            // ③ bug 旧「执行上线」死按钮（siModalExecuteRelease→execute-release，现恒 409）已从「上线编排」
            //   区块彻底移除——精确限定在该区块内查找，避免与批次详情页真实有效的「✅ 执行上线」按钮同名误判。
            const orchSection = page.locator('.u-detail-section:has(h3:has-text("上线编排"))');
            await shotOnFail(page, (await orchSection.count()) > 0, 't3-orch-section-present', 'T3「上线编排」区块仍渲染（admin+bug+待上线，siReleaseOrchHasContent 仍为真）');
            await shotOnFail(page, (await orchSection.locator('button:has-text("执行上线")').count()) === 0, 't3-orch-execute-btn-gone', 'T3「上线编排」区块内旧「执行上线」死按钮已移除（siModalExecuteRelease 函数本体已删）');
            // [C9 前端块·codex 206 审 MED-3] 「指定上线开发」按钮已隐藏（此前的裁定"C7 已断误操作路径"不成立——
            // C7 只隐藏了「上线编排」批量面板入口，本区块这条独立按钮此前仍可点、仍能拿到 200 但字段不参与
            // 新执行链路，是本次改的真问题）。断言从"按钮仍在"翻转为"按钮已隐藏但历史说明文案仍在"。
            await shotOnFail(page, (await orchSection.locator('button:has-text("指定上线开发")').count()) === 0, 't3-orch-assign-btn-hidden', 'T3「上线编排」区块内「指定上线开发」按钮已隐藏（2026-07-30 起 assign-release-dev 端点已随旧家族封禁，前端可达路径为零）');
            const orchText = (await orchSection.textContent()) || '';
            await shotOnFail(page, orchText.includes('历史留痕机制') && orchText.includes('入口已下线'), 't3-orch-assign-hint-text', 'T3「上线编排」区块仍保留只读历史说明文案（"历史留痕机制"+"入口已下线"），只是没有可点击按钮');

            await shotOnFail(page, page._consoleErrors.length === 0, 't3-console-clean', `T3 页面全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // T3b：「前往上线单」按钮权限镜像（[C9 前端块] codex 206 审 MED-2）——issue4-bug 详情抽屉
        //   （已挂 relT3，release_id 非空）。三角色对比：admin/对接人应见按钮，仅能看见单据本身（isAssignee
        //   分支）的普通用户不该见按钮，但应仍能看见进度提示文案（"宁可少显示不要显示了点不开"）。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── T3b：「前往上线单」按钮权限镜像（issue4-bug 详情抽屉，已挂 relT3） ──');
            const orchSel = '.u-detail-section:has(h3:has-text("上线编排"))';
            const goBtnSel = `${orchSel} button:has-text("前往上线单")`;

            const pageAdmin = await loginPage(browser, adminTok);
            await pageAdmin.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issue4}`);
            await pageAdmin.waitForLoadState('networkidle');
            await pageAdmin.waitForTimeout(500);
            await shotOnFail(pageAdmin, (await pageAdmin.locator(goBtnSel).count()) > 0, 't3b-admin-btn-visible', 'T3b admin 视角「前往上线单」按钮可见（镜像后端 GET /sys-releases/:id 的 admin 分支）');
            await shotOnFail(pageAdmin, pageAdmin._consoleErrors.length === 0, 't3b-admin-console-clean', `T3b admin 页面全程无 JS 报错（${pageAdmin._consoleErrors.length} 个）`);
            await pageAdmin.close();

            const pageLiaison = await loginPage(browser, liaisonTok);
            await pageLiaison.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issue4}`);
            await pageLiaison.waitForLoadState('networkidle');
            await pageLiaison.waitForTimeout(500);
            await shotOnFail(pageLiaison, (await pageLiaison.locator(goBtnSel).count()) > 0, 't3b-liaison-btn-visible', 'T3b 对接人(示例对接人)视角「前往上线单」按钮可见（镜像后端对接人分支）');
            await pageLiaison.close();

            // 普通用户（示例开发A，assigned_to=本单·isAssignee 可见性分支放行，但非 admin/对接人/本批次执行人）——
            // 能打开详情页（否则 goto 会被 checkAuth/403 拦住整页），但「前往上线单」按钮不该出现，仅保留进度文案。
            const pageOther = await loginPage(browser, executorTok);
            await pageOther.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issue4}`);
            await pageOther.waitForLoadState('networkidle');
            await pageOther.waitForTimeout(500);
            await shotOnFail(pageOther, (await pageOther.locator(orchSel).count()) > 0, 't3b-other-can-view', 'T3b 普通用户（isAssignee 分支放行）仍能看到单据详情本身（前置条件：不是整页 403）');
            await shotOnFail(pageOther, (await pageOther.locator(goBtnSel).count()) === 0, 't3b-other-btn-hidden', 'T3b 普通用户（非 admin/对接人/批次执行人）「前往上线单」按钮不可见——点击会 403，故不显示（宁可少显示不要显示了点不开）');
            const otherOrchText = (await pageOther.locator(orchSel).textContent()) || '';
            await shotOnFail(pageOther, otherOrchText.includes('已建应急上线单'), 't3b-other-progress-text-kept', 'T3b 普通用户仍能看到「已建应急上线单」进度文案（按钮隐藏≠信息也隐藏）');
            await shotOnFail(pageOther, pageOther._consoleErrors.length === 0, 't3b-other-console-clean', `T3b 普通用户页面全程无 JS 报错（${pageOther._consoleErrors.length} 个）`);
            await pageOther.close();
        }

        // ── timeline 折叠渲染：打开 issue2 的详情抽屉 ──
        {
            console.log('\n── timeline release_published 折叠渲染（issue2 详情抽屉） ──');
            const page = await loginPage(browser, adminTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issue2}`);
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(600);

            const hasFilterToggle = await page.locator('label:has-text("隐藏上线单调整记录")').count();
            await shotOnFail(page, hasFilterToggle > 0, 'tl-filter-toggle-present', 'timeline 区出现「隐藏上线单调整记录」过滤开关（本单确有 release_add/release_published 事件；[C7] 文案随「批次」→「上线单」术语统一同步改名）');

            const evtLabels = await page.$$eval('.si-tl-evt', els => els.map(e => e.textContent.trim()));
            await shotOnFail(page, evtLabels.some(t => t.includes('发布留痕')), 'tl-published-label', `release_published 事件显示独立标签「发布留痕」（非通用「范围变更」），实得标签集: ${JSON.stringify(evtLabels)}`);
            await shotOnFail(page, evtLabels.some(t => t.includes('加入上线单')), 'tl-add-label', 'release_add 事件显示独立标签「加入上线单」（[C7] 原「加入批次」随术语统一改名，非通用「范围变更」）');

            const detailsInfo = await page.$$eval('.si-tl-item details', els => els.map(d => ({ open: d.open, summary: d.querySelector('summary') ? d.querySelector('summary').textContent : '' })));
            await shotOnFail(page, detailsInfo.length > 0, 'tl-details-present', `release_published 行含 <details> 折叠元素（找到 ${detailsInfo.length} 个）`);
            await shotOnFail(page, detailsInfo.length > 0 && detailsInfo.every(d => d.open === false), 'tl-details-closed-default', 'release_published 的 <details> 默认收起（未展开）');
            await shotOnFail(page, detailsInfo.length > 0 && /新功能.*C2b2冒烟测试单T2.*\d+\s*条\s*commit/.test(detailsInfo[0].summary), 'tl-details-summary-format',
                `<summary> 摘要格式正确（类型·标题·commit数），实得："${detailsInfo[0] && detailsInfo[0].summary}"`);

            // 过滤开关：勾选后 release-scope 行应隐藏
            const releaseScopeCountBefore = await page.locator('.si-tl-release-scope').count();
            await page.check('label:has-text("隐藏上线单调整记录") input[type="checkbox"]');
            await page.waitForTimeout(200);
            const visibleAfterHide = await page.$$eval('.si-tl-release-scope', els => els.filter(e => getComputedStyle(e).display !== 'none').length);
            await shotOnFail(page, releaseScopeCountBefore > 0 && visibleAfterHide === 0, 'tl-filter-hides-rows', `勾选过滤开关后 ${releaseScopeCountBefore} 条上线单调整记录全部隐藏（实际仍可见 ${visibleAfterHide} 条）`);

            await shotOnFail(page, page._consoleErrors.length === 0, 'tl-console-clean', `timeline 页面全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();
        }

        // ═══════════════════════════════════════════════════════════════
        // 排班维护：区间批量设置全链路
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── 排班维护：区间批量设置（liaison 示例对接人视角） ──');
            const page = await loginPage(browser, liaisonTok);
            await page.goto(`${BASE_URL}/Sys_Iteration.html`);
            await page.waitForLoadState('networkidle');
            await page.click('button:has-text("值班排班")');
            await page.waitForTimeout(400);

            await shotOnFail(page, (await page.locator('#siDutyRosterBody button:has-text("批量设置")').count()) > 0, 'duty-batch-btn-present', '排班维护面板出现「批量设置」按钮（对接人写权）');

            await page.fill('#siDutyBatchFrom', '2032-03-01');
            await page.fill('#siDutyBatchTo', '2032-03-03');
            await page.waitForTimeout(300);   // 等候选人下拉 siPopulateDutyUserSelects 异步填充完成
            await page.selectOption('#siDutyBatchUser', String(EXECUTOR_ID));
            await page.fill('#siDutyBatchNote', 'C2b2冒烟-批量设置');
            await page.click('button:has-text("批量设置")');   // confirm() 由 loginPage 内 dialog 监听自动接受
            await page.waitForTimeout(600);

            const toast5 = await lastToastText(page);
            await shotOnFail(page, toast5.includes('批量设置成功') && toast5.includes('3'), 'duty-batch-toast', `批量设置成功 toast 含天数 3（实得：${toast5}）`);

            // 查询区间验证表格 3 行 + 值班人正确（重新走查询以确保覆盖当前视图区间；批量设置提交后
            // siSubmitDutyRosterBatch 内部已用 siLoadDutyRoster 重渲染过一次 #siDutyRosterBody，
            // #siDutyFrom/#siDutyTo/查询按钮均是全新 DOM 节点，locator 需在重渲染后再定位一次）。
            const fromInput = page.locator('#siDutyRosterBody #siDutyFrom');
            const toInput = page.locator('#siDutyRosterBody #siDutyTo');
            await fromInput.fill('2032-03-01');
            await toInput.fill('2032-03-03');
            await shotOnFail(page, (await fromInput.inputValue()) === '2032-03-01' && (await toInput.inputValue()) === '2032-03-03', 'duty-query-fields-filled',
                `查询区间字段成功填入（实得 from=${await fromInput.inputValue()} to=${await toInput.inputValue()}）`);
            await page.locator('#siDutyRosterBody button:has-text("查询")').click();
            await page.waitForTimeout(500);
            // 区间合并展示（2026-07-30 用户提出）：连续同人 3 天合并为一段区间行（纯展示层·数据仍逐日）——
            // 断言从"恰 3 行"改为"1 段区间行 + 默认收起 + 展开后 3 条逐日子行（各带移除按钮）"。
            const mergedRows = await page.$$eval('#siDutyRosterBody .u-corr-table tbody tr:not([class^="si-duty-sub"])', trs => trs.map(tr => tr.textContent));
            const merged = mergedRows.filter(t => t.includes('示例开发A'));
            await shotOnFail(page, merged.length === 1 && merged[0].includes('2032-03-01 ~ 2032-03-03') && merged[0].includes('3 天'),
                'duty-batch-merged-row',
                `批量设置区间查询回显合并为 1 段区间行（2032-03-01 ~ 2032-03-03·示例开发A·3 天）（实得 ${merged.length} 段；样例: ${JSON.stringify(mergedRows.slice(0, 3))}）`);
            const subHiddenCount = await page.$$eval('#siDutyRosterBody tr.si-duty-sub-0', trs => trs.filter(tr => tr.style.display === 'none').length);
            await shotOnFail(page, subHiddenCount === 3, 'duty-batch-sub-hidden', `逐日子行默认收起（隐藏 ${subHiddenCount}/3）`);
            await page.locator('#siDutyRosterBody a:has-text("2032-03-01")').click();
            await page.waitForTimeout(200);
            const subVisible = await page.$$eval('#siDutyRosterBody tr.si-duty-sub-0', trs => trs.filter(tr => tr.style.display !== 'none').length);
            const subRemoveBtns = await page.locator('#siDutyRosterBody tr.si-duty-sub-0 button:has-text("移除")').count();
            await shotOnFail(page, subVisible === 3 && subRemoveBtns === 3, 'duty-batch-sub-expand',
                `点击区间行展开后 3 条逐日子行可见且各带「移除」按钮（可见 ${subVisible}/3·按钮 ${subRemoveBtns}/3）`);

            await shotOnFail(page, page._consoleErrors.length === 0, 'duty-console-clean', `排班维护面板全程无 JS 报错（${page._consoleErrors.length} 个${page._consoleErrors.length ? ': ' + page._consoleErrors.slice(0, 2).join(' | ') : ''}）`);
            await page.close();

            // 记录清理用日期区间（清理阶段按日期段删，不逐行查 id）
            dutyCleanupIds.push('2032-03-01', '2032-03-02', '2032-03-03');
        }

    } finally {
        await browser.close();
        // ── 清理测试夹具（无论通过与否都执行，不留残留数据）──
        try {
            await dbRun(`DELETE FROM sys_release_duty_roster WHERE duty_date BETWEEN '2032-03-01' AND '2032-03-03'`);
            await dbRun(`DELETE FROM sys_issue_timeline WHERE ref_id IN (?,?,?) OR issue_id IN (?,?,?,?)`, [relT1, relT2, relT3, issue1, issue2, issue3, issue4]);
            await dbRun(`DELETE FROM sys_issue_release_commit_snapshots WHERE release_id IN (?,?,?)`, [relT1, relT2, relT3]);
            await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id IN (?,?,?,?)`, [issue1, issue2, issue3, issue4]);
            await dbRun(`DELETE FROM sys_issues WHERE id IN (?,?,?,?)`, [issue1, issue2, issue3, issue4]);
            await dbRun(`DELETE FROM sys_releases WHERE id IN (?,?,?)`, [relT1, relT2, relT3]);
            console.log('\n  🧹 测试夹具已清理（issue1/2/3/4、relT1/2/3、排班 2032-03-01~03）');
        } catch (cleanErr) {
            console.error('  ⚠️ 清理夹具时出错（需人工核查残留）:', cleanErr.message);
        }
        db.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (failShots.length) console.log('  失败截图：\n    ' + failShots.join('\n    '));
    console.log(fail === 0 ? '  🎉 C2b 第2批 Playwright 冒烟全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('实测脚本异常:', e && e.stack || e); process.exit(1); });
