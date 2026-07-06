/**
 * 模型中心列表页「点击表头排序」Playwright 视觉冒烟测试
 *
 * 用法：PORT=3300 node scripts/test-model-center-sort-playwright.js（先起本地 server，BASE_URL 指向它）
 *
 * 范围：
 *   - 移植自 Data_Collab.html v1.72.1 客户端排序范式，验证 Model_Center.html 新加的可排序表头
 *   - 断言：① 点表头行顺序按该字段升/降变化 ② sort-icon + active 高亮同步
 *          ③ 第三次点同列恢复默认序（且与原始顺序完全一致，非巧合重排）
 *          ④ 与搜索筛选叠加不冲突（筛选后仍保持排序）
 *          ⑤ 排序切换后分页重置到第 1 页 ⑥ 0 console error
 *
 * ⚠️ 校验用「行 data-id 顺序 + allModelsData 原始字段值」而非渲染文本——
 *    渲染的「表名」列会在伴生表/custom 模式前插入「●」视觉标记字符，直接比较渲染文本
 *    会被这个前缀字符污染 locale 排序断言（首次实测踩坑，已改用原始字段值校验）。
 * ⚠️ 只读点击，不产生任何写操作（不点击注册/编辑/删除/ETL/DDL/验收等按钮）。
 */
'use strict';

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || '3300';
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR
    || 'C:\\Users\\FY\\AppData\\Local\\Temp\\claude\\E-------------\\f7af31f3-83b1-409f-9af5-66bd66218363\\scratchpad';

const ADMIN_ID = 1;

async function signAs(userId) {
    const user = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get('SELECT id, username, display_name, role FROM users WHERE id=?', [userId],
            (err, row) => { db.close(); err ? reject(err) : resolve(row); });
    });
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET,
        { expiresIn: '1h' }
    );
}

let assertCount = 0;
function expect(condition, message) {
    assertCount++;
    if (!condition) throw new Error(`Assert #${assertCount} FAILED: ${message}`);
    console.log(`  [OK] ${message}`);
}

// 中文 locale 字符串比较（与前端 sortByField 的 string 分支保持一致）
function isMonotonicString(arr, mult) {
    for (let i = 1; i < arr.length; i++) {
        const cmp = String(arr[i - 1]).localeCompare(String(arr[i]), 'zh-Hans-CN') * mult;
        if (cmp > 0) return false;
    }
    return true;
}

function isMonotonicDate(arr, mult) {
    for (let i = 1; i < arr.length; i++) {
        const ta = new Date(String(arr[i - 1]).replace(' ', 'T')).getTime();
        const tb = new Date(String(arr[i]).replace(' ', 'T')).getTime();
        if ((ta - tb) * mult > 0) return false;
    }
    return true;
}

