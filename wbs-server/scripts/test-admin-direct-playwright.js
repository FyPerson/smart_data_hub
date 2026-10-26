/**
 * v1.72.3 admin 直派模式 Playwright UI 测试
 *
 * 用法：node scripts/test-admin-direct-playwright.js
 * 前置：无服务前置（[#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例，也可由 TEST_* 变量组指向已起好的隔离实例；不再依赖 localhost:3000 / 业务库 / .env）
 *   造数：经页面建 1 张协作单（OA_PW_<时间戳>）；收尾直连实例库 DELETE（FK 级联）并回查，每次失败再试一轮（共 2 轮，间隔 200ms），遗留计失败。
 *   原来 process.exit(0/1) 写在 try 里，finally 的清理从不执行（协作单恒残留）——现改为记录退出码、finally 之后统一 finish。
 *   固定值：用户 id 1 admin / 8 导出人 / 7 publisher；db_connections id=2（快照库里须存在，首跑核对）。
 *   已知既有红：当前首个失败点更早：:161 等待 #newModal.show 超时（页面 2026-07-10 前端统一后改为 .open，daf053ec）；越过后才会遇到 OA 规范化导致的 TypeError（服务端规范化 OA 号，OA_PW_<ts> 落库为 OA-_PW_<ts>，getCollabByOA 按原写法查不到，2026-06-28 起，ddbb88e0），主体在 created.assign_mode 处抛出；清理已按两种写法兜底。
 *
 * 测试链路：
 *   1. JWT 注入登录 admin
 *   2. 打开 Data_Collab.html → 见 admin 直派 checkbox（仅 admin 可见）
 *   3. 创建 admin 直派单（勾选 checkbox + 选数据导出人 + 填表）
 *   4. 列表见 OA-XXX [🎯 admin 直派] tag
 *   5. 进入详情页 → 见「admin 直派单操作」区块 + 改派/切回流转按钮
 *   6. 点改派 → 选新接收人 → 确定 → toast 「已改派给XX」
 *   7. 点切回流转 → 填原因 → 确定 → toast 「已切回流转模式」
 *   8. 详情页刷新到 PENDING_ASSIGN
 *   9. 改派历史 details 展开 → 见 1 条改派记录
 */
'use strict';

const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-2] ready() 之后赋值：testEnv.env().dbPath（实例库）

const ADMIN_ID = 1;
const EXPORTER_ID = 8;
const PUBLISHER_ID = 7;
const TARGET_DB_CONN_ID = 2;

// [#106 S4d-2] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function signAs(userId) {
    return testEnv.signToken(userId);
}

// [#106 S4d-2] 打开实例库：只读写已存在的实例库（OPEN_READWRITE，不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库），带打开回调转 Promise。
//   与 _test-fixture.js 的 openInstanceDb 同源（带打开回调、OPEN_READWRITE、不带 OPEN_CREATE）；本脚本只用 test-env、不引夹具，故保留本地副本
function openInstanceDb(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
    });
}

// [#106 S4d-2] 删协作单（FK 级联清子表）：失败一律 reject（原来 DELETE 的回调忽略错误、永远 resolve）；等 close 回调落定，关库错误不丢（语句错误优先）
async function cleanupTestCollab(id) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.run('PRAGMA foreign_keys = ON', (pe) => {
            if (pe) { db.close(() => reject(pe)); return; }
            db.run('DELETE FROM collab_requests WHERE id = ?', [id], (de) => {
                db.close((ce) => { const err = de || ce; err ? reject(err) : resolve(); });
            });
        });
    });
}

