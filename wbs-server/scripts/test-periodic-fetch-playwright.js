/**
 * 周期取数推送 集成点3（⑤ 前端页）Playwright 视觉冒烟测试
 *
 * 用法：node scripts/test-periodic-fetch-playwright.js
 * [#106 S4d-3] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再依赖写死的 PORT 3200 / localhost / 业务库 task_pool.db / .env。
 *   造数：页面建 1 个周期任务（PW_周期取数测试_<时间戳>，唯一，只写 periodic_tasks 元数据表）；收尾直连实例库删 runs / pushes / tasks 并回查任务行确已不在，
 *   失败再试一轮（共 2 轮，间隔 200ms），遗留计失败（原来每步回调忽略错误、永远 resolve）。
 *   固定值：用户 id 1 admin / 2 viewer（快照库里须存在且角色不变）；快照库须至少有 1 个 db_connections（建任务表单下拉依赖，首跑核对）。
 *
 * 范围（任务书 §5 集成点3 verify 要求：视觉冒烟，非 ⑥ 真样本 e2e）：
 *   - 页面渲染 / admin navbar 入口可见（profile 下拉，见 app.js updateUserUI 新增项）/ 0 console error
 *   - 关键交互可达：建任务表单打开+提交（只写本地 periodic_tasks 元数据表，不碰业务库）/ run 列表 tab /
 *     推送核对 tab（空态渲染）
 *   - 非 admin 访问 → 重定向（前端纵深防御，后端 requireAdmin 是真正的权限闸）
 *
 * ⚠️ 刻意不做（红线 + 任务书要求）：
 *   - 不点击"跑本月"（会真连业务库 source 连接，属 ⑥ 真样本实测，主线收，worktree 不硬连真业务库）
 *   - 不点击"反查核对"/"确认发送"（会真调钉钉 API，本地 db 副本含生产系统真实凭证，避免任何真实外部副作用）
 *   本测试只验证这些按钮/面板"可达可见"，不触发其真实副作用分支。
 */
'use strict';

const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-3] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-3] ready() 之后赋值：testEnv.env().dbPath（实例库）

const ADMIN_ID = 1;
const NON_ADMIN_ID = 2; // role='viewer'（本地 db 副本实测存在，用于非 admin 重定向断言）

// [#106 S4d-3] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function signAs(userId) {
    return testEnv.signToken(userId);
}

// [#106 S4d-3] 打开实例库：只读写已存在的实例库（OPEN_READWRITE，不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库），带打开回调转 Promise。
//   与 _test-fixture.js 的 openInstanceDb 同源，S4c 提交后可改用夹具导出
function openInstanceDb(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
    });
}
// 三个小助手：失败一律 reject（原来出错 resolve(undefined) / 回调忽略错误），close 等回调落定，关库错误不丢（语句错误优先）
async function dbGetRow(sql, params) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => { db.close((ce) => { const e = err || ce; e ? reject(e) : resolve(row); }); });
    });
}
async function dbRunStmt(sql, params) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.run(sql, params, (err) => { db.close((ce) => { const e = err || ce; e ? reject(e) : resolve(); }); });
    });
}

/**
 * 删测试任务（先删子表：runs/pushes 无 FK CASCADE，本项目 FK 未启用，手动清干净；测试只应产生 0 run/push，这两步是防御性兜底）。
 * [#106 S4d-3] 每一步失败都 reject；删完回查任务行确已不在；有失败再试一轮（共 2 轮，间隔 200ms）；返回 null = 已清，否则返回失败说明。
 * 原来每个 db.run 的回调都忽略错误、最后永远 resolve，清理失败时脚本照样退出 0
 */
async function cleanupTestTask(taskName) {
    let lastErr = null;
    for (let round = 0; round < 2; round++) {
        if (round > 0) await new Promise((r) => setTimeout(r, 200));
        try {
            const row = await dbGetRow('SELECT id FROM periodic_tasks WHERE task_name = ?', [taskName]);
            if (!row) return null;
            await dbRunStmt('DELETE FROM periodic_task_pushes WHERE run_id IN (SELECT id FROM periodic_task_runs WHERE task_id = ?)', [row.id]);
            await dbRunStmt('DELETE FROM periodic_task_runs WHERE task_id = ?', [row.id]);
            await dbRunStmt('DELETE FROM periodic_tasks WHERE id = ?', [row.id]);
            const left = await dbGetRow('SELECT id FROM periodic_tasks WHERE id = ?', [row.id]);
            if (!left) return null;
            lastErr = '删除后任务行仍在';
        } catch (e) { lastErr = (e && e.message) || String(e); }
    }
    return lastErr;
}

// [#106 S4d-3] 查询失败 reject（原来出错 resolve(undefined)，与「没查到」分不开）
async function getTaskByName(taskName) {
    return dbGetRow('SELECT * FROM periodic_tasks WHERE task_name = ?', [taskName]);
}

let assertCount = 0;
function expect(condition, message) {
    assertCount++;
    if (!condition) throw new Error(`❌ Assert #${assertCount}: ${message}`);
    console.log(`  ✓ ${message}`);
}

