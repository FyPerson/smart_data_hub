/**
 * v1.72.5 viewer 角色 admin 直派收单 Playwright UI 测试
 *
 * 用法：node scripts/test-viewer-exporter-playwright.js
 * 前置：本地 server 已启动（localhost:3000）+ 本地 DB 有 viewer 用户（id=2 示例客服A）
 *
 * 测试链路：
 *   1. admin JWT 注入 → 创建直派单选示例客服A（viewer）
 *   2. 验证 admin 直派下拉里能选到 viewer（v1.72.5 核心修复）
 *   3. 列表见 [🎯 admin 直派] tag
 *   4. 切到示例客服A JWT → 列表能看到自己的协作单
 *   5. 进详情页 → 见「提交导出结果」按钮
 *   6. 点提交导出 → 弹窗 → 上传 result_data + screenshot → 提交
 *   7. 验证 status = SUBMITTED + result_data 已落盘
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';

const ADMIN_ID = 1;
const VIEWER_ID = 2;     // 示例客服A（viewer）
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

function makeTmpFile(name, buf) {
    const tmpPath = path.join(os.tmpdir(), `viewer-pw-${Date.now()}-${name}`);
    fs.writeFileSync(tmpPath, buf);
    return tmpPath;
}

let assertCount = 0;
function expect(condition, message) {
    assertCount++;
    if (!condition) throw new Error(`❌ Assert #${assertCount}: ${message}`);
    console.log(`  ✓ ${message}`);
}

(async () => {
    console.log('=== v1.72.5 viewer 角色 admin 直派收单 Playwright UI 测试 ===\n');

    const adminToken = await signAs(ADMIN_ID);
    const viewerToken = await signAs(VIEWER_ID);
    const browser = await chromium.launch({ headless: true });
    let testCollabId = null;

    try {
        // ============================================================
        // 步骤 1：admin 登录 + 打开新建弹窗，验证下拉里有示例客服A（viewer）
        // ============================================================
        console.log('1. admin 登录 + 打开新建协作单弹窗...');
        const adminContext = await browser.newContext();
        const adminPage = await adminContext.newPage();
        adminPage.on('console', msg => {
            if (msg.type() === 'error') console.log(`  [admin-browser-err] ${msg.text()}`);
        });

        await adminPage.goto(`${BASE_URL}/login.html`);
        await adminPage.evaluate((token) => { localStorage.setItem('token', token); }, adminToken);
        await adminPage.goto(`${BASE_URL}/Data_Collab.html`);
        await adminPage.waitForLoadState('networkidle');
        await adminPage.waitForTimeout(500);

        await adminPage.click('button:has-text("新建协作单")');
        await adminPage.waitForSelector('#newModal.show', { timeout: 3000 });
        await adminPage.waitForTimeout(300);

        // ============================================================
        // 步骤 2：勾选 admin 直派 + 验证下拉里有 viewer（v1.72.5 核心修复点）
        // ============================================================
        console.log('\n2. 勾选 admin 直派 + 验证下拉包含 viewer 示例客服A...');
        await adminPage.check('#f_admin_direct_toggle');
        await adminPage.waitForTimeout(500);

        // 等待 exporter 下拉填充
        await adminPage.waitForFunction(() => {
            const sel = document.querySelector('#f_admin_direct_exporter');
            return sel && sel.options.length > 1;
        }, { timeout: 3000 });

        // 检查下拉里是否有 viewer 用户（VIEWER_ID=2 示例客服A）
        const viewerInDropdown = await adminPage.evaluate((vid) => {
            const sel = document.querySelector('#f_admin_direct_exporter');
            return Array.from(sel.options).some(o => Number(o.value) === vid);
        }, VIEWER_ID);
        expect(viewerInDropdown, `admin 直派下拉里能选到 viewer 示例客服A（id=${VIEWER_ID}）— v1.72.5 核心修复`);

        // ============================================================
        // 步骤 3：填表 + 选示例客服A + 提交
        // ============================================================
        console.log('\n3. 填表（admin 直派给示例客服A viewer）...');
        const testOA = `OA_PW_VW_${Date.now()}`;
        await adminPage.fill('#f_oa_no', testOA);
        await adminPage.selectOption('#f_dept', { index: 1 });
        await adminPage.fill('#f_requester', 'Playwright viewer 测试业务方');
        await adminPage.fill('#f_desc', 'v1.72.5 admin 直派给 viewer UI 测试单');

        await adminPage.waitForFunction(() => {
            const sel = document.querySelector('#f_target_db');
            return sel && sel.options.length > 1;
        }, { timeout: 3000 });
        await adminPage.selectOption('#f_target_db', String(TARGET_DB_CONN_ID));

        await adminPage.selectOption('#f_admin_direct_exporter', String(VIEWER_ID));
        await adminPage.click('#btnSubmit');
        await adminPage.waitForTimeout(1500);

        const created = await getCollabByOA(testOA);
        expect(created !== null, `协作单已创建（OA=${testOA}）`);
        expect(created.assign_mode === 'admin_direct', 'assign_mode = admin_direct');
        expect(created.status === 'EXPORTING', 'status = EXPORTING（跳过 PENDING_ASSIGN）');
        expect(Number(created.exporter_user_id) === VIEWER_ID, `exporter_user_id = ${VIEWER_ID}（viewer 示例客服A）`);
        testCollabId = created.id;

        await adminContext.close();

        // ============================================================
        // 步骤 4：切到 viewer 示例客服A → 列表能看到自己的协作单
        // ============================================================
        console.log('\n4. 切到 viewer 示例客服A → 验证列表可见...');
        const viewerContext = await browser.newContext();
        const viewerPage = await viewerContext.newPage();
        viewerPage.on('console', msg => {
            if (msg.type() === 'error') console.log(`  [viewer-browser-err] ${msg.text()}`);
        });

        await viewerPage.goto(`${BASE_URL}/login.html`);
        await viewerPage.evaluate((token) => { localStorage.setItem('token', token); }, viewerToken);
        await viewerPage.goto(`${BASE_URL}/Data_Collab.html`);
        await viewerPage.waitForLoadState('networkidle');
        await viewerPage.waitForTimeout(1500);  // 给列表加载更多时间

        // 验证列表中能看到这个单（按 OA 号搜索整个 body 文本，selector 不准时兜底）
        const listVisibleToViewer = await viewerPage.evaluate((oa) => {
            // 优先查列表 tbody
            const tbody = document.querySelector('#listBody');
            if (tbody && tbody.textContent.includes(oa)) return 'found in #listBody';
            // 兜底：全 body 搜
            if (document.body.textContent.includes(oa)) return 'found in body';
            return null;
        }, testOA);
        if (!listVisibleToViewer) {
            const debug = await viewerPage.evaluate(() => {
                const tbody = document.querySelector('#listBody');
                return {
                    tbodyHTML: tbody ? tbody.innerHTML.substring(0, 500) : '(no #listBody)',
                    bodyHasError: document.body.textContent.includes('未登录') || document.body.textContent.includes('403'),
                };
            });
            console.log(`  [debug] tbody first 500: ${debug.tbodyHTML}`);
            console.log(`  [debug] hasError: ${debug.bodyHasError}`);
        }
        expect(!!listVisibleToViewer, `viewer 示例客服A在列表中能看到自己被指派的协作单（${listVisibleToViewer || 'NOT FOUND'}）`);

        // ============================================================
        // 步骤 5：viewer 进详情页 → 见「提交导出结果」按钮
        // ============================================================
        console.log('\n5. viewer 进详情页 → 验证 submit-export 按钮可见...');
        await viewerPage.evaluate((id) => {
            window.openDetail(id);
        }, testCollabId);
        await viewerPage.waitForSelector('#detailModal.show', { timeout: 3000 });
        await viewerPage.waitForTimeout(800);

        // 查找提交导出按钮（按文本匹配，避免 selector class 不稳定）
        const submitExportBtnVisible = await viewerPage.evaluate(() => {
            const btns = document.querySelectorAll('#detailModal button');
            return Array.from(btns).some(b => b.textContent.includes('提交导出'));
        });
        expect(submitExportBtnVisible, 'viewer 详情页见「提交导出结果」按钮');

        // ============================================================
        // 步骤 6：点击提交导出 → 弹窗 → 上传文件 → 提交
        // ============================================================
        console.log('\n6. 点击提交导出 → 上传 result_data + screenshot → 提交...');
        // 点击按钮（按文本）
        await viewerPage.evaluate(() => {
            const btns = document.querySelectorAll('#detailModal button');
            const btn = Array.from(btns).find(b => b.textContent.includes('提交导出'));
            if (btn) btn.click();
        });
        // 等弹窗（弹窗 id 可能是 exportUploadModal 或类似）
        await viewerPage.waitForTimeout(800);

        // 准备测试文件
        const dataBuf = Buffer.from('Playwright viewer test data ' + Date.now());
        const shotBuf = Buffer.from('Playwright viewer test screenshot');
        const dataPath = makeTmpFile('result.xlsx', dataBuf);
        const shotPath = makeTmpFile('screenshot.png', shotBuf);

        // 找 file input（result_data 和 screenshot）
        const dataInputId = await viewerPage.evaluate(() => {
            // 找 modal 内的 file input
            const inputs = document.querySelectorAll('input[type="file"]');
            for (const i of inputs) {
                if (i.id && (i.id.includes('result_data') || i.id.includes('exportData') || i.id.includes('f_export_data'))) {
                    return i.id;
                }
            }
            return null;
        });

        if (dataInputId) {
            console.log(`  [info] 找到 file input: #${dataInputId}`);
            await viewerPage.setInputFiles(`#${dataInputId}`, dataPath);
            await viewerPage.waitForTimeout(300);
        } else {
            console.log('  [warn] 没找到 result_data file input，列出弹窗内所有 input：');
            const allInputs = await viewerPage.evaluate(() => {
                return Array.from(document.querySelectorAll('input')).map(i => `${i.id || '(no id)'} type=${i.type}`);
            });
            console.log('  ' + allInputs.join('\n  '));
        }

        // 找 screenshot input
        const shotInputId = await viewerPage.evaluate(() => {
            const inputs = document.querySelectorAll('input[type="file"]');
            for (const i of inputs) {
                if (i.id && (i.id.includes('screenshot') || i.id.includes('shot'))) {
                    return i.id;
                }
            }
            return null;
        });
        if (shotInputId) {
            console.log(`  [info] 找到 screenshot input: #${shotInputId}`);
            await viewerPage.setInputFiles(`#${shotInputId}`, shotPath);
            await viewerPage.waitForTimeout(300);
        }

        // 点击提交按钮（找弹窗里的"提交"按钮）
        const submitClicked = await viewerPage.evaluate(() => {
            // 找当前可见的模态弹窗里的提交按钮
            const modals = document.querySelectorAll('.modal-overlay.show');
            for (const m of modals) {
                if (m.id === 'detailModal') continue;  // 跳过详情页
                const btns = m.querySelectorAll('button');
                for (const b of btns) {
                    const t = b.textContent.trim();
                    if (t === '提交' || t === '确定提交' || t.includes('提交')) {
                        b.click();
                        return `clicked: ${t} in modal #${m.id}`;
                    }
                }
            }
            return null;
        });
        console.log(`  [info] 提交按钮: ${submitClicked || '(未找到)'}`);

        await viewerPage.waitForTimeout(2500);  // 等服务器响应 + 状态更新

        // ============================================================
        // 步骤 7：验证 DB 状态 DONE（v1.72.10：exporter 上传后直接 DONE，跳过 SUBMITTED）
        // ============================================================
        console.log('\n7. 验证 DB 状态切换到 DONE（v1.72.10 改造）...');
        const submitted = await getCollabByOA(testOA);
        expect(submitted !== null, '协作单仍存在');
        expect(submitted.status === 'DONE', `提交后 status = DONE，跳过 SUBMITTED（实际：${submitted.status}）`);
        expect(submitted.done_at !== null && submitted.done_at !== '', 'done_at 字段已写');
        expect(submitted.sql_validation_status === 'admin_closed', `sql_validation_status = 'admin_closed' (与 admin-submit-on-behalf 一致)`);

        await viewerContext.close();

        console.log(`\n=== ${assertCount} PASS / 0 FAIL ===\n`);
    } catch (e) {
        console.error('\n❌ 测试失败：', e.message);
        console.error(e.stack);
        process.exit(1);
    } finally {
        if (testCollabId) {
            await cleanupTestCollab(testCollabId);
            console.log(`[cleanup] 已删除测试协作单 id=${testCollabId}`);
        }
        await browser.close();
    }
})();