// [#106 S4d-2] 查询失败 reject（原来出错 resolve(undefined)，调用方分不清「没查到」和「查询失败」）
async function getCollabByOA(oa) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM collab_requests WHERE oa_request_no = ?', [oa],
            (err, row) => { db.close((ce) => { const e = err || ce; e ? reject(e) : resolve(row); }); });
    });
}
// [#106 S4d-2 修复批] 与 server.js canonicalizeCollabOa / oaCore 同义（null / undefined → 空核心值；核心值为空 → 返回 ''）：去掉 /^(test-)?oa-?/i 前缀再拼 OA-；只用于清理兜底，不改造数常量与业务断言
function canonicalCollabOa(oa) {
    const core = (oa === null || oa === undefined) ? '' : String(oa).trim().replace(/^(test-)?oa-?/i, '').trim();
    return core ? 'OA-' + core : '';
}
async function findCollabIdsByOA(oa) {
    const db = await openInstanceDb(DB_PATH);
    const canon = canonicalCollabOa(oa);
    const names = canon ? [oa, canon] : [oa];   // 规范化值为空时只按原写法查（避免 IN (?, '')）
    return new Promise((resolve, reject) => {
        db.all(`SELECT id FROM collab_requests WHERE oa_request_no IN (${names.map(() => '?').join(', ')})`, names,
            (err, rows) => { db.close((ce) => { const e = err || ce; e ? reject(e) : resolve(rows || []); }); });
    });
}
async function getCollabIdRow(id) {
    const db = await openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => {
        db.get('SELECT id FROM collab_requests WHERE id = ?', [id],
            (err, row) => { db.close((ce) => { const e = err || ce; e ? reject(e) : resolve(row); }); });
    });
}

let testCollabId = null;
let testOA = null;

/**
 * [#106 S4d-2] 清理造的协作单：先按 testOA 兜底查出「页面提交成功但脚本在登记 id 之前就失败」的单；DELETE 后回查行确已不在；
 * 失败再试一轮（共 2 轮，间隔 200ms）；清掉才把 testCollabId 置空；返回 null = 已清，否则返回失败说明
 */
