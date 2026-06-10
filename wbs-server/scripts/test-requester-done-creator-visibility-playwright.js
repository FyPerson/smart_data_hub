/**
 * v1.77.0 创建人发送按钮可见性实测（codex 合并审 M-1 第十人衍生）
 *
 * 用法：本地 server(3000) 已启动后 node scripts/test-requester-done-creator-visibility-playwright.js
 *
 * 背景：notify-requester-done 删 hasValidExporter 守卫 + 权限加创建人后，
 *   developer 交付路径（exporter=0）下创建人/admin 应能点发送按钮。
 *
 * ⚠️ 已知边界（2026-06-11 用户拍板记 backlog，不阻塞 v1.77.0）：
 *   详情 GET 可见性校验（server.js ~12148）仅放行 admin/contact/developer/exporter，**无 isCreator**。
 *   故"创建人非 admin"时连详情页都进不去（403）→ 按钮无从渲染。
 *   但生产 created_by 恒为 admin（创建 endpoint 仅 admin），该缺口对真实单零影响。
 *   待未来放开非 admin 创建权（collaborator 角色改造）时，需在详情 GET 可见性补 isCreator，
 *   届时启用本脚本被注释的"创建人非 admin 视角"用例（C1b）。
 *
 * 用例（匹配当前生产现实）：
 *   C1 admin（兼创建人）视角：developer 路径 DONE 单 → 按钮可见
 *   C2 无关 user 视角：同单 → 按钮不可见（前端显隐与后端 NOT_AUTHORIZED_TO_NOTIFY 同条件）
 *   C3 控制台无 JS 报错
 *   C1b（待启用）创建人非 admin 视角——依赖详情 GET 补 isCreator
 *
 * 持久保留（按钮可见性是本需求核心交付，纳入回归）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

let pass = 0, fail = 0;
const must = (c, m, d) => { if (c) { pass++; console.log('  PASS ' + m); } else { fail++; console.log('  FAIL ' + m + (d ? ' :: ' + d : '')); } };
const OTHER_USER_ID = 12;  // 饶璐 user（非创建人非 exporter 非 admin）

function dbRun(sql, params = []) {
    return new Promise((res, rej) => { const db = new sqlite3.Database(fx.DB_PATH); db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); }); });
}

async function openDetailAs(browser, token, id) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto('http://localhost:3000/login.html');
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto('http://localhost:3000/Data_Collab.html');
    await page.waitForLoadState('networkidle');
    await page.evaluate(i => openDetail(i), id);
    await page.waitForTimeout(700);
    const visible = await page.evaluate(() => {
        const body = document.getElementById('detailBody');
        return !!(body && body.querySelector('.requester-done-notify-btn'));
    });
    return { page, visible, errs };
}

(async () => {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    // 造 developer 交付路径 DONE 单：创建人=publisher（非 admin），exporter=0，有 active result_data
    const cr = await fx.apiCall('POST', '/api/collab/requests', adminToken, {
        oa_request_no: 'TEST-CREATOR-VIS-' + Date.now(),
        requester_dept: '市场营销部', requester_name: '实测', requester_phone: '13800001111',
        description: '创建人按钮可见性实测', deadline: '2026-12-31 18:00:00',
        contact_person_id: fx.CONTACT_ID, assign_mode: 'normal', target_db_connection_id: fx.TARGET_DB_CONN_ID
    });
    const id = cr.body.id;
    // developer 交付路径（exporter=0）+ active result_data；创建人=admin（生产现实，匹配当前权限模型）
    await fx.setCollabState(id, { status: 'DONE', exporter_user_id: 0 });
    await dbRun(
        `INSERT INTO collab_attachments (collab_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name, status)
         VALUES (?, 'result_data', ?, '开发交付.xlsx', ?, 'dev1', 'active')`,
        [id, `collab/_e2e/${id}_r.xlsx`, fx.DEV1_ID]
    );

    const browser = await chromium.launch();
    console.log('\n── C1 admin（兼创建人）视角：developer 路径 DONE 单 ──');
    const c1 = await openDetailAs(browser, adminToken, id);
    must(c1.visible, 'C1 admin developer 路径 DONE 单按钮可见');
    must(c1.errs.length === 0, 'C3a admin 视角无 JS 报错', c1.errs.join('|'));

    console.log('\n── C2 无关 user 视角 ──');
    //   无关 user 详情 GET 本就 403（可见性正确拦截）→ 详情打不开、按钮不可见，403 是预期 feature 非 bug。
    //   故 C2 只断言"按钮不可见"，不断言"无报错"（403 资源加载错误是预期的）。
    const otherToken = await fx.signAs(OTHER_USER_ID);
    const c2 = await openDetailAs(browser, otherToken, id);
    must(!c2.visible, 'C2 无关 user 按钮不可见（详情 GET 403 拦截，与后端守卫同条件）');
    must(c2.errs.every(e => /403|Forbidden/.test(e)), 'C3b 无关用户仅有预期 403、无其他 JS 报错', c2.errs.join('|'));

    // C1b（待启用）：创建人非 admin 视角——当前详情 GET 可见性无 isCreator，publisher 创建人会 403 进不去详情页。
    //   待未来放开非 admin 创建权 + 详情 GET 补 isCreator 后，取消下方注释启用：
    // await fx.setCollabState(id, { created_by: fx.PUBLISHER_ID, created_by_name: 'publisher' });
    // const pubToken = await fx.signAs(fx.PUBLISHER_ID);
    // const c1b = await openDetailAs(browser, pubToken, id);
    // must(c1b.visible, 'C1b 创建人(非admin) developer 路径按钮可见');

    await browser.close();
    await fx.cleanup(id);
    console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
