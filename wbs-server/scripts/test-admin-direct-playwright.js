/**
 * v1.72.3 admin 直派模式 Playwright UI 测试
 *
 * 用法：node scripts/test-admin-direct-playwright.js
 * 前置：本地 server 已启动（localhost:3000）
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

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

const ADMIN_ID = 1;
const EXPORTER_ID = 8;
const PUBLISHER_ID = 7;
const TARGET_DB_CONN_ID = 2;

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

async function cleanupTestCollab(id) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_PATH);
        db.serialize(() => {
            db.run('PRAGMA foreign_keys = ON');
            db.run('DELETE FROM collab_requests WHERE id = ?', [id], () => {
                db.close();
                resolve();
            });
        });
    });
}

async function getCollabByOA(oa) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_PATH);
        db.get('SELECT * FROM collab_requests WHERE oa_request_no = ?', [oa],
            (err, row) => { db.close(); resolve(row); });
    });
}

let assertCount = 0;
function expect(condition, message) {
    assertCount++;
    if (!condition) throw new Error(`❌ Assert #${assertCount}: ${message}`);
    console.log(`  ✓ ${message}`);
}

(async () => {
    console.log('=== v1.72.3 admin 直派模式 Playwright UI 测试 ===\n');

    const adminToken = await signAs(ADMIN_ID);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    let testCollabId = null;

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
        const testOA = `OA_PW_${Date.now()}`;
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
        process.exit(0);
    } catch (e) {
        console.error('\n❌ 测试失败:', e.message);
        console.error(e.stack);
        process.exit(1);
    } finally {
        if (testCollabId) {
            await cleanupTestCollab(testCollabId);
            console.log(`\n清理测试 fixture #${testCollabId}`);
        }
        await browser.close();
    }
})();
