/**
 * v1.72.5 viewer 角色 admin 直派收单 Playwright UI 测试
 *
 * 用法：node scripts/test-viewer-exporter-playwright.js
 * 前置：无服务前置（[#106 S4d-2] 经 scripts/lib/test-env.js 自起临时隔离实例，也可由 TEST_* 变量组指向已起好的隔离实例；不再依赖 localhost:3000 / 业务库 / .env）；
 *   实例库（本检出本地库快照）里须有 viewer 用户（id=2 示例客服A）和 db_connections id=2（首跑核对）。
 *   造数：经页面建 1 张协作单（OA_PW_VW_<时间戳>）+ 2 个临时上传文件（os.tmpdir() 下 viewer-pw-*）；收尾直连实例库 DELETE（FK 级联）并回查，失败再试一轮（共 2 轮，间隔 200ms），
 *   临时文件逐个删（删失败计失败），遗留计失败。原来 catch 里 process.exit(1) 会让 finally 的清理不执行，且成功路径没有显式退出——现改为记录退出码、清理与 teardown 之后统一 finish。
 *   已知既有红：当前首个失败点更早：:174 等待 #newModal.show 超时（页面 2026-07-10 前端统一后改为 .open，daf053ec）；越过后才会遇到 OA 规范化导致的 TypeError（服务端规范化 OA 号，OA_PW_VW_<ts> 落库为 OA-_PW_VW_<ts>，getCollabByOA 按原写法查不到，2026-06-28 起，ddbb88e0），主体在 created.assign_mode 处抛出；清理已按两种写法兜底。
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
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-2] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-2] ready() 之后赋值：testEnv.env().dbPath（实例库）

const ADMIN_ID = 1;
const VIEWER_ID = 2;     // 示例客服A（viewer）
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

// [#106 S4d-2] 临时上传文件登记进 tmpFiles（先登记再写，写一半失败也能删），收尾 removeTmpFiles 逐个删
const tmpFiles = [];
function makeTmpFile(name, buf) {
    const tmpPath = path.join(os.tmpdir(), `viewer-pw-${Date.now()}-${name}`);
    tmpFiles.push(tmpPath);
    fs.writeFileSync(tmpPath, buf);
    return tmpPath;
}
/** 删临时文件：每个文件单独 try；不存在算已清；只把删掉的移出登记；返回仍失败的说明数组（调用方计失败）。原来写出去就不删 */
function removeTmpFiles() {
    const errs = [];
    for (const p of tmpFiles.slice()) {
        try { fs.unlinkSync(p); } catch (e) { if (!e || e.code !== 'ENOENT') { errs.push(`${p}: ${(e && e.message) || e}`); continue; } }
        tmpFiles.splice(tmpFiles.indexOf(p), 1);
    }
    return errs;
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
            // [#106 S4d-2 修复批] 按原写法与规范化写法两种 OA 都查，查到几行删几行（服务端建单会把 OA_PW_VW_<ts> 落成 OA-_PW_VW_<ts>，只按原写法查永远查不到、每跑一次漏一张单）
            const ids = new Set();
            if (testCollabId) ids.add(testCollabId);
            if (testOA) { for (const r of await findCollabIdsByOA(testOA)) ids.add(r.id); }
            if (ids.size === 0) return null;
            for (const id of ids) await cleanupTestCollab(id);
            const leftIds = [];
            for (const id of ids) { if (await getCollabIdRow(id)) leftIds.push(id); }
            const leftByOa = testOA ? await findCollabIdsByOA(testOA) : [];   // 删后回查：两种写法都要为空才算清掉
            if (leftIds.length === 0 && leftByOa.length === 0) { console.log(`[cleanup] 已删除测试协作单 id=${Array.from(ids).join(',')}`); testCollabId = null; return null; }
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
    console.log('=== v1.72.5 viewer 角色 admin 直派收单 Playwright UI 测试 ===\n');

    const adminToken = await signAs(ADMIN_ID);
    const viewerToken = await signAs(VIEWER_ID);
    const browser = await chromium.launch({ headless: true });
    let exitCode = 0;   // [#106 S4d-2] 原 catch 里的 process.exit(1) 会让 finally 的清理从不执行；改为记录退出码，清理与 teardown 之后统一 finish

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
        testOA = `OA_PW_VW_${Date.now()}`;
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
        exitCode = 1;
    } finally {
        // [#106 S4d-2] 三个收尾动作各自 try / catch，互不跳过；任一失败都计失败（退出码 1）
        try { await browser.close(); } catch (e) { console.error(`❌ 浏览器关闭失败：${e && e.message}`); exitCode = 1; }
        const fileErrs = removeTmpFiles();
        if (fileErrs.length) { console.error(`❌ 删除临时上传文件失败：${fileErrs.join(' | ')}`); exitCode = 1; }
        const cleanupErr = await cleanupCollabChecked();
        if (cleanupErr) { console.error(`❌ 清理测试协作单 #${testCollabId} 失败（已重试 1 轮）：${cleanupErr}`); exitCode = 1; }
    }

    try { await testEnv.teardown(); } catch (e) { console.error(`❌ teardown（收掉自起实例）失败：${e && e.message}`); exitCode = 1; }
    testEnv.finish(exitCode);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('测试异常:', e && e.stack || e);
    try { await cleanupCollabChecked(); } catch (_) { /* 已在报错路径，尽力清理 */ }
    try { removeTmpFiles(); } catch (_) { /* 已在报错路径，尽力清理 */ }
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