async function cleanupCollabChecked() {
    let lastErr = null;
    for (let round = 0; round < 2; round++) {
        if (round > 0) await new Promise((r) => setTimeout(r, 200));
        try {
            // [#106 S4d-2 修复批] 按原写法与规范化写法两种 OA 都查，查到几行删几行（服务端建单会把 OA_PW_<ts> 落成 OA-_PW_<ts>，只按原写法查永远查不到、每跑一次漏一张单）
            const ids = new Set();
            if (testCollabId) ids.add(testCollabId);
            if (testOA) { for (const r of await findCollabIdsByOA(testOA)) ids.add(r.id); }
            if (ids.size === 0) return null;
            for (const id of ids) await cleanupTestCollab(id);
            const leftIds = [];
            for (const id of ids) { if (await getCollabIdRow(id)) leftIds.push(id); }
            const leftByOa = testOA ? await findCollabIdsByOA(testOA) : [];   // 删后回查：两种写法都要为空才算清掉
            if (leftIds.length === 0 && leftByOa.length === 0) { console.log(`\n清理测试 fixture #${Array.from(ids).join(',#')}`); testCollabId = null; return null; }
            lastErr = `删除后协作单行仍在（按 id 剩 ${leftIds.length} 行 / 按两种 OA 写法剩 ${leftByOa.length} 行）`;
        } catch (e) { lastErr = (e && e.message) || String(e); }
    }
    return lastErr;
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
    console.log('=== v1.72.3 admin 直派模式 Playwright UI 测试 ===\n');

    const adminToken = await signAs(ADMIN_ID);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    let exitCode = 0;   // [#106 S4d-2] 原 try 里的 process.exit(0/1) 会让 finally 的清理从不执行；改为记录退出码，清理与 teardown 之后统一 finish

    page.on('console', msg => {
        if (msg.type() === 'error') console.log(`  [browser-err] ${msg.text()}`);
    });

    try {
        // ============================================================
        // 步骤 1：JWT 注入 + 跳转 login.html 中继 → Data_Collab.html
        // ============================================================
        console.log('1. JWT 注入登录 admin...');
        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate((token) => {
            localStorage.setItem('token', token);
        }, adminToken);
        await page.goto(`${BASE_URL}/Data_Collab.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(500);

        // ============================================================
        // 步骤 2：打开新建协作单弹窗，验证 admin 直派 checkbox 可见
        // ============================================================
        console.log('\n2. 打开新建协作单弹窗...');
        await page.click('button:has-text("新建协作单")');
        await page.waitForSelector('#newModal.show', { timeout: 3000 });
        await page.waitForTimeout(300);

        const directToggleVisible = await page.isVisible('#f_admin_direct_toggle');
        expect(directToggleVisible, 'admin 直派 toggle checkbox 可见（admin 角色）');

        // ============================================================
        // 步骤 3：勾选 admin 直派 + 填表 + 提交
        // ============================================================
        console.log('\n3. 填表（admin 直派模式）...');
        testOA = `OA_PW_${Date.now()}`;
        await page.fill('#f_oa_no', testOA);
        await page.selectOption('#f_dept', { index: 1 });  // 选第一个非空部门
        await page.fill('#f_requester', 'Playwright 测试业务方');
        await page.fill('#f_desc', 'Playwright admin 直派 UI 测试单');

        // 等待 target_db 下拉填充
        await page.waitForFunction(() => {
            const sel = document.querySelector('#f_target_db');
            return sel && sel.options.length > 1;
        }, { timeout: 3000 });
        await page.selectOption('#f_target_db', String(TARGET_DB_CONN_ID));

        // 勾选 admin 直派
        await page.check('#f_admin_direct_toggle');
        await page.waitForTimeout(300);
        const exporterRowVisible = await page.isVisible('#formRow_adminDirectExporter');
        expect(exporterRowVisible, '勾选后数据导出人下拉显示');

        // 等待 exporter 下拉填充
        await page.waitForFunction(() => {
            const sel = document.querySelector('#f_admin_direct_exporter');
            return sel && sel.options.length > 1;
        }, { timeout: 3000 });
        await page.selectOption('#f_admin_direct_exporter', String(EXPORTER_ID));

        // 提交
        await page.click('#btnSubmit');
        await page.waitForTimeout(1500);

        const created = await getCollabByOA(testOA);
        expect(created !== null, `协作单已创建（OA=${testOA}）`);
        expect(created.assign_mode === 'admin_direct', 'assign_mode = admin_direct');
        expect(created.status === 'EXPORTING', 'status = EXPORTING（跳过 PENDING_ASSIGN）');
        expect(Number(created.exporter_user_id) === EXPORTER_ID, `exporter_user_id = ${EXPORTER_ID}`);
        expect(Number(created.contact_person_id) === 0, 'contact_person_id = 0 占位');
        testCollabId = created.id;

        // ============================================================
        // 步骤 4：列表见 admin 直派 tag
        // ============================================================
        console.log('\n4. 验证列表 admin 直派 tag...');
        await page.waitForTimeout(800);
        // 刷新列表
        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(800);
        const tagVisible = await page.locator('.admin-direct-tag').first().isVisible();
        expect(tagVisible, '列表行显示 [🎯 admin 直派] tag');

        // ============================================================
        // 步骤 5：进入详情页 → 见操作区
        // ============================================================
        console.log('\n5. 打开详情页...');
        // 通过 deep link 打开详情，避免列表行点击 selector 复杂
        await page.evaluate((id) => {
            window.openDetail(id);
        }, testCollabId);
        await page.waitForSelector('.admin-direct-actions', { timeout: 3000 });
        await page.waitForTimeout(300);

        const reassignBtnVisible = await page.locator('.admin-direct-actions button.btn-reassign').isVisible();
        const fallbackBtnVisible = await page.locator('.admin-direct-actions button.btn-fallback').isVisible();
        expect(reassignBtnVisible, '改派接收人按钮可见');
        expect(fallbackBtnVisible, '切回流转模式按钮可见');

        // ============================================================
        // 步骤 6：点改派 → 选 PUBLISHER → 确定
        // ============================================================
        console.log('\n6. 点击改派按钮...');
        await page.click('.admin-direct-actions button.btn-reassign');
        await page.waitForSelector('#reassignModal', { timeout: 3000 });
        await page.waitForTimeout(200);

        await page.selectOption('#reassign_new_exporter', String(PUBLISHER_ID));
        await page.click('#btnConfirmReassign');
        await page.waitForTimeout(1500);

        // 验证 toast 成功（弹窗已关闭即视为成功）
        const reassignModalGone = await page.locator('#reassignModal').count() === 0;
        expect(reassignModalGone, '改派弹窗已关闭（操作成功）');

        const afterReassign = await getCollabByOA(testOA);
        expect(Number(afterReassign.exporter_user_id) === PUBLISHER_ID, `改派后 exporter_user_id = ${PUBLISHER_ID}`);

        // ============================================================
        // 步骤 7：点切回流转 → 填原因 → 确定
        // ============================================================
        console.log('\n7. 点击切回流转按钮...');
        await page.waitForTimeout(800);
        // 重新拿详情页（reassign 后页面已刷新）
        await page.click('.admin-direct-actions button.btn-fallback');
        await page.waitForSelector('#fallbackModal', { timeout: 3000 });
        await page.waitForTimeout(200);

        await page.fill('#fallback_reason_input', 'Playwright 测试切回原因');
        await page.click('#btnConfirmFallback');
        await page.waitForTimeout(1500);

        const fallbackModalGone = await page.locator('#fallbackModal').count() === 0;
        expect(fallbackModalGone, '切回流转弹窗已关闭（操作成功）');

        const afterFallback = await getCollabByOA(testOA);
        expect(afterFallback.status === 'PENDING_ASSIGN', '切回后 status = PENDING_ASSIGN');
        expect(afterFallback.exporter_user_id === null, '切回后 exporter_user_id = NULL');
        expect(afterFallback.assign_mode === 'admin_direct', '切回后 assign_mode 保留 admin_direct');

        // ============================================================
        // 步骤 7.5: codex 32 审 H-1 采纳 — 切回流转后自动打开编辑模式
        // ============================================================
        console.log('\n7.5. 验证 H-1：切回流转后自动打开编辑模式（强引导补 D1）...');
        // 切回 fallback 成功后 confirmAdminDirectFallback 内 setTimeout 300ms 触发 openEditModal
        // 等编辑弹窗自动弹出
        await page.waitForFunction(() => {
            const m = document.getElementById('newModal');
            return m && m.classList.contains('show');
        }, { timeout: 3000 });
        const editModalAutoOpened = await page.locator('#newModal.show').count() > 0;
        expect(editModalAutoOpened, 'H-1：切回流转后自动打开编辑模式（强引导补 D1）');
        // 关闭编辑弹窗，继续后续 admin-direct-actions 区块验证
        await page.click('button[onclick="closeNewModal()"]');
        await page.waitForTimeout(500);

        // ============================================================
        // 步骤 8：改派历史 details 展开
        // ============================================================
        console.log('\n8. 验证改派历史...');
        // 详情页此时回到 PENDING_ASSIGN 状态，admin-direct-actions 区块仍可见（PENDING_ASSIGN 也展示）
        // 但操作按钮已隐藏（仅 EXPORTING 显示）
        const historyDetailsExists = await page.locator('#reassignHistoryDetails').count() > 0;
        expect(historyDetailsExists, '改派历史 details 区块存在');

        // 展开 details
        await page.click('#reassignHistoryDetails summary');
        await page.waitForTimeout(800);

        const historyContent = await page.locator('#reassignHistoryContent').textContent();
        // 验证改派历史已加载：含时间戳 / 操作者名 / 至少一条 li 项
        const historyItemCount = await page.locator('#reassignHistoryContent .reassign-history-list li').count();
        expect(historyItemCount >= 1, `改派历史至少 1 条记录 (got ${historyItemCount})`);
        expect(historyContent && (historyContent.includes('2026-') || historyContent.includes('原接收人')),
            `改派历史含时间戳或改派内容关键字 (got: ${historyContent ? historyContent.slice(0, 80).replace(/\s+/g, ' ') : 'null'})`);

        console.log(`\n=== ${assertCount} 个断言全部 PASS ===`);
    } catch (e) {
        console.error('\n❌ 测试失败:', e.message);
        console.error(e.stack);
        exitCode = 1;
    } finally {
        // [#106 S4d-2] 两个收尾动作各自 try / catch：浏览器关闭失败不跳过协作单清理；任一失败都计失败（退出码 1）
        try { await browser.close(); } catch (e) { console.error(`❌ 浏览器关闭失败：${e && e.message}`); exitCode = 1; }
        const cleanupErr = await cleanupCollabChecked();
        if (cleanupErr) { console.error(`❌ 清理测试协作单 #${testCollabId} 失败（已重试 1 轮）：${cleanupErr}`); exitCode = 1; }
    }

    try { await testEnv.teardown(); } catch (e) { console.error(`❌ teardown（收掉自起实例）失败：${e && e.message}`); exitCode = 1; }
    testEnv.finish(exitCode);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('测试异常:', e && e.stack || e);
    try { await cleanupCollabChecked(); } catch (_) { /* 已在报错路径，尽力清理 */ }
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