(async () => {
    await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
    BASE_URL = testEnv.env().baseUrl;
    DB_PATH = testEnv.env().dbPath;
    console.log('=== 周期取数推送 集成点3（⑤前端页）Playwright 视觉冒烟测试 ===\n');

    const testTaskName = `PW_周期取数测试_${Date.now()}`;
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];
    let exitCode = 0;

    try {
        // ============================================================
        // 步骤 0：非 admin 访问 → 前端重定向（纵深防御，后端 requireAdmin 是真正闸门）
        // ============================================================
        console.log('0. 非 admin（viewer）访问 → 应被重定向...');
        const viewerToken = await signAs(NON_ADMIN_ID);
        const ctxViewer = await browser.newContext();
        const pageViewer = await ctxViewer.newPage();
        // alert() 会阻塞页面，需先挂 dialog handler 自动 accept，否则 waitForURL 卡死
        pageViewer.on('dialog', (d) => d.accept());
        await pageViewer.goto(`${BASE_URL}/login.html`);
        await pageViewer.evaluate((token) => localStorage.setItem('token', token), viewerToken);
        await pageViewer.goto(`${BASE_URL}/Periodic_Fetch.html`);
        await pageViewer.waitForURL(/Task_Pool\.html/, { timeout: 5000 });
        expect(pageViewer.url().includes('Task_Pool.html'), '非 admin 访问 Periodic_Fetch.html → 前端重定向到 Task_Pool.html（需要管理员权限）');
        await ctxViewer.close();

        // ============================================================
        // 步骤 1：JWT 注入登录 admin + 打开页面
        // ============================================================
        console.log('\n1. JWT 注入登录 admin，打开周期取数推送页...');
        const adminToken = await signAs(ADMIN_ID);
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('console', (msg) => {
            if (msg.type() === 'error') { consoleErrors.push(msg.text()); console.log(`  [browser-err] ${msg.text()}`); }
        });
        page.on('pageerror', (err) => { consoleErrors.push(err.message); console.log(`  [page-error] ${err.message}`); });

        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate((token) => localStorage.setItem('token', token), adminToken);
        await page.goto(`${BASE_URL}/Periodic_Fetch.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        expect(await page.isVisible('h1:has-text("周期取数推送")'), '页面标题「周期取数推送」渲染');
        expect(await page.isVisible('.navbar'), '导航栏渲染');

        // ============================================================
        // 步骤 2：admin navbar 入口可见（profile 下拉里的「周期取数推送」链接，app.js updateUserUI 新增）
        // ============================================================
        console.log('\n2. 验证 admin profile 下拉入口可见...');
        await page.click('.user-profile');
        await page.waitForTimeout(200);
        const dropdownLinkVisible = await page.isVisible('.dropdown-content a[href="/Periodic_Fetch.html"]');
        expect(dropdownLinkVisible, 'admin profile 下拉菜单含「📅 周期取数推送」入口（全站可发现，未改动任何既有页面导航栏）');
        await page.keyboard.press('Escape');

        // ============================================================
        // 步骤 3：打开「登记新任务」表单 + 提交（只写本地 periodic_tasks 元数据表）
        // ============================================================
        console.log('\n3. 打开登记新任务表单...');
        await page.click('button:has-text("＋ 登记新任务")');
        await page.waitForSelector('#pfNewCard', { state: 'visible', timeout: 3000 });
        expect(await page.isVisible('#pfNewName'), '登记新任务表单已展开（任务名称输入框可见）');

        await page.fill('#pfNewName', testTaskName);
        await page.fill('#pfNewDesc', 'Playwright 视觉冒烟测试任务');

        await page.waitForFunction(() => {
            const sel = document.querySelector('#pfNewConn');
            return sel && sel.options.length > 1;
        }, { timeout: 3000 });
        await page.selectOption('#pfNewConn', { index: 1 });

        // 占位符 chip 插入验证（点击后应把 '{{MONTH_START}}' 插入 textarea）
        await page.click('#pfNewCard .pf-chip:has-text("MONTH_START")');
        const sqlAfterChip = await page.inputValue('#pfNewSql');
        expect(sqlAfterChip.includes("'{{MONTH_START}}'"), '点击占位符 chip 后 textarea 插入 \'{{MONTH_START}}\'');

        await page.fill('#pfNewSql', `SELECT 1 AS a WHERE '{{MONTH_START}}' <= '{{MONTH_END}}'`);
        await page.click('#pfNewSaveBtn');
        await page.waitForTimeout(1200);

        const created = await getTaskByName(testTaskName);
        expect(created !== undefined && created !== null, `任务已创建（task_name=${testTaskName}）`);
        expect(created.status === 'active', '新建任务默认 active 状态');
        expect(created.template_version === 1, '新建任务 template_version=1');

        // ============================================================
        // 步骤 4：列表中出现该任务
        // ============================================================
        console.log('\n4. 验证任务列表出现新任务...');
        await page.waitForFunction((name) => document.body.textContent.includes(name), testTaskName, { timeout: 3000 });
        expect(true, '任务列表渲染出新建的任务卡');

        // ============================================================
        // 步骤 5：展开任务卡 → 验证三个子 tab 可达
        // ============================================================
        console.log('\n5. 展开任务卡，验证子 tab...');
        await page.click(`.pf-name:has-text("${testTaskName}")`);
        await page.waitForTimeout(500);
        expect(await page.isVisible('.pf-subtabs'), '任务卡展开，子 tab 区渲染');
        expect(await page.isVisible('.pf-subtab:has-text("脚本模板")'), '子 tab「脚本模板」可见');
        expect(await page.isVisible('.pf-subtab:has-text("跑数 · 历史")'), '子 tab「跑数 · 历史」可见');
        expect(await page.isVisible('.pf-subtab:has-text("推送")'), '子 tab「推送」可见');

        // 脚本模板 tab 默认激活，应看到 SQL textarea 含刚保存的内容。
        // ⚠️ 不能用泛化选择器 `.pf-sql`——「登记新任务」卡的 #pfNewSql 也带这个 class，创建后已
        //   display:none 隐藏但仍在 DOM 里，`.first()` 会先命中它导致误判；改用编辑区专属 id 前缀。
        const editSqlVisible = await page.locator('textarea[id^="pfEditSql_"]').first().isVisible();
        expect(editSqlVisible, '脚本模板 tab：编辑区 textarea 可见');

        // ============================================================
        // 步骤 6：切到「跑数 · 历史」tab —— 验证渲染但不点击"跑本月"（会真连业务库，属⑥主线收）
        // ============================================================
        console.log('\n6. 切到「跑数 · 历史」tab（仅验证渲染，不触发真实跑数）...');
        await page.click('.pf-subtab:has-text("跑数 · 历史")');
        await page.waitForTimeout(600);
        expect(await page.isVisible('button:has-text("▶ 跑本月")'), '「跑本月」按钮可见（不点击——会真连业务库，属⑥真样本实测主线）');
        expect(await page.isVisible('text=暂无执行历史'), '新任务尚无 run，空态文案渲染');

        // ============================================================
        // 步骤 7：切到「推送」tab —— 验证空态渲染（无可推送 run 时的提示），不触发真实钉钉调用
        // ============================================================
        console.log('\n7. 切到「推送」tab（仅验证空态渲染，不触发真实钉钉调用）...');
        await page.click('.pf-subtab:has-text("推送")');
        await page.waitForTimeout(600);
        expect(await page.isVisible('text=暂无可推送的 run'), '推送 tab：无可推送 run 时空态提示渲染（未跑过数）');

        // ============================================================
        // 步骤 8：禁用任务（验证禁用交互可达）
        // ============================================================
        console.log('\n8. 切回脚本模板 tab，验证禁用按钮...');
        await page.click('.pf-subtab:has-text("脚本模板")');
        await page.waitForTimeout(400);
        expect(await page.isVisible('button:has-text("禁用任务")'), '「禁用任务」按钮可见（active 任务）');
        page.once('dialog', (d) => d.accept());
        await page.click('button:has-text("禁用任务")');
        await page.waitForTimeout(1000);
        const afterDisable = await getTaskByName(testTaskName);
        expect(afterDisable.status === 'disabled', '点击禁用后任务状态变为 disabled');

        // ============================================================
        // 步骤 9：0 console error
        // ============================================================
        console.log('\n9. 验证全程 0 console error...');
        expect(consoleErrors.length === 0, `全程 0 console error（实际 ${consoleErrors.length} 条：${consoleErrors.join(' | ')}）`);

        await context.close();

        console.log(`\n=== ${assertCount} 个断言全部 PASS ===`);
    } catch (e) {
        console.error('\n❌ 测试失败:', e.message);
        console.error(e.stack);
        exitCode = 1;
    } finally {
        // ⚠️ 不在 catch 里直接 process.exit()——那会跳过本 finally 块（process.exit 立即终止进程，
        //   不等待其后的 await），导致失败时清理不到位、留脏测试数据（本脚本调试期真实踩过：首次跑
        //   在步骤5断言失败，catch 里 process.exit(1) 直接退出，finally 的 cleanupTestTask 从未执行，
        //   task_pool.db 里留了一条残留任务）。改为 catch 只记录退出码，finally 做清理，最后统一 exit。
        // [#106 S4d-3] 两个收尾动作各自 try / catch：浏览器关闭失败不跳过任务清理；任一失败都计失败（退出码 1）
        try { await browser.close(); } catch (e) { console.error(`❌ 浏览器关闭失败：${e && e.message}`); exitCode = 1; }
        const cleanupErr = await cleanupTestTask(testTaskName);
        if (cleanupErr) { console.error(`❌ 清理测试任务「${testTaskName}」失败（已重试 1 轮）：${cleanupErr}`); exitCode = 1; }
        else console.log(`\n清理测试任务「${testTaskName}」`);
    }
    try { await testEnv.teardown(); } catch (e) { console.error(`❌ teardown（收掉自起实例）失败：${e && e.message}`); exitCode = 1; }
    testEnv.finish(exitCode);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('测试异常:', e && e.stack || e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
