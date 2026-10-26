/**
 * v1.77.0 创建人发送按钮可见性实测（codex 合并审 M-1 第十人衍生）
 *
 * 用法：node scripts/test-requester-done-creator-visibility-playwright.js
 *   [#106 S3b] 被测服务 / 实例库 / 密钥来自 test-env：默认自起临时隔离实例（来源 = 本检出本地库快照），也可由 TEST_* 变量组指向已起好的隔离实例；不再要求 3000，不再写真实库。
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
const OTHER_USER_ID = 12;  // 示例开发D user（非创建人非 exporter 非 admin）

function dbRun(sql, params = []) {
    return new Promise((res, rej) => { const db = new sqlite3.Database(fx.DB_PATH); db.run(sql, params, function (e) { db.close(); e ? rej(e) : res(this); }); });
}

async function openDetailAs(browser, token, id) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    await page.goto(`${fx.BASE}/login.html`);
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${fx.BASE}/Data_Collab.html`);
    await page.waitForLoadState('networkidle');
    await page.evaluate(i => openDetail(i), id);
    await page.waitForTimeout(700);
    // [#106 S3b] 选择器由 .requester-done-notify-btn 改为 .u-nb-btn[data-collab-id]：前端统一线（v1.143.0 停点⑦，Data_Collab.html 的 notifyRequesterDone 处注释）已把按钮 class 改名，
    //   旧选择器在现行页面上恒为 0 个匹配——C1 恒红、C2 空转。探针实证（隔离实例 + 同样的 DONE 单）：旧选择器 0 个、新选择器 1 个，按钮文案「通知业务方并发送数据」。
    //   选择器来源（S3b 修复批 1，codex 13 建议）：`data-collab-id` 在整个前端只出现在 public/Data_Collab.html:2481 这一个按钮上
    //   （<button class="u-btn-secondary u-nb-btn" data-collab-id="${safeId}" onclick="notifyRequesterDone(...)">），页面自己的 notifyRequesterDone（Data_Collab.html:5727）用的是同一个选择器
    //   `.u-nb-btn[data-collab-id="${id}"]`。所以「匹配数恰为 1」就是「详情页渲染出了这一个按钮」：通用按钮类 u-nb-btn 之外还有 data-collab-id 约束，不会被别处的同类按钮顶替；
    //   C1 同时断言匹配数恰为 1（重复渲染 / 误匹配到别的单的按钮都会判红），C2 断言 0。
    const matches = await page.evaluate((cid) => {
        const body = document.getElementById('detailBody');
        return body ? body.querySelectorAll(`.u-nb-btn[data-collab-id="${cid}"]`).length : 0;
    }, id);
    return { page, visible: matches > 0, matches, errs };
}

(async () => {
    await fx.ready();   // 先于任何写库 / 网络请求 / 浏览器操作
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
    must(c1.matches === 1, 'C1 选择器 .u-nb-btn[data-collab-id] 在详情区恰好匹配 1 个按钮（Data_Collab.html:2481 唯一生成点）', `matches=${c1.matches}`);
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
    await fx.teardown().catch((e) => { console.error('teardown 失败：' + e.message); fail++; });
    fx.finish(fail ? 1 : 0);   // 成功路径：teardown 之后只设退出码、让事件循环自然结束（见 lib/test-env.js finish）
})().catch(async e => { console.error(e); await fx.teardown().catch(() => {}); process.exit(1); });