(async () => {
    console.log('=== 模型中心列表页 点击表头排序 Playwright 视觉冒烟测试 ===\n');

    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];
    let exitCode = 0;

    try {
        const adminToken = await signAs(ADMIN_ID);
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('console', (msg) => {
            if (msg.type() === 'error') { consoleErrors.push(msg.text()); console.log(`  [browser-err] ${msg.text()}`); }
        });
        page.on('pageerror', (err) => { consoleErrors.push(err.message); console.log(`  [page-error] ${err.message}`); });

        console.log('1. JWT 注入登录 admin，打开模型中心页...');
        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate((token) => localStorage.setItem('token', token), adminToken);
        await page.goto(`${BASE_URL}/Model_Center.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForSelector('#modelListBody tr', { timeout: 10000 });
        await page.waitForTimeout(300);

        expect(await page.isVisible('#modelListTable'), '模型列表表格渲染');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-01-initial.png') });

        // 当前渲染行的 data-id 顺序（反映 renderModelsPage 实际渲染顺序）
        const getRowIdOrder = async () => page.$$eval(
            '#modelListBody tr[data-id]',
            (trs) => trs.map((tr) => tr.getAttribute('data-id'))
        );
        // allModelsData 原始字段快照（id -> model），用于按真实字段值校验排序（避开渲染文本里的「●」等视觉前缀污染）
        const getModelMap = async () => page.evaluate(
            () => Object.fromEntries(allModelsData.map((m) => [String(m.id), m]))
        );

        const originalIdOrder = await getRowIdOrder();
        expect(originalIdOrder.length > 0, `默认渲染出至少 1 行数据（实际 ${originalIdOrder.length} 行）`);
        let modelMap = await getModelMap();
        console.log(`  初始渲染 ${originalIdOrder.length} 行，总数据 ${Object.keys(modelMap).length} 条`);

        // ============================================================
        // 步骤 2：点「表名」表头 → 第1次 desc
        // ============================================================
        console.log('\n2. 点击「表名」表头（第1次，应为 desc）...');
        await page.click('#modelListTable th.sortable[data-sort-by="table_name"]');
        await page.waitForTimeout(200);

        const activeAfterFirstClick = await page.$eval(
            '#modelListTable th.sortable[data-sort-by="table_name"]',
            (th) => th.classList.contains('active')
        );
        const iconAfterFirstClick = await page.$eval(
            '#modelListTable th.sortable[data-sort-by="table_name"] .sort-icon',
            (el) => el.textContent
        );
        expect(activeAfterFirstClick, '第1次点击后「表名」表头获得 active 高亮');
        expect(iconAfterFirstClick === '↓', `第1次点击后图标为 ↓（实际:${iconAfterFirstClick}）`);

        const idOrderDesc = await getRowIdOrder();
        const rawNamesDesc = idOrderDesc.map((id) => modelMap[id].table_name);
        expect(isMonotonicString(rawNamesDesc, -1), '第1次点击后「表名」原始字段值按降序排列');
        expect(JSON.stringify(idOrderDesc) !== JSON.stringify(originalIdOrder), '排序后行顺序与初始顺序不同（确认排序确实生效）');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-02-desc.png') });

        // ============================================================
        // 步骤 3：再点一次「表名」 → asc
        // ============================================================
        console.log('\n3. 再次点击「表名」表头（第2次，应为 asc）...');
        await page.click('#modelListTable th.sortable[data-sort-by="table_name"]');
        await page.waitForTimeout(200);

        const iconAfterSecondClick = await page.$eval(
            '#modelListTable th.sortable[data-sort-by="table_name"] .sort-icon',
            (el) => el.textContent
        );
        expect(iconAfterSecondClick === '↑', `第2次点击后图标为 ↑（实际:${iconAfterSecondClick}）`);

        const idOrderAsc = await getRowIdOrder();
        const rawNamesAsc = idOrderAsc.map((id) => modelMap[id].table_name);
        expect(isMonotonicString(rawNamesAsc, 1), '第2次点击后「表名」原始字段值按升序排列');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-03-asc.png') });

        // ============================================================
        // 步骤 4：第三次点击「表名」 → 清排序，恢复默认原始顺序
        // ============================================================
        console.log('\n4. 第三次点击「表名」表头（应清排序，恢复默认顺序）...');
        await page.click('#modelListTable th.sortable[data-sort-by="table_name"]');
        await page.waitForTimeout(200);

        const activeAfterThirdClick = await page.$eval(
            '#modelListTable th.sortable[data-sort-by="table_name"]',
            (th) => th.classList.contains('active')
        );
        const iconAfterThirdClick = await page.$eval(
            '#modelListTable th.sortable[data-sort-by="table_name"] .sort-icon',
            (el) => el.textContent
        );
        expect(!activeAfterThirdClick, '第3次点击后「表名」表头失去 active 高亮');
        expect(iconAfterThirdClick === '⇅', `第3次点击后图标恢复为 ⇅（实际:${iconAfterThirdClick}）`);

        const idOrderReset = await getRowIdOrder();
        expect(JSON.stringify(idOrderReset) === JSON.stringify(originalIdOrder), '第3次点击后行顺序与初始默认顺序完全一致（非巧合重排）');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-04-reset.png') });

        // ============================================================
        // 步骤 5：状态列（statusOrder 自定义优先级）+ 最后更新（date 类型）排序
        // ============================================================
        console.log('\n5. 点击「状态」表头（statusOrder 自定义优先级类型）...');
        await page.click('#modelListTable th.sortable[data-sort-by="status"]');
        await page.waitForTimeout(200);
        const STATUS_SORT_ORDER = { CREATED: 0, DEVELOPING: 1, REVIEWING: 2, ONLINE: 3, OFFLINE: 4 };
        const idOrderStatusDesc = await getRowIdOrder();
        const statusRankDesc = idOrderStatusDesc.map((id) => {
            const s = modelMap[id].status;
            return STATUS_SORT_ORDER[s] !== undefined ? STATUS_SORT_ORDER[s] : 99;
        });
        let statusMonotonic = true;
        for (let i = 1; i < statusRankDesc.length; i++) {
            if (statusRankDesc[i - 1] - statusRankDesc[i] < 0) { statusMonotonic = false; break; }
        }
        expect(statusMonotonic, '「状态」列第1次点击后按业务优先级降序排列（statusOrder 类型分派生效）');
        // 清排序，回默认，避免影响后续步骤
        await page.click('#modelListTable th.sortable[data-sort-by="status"]');
        await page.click('#modelListTable th.sortable[data-sort-by="status"]');

        console.log('\n6. 点击「最后更新」表头（date 类型），验证日期列排序...');
        await page.click('#modelListTable th.sortable[data-sort-by="updated_at"]');
        await page.waitForTimeout(200);
        const idOrderUpdatedDesc = await getRowIdOrder();
        const rawUpdatedDesc = idOrderUpdatedDesc.map((id) => modelMap[id].updated_at);
        expect(isMonotonicDate(rawUpdatedDesc, -1), '「最后更新」列第1次点击后按日期降序排列（date 类型分派生效）');

        // ============================================================
        // 步骤 7：与搜索筛选叠加 —— 保持当前排序（updated_at desc）下搜索
        // ============================================================
        console.log('\n7. 输入搜索关键字「dwd」并回车，验证排序与筛选叠加...');
        await page.fill('#searchKeyword', 'dwd');
        await page.press('#searchKeyword', 'Enter');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);

        modelMap = await getModelMap(); // allModelsData 已被 loadModels() 重新拉取替换，需要刷新快照
        const idOrderFiltered = await getRowIdOrder();
        expect(idOrderFiltered.length > 0, '搜索「dwd」后仍有匹配数据');
        const filteredNamesRaw = idOrderFiltered.map((id) => modelMap[id].table_name.toLowerCase());
        const allMatchKeyword = filteredNamesRaw.every((n) => n.includes('dwd'));
        expect(allMatchKeyword, '筛选结果表名均包含关键字「dwd」（筛选生效）');
        const filteredUpdatedRaw = idOrderFiltered.map((id) => modelMap[id].updated_at);
        expect(isMonotonicDate(filteredUpdatedRaw, -1), '筛选后仍保持「最后更新」降序（排序未被搜索重置，叠加生效）');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-05-filter-plus-sort.png') });

        // 清空搜索，恢复全量，避免影响后续步骤
        await page.fill('#searchKeyword', '');
        await page.press('#searchKeyword', 'Enter');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);

        // ============================================================
        // 步骤 8：分页交互 —— 先跳到第 2 页，再点排序表头，验证重置回第 1 页
        // ============================================================
        console.log('\n8. 验证排序切换后分页重置到第 1 页...');
        const paginationInfoText = await page.textContent('#paginationInfo');
        console.log(`  分页信息: ${paginationInfoText}`);

        const scaffoldOk = await page.evaluate(() => typeof goToPage === 'function' && typeof currentPage !== 'undefined');
        expect(scaffoldOk, 'goToPage / currentPage 全局可访问（验证分页脚手架未被破坏）');

        await page.evaluate(() => { if (typeof goToPage === 'function') goToPage(2); });
        await page.waitForTimeout(200);
        const pageAfterGoTo2 = await page.evaluate(() => currentPage);
        console.log(`  goToPage(2) 后 currentPage = ${pageAfterGoTo2}`);

        await page.click('#modelListTable th.sortable[data-sort-by="tech_owner"]');
        await page.waitForTimeout(200);
        const pageAfterSortClick = await page.evaluate(() => currentPage);
        expect(pageAfterSortClick === 1, `点击排序表头后 currentPage 重置为 1（实际:${pageAfterSortClick}）`);

        // 清排序，回到原始态收尾
        await page.click('#modelListTable th.sortable[data-sort-by="tech_owner"]'); // asc
        await page.click('#modelListTable th.sortable[data-sort-by="tech_owner"]'); // reset
        await page.click('#modelListTable th.sortable[data-sort-by="updated_at"]'); // updated_at 由 desc -> asc
        await page.click('#modelListTable th.sortable[data-sort-by="updated_at"]'); // -> reset

        // ============================================================
        // 收尾：console error 断言
        // ============================================================
        console.log('\n9. 校验全程 0 console error...');
        expect(consoleErrors.length === 0, `全程 0 console error（实际:${consoleErrors.length}）`);

        console.log(`\n=== 全部 ${assertCount} 项断言通过 ===`);
    } catch (err) {
        console.error('\n测试失败:', err.message);
        exitCode = 1;
    } finally {
        await browser.close();
        process.exit(exitCode);
    }
})();
